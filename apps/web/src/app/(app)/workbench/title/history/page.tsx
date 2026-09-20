import { pageTitle } from '@june/shared';
import type { Metadata } from 'next';

import { TaskHistory } from '@/features/workbench/components/task-history';

export const metadata: Metadata = { title: pageTitle('标题历史') };

export default function WorkbenchTitleHistoryPage(): React.JSX.Element {
  return (
    <TaskHistory
      title="标题历史"
      description="查看已提交的标题生成任务与结果。"
      fixedType="TEXT_TITLE"
      detailTarget="title"
    />
  );
}
