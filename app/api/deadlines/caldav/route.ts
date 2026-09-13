import { NextResponse } from "next/server";

import { isOwner } from "@/lib/auth/owner";
import { invalidateCalendarCache } from "@/lib/caldav/cache";
import { CALDAV_COLLECTION_NAME, getCalDavConfig } from "@/lib/caldav/store";
import {
  buildIcsText,
  deadlineEventUid,
  getIcsProperty,
  icsEventSummary,
  legacyEventUids,
} from "@/lib/ical";
import { globalMap } from "@/lib/utils/global-state";

/**
 * POST /api/deadlines/caldav — 把会议 deadline 事件写入站主专属 CalDAV 日历（主人专属）。
 *
 * **一次可写多个节点**（body `nodes` 数组）：一届会议往往有多个投稿节点，而用户通常
 * 只投其中一部分（ADMA 的多赛道、ASPLOS/FAST/NSDI 的一年多轮），故选哪些节点由
 * `/deadlines` 页的会议详情 Dialog 勾选后一并提交。
 *
 * 凭证优先使用网站内设置（data/caldav.json，站主在「日历」页面配置），
 * 未设置时回退环境变量（CALDAV_URL / CALDAV_USER / CALDAV_PASSWORD，compose 注入）。
 *
 * 事件 UID 稳定（见 `deadlineEventUid`，含截止日期），重复添加幂等覆盖，不产生重复事件；
 * 写入成功后顺带删掉历史格式的旧 UID（`legacyEventUids`），旧日程不会残留两份。
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

/** 单个投稿节点（一届会议的多个节点由客户端勾选后一并提交） */
type CalDavNode = {
  /** 截止时刻（UTC 毫秒，客户端已按会议时区换算） */
  utc: number;
  /** 节点类型（进 CATEGORIES 与 UID） */
  labelKey?: "abstract" | "paper";
  /** 轮次备注（ccfddl 的 `c` 原文，如 "Poster Paper"）：清洗后进 UID 与 SUMMARY */
  round?: string;
  /** 截止日期（会议本地 "YYYY-MM-DD"，进 UID；缺省时用 utc 的 UTC 日期） */
  day?: string;
};

type CalDavBody = {
  /** 会议缩写 */
  a: string;
  /** 会议全称 */
  n: string;
  /** 届别年份 */
  year: number;
  /** 会期原文 */
  date?: string;
  /** 举办地 */
  place?: string;
  /** 官网 */
  link?: string;
  /** 要写入的节点（一次多个） */
  nodes?: CalDavNode[];
  /** @deprecated 单节点旧格式（保留兼容，等价于 nodes: [{ utc, labelKey, round }]） */
  labelKey?: "abstract" | "paper";
  utc?: number;
  round?: string;
};

/** 一次写入的节点数上限（最大一届 VLDB 2027 有 24 个节点） */
const MAX_NODES = 64;

/**
 * 防重复提交：同一事件（UID）5 秒内只处理一次（防双击/连点）；不同事件之间不限流
 * （单用户站 + 幂等覆盖（UID 稳定）本身无重复风险，全局限流会误伤正常批量添加）。
 * 命中去重时按「已写入」计（几秒前刚 PUT 过，事件确实在日历里）。
 *
 * ⚠ 记录表必须挂在 `globalThis` 上：Next.js 逐请求重新求值模块，模块级 Map 每次
 *   都是空表 → 防抖永不生效（详见 `lib/utils/global-state.ts`）。
 */
const DEDUP_MS = 5_000;
const lastWriteByUid = globalMap<string, number>("deadlines:caldav-last-write");

/** 归一化 body.nodes（兼容旧的单节点格式），不合法时返回 null */
function normalizeNodes(body: CalDavBody | null): CalDavNode[] | null {
  if (!body) return null;
  const raw = Array.isArray(body.nodes) ? body.nodes : [];
  const nodes: CalDavNode[] =
    raw.length > 0
      ? raw
      : typeof body.utc === "number"
        ? [{ utc: body.utc, labelKey: body.labelKey, round: body.round }]
        : [];
  if (nodes.length === 0 || nodes.length > MAX_NODES) return null;
  const ok = nodes.every(
    (nd) =>
      nd &&
      typeof nd.utc === "number" &&
      Number.isFinite(nd.utc) &&
      (nd.labelKey === undefined || nd.labelKey === "abstract" || nd.labelKey === "paper"),
  );
  return ok ? nodes : null;
}

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
  const nodes = normalizeNodes(body);
  if (
    !body ||
    typeof body.a !== "string" ||
    !body.a.trim() ||
    typeof body.n !== "string" ||
    typeof body.year !== "number" ||
    !nodes
  ) {
    return NextResponse.json({ error: "参数不合法" }, { status: 400 });
  }

  const collectionUrl = `${baseUrl.replace(/\/$/, "")}/${encodeURIComponent(user)}/${CALDAV_COLLECTION_NAME}/`;

  // 确保日历集合存在（已存在时 MKCOL 返回 409，忽略）
  await fetch(collectionUrl, {
    method: "MKCOL",
    headers: { Authorization: auth, "Content-Type": "application/xml" },
    body: MKCOL_XML,
  }).catch(() => {});

  // 逐个节点写入（顺序执行：节点数最多 24、Radicale 就在本机，量级很小且便于逐条报错）
  let added = 0;
  const failed: string[] = [];
  const written = new Set<string>();

  for (const node of [...nodes].sort((x, y) => x.utc - y.utc)) {
    const uid = deadlineEventUid({
      abbr: body.a,
      year: body.year,
      labelKey: node.labelKey,
      round: node.round,
      day: node.day,
      utc: node.utc,
    });
    if (written.has(uid)) continue; // 同一批里重复的节点（数据异常时兜底）
    written.add(uid);

    const now = Date.now();
    if (now - (lastWriteByUid.get(uid) ?? 0) < DEDUP_MS) {
      added++; // 刚写过（防连点）：事件已在日历里，按成功计
      continue;
    }

    const resourceUrl = `${collectionUrl}${encodeURIComponent(uid)}.ics`;
    const legacyUids = legacyEventUids({
      abbr: body.a,
      year: body.year,
      labelKey: node.labelKey,
      round: node.round,
    }).filter((u) => u !== uid);

    // 幂等覆盖会重建整个事件，但用户备注（DESCRIPTION）不属于会议数据——
    // 先读旧事件把备注带过去，否则每次重新添加都会丢失备注。
    // ⚠ 必须**一并读历史 UID**：UID 方案换过（现在含截止日期），旧事件挂在
    //   `缩写-年份-类型[-轮次]` 上，只读新 UID 会让用户写过的备注随迁移一起消失。
    // ⚠ 仅当事件带 X-CONF-NAME（新格式）时 DESCRIPTION 才是备注；
    //   旧格式事件的 DESCRIPTION 是会议全称，会被 confName 取代，不能当备注继承。
    let existingNote: string | undefined;
    for (const candidate of [uid, ...legacyUids]) {
      const text = await fetch(
        `${collectionUrl}${encodeURIComponent(candidate)}.ics`,
        { headers: { Authorization: auth } },
      )
        .then((r) => (r.ok ? r.text() : ""))
        .catch(() => "");
      if (getIcsProperty(text, "X-CONF-NAME")) {
        existingNote = getIcsProperty(text, "DESCRIPTION");
        break;
      }
    }

    const ics = buildIcsText({
      uid: `${uid}@shaoyuanyu.cn`,
      // 标题语言中立：会议缩写 + 年份 + 英文节点词（节点词不嵌入界面语言，
      // 中文节点名由本站 UI 用 CATEGORIES 本地化合成）
      summary: icsEventSummary(body.a, body.year, node.labelKey, node.round),
      // 本站 UI 用的洁净标题（不含节点词，避免「ADMA 2026 · Full Paper · 全文」）
      confTitle: `${body.a} ${body.year}`,
      // 会议全称（X-CONF-NAME）：不写 DESCRIPTION，见文件头说明
      confName: body.n,
      // DESCRIPTION = 用户备注（重新添加时继承旧备注；新建时为空）
      description: existingNote,
      location: body.place || undefined,
      confDates: body.date || undefined,
      url: body.link,
      categories: [node.labelKey ?? "paper"],
      start: node.utc,
      end: node.utc + 3_600_000,
    });

    let res: Response;
    try {
      res = await fetch(resourceUrl, {
        method: "PUT",
        headers: { Authorization: auth, "Content-Type": "text/calendar" },
        body: ics,
      });
    } catch (err) {
      // 网络层失败（Radicale 未启动/不可达）：避免抛未捕获异常变 500
      console.error("[deadlines/caldav] 连接失败", err, uid);
      failed.push(uid);
      continue;
    }
    if (!res.ok) {
      console.error(
        "[deadlines/caldav] PUT failed",
        uid,
        res.status,
        await res.text().catch(() => ""),
      );
      failed.push(uid);
      continue;
    }

    // 迁移：历史格式（不含日期后缀）的旧事件不能再留在日历里，否则与新的重复一份。
    // 放在 PUT 成功之后——写失败时旧的还在，不至于把日程弄丢。
    for (const legacy of legacyUids) {
      await fetch(`${collectionUrl}${encodeURIComponent(legacy)}.ics`, {
        method: "DELETE",
        headers: { Authorization: auth },
      }).catch(() => {});
    }

    lastWriteByUid.set(uid, Date.now());
    added++;
  }

  // 简单防内存泄漏：条目过多时清空（单用户场景极少触发）
  if (lastWriteByUid.size > 500) lastWriteByUid.clear();

  if (added === 0) {
    return NextResponse.json(
      { error: "CalDAV 写入失败", added, failed: failed.length },
      { status: 502 },
    );
  }
  // 日历页有 30 秒内存缓存：写入后必须失效，否则「添加完回日历看不到」
  invalidateCalendarCache();
  return NextResponse.json({ ok: true, added, failed: failed.length, errors: failed });
}
