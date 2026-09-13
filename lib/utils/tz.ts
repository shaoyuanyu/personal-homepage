/**
 * 时区工具（零依赖、零数据 import）。
 *
 * ccfddl 数据里的截止时间都是「会议所在时区的墙钟时间」（如 AoE 的 23:59:59），
 * 展示前必须换算成绝对时刻。显示端（/deadlines、/venues 客户端组件）与服务端
 * （`lib/data/conference.ts` 给日历事件补时间线）共用本模块——
 * ⚠ 此前该函数在 `deadlines-list.tsx` 与 `venue-explorer.tsx` 各抄了一份，
 *   改一处得同步两处；现在收敛到这里。
 */

/** "YYYY-MM-DD HH:mm:ss"（tz 墙钟时间）→ UTC 毫秒；tz 无效时按 UTC 兜底 */
export function zonedToUtcMs(ts: string, tz: string): number {
  const [d, time = "00:00:00"] = ts.split(" ");
  const [Y, M, D] = d.split("-").map(Number);
  const [h, mi, s] = time.split(":").map(Number);
  const naive = Date.UTC(Y, M - 1, D, h, mi, s);
  try {
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    const parts = dtf.formatToParts(new Date(naive));
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
    const wall = Date.UTC(
      get("year"),
      get("month") - 1,
      get("day"),
      get("hour") % 24,
      get("minute"),
      get("second"),
    );
    return naive - (wall - naive);
  } catch {
    return naive;
  }
}

/** 访客本地时区的 UTC 偏移标注（如 UTC+8 / UTC-4:30），随夏令时取当前偏移 */
export function localTzOffset(): string {
  // getTimezoneOffset() = UTC - 本地（分钟），正号表示本地比 UTC 慢
  const offsetMin = -new Date().getTimezoneOffset();
  const sign = offsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return `UTC${sign}${h}${m ? `:${String(m).padStart(2, "0")}` : ""}`;
}
