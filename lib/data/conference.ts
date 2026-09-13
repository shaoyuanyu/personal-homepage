/**
 * 会议届别查询（服务端）：给日历事件补上「这届会议的完整投稿时间线」。
 *
 * 场景：本站写入的会议事件身份是**某个投稿节点的截止提醒**（见 CLAUDE.md「事件字段归位」），
 * 单看一条事件无法知道它在一届会议流程里的位置。`/api/calendar` 在返回事件前调用
 * `enrichAppointments()`，按事件标题里的「缩写 + 年份」从 deadlines 数据（含覆盖层）
 * 查出该届全部节点，供详情弹窗展示时间线并跳转到同届其它节点的日程。
 *
 * ⚠ 连接键只用**缩写规范化后的精确等值**（与 /venues 页同一规则）——绝不做模糊匹配：
 *   匹配错会把 A 会议的时间线挂到 B 会议的事件上，比不显示更糟。
 * ⚠ 服务端做（而非客户端 import 数据）是因为 deadlines 数据有 313 个会议，
 *   打进 /calendar 的浏览器包不值当；客户端只拿该事件所属的那一届。
 */
import type {
  IcsConferenceInfo,
  IcsConferenceNode,
  ParsedIcsAppointment,
} from "@/lib/ical";
import { zonedToUtcMs } from "@/lib/utils/tz";

import { deadlines } from "./index";

/** 本站会议的节点词表（与写入 CATEGORIES 的词表同源：见 lib/ical.ts 的 NODE_LABEL_EN） */
const NODE_KEYS = new Set([
  "abstract",
  "paper",
  "registration",
  "camera",
  "notification",
]);

/** 缩写规范化：大小写 / 空格 / 连字符 / 点号不敏感 */
function abbrKey(a: string): string {
  return a.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * 事件标题（`X-CONF-TITLE` 如 "ADMA 2026"，回退 `SUMMARY` 如 "ADMA 2026 · Full Paper"）
 * → 「缩写 + 届别年份」；解析不出返回 null。
 */
export function conferenceRefFromTitle(
  title: string,
): { abbr: string; year: number } | null {
  // 去掉「· 节点词」后缀（外部客户端看到的 SUMMARY 带英文节点词）
  const base = title.split("·")[0].trim();
  const m = /^(.+?)\s+((?:19|20)\d{2})$/.exec(base);
  if (!m) return null;
  const abbr = m[1].trim();
  return abbr ? { abbr, year: Number(m[2]) } : null;
}

/** 事件是否为投稿节点事件（CATEGORIES 命中节点词表） */
function isDeadlineNodeEvent(ev: ParsedIcsAppointment): boolean {
  return (ev.categories ?? []).some((c) =>
    NODE_KEYS.has(c.trim().toLowerCase()),
  );
}

/**
 * 按「缩写 + 届别年份」取该届会议信息（节点已换算为 UTC 毫秒并按时间升序）；
 * 会议或该届不存在、该届无节点数据时返回 null。
 */
export function conferenceEdition(
  abbr: string,
  year: number,
): IcsConferenceInfo | null {
  const key = abbrKey(abbr);
  if (!key) return null;
  const conf = deadlines.find((c) => abbrKey(c.a) === key);
  const edition = conf?.years.find((y) => y.y === year);
  if (!conf || !edition || edition.timeline.length === 0) return null;

  const nodes: IcsConferenceNode[] = edition.timeline
    .map((e) => ({
      utc: zonedToUtcMs(e.t, edition.tz),
      kind: e.k ?? "paper",
      comment: e.c,
    }))
    .sort((a, b) => a.utc - b.utc);

  return {
    abbr: conf.a,
    year: edition.y,
    link: edition.link,
    date: edition.date,
    place: edition.place,
    nodes,
  };
}

/**
 * 给一批日历事件补上会议届别信息（同届只查一次表）。
 * 个人日程、第三方事件、以及数据里查不到的会议原样返回。
 */
export function enrichAppointments(
  events: ParsedIcsAppointment[],
): ParsedIcsAppointment[] {
  const cache = new Map<string, IcsConferenceInfo | null>();
  return events.map((ev) => {
    if (!isDeadlineNodeEvent(ev)) return ev;
    const ref = conferenceRefFromTitle(ev.confTitle || ev.summary);
    if (!ref) return ev;
    const cacheKey = `${abbrKey(ref.abbr)}|${ref.year}`;
    if (!cache.has(cacheKey)) {
      cache.set(cacheKey, conferenceEdition(ref.abbr, ref.year));
    }
    const conference = cache.get(cacheKey);
    return conference ? { ...ev, conference } : ev;
  });
}
