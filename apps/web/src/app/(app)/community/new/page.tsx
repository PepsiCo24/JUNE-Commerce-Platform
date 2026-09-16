import { redirect } from 'next/navigation';

export default function CommunityNewRedirectPage(): never {
  redirect('/community/posts/new');
}
