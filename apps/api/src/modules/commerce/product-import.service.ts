import { Injectable, Logger } from '@nestjs/common';
import { AssetKind, ImportStatus } from '@june/db';
import {
  ERROR_CODES,
  PRODUCT_CSV_COLUMNS,
  PRODUCT_IMPORT_MAX_ROWS,
  formatBytes,
  productCreateSchema,
  type ImportJobStatus,
  type ProductImportCommitInput,
  type ProductImportPreview,
  type ProductImportRowError,
  type productImportPreviewSchema,
} from '@june/shared';
import Papa from 'papaparse';
import type { z } from 'zod';

import { AuditService } from '../../common/audit/audit.service';
import type { AuthUser } from '../../common/auth/auth-context';
import { AppException } from '../../common/errors/app-exception';
import { loadEnv } from '../../config/env';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { AssetsService } from '../assets/assets.service';
import { QueueProducerService } from '../queue/queue-producer.service';
import { S3Service } from '../storage/s3.service';
import type { ClientMeta, ImportEnqueueResult } from './commerce.types';
import { ShopsService } from './shops.service';

export type ProductImportPreviewInput = z.infer<typeof productImportPreviewSchema>;

/** UTF-8 BOM。Excel 只有见到 BOM 才会把 UTF-8 CSV 里的中文正确解码。 */
const CSV_BOM = '\ufeff';
/** 预览返回的样本行数 */
const PREVIEW_SAMPLE_ROWS = 20;
/** 预览返回的逐行错误上限,避免整份坏文件把响应体撑爆 */
const MAX_PREVIEW_ERRORS = 200;
/** 必填列。其余列都有默认值或可为空(与 productCreateSchema 的字段规则一致)。 */
const REQUIRED_CSV_COLUMNS = ['name'] as const;

/** CSV 模板里的示例行,和表头一一对应 */
const TEMPLATE_EXAMPLE: Record<(typeof PRODUCT_CSV_COLUMNS)[number], string> = {
  name: '夏季纯棉短袖T恤',
  sku: 'TS-2026-001',
  title: '透气纯棉短袖,夏日通勤首选',
  description: '100% 新疆长绒棉,亲肤透气,不易变形。',
  price: '99.00',
  currency: 'CNY',
  stock: '120',
  status: 'DRAFT',
  attributes: '颜色=白色;尺码=M;材质=纯棉',
};

/**
 * 商品 CSV 导入。
 *
 * 同步/异步边界:
 *  - 模板下载、预览校验(纯解析,不写业务表)在 API 内同步完成;
 *  - 真正的逐行入库一律走队列由 Worker 执行,API 只创建 ImportJob 并返回 jobId。
 */
@Injectable()
export class ProductImportService {
  private readonly logger = new Logger(ProductImportService.name);
  private readonly env = loadEnv();

  constructor(
    private readonly prisma: PrismaService,
    private readonly s3: S3Service,
    private readonly assets: AssetsService,
    private readonly queue: QueueProducerService,
    private readonly audit: AuditService,
    private readonly shops: ShopsService,
  ) {}

  // ---------------------------------------------------------------------------
  // 模板
  // ---------------------------------------------------------------------------

  /** CSV 模板文本:BOM + 表头 + 一行示例 */
  buildTemplate(): string {
    const header = PRODUCT_CSV_COLUMNS.map(escapeCsvCell).join(',');
    const example = PRODUCT_CSV_COLUMNS.map((column) => escapeCsvCell(TEMPLATE_EXAMPLE[column])).join(
      ',',
    );
    // 用 CRLF:Excel 与 Numbers 对 CRLF 的兼容性最好
    return `${CSV_BOM}${header}\r\n${example}\r\n`;
  }

  // ---------------------------------------------------------------------------
  // 预览
  // ---------------------------------------------------------------------------

  async preview(user: AuthUser, input: ProductImportPreviewInput): Promise<ProductImportPreview> {
    const shop = await this.shops.mustOwn(user, input.shopId);
    const { text } = await this.readCsvAsset(user, input.fileAssetId);
    const { rows, columns } = this.parseCsv(text);

    if (rows.length > PRODUCT_IMPORT_MAX_ROWS) {
      throw AppException.badRequest(
        ERROR_CODES.IMPORT_TOO_MANY_ROWS,
        `单次最多导入 ${PRODUCT_IMPORT_MAX_ROWS} 行,当前文件有 ${rows.length} 行,请拆分后再导入`,
      );
    }

    const missingRequiredColumns = REQUIRED_CSV_COLUMNS.filter(
      (column) => !columns.includes(column),
    );

    const errors: ProductImportRowError[] = [];
    const seenSkus = new Map<string, number>();

    if (missingRequiredColumns.length === 0) {
      rows.forEach((row, index) => {
        if (errors.length >= MAX_PREVIEW_ERRORS) return;
        // 第 1 行是表头,数据行从 2 开始编号,与用户在 Excel 里看到的行号一致
        const rowNumber = index + 2;
        errors.push(...this.validateRow(shop.id, row, rowNumber, seenSkus));
      });
    }

    return {
      totalRows: rows.length,
      sample: rows.slice(0, PREVIEW_SAMPLE_ROWS).map((row) => pickColumns(row, columns)),
      errors: errors.slice(0, MAX_PREVIEW_ERRORS),
      maxRows: PRODUCT_IMPORT_MAX_ROWS,
      detectedColumns: columns,
      missingRequiredColumns: [...missingRequiredColumns],
    };
  }

  // ---------------------------------------------------------------------------
  // 提交:只建作业 + 入队,不在请求里逐行写库
  // ---------------------------------------------------------------------------

  async commit(
    user: AuthUser,
    input: ProductImportCommitInput,
    meta: ClientMeta,
  ): Promise<ImportEnqueueResult> {
    const shop = await this.shops.mustOwn(user, input.shopId);
    const { text, fileName } = await this.readCsvAsset(user, input.fileAssetId);
    const { rows, columns } = this.parseCsv(text);

    if (rows.length > PRODUCT_IMPORT_MAX_ROWS) {
      throw AppException.badRequest(
        ERROR_CODES.IMPORT_TOO_MANY_ROWS,
        `单次最多导入 ${PRODUCT_IMPORT_MAX_ROWS} 行,当前文件有 ${rows.length} 行,请拆分后再导入`,
      );
    }
    if (rows.length === 0) {
      throw AppException.badRequest(ERROR_CODES.VALIDATION_FAILED, 'CSV 中没有可导入的数据行');
    }

    const missing = REQUIRED_CSV_COLUMNS.filter((column) => !columns.includes(column));
    if (missing.length > 0) {
      throw AppException.validation(
        missing.map((column) => ({ path: column, message: `缺少必填列 ${column}` })),
        'CSV 缺少必填列,请先下载模板核对表头',
      );
    }

    const job = await this.prisma.db.importJob.create({
      data: {
        ownerId: user.id,
        shopId: shop.id,
        kind: 'product_csv',
        status: ImportStatus.PENDING,
        fileAssetId: input.fileAssetId,
        fileName,
        totalRows: rows.length,
      },
    });

    await this.queue.enqueueProductImport({ importJobId: job.id, ownerId: user.id });

    await this.audit.record({
      actor: user,
      action: 'product.import.enqueue',
      targetType: 'ImportJob',
      targetId: job.id,
      metadata: {
        shopId: shop.id,
        fileAssetId: input.fileAssetId,
        totalRows: rows.length,
        // 说明:ImportJob 表没有承载这两项的列(schema 属于 packages/db,不在本模块改动范围),
        // 因此先写入审计留痕;Worker 侧按默认策略执行,详见交付说明。
        duplicateStrategy: input.duplicateStrategy,
        continueOnRowError: input.continueOnRowError,
      },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    return { jobId: job.id, totalRows: rows.length };
  }

  /** 作业进度与逐行错误。只能查自己的作业。 */
  async status(user: AuthUser, jobId: string): Promise<ImportJobStatus> {
    const job = await this.prisma.db.importJob.findFirst({
      where: { id: jobId, ownerId: user.id },
    });
    if (!job) throw AppException.notOwner();

    return {
      id: job.id,
      status: job.status,
      totalRows: job.totalRows,
      processedRows: job.processedRows,
      successRows: job.successRows,
      failedRows: job.failedRows,
      rowErrors: toRowErrors(job.rowErrors),
      errorMessage: job.errorMessage,
      createdAt: job.createdAt.toISOString(),
      finishedAt: job.finishedAt?.toISOString() ?? null,
    };
  }

  // ---------------------------------------------------------------------------
  // 内部实现
  // ---------------------------------------------------------------------------

  /**
   * 从对象存储整读 CSV。
   * 导入文件本身很小,但仍按 UPLOAD_MAX_BYTES 设硬上限并在超限时立刻断流,
   * 避免有人上传超大文件把 API 进程内存打满。
   */
  private async readCsvAsset(
    user: AuthUser,
    fileAssetId: string,
  ): Promise<{ text: string; fileName: string | null }> {
    const [asset] = await this.assets.assertOwnedActive(user.id, [fileAssetId], [
      AssetKind.IMPORT_FILE,
    ]);
    if (!asset) throw AppException.notOwner();

    const limit = this.env.UPLOAD_MAX_BYTES;
    if (asset.byteSize > limit) {
      throw AppException.payloadTooLarge(`导入文件不能超过 ${formatBytes(limit)}`);
    }

    const stream = await this.s3.getStream(asset.objectKey);
    if (!stream) {
      throw AppException.badRequest(ERROR_CODES.UPLOAD_NOT_CONFIRMED, '尚未检测到上传完成的文件');
    }

    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of stream) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      total += buf.length;
      if (total > limit) {
        stream.destroy();
        throw AppException.payloadTooLarge(`导入文件不能超过 ${formatBytes(limit)}`);
      }
      chunks.push(buf);
    }

    return { text: Buffer.concat(chunks).toString('utf8'), fileName: asset.originalName };
  }

  private parseCsv(text: string): { rows: Array<Record<string, string>>; columns: string[] } {
    const parsed = Papa.parse<Record<string, string>>(text.replace(/^\ufeff/, ''), {
      header: true,
      skipEmptyLines: 'greedy',
      transformHeader: (header: string) => header.trim(),
    });

    if (parsed.errors.length > 0) {
      this.logger.debug(`CSV 解析告警 ${parsed.errors.length} 条,首条:${parsed.errors[0]?.message}`);
    }

    return { rows: parsed.data, columns: parsed.meta.fields ?? [] };
  }

  /**
   * 单行校验。字段规则直接复用 productCreateSchema,
   * 保证"导入进来的商品"与"界面上创建的商品"受同一套约束。
   */
  private validateRow(
    shopId: string,
    row: Record<string, string>,
    rowNumber: number,
    seenSkus: Map<string, number>,
  ): ProductImportRowError[] {
    const errors: ProductImportRowError[] = [];
    const candidate: Record<string, unknown> = { shopId };

    for (const column of PRODUCT_CSV_COLUMNS) {
      const raw = (row[column] ?? '').trim();
      // 空单元格视为"未填写",交给 schema 的默认值/可空规则处理
      if (raw === '') continue;

      if (column === 'attributes') {
        const parsed = parseAttributeCell(raw);
        if (parsed.error) {
          errors.push({
            row: rowNumber,
            field: 'attributes',
            code: ERROR_CODES.VALIDATION_FAILED,
            message: parsed.error,
          });
          continue;
        }
        candidate.attributes = parsed.value;
        continue;
      }

      candidate[column] =
        column === 'status' || column === 'currency' ? raw.toUpperCase() : raw;
    }

    const result = productCreateSchema.safeParse(candidate);
    if (!result.success) {
      for (const issue of result.error.issues) {
        const field = issue.path.map(String).join('.') || null;
        // shopId 由服务端注入,不该出现在逐行错误里
        if (field === 'shopId') continue;
        errors.push({
          row: rowNumber,
          field,
          code: ERROR_CODES.VALIDATION_FAILED,
          message: issue.message,
        });
      }
      return errors;
    }

    const sku = result.data.sku?.trim();
    if (sku) {
      const firstRow = seenSkus.get(sku);
      if (firstRow !== undefined) {
        errors.push({
          row: rowNumber,
          field: 'sku',
          code: ERROR_CODES.PRODUCT_SKU_DUPLICATE,
          message: `SKU 与第 ${firstRow} 行重复`,
        });
      } else {
        seenSkus.set(sku, rowNumber);
      }
    }

    return errors;
  }
}

/** `k=v;k=v` 形式的扩展属性 */
export function parseAttributeCell(raw: string): {
  value: Record<string, string>;
  error: string | null;
} {
  const value: Record<string, string> = {};
  for (const pair of raw.split(';')) {
    const trimmed = pair.trim();
    if (trimmed === '') continue;
    const separator = trimmed.indexOf('=');
    if (separator <= 0) {
      return { value: {}, error: `属性格式应为 键=值;键=值,无法解析「${trimmed}」` };
    }
    const key = trimmed.slice(0, separator).trim();
    const val = trimmed.slice(separator + 1).trim();
    if (key === '') {
      return { value: {}, error: '属性名不能为空' };
    }
    value[key] = val;
  }
  return { value, error: null };
}

/** CSV 单元格转义:含分隔符、引号或换行时用双引号包裹 */
function escapeCsvCell(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function pickColumns(row: Record<string, string>, columns: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const column of columns) out[column] = row[column] ?? '';
  return out;
}

/** rowErrors 是 Json 列,读回时做一次形状收敛 */
function toRowErrors(raw: unknown): ProductImportRowError[] {
  if (!Array.isArray(raw)) return [];
  const out: ProductImportRowError[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const item = entry as Record<string, unknown>;
    out.push({
      row: typeof item.row === 'number' ? item.row : 0,
      field: typeof item.field === 'string' ? item.field : null,
      code: typeof item.code === 'string' ? item.code : ERROR_CODES.VALIDATION_FAILED,
      message: typeof item.message === 'string' ? item.message : '',
    });
  }
  return out;
}
