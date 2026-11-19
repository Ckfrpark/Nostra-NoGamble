// 본인인증. 운영에서는 PASS/NICE 등 본인확인기관 연동으로 CI(연계정보)를 받아
// 서버 비밀키로 해시한 값을 identityId로 쓴다. 같은 사람은 항상 같은 identityId → 1인 1계정.
// 이 파일의 DevIdentityProvider는 개발용으로, 휴대폰 번호를 CI 대신 쓴다.
import { createHmac } from 'node:crypto';

export interface IdentityProvider {
  /** 인증 결과를 검증하고 identityId(CI 해시)를 돌려준다. 실패하면 null. */
  verify(input: Record<string, unknown>): Promise<string | null>;
}

export function hashCi(ci: string, secret: string): string {
  return createHmac('sha256', secret).update(ci).digest('hex');
}

export class DevIdentityProvider implements IdentityProvider {
  secret: string;
  constructor(secret: string) {
    this.secret = secret;
  }
  async verify(input: Record<string, unknown>) {
    const phone = String(input.phone ?? '').replace(/[^0-9]/g, '');
    if (!/^01[0-9]{8,9}$/.test(phone)) return null;
    return hashCi(`dev-phone:${phone}`, this.secret);
  }
}
