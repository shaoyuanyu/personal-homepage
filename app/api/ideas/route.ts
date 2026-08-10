import { NextResponse } from "next/server";

import { isOwner } from "@/lib/auth/owner";
import { createIdea, listIdeas, MAX_CONTENT_LENGTH } from "@/lib/ideas/store";

/** 主人专属 API：游客一律 401（不用 requireOwner，避免 redirect 语义） */

export async function GET() {
  if (!(await isOwner())) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return NextResponse.json({ ideas: listIdeas() });
}

export async function POST(req: Request) {
  if (!(await isOwner())) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const body = (await req.json().catch(() => null)) as { content?: unknown } | null;
  const content = typeof body?.content === "string" ? body.content.trim() : "";
  if (!content) {
    return NextResponse.json({ error: "empty_content" }, { status: 400 });
  }
  if (content.length > MAX_CONTENT_LENGTH) {
    return NextResponse.json({ error: "too_long" }, { status: 400 });
  }
  return NextResponse.json({ idea: createIdea(content) }, { status: 201 });
}
