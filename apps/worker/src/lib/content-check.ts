/**
 * 输出内容检查(Worker 侧实现)。
 *
 * ⚠️ 与 API 侧保持同一规则语义:
 *   规则引擎的另一份实现在 apps/api/src/modules/content/(ContentRuleService,由另一任务负责)。
 *   Worker 不能跨 app import,因此这里**自己从数据库读同一张 content_rules 表**并实现同样的
 *   判定语义。两侧的唯一事实来源是数据库里的规则数据 + 本文件顶部记录的语义约定:
 *
 *     - BANNED_WORD     词表包含匹配(大小写不敏感,去除零宽字符后比较)
 *     - BANNED_PHRASE   正则匹配(规则里存的是正则字符串)
 *     - BANNED_CATEGORY 语义类别,Worker 侧用关键词兜底(模型判定在 API 侧的输入检查阶段)
 *     - PLATFORM_RULE   平台限制(标题字数、正文字数、禁用符号)
 *     - SYSTEM_PROMPT   不是检查项,而是注入模型的系统提示词(**绝不下发前端、绝不写日志**)
 *
 *     action: BLOCK 直接拦截 / REWRITE 要求模型有限次数重写 / WARN 仅记录
 *     platforms 为空数组表示适用全部平台
 *
 *   若两侧语义出现分歧,以 apps/api 的 ContentRuleService 为准并同步修改本文件。
 *
 * 命中片段一律掩码后再落库/展示,避免把敏感内容原样回显给用户或写进日志。
 */
import { ContentRuleType, RuleAction, type ContentRule } from '@june/db';
import type { ContentCheckOutcome } from '@june/shared';

import { createLogger } from './logger';
import { getPrisma } from './prisma';

const log = createLogger('content-check');

export type Violation = ContentCheckOutcome['violations'][number];

export interface CheckField {
  /** 字段名,用于告诉用户是哪一部分不合规:title / titles[0] / body / highlights[1] ... */
  field: string;
  value: string;
}

/** 命中片段掩码:保留首字符,其余固定替换,不回显完整敏感词 */
export function maskMatched(matched: string): string {
  const trimmed = matched.trim().slice(0, 40);
  if (trimmed.length === 0) return '***';
  if (trimmed.length === 1) return `${trimmed}*`;
  return `${trimmed[0]}${'*'.repeat(Math.min(6, trimmed.length - 1))}`;
}

/** 去掉零宽字符与重复空白,防止用"违*禁*词"之类的插入绕过词表 */
function normalizeForMatch(value: string): string {
  return value
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

// ---------------------------------------------------------------------------
// 规则载荷读取(容错:payload 由后台录入,字段名允许几种常见写法)
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readStringArray(payload: Record<string, unknown>, keys: string[]): string[] {
  for (const key of keys) {
    const raw = payload[key];
    if (Array.isArray(raw)) {
      return raw.filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
    }
    if (typeof raw === 'string' && raw.trim().length > 0) {
      // 允许后台用换行/逗号分隔的一段文本录入词表
      return raw
        .split(/[\n,,、]/)
        .map((s) => s.trim())
        .filter(Boolean);
    }
  }
  return [];
}

function readNumber(payload: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const raw = payload[key];
    if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return raw;
    if (typeof raw === 'string' && raw.trim() && Number.isFinite(Number(raw))) return Number(raw);
  }
  return null;
}

function readText(payload: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const raw = payload[key];
    if (typeof raw === 'string' && raw.trim().length > 0) return raw;
  }
  return '';
}

// ---------------------------------------------------------------------------
// 取规则
// ---------------------------------------------------------------------------

export interface LoadRulesOptions {
  /** 目标平台标识。规则的 platforms 为空数组表示适用全部平台 */
  platform: string;
  /** 输出检查取 applyToOutput,输入检查取 applyToInput */
  phase: 'input' | 'output';
}

export async function loadRules(options: LoadRulesOptions): Promise<ContentRule[]> {
  const rules = await getPrisma().contentRule.findMany({
    where: {
      enabled: true,
      deletedAt: null,
      ...(options.phase === 'output' ? { applyToOutput: true } : { applyToInput: true }),
    },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
  });

  return rules.filter((r) => r.platforms.length === 0 || r.platforms.includes(options.platform));
}

/**
 * 拼装注入模型的系统提示词。
 * **内部系统提示词绝不下发前端、绝不写入日志**(docs/CONVENTIONS.md §11),
 * 这里只返回字符串给适配器使用,调用方不得把它放进 SSE 事件或错误信息。
 */
export async function buildSystemPrompt(platform: string): Promise<string> {
  const rules = await loadRules({ platform, phase: 'output' });
  const prompts = rules
    .filter((r) => r.type === ContentRuleType.SYSTEM_PROMPT)
    .map((r) => readText(asRecord(r.payload), ['prompt', 'text', 'content', 'value']))
    .filter(Boolean);

  // 顺带把违禁词/禁用表达也告知模型,能显著降低"生成出来才被拦"的概率
  const banned = new Set<string>();
  for (const rule of rules) {
    if (rule.type === ContentRuleType.BANNED_WORD || rule.type === ContentRuleType.BANNED_CATEGORY) {
      for (const word of readStringArray(asRecord(rule.payload), ['words', 'terms', 'list', 'keywords', 'values'])) {
        banned.add(word);
      }
    }
  }
  if (banned.size > 0) {
    prompts.push(`以下表达严格禁止出现在输出中:${[...banned].slice(0, 200).join('、')}。`);
  }

  return prompts.join('\n\n');
}

// ---------------------------------------------------------------------------
// 执行检查
// ---------------------------------------------------------------------------

/** 纯函数:给定规则与待检字段,产出检查结论。便于单测与与 API 侧对照。 */
export function evaluateRules(
  rules: ContentRule[],
  fields: CheckField[],
  phase: 'input' | 'output',
  rewriteCount: number,
  startedAt: number,
): ContentCheckOutcome {
  const violations: Violation[] = [];

  for (const rule of rules) {
    const payload = asRecord(rule.payload);

    switch (rule.type) {
      case ContentRuleType.SYSTEM_PROMPT:
        // 系统提示词不参与检查
        break;

      case ContentRuleType.BANNED_WORD:
      case ContentRuleType.BANNED_CATEGORY: {
        const words = readStringArray(payload, ['words', 'terms', 'list', 'keywords', 'values']);
        for (const field of fields) {
          const haystack = normalizeForMatch(field.value);
          for (const word of words) {
            const needle = normalizeForMatch(word);
            if (needle && haystack.includes(needle)) {
              violations.push(toViolation(rule, field.field, word));
              break;
            }
          }
        }
        break;
      }

      case ContentRuleType.BANNED_PHRASE: {
        const patterns = readStringArray(payload, ['patterns', 'regexes', 'regex', 'list', 'values']);
        for (const source of patterns) {
          let regex: RegExp;
          try {
            regex = new RegExp(source, 'iu');
          } catch {
            log.warn(`规则 ${rule.id} 的正则无法编译,已跳过`);
            continue;
          }
          for (const field of fields) {
            const match = regex.exec(field.value);
            if (match) violations.push(toViolation(rule, field.field, match[0]));
          }
        }
        break;
      }

      case ContentRuleType.PLATFORM_RULE: {
        const titleMax = readNumber(payload, ['titleMaxChars', 'titleMax', 'maxTitleLength']);
        const bodyMax = readNumber(payload, ['bodyMaxChars', 'bodyMax', 'maxBodyLength']);
        const forbiddenChars = readStringArray(payload, ['forbiddenChars', 'bannedChars', 'chars']);

        for (const field of fields) {
          const isTitle = field.field.startsWith('title');
          const isBody = field.field === 'body';
          const limit = isTitle ? titleMax : isBody ? bodyMax : null;
          if (limit !== null && field.value.length > limit) {
            violations.push(
              toViolation(rule, field.field, `长度 ${field.value.length} 超过平台上限 ${limit}`, true),
            );
          }
          for (const ch of forbiddenChars) {
            if (ch && field.value.includes(ch)) {
              violations.push(toViolation(rule, field.field, ch));
            }
          }
        }
        break;
      }

      default:
        break;
    }
  }

  const blocking = violations.filter((v) => v.action === RuleAction.BLOCK);
  return {
    passed: blocking.length === 0,
    phase,
    violations,
    rewriteCount,
    durationMs: Date.now() - startedAt,
  };
}

function toViolation(rule: ContentRule, field: string, matched: string, plainMessage = false): Violation {
  return {
    ruleId: rule.id,
    ruleName: rule.name,
    ruleType: rule.type as Violation['ruleType'],
    action: rule.action as Violation['action'],
    matched: plainMessage ? matched.slice(0, 80) : maskMatched(matched),
    field,
  };
}

/** 从数据库取规则并执行输出检查 */
export async function checkOutput(params: {
  platform: string;
  fields: CheckField[];
  rewriteCount: number;
}): Promise<ContentCheckOutcome> {
  const startedAt = Date.now();
  const rules = await loadRules({ platform: params.platform, phase: 'output' });
  return evaluateRules(rules, params.fields, 'output', params.rewriteCount, startedAt);
}

/** 是否存在"要求模型重写"的命中(BLOCK 优先级更高,已在 passed 里体现) */
export function needsRewrite(outcome: ContentCheckOutcome): boolean {
  return outcome.violations.some((v) => v.action === RuleAction.REWRITE);
}

/** 给模型的重写指令。只描述违规类别与字段,不回显完整敏感内容。 */
export function buildRewriteInstruction(outcome: ContentCheckOutcome): string {
  const items = outcome.violations
    .filter((v) => v.action === RuleAction.BLOCK || v.action === RuleAction.REWRITE)
    .slice(0, 20)
    .map((v) => `- 字段 ${v.field} 违反「${v.ruleName}」(命中:${v.matched})`);
  return [
    '上一次输出未通过平台内容检查,请重写。必须修正以下问题,同时保持商品信息准确:',
    ...items,
    '重写时不要使用绝对化用语、不要出现被禁止的表达,严格按要求的 JSON 结构输出。',
  ].join('\n');
}
