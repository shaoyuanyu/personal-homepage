import { NextResponse } from "next/server";

import { isOwner } from "@/lib/auth/owner";
import { invalidateCalendarCache } from "@/lib/caldav/cache";
import { CALDAV_COLLECTION_NAME, getCalDavConfig } from "@/lib/caldav/store";

/**
 * DELETE /api/calendar/events/[uid] — 从站主 CalDAV 日历删除事件（主人专属）。
 *
 * 删除流程（不依赖文件名 = UID 的假设）：
 * 1. REPORT calendar-query 按 UID 精确匹配（text-match），从 multistatus 提取资源 href；
 * 2. 对每个匹配的 href 发 CalDAV DELETE（多个同 UID 资源逐一删除，幂等）；
 * 3. 无匹配 → 404「事件不存在或已删除」（客户端删除后的残留也按成功处理）。
 *
 * 删除成功后清空 GET /api/calendar 的内存缓存，保证前端刷新立即生效。
 */

const UID_RE = /^[A-Za-z0-9._@+-]+$/;

const QUERY_XML = (uid: string) => `<?xml version="1.0" encoding="utf-8"?>
<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop>
    <D:getetag/>
  </D:prop>
  <C:filter>
    <C:comp-filter name="VCALENDAR">
      <C:comp-filter name="VEVENT">
        <C:prop-filter name="UID">
          <C:text-match collation="i;octet">${uid}</C:text-match>
        </C:prop-filter>
      </C:comp-filter>
    </C:comp-filter>
  </C:filter>
</C:calendar-query>`;

/** 从 multistatus XML 提取所有 href（容错 namespace 前缀） */
function extractHrefs(xml: string): string[] {
  const re = /<(?:[A-Za-z0-9]+:)?href[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9]+:)?href>/g;
  const out: string[] = [];
  for (const m of xml.matchAll(re)) {
    const href = m[1].trim();
    if (href) out.push(href);
  }
  return out;
}

type Params = { params: Promise<{ uid: string }> };

export async function DELETE(_req: Request, { params }: Params) {
  if (!(await isOwner())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { uid } = await params;
  // 校验 UID 字符集（Radicale 以 UID 作文件名；防路径注入）
  if (!UID_RE.test(uid)) {
    return NextResponse.json({ error: "参数不合法" }, { status: 400 });
  }

  const cfg = getCalDavConfig();
  if (!cfg) {
    return NextResponse.json({ error: "CalDAV 服务未配置" }, { status: 503 });
  }
  const { baseUrl, user, password } = cfg;
  const collectionUrl = `${baseUrl.replace(/\/$/, "")}/${encodeURIComponent(user)}/${CALDAV_COLLECTION_NAME}/`;
  const auth = `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;

  // 1. 按 UID 查找资源 href
  let res: Response;
  try {
    res = await fetch(collectionUrl, {
      method: "REPORT",
      headers: {
        Authorization: auth,
        "Content-Type": "application/xml",
        Accept: "application/xml",
      },
      body: QUERY_XML(uid),
    });
  } catch (err) {
    console.error("[calendar/events] CalDAV 连接失败", err);
    return NextResponse.json(
      { error: "无法连接 CalDAV 服务，请稍后再试" },
      { status: 502 },
    );
  }

  if (res.status === 404) {
    // 集合不存在 → 事件必然不存在
    return NextResponse.json({ error: "事件不存在或已删除" }, { status: 404 });
  }
  if (!res.ok) {
    console.error(
      "[calendar/events] REPORT failed",
      res.status,
      await res.text().catch(() => ""),
    );
    return NextResponse.json(
      { error: `CalDAV 读取失败 (HTTP ${res.status})` },
      { status: 502 },
    );
  }

  const hrefs = extractHrefs(await res.text().catch(() => ""));
  if (hrefs.length === 0) {
    return NextResponse.json({ error: "事件不存在或已删除" }, { status: 404 });
  }

  // 2. 逐一删除匹配资源（Radicale 返回的 href 可能为绝对 URL 或相对路径）
  for (const href of hrefs) {
    const target = new URL(href, collectionUrl).href;
    try {
      const del = await fetch(target, {
        method: "DELETE",
        headers: { Authorization: auth },
      });
      // 404：资源已被其他客户端删除，视为成功
      if (!del.ok && del.status !== 404) {
        console.error(
          "[calendar/events] DELETE failed",
          del.status,
          await del.text().catch(() => ""),
        );
        return NextResponse.json(
          { error: `CalDAV 删除失败 (HTTP ${del.status})` },
          { status: 502 },
        );
      }
    } catch (err) {
      console.error("[calendar/events] CalDAV 连接失败", err);
      return NextResponse.json(
        { error: "无法连接 CalDAV 服务，请稍后再试" },
        { status: 502 },
      );
    }
  }

  invalidateCalendarCache();
  return NextResponse.json({ ok: true });
}
