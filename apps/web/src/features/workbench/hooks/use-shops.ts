'use client';

import {
  PAGE_SIZE_DEFAULT,
  type PageResult,
  type ShopCreateInput,
  type ShopDetail,
  type ShopGraph,
  type ShopStats,
  type ShopSummary,
  type ShopUpdateInput,
} from '@june/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api } from '@/lib/api/client';

import type { ShopDeleteResult } from '../lib/api-types';
import { workbenchKeys } from '../lib/keys';

export interface ShopListParams {
  page: number;
  pageSize?: number;
  q?: string;
  type?: 'ALL' | 'MAIN' | 'SUB';
  status?: 'ALL' | 'ACTIVE' | 'PAUSED' | 'CLOSED';
  parentId?: string;
}

export function useShopList(params: ShopListParams) {
  return useQuery({
    queryKey: workbenchKeys.shopList(params),
    queryFn: () =>
      api.get<PageResult<ShopSummary>>('/shops', {
        query: {
          page: params.page,
          pageSize: params.pageSize ?? PAGE_SIZE_DEFAULT,
          q: params.q || undefined,
          type: params.type ?? 'ALL',
          status: params.status ?? 'ALL',
          parentId: params.parentId,
        },
      }),
  });
}

export function useShopStats() {
  return useQuery({
    queryKey: workbenchKeys.shopStats(),
    queryFn: () => api.get<ShopStats>('/shops/stats'),
  });
}

export function useShopGraph() {
  return useQuery({
    queryKey: workbenchKeys.shopGraph(),
    queryFn: () => api.get<ShopGraph>('/shops/graph'),
  });
}

export function useShopDetail(shopId: string | null) {
  return useQuery({
    queryKey: workbenchKeys.shopDetail(shopId ?? '—'),
    queryFn: () => api.get<ShopDetail>(`/shops/${shopId as string}`),
    enabled: Boolean(shopId),
  });
}

export function useShopMutations() {
  const queryClient = useQueryClient();

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['workbench', 'shops'] });
  };

  const create = useMutation({
    mutationFn: (input: ShopCreateInput) => api.post<ShopDetail>('/shops', input),
    onSuccess: invalidate,
  });

  const update = useMutation({
    mutationFn: ({ id, input }: { id: string; input: ShopUpdateInput }) =>
      api.patch<ShopDetail>(`/shops/${id}`, input),
    onSuccess: invalidate,
  });

  const resetInheritance = useMutation({
    mutationFn: ({ id, fields }: { id: string; fields: Array<'platform' | 'contactName' | 'contactInfo' | 'note'> }) =>
      api.post<ShopDetail>(`/shops/${id}/reset-inheritance`, { fields }),
    onSuccess: invalidate,
  });

  const remove = useMutation({
    mutationFn: ({
      id,
      body,
    }: {
      id: string;
      body: {
        childrenStrategy: 'reject' | 'promote_to_main' | 'move_to_shop' | 'delete';
        childrenTargetShopId?: string;
        productsStrategy: 'reject' | 'move_to_shop' | 'archive' | 'delete';
        productsTargetShopId?: string;
        credentialsStrategy: 'reject' | 'delete';
        confirmName: string;
      };
    }) => api.delete<ShopDeleteResult>(`/shops/${id}`, { body }),
    onSuccess: invalidate,
  });

  return { create, update, resetInheritance, remove };
}
