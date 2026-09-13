import { NextResponse } from "next/server";

import { isOwner } from "@/lib/auth/owner";
import { CALDAV_COLLECTION_NAME, getCalDavConfig } from "@/lib/caldav/store";
import {
  buildIcsText,
  conferenceRoundLabel,
  getIcsProperty,
  icsEventSummary,
} from "@/lib/ical";

/**
 * POST /api/deadlines/caldav — 把会议 deadline 事件写入站主专属 CalDAV 日历（主人专属）。
 *
 * 凭证优先使用网站内设置（data/caldav.json，站主在「日历」页面配置），
 * 未设置时回退环境变量（CALDAV_URL / CALDAV_USER / CALDAV_PASSWORD，compose 注入）。
 *
 * 事件 UID 稳定（会议-年份-类型），重复添加幂等覆盖，不产生重复事件。
 *
 * 事件身份 = 「某会议某投稿节点的截止提醒」（不是会议本体），故：
 * - SUMMARY 带英文节点词（外部客户端无类别徽章，不写会被误读成会议举办时间）
 * - X-CONF-TITLE 存洁净标题（本站 UI 用 CATEGORIES 合成中文标题）
 * - X-CONF-NAME 存会议全称（**不用 DESCRIPTION**：各客户端把 DESCRIPTION 当「备注」框且可编辑，
 *   放全称会被用户手改坏；RFC 5545 §3.8.8.2 允许 x-prop，未识别的扩展属性客户端必须忽略）
 * - DESCRIPTION = 用户自己的备注（客户端可直接看/改，双向同步）
 * - DTSTART = 截止时刻；地点 → LOCATION（标注为「会议地点」）；会期 → X-CONF-DATES
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
  date?: string;
  place?: string;
  link?: string;
  utc: number;
  /**
   * 该节点的轮次备注（ccfddl 的 `c` 原文，如 "Poster Paper"）：服务端清洗后并入 UID，
   * 让**同一天、同类型**的多个节点（ADMA 2026 的 Poster / Encore）各自成为独立日程。
   */
  round?: string;
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

  // 稳定 UID：会议-年份-类型[-轮次] → 幂等覆盖。
  // ⚠ **轮次必须并入**：同一届同一天、同类型的多个节点（ADMA 2026 的 Poster / Encore）
  //   若只按「类型」定 UID 会互相覆盖，日历里只留得下一条（用户指定要各自独立成日程）。
  const labelKey = body.labelKey ?? "paper";
  const roundSlug = conferenceRoundLabel({ comment: body.round })
    ?.toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const uid = `${body.a.toLowerCase()}-${body.year}-${labelKey}${roundSlug ? `-${roundSlug}` : ""}`;
  /** 旧格式（不含轮次）的 UID：迁移时删掉它，避免同一条日程留下两份 */
  const legacyUid = `${body.a.toLowerCase()}-${body.year}-${labelKey}`;

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

  // 幂等覆盖会重建整个事件，但用户备注（DESCRIPTION）不属于会议数据——
  // 先读旧事件把备注带过去，否则每次从卡片重新添加都会丢失备注。
  // ⚠ 仅当旧事件带 X-CONF-NAME（新格式）时 DESCRIPTION 才是备注；
  //   旧格式事件的 DESCRIPTION 是会议全称，会被 confName 取代，不能当备注继承。
  const existingIcs = await fetch(
    `${collectionUrl}${encodeURIComponent(uid)}.ics`,
    { headers: { Authorization: auth } },
  )
    .then((r) => (r.ok ? r.text() : ""))
    .catch(() => "");
  const existingNote = getIcsProperty(existingIcs, "X-CONF-NAME")
    ? getIcsProperty(existingIcs, "DESCRIPTION")
    : undefined;

  const ics = buildIcsText({
    uid: `${uid}@shaoyuanyu.cn`,
    // 标题语言中立：会议缩写 + 年份 + 英文节点词（节点词不嵌入界面语言，
    // 中文节点名由本站 UI 用 CATEGORIES 本地化合成）
    summary: icsEventSummary(body.a, body.year, body.labelKey, body.round),
    // 本站 UI 用的洁净标题（不含节点词，避免「ADMA 2026 · Full Paper · 全文」）
    confTitle: `${body.a} ${body.year}`,
    // 会议全称（X-CONF-NAME）：不写 DESCRIPTION，见文件头说明
    confName: body.n,
    // DESCRIPTION = 用户备注（重新添加时继承旧备注；新建时为空）
    description: existingNote,
    location: body.place || undefined,
    confDates: body.date || undefined,
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
  // 迁移：旧格式（不含轮次）的事件不能再留在日历里，否则与新的重复一份。
  // 放在 PUT 成功之后——写失败时旧的还在，不至于把日程弄丟。
  if (roundSlug) {
    await fetch(`${collectionUrl}${encodeURIComponent(legacyUid)}.ics`, {
      method: "DELETE",
      headers: { Authorization: auth },
    }).catch(() => {});
  }
  lastWriteByUid.set(uid, Date.now());
  // 简单防内存泄漏：条目过多时清空（单用户场景极少触发）
  if (lastWriteByUid.size > 200) {
    lastWriteByUid.clear();
  }
  return NextResponse.json({ ok: true });
}
