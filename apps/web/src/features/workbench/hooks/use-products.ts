'use client';

import {
  PAGE_SIZE_DEFAULT,
  type CursorResult,
  type ImportJobStatus,
  type ProductCreateInput,
  type ProductDetail,
  type ProductSummary,
  type ProductUpdateInput,
} from '@june/shared';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api } from '@/lib/api/client';

import { workbenchKeys } from '../lib/keys';

export interface ProductListParams {
  q?: string;
  shopId?: string;
  status?: 'ALL' | 'DRAFT' | 'ACTIVE' | 'OFF_SHELF' | 'ARCHIVED';
  sort?: 'updated_desc' | 'created_desc' | 'name_asc' | 'price_asc' | 'price_desc';
}

export function useProductList(params: ProductListParams) {
  const query = useInfiniteQuery({
    queryKey: workbenchKeys.productList(params),
    queryFn: ({ pageParam }) =>
      api.get<CursorResult<ProductSummary>>('/products', {
        query: {
          q: params.q || undefined,
          shopId: params.shopId || undefined,
          status: params.status ?? 'ALL',
          sort: params.sort ?? 'updated_desc',
          cursor: pageParam,
          limit: PAGE_SIZE_DEFAULT,
        },
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });

  return {
    items: query.data?.pages.flatMap((page) => page.items) ?? [],
    isLoading: query.isPending,
    isError: query.isError,
    error: query.error,
    refetch: () => void query.refetch(),
    hasMore: Boolean(query.hasNextPage),
    isFetchingNextPage: query.isFetchingNextPage,
    loadMore: () => void query.fetchNextPage(),
  };
}

export function useProductDetail(productId: string | null) {
  return useQuery({
    queryKey: workbenchKeys.productDetail(productId ?? '—'),
    queryFn: () => api.get<ProductDetail>(`/products/${productId as string}`),
    enabled: Boolean(productId),
  });
}

export function useProductMutations() {
  const queryClient = useQueryClient();
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['workbench', 'products'] });
    void queryClient.invalidateQueries({ queryKey: workbenchKeys.shopStats() });
  };

  const create = useMutation({
    mutationFn: (input: ProductCreateInput) => api.post<ProductDetail>('/products', input),
    onSuccess: invalidate,
  });

  const update = useMutation({
    mutationFn: ({ id, input }: { id: string; input: ProductUpdateInput }) =>
      api.patch<ProductDetail>(`/products/${id}`, input),
    onSuccess: invalidate,
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/products/${id}`),
    onSuccess: invalidate,
  });

  return { create, update, remove };
}

const IMPORT_TERMINAL = new Set(['SUCCEEDED', 'PARTIAL', 'FAILED', 'CANCELED']);

export function useImportJob(jobId: string | null) {
  return useQuery({
    queryKey: workbenchKeys.importJob(jobId ?? '—'),
    queryFn: () => api.get<ImportJobStatus>(`/products/import/${jobId as string}`),
    enabled: Boolean(jobId),
    refetchInterval: (current) => {
      const status = current.state.data?.status;
      if (!status || IMPORT_TERMINAL.has(status)) return false;
      return 2_000;
    },
  });
}
