'use client';

import { PAGE_SIZE_MAX, type PageResult, type ShopSummary } from '@june/shared';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import { api } from '@/lib/api/client';

import { workbenchKeys } from '../lib/keys';

/** 文案页面用的轻量商品选项(后端 /products/options 的返回形状) */
export interface ProductOption {
  id: string;
  name: string;
  sku: string | null;
  shopName: string;
}

/**
 * 店铺下拉选项。
 * 店铺数量属于小列表(主店 + 子店),一次取满即可,不做增量加载。
 */
export function useShopOptions(): UseQueryResult<ShopSummary[]> {
  return useQuery({
    queryKey: workbenchKeys.shopOptions(),
    queryFn: async () => {
      const result = await api.get<PageResult<ShopSummary>>('/shops', {
        query: { page: 1, pageSize: PAGE_SIZE_MAX, type: 'ALL', status: 'ALL' },
      });
      return result.items;
    },
    staleTime: 30_000,
  });
}

/**
 * 商品下拉选项。
 * 后端已按 ownerId 过滤,所以"保存到商品"只会出现有权限的商品
 * —— 前端不做权限决策,只呈现后端给出的可选集合。
 */
export function useProductOptions(q = '', shopId?: string | null): UseQueryResult<ProductOption[]> {
  return useQuery({
    queryKey: workbenchKeys.productOptions(q, shopId ?? undefined),
    queryFn: () =>
      api.get<ProductOption[]>('/products/options', {
        query: { q: q || undefined, shopId: shopId ?? undefined, limit: 50 },
      }),
    staleTime: 15_000,
    enabled: shopId ? Boolean(shopId) : true,
  });
}
