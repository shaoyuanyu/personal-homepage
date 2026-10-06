import { NextRequest, NextResponse } from "next/server";

import { isOwner } from "@/lib/auth/owner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `/mail/agent` 只读入口的数据通路（MAIL-AGENT.md 4.5 / 第八节第 5 步）：
 * 转发到 mailagentd 的 `/agent/*` 只读视图（绑回环、无认证），守卫在这一层。
 * 注意静态段 `agent` 优先于兄弟 `[...path]` 代理（后者去 webmaild）。
 */
const MAIL_AGENT_URL = process.env.MAIL_AGENT_URL ?? "http://127.0.0.1:9711";

async function proxy(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  if (!(await isOwner())) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { path } = await params;
  const target = `${MAIL_AGENT_URL}/agent/${path.map(encodeURIComponent).join("/")}${req.nextUrl.search}`;

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
    return NextResponse.json({ error: "mailagentd_unreachable" }, { status: 502 });
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
