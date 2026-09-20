import { pageTitle } from '@june/shared';
import type { Metadata } from 'next';

import { TaskHistory } from '@/features/workbench/components/task-history';

export const metadata: Metadata = { title: pageTitle('任务记录') };

export default function WorkbenchTasksPage(): React.JSX.Element {
  return (
    <TaskHistory
      title="任务记录"
      description="按类型与状态筛选历史任务。点进详情会打开对应的生图或文案结果。"
    />
  );
}
