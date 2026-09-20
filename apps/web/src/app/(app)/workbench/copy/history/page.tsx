import { pageTitle } from '@june/shared';
import type { Metadata } from 'next';

import { TaskHistory } from '@/features/workbench/components/task-history';

export const metadata: Metadata = { title: pageTitle('文案历史') };

export default function WorkbenchCopyHistoryPage(): React.JSX.Element {
  return (
    <TaskHistory
      title="文案历史"
      description="查看已提交的文案任务。未通过内容检查的结果不会当作成功展示。"
      fixedType="TEXT_COPY"
      detailTarget="copy"
    />
  );
}
