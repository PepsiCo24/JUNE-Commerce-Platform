'use client';

import type { StorageUsageView } from '@june/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { api } from '@/lib/api/client';
import { useSseEvent } from '@/providers/sse-provider';

import { workbenchKeys } from '../lib/keys';

export function useStorageUsage() {
  const queryClient = useQueryClient();

  useSseEvent('storage.updated', () => {
    void queryClient.invalidateQueries({ queryKey: workbenchKeys.storageUsage() });
  });

  return useQuery({
    queryKey: workbenchKeys.storageUsage(),
    queryFn: () => api.get<StorageUsageView>('/assets/usage'),
  });
}
