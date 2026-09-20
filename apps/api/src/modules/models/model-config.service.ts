import { Injectable, Logger } from '@nestjs/common';
import { ModelCapability, ProviderKind, type ModelConfig, type ModelProvider } from '@june/db';
import {
  DEFAULT_MODEL_LIMITS,
  modelLimitsSchema,
  modelPolicyUpdateSchema,
  SSE_CHANNELS,
  type ModelSelectionPolicy,
  type PublicModelConfigResponse,
  type PublicModelOption,
  type SseConfigUpdatedEvent,
} from '@june/shared';

import { loadEnv } from '../../config/env';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { RedisService } from '../../infra/redis/redis.service';

/** ConfigRevision 的 scope 取值,与 SseConfigUpdatedEvent.scope 保持一致 */
export const CONFIG_SCOPES = ['models', 'content', 'share', 'concurrency'] as const;
export type ConfigScope = (typeof CONFIG_SCOPES)[number];

/** SystemConfig 中保存模型选择策略的键 */
export const MODEL_POLICY_KEY = 'models.policy';

export const DEFAULT_MODEL_POLICY: ModelSelectionPolicy = {
  image: { mode: 'user_selectable', fixedModelId: null },
  text: { mode: 'user_selectable', fixedModelId: null },
  title: { mode: 'user_selectable', fixedModelId: null, inheritFromText: true },
};

/** 公开配置缓存时长。真正的失效靠 key 里的 version,TTL 只是兜底回收。 */
const PUBLIC_CONFIG_TTL_SECONDS = 60;

type ModelWithProvider = ModelConfig & { provider: ModelProvider };

/**
 * 模型公开配置与配置版本管理。
 *
 * 缓存策略(重要):公开配置的缓存 key 里带版本号(models:public:v{version})。
 * 配置一变,version 自增,新 key 天然未命中,旧 key 自然过期。
 * 这样**不会出现"用过期缓存把已停用模型放行"**的情况——
 * 而且即便读到了旧缓存,提交任务时 ModelResolverService 也会回源数据库再判一次。
 */
@Injectable()
export class ModelConfigService {
  private readonly logger = new Logger(ModelConfigService.name);
  private readonly env = loadEnv();

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  // ---------------------------------------------------------------------------
  // 版本
  // ---------------------------------------------------------------------------

  /** 读取某个 scope 的当前版本。没有记录时视为 0。 */
  async getRevision(scope: ConfigScope): Promise<number> {
    const row = await this.prisma.db.configRevision.findUnique({ where: { scope } });
    return row?.version ?? 0;
  }

  /** 一次取回全部 scope 的版本,SSE 建连时下发给前端对齐 */
  async getAllRevisions(): Promise<Record<string, number>> {
    const rows = await this.prisma.db.configRevision.findMany();
    const out: Record<string, number> = {};
    for (const scope of CONFIG_SCOPES) out[scope] = 0;
    for (const row of rows) out[row.scope] = row.version;
    return out;
  }

  /**
   * 配置变更后自增版本并广播。
   *
   * 热更新链路:管理员写库 -> 版本自增 -> Redis Pub/Sub 广播 ->
   * 各 API 实例的 SSE 连接转发 config.updated -> 前端按 scope 补拉公开配置。
   * 事件里**只带版本号**,不带任何配置内容,天然不会泄漏密钥。
   *
   * @param disabledModelIds 本次被停用/删除的模型 id。前端据此清除已选中的模型,
   *                         而不是擅自替换成别的供应商。
   */
  async bumpRevision(
    scope: ConfigScope,
    actorId: string | null,
    disabledModelIds?: string[],
  ): Promise<number> {
    const revision = await this.prisma.db.$transaction((tx) =>
      tx.configRevision.upsert({
        where: { scope },
        create: { scope, version: 1, updatedBy: actorId },
        update: { version: { increment: 1 }, updatedBy: actorId },
      }),
    );

    const event: SseConfigUpdatedEvent = {
      type: 'config.updated',
      scope,
      version: revision.version,
      ...(disabledModelIds && disabledModelIds.length > 0 ? { disabledModelIds } : {}),
    };

    try {
      await this.redis.publisher.publish(SSE_CHANNELS.broadcast, JSON.stringify(event));
    } catch (err) {
      // 广播失败不回滚配置:前端重连或下次轮询仍会按版本号对齐到最新状态
      this.logger.error(`配置变更广播失败 scope=${scope}: ${(err as Error).message}`);
    }

    return revision.version;
  }

  // ---------------------------------------------------------------------------
  // 策略
  // ---------------------------------------------------------------------------

  /** 读取模型选择策略。解析失败一律回落到"用户可选",不因脏数据锁死功能。 */
  async getPolicy(): Promise<ModelSelectionPolicy> {
    const row = await this.prisma.db.systemConfig.findUnique({ where: { key: MODEL_POLICY_KEY } });
    if (!row?.value) return DEFAULT_MODEL_POLICY;

    const parsed = modelPolicyUpdateSchema.safeParse(row.value);
    if (!parsed.success) {
      this.logger.warn(`模型策略配置格式异常,已回落为用户可选:${parsed.error.issues[0]?.message ?? ''}`);
      return DEFAULT_MODEL_POLICY;
    }
    return {
      image: parsed.data.image,
      text: parsed.data.text,
      title: parsed.data.title ?? DEFAULT_MODEL_POLICY.title,
    };
  }

  // ---------------------------------------------------------------------------
  // 公开配置
  // ---------------------------------------------------------------------------

  /**
   * 给普通用户的公开模型配置。
   *
   * 只包含渲染表单必需的字段:**绝不包含 apiKey、baseUrl、内部系统提示词**。
   * 过滤条件保证"未配置凭据的模型不会出现在可选列表里"。
   */
  async getPublicConfig(): Promise<PublicModelConfigResponse> {
    const version = await this.getRevision('models');
    const cacheKey = `models:public:v${version}`;

    const cached = await this.redis.getJson<PublicModelConfigResponse>(cacheKey);
    if (cached) return cached;

    const [policy, rows] = await Promise.all([
      this.getPolicy(),
      this.prisma.db.modelConfig.findMany({
        where: {
          enabled: true,
          visible: true,
          deletedAt: null,
          provider: { enabled: true, hasCredential: true, deletedAt: null },
        },
        include: { provider: true },
        orderBy: [{ sortOrder: 'asc' }, { displayName: 'asc' }],
      }),
    ]);

    const options = rows.map((row) => this.toPublicOption(row));

    const imageModels = this.applyPolicy(
      options.filter((o) => o.capabilities.some((c) => c === 'TEXT_TO_IMAGE' || c === 'IMAGE_EDIT')),
      policy.image,
    );
    const textModels = this.applyPolicy(
      options.filter((o) => o.capabilities.includes('TEXT')),
      policy.text,
    );
    const titlePolicy = policy.title.inheritFromText ? policy.text : policy.title;
    const titleModels = this.applyPolicy(
      options.filter((o) => o.capabilities.includes('TEXT')),
      titlePolicy,
    );

    const response: PublicModelConfigResponse = {
      version,
      policy,
      imageModels,
      textModels,
      titleModels,
      concurrency: {
        imagePerUserRunning: this.env.CONCURRENCY_IMAGE_PER_USER_RUNNING,
        imagePerUserPending: this.env.CONCURRENCY_IMAGE_PER_USER_PENDING,
      },
    };

    await this.redis.setJson(cacheKey, response, PUBLIC_CONFIG_TTL_SECONDS);
    return response;
  }

  /**
   * fixed 模式下只返回被指定的那一个模型,前端据此隐藏选择器。
   * 指定模型当前不可用时返回空列表:与其给出一个提交必然失败的选项,
   * 不如让前端明确提示"暂无可用模型"。
   */
  private applyPolicy(
    options: PublicModelOption[],
    policy: ModelSelectionPolicy['image'],
  ): PublicModelOption[] {
    if (policy.mode !== 'fixed') return options;
    if (!policy.fixedModelId) return [];
    return options.filter((o) => o.id === policy.fixedModelId);
  }

  private toPublicOption(row: ModelWithProvider): PublicModelOption {
    const parsed = modelLimitsSchema.safeParse(row.limits);
    if (!parsed.success) {
      this.logger.warn(`模型 ${row.slug} 的 limits 解析失败,已使用最保守的默认值`);
    }

    return {
      id: row.id,
      displayName: row.displayName,
      providerSlug: row.provider.slug,
      providerName: row.provider.name,
      capabilities: row.capabilities,
      isDefault: row.isDefault,
      limits: parsed.success ? parsed.data : DEFAULT_MODEL_LIMITS,
      // 模拟供应商必须显式标识,避免压测数据被当成真实生成结果
      isMock: row.provider.kind === ProviderKind.MOCK,
    };
  }

  /** 把请求侧的能力枚举翻译成 Prisma 枚举 */
  static toPrismaCapability(capability: 'TEXT_TO_IMAGE' | 'IMAGE_EDIT' | 'TEXT'): ModelCapability {
    switch (capability) {
      case 'TEXT_TO_IMAGE':
        return ModelCapability.TEXT_TO_IMAGE;
      case 'IMAGE_EDIT':
        return ModelCapability.IMAGE_EDIT;
      case 'TEXT':
        return ModelCapability.TEXT;
    }
  }
}
