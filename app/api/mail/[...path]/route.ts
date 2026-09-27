import { NextRequest, NextResponse } from "next/server";

import { isOwner } from "@/lib/auth/owner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** webmaild 只绑回环、无认证（MAIL-AGENT.md 4.6：信任边界在本机），守卫在这一层 */
const WEBMAILD_URL = process.env.WEBMAILD_URL ?? "http://127.0.0.1:9710";

async function proxy(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  if (!(await isOwner())) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { path } = await params;
  const target = `${WEBMAILD_URL}/${path.map(encodeURIComponent).join("/")}${req.nextUrl.search}`;

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: req.method,
      headers: { "content-type": req.headers.get("content-type") ?? "application/json" },
      body: req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer(),
      // @ts-expect-error Node fetch 需要 duplex 才能带 body 流
      duplex: "half",
      cache: "no-store",
    });
  } catch {
    return NextResponse.json({ error: "webmaild_unreachable" }, { status: 502 });
  }

  const headers = new Headers();
  for (const name of ["content-type", "content-disposition"]) {
    const v = upstream.headers.get(name);
    if (v) headers.set(name, v);
  }
  return new NextResponse(upstream.body, { status: upstream.status, headers });
}

export const GET = proxy;
export const POST = proxy;
