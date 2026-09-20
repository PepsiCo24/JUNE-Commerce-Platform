'use client';

import type { ReactNode } from 'react';
import { Suspense } from 'react';

import { AmbientBackdrop } from '@/components/layout/ambient-backdrop';

import { CommunityAside } from './community-aside';
import { CommunityRail } from './community-rail';

/**
 * 社区信息流外框:氛围背景 + 大屏三栏(左导航 / 主列 / 右热帖)。
 * 左右栏 sticky:主列滚动时侧栏钉在视口内(知乎式)。
 *
 * sticky 父级必须被 grid stretch 拉满主列高度,才能在滚动中持续吸顶;
 * 不要给 sticky 祖先加 overflow-x-hidden。
 */
export function CommunityFeedFrame({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <div className="relative isolate min-h-full w-full">
      <div aria-hidden className="bg-community-feed absolute inset-0 -z-20" />
      <AmbientBackdrop variant="community" />

      <div className="relative z-10 mx-auto w-full max-w-[1600px] px-4 py-4 sm:px-6 sm:py-5 lg:px-8">
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[220px_minmax(0,1fr)] xl:grid-cols-[220px_minmax(0,1fr)_300px] xl:gap-6">
          <div className="hidden lg:block">
            {/* 左侧按视口定高、内容 flex 吃满,不加 overflow 避免出现滚动条 */}
            <div className="sticky top-16">
              <Suspense fallback={null}>
                <CommunityRail />
              </Suspense>
            </div>
          </div>

          <div className="min-w-0">{children}</div>

          <div className="hidden xl:block">
            <div className="sticky top-16 max-h-[calc(100dvh-4.5rem)] overflow-y-auto overscroll-contain [scrollbar-width:thin]">
              <CommunityAside />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
