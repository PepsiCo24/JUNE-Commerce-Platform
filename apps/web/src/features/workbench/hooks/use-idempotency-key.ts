'use client';

import { useCallback, useState } from 'react';

import { createIdempotencyKey } from '@/lib/api/client';

/**
 * 幂等键的生命周期管理。
 *
 * 规则(直接对应"不重复计费"的验收项):
 *  1. 键存在组件 state 里,**同一次用户操作复用同一个键**
 *     —— 双击提交、网络超时后手动重试,后端都会识别为同一请求并返回原任务;
 *  2. **参数变化后才生成新键**:signature 变化时(渲染期)立即换键,
 *     否则"改了提示词再提交"会被误判为重复请求而拿回旧任务;
 *  3. 提交成功后由调用方显式 reset(),下一次提交是一次新的付费操作,必须用新键。
 */
export function useIdempotencyKey(signature: string): { key: string; reset: () => void } {
  const [state, setState] = useState(() => ({ signature, key: createIdempotencyKey() }));

  // 渲染期同步派生:不能放进 effect,否则本次渲染里提交用的仍是旧参数对应的键
  let key = state.key;
  if (state.signature !== signature) {
    key = createIdempotencyKey();
    setState({ signature, key });
  }

  const reset = useCallback(() => {
    setState({ signature, key: createIdempotencyKey() });
  }, [signature]);

  return { key, reset };
}
