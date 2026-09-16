'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useMemo } from 'react';

/**
 * 把筛选条件写进 URL query。
 *
 * 为什么不用 useState:筛选条件进 URL 才能分享、能用浏览器前进/后退回退到上一组条件、
 * 刷新后不丢失。默认值不写进 URL,保持地址干净。
 *
 * 用 `router.replace` 而不是 `push`:同一页面反复调筛选不应该在历史里堆十几条记录;
 * 真正需要"回到上一组条件"时,`replace` 仍然会更新当前条目的 search,配合下面的
 * `pushFilters` 可以在需要留痕的场景(如进入下钻)显式 push。
 */
export function useUrlFilters<T extends Record<string, string>>(
  defaults: T,
): {
  filters: T;
  setFilters: (patch: Partial<T>, options?: { push?: boolean }) => void;
  resetFilters: () => void;
  /** 当前是否有非默认筛选,用于决定是否显示"清空筛选" */
  isFiltered: boolean;
} {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const filters = useMemo(() => {
    const result = { ...defaults };
    for (const key of Object.keys(defaults) as Array<keyof T & string>) {
      const value = searchParams.get(key);
      if (value !== null && value !== '') result[key] = value as T[keyof T & string];
    }
    return result;
  }, [searchParams, defaults]);

  const write = useCallback(
    (next: Record<string, string>, push: boolean) => {
      const params = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(next)) {
        if (value === '' || value === defaults[key]) params.delete(key);
        else params.set(key, value);
      }
      const qs = params.toString();
      const url = qs ? `${pathname}?${qs}` : pathname;
      if (push) router.push(url, { scroll: false });
      else router.replace(url, { scroll: false });
    },
    [searchParams, pathname, router, defaults],
  );

  const setFilters = useCallback(
    (patch: Partial<T>, options?: { push?: boolean }) => {
      write(patch as Record<string, string>, options?.push ?? false);
    },
    [write],
  );

  const resetFilters = useCallback(() => {
    const cleared: Record<string, string> = {};
    for (const key of Object.keys(defaults)) cleared[key] = '';
    write(cleared, false);
  }, [write, defaults]);

  const isFiltered = useMemo(
    () => (Object.keys(defaults) as Array<keyof T & string>).some((key) => filters[key] !== defaults[key]),
    [filters, defaults],
  );

  return { filters, setFilters, resetFilters, isFiltered };
}
