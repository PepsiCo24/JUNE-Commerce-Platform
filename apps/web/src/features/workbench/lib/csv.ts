/**
 * 商品 CSV 导入的前端侧处理。
 *
 * 分工说明:
 *  - 模板由前端用 PRODUCT_CSV_COLUMNS 生成(与后端 /products/import/template 同一份列定义,
 *    放在前端可以省掉一次下载往返,列定义来自共享常量所以不会漂移);
 *  - 选择文件后**先在浏览器里用 papaparse 解析前 20 行**做基本校验,
 *    让用户在上传前就能看到"第 3 行价格不是数字"这类问题;
 *  - 真正的权威校验仍在后端(preview / commit),前端预览只是提前暴露问题,不替代后端。
 */

import { PRODUCT_CSV_COLUMNS, type ProductImportRowError } from '@june/shared';
import Papa from 'papaparse';

/** 预览行数上限,与后端 preview 的样本行数一致 */
export const CSV_PREVIEW_ROWS = 20;

/** 必填列。其余列都有默认值或允许为空,与后端 REQUIRED_CSV_COLUMNS 一致。 */
const REQUIRED_COLUMNS = ['name'] as const;

const ALLOWED_STATUS = ['DRAFT', 'ACTIVE', 'OFF_SHELF', 'ARCHIVED'] as const;

/** UTF-8 BOM:Excel 只有见到 BOM 才会把 UTF-8 CSV 里的中文正确解码 */
const CSV_BOM = '\ufeff';

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

function escapeCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** 生成模板内容(表头 + 一行示例)。CRLF 换行,Excel / Numbers 兼容性最好。 */
export function buildCsvTemplate(): string {
  const header = PRODUCT_CSV_COLUMNS.map(escapeCell).join(',');
  const example = PRODUCT_CSV_COLUMNS.map((column) => escapeCell(TEMPLATE_EXAMPLE[column])).join(',');
  return `${CSV_BOM}${header}\r\n${example}\r\n`;
}

export interface LocalCsvPreview {
  /** 解析到的表头 */
  columns: string[];
  /** 缺失的必填列 */
  missingRequiredColumns: string[];
  /** 不在模板列定义里的多余列(仅提示,后端会忽略) */
  unknownColumns: string[];
  /** 前 CSV_PREVIEW_ROWS 行 */
  sample: Array<Record<string, string>>;
  /** 数据总行数(不含表头) */
  totalRows: number;
  /** 前端能提前发现的逐行问题 */
  errors: ProductImportRowError[];
  /** papaparse 自身的解析告警(引号未闭合等) */
  parseWarnings: string[];
}

/** 在浏览器里解析 CSV 并做基本校验 */
export function parseCsvForPreview(file: File): Promise<LocalCsvPreview> {
  return new Promise((resolve, reject) => {
    Papa.parse<Record<string, string>>(file, {
      header: true,
      skipEmptyLines: 'greedy',
      // 交给浏览器按 BOM / 声明解码,不强行指定 encoding
      complete: (result) => {
        const columns = (result.meta.fields ?? []).map((field) => field.trim());
        const rows = result.data;

        const missingRequiredColumns = REQUIRED_COLUMNS.filter((column) => !columns.includes(column));
        const unknownColumns = columns.filter(
          (column) => column.length > 0 && !(PRODUCT_CSV_COLUMNS as readonly string[]).includes(column),
        );

        const errors: ProductImportRowError[] = [];
        rows.forEach((row, index) => {
          // 行号从 2 起算:第 1 行是表头,和用户在 Excel 里看到的行号对齐
          const rowNumber = index + 2;
          errors.push(...validateRow(row, rowNumber));
        });

        resolve({
          columns,
          missingRequiredColumns,
          unknownColumns,
          sample: rows.slice(0, CSV_PREVIEW_ROWS),
          totalRows: rows.length,
          errors,
          parseWarnings: result.errors.slice(0, 20).map((error) => `第 ${(error.row ?? 0) + 2} 行:${error.message}`),
        });
      },
      error: (error) => reject(error),
    });
  });
}

function validateRow(row: Record<string, string>, rowNumber: number): ProductImportRowError[] {
  const issues: ProductImportRowError[] = [];
  const value = (key: string): string => (row[key] ?? '').trim();

  if (!value('name')) {
    issues.push({ row: rowNumber, field: 'name', code: 'REQUIRED', message: '商品名称不能为空' });
  }

  const price = value('price');
  if (price && Number.isNaN(Number(price))) {
    issues.push({ row: rowNumber, field: 'price', code: 'NOT_A_NUMBER', message: `价格「${price}」不是数字` });
  }

  const stock = value('stock');
  if (stock && !/^\d+$/.test(stock)) {
    issues.push({ row: rowNumber, field: 'stock', code: 'NOT_AN_INTEGER', message: `库存「${stock}」不是非负整数` });
  }

  const currency = value('currency');
  if (currency && currency.length !== 3) {
    issues.push({ row: rowNumber, field: 'currency', code: 'BAD_LENGTH', message: '币种需为 3 位代码,如 CNY' });
  }

  const status = value('status');
  if (status && !(ALLOWED_STATUS as readonly string[]).includes(status)) {
    issues.push({
      row: rowNumber,
      field: 'status',
      code: 'BAD_ENUM',
      message: `状态只能是 ${ALLOWED_STATUS.join(' / ')}`,
    });
  }

  const attributes = value('attributes');
  if (attributes && !attributes.split(';').every((pair) => pair.trim() === '' || pair.includes('='))) {
    issues.push({
      row: rowNumber,
      field: 'attributes',
      code: 'BAD_FORMAT',
      message: '扩展属性需形如「颜色=白色;尺码=M」',
    });
  }

  return issues;
}

/** 把逐行错误导出成 CSV 报告,便于用户在 Excel 里逐条修正 */
export function buildRowErrorReport(errors: ProductImportRowError[]): string {
  const header = ['行号', '字段', '错误码', '原因'].map(escapeCell).join(',');
  const body = errors
    .map((error) =>
      [String(error.row), error.field ?? '', error.code, error.message].map(escapeCell).join(','),
    )
    .join('\r\n');
  return `${CSV_BOM}${header}\r\n${body}\r\n`;
}
