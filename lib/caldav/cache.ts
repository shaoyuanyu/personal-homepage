import type { ParsedIcsEvent } from "@/lib/ical";

/**
 * GET /api/calendar 的简单内存缓存（30 秒，月视图翻页会重复请求同一范围）。
 * 独立成模块：写入/删除事件后调用 invalidateCalendarCache() 失效，保证立即读到最新数据。
 */

export type CalendarCacheEntry = { expires: number; events: ParsedIcsEvent[] };

export const CALENDAR_CACHE_TTL_MS = 30_000;

export const calendarCache = new Map<string, CalendarCacheEntry>();

/** 清空日历读取缓存（删除/写入事件后调用） */
export function invalidateCalendarCache() {
  calendarCache.clear();
}
