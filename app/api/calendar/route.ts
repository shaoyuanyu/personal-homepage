import { NextResponse } from "next/server";

import { isOwner } from "@/lib/auth/owner";
import { CALENDAR_CACHE_TTL_MS, calendarCache } from "@/lib/caldav/cache";
import { CALDAV_COLLECTION_NAME, getCalDavConfig } from "@/lib/caldav/store";
import { enrichAppointments } from "@/lib/data/conference";
import { parseIcsText } from "@/lib/ical";

/**
 * GET /api/calendar?start=YYYY-MM-DD&end=YYYY-MM-DD — 读取站主 CalDAV 日历事件（主人专属）。
 *
 * 通过 CalDAV REPORT（calendar-query + time-range）向 Radicale 查询指定时间范围的事件，
 * 解析 multistatus 响应中的 iCal 数据后返回。凭证优先使用网站内设置（data/caldav.json），
 * 未设置时回退环境变量（CALDAV_URL / CALDAV_USER / CALDAV_PASSWORD，compose 注入）。
 *
 * 返回前用 `enrichAppointments()` 给投稿节点事件补上「该届会议完整时间线」
 * （见 lib/data/conference.ts）——弹窗靠它展示节点序列并跳转到同届其它节点日程。
 *
 * 简单内存缓存 30 秒（月视图翻页会重复请求同一范围）；缓存实现见 lib/caldav/cache.ts，
 * 写入/删除事件后由 invalidateCalendarCache() 失效。
 */

const REPORT_XML = (start: string, end: string) => `<?xml version="1.0" encoding="utf-8"?>
<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop>
    <D:getetag/>
    <C:calendar-data/>
  </D:prop>
  <C:filter>
    <C:comp-filter name="VCALENDAR">
      <C:comp-filter name="VEVENT">
        <C:time-range start="${start}" end="${end}"/>
      </C:comp-filter>
    </C:comp-filter>
  </C:filter>
</C:calendar-query>`;

/** 还原 XML 实体转义（注意 &amp; 最后处理，避免二次转义） */
function decodeXmlEntities(s: string): string {
  return s
    .replace(/&#13;/gi, "\r")
    .replace(/&#10;/gi, "\n")
    .replace(/&#x0d;/gi, "\r")
    .replace(/&#x0a;/gi, "\n")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** 从 CalDAV multistatus XML 中提取所有 calendar-data 块（容错 namespace 前缀） */
function extractCalendarData(xml: string): string[] {
  const re = /<(?:[A-Za-z0-9]+:)?calendar-data[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9]+:)?calendar-data>/g;
  const out: string[] = [];
  for (const m of xml.matchAll(re)) {
    const body = decodeXmlEntities(m[1].trim());
    if (body) out.push(body);
  }
  return out;
}

/** YYYY-MM-DD → CalDAV time-range 需要的 YYYYMMDDT000000Z（start 含当天） */
function toRangeDate(d: string): string {
  return `${d.replace(/-/g, "")}T000000Z`;
}

/** YYYY-MM-DD → 排他 end（time-range 的 end 不含当天，需 +1 天） */
function toRangeEndExclusive(d: string): string {
  const [y, m, day] = d.split("-").map(Number);
  const next = new Date(Date.UTC(y, m - 1, day + 1));
  return `${next.toISOString().slice(0, 10).replace(/-/g, "")}T000000Z`;
}

export async function GET(req: Request) {
  if (!(await isOwner())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const start = searchParams.get("start") ?? "";
  const end = searchParams.get("end") ?? "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
    return NextResponse.json({ error: "参数不合法" }, { status: 400 });
  }

  const cfg = getCalDavConfig();
  if (!cfg) {
    return NextResponse.json({ error: "CalDAV 服务未配置" }, { status: 503 });
  }
  const { baseUrl, user, password } = cfg;

  // cacheKey 含 v 参数：前端刷新按钮传新 v 即可绕过 30s 缓存
  const cacheKey = `${start}|${end}|${searchParams.get("v") ?? ""}`;
  const hit = calendarCache.get(cacheKey);
  if (hit && hit.expires > Date.now()) {
    return NextResponse.json({ events: hit.events });
  }

  const collectionUrl = `${baseUrl.replace(/\/$/, "")}/${encodeURIComponent(user)}/${CALDAV_COLLECTION_NAME}/`;
  const auth = `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;

  let res: Response;
  try {
    res = await fetch(collectionUrl, {
      method: "REPORT",
      headers: {
        Authorization: auth,
        "Content-Type": "application/xml",
        Accept: "application/xml",
      },
      body: REPORT_XML(toRangeDate(start), toRangeEndExclusive(end)),
    });
  } catch (err) {
    console.error("[calendar] CalDAV 连接失败", err);
    return NextResponse.json(
      { error: "无法连接 CalDAV 服务，请稍后再试" },
      { status: 502 },
    );
  }

  if (res.status === 404) {
    // 集合不存在（尚未添加过事件）
    return NextResponse.json({ events: [] });
  }
  if (!res.ok) {
    console.error("[calendar] REPORT failed", res.status, await res.text().catch(() => ""));
    return NextResponse.json(
      { error: `CalDAV 读取失败 (HTTP ${res.status})` },
      { status: 502 },
    );
  }

  const xml = await res.text().catch(() => "");
  const events = enrichAppointments(
    extractCalendarData(xml).flatMap((ics) => parseIcsText(ics)),
  );

  calendarCache.set(cacheKey, { expires: Date.now() + CALENDAR_CACHE_TTL_MS, events });
  return NextResponse.json({ events });
}
