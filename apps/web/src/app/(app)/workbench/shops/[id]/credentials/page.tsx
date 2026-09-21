import { redirect } from 'next/navigation';

/** 店铺凭据入口已下线,旧链接统一回到对应店铺详情。 */
export default async function ShopCredentialsRedirectPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<never> {
  const { id } = await params;
  redirect(`/workbench/shops/${id}`);
}
