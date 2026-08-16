/**
 * iCalendar 构造（RFC 5545 子集）。
 * 客户端 .ics 下载与 CalDAV 写入 API 共用，零依赖纯函数。
 */

/** UTC 毫秒戳 → iCal 格式 YYYYMMDDTHHMMSSZ */
export function toIcsUtc(utcMs: number): string {
  return new Date(utcMs).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

export type IcsEvent = {
  /** 事件唯一标识（服务端写入用稳定值实现幂等覆盖） */
  uid: string;
  summary: string;
  description?: string;
  url?: string;
  /** UTC 毫秒时间戳 */
  start: number;
  end: number;
};

/** 转义 iCal 文本（反斜杠/逗号/分号/换行） */
function esc(s: string): string {
  return s.replace(/[\\;,]/g, "\\$&").replace(/\n/g, "\\n");
}

/** 构造单事件 VCALENDAR 文本 */
export function buildIcsText(e: IcsEvent): string {
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//shaoyuanyu.cn//Deadlines//CN",
    "BEGIN:VEVENT",
    `UID:${esc(e.uid)}`,
    `DTSTART:${toIcsUtc(e.start)}`,
    `DTEND:${toIcsUtc(e.end)}`,
    `SUMMARY:${esc(e.summary)}`,
    ...(e.description ? [`DESCRIPTION:${esc(e.description)}`] : []),
    ...(e.url ? [`URL:${esc(e.url)}`] : []),
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
}

/* ---------------- iCal 解析（CalDAV 读取方向） ---------------- */

export type ParsedIcsAppointment = {
  uid: string;
  summary: string;
  description?: string;
  url?: string;
  /** 全天事件日期 "YYYY-MM-DD"（无时区语义，按浏览器本地日解释） */
  allDayDate?: string;
  /** 明确 UTC 时间（毫秒戳）；null 表示全天或浮时 */
  startUtc: number | null;
  endUtc: number | null;
  /** 浮时时间 "YYYY-MM-DDTHH:mm"（无时区语义，按浏览器本地解释） */
  floatingStart?: string;
  floatingEnd?: string;
};

/** 解析 iCal 中的日期时间值 → UTC 毫秒（仅支持 Z 结尾的 UTC 形式） */
function parseIcsUtc(v: string): number | null {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(v.trim());
  if (!m) return null;
  const [, Y, Mo, D, h, mi, s] = m.map(Number);
  return Date.UTC(Y, Mo - 1, D, h, mi, s);
}

/** 解析 iCal 中的日期时间值 → 浮时 "YYYY-MM-DDTHH:mm"（无 Z、无 TZID 偏移语义） */
function parseIcsFloating(v: string): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/.exec(v.trim());
  if (!m) return null;
  const [, Y, Mo, D, h, mi] = m.map(Number);
  return `${Y}-${String(Mo).padStart(2, "0")}-${String(D).padStart(2, "0")}T${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}`;
}

/** 还原 iCal 转义文本（\n 换行、\\ \, \;） */
function unesc(s: string): string {
  return s
    .replace(/\\n/gi, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\");
}

/** 解析单个 VEVENT 块 → 事件对象（解析失败返回 null） */
function parseVevent(block: string): ParsedIcsAppointment | null {
  const props = new Map<string, { params: string; value: string }>();
  for (const line of block.split(/\r\n|\n/)) {
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const namePart = line.slice(0, idx);
    const value = line.slice(idx + 1);
    const [name, ...paramParts] = namePart.split(";");
    props.set(name.toUpperCase(), { params: paramParts.join(";"), value });
  }

  const uid = props.get("UID")?.value ?? "";
  const summary = props.get("SUMMARY")?.value ?? "";
  if (!uid && !summary) return null;

  const startProp = props.get("DTSTART");
  const endProp = props.get("DTEND");
  if (!startProp) return null;

  const start = startProp.value;
  const isAllDay = /VALUE=DATE(?!-TIME)/i.test(startProp.params);
  const end = endProp?.value ?? "";

  const ev: ParsedIcsAppointment = {
    uid,
    summary: unesc(summary),
    description: props.get("DESCRIPTION") ? unesc(props.get("DESCRIPTION")!.value) : undefined,
    url: props.get("URL")?.value || undefined,
    startUtc: null,
    endUtc: null,
  };

  if (isAllDay) {
    // 全天事件：DTSTART/DTEND 均为 "YYYYMMDD"，DTEND 不含结束日
    const m = /^(\d{4})(\d{2})(\d{2})$/.exec(start.trim());
    if (m) {
      const s = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
      ev.allDayDate = `${m[1]}-${m[2]}-${m[3]}`;
      ev.startUtc = s;
      const m2 = /^(\d{4})(\d{2})(\d{2})$/.exec(end.trim());
      // endUtc = 最后一天零点（= DTEND 前一日；无 DTEND 时同 startUtc）
      ev.endUtc = m2
        ? Date.UTC(Number(m2[1]), Number(m2[2]) - 1, Number(m2[3]) - 1)
        : s;
    }
  } else {
    ev.startUtc = parseIcsUtc(start);
    if (ev.startUtc === null) {
      // 非 UTC：尝试浮时（含 TZID 的降级为浮时，按访客本地解释）
      ev.floatingStart = parseIcsFloating(start) ?? undefined;
    }
    if (end) {
      ev.endUtc = parseIcsUtc(end);
      if (ev.endUtc === null && !ev.floatingStart) {
        ev.floatingStart = parseIcsFloating(start) ?? undefined;
        ev.floatingEnd = parseIcsFloating(end) ?? undefined;
      } else if (ev.endUtc === null && ev.floatingStart) {
        ev.floatingEnd = parseIcsFloating(end) ?? undefined;
      }
    }
  }

  return ev;
}

/**
 * 解析完整 iCal 文本（VCALENDAR，可含多个 VEVENT）→ 事件数组。
 * 支持：行折叠、UTC（Z）、全天（VALUE=DATE）、浮时。TZID 事件降级为浮时。
 */
export function parseIcsText(text: string): ParsedIcsAppointment[] {
  // 行折叠：RFC 5545 中续行以单个空格/制表符开头
  const unfolded = text
    .replace(/\r\n[ \t]/g, "")
    .replace(/\n[ \t]/g, "")
    .replace(/\r[ \t]/g, "");

  const events: ParsedIcsAppointment[] = [];
  const veventRe = /BEGIN:VEVENT[\s\S]*?END:VEVENT/g;
  for (const match of unfolded.matchAll(veventRe)) {
    const ev = parseVevent(match[0]);
    if (ev) events.push(ev);
  }
  return events;
}
