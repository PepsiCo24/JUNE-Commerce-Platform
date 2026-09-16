import { pageTitle } from '@june/shared';
import type { Metadata } from 'next';

import { TaskHistory } from '@/features/workbench/components/task-history';

export const metadata: Metadata = { title: pageTitle('生图历史') };

export default function WorkbenchImageHistoryPage(): React.JSX.Element {
  return (
    <TaskHistory
      title="生图历史"
      description="查看已提交的生图任务。点击进入详情,状态一律从后端读取。"
      fixedType="IMAGE_GENERATE"
      detailHref={(task) => `/workbench/image?taskId=${task.id}`}
    />
  );
}
