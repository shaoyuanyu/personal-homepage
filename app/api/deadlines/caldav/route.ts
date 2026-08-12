import { NextResponse } from "next/server";

import { isOwner } from "@/lib/auth/owner";
import { buildIcsText } from "@/lib/ical";

/**
 * POST /api/deadlines/caldav — 把会议 deadline 事件写入站主专属 CalDAV 日历（主人专属）。
 *
 * 凭证来自环境变量（VPS compose 注入，勿入库）：
 *   CALDAV_URL      compose 网络内 http://radicale:5232（本地测试用 http://127.0.0.1:5232）
 *   CALDAV_USER     如 caladmin（scripts/setup-calendar-vps.sh 创建）
 *   CALDAV_PASSWORD 同上
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
  label: string;
  labelKey?: string;
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

  const baseUrl = process.env.CALDAV_URL;
  const user = process.env.CALDAV_USER;
  const password = process.env.CALDAV_PASSWORD;
  if (!baseUrl || !user || !password) {
    return NextResponse.json({ error: "CalDAV 服务未配置" }, { status: 503 });
  }
  const auth = `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;

  const body = (await req.json().catch(() => null)) as CalDavBody | null;
  if (
    !body ||
    typeof body.a !== "string" ||
    typeof body.n !== "string" ||
    typeof body.year !== "number" ||
    typeof body.utc !== "number" ||
    typeof body.label !== "string"
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

  const collectionUrl = `${baseUrl.replace(/\/$/, "")}/${encodeURIComponent(user)}/calendar/`;

  // 确保日历集合存在（已存在时 MKCOL 返回 409，忽略）
  await fetch(collectionUrl, {
    method: "MKCOL",
    headers: { Authorization: auth, "Content-Type": "application/xml" },
    body: MKCOL_XML,
  }).catch(() => {});

  const ics = buildIcsText({
    uid: `${uid}@shaoyuanyu.cn`,
    summary: `${body.a} ${body.year} ${body.label}`,
    description: `${body.n}\nDeadline: ${body.t} (${body.tz})\nDates: ${body.date ?? ""}\nLocation: ${body.place ?? ""}`,
    url: body.link,
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
