/**
 * Prisma 已知错误码判定。
 * 跨客户端实例的 instanceof 不可靠(扩展客户端与基础客户端并非同一构造器),
 * 因此统一按错误码判断。
 */
export function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'P2002';
}
