import { NextResponse } from "next/server";

import { isOwner } from "@/lib/auth/owner";
import { invalidateCalendarCache } from "@/lib/caldav/cache";
import { CALDAV_COLLECTION_NAME, getCalDavConfig } from "@/lib/caldav/store";
import { getIcsProperty, upsertIcsProperty } from "@/lib/ical";

/**
 * DELETE /api/calendar/events/[uid] — 从站主 CalDAV 日历删除事件（主人专属）。
 *
 * 删除流程（不依赖文件名 = UID 的假设）：
 * 1. REPORT calendar-query 按 UID 精确匹配（text-match），从 multistatus 提取资源 href；
 * 2. 对每个匹配的 href 发 CalDAV DELETE（多个同 UID 资源逐一删除，幂等）；
 * 3. 无匹配 → 404「事件不存在或已删除」（客户端删除后的残留也按成功处理）。
 *
 * 删除成功后清空 GET /api/calendar 的内存缓存，保证前端刷新立即生效。
 *
 * PUT /api/calendar/events/[uid] — 更新事件备注（标准 `DESCRIPTION` 属性，主人专属）。
 * body `{ note: string }`（空串 = 删除备注）。**就地改写属性**而非解析重建：本站只认识
 * 事件的一部分字段，重建会把外部客户端写入的 VALARM / ATTENDEE / 其它属性静默丢掉。
 *
 * 备注就是 DESCRIPTION（各客户端把它当「备注/描述」框，故用户在 Apple/华为里改备注 = 改它，
 * 本站刷新即见）。会议全称另存 `X-CONF-NAME`，不受此操作影响。
 */

const UID_RE = /^[A-Za-z0-9._@+-]+$/;

/** 备注长度上限（防超长文本写进 iCal；前端 textarea 同值 maxLength） */
const NOTE_MAX_LENGTH = 1000;

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

/** CalDAV 连接上下文（未配置时返回 null → 调用方 503） */
function calDavContext() {
  const cfg = getCalDavConfig();
  if (!cfg) return null;
  const collectionUrl = `${cfg.baseUrl.replace(/\/$/, "")}/${encodeURIComponent(cfg.user)}/${CALDAV_COLLECTION_NAME}/`;
  const auth = `Basic ${Buffer.from(`${cfg.user}:${cfg.password}`).toString("base64")}`;
  return { collectionUrl, auth };
}

type LookupResult =
  | { kind: "ok"; hrefs: string[] }
  | { kind: "response"; response: NextResponse };

/** 按 UID 查事件资源 href（REPORT calendar-query + text-match） */
async function lookupEventHrefs(
  collectionUrl: string,
  auth: string,
  uid: string,
): Promise<LookupResult> {
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
    return {
      kind: "response",
      response: NextResponse.json(
        { error: "无法连接 CalDAV 服务，请稍后再试" },
        { status: 502 },
      ),
    };
  }

  if (res.status === 404) {
    // 集合不存在 → 事件必然不存在
    return {
      kind: "response",
      response: NextResponse.json({ error: "事件不存在或已删除" }, { status: 404 }),
    };
  }
  if (!res.ok) {
    console.error(
      "[calendar/events] REPORT failed",
      res.status,
      await res.text().catch(() => ""),
    );
    return {
      kind: "response",
      response: NextResponse.json(
        { error: `CalDAV 读取失败 (HTTP ${res.status})` },
        { status: 502 },
      ),
    };
  }

  const hrefs = extractHrefs(await res.text().catch(() => ""));
  if (hrefs.length === 0) {
    return {
      kind: "response",
      response: NextResponse.json({ error: "事件不存在或已删除" }, { status: 404 }),
    };
  }
  return { kind: "ok", hrefs };
}

export async function DELETE(_req: Request, { params }: Params) {
  if (!(await isOwner())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { uid } = await params;
  // 校验 UID 字符集（Radicale 以 UID 作文件名；防路径注入）
  if (!UID_RE.test(uid)) {
    return NextResponse.json({ error: "参数不合法" }, { status: 400 });
  }

  const ctx = calDavContext();
  if (!ctx) {
    return NextResponse.json({ error: "CalDAV 服务未配置" }, { status: 503 });
  }

  // 1. 按 UID 查找资源 href
  const found = await lookupEventHrefs(ctx.collectionUrl, ctx.auth, uid);
  if (found.kind === "response") return found.response;
  const { hrefs } = found;

  // 2. 逐一删除匹配资源（Radicale 返回的 href 可能为绝对 URL 或相对路径）
  for (const href of hrefs) {
    const target = new URL(href, ctx.collectionUrl).href;
    try {
      const del = await fetch(target, {
        method: "DELETE",
        headers: { Authorization: ctx.auth },
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

export async function PUT(req: Request, { params }: Params) {
  if (!(await isOwner())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { uid } = await params;
  if (!UID_RE.test(uid)) {
    return NextResponse.json({ error: "参数不合法" }, { status: 400 });
  }

  const body = (await req.json().catch(() => null)) as { note?: unknown } | null;
  if (!body || typeof body.note !== "string") {
    return NextResponse.json({ error: "参数不合法" }, { status: 400 });
  }
  const note = body.note.trim();
  if (note.length > NOTE_MAX_LENGTH) {
    return NextResponse.json({ error: "备注过长" }, { status: 400 });
  }

  const ctx = calDavContext();
  if (!ctx) {
    return NextResponse.json({ error: "CalDAV 服务未配置" }, { status: 503 });
  }

  const found = await lookupEventHrefs(ctx.collectionUrl, ctx.auth, uid);
  if (found.kind === "response") return found.response;

  for (const href of found.hrefs) {
    const target = new URL(href, ctx.collectionUrl).href;
    try {
      // 取回原事件文本 → 只改 COMMENT（备注）→ 写回（保留其余属性，含未知 VALARM/ATTENDEE）
      const got = await fetch(target, { headers: { Authorization: ctx.auth } });
      if (!got.ok) {
        console.error("[calendar/events] GET failed", got.status);
        return NextResponse.json(
          { error: `CalDAV 读取失败 (HTTP ${got.status})` },
          { status: 502 },
        );
      }
      let ics = await got.text();
      // 旧格式事件自愈：描述里存的还是会议全称 → 先落到 X-CONF-NAME，再写备注，
      // 否则这次写备注会把会议全称抹掉（且客户端里那段全称会变成备注）
      if (!getIcsProperty(ics, "X-CONF-NAME") && getIcsProperty(ics, "CATEGORIES")) {
        const legacyName = getIcsProperty(ics, "DESCRIPTION")
          ?.split(/\r?\n/)[0]
          ?.trim();
        if (legacyName) ics = upsertIcsProperty(ics, "X-CONF-NAME", legacyName);
      }
      const updated = upsertIcsProperty(ics, "DESCRIPTION", note || null);
      const put = await fetch(target, {
        method: "PUT",
        headers: {
          Authorization: ctx.auth,
          "Content-Type": "text/calendar; charset=utf-8",
        },
        body: updated,
      });
      if (!put.ok) {
        console.error(
          "[calendar/events] PUT failed",
          put.status,
          await put.text().catch(() => ""),
        );
        return NextResponse.json(
          { error: `CalDAV 写入失败 (HTTP ${put.status})` },
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
  return NextResponse.json({ ok: true, note });
}
