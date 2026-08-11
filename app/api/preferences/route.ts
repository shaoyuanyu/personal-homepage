import { NextResponse } from "next/server";

import { isOwner } from "@/lib/auth/owner";
import { getPreferences, setPreferences } from "@/lib/preferences/store";
import {
  isKnownPreferenceKey,
  sanitizePreference,
} from "@/lib/preferences/registry";

/**
 * 主人偏好持久化 API：跨设备同步登录用户的偏好/状态（如 CCF 页领域筛选）。
 * 游客一律 401（不用 requireOwner，避免 redirect 语义）。
 *
 * - GET   /api/preferences → { preferences: Record<key, value> }
 * - PATCH /api/preferences  body: { [key]: value | null }（null 删除该 key）
 *          → { preferences: 写入后全量 }；未知 key / 非法值返回 400
 */

const MAX_BODY_BYTES = 16 * 1024;

export async function GET() {
  if (!(await isOwner())) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return NextResponse.json({ preferences: getPreferences() });
}

export async function PATCH(req: Request) {
  if (!(await isOwner())) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const text = await req.text().catch(() => "");
  if (!text || text.length > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const entries = Object.entries(body as Record<string, unknown>);
  if (entries.length === 0 || entries.length > 10) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  // 逐 key 白名单 + 清洗：任何一个 key 非法则整体拒绝，客户端行为可预期
  const patch: Record<string, unknown> = {};
  for (const [key, value] of entries) {
    if (!isKnownPreferenceKey(key)) {
      return NextResponse.json({ error: "unknown_key", key }, { status: 400 });
    }
    if (value === null) {
      patch[key] = null; // 删除
      continue;
    }
    const clean = sanitizePreference(key, value);
    if (clean === null) {
      return NextResponse.json({ error: "invalid_value", key }, { status: 400 });
    }
    patch[key] = clean;
  }

  return NextResponse.json({ preferences: setPreferences(patch) });
}
