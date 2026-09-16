/**
 * 种子数据。
 *
 * 边界(重要):
 *  1. 本脚本只写入"平台运行所必需的基础配置":角色、配置修订号、系统配置骨架、
 *     供应商与模型目录、内容规则。这些属于系统数据,可在生产环境安全执行。
 *  2. 所有供应商的 API Key 一律留空(hasCredential=false、enabled=false),
 *     limits.verified=false,管理后台会显著标注"待真实联调"。
 *     缺少凭据时模型不会出现在用户可选列表,也绝不冒充生成成功。
 *  3. 演示业务数据(用户/店铺/商品/帖子)只在 SEED_DEMO=true 时写入,
 *     且邮箱统一使用 @demo.june.invalid 域、名称统一带 [DEMO] 前缀,
 *     与真实数据、压测数据(@loadtest.invalid)三者互不混淆。
 *     生产环境请勿设置 SEED_DEMO。
 *  4. 幂等:全部使用 upsert,可重复执行。
 *
 * 用法:
 *   pnpm --filter @june/db seed
 *   SEED_DEMO=true pnpm --filter @june/db seed     # 附带演示数据
 *   SEED_DEMO=true SEED_DEMO_PASSWORD=xxx pnpm ... # 自定义演示账号密码
 */

import { randomBytes } from 'node:crypto';

import 'dotenv/config';
import { hash } from '@node-rs/argon2';

import { createPrismaClient } from '../src/client';
import { DEFAULT_ROLES, ROLE_USER } from '../src/constants';
import {
  AssetKind,
  AssetStatus,
  AssetVisibility,
  ContentRuleType,
  ModelCapability,
  PostStatus,
  ProductStatus,
  ProviderKind,
  RuleAction,
  ShopStatus,
  ShopType,
} from '../generated/prisma/client';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('缺少 DATABASE_URL。请先复制 .env.example 为 .env 并填写数据库连接串。');
}

// 种子是一次性脚本,连接池给小值即可,不要占用运行时的连接额度
const prisma = createPrismaClient({ connectionString, poolMax: 3, logQueries: false });

/** 演示数据统一标识,便于一键清理与人工辨认 */
const DEMO_EMAIL_DOMAIN = 'demo.june.invalid';
const DEMO_PREFIX = '[DEMO]';

// ---------------------------------------------------------------------------
// 1. 角色
// ---------------------------------------------------------------------------
async function seedRoles(): Promise<void> {
  for (const role of DEFAULT_ROLES) {
    await prisma.role.upsert({
      where: { slug: role.slug },
      create: {
        slug: role.slug,
        name: role.name,
        description: role.description,
        level: role.level,
        permissions: role.permissions,
        isSystem: true,
      },
      // 权限点会随版本演进,以代码定义为准覆盖数据库
      update: {
        name: role.name,
        description: role.description,
        level: role.level,
        permissions: role.permissions,
      },
    });
  }
  console.log(`[seed] 角色 ${DEFAULT_ROLES.length} 个`);
}

// ---------------------------------------------------------------------------
// 2. 配置修订号(SSE 配置同步的版本基准)
// ---------------------------------------------------------------------------
const CONFIG_SCOPES = ['models', 'content', 'share', 'concurrency', 'system'] as const;

async function seedConfigRevisions(): Promise<void> {
  for (const scope of CONFIG_SCOPES) {
    await prisma.configRevision.upsert({
      where: { scope },
      create: { scope, version: 1 },
      update: {},
    });
  }
  console.log(`[seed] 配置修订号 ${CONFIG_SCOPES.length} 个 scope`);
}

// ---------------------------------------------------------------------------
// 3. 系统配置骨架
//    isSecret 的项这里只建占位(值为空),真实密钥通过管理后台写入并加密存储,
//    绝不写在种子或代码里。
// ---------------------------------------------------------------------------
interface SystemConfigSeed {
  key: string;
  group: string;
  description: string;
  isPublic: boolean;
  isSecret: boolean;
  value?: unknown;
}

const SYSTEM_CONFIGS: SystemConfigSeed[] = [
  {
    key: 'models.policy',
    group: 'models',
    description:
      '模型选择策略。mode=user_selectable 时用户可选;mode=fixed 时前端隐藏选择器,后端强制使用 fixedModelId,改请求参数无法绕过。',
    isPublic: true,
    isSecret: false,
    value: {
      image: { mode: 'user_selectable', fixedModelId: null },
      text: { mode: 'user_selectable', fixedModelId: null },
    },
  },
  {
    key: 'concurrency.limits',
    group: 'concurrency',
    description:
      '并发初值。全局限制覆盖所有 Worker 实例(Redis 计数),供应商频率限制另在 ModelProvider 上配置。硬上限由 API 侧 zod 校验兜底。',
    isPublic: false,
    isSecret: false,
    value: {
      imageGlobal: 5,
      textGlobal: 10,
      imagePerUserRunning: 1,
      imagePerUserPending: 3,
      imageProcess: 2,
      queueCapacityImage: 200,
      queueCapacityText: 400,
    },
  },
  {
    key: 'storage.quota',
    group: 'storage',
    description: '新用户默认存储配额(字节)与上传单文件上限。上传前检查额度。',
    isPublic: false,
    isSecret: false,
    value: { defaultQuotaBytes: 5 * 1024 * 1024 * 1024, maxUploadBytes: 20 * 1024 * 1024 },
  },
  {
    key: 'share.enabled',
    group: 'share',
    description: '分享渠道开关。缺少配置的渠道前端会明确提示并降级为复制链接/二维码。',
    isPublic: true,
    isSecret: false,
    value: { link: true, qrcode: true, wechat: false, qq: false },
  },
  {
    key: 'share.wechat.appId',
    group: 'share',
    description: '微信公众号/开放平台 AppId。JS-SDK 签名在后端生成,前端只拿到签名结果。',
    isPublic: true,
    isSecret: false,
    value: null,
  },
  {
    key: 'share.wechat.appSecret',
    group: 'share',
    description: '微信 AppSecret。加密存储,读接口只返回掩码,绝不下发前端。',
    isPublic: false,
    isSecret: true,
  },
  {
    key: 'share.qq.appId',
    group: 'share',
    description: 'QQ 互联 AppId。未配置时 QQ 分享按钮明确提示不可用并降级。',
    isPublic: true,
    isSecret: false,
    value: null,
  },
  {
    key: 'share.jsApiDomains',
    group: 'share',
    description: '允许调用 JS-SDK 的安全域名列表,需与微信后台配置一致。',
    isPublic: false,
    isSecret: false,
    value: [],
  },
  {
    key: 'content.rewriteMaxAttempts',
    group: 'content',
    description: '输出检查未通过时允许模型重写的最大次数,超过则拦截,不展示未通过内容。',
    isPublic: false,
    isSecret: false,
    value: 2,
  },
];

async function seedSystemConfigs(): Promise<void> {
  for (const cfg of SYSTEM_CONFIGS) {
    await prisma.systemConfig.upsert({
      where: { key: cfg.key },
      create: {
        key: cfg.key,
        group: cfg.group,
        description: cfg.description,
        isPublic: cfg.isPublic,
        isSecret: cfg.isSecret,
        value: cfg.isSecret ? undefined : (cfg.value as never),
      },
      // 已存在的配置值不覆盖(可能已被管理员在后台调整),只同步描述与分类
      update: {
        group: cfg.group,
        description: cfg.description,
        isPublic: cfg.isPublic,
        isSecret: cfg.isSecret,
      },
    });
  }
  console.log(`[seed] 系统配置 ${SYSTEM_CONFIGS.length} 项(密钥类仅建占位)`);
}

// ---------------------------------------------------------------------------
// 4. 供应商与模型目录
//
//    limits 依据各家公开文档整理,但由于本环境没有可用凭据,
//    统一标记 verified=false(= 待真实联调)。管理后台会显著提示,
//    并且 hasCredential=false 的供应商下所有模型都不会出现在用户可选列表中。
//    真实接入时:后台填入 API Key -> 连接测试 -> 小规模联调 -> 手动把 verified 置 true。
// ---------------------------------------------------------------------------
interface ProviderSeed {
  slug: string;
  kind: ProviderKind;
  name: string;
  baseUrl: string;
  sortOrder: number;
  rateLimitPerMinute: number;
  maxConcurrency: number;
  models: Array<{
    slug: string;
    displayName: string;
    modelKey: string;
    capabilities: ModelCapability[];
    limits: Record<string, unknown>;
    defaultParams?: Record<string, unknown>;
  }>;
}

const PROVIDERS: ProviderSeed[] = [
  {
    slug: 'openai',
    kind: ProviderKind.OPENAI,
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    sortOrder: 10,
    rateLimitPerMinute: 60,
    maxConcurrency: 4,
    models: [
      {
        slug: 'openai-gpt-image-1',
        displayName: 'GPT Image 1(文生图 / 参考图编辑)',
        modelKey: 'gpt-image-1',
        capabilities: [ModelCapability.TEXT_TO_IMAGE, ModelCapability.IMAGE_EDIT],
        limits: {
          maxOutputs: 8,
          maxOutputsPerCall: 4,
          maxReferenceImages: 4,
          sizes: ['1024x1024', '1536x1024', '1024x1536'],
          sizeMode: 'size_string',
          deliveryMode: 'sync',
          // images.generate 默认返回 b64_json
          resultCarrier: 'base64',
          supportsNegativePrompt: false,
          supportsSeed: false,
          supportsImageEdit: true,
          maxPromptChars: 32000,
          docsUrl: 'https://platform.openai.com/docs/api-reference/images',
          verified: false,
        },
        defaultParams: { quality: 'high', background: 'auto' },
      },
      {
        slug: 'openai-gpt-4o-mini-copy',
        displayName: 'GPT-4o mini(标题与文案)',
        modelKey: 'gpt-4o-mini',
        capabilities: [ModelCapability.TEXT],
        limits: {
          deliveryMode: 'sync',
          supportsStructuredOutput: true,
          maxOutputTokens: 4096,
          maxPromptChars: 24000,
          docsUrl: 'https://platform.openai.com/docs/guides/structured-outputs',
          verified: false,
        },
        defaultParams: { temperature: 0.8 },
      },
    ],
  },
  {
    slug: 'gemini',
    kind: ProviderKind.GEMINI,
    name: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    sortOrder: 20,
    rateLimitPerMinute: 60,
    maxConcurrency: 4,
    models: [
      {
        slug: 'gemini-2-5-flash-image',
        displayName: 'Gemini 2.5 Flash Image(文生图 / 图像编辑)',
        modelKey: 'gemini-2.5-flash-image',
        capabilities: [ModelCapability.TEXT_TO_IMAGE, ModelCapability.IMAGE_EDIT],
        limits: {
          // generateContent 每次返回一张图,多张由适配层拆分为多次调用
          maxOutputs: 4,
          maxOutputsPerCall: 1,
          maxReferenceImages: 3,
          aspectRatios: ['1:1', '3:4', '4:3', '9:16', '16:9'],
          sizeMode: 'aspect_ratio',
          deliveryMode: 'sync',
          resultCarrier: 'base64',
          supportsImageEdit: true,
          maxPromptChars: 8000,
          docsUrl: 'https://ai.google.dev/gemini-api/docs/image-generation',
          verified: false,
        },
      },
      {
        slug: 'gemini-2-5-flash-copy',
        displayName: 'Gemini 2.5 Flash(标题与文案)',
        modelKey: 'gemini-2.5-flash',
        capabilities: [ModelCapability.TEXT],
        limits: {
          deliveryMode: 'sync',
          supportsStructuredOutput: true,
          maxOutputTokens: 8192,
          maxPromptChars: 24000,
          docsUrl: 'https://ai.google.dev/gemini-api/docs/structured-output',
          verified: false,
        },
      },
    ],
  },
  {
    slug: 'ark-seedream',
    kind: ProviderKind.ARK_SEEDREAM,
    name: '火山方舟 Seedream',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    sortOrder: 30,
    rateLimitPerMinute: 60,
    maxConcurrency: 3,
    models: [
      {
        slug: 'ark-seedream-4-0',
        displayName: 'Seedream 4.0(文生图 / 参考图)',
        modelKey: 'doubao-seedream-4-0-250828',
        capabilities: [ModelCapability.TEXT_TO_IMAGE, ModelCapability.IMAGE_EDIT],
        limits: {
          maxOutputs: 8,
          maxOutputsPerCall: 1,
          maxReferenceImages: 6,
          sizes: ['1024x1024', '2048x2048', '2304x1728', '1728x2304', '2560x1440', '1440x2560'],
          sizeMode: 'size_string',
          deliveryMode: 'sync',
          resultCarrier: 'url',
          // 方舟返回的图片链接是短时有效的,必须及时转存
          resultUrlTtlSeconds: 86400,
          supportsSeed: true,
          supportsImageEdit: true,
          maxPromptChars: 3000,
          docsUrl: 'https://www.volcengine.com/docs/82379',
          verified: false,
        },
        defaultParams: { watermark: false, response_format: 'url' },
      },
    ],
  },
  {
    slug: 'aliyun-wanx',
    kind: ProviderKind.ALIYUN_WANX,
    name: '阿里云通义万相',
    baseUrl: 'https://dashscope.aliyuncs.com/api/v1',
    sortOrder: 40,
    rateLimitPerMinute: 30,
    maxConcurrency: 2,
    models: [
      {
        slug: 'wanx-v2-t2i-turbo',
        displayName: '通义万相 文生图 Turbo(异步)',
        modelKey: 'wanx2.1-t2i-turbo',
        capabilities: [ModelCapability.TEXT_TO_IMAGE],
        limits: {
          maxOutputs: 4,
          maxOutputsPerCall: 4,
          maxReferenceImages: 0,
          sizes: ['1024x1024', '1280x720', '720x1280', '1152x768', '768x1152'],
          sizeMode: 'size_string',
          // DashScope 图像生成是"提交任务 + 轮询 task_id"模式
          deliveryMode: 'async_poll',
          resultCarrier: 'url',
          resultUrlTtlSeconds: 86400,
          supportsNegativePrompt: true,
          supportsSeed: true,
          maxPromptChars: 800,
          docsUrl: 'https://help.aliyun.com/zh/model-studio/text-to-image',
          verified: false,
        },
        defaultParams: { prompt_extend: true, watermark: false },
      },
    ],
  },
  {
    slug: 'bfl-flux',
    kind: ProviderKind.BFL_FLUX,
    name: 'Black Forest Labs FLUX',
    baseUrl: 'https://api.bfl.ai/v1',
    sortOrder: 50,
    rateLimitPerMinute: 24,
    maxConcurrency: 2,
    models: [
      {
        slug: 'flux-pro-1-1',
        displayName: 'FLUX 1.1 Pro(异步轮询)',
        modelKey: 'flux-pro-1.1',
        capabilities: [ModelCapability.TEXT_TO_IMAGE],
        limits: {
          // BFL 每次请求产出一张,多张由适配层拆分
          maxOutputs: 4,
          maxOutputsPerCall: 1,
          maxReferenceImages: 0,
          sizeMode: 'width_height',
          minWidth: 256,
          maxWidth: 1440,
          minHeight: 256,
          maxHeight: 1440,
          dimensionStep: 32,
          deliveryMode: 'async_poll',
          resultCarrier: 'url',
          // BFL 结果链接有效期很短(约 10 分钟),必须立刻转存
          resultUrlTtlSeconds: 600,
          supportsSeed: true,
          maxPromptChars: 2000,
          docsUrl: 'https://docs.bfl.ai/',
          verified: false,
        },
        defaultParams: { output_format: 'png', safety_tolerance: 2 },
      },
      {
        slug: 'flux-kontext-pro',
        displayName: 'FLUX.1 Kontext Pro(参考图编辑,异步)',
        modelKey: 'flux-kontext-pro',
        capabilities: [ModelCapability.IMAGE_EDIT],
        limits: {
          maxOutputs: 4,
          maxOutputsPerCall: 1,
          maxReferenceImages: 1,
          aspectRatios: ['1:1', '3:4', '4:3', '9:16', '16:9'],
          sizeMode: 'aspect_ratio',
          deliveryMode: 'async_poll',
          resultCarrier: 'url',
          resultUrlTtlSeconds: 600,
          supportsImageEdit: true,
          supportsSeed: true,
          maxPromptChars: 2000,
          docsUrl: 'https://docs.bfl.ai/',
          verified: false,
        },
        defaultParams: { output_format: 'png' },
      },
    ],
  },
  {
    // 压测专用。响应带 x-june-mock-provider 头,产出图片带明显标识,
    // 只用于容量压测,绝不代表真实模型能力。默认停用。
    slug: 'mock-loadtest',
    kind: ProviderKind.MOCK,
    name: '【压测模拟】Mock Provider(非真实模型)',
    baseUrl: 'http://mock-provider:4010/v1',
    sortOrder: 900,
    rateLimitPerMinute: 0,
    maxConcurrency: 0,
    models: [
      {
        slug: 'mock-image',
        displayName: '【压测模拟】生图(非真实)',
        modelKey: 'mock-image-1',
        capabilities: [ModelCapability.TEXT_TO_IMAGE, ModelCapability.IMAGE_EDIT],
        limits: {
          maxOutputs: 4,
          maxOutputsPerCall: 4,
          maxReferenceImages: 2,
          sizes: ['512x512', '1024x1024'],
          sizeMode: 'size_string',
          deliveryMode: 'sync',
          resultCarrier: 'base64',
          supportsImageEdit: true,
          verified: false,
        },
      },
      {
        slug: 'mock-text',
        displayName: '【压测模拟】文案(非真实)',
        modelKey: 'mock-text-1',
        capabilities: [ModelCapability.TEXT],
        limits: { deliveryMode: 'sync', supportsStructuredOutput: true, maxOutputTokens: 2048, verified: false },
      },
    ],
  },
];

async function seedProviders(): Promise<void> {
  let modelCount = 0;

  for (const p of PROVIDERS) {
    const provider = await prisma.modelProvider.upsert({
      where: { slug: p.slug },
      create: {
        slug: p.slug,
        kind: p.kind,
        name: p.name,
        baseUrl: p.baseUrl,
        // 没有凭据一律停用,避免用户看到"看起来可用"的模型
        enabled: false,
        hasCredential: false,
        sortOrder: p.sortOrder,
        rateLimitPerMinute: p.rateLimitPerMinute,
        maxConcurrency: p.maxConcurrency,
      },
      // 已存在则不动 enabled / 密钥 / baseUrl(可能已被管理员改过),只同步展示信息
      update: { name: p.name, kind: p.kind, sortOrder: p.sortOrder },
    });

    for (const m of p.models) {
      await prisma.modelConfig.upsert({
        where: { slug: m.slug },
        create: {
          providerId: provider.id,
          slug: m.slug,
          displayName: m.displayName,
          modelKey: m.modelKey,
          capabilities: m.capabilities,
          enabled: false,
          visible: true,
          sortOrder: p.sortOrder,
          isDefault: false,
          limits: m.limits as never,
          defaultParams: (m.defaultParams ?? {}) as never,
        },
        update: {
          displayName: m.displayName,
          capabilities: m.capabilities,
          // limits 以代码为准同步(含 docsUrl / verified 标记),便于随文档更新
          limits: m.limits as never,
        },
      });
      modelCount += 1;
    }
  }

  console.log(
    `[seed] 供应商 ${PROVIDERS.length} 家 / 模型 ${modelCount} 个 —— 全部为「待真实联调」状态:` +
      '未配置 API Key、默认停用、不会出现在用户可选列表',
  );
}

// ---------------------------------------------------------------------------
// 5. 内容规则
//    SYSTEM_PROMPT 只在后端拼装提示词时使用,绝不下发前端。
// ---------------------------------------------------------------------------
interface ContentRuleSeed {
  name: string;
  type: ContentRuleType;
  action: RuleAction;
  platforms: string[];
  payload: Record<string, unknown>;
  applyToInput: boolean;
  applyToOutput: boolean;
  sortOrder: number;
}

const CONTENT_RULES: ContentRuleSeed[] = [
  {
    name: '电商文案基础系统规则',
    type: ContentRuleType.SYSTEM_PROMPT,
    action: RuleAction.WARN,
    platforms: [],
    applyToInput: false,
    applyToOutput: false,
    sortOrder: 10,
    payload: {
      text: [
        '你是电商运营文案助手,只输出与商品营销相关的内容。',
        '硬性要求:',
        '1. 不得使用绝对化用语(如"最""第一""国家级""顶级""绝对")。',
        '2. 不得作出功效、疗效、治疗、投资收益等承诺性表述。',
        '3. 不得编造未提供的资质、奖项、检测报告、销量与用户评价数据。',
        '4. 不得包含联系方式、外部链接、二维码引导或跨平台导流。',
        '5. 不得包含歧视、低俗、暴力、政治敏感内容。',
        '6. 只描述用户提供的商品信息,信息不足时如实概括,不虚构参数。',
        '7. 严格按要求的 JSON 结构输出,不要输出解释性文字或 Markdown 代码块。',
      ].join('\n'),
    },
  },
  {
    name: '广告法绝对化用语',
    type: ContentRuleType.BANNED_WORD,
    action: RuleAction.REWRITE,
    platforms: [],
    applyToInput: false,
    applyToOutput: true,
    sortOrder: 20,
    payload: {
      caseSensitive: false,
      words: [
        '最好',
        '最佳',
        '最优',
        '最便宜',
        '最低价',
        '第一品牌',
        '全国第一',
        '世界第一',
        '国家级',
        '国家免检',
        '顶级',
        '极品',
        '绝无仅有',
        '独一无二',
        '史上最',
        '万能',
        '100%有效',
        '永久',
        '彻底根治',
      ],
    },
  },
  {
    name: '医疗与功效承诺',
    type: ContentRuleType.BANNED_CATEGORY,
    action: RuleAction.BLOCK,
    platforms: [],
    applyToInput: true,
    applyToOutput: true,
    sortOrder: 30,
    payload: {
      category: 'medical_claim',
      description: '宣称治疗、治愈、替代药物或医疗器械功效',
      keywords: ['治愈', '根治', '特效药', '包治', '抗癌', '降血压', '降血糖', '壮阳', '丰胸', '减肥不反弹'],
    },
  },
  {
    name: '违法与违规品类',
    type: ContentRuleType.BANNED_CATEGORY,
    action: RuleAction.BLOCK,
    platforms: [],
    applyToInput: true,
    applyToOutput: true,
    sortOrder: 40,
    payload: {
      category: 'illegal_goods',
      description: '法律禁止或平台禁售的商品与服务',
      keywords: ['枪支', '弹药', '毒品', '管制刀具', '窃听器', '发票代开', '代考', '身份证购买', '走私'],
    },
  },
  {
    name: '跨平台导流与联系方式',
    type: ContentRuleType.BANNED_PHRASE,
    action: RuleAction.BLOCK,
    platforms: [],
    applyToInput: false,
    applyToOutput: true,
    sortOrder: 50,
    payload: {
      flags: 'i',
      patterns: [
        // 微信/QQ 号引导
        '(加|微|VX|vx|wx)\\s*[:: ]?\\s*[a-zA-Z0-9_-]{5,20}',
        '(QQ|qq)\\s*[:: ]?\\s*\\d{5,12}',
        // 手机号
        '1[3-9]\\d{9}',
        // 外部链接
        'https?://[^\\s]+',
      ],
    },
  },
  {
    name: '淘宝 / 天猫标题规则',
    type: ContentRuleType.PLATFORM_RULE,
    action: RuleAction.REWRITE,
    platforms: ['taobao'],
    applyToInput: false,
    applyToOutput: true,
    sortOrder: 60,
    payload: { maxTitleChars: 30, maxBodyChars: 2000, forbiddenSymbols: ['★', '☆', '❤', '【】'] },
  },
  {
    name: '京东标题规则',
    type: ContentRuleType.PLATFORM_RULE,
    action: RuleAction.REWRITE,
    platforms: ['jd'],
    applyToInput: false,
    applyToOutput: true,
    sortOrder: 61,
    payload: { maxTitleChars: 60, maxBodyChars: 2000, forbiddenSymbols: ['★', '☆', '❤'] },
  },
  {
    name: '小红书文案规则',
    type: ContentRuleType.PLATFORM_RULE,
    action: RuleAction.REWRITE,
    platforms: ['xiaohongshu'],
    applyToInput: false,
    applyToOutput: true,
    sortOrder: 62,
    payload: { maxTitleChars: 20, maxBodyChars: 1000 },
  },
  {
    name: '抖音电商文案规则',
    type: ContentRuleType.PLATFORM_RULE,
    action: RuleAction.REWRITE,
    platforms: ['douyin'],
    applyToInput: false,
    applyToOutput: true,
    sortOrder: 63,
    payload: { maxTitleChars: 30, maxBodyChars: 1200, forbiddenSymbols: ['★', '☆'] },
  },
  {
    name: 'Amazon 标题规则',
    type: ContentRuleType.PLATFORM_RULE,
    action: RuleAction.REWRITE,
    platforms: ['amazon'],
    applyToInput: false,
    applyToOutput: true,
    sortOrder: 64,
    payload: { maxTitleChars: 200, maxBodyChars: 2000, forbiddenSymbols: ['!', '$', '?'] },
  },
];

async function seedContentRules(): Promise<void> {
  for (const rule of CONTENT_RULES) {
    const existing = await prisma.contentRule.findFirst({
      where: { name: rule.name, deletedAt: null },
      select: { id: true },
    });

    if (existing) {
      // 已存在的规则可能被管理员改过,种子不覆盖内容,仅保证存在
      continue;
    }

    const created = await prisma.contentRule.create({
      data: {
        name: rule.name,
        type: rule.type,
        action: rule.action,
        platforms: rule.platforms,
        payload: rule.payload as never,
        applyToInput: rule.applyToInput,
        applyToOutput: rule.applyToOutput,
        enabled: true,
        sortOrder: rule.sortOrder,
        version: 1,
        createdBy: 'seed',
      },
    });

    // 初始版本快照,后续每次修改都会追加新版本
    await prisma.contentRuleVersion.create({
      data: {
        ruleId: created.id,
        version: 1,
        snapshot: rule as never,
        changedBy: 'seed',
        changeNote: '种子初始化',
      },
    });
  }
  console.log(`[seed] 内容规则 ${CONTENT_RULES.length} 条(含系统提示词、违禁词、类别、平台规则)`);
}

// ---------------------------------------------------------------------------
// 6. 演示业务数据(仅 SEED_DEMO=true)
// ---------------------------------------------------------------------------
async function seedDemoData(): Promise<void> {
  const password = process.env.SEED_DEMO_PASSWORD ?? `Demo-${randomBytes(9).toString('base64url')}`;
  const passwordHash = await hash(password, { algorithm: 2, memoryCost: 19456, timeCost: 2, parallelism: 1 });

  const userRole = await prisma.role.findUniqueOrThrow({ where: { slug: ROLE_USER } });
  const quotaBytes = BigInt(5 * 1024 * 1024 * 1024);

  const demoUsers = [
    { email: `alice@${DEMO_EMAIL_DOMAIN}`, displayName: `${DEMO_PREFIX} 演示用户 Alice` },
    { email: `bob@${DEMO_EMAIL_DOMAIN}`, displayName: `${DEMO_PREFIX} 演示用户 Bob` },
  ];

  const userIds: string[] = [];

  for (const u of demoUsers) {
    const user = await prisma.user.upsert({
      where: { email: u.email },
      create: {
        email: u.email,
        passwordHash,
        displayName: u.displayName,
        bio: '演示账号,用于本地功能走查。可随时清理。',
        roles: { create: { roleId: userRole.id, grantedBy: 'seed' } },
        storageUsage: { create: { quotaBytes } },
      },
      update: { passwordHash },
    });
    userIds.push(user.id);
  }

  const aliceId = userIds[0];
  if (!aliceId) throw new Error('演示用户创建失败');

  // 主店 + 两个子店,演示继承与覆盖
  const mainShop = await prisma.shop.upsert({
    where: { id: 'demo-shop-main' },
    create: {
      id: 'demo-shop-main',
      ownerId: aliceId,
      type: ShopType.MAIN,
      status: ShopStatus.ACTIVE,
      name: `${DEMO_PREFIX} 主店铺·家居旗舰`,
      platform: 'taobao',
      url: 'https://example.invalid/demo-main',
      description: '演示主店铺',
      contactName: '俊哥',
      contactInfo: 'demo-contact@example.invalid',
      note: '主店备注(子店默认继承)',
    },
    update: {},
  });

  await prisma.shop.upsert({
    where: { id: 'demo-shop-sub-a' },
    create: {
      id: 'demo-shop-sub-a',
      ownerId: aliceId,
      type: ShopType.SUB,
      parentId: mainShop.id,
      name: `${DEMO_PREFIX} 子店铺·完全继承`,
      platform: mainShop.platform,
      contactName: mainShop.contactName,
      contactInfo: mainShop.contactInfo,
      note: mainShop.note,
      overriddenFields: [],
    },
    update: {},
  });

  await prisma.shop.upsert({
    where: { id: 'demo-shop-sub-b' },
    create: {
      id: 'demo-shop-sub-b',
      ownerId: aliceId,
      type: ShopType.SUB,
      parentId: mainShop.id,
      name: `${DEMO_PREFIX} 子店铺·覆盖平台与联系人`,
      platform: 'douyin',
      contactName: '子店负责人',
      contactInfo: mainShop.contactInfo,
      note: mainShop.note,
      // 显式记录被覆盖的字段:主店变更时不再同步这两项
      overriddenFields: ['platform', 'contactName'],
    },
    update: {},
  });

  for (let i = 1; i <= 6; i += 1) {
    await prisma.product.upsert({
      where: { id: `demo-product-${i}` },
      create: {
        id: `demo-product-${i}`,
        ownerId: aliceId,
        shopId: mainShop.id,
        status: i % 3 === 0 ? ProductStatus.DRAFT : ProductStatus.ACTIVE,
        name: `${DEMO_PREFIX} 演示商品 ${i}`,
        sku: `DEMO-SKU-${String(i).padStart(4, '0')}`,
        title: `演示商品 ${i} 的营销标题`,
        description: '这是演示商品的描述文本,用于本地走查商品列表与详情。',
        price: `${(i * 19.9).toFixed(2)}`,
        stock: i * 10,
        attributes: { color: i % 2 === 0 ? '米白' : '雾灰', size: 'M' },
      },
      update: {},
    });
  }

  // 演示帖子:一条置顶、一条普通、一条草稿(草稿只有作者可见)
  const posts = [
    {
      id: 'demo-post-pinned',
      slug: 'demo-pinned-welcome',
      status: PostStatus.PUBLISHED,
      title: `${DEMO_PREFIX} 欢迎来到 JUNE 社区`,
      isPinned: true,
      pinnedOrder: 1,
    },
    {
      id: 'demo-post-normal',
      slug: 'demo-normal-workflow',
      status: PostStatus.PUBLISHED,
      title: `${DEMO_PREFIX} 生图工作流使用心得`,
      isPinned: false,
      pinnedOrder: null,
    },
    {
      id: 'demo-post-draft',
      slug: 'demo-draft-only-author',
      status: PostStatus.DRAFT,
      title: `${DEMO_PREFIX} 未发布草稿(仅作者可见)`,
      isPinned: false,
      pinnedOrder: null,
    },
  ];

  for (const p of posts) {
    const published = p.status === PostStatus.PUBLISHED;
    await prisma.post.upsert({
      where: { id: p.id },
      create: {
        id: p.id,
        slug: p.slug,
        authorId: aliceId,
        status: p.status,
        title: p.title,
        contentHtml: '<p>演示正文。服务端已清洗不安全 HTML,渲染只使用清洗后的结果。</p>',
        excerpt: '演示正文摘要。',
        isPinned: p.isPinned,
        pinnedOrder: p.pinnedOrder,
        pinnedAt: p.isPinned ? new Date() : null,
        publishedAt: published ? new Date() : null,
      },
      update: {},
    });
  }

  console.log(
    [
      `[seed] 演示数据已写入:${demoUsers.length} 用户 / 3 店铺 / 6 商品 / 3 帖子`,
      `       演示账号:${demoUsers.map((u) => u.email).join('、')}`,
      `       演示密码:${password}`,
      '       提示:演示数据统一使用 @demo.june.invalid 域与 [DEMO] 前缀,与真实数据、压测数据严格区分。',
    ].join('\n'),
  );
}

/** 演示图片资产占位:仅在设置了 SEED_DEMO_ASSET_KEY 时创建,避免引用不存在的对象 */
async function seedDemoAssetPlaceholder(userId: string): Promise<void> {
  const key = process.env.SEED_DEMO_ASSET_KEY;
  if (!key) return;

  await prisma.asset.upsert({
    where: { objectKey: key },
    create: {
      ownerId: userId,
      kind: AssetKind.POST_IMAGE,
      status: AssetStatus.ACTIVE,
      visibility: AssetVisibility.PUBLIC,
      objectKey: key,
      bucket: process.env.S3_BUCKET ?? 'june-dev',
      mimeType: 'image/webp',
      byteSize: 0,
      confirmedAt: new Date(),
      refCount: 0,
    },
    update: {},
  });
}

// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  console.log('[seed] 开始写入基础数据(幂等,可重复执行)');

  await seedRoles();
  await seedConfigRevisions();
  await seedSystemConfigs();
  await seedProviders();
  await seedContentRules();

  if (process.env.SEED_DEMO === 'true') {
    await seedDemoData();
    const alice = await prisma.user.findUnique({ where: { email: `alice@${DEMO_EMAIL_DOMAIN}` } });
    if (alice) await seedDemoAssetPlaceholder(alice.id);
  } else {
    console.log('[seed] 未设置 SEED_DEMO=true,跳过演示业务数据(生产环境应保持跳过)');
  }

  console.log('[seed] 完成。下一步:pnpm --filter @june/db admin:init 创建管理员账号');
}

main()
  .catch((error: unknown) => {
    console.error('[seed] 失败:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
