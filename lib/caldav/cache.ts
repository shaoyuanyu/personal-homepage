import type { ParsedIcsAppointment } from "@/lib/ical";
import { globalMap } from "@/lib/utils/global-state";

/**
 * GET /api/calendar 的简单内存缓存（30 秒，月视图翻页会重复请求同一范围）。
 * 独立成模块：写入/删除事件后调用 invalidateCalendarCache() 失效，保证立即读到最新数据。
 *
 * ⚠ 缓存表必须挂在 `globalThis` 上（模块级 Map 逐请求重建 → 缓存永不命中）。
 */

export type CalendarCacheEntry = { expires: number; events: ParsedIcsAppointment[] };

export const CALENDAR_CACHE_TTL_MS = 30_000;

export const calendarCache = globalMap<string, CalendarCacheEntry>("caldav:calendar-cache");

/** 清空日历读取缓存（删除/写入事件后调用） */
export function invalidateCalendarCache() {
  calendarCache.clear();
}
