/**
 * SSE 事件契约。
 *
 * 约定:
 *  - 每个标签页只维护一条 SSE 连接,服务端在这条连接上复用推送配置、内容与任务事件。
 *  - 只推送当前会话有权接收的事件:任务事件按 userId 过滤,内容事件为公共信息。
 *  - 绝不推送 API Key、内部系统提示词或任何密文字段。
 *  - 配置类事件只推送版本号,前端收到后调用公开配置接口补拉,
 *    这样即使漏收事件,重连时也能靠版本号对齐到最新状态。
 */

export const SSE_EVENT_TYPES = [
  'connected',
  'heartbeat',
  'config.updated',
  'task.updated',
  'post.updated',
  'comment.updated',
  'storage.updated',
  'session.invalidated',
] as const;

export type SseEventType = (typeof SSE_EVENT_TYPES)[number];

/** 连接建立。带上当前各 scope 的配置版本,便于前端立即对齐。 */
export interface SseConnectedEvent {
  type: 'connected';
  connectionId: string;
  serverTime: string;
  configVersions: Record<string, number>;
}

export interface SseHeartbeatEvent {
  type: 'heartbeat';
  serverTime: string;
}

/**
 * 配置更新。scope 用于区分需要补拉哪一类公开配置。
 * 只带版本号,不带具体内容,天然避免密钥泄漏。
 */
export interface SseConfigUpdatedEvent {
  type: 'config.updated';
  scope: 'models' | 'content' | 'share' | 'concurrency';
  version: number;
  /**
   * 受影响的模型 id(可选)。前端据此判断当前选中的模型是否被停用,
   * 若被停用则清除选择并提示,不擅自切换到其他供应商。
   */
  disabledModelIds?: string[];
}

export interface SseTaskUpdatedEvent {
  type: 'task.updated';
  taskId: string;
  status: string;
  stage: string;
  progressPercent: number | null;
  succeededCount: number;
  failedCount: number;
  requestedCount: number;
  /** 终态时为 true,前端可停止轮询兜底 */
  terminal: boolean;
}

/** 管理员修改内容后通知相关在线页面 */
export interface SsePostUpdatedEvent {
  type: 'post.updated';
  postId: string;
  slug: string;
  action: 'updated' | 'hidden' | 'restored' | 'deleted' | 'pinned' | 'unpinned';
}

export interface SseCommentUpdatedEvent {
  type: 'comment.updated';
  postId: string;
  commentId: string;
  action: 'created' | 'hidden' | 'restored' | 'deleted';
}

export interface SseStorageUpdatedEvent {
  type: 'storage.updated';
  bytesUsed: string;
  quotaBytes: string;
}

/** 被禁用、改密码或远端退出时通知前端立即跳转登录 */
export interface SseSessionInvalidatedEvent {
  type: 'session.invalidated';
  reason: 'logout' | 'password_changed' | 'disabled' | 'revoked';
}

export type SseEvent =
  | SseConnectedEvent
  | SseHeartbeatEvent
  | SseConfigUpdatedEvent
  | SseTaskUpdatedEvent
  | SsePostUpdatedEvent
  | SseCommentUpdatedEvent
  | SseStorageUpdatedEvent
  | SseSessionInvalidatedEvent;

/** Redis Pub/Sub 频道。API 多实例或 Worker 产生的事件通过它汇聚到各连接。 */
export const SSE_CHANNELS = {
  /** 全站广播(配置、公共内容) */
  broadcast: 'june:sse:broadcast',
  /** 按用户定向推送,频道名为 june:sse:user:<userId> */
  userPrefix: 'june:sse:user:',
} as const;

export function userSseChannel(userId: string): string {
  return `${SSE_CHANNELS.userPrefix}${userId}`;
}
