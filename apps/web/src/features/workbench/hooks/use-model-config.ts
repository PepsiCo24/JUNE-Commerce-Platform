'use client';

import {
  DEFAULT_MODEL_LIMITS,
  type ModelLimits,
  type PublicModelConfigResponse,
  type PublicModelOption,
} from '@june/shared';
import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { useCallback, useEffect } from 'react';
import { toast } from 'sonner';

import { api } from '@/lib/api/client';
import { useSse } from '@/providers/sse-provider';

import { workbenchKeys } from '../lib/keys';

/**
 * 公开模型配置。
 *
 * 安全边界:这个接口**只返回渲染表单所需的公开信息**——没有 API Key、没有 baseUrl、
 * 没有系统提示词。前端全程不接触任何供应商密钥,构建产物里也不存在密钥。
 *
 * 热更新:query key 里带 `useSse().configVersions.models`,
 * 后台改配置 → SSE 推 config.updated(只带版本号)→ 版本号变化 → 这里自动重取。
 */
export function useModelConfig(): UseQueryResult<PublicModelConfigResponse> {
  const { configVersions } = useSse();
  const version = configVersions.models ?? 0;

  return useQuery({
    queryKey: workbenchKeys.modelConfig(version),
    queryFn: () => api.get<PublicModelConfigResponse>('/models/config'),
    // 配置变更靠版本号驱动,这里给较长的 staleTime 避免频繁重取
    staleTime: 60_000,
  });
}

/** 手动让模型配置立刻失效(例如收到 MODEL_SELECTION_LOCKED 后需要对齐后台设置) */
export function useRefreshModelConfig(): () => void {
  const queryClient = useQueryClient();
  return useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['workbench', 'models', 'config'] });
  }, [queryClient]);
}

/**
 * 模型被停用时的处理。
 *
 * 要求很明确:清除当前选择 + 提示用户重新选择,**绝不自动切换到其他供应商**
 * ——自动切换意味着用户在不知情的情况下产生了另一家供应商的计费调用。
 */
export function useDisabledModelGuard(selectedModelId: string | null, onClear: () => void): void {
  const { disabledModelIds, acknowledgeDisabledModels } = useSse();
  const refresh = useRefreshModelConfig();

  useEffect(() => {
    if (!selectedModelId) return;
    if (!disabledModelIds.includes(selectedModelId)) return;

    onClear();
    toast.error('所选模型已被停用,请重新选择');
    refresh();
    // 消费掉这次提示,避免其他页面重复弹
    acknowledgeDisabledModels();
  }, [disabledModelIds, selectedModelId, onClear, refresh, acknowledgeDisabledModels]);
}

/** 取模型的 limits;模型未知时退回最保守的默认能力,避免界面按"无限制"渲染 */
export function limitsOf(model: PublicModelOption | null | undefined): ModelLimits {
  return model?.limits ?? DEFAULT_MODEL_LIMITS;
}

/**
 * 解析当前应使用的模型。
 *
 * fixed 模式:后台指定了 fixedModelId,前端隐藏选择器。
 * 注意"隐藏选择器"只是体验层面的一致性 —— 即使手改请求体塞入 modelConfigId,
 * 后端也会忽略该字段并以 MODEL_SELECTION_LOCKED 拒绝,判定方永远是后端。
 */
export function resolveActiveModel(
  config: PublicModelConfigResponse | undefined,
  scope: 'image' | 'text' | 'title',
  selectedModelId: string | null,
): { model: PublicModelOption | null; locked: boolean; options: PublicModelOption[] } {
  if (!config) return { model: null, locked: false, options: [] };

  const options =
    scope === 'image' ? config.imageModels : scope === 'title' ? config.titleModels : config.textModels;
  const policy =
    scope === 'title'
      ? config.policy.title.inheritFromText
        ? config.policy.text
        : config.policy.title
      : config.policy[scope];

  if (policy.mode === 'fixed') {
    const fixed =
      options.find((option) => option.id === policy.fixedModelId) ??
      options.find((option) => option.isDefault) ??
      options[0] ??
      null;
    return { model: fixed, locked: true, options };
  }

  const selected =
    options.find((option) => option.id === selectedModelId) ??
    options.find((option) => option.isDefault) ??
    options[0] ??
    null;

  return { model: selected, locked: false, options };
}
