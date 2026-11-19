// 올공나라 로그인 (Supabase Auth). 카카오·구글로 올공나라에 로그인한 토큰을 확인하고
// 올공 회원 id를 identityId(해시)로 쓴다. 올공 지갑(알알)과는 연결하지 않는다.
import { hashCi } from './identity.ts';

export interface OlgongConfig {
  url: string; // https://<project>.supabase.co
  key: string; // 공개(publishable/anon) 키
  secret: string; // identityId 해시용 서버 비밀
}

export interface OlgongUser {
  olgongId: string;
  identityId: string;
  nickname?: string;
}

export function olgongConfigFromEnv(env: NodeJS.ProcessEnv = process.env): OlgongConfig | null {
  if (!env.OLGONG_SUPABASE_URL || !env.OLGONG_SUPABASE_KEY) return null;
  return { url: env.OLGONG_SUPABASE_URL.replace(/\/+$/, ''), key: env.OLGONG_SUPABASE_KEY, secret: env.IDENTITY_SECRET ?? '' };
}

/** 토큰을 올공 Supabase에 확인한다. 실패하면 null. */
export async function verifyOlgongToken(cfg: OlgongConfig, accessToken: string, fetchImpl: typeof fetch = fetch): Promise<OlgongUser | null> {
  if (accessToken.length < 20 || accessToken.length > 4000) return null;
  const headers = { apikey: cfg.key, authorization: `Bearer ${accessToken}` };
  let res: Response;
  try {
    res = await fetchImpl(`${cfg.url}/auth/v1/user`, { headers, signal: AbortSignal.timeout(5000) });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const user = (await res.json()) as { id?: string };
  if (!user.id || typeof user.id !== 'string') return null;
  let nickname: string | undefined;
  try {
    const u = new URL('/rest/v1/member_profiles', cfg.url);
    u.searchParams.set('select', 'nickname');
    u.searchParams.set('user_id', `eq.${user.id}`);
    const pr = await fetchImpl(u, { headers, signal: AbortSignal.timeout(5000) });
    if (pr.ok) {
      const rows = (await pr.json()) as { nickname?: string }[];
      const n = rows[0]?.nickname?.trim();
      if (n && n.length >= 2 && n.length <= 16) nickname = n;
    }
  } catch {
    // 닉네임은 없어도 된다 (가입 때 따로 받는다)
  }
  return { olgongId: user.id, identityId: hashCi(`olgong:${user.id}`, cfg.secret), ...(nickname ? { nickname } : {}) };
}

/** 카카오·구글 로그인 시작 주소. 로그인 후 redirectTo 로 #access_token=... 이 붙어 돌아온다. */
export function olgongAuthorizeUrl(cfg: OlgongConfig, provider: 'kakao' | 'google', redirectTo: string): string {
  const u = new URL('/auth/v1/authorize', cfg.url);
  u.searchParams.set('provider', provider);
  u.searchParams.set('redirect_to', redirectTo);
  return u.toString();
}
