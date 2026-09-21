'use client';

import type { PublicUserProfile } from '@june/shared';
import { MapPin, MessageCircle, Phone } from 'lucide-react';
import Link from 'next/link';

import { Avatar } from '@/components/ui/avatar';
import { Pagination } from '@/components/ui/pagination';
import { formatCount, formatDate } from '@/lib/utils';

import { useUserPosts } from '../hooks/use-user-posts';
import { PostCard } from '../posts/post-card';

export function PublicProfileView({ profile }: { profile: PublicUserProfile }): React.JSX.Element {
  const posts = useUserPosts(profile.id);

  return (
    <div className="mx-auto w-full max-w-[900px] px-4 py-8 sm:px-6">
      <header className="flex flex-col gap-6 rounded-xl border border-border-default bg-bg-elevated p-6 sm:flex-row sm:items-start">
        <Avatar src={profile.avatarUrl} name={profile.displayName} size={88} />
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-semibold text-fg">{profile.displayName}</h1>
          <p className="mt-1 text-sm text-fg-subtle">加入于 {formatDate(profile.joinedAt)}</p>
          {profile.bio ? <p className="mt-3 text-sm leading-relaxed text-fg-muted">{profile.bio}</p> : null}
          <div className="mt-3 flex flex-wrap gap-3 text-sm text-fg-muted">
            {profile.location ? (
              <span className="inline-flex items-center gap-1">
                <MapPin size={14} aria-hidden />
                {profile.location}
              </span>
            ) : null}
            {profile.phone ? (
              <span className="inline-flex items-center gap-1">
                <Phone size={14} aria-hidden />
                {profile.phone}
              </span>
            ) : null}
            {profile.wechatId ? (
              <span className="inline-flex items-center gap-1">
                <MessageCircle size={14} aria-hidden />
                微信 {profile.wechatId}
              </span>
            ) : null}
          </div>
          <dl className="mt-4 flex flex-wrap gap-6 text-sm">
            <div>
              <dt className="text-fg-subtle">公开帖子</dt>
              <dd className="font-semibold text-fg">{formatCount(profile.stats.publishedPostCount)}</dd>
            </div>
            <div>
              <dt className="text-fg-subtle">获赞</dt>
              <dd className="font-semibold text-fg">{formatCount(profile.stats.totalLikeCount)}</dd>
            </div>
          </dl>
        </div>
      </header>

      <section className="mt-8">
        <h2 className="mb-4 text-lg font-semibold text-fg">发布的帖子</h2>
        {posts.isLoading ? (
          <p className="text-sm text-fg-muted">加载中…</p>
        ) : posts.items.length === 0 ? (
          <p className="text-sm text-fg-muted">还没有公开帖子。</p>
        ) : (
          <>
            <ul className="flex flex-col gap-4">
              {posts.items.map((post) => (
                <li key={post.id}>
                  <PostCard post={post} showShare={false} />
                </li>
              ))}
            </ul>
            <div className="mt-4">
              <Pagination
                page={posts.page}
                pageSize={posts.pageSize}
                total={posts.total}
                onPageChange={posts.setPage}
              />
            </div>
          </>
        )}
      </section>

      <p className="mt-8 text-center text-xs text-fg-subtle">
        <Link href="/community" className="text-accent hover:underline">
          返回社区
        </Link>
      </p>
    </div>
  );
}
