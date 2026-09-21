import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../../infra/prisma/prisma.service';
import type { AuthUser } from '../auth/auth-context';

export interface AuditEntry {
  actor: AuthUser | null;
  action: string;
  targetType: string;
  targetId?: string | null;
  /** 变更前后差异。写入前会自动脱敏。 */
  diff?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
  ip?: string | null;
  userAgent?: string | null;
  result?: 'success' | 'failure';
}

/**
 * 绝不允许写入审计日志明文的字段名。
 * 含密码/密钥,以及店铺与支付宝相关的 PII(手机号、平台账号、联系方式等)。
 * 匹配到时:buildDiff 只记 `{ changed: true }`,redact 记为 `[redacted]`。
 */
const FORBIDDEN_FIELDS =
  /password|passwd|secret|apikey|api_key|token|credential|authorization|cookie|cipher|privatekey|phone|mobile|contactinfo|contactname|platformaccount|account|^note$/i;

/**
 * 审计日志。
 *
 * 硬性约束:日志中**不得出现任何密码、密钥,或店铺/支付宝 PII 明文**。
 * 即使调用方不小心传入,这里也会在写库前脱敏,做到最后一道防线。
 *
 * 审计写入失败不影响主业务:记录错误日志但不抛出,避免"日志坏了导致功能不可用"。
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  async record(entry: AuditEntry): Promise<void> {
    try {
      await this.prisma.db.auditLog.create({
        data: {
          actorId: entry.actor?.id ?? null,
          actorEmail: entry.actor?.email ?? null,
          actorRole: entry.actor ? (entry.actor.roles[0] ?? null) : null,
          action: entry.action,
          targetType: entry.targetType,
          targetId: entry.targetId ?? null,
          diff: entry.diff ? (this.redact(entry.diff) as object) : undefined,
          metadata: entry.metadata ? (this.redact(entry.metadata) as object) : undefined,
          ip: entry.ip ?? null,
          userAgent: entry.userAgent?.slice(0, 400) ?? null,
          result: entry.result ?? 'success',
        },
      });
    } catch (err) {
      this.logger.error(
        `审计写入失败 action=${entry.action} target=${entry.targetType}:${(err as Error).message}`,
      );
    }
  }

  /**
   * 构造字段级 diff。只保留实际发生变化的字段,敏感字段只记录"已变更"而不记录值。
   */
  buildDiff<T extends Record<string, unknown>>(before: T, after: Partial<T>): Record<string, unknown> {
    const diff: Record<string, unknown> = {};
    for (const [key, nextValue] of Object.entries(after)) {
      if (nextValue === undefined) continue;
      const prevValue = before[key];
      const changed = JSON.stringify(prevValue ?? null) !== JSON.stringify(nextValue ?? null);
      if (!changed) continue;

      if (FORBIDDEN_FIELDS.test(key)) {
        diff[key] = { changed: true };
      } else {
        diff[key] = { from: this.truncate(prevValue), to: this.truncate(nextValue) };
      }
    }
    return diff;
  }

  private truncate(value: unknown): unknown {
    if (typeof value === 'string' && value.length > 500) {
      return `${value.slice(0, 500)}…(已截断)`;
    }
    return value ?? null;
  }

  private redact(input: Record<string, unknown>, depth = 0): unknown {
    if (depth > 5) return '[deep]';
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) {
      if (FORBIDDEN_FIELDS.test(key)) {
        out[key] = '[redacted]';
      } else if (Array.isArray(value)) {
        out[key] = value.slice(0, 50).map((v) =>
          v && typeof v === 'object' ? this.redact(v as Record<string, unknown>, depth + 1) : v,
        );
      } else if (value && typeof value === 'object') {
        out[key] = this.redact(value as Record<string, unknown>, depth + 1);
      } else {
        out[key] = this.truncate(value);
      }
    }
    return out;
  }
}
