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
  /**
   * 外部日历客户端直接看到的标题。投稿节点事件应带上节点词（如 "ADMA 2026 · Full Paper"），
   * 否则外部客户端只看到会议名，会把这个「截止时刻」误读成「会议举办时间」。
   */
  summary: string;
  /**
   * 本站日历 UI 展示用的语言中立标题（如 "ADMA 2026"，不含节点词）。
   * SUMMARY 不得不带英文节点词（外部客户端无类别徽章），而本站 UI 用 CATEGORIES
   * + 本地化标签自己合成标题（"ADMA 2026 · 全文"），故把洁净标题另存一份，避免靠字符串裁剪。
   */
  confTitle?: string;
  /**
   * 会议全称（如 "International Conference on Very Large Data Bases"）。
   * ⚠ 为什么不用标准的 `DESCRIPTION`？因为**三大生态的「备注」框都绑定 DESCRIPTION**
   * （Apple EventKit 只有 `notes`、鸿蒙 `calendarManager.Event` 只有 `description`），
   * 而 DESCRIPTION 要留给用户自己的备注（双向可编辑）——否则用户一改备注就会把全称改坏。
   * 故全称放 RFC 5545 §3.8.8.2 明确允许的 `x-prop`（未识别的扩展属性客户端必须忽略）。
   */
  confName?: string;
  /**
   * 用户备注（标准 `DESCRIPTION` 属性）。
   * 客户端把 DESCRIPTION 当「备注/描述」框，所以用户可在 Apple/华为日历里直接看和改，双向同步。
   */
  description?: string;
  /** 地点（标准 LOCATION 属性，外部日历客户端可识别） */
  location?: string;
  /** 会期（如 "November 13 - 15, 2026"）。
   * iCal 无标准会期字段，用 X- 扩展属性承载：外部客户端忽略，本站日历 UI 结构化取用
   * （避免把会期埋在 DESCRIPTION 里靠文本解析）。
   */
  confDates?: string;
  url?: string;
  /** 类别（iCal CATEGORIES，语言中立的机器可读标签，如 ["abstract", "paper"]） */
  categories?: string[];
  /** UTC 毫秒时间戳 */
  start: number;
  end: number;
};

/**
 * iCal TEXT 值转义（RFC 5545 §3.3.11）：反斜杠 / 逗号 / 分号 / 换行。
 *
 * ⚠ 逗号与分号**必须**转义，此处没有选择余地：
 *   ① RFC 要求（TEXT 里这几个是特殊字符）；
 *   ② **Radicale 会吃掉裸逗号之后的全部内容**——它用 vobject 校验并**重新序列化**
 *      每个 item，而 vobject 把逗号当列表分隔符、只保留第一项。实测（本地
 *      Radicale）`LOCATION:Providence, RI, USA` 经 PUT 后存成 `LOCATION:Providence`、
 *      `SUMMARY:Alpha, Beta, Gamma` 存成 `SUMMARY:Alpha` → **静默丢数据**。
 *   代价是：**不做反转义的客户端**（手机端华为/鸿蒙日历）会把 `\,` 原样显示成
 *   `Providence\, RI\, USA`（用户报障）；网页端与桌面日历客户端都会反转义，
 *   所以只有手机端暴露。→ 因此**手机端可见的字段要避免出现这些字符**：
 *   地点走 `icsLocationText`（逗号 → 中点）。
 */
function esc(s: string): string {
  return s.replace(/[\\;,]/g, "\\$&").replace(/\n/g, "\\n");
}

/**
 * 写入 ICS 的**地点**文本：逗号 / 分号 → 中点（"Providence, RI, USA" → "Providence · RI · USA"）。
 *
 * ⚠ 为什么地点必须这样“改写”：逗号在客户端可见字段上无解——裸逗号会被 Radicale
 *   （vobject）截断丢数据（见 `esc`），而转义后的 `\,` 在**不做反转义的手机端客户端**
 *   上会原样显示（用户报障）。中点与站内其它分隔符（`ADMA 2026 · 全文`）同一视觉语言，
 *   且**不丢信息**（城市/州/国家三段都在）。
 * ⚠ **只对地点这么做**：LOCATION 是站内数据生成的结构化字段，换分隔符只是排版选择；
 *   **用户自己写的备注（DESCRIPTION）绝不能这样改写**——那里的转义必须原样保留
 *   （宁可手机端显示 `\,`，也不能动用户的字）。
 */
export function icsLocationText(place: string): string {
  return place.replace(/\s*[;,]+\s*/g, " · ").trim();
}

/**
 * 投稿节点 → 语言中立的英文词（写入 SUMMARY，供外部客户端识别事件性质）。
 * 本站 UI **不**直接显示它：由 CATEGORIES + `calendar.cat*` 本地化标签合成中文标题。
 */
export const NODE_LABEL_EN: Record<string, string> = {
  abstract: "Abstract",
  paper: "Full Paper",
  registration: "Registration",
  camera: "Camera-ready",
  notification: "Notification",
};

/**
 * 投稿节点事件的 SUMMARY 写法（CalDAV 写入 / .ics 下载 / Google 日历链接三处共用）：
 * `缩写 年份 · 英文节点词`，如 "ADMA 2026 · Full Paper"。
 */
export function icsEventSummary(
  abbr: string,
  year: number | string,
  labelKey?: string,
  /** 节点轮次备注原文（ccfddl 的 `c`，如 "Poster Paper"）：同一天同名事件靠它区分 */
  round?: string,
): string {
  const base = `${abbr} ${year}`;
  const node = NODE_LABEL_EN[labelKey ?? "paper"];
  if (!node) return base;
  // 轮次写在节点词**前**，与站内标题一致（「ADMA 2026 · Poster Full Paper」）；
  // 外部客户端（Apple / 华为）只有标题可用，不带轮次时同一天的两条事件长得一模一样
  const roundLabel = conferenceRoundLabel({ comment: round });
  return roundLabel ? `${base} · ${roundLabel} ${node}` : `${base} · ${node}`;
}

/** 节点类型 + 轮次备注 → UID 的中间段（轮次清洗成 slug，空轮次为空串） */
function roundUidSegment(round?: string): string {
  return (
    conferenceRoundLabel({ comment: round })
      ?.toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") ?? ""
  );
}

/**
 * 投稿节点日程的稳定 UID（CalDAV 写入与 .ics 下载共用）：
 * `缩写-年份-节点类型[-轮次短标签]-截止日期`，如 `adma-2026-paper-poster-20260911`。
 *
 * ⚠ **必须带截止日期**：ccfddl 的轮次备注 `c` 有大量缺口——230 个多节点届次里
 *   140 个（61%）的 `c` 完全为空，而这正是「一年多轮」那类会议
 *   （如 NSDI 2027 的四月/九月两轮，`c` 全空）。只按「缩写-年份-类型-轮次」定 UID 时
 *   同届同类型会撞成同一个键**互相覆盖**：实测 43 组节点命中（本地日历里
 *   NSDI 2027 的 4 条只剩了九月那 2 条、EDBT 2027 的 3 条只剩 1 条）。
 *   这 43 组里**没有任何一组是同一天**，故日期后缀足以保证唯一。
 * ⚠ `day` 用**会议所在时区**的日期（数据里 `entry.t` 的日期部分），与卡片显示的
 *   截止日期同源、可读；缺省时才退回 utc 的 UTC 日期。
 */
export function deadlineEventUid(opts: {
  abbr: string;
  year: number | string;
  labelKey?: string;
  round?: string;
  /** 截止日期（会议本地 "YYYY-MM-DD"） */
  day?: string;
  /** 兜底：没有 day 时用它的 UTC 日期 */
  utc: number;
}): string {
  const day = (opts.day ?? new Date(opts.utc).toISOString().slice(0, 10)).replace(
    /-/g,
    "",
  );
  return [
    opts.abbr.toLowerCase(),
    opts.year,
    opts.labelKey ?? "paper",
    roundUidSegment(opts.round),
    day,
  ]
    .filter(Boolean)
    .join("-");
}

/**
 * 历史 UID 格式（迁移用：写入成功后删掉它们，避免同一条日程留下两份）：
 * `缩写-年份-类型`（最初格式）与 `缩写-年份-类型-轮次`（上一版格式）。
 */
export function legacyEventUids(opts: {
  abbr: string;
  year: number | string;
  labelKey?: string;
  round?: string;
}): string[] {
  const base = `${opts.abbr.toLowerCase()}-${opts.year}-${opts.labelKey ?? "paper"}`;
  const round = roundUidSegment(opts.round);
  return round ? [base, `${base}-${round}`] : [base];
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
    ...(e.confTitle ? [`X-CONF-TITLE:${esc(e.confTitle)}`] : []),
    // 地点：改写掉逗号（见 icsLocationText——裸逗号会被 Radicale 截断、转义逗号在
    // 手机端客户端上会原样显示）
    ...(e.location ? [`LOCATION:${esc(icsLocationText(e.location))}`] : []),
    ...(e.confDates ? [`X-CONF-DATES:${esc(e.confDates)}`] : []),
    ...(e.confName ? [`X-CONF-NAME:${esc(e.confName)}`] : []),
    ...(e.description ? [`DESCRIPTION:${esc(e.description)}`] : []),
    ...(e.url ? [`URL:${esc(e.url)}`] : []),
    ...(e.categories?.length
      ? [`CATEGORIES:${e.categories.map(esc).join(",")}`]
      : []),
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
}

/* ---------------- iCal 属性级读写（无解析重建，保留未知属性） ---------------- */

/** 展开 iCal 折行（RFC 5545 续行以单个空格/制表符开头） */
function unfoldIcs(text: string): string {
  return text
    .replace(/\r\n[ \t]/g, "")
    .replace(/\n[ \t]/g, "")
    .replace(/\r[ \t]/g, "");
}

/**
 * 读取 VCALENDAR 文本中的某个属性值（未转义文本；不存在返回 undefined）。
 * 注：取第一个匹配（本站事件均只有一个 VEVENT）。
 */
export function getIcsProperty(icsText: string, name: string): string | undefined {
  const m = new RegExp(`^${name}:(.*)$`, "m").exec(unfoldIcs(icsText));
  return m ? unesc(m[1].trim()) : undefined;
}

/**
 * 替换 / 插入 / 删除 VCALENDAR 文本中的某个属性，**其余属性原样保留**（含本站不认识的
 * VALARM / ATTENDEE / 其它 X- 属性）——故不用「解析成对象再重建」（外部客户端写入的
 * 属性会被静默丢掉）。value 为 null/空串时删除该属性。
 */
export function upsertIcsProperty(
  icsText: string,
  name: string,
  value: string | null,
): string {
  const lines = unfoldIcs(icsText).split(/\r?\n/);
  const propRe = new RegExp(`^${name}[;:]`);
  const idx = lines.findIndex((line) => propRe.test(line));
  const newLine = value ? `${name}:${esc(value)}` : null;

  if (idx >= 0) {
    if (newLine) lines[idx] = newLine;
    else lines.splice(idx, 1);
  } else if (newLine) {
    const end = lines.findIndex((line) => line.trim().toUpperCase() === "END:VEVENT");
    lines.splice(end >= 0 ? end : lines.length, 0, newLine);
  }
  return lines.join("\r\n");
}

/* ---------------- iCal 解析（CalDAV 读取方向） ---------------- */

/** 会议届别的投稿节点（服务端按会议数据补齐，不来自 ICS 文件本身） */
export type IcsConferenceNode = {
  /** 截止时刻（UTC 毫秒，已按会议所在时区换算） */
  utc: number;
  /** 节点类型（与 CATEGORIES 同词表：abstract / paper / registration / …） */
  kind: string;
  /** 轮次备注原文（如 "Main Track" / "first round"，ccfddl 数据原文） */
  comment?: string;
};

/**
 * 事件所属会议届别的信息（`/api/calendar` 服务端按事件标题里的「缩写 + 年份」
 * 从 deadlines 数据补齐）：详情弹窗用它展示这届会议**完整的时间线**，
 * 并支持点击节点跳到同届其它节点的事件。个人日程 / 第三方事件没有此字段。
 */
export type IcsConferenceInfo = {
  /** 缩写 */
  abbr: string;
  /** 届别年份 */
  year: number;
  /** 该届官网 */
  link?: string;
  /** 会期原文 */
  date?: string;
  /** 举办地 */
  place?: string;
  /** 该届全部投稿节点（按时间升序） */
  nodes: IcsConferenceNode[];
};

export type ParsedIcsAppointment = {
  uid: string;
  summary: string;
  /** 本站写入的洁净标题（X-CONF-TITLE，不含节点词）；第三方事件无此字段 */
  confTitle?: string;
  /** 会议全称（X-CONF-NAME 扩展属性，本站写入；第三方客户端不提供也不显示） */
  confName?: string;
  /** 用户备注（标准 DESCRIPTION；客户端「备注」框读写的就是它） */
  description?: string;
  /** 地点（LOCATION 属性） */
  location?: string;
  /** 会议会期（X-CONF-DATES 扩展属性，本站写入；第三方客户端一般不提供） */
  confDates?: string;
  url?: string;
  /** 类别（CATEGORIES 属性值，逗号分割去转义；缺失时为 undefined） */
  categories?: string[];
  /** 全天事件日期 "YYYY-MM-DD"（无时区语义，按浏览器本地日解释） */
  allDayDate?: string;
  /** 明确 UTC 时间（毫秒戳）；null 表示全天或浮时 */
  startUtc: number | null;
  endUtc: number | null;
  /** 浮时时间 "YYYY-MM-DDTHH:mm"（无时区语义，按浏览器本地解释） */
  floatingStart?: string;
  floatingEnd?: string;
  /** 会议届别信息（仅 `/api/calendar` 服务端补齐；个人日程 / 第三方事件为 undefined） */
  conference?: IcsConferenceInfo;
};

/**
 * 节点与事件的时刻容差（毫秒）。写入时段的 DTSTART 与节点时刻用**同一个**
 * `zonedToUtcMs(t, tz)` 换算（服务端 `lib/data/conference.ts` 与卡片写入端共用），
 * 故实为精确相等；容 1 分钟只为防浮点/秒级误差。
 */
export const NODE_TIME_TOLERANCE_MS = 60_000;

/**
 * 事件命中的**那个**投稿节点（同届里时刻吻合的第一个；无 conference / 时刻对不上时 null）。
 * ⚠ 只取一个：同届同一天可能有多个节点共用同一截止时刻（如 ADMA 2026 的
 *   「Poster Paper / Encore Paper」），逐个判定会让「当前项」变成多个。
 */
export function matchedConferenceNode(
  ev: ParsedIcsAppointment,
): IcsConferenceNode | null {
  const nodes = ev.conference?.nodes;
  if (!nodes || nodes.length === 0) return null;

  // ① 先按 `SUMMARY` 里的「轮次 节点词」**精确定位**（本站写入的事件都带这个后缀）。
  //    ⚠ 必须优先于时刻匹配：同一届同一天可能有多个节点**共用同一截止时刻**
  //    （ADMA 2026 的 Poster / Encore），此时时刻匹配只能命中第一个，
  //    两条日程会显示成同一个节点（标题/徐章都变成 "Poster"）。
  const catKey = (ev.categories ?? [])
    .map((c) => c.trim().toLowerCase())
    .find((c) => c in NODE_LABEL_EN);
  const nodeWord = NODE_LABEL_EN[catKey ?? "paper"];
  const tail = ev.summary
    .split("·")
    .slice(1)
    .map((part) => part.trim())
    .join(" · ");
  if (tail && nodeWord) {
    const hit = nodes.find((n) => {
      const round = conferenceRoundLabel(n);
      return round !== null && tail === `${round} ${nodeWord}`;
    });
    if (hit) return hit;
  }

  // ② 回退：按时刻容差（旧格式事件、以及外部客户端写入的无轮次事件）
  if (ev.startUtc === null) return null;
  const startUtc = ev.startUtc;
  return (
    nodes.find((n) => Math.abs(startUtc - n.utc) <= NODE_TIME_TOLERANCE_MS) ?? null
  );
}

/**
 * 节点的**轮次短标签**（如 "Poster" / "Main Track"）：让同一天、同类型的多条节点日程
 * （ccfddl 里的 Poster / Encore 等轮次）在标题与徽章里有可区分的名字。
 *
 * ⚠ 数据源的 `c` 字段既可能是干净的轮次名，也可能是整句说明
 *   （如 "Supplementary material due Sep 2, 2026. All deadlines are 11:00 am"）
 *   → 只接受**短且无句读**的：长度 ≤ 40 且不含 `.:;,`（`/` 允许，如 "2026/1"）。
 * ⚠ 尾部的 " Paper" 去掉（类别名已由徽章/标题表达）："Poster Paper" +「全文」→ "Poster 全文"。
 */
function roundBaseLabel(comment?: string): string | null {
  const raw = comment?.trim();
  if (!raw || raw.length > 40 || /[.:;,]/.test(raw)) return null;
  return raw.replace(/\s+Papers?$/i, "").trim() || null;
}

/**
 * 轮次的**完整标签**（去尾 `" Paper"`，**不做**尾部剥离）：如 `Spring Submission Deadline`。
 * ⚠ 时间线**优先显示它**——竖向布局的行宽与节点数无关（宽屏分栏 297px、窄屏 396px），
 *   最长的备注（37 字符 ≈ 220px）也放得下；只有当行宽不够时才降级到 `conferenceRoundLabel`。
 */
export function conferenceRoundFullLabel(
  node?: { comment?: string } | null,
): string | null {
  return roundBaseLabel(node?.comment);
}

/**
 * 轮次的**短标签**（在完整标签上再剥掉尾部流程词）：`Spring Submission Deadline` → `Spring`。
 * 用于 **UID slug / SUMMARY / 列表徽章**（这些位置的宽度受限），以及**时间线**在窄行宽下的降级。
 */
export function conferenceRoundLabel(
  node?: { comment?: string } | null,
): string | null {
  const base = roundBaseLabel(node?.comment);
  return base ? shortenRoundLabel(base) || base : null;
}

/**
 * 轮次标签里**只表流程、不表区分**的尾部词：反复剥掉它们，只留核心词——
 * `Spring Submission Deadline` → `Spring`、`September Cycle Submission Deadline` → `September`、
 * `Main Track` → `Main`、`Industry Track` → `Industry`。
 *
 * ⚠ 为什么仍需要它：**UID slug / SUMMARY / 列表徽章**这些位置宽度受限（外部客户端的
 *   标题也要短）；时间线本身**优先显示完整标签**（`conferenceRoundFullLabel`），
 *   只在行宽极窄时降级到短标签。
 * ⚠ 只剥**尾部**且必须剥完仍非空（`Submission Deadline` → `Submission`，避免剥成空串）。
 *   实测 313 个会议：205 个可清洗标签中 136 个被缩短，**同一届内零冲突**（核心词仍能区分）。
 */
function shortenRoundLabel(label: string): string {
  const TAIL =
    /\s+(Tracks?|Sessions?|Papers?|Deadlines?|Cycles?|Submissions?|Rounds?|Phases?|Schedules?)$/i;
  let out = label;
  for (;;) {
    const next = out.replace(TAIL, "").trim();
    if (!next || next === out) return out;
    out = next;
  }
}

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

  // CATEGORIES 为逗号分隔列表（TEXT 转义，分隔逗号不转义）——lookbehind 排除 \, 字面逗号
  const rawCategories = props.get("CATEGORIES")?.value;
  const categories = rawCategories
    ? rawCategories.split(/(?<!\\),/).map(unesc).filter(Boolean)
    : undefined;

  const startProp = props.get("DTSTART");
  const endProp = props.get("DTEND");
  if (!startProp) return null;

  const start = startProp.value;
  const isAllDay = /VALUE=DATE(?!-TIME)/i.test(startProp.params);
  const end = endProp?.value ?? "";

  const ev: ParsedIcsAppointment = {
    uid,
    summary: unesc(summary),
    confTitle: props.get("X-CONF-TITLE") ? unesc(props.get("X-CONF-TITLE")!.value) : undefined,
    description: props.get("DESCRIPTION") ? unesc(props.get("DESCRIPTION")!.value) : undefined,
    location: props.get("LOCATION") ? unesc(props.get("LOCATION")!.value) : undefined,
    confName: props.get("X-CONF-NAME") ? unesc(props.get("X-CONF-NAME")!.value) : undefined,
    confDates: props.get("X-CONF-DATES") ? unesc(props.get("X-CONF-DATES")!.value) : undefined,
    url: props.get("URL")?.value || undefined,
    categories,
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
  const unfolded = unfoldIcs(text);

  const events: ParsedIcsAppointment[] = [];
  const veventRe = /BEGIN:VEVENT[\s\S]*?END:VEVENT/g;
  for (const match of unfolded.matchAll(veventRe)) {
    const ev = parseVevent(match[0]);
    if (ev) events.push(ev);
  }
  return events;
}
