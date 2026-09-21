/**
 * 文案生成 Worker。
 *
 * 与生图流程同构(模型复核 → 闸门 → 解密 → 调用 → 分类 → 归还闸门),差异集中在结果处理:
 *
 *  1. 用文本适配器的**结构化输出**(JSON Schema),不做自由文本解析。
 *  2. 拿到 raw 后必须用 `copyResultPayloadSchema.safeParse` 校验结构;
 *     不合规则按"有限次数重写"最多再试 2 次,仍失败置 CONTENT_STRUCTURE_INVALID。
 *  3. 通过结构校验后跑**输出检查**(内容规则,见 lib/content-check.ts)。
 *     - BLOCK 命中 → 直接拦截;
 *     - REWRITE 命中 → 要求模型重写,最多 2 次;用尽仍不通过按拦截处理。
 *  4. **未通过检查的内容绝不写入可展示字段**:`GenerationResult.textPayload` 只在通过后写入;
 *     被拦截时 status=FAILED、errorCode=CONTENT_BLOCKED_OUTPUT,`checkResult` 只记录
 *     违规摘要(命中片段已掩码)。
 *  5. **不做提前流式展示**:SSE 事件只带状态与阶段,任何时候都不携带正文,
 *     因此用户不可能看到未通过检查的内容。
 */
import { Prisma, ResultStatus, TaskStatus, TaskType } from '@june/db';
import {
  CONTENT_CHECK_DISCLAIMER,
  ERROR_CODES,
  QUEUE_NAMES,
  copyResultPayloadSchema,
  titleResultPayloadSchema,
  type ContentCheckOutcome,
  type TextGenerationJob,
} from '@june/shared';
import { RuleAction } from '@june/db';
import { Worker, type Job } from 'bullmq';

import { loadEnv } from '../config/env';
import { GateSession } from '../lib/concurrency';
import { buildRewriteInstruction, checkOutput, buildSystemPrompt, needsRewrite } from '../lib/content-check';
import { openProviderApiKey } from '../lib/crypto';
import { clearDeferCount, deferJob } from '../lib/defer';
import { classifyUpstreamFailure, toProviderFailure } from '../lib/errors';
import { createLogger } from '../lib/logger';
import { recordFailed, recordProcessed } from '../lib/metrics';
import { checkModelUsable } from '../lib/model-guard';
import { getPrisma } from '../lib/prisma';
import type {
  ProviderCredentials,
  StructuredTextOutcome,
  StructuredTextRequest,
  TextProvider,
} from '../lib/provider-contract';
import { resolveTextProvider } from '../lib/provider-registry';
import { queueConnection } from '../lib/redis';
import { TaskReporter } from '../lib/task-state';

const log = createLogger('text-generation');

/** 结构不合规时的重写上限(不含首次调用) */
const MAX_STRUCTURE_RETRIES = 2;
/** 内容检查要求重写的上限 */
const MAX_CONTENT_REWRITES = 2;

interface CopyInput {
  productName?: string;
  productDetails?: string;
  sellingPoints?: string[];
  targetPlatform?: string;
  style?: string;
  prompt?: string;
  titleCount?: number;
  keywords?: string[];
  maxTitleLength?: number;
  systemPrompt?: string;
  wrappedUserInput?: string;
}

/**
 * 结构化输出的 JSON Schema。与 @june/shared 的 copyResultPayloadSchema 一一对应。
 * 手写而不是自动生成:各家结构化输出对 schema 的子集支持不同
 * (OpenAI 要求 additionalProperties=false 且 required 覆盖全部字段),需要精确控制。
 */
const TITLE_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['titles'],
  properties: {
    titles: {
      type: 'array',
      minItems: 1,
      maxItems: 10,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'charCount'],
        properties: {
          text: { type: 'string', maxLength: 300 },
          charCount: { type: 'integer', minimum: 1, maximum: 120 },
        },
      },
    },
  },
};

const COPY_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['titles', 'body', 'highlights', 'keywords'],
  properties: {
    titles: { type: 'array', minItems: 1, maxItems: 10, items: { type: 'string', maxLength: 300 } },
    body: { type: 'string', maxLength: 8000 },
    highlights: { type: 'array', maxItems: 12, items: { type: 'string', maxLength: 200 } },
    keywords: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 60 } },
  },
};

export function createTextGenerationWorker(): Worker<TextGenerationJob> {
  const env = loadEnv();
  return new Worker<TextGenerationJob>(QUEUE_NAMES.textGeneration, (job, token) => handle(job, token), {
    connection: queueConnection(),
    prefix: env.QUEUE_PREFIX,
    concurrency: env.CONCURRENCY_TEXT_GLOBAL,
    lockDuration: env.TASK_TEXT_TIMEOUT_MS + 60_000,
    stalledInterval: 30_000,
    // 与生图同理:stalled 不重投,避免重复调用付费接口
    maxStalledCount: 0,
  });
}

async function handle(job: Job<TextGenerationJob>, token?: string): Promise<void> {
  const env = loadEnv();
  const prisma = getPrisma();
  const { taskId, userId } = job.data;
  const jobStartedAt = Date.now();
  const held = new GateSession();

  try {
    const task = await prisma.generationTask.findUnique({
      where: { id: taskId },
      include: { modelConfig: { include: { provider: true } }, results: true },
    });
    if (!task) {
      log.warn(`任务 ${taskId} 不存在(可能已被删除),跳过`);
      return;
    }
    if (task.userId !== userId) {
      log.error(`任务 ${taskId} 的归属与队列载荷不一致,已拒绝处理`);
      return;
    }
    if (task.status === TaskStatus.CANCELED) return;
    if (task.status === TaskStatus.UNKNOWN) {
      log.warn(`任务 ${taskId} 处于 UNKNOWN,等待核对,拒绝重跑以免重复计费`);
      return;
    }

    // 幂等:文案任务只有一个结果(seq=0),已成功就不再调用上游
    const existing = task.results.find((r) => r.seq === 0);
    if (existing?.status === ResultStatus.SUCCEEDED) {
      log.info(`任务 ${taskId} 已有成功结果,跳过上游调用`);
      return;
    }

    const reporter = new TaskReporter({
      taskId,
      userId,
      requestedCount: task.requestedCount,
      succeededCount: task.succeededCount,
      failedCount: task.failedCount,
      status: task.status,
      stage: 'queued',
      progressPercent: null,
    });
    const queueWaitMs = Date.now() - task.createdAt.getTime();

    // ---- 模型复核 ----
    const guard = checkModelUsable(task.modelConfig);
    if (!guard.ok) {
      await failTask(reporter, taskId, guard.errorCode, guard.message, queueWaitMs, false);
      recordFailed(job.queueName);
      return;
    }
    const model = guard.model;

    // ---- 闸门:全局 → 供应商并发 ----
    if (!(await held.acquireGlobal('text', env.CONCURRENCY_TEXT_GLOBAL))) {
      throw await deferJob(job, token, '全局文案并发已满');
    }
    if (!(await held.acquireProviderConcurrency(model.provider.slug, model.provider.maxConcurrency))) {
      throw await deferJob(job, token, `供应商 ${model.provider.slug} 并发已满`);
    }

    await prisma.generationTask.update({
      where: { id: taskId },
      data: {
        status: TaskStatus.RUNNING,
        stage: 'submitting',
        startedAt: task.startedAt ?? new Date(),
        queueWaitMs,
        attempt: job.data.attempt,
        errorCode: null,
        errorMessage: null,
        retryable: false,
      },
    });
    await reporter.setStage('submitting');

    // ---- 解密凭据 ----
    let apiKey: string | null = null;
    try {
      apiKey = openProviderApiKey(model.provider);
    } catch (err) {
      log.error(`任务 ${taskId} 解密供应商凭据失败`, err);
    }
    if (!apiKey) {
      await failTask(
        reporter,
        taskId,
        ERROR_CODES.MODEL_CREDENTIAL_MISSING,
        '供应商凭据无法解密,请在后台重新录入 API Key(任务未产生任何上游调用)',
        queueWaitMs,
        false,
      );
      recordFailed(job.queueName);
      return;
    }
    const creds: ProviderCredentials = { apiKey, baseUrl: model.provider.baseUrl };

    let adapter: TextProvider;
    try {
      adapter = resolveTextProvider(model.providerKind);
    } catch (err) {
      await failTask(
        reporter,
        taskId,
        ERROR_CODES.MODEL_NOT_AVAILABLE,
        `供应商适配器不可用:${(err as Error).message}`,
        queueWaitMs,
        true,
      );
      recordFailed(job.queueName);
      return;
    }

    const input = (task.input ?? {}) as CopyInput;
    const platform = input.targetPlatform ?? 'other';
    const isTitleTask = task.type === TaskType.TEXT_TITLE;
    // 系统提示词只在进程内使用:标题任务优先用提交时定版的 systemPrompt
    const systemPrompt =
      isTitleTask && typeof input.systemPrompt === 'string' && input.systemPrompt.trim()
        ? input.systemPrompt
        : await buildSystemPrompt(platform);
    const basePrompt =
      isTitleTask && typeof input.wrappedUserInput === 'string' && input.wrappedUserInput.trim()
        ? input.wrappedUserInput
        : isTitleTask
          ? buildTitleUserPrompt(input)
          : buildUserPrompt(input);
    const jsonSchema = isTitleTask ? TITLE_JSON_SCHEMA : COPY_JSON_SCHEMA;
    const schemaName = isTitleTask ? 'june_title_result' : 'june_copy_result';

    const deadline = jobStartedAt + env.TASK_TEXT_TIMEOUT_MS;
    let providerCallCount = task.providerCallCount;
    let upstreamDurationMs = 0;
    let structureRetries = 0;
    let contentRewrites = 0;
    let extraInstruction = '';

    // ---- 生成 → 结构校验 → 内容检查(必要时重写)----
    for (;;) {
      if (Date.now() >= deadline) {
        const disposition = classifyUpstreamFailure({
          failure: {
            errorCode: ERROR_CODES.UPSTREAM_TIMEOUT,
            message: `任务超过 ${env.TASK_TEXT_TIMEOUT_MS}ms 上限`,
            retryable: false,
          },
          phase: providerCallCount > 0 ? 'poll_exhausted' : 'never_submitted_timeout',
          attempt: job.data.attempt,
        });
        if (disposition.action === 'mark_unknown') {
          await markUnknown(
            reporter,
            disposition.errorCode,
            disposition.message,
            providerCallCount,
            queueWaitMs,
          );
        } else if (disposition.action === 'fail') {
          await failResult(taskId, disposition.errorCode, disposition.message);
          await failTask(
            reporter,
            taskId,
            disposition.errorCode,
            disposition.message,
            queueWaitMs,
            true,
            disposition.taskStatus,
          );
        }
        recordFailed(job.queueName);
        return;
      }

      // 每一次上游调用都单独计入供应商频率限制与调用计数
      const rate = await held.acquireProviderRate(model.provider.slug, model.provider.rateLimitPerMinute);
      if (!rate.ok) {
        throw await deferJob(job, token, `供应商 ${model.provider.slug} 触发频率限制`, rate.waitMs);
      }
      providerCallCount += 1;
      await prisma.generationTask.update({ where: { id: taskId }, data: { providerCallCount } });

      const request: StructuredTextRequest = {
        modelKey: model.modelKey,
        systemPrompt,
        userPrompt: extraInstruction ? `${basePrompt}\n\n${extraInstruction}` : basePrompt,
        jsonSchema,
        schemaName,
        ...(model.limits.maxOutputTokens > 0 ? { maxOutputTokens: model.limits.maxOutputTokens } : {}),
      };

      await reporter.setStage('submitting');
      const promise = (async (): Promise<StructuredTextOutcome> => {
        try {
          return await adapter.generateStructured(request, creds, {
            timeoutMs: Math.max(5_000, deadline - Date.now()),
          });
        } catch (err) {
          return toProviderFailure(err, '生成文案失败');
        }
      })();
      await reporter.setStage('generating');
      const outcome = await promise;

      if (outcome.kind === 'failed') {
        const disposition = classifyUpstreamFailure({
          failure: outcome,
          phase: 'submit',
          attempt: job.data.attempt,
        });
        if (disposition.action === 'retry_later') {
          throw await deferJob(job, token, `上游限流(${disposition.errorCode})`, disposition.delayMs);
        }
        if (disposition.action === 'mark_unknown') {
          await markUnknown(
            reporter,
            disposition.errorCode,
            disposition.message,
            providerCallCount,
            queueWaitMs,
          );
          recordFailed(job.queueName);
          return;
        }
        await failResult(taskId, disposition.errorCode, disposition.message);
        await failTask(
          reporter,
          taskId,
          disposition.errorCode,
          disposition.message,
          queueWaitMs,
          disposition.retryable,
          disposition.taskStatus,
        );
        recordFailed(job.queueName);
        return;
      }

      upstreamDurationMs += outcome.upstreamDurationMs;

      // ---- 结构校验:上游返回的 JSON 只是"语法合法",结构必须由我们校验 ----
      const candidate = outcome.parsed ?? safeJsonParse(outcome.raw);
      if (isTitleTask) {
        const parsedTitle = titleResultPayloadSchema.safeParse(candidate);
        if (!parsedTitle.success) {
          const issues = parsedTitle.error.issues
            .slice(0, 5)
            .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
            .join('; ');
          log.warn(`任务 ${taskId} 标题结构不合规:${issues}`);
          if (structureRetries < MAX_STRUCTURE_RETRIES) {
            structureRetries += 1;
            extraInstruction = [
              '请严格输出 {"titles":[{"text":"标题","charCount":12}]} 结构,不要输出正文或其他字段。',
              `具体问题:${issues}`,
            ].join('\n');
            continue;
          }
          const message = '模型多次返回的标题结构不符合要求';
          await failResult(taskId, ERROR_CODES.CONTENT_STRUCTURE_INVALID, message);
          await failTask(reporter, taskId, ERROR_CODES.CONTENT_STRUCTURE_INVALID, message, queueWaitMs, true);
          recordFailed(job.queueName);
          return;
        }

        const maxLen = Math.min(120, Math.max(8, input.maxTitleLength ?? 60));
        const expectedCount = Math.min(10, Math.max(1, input.titleCount ?? 5));
        const normalized = parsedTitle.data.titles.map((item) => ({
          text: item.text.trim(),
          charCount: [...item.text.trim()].length,
        }));
        if (normalized.length < 1 || normalized.length > expectedCount) {
          extraInstruction = `请输出 ${expectedCount} 条标题,当前数量不符合要求。`;
          if (structureRetries < MAX_STRUCTURE_RETRIES) {
            structureRetries += 1;
            continue;
          }
          await failResult(taskId, ERROR_CODES.CONTENT_STRUCTURE_INVALID, '标题数量不符合要求');
          await failTask(
            reporter,
            taskId,
            ERROR_CODES.CONTENT_STRUCTURE_INVALID,
            '标题数量不符合要求',
            queueWaitMs,
            true,
          );
          recordFailed(job.queueName);
          return;
        }
        const tooLong = normalized.find((item) => item.charCount > maxLen);
        if (tooLong) {
          extraInstruction = `有标题超过 ${maxLen} 字,请缩短并保持语义完整,不要生硬截断。`;
          if (structureRetries < MAX_STRUCTURE_RETRIES) {
            structureRetries += 1;
            continue;
          }
          await failResult(taskId, ERROR_CODES.CONTENT_STRUCTURE_INVALID, '标题长度超出限制');
          await failTask(
            reporter,
            taskId,
            ERROR_CODES.CONTENT_STRUCTURE_INVALID,
            '标题长度超出限制',
            queueWaitMs,
            true,
          );
          recordFailed(job.queueName);
          return;
        }

        await reporter.setStage('checking');
        const check = await checkOutput({
          platform,
          fields: normalized.map((item, index) => ({ field: `titles[${index}]`, value: item.text })),
          rewriteCount: contentRewrites,
        });

        const hasBlock = check.violations.some((v) => v.action === RuleAction.BLOCK);
        if (hasBlock) {
          await blockResult(taskId, check);
          await failTask(
            reporter,
            taskId,
            ERROR_CODES.CONTENT_BLOCKED_OUTPUT,
            '标题未通过内容检查,已拦截',
            queueWaitMs,
            true,
          );
          recordFailed(job.queueName);
          return;
        }
        if (needsRewrite(check)) {
          if (contentRewrites < MAX_CONTENT_REWRITES) {
            contentRewrites += 1;
            extraInstruction = buildRewriteInstruction(check);
            continue;
          }
          await blockResult(taskId, { ...check, passed: false });
          await failTask(
            reporter,
            taskId,
            ERROR_CODES.CONTENT_BLOCKED_OUTPUT,
            '标题重写后仍未通过内容检查',
            queueWaitMs,
            true,
          );
          recordFailed(job.queueName);
          return;
        }

        const titlePayload = { titles: normalized };
        await prisma.generationResult.upsert({
          where: { taskId_seq: { taskId, seq: 0 } },
          create: {
            taskId,
            seq: 0,
            status: ResultStatus.SUCCEEDED,
            textPayload: titlePayload,
            checkResult: { ...check, disclaimer: CONTENT_CHECK_DISCLAIMER },
            finishedAt: new Date(),
          },
          update: {
            status: ResultStatus.SUCCEEDED,
            textPayload: titlePayload,
            checkResult: { ...check, disclaimer: CONTENT_CHECK_DISCLAIMER },
            errorCode: null,
            errorMessage: null,
            finishedAt: new Date(),
          },
        });
        await reporter.finish({
          status: TaskStatus.SUCCEEDED,
          stage: 'done',
          succeededCount: normalized.length,
          failedCount: 0,
          errorCode: null,
          errorMessage: null,
          retryable: false,
          upstreamDurationMs,
          queueWaitMs,
          providerCallCount,
        });
        await clearDeferCount(job.id);
        recordProcessed(job.queueName, Date.now() - jobStartedAt);
        log.info(`任务 ${taskId} 标题生成完成: ${normalized.length} 条`);
        return;
      }

      const parsed = copyResultPayloadSchema.safeParse(candidate);
      if (!parsed.success) {
        const issues = parsed.error.issues
          .slice(0, 5)
          .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
          .join('; ');
        log.warn(`任务 ${taskId} 第 ${structureRetries + 1} 次返回结构不合规:${issues}`);
        if (structureRetries < MAX_STRUCTURE_RETRIES) {
          structureRetries += 1;
          extraInstruction = [
            '上一次输出的 JSON 结构不符合要求,请严格按下述结构重新输出,不要加入任何解释性文字:',
            '{"titles": ["标题1"], "body": "正文", "highlights": ["卖点"], "keywords": ["关键词"]}',
            `具体问题:${issues}`,
          ].join('\n');
          continue;
        }
        const message = '模型多次返回的结构都不符合要求,请稍后重试或更换模型';
        await failResult(taskId, ERROR_CODES.CONTENT_STRUCTURE_INVALID, message);
        await failTask(reporter, taskId, ERROR_CODES.CONTENT_STRUCTURE_INVALID, message, queueWaitMs, true);
        recordFailed(job.queueName);
        return;
      }

      // ---- 输出检查 ----
      await reporter.setStage('checking');
      const payload = parsed.data;
      const check = await checkOutput({
        platform,
        fields: [
          ...payload.titles.map((value, index) => ({ field: `titles[${index}]`, value })),
          { field: 'body', value: payload.body },
          ...payload.highlights.map((value, index) => ({ field: `highlights[${index}]`, value })),
          ...payload.keywords.map((value, index) => ({ field: `keywords[${index}]`, value })),
        ],
        rewriteCount: contentRewrites,
      });

      const hasBlock = check.violations.some((v) => v.action === RuleAction.BLOCK);
      if (hasBlock) {
        // BLOCK 是"直接拦截",不给重写机会
        await blockResult(taskId, check);
        await failTask(
          reporter,
          taskId,
          ERROR_CODES.CONTENT_BLOCKED_OUTPUT,
          '生成结果未通过内容检查,已拦截并未展示',
          queueWaitMs,
          true,
        );
        log.info(`任务 ${taskId} 输出被拦截,命中 ${check.violations.length} 条规则(内容未写入可展示字段)`);
        recordFailed(job.queueName);
        return;
      }

      if (needsRewrite(check)) {
        if (contentRewrites < MAX_CONTENT_REWRITES) {
          contentRewrites += 1;
          extraInstruction = buildRewriteInstruction(check);
          continue;
        }
        // 重写次数用尽仍有 REWRITE 级命中,按拦截处理:不能把它当"通过"放出去
        await blockResult(taskId, { ...check, passed: false });
        await failTask(
          reporter,
          taskId,
          ERROR_CODES.CONTENT_BLOCKED_OUTPUT,
          `已尝试重写 ${contentRewrites} 次仍未通过内容检查,结果已拦截`,
          queueWaitMs,
          true,
        );
        recordFailed(job.queueName);
        return;
      }

      // ---- 通过:此时才写入可展示字段 ----
      await prisma.generationResult.upsert({
        where: { taskId_seq: { taskId, seq: 0 } },
        create: {
          taskId,
          seq: 0,
          status: ResultStatus.SUCCEEDED,
          textPayload: payload,
          checkResult: { ...check, disclaimer: CONTENT_CHECK_DISCLAIMER },
          finishedAt: new Date(),
        },
        update: {
          status: ResultStatus.SUCCEEDED,
          textPayload: payload,
          checkResult: { ...check, disclaimer: CONTENT_CHECK_DISCLAIMER },
          errorCode: null,
          errorMessage: null,
          finishedAt: new Date(),
        },
      });
      await reporter.finish({
        status: TaskStatus.SUCCEEDED,
        stage: 'done',
        succeededCount: 1,
        failedCount: 0,
        errorCode: null,
        errorMessage: null,
        retryable: false,
        upstreamDurationMs,
        queueWaitMs,
        providerCallCount,
      });
      await clearDeferCount(job.id);
      recordProcessed(job.queueName, Date.now() - jobStartedAt);
      log.info(
        `任务 ${taskId} 文案生成完成:上游调用 ${providerCallCount} 次,` +
          `结构重试 ${structureRetries} 次,内容重写 ${contentRewrites} 次`,
      );
      return;
    }
  } finally {
    await held.releaseAll();
  }
}

// ---------------------------------------------------------------------------

function buildTitleUserPrompt(input: CopyInput): string {
  const parts: string[] = [];
  if (input.productName) parts.push(`商品名称:${input.productName}`);
  if (input.sellingPoints && input.sellingPoints.length > 0) {
    parts.push(`卖点:\n${input.sellingPoints.map((p) => `- ${p}`).join('\n')}`);
  }
  if (input.keywords && input.keywords.length > 0) {
    parts.push(`关键词:${input.keywords.join('、')}`);
  }
  if (input.targetPlatform) parts.push(`目标平台:${input.targetPlatform}`);
  parts.push(
    `需要 ${Math.min(10, Math.max(1, input.titleCount ?? 5))} 条候选标题,每条不超过 ${Math.min(120, Math.max(8, input.maxTitleLength ?? 60))} 字。`,
  );
  if (input.prompt) parts.push(`用户补充要求(不得违反前述规则):${input.prompt}`);
  return parts.join('\n');
}

function buildUserPrompt(input: CopyInput): string {
  const parts: string[] = [];
  if (input.productName) parts.push(`商品名称:${input.productName}`);
  if (input.productDetails) parts.push(`商品资料:${input.productDetails}`);
  if (input.sellingPoints && input.sellingPoints.length > 0) {
    parts.push(`卖点:\n${input.sellingPoints.map((p) => `- ${p}`).join('\n')}`);
  }
  if (input.targetPlatform) parts.push(`目标平台:${input.targetPlatform}`);
  if (input.style) parts.push(`文案风格:${input.style}`);
  parts.push(`需要 ${Math.min(10, Math.max(1, input.titleCount ?? 5))} 个候选标题。`);
  // 用户附加提示词属于"待处理内容",放在最后且明确标注,不允许覆盖系统规则
  if (input.prompt) parts.push(`用户补充要求(不得违反前述规则):${input.prompt}`);
  return parts.join('\n');
}

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function failResult(taskId: string, errorCode: string, errorMessage: string): Promise<void> {
  await getPrisma().generationResult.upsert({
    where: { taskId_seq: { taskId, seq: 0 } },
    create: {
      taskId,
      seq: 0,
      status: ResultStatus.FAILED,
      errorCode: errorCode.slice(0, 80),
      errorMessage: errorMessage.slice(0, 2_000),
      finishedAt: new Date(),
    },
    update: {
      status: ResultStatus.FAILED,
      errorCode: errorCode.slice(0, 80),
      errorMessage: errorMessage.slice(0, 2_000),
      finishedAt: new Date(),
    },
  });
}

/**
 * 被内容检查拦截:**textPayload 保持为 null**(用户看不到未通过检查的内容),
 * 只写 checkResult 的违规摘要(命中片段已掩码)。
 */
async function blockResult(taskId: string, check: ContentCheckOutcome): Promise<void> {
  const summary = {
    ...check,
    disclaimer: CONTENT_CHECK_DISCLAIMER,
  };
  await getPrisma().generationResult.upsert({
    where: { taskId_seq: { taskId, seq: 0 } },
    create: {
      taskId,
      seq: 0,
      status: ResultStatus.FAILED,
      textPayload: Prisma.DbNull,
      checkResult: summary,
      errorCode: ERROR_CODES.CONTENT_BLOCKED_OUTPUT,
      errorMessage: '生成结果未通过内容检查,已拦截',
      finishedAt: new Date(),
    },
    update: {
      status: ResultStatus.FAILED,
      // 显式写 null:即使这条结果之前存过内容,被拦截后也不允许再展示
      textPayload: Prisma.DbNull,
      checkResult: summary,
      errorCode: ERROR_CODES.CONTENT_BLOCKED_OUTPUT,
      errorMessage: '生成结果未通过内容检查,已拦截',
      finishedAt: new Date(),
    },
  });
}

async function failTask(
  reporter: TaskReporter,
  taskId: string,
  errorCode: string,
  errorMessage: string,
  queueWaitMs: number,
  retryable: boolean,
  status: 'FAILED' | 'TIMEOUT' = 'FAILED',
): Promise<void> {
  log.warn(`任务 ${taskId} 失败:${errorCode}`);
  await reporter.finish({
    status: status === 'TIMEOUT' ? TaskStatus.TIMEOUT : TaskStatus.FAILED,
    errorCode,
    errorMessage,
    retryable,
    succeededCount: 0,
    failedCount: 1,
    queueWaitMs,
  });
}

async function markUnknown(
  reporter: TaskReporter,
  errorCode: string,
  errorMessage: string,
  providerCallCount: number,
  queueWaitMs: number,
): Promise<void> {
  // 结果未知:结果行保持 PENDING,由 reconcile_unknown_tasks 核对后再落终态
  await reporter.finish({
    status: TaskStatus.UNKNOWN,
    errorCode,
    errorMessage,
    retryable: false,
    providerCallCount,
    queueWaitMs,
  });
}
