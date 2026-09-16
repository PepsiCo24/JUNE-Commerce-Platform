/**
 * 模拟生图供应商 —— **仅用于容量压测与本地开发,不是任何真实供应商**。
 *
 * 为什么需要它:
 *  容量压测要打满队列、并发、存储与前端渲染链路,但不能真的向 5 家上游付费出图。
 *  这个适配器在本地合成一张合法 PNG,行为(延迟、失败率、异步/同步)可配置。
 *
 * 防止误当真实服务使用的措施(必须一眼看出是模拟):
 *  1. displayName 一律以 `[MOCK]` 前缀开头,前端 PublicModelOption.isMock 也会为 true;
 *  2. limits.verified = false,后台会显著标注「待真实联调」;
 *  3. 生成的图片本身画着大写 "MOCK" 字样,任何人打开图片都能看出来;
 *  4. modelKey 以 `mock-` 开头;
 *  5. docsUrl 指向本文件而不是任何供应商域名;
 *  6. 不发起任何网络请求 —— 即使误配了真实 baseUrl 也不会打到外部。
 */

import { deflateSync } from 'node:zlib';

import { ERROR_CODES } from '@june/shared';

import { unknownResult } from '../http';
import { buildLimits, readInt } from '../limits';
import type {
  ConnectionTestResult,
  GeneratedImage,
  ImageGenerationOutcome,
  ImageGenerationRequest,
  ImageProvider,
  ModelDescriptor,
  PollOutcome,
  ProviderCallOptions,
  ProviderCredentials,
} from '../types';

const PROVIDER_LABEL = '[MOCK] 模拟供应商';
const DOCS_URL = 'internal://packages/providers/src/image/mock.ts';

export interface MockProviderConfig {
  /** 每次调用的固定延迟(毫秒) */
  delayMs: number;
  /** 延迟抖动上限(毫秒),实际延迟 = delayMs + [0, jitterMs) */
  jitterMs: number;
  /** 失败率 [0, 1]。命中后返回 UPSTREAM_ERROR */
  failureRate: number;
  /** 「结果未知」率 [0, 1]。命中后返回 UPSTREAM_RESULT_UNKNOWN,用于演练不可重试路径 */
  unknownRate: number;
  /** 限流率 [0, 1]。命中后返回 UPSTREAM_RATE_LIMITED 并带 retryAfterSeconds */
  rateLimitRate: number;
  /** 随机数来源,便于测试注入确定性序列 */
  random: () => number;
}

export const MOCK_DEFAULT_CONFIG: MockProviderConfig = {
  delayMs: 800,
  jitterMs: 400,
  failureRate: 0,
  unknownRate: 0,
  rateLimitRate: 0,
  random: Math.random,
};

// ---------------------------------------------------------------------------
// 合成一张带 "MOCK" 字样的合法 PNG
// ---------------------------------------------------------------------------

/** 5x7 点阵字形,1 = 前景像素 */
const GLYPHS: Record<string, string[]> = {
  M: ['10001', '11011', '10101', '10001', '10001', '10001', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  C: ['01110', '10001', '10000', '10000', '10000', '10001', '01110'],
  K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
};

const GLYPH_WIDTH = 5;
const GLYPH_HEIGHT = 7;

/**
 * 生成一张 8 位灰度 PNG,画面中央是大写 "MOCK"。
 *
 * 这里是手写 PNG 编码器(IHDR + IDAT + IEND),不引入图形库:
 *  - colorType = 0(灰度),bitDepth = 8;
 *  - 每条扫描线前置一个 filter byte 0(None);
 *  - IDAT 内容是 zlib 流,正好是 zlib.deflateSync 的输出格式;
 *  - 每个 chunk 的 CRC32 按 PNG 规范对 (type + data) 计算。
 * 产出的字节是标准 PNG,可被浏览器 / sharp / 图片库正常解码。
 */
export function createMockPng(width = 512, height = 512): Buffer {
  const background = 0x1e;
  const foreground = 0xf0;
  const raster = Buffer.alloc(width * height, background);

  const text = 'MOCK';
  // 让字形尽量填满宽度的 70%
  const scale = Math.max(1, Math.floor((width * 0.7) / (text.length * (GLYPH_WIDTH + 1))));
  const textWidth = text.length * (GLYPH_WIDTH + 1) * scale - scale;
  const textHeight = GLYPH_HEIGHT * scale;
  const originX = Math.max(0, Math.floor((width - textWidth) / 2));
  const originY = Math.max(0, Math.floor((height - textHeight) / 2));

  text.split('').forEach((char, charIndex) => {
    const glyph = GLYPHS[char];
    if (!glyph) return;
    const glyphX = originX + charIndex * (GLYPH_WIDTH + 1) * scale;
    for (let row = 0; row < GLYPH_HEIGHT; row += 1) {
      const line = glyph[row] as string;
      for (let col = 0; col < GLYPH_WIDTH; col += 1) {
        if (line[col] !== '1') continue;
        for (let dy = 0; dy < scale; dy += 1) {
          for (let dx = 0; dx < scale; dx += 1) {
            const x = glyphX + col * scale + dx;
            const y = originY + row * scale + dy;
            if (x < 0 || x >= width || y < 0 || y >= height) continue;
            raster[y * width + x] = foreground;
          }
        }
      }
    }
  });

  // 加一圈边框,进一步强化「这不是真实出图」的视觉信号
  for (let x = 0; x < width; x += 1) {
    for (let t = 0; t < 4; t += 1) {
      raster[t * width + x] = foreground;
      raster[(height - 1 - t) * width + x] = foreground;
    }
  }
  for (let y = 0; y < height; y += 1) {
    for (let t = 0; t < 4; t += 1) {
      raster[y * width + t] = foreground;
      raster[y * width + (width - 1 - t)] = foreground;
    }
  }

  // 扫描线:每行前面加一个 filter byte 0
  const rawWithFilters = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y += 1) {
    rawWithFilters[y * (width + 1)] = 0;
    raster.copy(rawWithFilters, y * (width + 1) + 1, y * width, (y + 1) * width);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // color type: grayscale
  ihdr[10] = 0; // compression: deflate
  ihdr[11] = 0; // filter method: adaptive
  ihdr[12] = 0; // interlace: none

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(rawWithFilters)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

const CRC_TABLE: number[] = (() => {
  const table: number[] = [];
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buf) {
    crc = (CRC_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------------------
// 模型能力
// ---------------------------------------------------------------------------

export function describeMockImageModels(): ModelDescriptor[] {
  const limits = buildLimits({
    maxOutputs: 8,
    maxOutputsPerCall: 4,
    maxReferenceImages: 4,
    maxReferenceBytes: 10 * 1024 * 1024,
    sizes: ['512x512', '1024x1024', '1024x1536', '1536x1024'],
    sizeMode: 'size_string',
    deliveryMode: 'sync',
    resultCarrier: 'base64',
    supportsNegativePrompt: true,
    supportsSeed: true,
    supportsImageEdit: true,
    maxPromptChars: 4_000,
    resultUrlTtlSeconds: 0,
    docsUrl: DOCS_URL,
    // 模拟服务永远不是「已核对的真实能力」
    verified: false,
  });

  return [
    {
      modelKey: 'mock-image-sync',
      displayName: '[MOCK] 压测用模拟生图(同步)',
      capabilities: ['TEXT_TO_IMAGE', 'IMAGE_EDIT'],
      limits,
    },
    {
      modelKey: 'mock-image-async',
      displayName: '[MOCK] 压测用模拟生图(异步轮询)',
      capabilities: ['TEXT_TO_IMAGE', 'IMAGE_EDIT'],
      limits: buildLimits({ ...limits, deliveryMode: 'async_poll' }),
    },
  ];
}

// ---------------------------------------------------------------------------
// 适配器
// ---------------------------------------------------------------------------

/** 异步模式下的假任务表。压测进程内存里维护,重启即清空 */
interface MockTask {
  readyAt: number;
  count: number;
  width: number;
  height: number;
}

export class MockImageProvider implements ImageProvider {
  readonly kind = 'MOCK' as const;

  private readonly config: MockProviderConfig;
  private readonly tasks = new Map<string, MockTask>();
  private sequence = 0;

  constructor(config: Partial<MockProviderConfig> = {}) {
    this.config = { ...MOCK_DEFAULT_CONFIG, ...config };
  }

  describeDefaultModels(): ModelDescriptor[] {
    return describeMockImageModels();
  }

  async submit(
    req: ImageGenerationRequest,
    _creds: ProviderCredentials,
    options?: ProviderCallOptions,
  ): Promise<ImageGenerationOutcome> {
    const startedAt = Date.now();
    const isAsync = req.modelKey === 'mock-image-async';

    const injected = this.rollInjectedFailure();
    if (injected) return injected;

    const delay = this.resolveDelay();
    if (!isAsync) {
      await sleep(delay, options?.signal);
      const dims = this.resolveDims(req);
      return {
        kind: 'completed',
        images: this.renderImages(req.count, dims),
        upstreamDurationMs: Date.now() - startedAt,
      };
    }

    this.sequence += 1;
    const taskId = `mock-task-${Date.now()}-${this.sequence}`;
    const dims = this.resolveDims(req);
    this.tasks.set(taskId, {
      readyAt: Date.now() + delay,
      count: req.count,
      width: dims.width,
      height: dims.height,
    });
    return { kind: 'pending', providerTaskId: taskId, pollAfterMs: Math.max(200, Math.floor(delay / 3)) };
  }

  async poll(providerTaskId: string, _creds: ProviderCredentials): Promise<PollOutcome> {
    const task = this.tasks.get(providerTaskId);
    if (!task) {
      // 与真实异步供应商一致:查不到任务是「结果未知」,不是「失败」
      return unknownResult(PROVIDER_LABEL, `模拟任务 ${providerTaskId} 不存在或已过期`, providerTaskId);
    }
    if (Date.now() < task.readyAt) {
      return { kind: 'pending', providerTaskId, pollAfterMs: 200 };
    }
    this.tasks.delete(providerTaskId);
    return {
      kind: 'completed',
      images: this.renderImages(task.count, { width: task.width, height: task.height }),
      upstreamDurationMs: 0,
      providerTaskId,
    };
  }

  async testConnection(): Promise<ConnectionTestResult> {
    return {
      ok: true,
      message: '[MOCK] 模拟供应商始终连通,不发起任何网络请求',
      latencyMs: 0,
    };
  }

  private renderImages(count: number, dims: { width: number; height: number }): GeneratedImage[] {
    const png = createMockPng(dims.width, dims.height);
    const base64 = png.toString('base64');
    return Array.from({ length: Math.max(1, count) }, () => ({
      base64,
      mimeType: 'image/png',
      width: dims.width,
      height: dims.height,
    }));
  }

  private resolveDims(req: ImageGenerationRequest): { width: number; height: number } {
    if (req.width && req.height) return { width: req.width, height: req.height };
    if (req.size) {
      const match = /^(\d{2,5})[x*](\d{2,5})$/.exec(req.size);
      if (match) {
        return {
          width: Number.parseInt(match[1] as string, 10),
          height: Number.parseInt(match[2] as string, 10),
        };
      }
    }
    return { width: 512, height: 512 };
  }

  private resolveDelay(): number {
    const jitter = this.config.jitterMs > 0 ? Math.floor(this.config.random() * this.config.jitterMs) : 0;
    return Math.max(0, this.config.delayMs + jitter);
  }

  /** 按配置的概率注入各类失败,用于演练上层的重试 / 不可重试 / 退避分支 */
  private rollInjectedFailure(): ImageGenerationOutcome | undefined {
    const { random, rateLimitRate, unknownRate, failureRate } = this.config;

    if (rateLimitRate > 0 && random() < rateLimitRate) {
      return {
        kind: 'failed',
        errorCode: ERROR_CODES.UPSTREAM_RATE_LIMITED,
        message: `${PROVIDER_LABEL} 注入的限流(压测用)`,
        retryable: true,
        httpStatus: 429,
        retryAfterSeconds: 2,
      };
    }
    if (unknownRate > 0 && random() < unknownRate) {
      return unknownResult(PROVIDER_LABEL, '注入的「结果未知」(压测用),上层不应盲目重试');
    }
    if (failureRate > 0 && random() < failureRate) {
      return {
        kind: 'failed',
        errorCode: ERROR_CODES.UPSTREAM_ERROR,
        message: `${PROVIDER_LABEL} 注入的失败(压测用)`,
        retryable: true,
        httpStatus: 500,
      };
    }
    return undefined;
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error('模拟调用被取消'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** 供后台校验压测参数复用 */
export function clampMockDelayMs(value: unknown): number | undefined {
  return readInt({ v: value }, 'v', 0, 600_000, undefined);
}
