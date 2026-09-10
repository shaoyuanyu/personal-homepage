import { NextResponse } from "next/server";

import { isOwner } from "@/lib/auth/owner";
import { CALDAV_COLLECTION_NAME, getCalDavConfig } from "@/lib/caldav/store";
import { buildIcsText } from "@/lib/ical";

/**
 * POST /api/deadlines/caldav — 把会议 deadline 事件写入站主专属 CalDAV 日历（主人专属）。
 *
 * 凭证优先使用网站内设置（data/caldav.json，站主在「日历」页面配置），
 * 未设置时回退环境变量（CALDAV_URL / CALDAV_USER / CALDAV_PASSWORD，compose 注入）。
 *
 * 事件 UID 稳定（会议-年份-类型），重复添加幂等覆盖，不产生重复事件。
 */

const MKCOL_XML = `<?xml version="1.0" encoding="utf-8"?>
<D:mkcol xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:set><D:prop><D:resourcetype><D:collection/><C:calendar/></D:resourcetype></D:prop></D:set>
</D:mkcol>`;

type CalDavBody = {
  a: string;
  n: string;
  year: number;
  labelKey?: "abstract" | "paper";
  t: string;
  tz: string;
  date?: string;
  place?: string;
  link?: string;
  utc: number;
};

// 防重复提交：同一事件（UID）5 秒内只处理一次（防双击/连点）；不同会议之间不限流
// （单用户站 + 幂等覆盖（UID 稳定）本身无重复风险，全局限流会误伤正常批量添加）
const DEDUP_MS = 5_000;
const lastWriteByUid = new Map<string, number>();

export async function POST(req: Request) {
  if (!(await isOwner())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const cfg = getCalDavConfig();
  if (!cfg) {
    return NextResponse.json({ error: "CalDAV 服务未配置" }, { status: 503 });
  }
  const { baseUrl, user, password } = cfg;
  const auth = `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;

  const body = (await req.json().catch(() => null)) as CalDavBody | null;
  if (
    !body ||
    typeof body.a !== "string" ||
    typeof body.n !== "string" ||
    typeof body.year !== "number" ||
    typeof body.utc !== "number"
  ) {
    return NextResponse.json({ error: "参数不合法" }, { status: 400 });
  }

  // 稳定 UID：会议-年份-类型 → 幂等覆盖
  const uid = `${body.a.toLowerCase()}-${body.year}-${body.labelKey ?? "paper"}`;

  // 同一事件防抖（防双击连点）；不同事件不受限
  const now = Date.now();
  if (now - (lastWriteByUid.get(uid) ?? 0) < DEDUP_MS) {
    return NextResponse.json({ error: "操作过于频繁，请稍后再试" }, { status: 429 });
  }

  const collectionUrl = `${baseUrl.replace(/\/$/, "")}/${encodeURIComponent(user)}/${CALDAV_COLLECTION_NAME}/`;

  // 确保日历集合存在（已存在时 MKCOL 返回 409，忽略）
  await fetch(collectionUrl, {
    method: "MKCOL",
    headers: { Authorization: auth, "Content-Type": "application/xml" },
    body: MKCOL_XML,
  }).catch(() => {});

  const ics = buildIcsText({
    uid: `${uid}@shaoyuanyu.cn`,
    // 标题刻意语言中立（会议 + 年份），不嵌入界面语言节点词——
    // 否则事件会显示写入时语言的文案（zh 写入的「全文」在 en 界面无法翻译）；
    // 节点类型（abstract/paper）走标准 iCal CATEGORIES 属性，由日历端本地化展示
    summary: `${body.a} ${body.year}`,
    description: `${body.n}\nDeadline: ${body.t} (${body.tz})\nDates: ${body.date ?? ""}\nLocation: ${body.place ?? ""}`,
    url: body.link,
    categories: [body.labelKey ?? "paper"],
    start: body.utc,
    end: body.utc + 3_600_000,
  });

  let res: Response;
  try {
    res = await fetch(`${collectionUrl}${encodeURIComponent(uid)}.ics`, {
      method: "PUT",
      headers: { Authorization: auth, "Content-Type": "text/calendar" },
      body: ics,
    });
  } catch (err) {
    // 网络层失败（Radicale 未启动/不可达）：避免抛未捕获异常变 500
    console.error("[deadlines/caldav] 连接失败", err);
    return NextResponse.json(
      { error: "无法连接 CalDAV 服务，请稍后再试" },
      { status: 502 },
    );
  }
  if (!res.ok) {
    console.error(
      "[deadlines/caldav] PUT failed",
      res.status,
      await res.text().catch(() => ""),
    );
    return NextResponse.json(
      { error: `CalDAV 写入失败 (HTTP ${res.status})` },
      { status: 502 },
    );
  }
  lastWriteByUid.set(uid, Date.now());
  // 简单防内存泄漏：条目过多时清空（单用户场景极少触发）
  if (lastWriteByUid.size > 200) {
    lastWriteByUid.clear();
  }
  return NextResponse.json({ ok: true });
}
