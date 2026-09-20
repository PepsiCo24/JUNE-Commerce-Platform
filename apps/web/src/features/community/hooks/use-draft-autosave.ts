'use client';

import { DRAFT_AUTOSAVE_DEBOUNCE_MS, ERROR_CODES, type PostDraftDetail } from '@june/shared';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { SaveState } from '@/components/feedback/save-status';
import { ApiError, describeError } from '@/lib/api/errors';

import { createDraft, fetchDraft, saveDraft } from '../api';

/** 编辑器当前的内容快照。父组件每次改动都传新的对象进来。 */
export interface DraftSnapshot {
  title: string;
  contentHtml: string;
  contentJson: unknown;
  coverAssetId: string | null;
  imageAssetIds: string[];
  category: import('@june/shared').PostCategory;
}

export interface DraftAutosaveController {
  state: SaveState;
  savedAt: string | null;
  error: string | null;
  /** 已建立的草稿 id(新建帖子时第一次真正产生内容后才创建) */
  draftId: string | null;
  /** 立即保存(存草稿按钮 / 发布前) */
  saveNow: () => Promise<boolean>;
  /** 保存失败或版本冲突后的重试。冲突时先与服务端对齐版本号,再由用户决定是否覆盖。 */
  retry: () => void;
  /** 服务端已有更新版本,自动保存已暂停 */
  stale: boolean;
  hasUnsavedChanges: boolean;
}

function serialize(snapshot: DraftSnapshot): string {
  return JSON.stringify({
    title: snapshot.title,
    contentHtml: snapshot.contentHtml,
    coverAssetId: snapshot.coverAssetId,
    imageAssetIds: snapshot.imageAssetIds,
    category: snapshot.category,
  });
}

/**
 * 草稿自动保存。
 *
 * 「旧请求不覆盖新内容」由两层共同保证:
 *
 *  第一层 —— 本地内容序号(editSeq)。
 *    每次内容变化 editSeq +1;发起保存时记下当次的序号,响应回来后先比对:
 *    如果 editSeq 已经变了,说明用户在等响应期间又改了内容,
 *    这次响应**整条丢弃**(既不写回编辑器,也不标记为"已保存",状态保持 dirty),
 *    随后的防抖保存会带上最新内容。
 *
 *  第二层 —— 服务端乐观锁(draftRevision)。
 *    每次保存带一个严格递增的 revision,后端的更新条件是 `draftRevision < revision`,
 *    命中 0 行就返回 409 DRAFT_STALE。也就是说即使请求在网络里乱序到达,
 *    到得晚的旧请求也会被数据库拒绝,不可能把新内容改回去。
 *    收到 DRAFT_STALE 时前端**不覆盖**当前编辑内容,只暂停自动保存并提示用户。
 *
 *  另外每次发起新保存前 abort 上一次未完成的请求,减少无谓的在途请求。
 */
export function useDraftAutosave(params: {
  /** 已有草稿时传入;新建帖子传 null,第一次有内容时自动创建 */
  initialDraftId: string | null;
  initialRevision: number;
  snapshot: DraftSnapshot;
  /** 关闭自动保存(编辑已发布的帖子时不能把改动悄悄写进线上内容) */
  enabled: boolean;
  onDraftCreated?: (draft: PostDraftDetail) => void;
}): DraftAutosaveController {
  const { initialDraftId, initialRevision, snapshot, enabled, onDraftCreated } = params;

  const [draftId, setDraftId] = useState<string | null>(initialDraftId);
  const [state, setState] = useState<SaveState>('idle');
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);

  /** 本地内容序号:每次内容变化 +1 */
  const editSeqRef = useRef(0);
  /** 最近一次成功保存(或初始加载)对应的内容序号 */
  const savedSeqRef = useRef(0);
  /** 下一个要发给服务端的 revision。严格递增,永远大于已发出过的任何值。 */
  const nextRevisionRef = useRef(initialRevision);
  const abortRef = useRef<AbortController | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const creatingRef = useRef<Promise<PostDraftDetail> | null>(null);
  const snapshotRef = useRef(snapshot);
  const lastSerializedRef = useRef(serialize(snapshot));
  const mountedRef = useRef(true);

  snapshotRef.current = snapshot;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (timerRef.current) clearTimeout(timerRef.current);
      abortRef.current?.abort();
    };
  }, []);

  /** 确保草稿存在。新建帖子时只在真正产生内容后创建,避免留下一堆空草稿。 */
  const ensureDraft = useCallback(async (): Promise<string | null> => {
    if (draftId) return draftId;
    if (creatingRef.current) {
      const existing = await creatingRef.current;
      return existing.id;
    }

    const promise = createDraft();
    creatingRef.current = promise;
    try {
      const created = await promise;
      if (mountedRef.current) {
        setDraftId(created.id);
        nextRevisionRef.current = Math.max(nextRevisionRef.current, created.revision);
        onDraftCreated?.(created);
      }
      return created.id;
    } finally {
      creatingRef.current = null;
    }
  }, [draftId, onDraftCreated]);

  /**
   * 执行一次保存。返回是否成功落库。
   * `seq` 是发起时的本地内容序号,用于判断响应回来时内容是否已经变了。
   */
  const runSave = useCallback(async (): Promise<boolean> => {
    const seq = editSeqRef.current;
    const current = snapshotRef.current;

    let id: string | null;
    try {
      id = await ensureDraft();
    } catch (err) {
      if (mountedRef.current) {
        setState('error');
        setError(describeError(err));
      }
      return false;
    }
    if (!id) return false;

    // 取消上一次还没回来的保存:它带的内容一定比这次旧
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    const revision = nextRevisionRef.current + 1;
    nextRevisionRef.current = revision;

    if (mountedRef.current) {
      setState('saving');
      setError(null);
    }

    try {
      const result = await saveDraft(
        id,
        {
          title: current.title,
          contentHtml: current.contentHtml,
          contentJson: current.contentJson,
          coverAssetId: current.coverAssetId,
          imageAssetIds: current.imageAssetIds,
          category: current.category,
          revision,
        },
        controller.signal,
      );

      if (!mountedRef.current) return true;
      nextRevisionRef.current = Math.max(nextRevisionRef.current, result.revision);

      // 第一层:响应回来时内容已经变了 —— 丢弃这次响应,保持"有未保存的修改"
      if (seq !== editSeqRef.current) {
        setState('dirty');
        return true;
      }

      savedSeqRef.current = seq;
      lastSerializedRef.current = serialize(current);
      setSavedAt(result.updatedAt);
      setState('saved');
      return true;
    } catch (err) {
      // 被我们自己取消的请求不算失败
      if (err instanceof DOMException && err.name === 'AbortError') return false;
      if (!mountedRef.current) return false;

      if (err instanceof ApiError && err.code === ERROR_CODES.DRAFT_STALE) {
        // 第二层:服务端已有更新版本。绝不用本地内容覆盖,只暂停自动保存并交给用户决定。
        setStale(true);
        setState('error');
        setError('草稿已有更新版本(可能在其他设备或标签页编辑过),为避免覆盖已暂停自动保存');
        return false;
      }

      setState('error');
      setError(describeError(err));
      return false;
    }
  }, [ensureDraft]);

  const scheduleSave = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      void runSave();
    }, DRAFT_AUTOSAVE_DEBOUNCE_MS);
  }, [runSave]);

  // 内容变化 → 序号 +1 → 标记 dirty → 防抖保存
  const serialized = serialize(snapshot);
  useEffect(() => {
    if (!enabled) return;
    if (serialized === lastSerializedRef.current) return;

    editSeqRef.current += 1;
    lastSerializedRef.current = serialized;

    // 版本冲突期间不再自动保存,等用户处理
    if (stale) {
      setState('error');
      return;
    }

    setState('dirty');
    scheduleSave();
  }, [serialized, enabled, stale, scheduleSave]);

  const hasUnsavedChanges = state === 'dirty' || state === 'saving' || state === 'error';

  // 离开页面前提示。只有真的有未保存修改时才拦,不无条件弹窗。
  useEffect(() => {
    if (!enabled || !hasUnsavedChanges) return;

    const handler = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
      // 现代浏览器只展示自己的固定文案,这里按规范赋值即可
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [enabled, hasUnsavedChanges]);

  const saveNow = useCallback(async (): Promise<boolean> => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    return runSave();
  }, [runSave]);

  /**
   * 重试。
   * 版本冲突时先拉一次服务端草稿取回真实 revision,再让用户的这次显式保存覆盖它——
   * 覆盖是用户主动点出来的,自动保存永远不会做这件事。
   */
  const retry = useCallback(() => {
    void (async () => {
      if (stale && draftId) {
        try {
          const latest = await fetchDraft(draftId);
          nextRevisionRef.current = Math.max(nextRevisionRef.current, latest.revision);
        } catch (err) {
          setError(describeError(err));
          return;
        }
        setStale(false);
      }
      await runSave();
    })();
  }, [draftId, runSave, stale]);

  return {
    state,
    savedAt,
    error,
    draftId,
    saveNow,
    retry,
    stale,
    hasUnsavedChanges,
  };
}
