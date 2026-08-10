import { NextResponse } from "next/server";

import { isOwner } from "@/lib/auth/owner";
import { deleteIdea, updateIdea, type IdeaStatus } from "@/lib/ideas/store";

type Params = { params: Promise<{ id: string }> };

export async function PATCH(req: Request, { params }: Params) {
  if (!(await isOwner())) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const body = (await req.json().catch(() => null)) as {
    content?: unknown;
    status?: unknown;
  } | null;

  const patch: { content?: string; status?: IdeaStatus } = {};
  if (typeof body?.content === "string") {
    const content = body.content.trim();
    if (!content) {
      return NextResponse.json({ error: "empty_content" }, { status: 400 });
    }
    patch.content = content;
  }
  if (body?.status === "open" || body?.status === "done") {
    patch.status = body.status;
  }

  const idea = updateIdea(id, patch);
  if (!idea) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  return NextResponse.json({ idea });
}

export async function DELETE(_req: Request, { params }: Params) {
  if (!(await isOwner())) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  if (!deleteIdea(id)) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
