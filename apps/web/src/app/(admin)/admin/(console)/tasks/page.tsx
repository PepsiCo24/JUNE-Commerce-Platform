import { pageTitle } from '@june/shared';
import type { Metadata } from 'next';

import { TasksScreen } from '@/features/admin/screens/tasks-screen';

export const metadata: Metadata = { title: pageTitle('任务') };

export default function AdminTasksPage(): React.JSX.Element {
  return <TasksScreen />;
}
