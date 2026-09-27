import { NextRequest, NextResponse } from "next/server";

import { SESSION_COOKIE, sessionCookieDomain } from "@/lib/auth/session";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    // domain 必须与签发时一致才能删掉
    domain: sessionCookieDomain(req.headers.get("host")),
    maxAge: 0,
  });
  return res;
}
