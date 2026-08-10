import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * 主人会话：HMAC-SHA256 签名的无状态 Cookie（非 JWT，但原理相同）。
 * payload 只有 v/iat/exp 三个字段，签名防篡改，无需服务端存储。
 */

export const SESSION_COOKIE = "owner_session";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 天

interface SessionPayload {
  v: 1;
  iat: number;
  exp: number;
}

function getAuthSecret(): string {
  const secret = process.env.AUTH_SECRET;
  if (!secret) {
    throw new Error("AUTH_SECRET 未配置，请先运行 pnpm totp:setup 生成");
  }
  return secret;
}

function sign(data: string): string {
  return createHmac("sha256", getAuthSecret()).update(data).digest("base64url");
}

/** 签发会话 token（格式：base64url(payload).base64url(hmac)） */
export function createSessionToken(): string {
  const payload: SessionPayload = {
    v: 1,
    iat: Date.now(),
    exp: Date.now() + SESSION_TTL_MS,
  };
  const data = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${data}.${sign(data)}`;
}

/** 校验会话 token：签名正确 + 未过期 */
export function verifySessionToken(token: string | null | undefined): boolean {
  if (!token) return false;
  const [data, sig] = token.split(".");
  if (!data || !sig) return false;

  const expected = Buffer.from(sign(data));
  const actual = Buffer.from(sig);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return false;
  }

  try {
    const payload = JSON.parse(
      Buffer.from(data, "base64url").toString("utf8"),
    ) as SessionPayload;
    return payload.v === 1 && payload.exp > Date.now();
  } catch {
    return false;
  }
}
