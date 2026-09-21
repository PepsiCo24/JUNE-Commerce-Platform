'use client';

import { ArrowRight } from 'lucide-react';
import Link from 'next/link';

import { PageHeader } from '@/components/layout/page-header';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

import { WORKBENCH_NAV_ITEMS } from '../lib/nav';

export function OverviewDashboard(): React.JSX.Element {
  const entries = WORKBENCH_NAV_ITEMS.filter((item) => item.href !== '/workbench/shops/graph');

  return (
    <div className="space-y-6">
      <PageHeader title="工作台" description="从这里进入各项能力。" />

      <section className="space-y-3">
        <h2 className="text-base font-semibold text-fg">入口</h2>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {entries.map((item) => {
            const Icon = item.icon;
            return (
              <Link key={item.href} href={item.href} className="group">
                <Card interactive className="h-full">
                  <CardHeader>
                    <CardTitle as="h3" className="flex items-center gap-2">
                      <Icon size={18} aria-hidden className="text-accent" />
                      {item.label}
                    </CardTitle>
                    <CardDescription>{item.description}</CardDescription>
                  </CardHeader>
                  <CardContent className="flex justify-end text-fg-subtle group-hover:text-accent">
                    <ArrowRight size={16} aria-hidden />
                  </CardContent>
                </Card>
              </Link>
            );
          })}
        </div>
      </section>
    </div>
  );
}
