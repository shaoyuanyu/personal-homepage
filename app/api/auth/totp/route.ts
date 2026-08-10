import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import {
  clearRateLimit,
  getClientIp,
  isRateLimited,
  recordFailure,
} from "@/lib/auth/rate-limit";
import { verifyRecoveryCode } from "@/lib/auth/recovery";
import {
  SESSION_COOKIE,
  SESSION_TTL_MS,
  createSessionToken,
} from "@/lib/auth/session";
import { verifyTotp } from "@/lib/auth/totp";

export const runtime = "nodejs";

/** 判断请求是否经 HTTPS（nginx 反代时看 x-forwarded-proto） */
function isHttps(req: NextRequest): boolean {
  const proto = req.headers.get("x-forwarded-proto");
  if (proto) return proto.split(",")[0]!.trim() === "https";
  return req.nextUrl.protocol === "https:";
}

export async function POST(req: NextRequest) {
  const ip = getClientIp(req);

  if (isRateLimited(ip)) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  const body = await req.json().catch(() => null);
  const code = typeof body?.code === "string" ? body.code.trim() : "";
  const ok = verifyTotp(code) || verifyRecoveryCode(code);

  if (!ok) {
    recordFailure(ip);
    return NextResponse.json({ error: "invalid_code" }, { status: 401 });
  }

  clearRateLimit(ip);

  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, createSessionToken(), {
    httpOnly: true,
    secure: isHttps(req),
    sameSite: "lax",
    path: "/",
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
  return res;
}
