import { Injectable, type PipeTransform } from '@nestjs/common';
import type { ZodType } from 'zod';

import { AppException } from '../errors/app-exception';

/**
 * zod 校验管道。
 *
 * 使用 @june/shared 中的 schema,保证前端与后端用同一份规则,
 * 不会出现"前端校验通过、后端语义不同"的偏差。
 * 校验失败统一转成带字段路径的 VALIDATION_FAILED,便于表单定位。
 */
@Injectable()
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);
    if (result.success) return result.data;

    throw AppException.validation(
      result.error.issues.map((issue) => ({
        path: issue.path.map(String).join('.') || '(root)',
        message: issue.message,
      })),
    );
  }
}

/** 便捷工厂:`@Body(zodBody(loginSchema)) dto: LoginInput` */
export function zodBody<T>(schema: ZodType<T>): ZodValidationPipe<T> {
  return new ZodValidationPipe(schema);
}

/** 查询参数同样走 zod(schema 内使用 z.coerce 处理字符串到数字/布尔的转换) */
export function zodQuery<T>(schema: ZodType<T>): ZodValidationPipe<T> {
  return new ZodValidationPipe(schema);
}
