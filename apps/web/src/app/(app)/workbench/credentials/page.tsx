import { redirect } from 'next/navigation';

/** 店铺凭据入口已下线,旧链接统一回到店铺列表。 */
export default function CredentialsRedirectPage(): never {
  redirect('/workbench/shops');
}
