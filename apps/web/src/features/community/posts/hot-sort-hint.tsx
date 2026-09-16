import { InfoHint } from '@/components/ui/tooltip';

import { hotRuleDescription } from '../utils';

/**
 * 热门规则说明。放在排序切换旁边,让用户点开就能看到确切口径,
 * 文案由 HOT_SCORE_WEIGHTS 生成,和后端算分用的是同一份权重。
 */
export function HotSortHint(): React.JSX.Element {
  return <InfoHint className="shrink-0">{hotRuleDescription()}</InfoHint>;
}
