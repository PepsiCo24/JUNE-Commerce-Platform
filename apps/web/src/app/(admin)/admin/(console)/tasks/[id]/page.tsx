import { pageTitle } from '@june/shared';
import type { Metadata } from 'next';

import { TaskDetailScreen } from '@/features/admin/screens/task-detail-screen';

export const metadata: Metadata = { title: pageTitle('任务详情') };

export default async function AdminTaskDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<React.JSX.Element> {
  const { id } = await params;
  return <TaskDetailScreen taskId={id} />;
}
