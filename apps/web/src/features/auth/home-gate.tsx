'use client';

import { BrandLogo } from '@june/brand';
import { BRAND_FULL_NAME } from '@june/shared';
import { LayoutPanelLeft, MessagesSquare } from 'lucide-react';
import Link from 'next/link';
import { motion } from 'motion/react';

import { AmbientBackdrop } from '@/components/layout/ambient-backdrop';
import { Card } from '@/components/ui/card';
import { useReducedMotion } from '@/providers/preferences-provider';

const ENTRIES = [
  {
    href: '/community',
    title: '社区',
    description: '浏览与发布图文，和团队分享创作经验。',
    icon: MessagesSquare,
  },
  {
    href: '/workbench',
    title: '工作台',
    description: '生图、文案、店铺与商品管理。',
    icon: LayoutPanelLeft,
  },
] as const;

export function HomeGate(): React.JSX.Element {
  const reduced = useReducedMotion();
  const duration = reduced ? 0 : 0.35;

  return (
    <div className="relative flex min-h-[calc(100dvh-8rem)] flex-col items-center justify-center px-4 py-10">
      <AmbientBackdrop variant="home" />
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration }}
        className="relative z-10 flex w-full max-w-4xl flex-col items-center"
      >
        <BrandLogo variant="full" theme="dark" size="xl" title={BRAND_FULL_NAME} className="mb-10" />
        <div className="grid w-full gap-5 sm:grid-cols-2">
          {ENTRIES.map((entry) => {
            const Icon = entry.icon;
            return (
              <Link key={entry.href} href={entry.href} className="group block">
                <Card glass className="h-full min-h-56 p-7 transition-transform duration-200 group-hover:-translate-y-0.5">
                  <div className="mb-6 flex size-12 items-center justify-center rounded-xl border border-accent-border bg-accent-surface text-accent">
                    <Icon size={22} aria-hidden />
                  </div>
                  <h2 className="text-2xl font-semibold text-fg">{entry.title}</h2>
                  <p className="mt-2 text-sm leading-relaxed text-fg-muted">{entry.description}</p>
                </Card>
              </Link>
            );
          })}
        </div>
        <p className="mt-8 text-xs text-fg-subtle">{BRAND_FULL_NAME}</p>
      </motion.div>
    </div>
  );
}
