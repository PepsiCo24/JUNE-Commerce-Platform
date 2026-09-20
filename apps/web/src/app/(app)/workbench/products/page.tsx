import { redirect } from 'next/navigation';

/** 商品维护已收纳到各店铺详情内,保留路由以免旧链接失效 */
export default function WorkbenchProductsRedirectPage(): never {
  redirect('/workbench/shops');
}
