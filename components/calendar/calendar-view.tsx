"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import {
  CalendarClockIcon,
  CalendarDaysIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ExternalLinkIcon,
  HouseIcon,
  RefreshCwIcon,
  TriangleAlertIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { enUS, zhCN } from "react-day-picker/locale";
import type { ParsedIcsEvent } from "@/lib/ical";

/* ---------------- 日期工具（无依赖） ---------------- */

type Day = { y: number; m: number; d: number };

function toDayKey(day: Day): string {
  return `${day.y}-${String(day.m).padStart(2, "0")}-${String(day.d).padStart(2, "0")}`;
}

function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** 事件 → 本地日期范围（跨天事件覆盖多个日期） */
function eventLocalRange(ev: ParsedIcsEvent): { start: Day; end: Day } {
  const fromMs = (ms: number): Day => {
    const d = new Date(ms);
    return { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate() };
  };
  const fromStr = (s: string): Day => {
    const [date] = s.split("T");
    const [y, m, d] = date.split("-").map(Number);
    return { y, m, d };
  };

  let start: Day;
  let end: Day;
  if (ev.allDayDate) {
    start = fromStr(ev.allDayDate);
    // 持续天数 = (endUtc - startUtc) / 天（至少 1 天）
    const days =
      ev.startUtc !== null && ev.endUtc !== null
        ? Math.max(1, Math.round((ev.endUtc - ev.startUtc) / 86_400_000) + 1)
        : 1;
    end = fromMs(Date.UTC(start.y, start.m - 1, start.d + days - 1));
  } else if (ev.floatingStart) {
    start = fromStr(ev.floatingStart);
    end = ev.floatingEnd ? fromStr(ev.floatingEnd) : start;
    // 防御：结束早于开始时按单日处理
    if (toDayKey(end) < toDayKey(start)) end = start;
  } else if (ev.startUtc !== null) {
    start = fromMs(ev.startUtc);
    end = ev.endUtc !== null ? fromMs(ev.endUtc) : start;
    // 同一天内结束（如 1 小时事件）只算一天；结束早于开始视为异常单日
    if (
      sameDay(new Date(ev.startUtc), new Date(ev.endUtc ?? ev.startUtc)) ||
      toDayKey(end) < toDayKey(start)
    ) {
      end = start;
    }
  } else {
    return { start: { y: 1970, m: 1, d: 1 }, end: { y: 1970, m: 1, d: 1 } };
  }
  return { start, end };
}

/** 事件 → 本地开始时间 Date（归格与列表排序共用） */
function eventStartDate(ev: ParsedIcsEvent): Date {
  if (ev.allDayDate) {
    const [y, m, d] = ev.allDayDate.split("-").map(Number);
    return new Date(y, m - 1, d);
  }
  if (ev.floatingStart) {
    const [date, time] = ev.floatingStart.split("T");
    const [y, m, d] = date.split("-").map(Number);
    const [h, mi] = time.split(":").map(Number);
    return new Date(y, m - 1, d, h, mi);
  }
  if (ev.startUtc !== null) return new Date(ev.startUtc);
  return new Date(0);
}

/** 事件当天的时间前缀（HH:mm，本地）；全天/无时刻返回 null */
function eventTimePrefix(ev: ParsedIcsEvent, locale: string): string | null {
  if (ev.allDayDate || ev.floatingStart) {
    return ev.floatingStart ? ev.floatingStart.split("T")[1] : null;
  }
  if (ev.startUtc === null) return null;
  return new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(ev.startUtc));
}

const WEEKDAY_ZH = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
const WEEKDAY_EN = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/* ---------------- 主组件 ---------------- */

export function CalendarView() {
  const t = useTranslations("calendar");
  const locale = useLocale();
  // 周起始：zh 周一（1），en 周日（0）
  const weekStartsOn = locale === "zh" ? 1 : 0;
  // 网格容器引用：列表点击跳转后瞬时定位到网格顶部
  const gridRef = useRef<HTMLDivElement>(null);

  const [viewDate, setViewDate] = useState<Date>(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });
  const [events, setEvents] = useState<ParsedIcsEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ParsedIcsEvent | null>(null);
  // 聚焦的选中日期；null = 未聚焦（下方显示本月及未来事件总览）
  const [selectedDate, setSelectedDate] = useState<Date | null>(null);
  // 选中日期的当天事件（聚焦时按需加载，双向联动）
  const [dayEvents, setDayEvents] = useState<ParsedIcsEvent[]>([]);
  const [dayEventsLoading, setDayEventsLoading] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  // 本月及未来事件列表（网格下方详细列表，独立于当月网格加载）
  const [upcoming, setUpcoming] = useState<ParsedIcsEvent[]>([]);
  const [upcomingLoading, setUpcomingLoading] = useState(true);
  // 跳转选择器：打开状态 + 本地时区（官方 Calendar timeZone prop，避免 SSR 不一致）
  const [jumpOpen, setJumpOpen] = useState(false);
  const [timeZone, setTimeZone] = useState<string | undefined>(undefined);
  const [jumpMonth, setJumpMonth] = useState<Date>(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });

  useEffect(() => {
    setTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
  }, []);

  // 聚焦某天时：按需加载当天事件（任意日期均准确，API 有 30s 缓存兜底）
  useEffect(() => {
    if (!selectedDate) {
      setDayEvents([]);
      return;
    }
    let cancelled = false;
    const fmt = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    setDayEventsLoading(true);
    fetch(`/api/calendar?start=${fmt(selectedDate)}&end=${fmt(selectedDate)}&v=${reloadKey}`)
      .then((r) => r.json().catch(() => null))
      .then((data: { events?: ParsedIcsEvent[] } | null) => {
        if (!cancelled && data?.events) setDayEvents(data.events);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setDayEventsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedDate, reloadKey]);

  // 加载本月 1 日 ~ 未来 7 个月末的事件（网格下方列表；刷新按钮联动）
  useEffect(() => {
    let cancelled = false;
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    const end = new Date(now.getFullYear(), now.getMonth() + 7, 0);
    const fmt = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    setUpcomingLoading(true);
    fetch(`/api/calendar?start=${fmt(start)}&end=${fmt(end)}&v=${reloadKey}`)
      .then((r) => r.json().catch(() => null))
      .then((data: { events?: ParsedIcsEvent[] } | null) => {
        if (!cancelled && data?.events) setUpcoming(data.events);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setUpcomingLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  // 网格范围：从月首向前补到周起始，固定 42 格（6 周），拆成 6 行 × 7 列
  const gridDays = useMemo(() => {
    const first = new Date(viewDate.getFullYear(), viewDate.getMonth(), 1);
    const offset = (first.getDay() - weekStartsOn + 7) % 7;
    const start = addDays(first, -offset);
    return Array.from({ length: 42 }, (_, i) => addDays(start, i));
  }, [viewDate, weekStartsOn]);

  const weekRows = useMemo(() => {
    const rows: Date[][] = [];
    for (let i = 0; i < 6; i++) {
      rows.push(gridDays.slice(i * 7, i * 7 + 7));
    }
    return rows;
  }, [gridDays]);

  const loadEvents = useCallback(async () => {
    setLoading(true);
    setError(null);
    const start = toDayKey({
      y: gridDays[0].getFullYear(),
      m: gridDays[0].getMonth() + 1,
      d: gridDays[0].getDate(),
    });
    const last = gridDays[41];
    const end = toDayKey({ y: last.getFullYear(), m: last.getMonth() + 1, d: last.getDate() });
    try {
      const res = await fetch(`/api/calendar?start=${start}&end=${end}&v=${reloadKey}`);
      if (res.status === 503) {
        setError(t("notConfigured"));
        return;
      }
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(data?.error ?? t("loadFailed"));
        return;
      }
      const data = (await res.json()) as { events: ParsedIcsEvent[] };
      setEvents(data.events);
    } catch {
      setError(t("loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [gridDays, reloadKey, t]);

  useEffect(() => {
    void loadEvents();
  }, [loadEvents]);

  // 事件按日期归格（跨天事件在每一天都出现）
  const byDay = useMemo(() => {
    const map = new Map<string, ParsedIcsEvent[]>();
    for (const ev of events) {
      const { start, end } = eventLocalRange(ev);
      const endKey = toDayKey(end);
      let day = start;
      // 防御：最多遍历 31 天（跨月事件不会超过一个月）
      for (let i = 0; i < 32; i++) {
        const key = toDayKey(day);
        const list = map.get(key) ?? [];
        list.push(ev);
        map.set(key, list);
        if (key === endKey) break;
        const d = new Date(day.y, day.m - 1, day.d + 1);
        day = { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate() };
      }
    }
    // 每天内按开始时间排序（无时刻的排最前）
    for (const list of map.values()) {
      list.sort((a, b) => {
        const at = a.startUtc ?? (a.floatingStart ? -1 : -2);
        const bt = b.startUtc ?? (b.floatingStart ? -1 : -2);
        return at - bt;
      });
    }
    return map;
  }, [events]);

  const today = new Date();
  const monthTitle = useMemo(
    () =>
      new Intl.DateTimeFormat(locale, { year: "numeric", month: "long" }).format(
        viewDate,
      ),
    [locale, viewDate],
  );
  const weekdays = locale === "zh" ? WEEKDAY_ZH : WEEKDAY_EN;

  const prevMonth = () =>
    setViewDate((v) => new Date(v.getFullYear(), v.getMonth() - 1, 1));
  const nextMonth = () =>
    setViewDate((v) => new Date(v.getFullYear(), v.getMonth() + 1, 1));
  const jumpToToday = () => {
    const now = new Date();
    setViewDate(new Date(now.getFullYear(), now.getMonth(), 1));
    setSelectedDate(new Date(now.getFullYear(), now.getMonth(), now.getDate()));
  };
  // 回本月并取消聚焦（下方显示本月及未来事件总览）
  const jumpToThisMonth = () => {
    const now = new Date();
    setViewDate(new Date(now.getFullYear(), now.getMonth(), 1));
    setSelectedDate(null);
  };
  const refresh = () => setReloadKey((k) => k + 1);

  const inCurrentMonth = (d: Date) => d.getMonth() === viewDate.getMonth();
  // 分段按钮状态高亮：viewDate 为当前月 / 聚焦今天
  const isThisMonth =
    viewDate.getFullYear() === today.getFullYear() &&
    viewDate.getMonth() === today.getMonth();
  const isTodaySelected =
    selectedDate !== null && sameDay(selectedDate, today);

  return (
    <div>
      {/* 工具栏：‹ 月份 › 居中夹住月份标题（Google 布局），今天为按钮样式 */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
        <div className="flex items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={prevMonth}
            aria-label={t("prevMonth")}
          >
            <ChevronLeftIcon data-icon="default" />
          </Button>
          {/* 月份标题：点击弹出跳转选择器（自绘 Popover，Base UI Select 在 Dialog 内 Popup 定位失败） */}
          <div className="relative">
            <Button
              variant="ghost"
              size="sm"
              className="text-base font-semibold tracking-tight"
              onClick={() => setJumpOpen((o) => !o)}
              aria-label={t("jumpTo")}
              aria-expanded={jumpOpen}
            >
              {monthTitle}
            </Button>
            {jumpOpen && (
              <>
                {/* 遮罩：点击外部关闭 */}
                <div
                  className="fixed inset-0 z-40"
                  onClick={() => setJumpOpen(false)}
                  aria-hidden
                />
                {/* 浮层面板 */}
                <div className="absolute left-1/2 top-full z-50 mt-2 -translate-x-1/2 rounded-xl border bg-popover p-2 shadow-lg">
                  <Calendar
                    mode="single"
                    onSelect={(d) => {
                      if (d) {
                        setViewDate(new Date(d.getFullYear(), d.getMonth(), 1));
                        setSelectedDate(
                          new Date(d.getFullYear(), d.getMonth(), d.getDate()),
                        );
                        setJumpOpen(false);
                      }
                    }}
                    month={jumpMonth}
                    onMonthChange={setJumpMonth}
                    locale={locale === "zh" ? zhCN : enUS}
                    timeZone={timeZone}
                    components={{
                      // 用 Month/Year Select 选择，移除 rdp 内置 ‹ › 导航层
                      // （其 absolute 全宽层会拦截 Caption 内 Select 的点击）
                      Nav: () => <></>,
                      MonthCaption: ({ calendarMonth, ...props }) => (
                        // z-10：防止其他绝对定位层拦截 Select 点击
                        <div
                          {...props}
                          className={cn(props.className, "relative z-10")}
                        >
                          <MonthYearSelect
                            displayMonth={calendarMonth.date}
                            locale={locale}
                            onMonthChange={setJumpMonth}
                          />
                        </div>
                      ),
                    }}
                    className="rounded-lg"
                  />
                </div>
              </>
            )}
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={nextMonth}
            aria-label={t("nextMonth")}
          >
            <ChevronRightIcon data-icon="default" />
          </Button>
        </div>
        <div className="flex items-center gap-2">
          {/* 分段按钮：本月 | 今日（连体 + 图标 + 当前态高亮） */}
          <div role="group" aria-label={t("jumpLabel")} className="flex items-center">
            <Button
              variant="outline"
              size="sm"
              className={`gap-1 rounded-r-none ${
                isThisMonth ? "bg-muted text-foreground hover:bg-muted" : ""
              }`}
              onClick={jumpToThisMonth}
            >
              <HouseIcon data-icon="default" className="size-3.5" />
              {t("jumpThisMonth")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className={`-ml-px gap-1 rounded-l-none ${
                isTodaySelected ? "bg-muted text-foreground hover:bg-muted" : ""
              }`}
              onClick={jumpToToday}
            >
              <CalendarDaysIcon data-icon="default" className="size-3.5" />
              {t("jumpToday")}
            </Button>
          </div>
          <Button variant="ghost" size="sm" onClick={refresh} aria-label={t("refresh")}>
            <RefreshCwIcon data-icon="default" className={loading ? "animate-spin" : ""} />
            <span className="hidden sm:inline">{t("refresh")}</span>
          </Button>
        </div>
      </div>

      {/* 加载中 */}
      {loading ? (
        <div className="flex h-64 items-center justify-center">
          <Spinner className="size-6 text-muted-foreground" />
        </div>
      ) : error ? (
        <div className="flex flex-col items-center gap-4 py-16 text-center">
          <TriangleAlertIcon data-icon="default" className="size-8 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">{error}</p>
          <Button variant="outline" size="sm" onClick={refresh}>
            {t("retry")}
          </Button>
        </div>
      ) : (
        <>
          {/* 卡片式月视图：独立表头 + 行分隔线 + 列分隔线（非当月格仅淡显日期，不显示事件） */}
          <div
            ref={gridRef}
            className="scroll-mt-16 overflow-hidden rounded-2xl border bg-card shadow-sm"
          >
            {/* 表头：shadcn 表格风格（muted 底 + 灰字），周末不特殊化 */}
            <div className="grid grid-cols-7 border-b bg-muted/50">
              {weekdays.map((w) => (
                <div
                  key={w}
                  className="py-2.5 text-center text-xs font-medium text-muted-foreground"
                >
                  {w}
                </div>
              ))}
            </div>
            {/* 6 行日期格 */}
            {weekRows.map((row, ri) => (
              <div
                key={ri}
                className={`grid grid-cols-7 ${ri > 0 ? "border-t" : ""}`}
              >
                {row.map((day, ci) => {
                  const key = toDayKey({
                    y: day.getFullYear(),
                    m: day.getMonth() + 1,
                    d: day.getDate(),
                  });
                  const dayEvents = byDay.get(key) ?? [];
                  const isToday = sameDay(day, today);
                  const isSelected =
                    selectedDate !== null && sameDay(day, selectedDate);
                  const inMonth = inCurrentMonth(day);
                  return (
                    <div
                      key={key}
                      onClick={() => {
                        // 点击日期格 → 聚焦该日期；非当月格子自动跳到对应月；
                        // 再次点击已聚焦的当月日期 → 取消聚焦（回到总览）
                        const target = new Date(
                          day.getFullYear(),
                          day.getMonth(),
                          day.getDate(),
                        );
                        if (!inMonth) {
                          setViewDate(
                            new Date(day.getFullYear(), day.getMonth(), 1),
                          );
                          setSelectedDate(target);
                          return;
                        }
                        setSelectedDate((cur) =>
                          cur && sameDay(cur, target) ? null : target,
                        );
                      }}
                      className={`min-h-20 cursor-pointer p-1.5 transition-colors hover:bg-muted/40 sm:min-h-24 sm:p-2 ${
                        ci > 0 ? "border-l" : ""
                      } ${
                        !inMonth ? "bg-muted/10 hover:bg-muted/20" : ""
                      } ${
                        isSelected ? "bg-muted/40 hover:bg-muted/50" : ""
                      }`}
                    >
                      {/* 日期号：选中实底 primary；今天（未选中）muted 圆底；非当月淡显 */}
                      <div className="mb-1.5 flex justify-between">
                        <span
                          className={`flex size-6 items-center justify-center rounded-full text-sm tabular-nums ${
                            isSelected
                              ? "bg-primary font-semibold text-primary-foreground shadow-sm"
                              : isToday && inMonth
                                ? "bg-muted font-medium text-foreground"
                                : inMonth
                                  ? "font-medium text-foreground"
                                  : "text-muted-foreground/40"
                          }`}
                        >
                          {day.getDate()}
                        </span>
                      </div>
                      {/* 事件块：secondary 淡灰底深字（shadcn 官方色板），非当月不显示 */}
                      <div className="flex flex-col gap-1 overflow-hidden">
                        {inMonth &&
                          dayEvents.slice(0, 3).map((ev) => {
                            const prefix = eventTimePrefix(ev, locale);
                            return (
                              <button
                                key={ev.uid + key}
                                onClick={() => setSelected(ev)}
                                title={ev.summary}
                                className="flex w-full items-center gap-1 rounded bg-secondary/80 px-1.5 py-1 text-left text-xs font-semibold leading-4 text-secondary-foreground transition-colors hover:bg-secondary"
                              >
                                {prefix && (
                                  <span className="shrink-0 text-[10px] font-medium tabular-nums text-muted-foreground">
                                    {prefix}
                                  </span>
                                )}
                                <span className="truncate">{ev.summary}</span>
                              </button>
                            );
                          })}
                        {inMonth && dayEvents.length > 3 && (
                          <span className="px-1.5 text-[10px] font-medium text-muted-foreground">
                            {t("more", { n: dayEvents.length - 3 })}
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>

          {/* 空状态 */}
          {events.length === 0 && (
            <Empty className="mt-8">
              <EmptyHeader>
                <EmptyTitle>{t("empty")}</EmptyTitle>
                <EmptyDescription>{t("emptyHint")}</EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
        </>
      )}

      {/* 双向联动：聚焦某天 → 显示当天事件；未聚焦 → 显示本月及未来事件总览 */}
      {selectedDate ? (
        <DayEventsList
          date={selectedDate}
          events={dayEvents}
          loading={dayEventsLoading}
          locale={locale}
          onSelect={setSelected}
          onClear={() => setSelectedDate(null)}
        />
      ) : (
        <UpcomingEventsList
          events={upcoming}
          loading={upcomingLoading}
          locale={locale}
          onJump={(ev) => {
            const d = eventStartDate(ev);
            setViewDate(new Date(d.getFullYear(), d.getMonth(), 1));
            setSelectedDate(new Date(d.getFullYear(), d.getMonth(), d.getDate()));
            // 瞬时定位到网格顶部（scroll-mt 避开 sticky header），避免平滑滚动动画的抽动感
            gridRef.current?.scrollIntoView({ behavior: "auto", block: "start" });
          }}
        />
      )}

      {/* 事件详情 Dialog */}
      <Dialog open={selected !== null} onOpenChange={(open) => !open && setSelected(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CalendarDaysIcon data-icon="default" className="size-4 shrink-0" />
              <span className="truncate">{selected?.summary ?? ""}</span>
            </DialogTitle>
            <DialogDescription className="sr-only">
              {selected?.summary ?? ""}
            </DialogDescription>
          </DialogHeader>
          {selected && (
            <EventDetails event={selected} locale={locale} />
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setSelected(null)}>
              {t("close")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** 官方 Calendar 的月份/年份选择器：用 shadcn Select 替换 react-day-picker 原生下拉 */
function MonthYearSelect({
  displayMonth,
  locale,
  onMonthChange,
}: {
  displayMonth: Date;
  locale: string;
  onMonthChange: (d: Date) => void;
}) {
  const monthOptions = useMemo(
    () =>
      Array.from({ length: 12 }, (_, i) => ({
        value: String(i + 1),
        label: new Intl.DateTimeFormat(locale, { month: "long" }).format(
          new Date(2000, i, 1),
        ),
      })),
    [locale],
  );
  // 年份范围：今年 -3 ～ +7（覆盖当年/次年会议 deadline 与个人安排）
  const yearOptions = useMemo(() => {
    const y = new Date().getFullYear();
    return Array.from({ length: 11 }, (_, i) => y - 3 + i);
  }, []);

  return (
    <div className="flex items-center justify-center gap-1.5">
      <Select
        value={String(displayMonth.getMonth() + 1)}
        onValueChange={(v) =>
          v && onMonthChange(new Date(displayMonth.getFullYear(), Number(v) - 1, 1))
        }
      >
        <SelectTrigger size="sm" className="w-24" aria-label="Month">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {monthOptions.map((m) => (
            <SelectItem key={m.value} value={m.value} label={m.label}>
              {m.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select
        value={String(displayMonth.getFullYear())}
        onValueChange={(v) =>
          v && onMonthChange(new Date(Number(v), displayMonth.getMonth(), 1))
        }
      >
        <SelectTrigger size="sm" className="w-24" aria-label="Year">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {yearOptions.map((y) => (
            <SelectItem key={y} value={String(y)} label={String(y)}>
              {y}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/** 聚焦某天的当天事件列表：按时间排序，可点击打开详情，「显示全部」返回总览 */
function DayEventsList({
  date,
  events,
  loading,
  locale,
  onSelect,
  onClear,
}: {
  date: Date;
  events: ParsedIcsEvent[];
  loading: boolean;
  locale: string;
  onSelect: (ev: ParsedIcsEvent) => void;
  onClear: () => void;
}) {
  const t = useTranslations("calendar");

  const title = useMemo(
    () =>
      new Intl.DateTimeFormat(locale, {
        year: "numeric",
        month: "long",
        day: "numeric",
        weekday: "long",
      }).format(date),
    [date, locale],
  );
  const sorted = useMemo(
    () =>
      [...events].sort(
        (a, b) => eventStartDate(a).getTime() - eventStartDate(b).getTime(),
      ),
    [events],
  );

  const header = (
    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
      <h2 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
        <CalendarDaysIcon
          data-icon="default"
          className="size-5 text-muted-foreground"
        />
        {title}
        {!loading && sorted.length > 0 && (
          <span className="text-xs font-normal text-muted-foreground">
            {t("items", { n: sorted.length })}
          </span>
        )}
      </h2>
      <Button variant="outline" size="sm" onClick={onClear}>
        {t("showAll")}
      </Button>
    </div>
  );

  if (loading) {
    return (
      <section className="mt-10">
        {header}
        <div className="flex h-24 items-center justify-center rounded-lg border bg-card">
          <Spinner className="size-5 text-muted-foreground" />
        </div>
      </section>
    );
  }

  if (sorted.length === 0) {
    return (
      <section className="mt-10">
        {header}
        <Empty className="mt-2">
          <EmptyHeader>
            <EmptyTitle>{t("dayEmpty")}</EmptyTitle>
          </EmptyHeader>
        </Empty>
      </section>
    );
  }

  return (
    <section className="mt-10">
      {header}
      <div className="flex flex-col gap-1.5">
        {sorted.map((ev) => {
          const prefix = eventTimePrefix(ev, locale);
          return (
            <button
              key={ev.uid}
              onClick={() => onSelect(ev)}
              title={ev.summary}
              className="flex items-center gap-3 rounded-lg border bg-card p-2.5 text-left transition-colors hover:bg-muted/50 sm:p-3"
            >
              {/* 时间块 */}
              <div className="flex w-14 shrink-0 items-center justify-center sm:w-16">
                {prefix ? (
                  <span className="text-sm font-semibold tabular-nums">
                    {prefix}
                  </span>
                ) : (
                  <span className="text-xs font-medium text-muted-foreground">
                    {t("allDay")}
                  </span>
                )}
              </div>
              {/* 标题 + 描述 */}
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold">{ev.summary}</p>
                {ev.description && (
                  <p className="truncate text-xs text-muted-foreground">
                    {ev.description}
                  </p>
                )}
              </div>
            </button>
          );
        })}
      </div>
    </section>
  );
}

/** 本月及未来事件详细列表：按月份分组、按时间排序，点击跳转到对应月份 */
function UpcomingEventsList({
  events,
  loading,
  locale,
  onJump,
}: {
  events: ParsedIcsEvent[];
  loading: boolean;
  locale: string;
  onJump: (ev: ParsedIcsEvent) => void;
}) {
  const t = useTranslations("calendar");
  const now = useMemo(() => new Date(), []);

  const groups = useMemo(() => {
    const sorted = [...events].sort((a, b) => {
      const da = eventStartDate(a).getTime();
      const db = eventStartDate(b).getTime();
      return da - db;
    });
    const monthFmt = new Intl.DateTimeFormat(locale, {
      year: "numeric",
      month: "long",
    });
    const groups: {
      key: string;
      label: string;
      events: ParsedIcsEvent[];
    }[] = [];
    for (const ev of sorted) {
      const d = eventStartDate(ev);
      const key = `${d.getFullYear()}-${d.getMonth() + 1}`;
      let g = groups.find((x) => x.key === key);
      if (!g) {
        g = { key, label: monthFmt.format(d), events: [] };
        groups.push(g);
      }
      g.events.push(ev);
    }
    return groups;
  }, [events, locale]);

  const header = (
    <h2 className="mb-3 flex items-center gap-2 text-lg font-semibold tracking-tight">
      <CalendarClockIcon
        data-icon="default"
        className="size-5 text-muted-foreground"
      />
      {t("upcoming")}
      {!loading && events.length > 0 && (
        <span className="text-xs font-normal text-muted-foreground">
          {t("items", { n: events.length })}
        </span>
      )}
    </h2>
  );

  if (loading) {
    return (
      <section className="mt-10">
        {header}
        <div className="flex h-24 items-center justify-center rounded-lg border bg-card">
          <Spinner className="size-5 text-muted-foreground" />
        </div>
      </section>
    );
  }

  if (groups.length === 0) {
    return (
      <section className="mt-10">
        {header}
        <Empty className="mt-2">
          <EmptyHeader>
            <EmptyTitle>{t("upcomingEmpty")}</EmptyTitle>
          </EmptyHeader>
        </Empty>
      </section>
    );
  }

  const dayFmt = new Intl.DateTimeFormat(locale, {
    month: "numeric",
    day: "numeric",
  });
  const weekdayFmt = new Intl.DateTimeFormat(locale, { weekday: "short" });

  return (
    <section className="mt-10">
      {header}
      <div className="flex flex-col gap-5">
        {groups.map((g) => (
          <div key={g.key}>
            <h3 className="mb-2 text-sm font-semibold text-muted-foreground">
              {g.label}
            </h3>
            <div className="flex flex-col gap-1.5">
              {g.events.map((ev) => {
                const d = eventStartDate(ev);
                // 早于当前 6 小时视为已过（当天未到的截止仍算未来）
                const past = d.getTime() < now.getTime() - 6 * 3_600_000;
                const prefix = eventTimePrefix(ev, locale);
                return (
                  <button
                    key={ev.uid}
                    onClick={() => onJump(ev)}
                    title={`${t("jumpTo")}: ${g.label}`}
                    className={`flex items-center gap-2.5 rounded-lg border bg-card p-2.5 text-left transition-colors hover:bg-muted/50 sm:gap-3 sm:p-3 ${
                      past ? "opacity-55" : ""
                    }`}
                  >
                    {/* 日期块：muted 灰底（shadcn 中性） */}
                    <div className="flex w-14 shrink-0 flex-col items-center rounded-lg bg-muted/70 py-1.5 sm:w-16">
                      <span className="text-sm leading-5 font-semibold tabular-nums text-foreground">
                        {dayFmt.format(d)}
                      </span>
                      <span className="text-[10px] font-medium text-muted-foreground">
                        {weekdayFmt.format(d)}
                      </span>
                    </div>
                    {/* 标题 + 描述 */}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold">{ev.summary}</p>
                      {ev.description && (
                        <p className="truncate text-xs text-muted-foreground">
                          {ev.description}
                        </p>
                      )}
                    </div>
                    {/* 时间 */}
                    <div className="shrink-0 text-right">
                      {prefix ? (
                        <p className="text-xs font-semibold tabular-nums text-foreground">
                          {prefix}
                        </p>
                      ) : (
                        <p className="text-xs font-medium text-muted-foreground">
                          {t("allDay")}
                        </p>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

/** 事件详情行（时间 / 描述 / 链接） */
function EventDetails({ event, locale }: { event: ParsedIcsEvent; locale: string }) {
  const t = useTranslations("calendar");

  const timeText = useMemo(() => {
    const fmt = new Intl.DateTimeFormat(locale, {
      dateStyle: "full",
      timeStyle: "short",
    });
    const dayFmt = new Intl.DateTimeFormat(locale, { dateStyle: "full" });

    if (event.allDayDate) {
      // 全天：持续天数
      const [y, m, d] = event.allDayDate.split("-").map(Number);
      const start = new Date(y, m - 1, d);
      const days =
        event.startUtc !== null && event.endUtc !== null
          ? Math.max(1, Math.round((event.endUtc - event.startUtc) / 86_400_000) + 1)
          : 1;
      if (days > 1) {
        const end = new Date(y, m - 1, d + days - 1);
        return `${dayFmt.format(start)} – ${dayFmt.format(end)} · ${t("allDay")}`;
      }
      return `${dayFmt.format(start)} · ${t("allDay")}`;
    }
    if (event.startUtc !== null) {
      const start = new Date(event.startUtc);
      if (event.endUtc !== null && !sameDay(start, new Date(event.endUtc))) {
        return `${dayFmt.format(start)} – ${fmt.format(new Date(event.endUtc))}`;
      }
      if (event.endUtc !== null) {
        const endFmt = new Intl.DateTimeFormat(locale, { timeStyle: "short" });
        return `${fmt.format(start)} – ${endFmt.format(new Date(event.endUtc))}`;
      }
      return fmt.format(start);
    }
    if (event.floatingStart) {
      const [date, time] = event.floatingStart.split("T");
      const [y, m, d] = date.split("-").map(Number);
      const [h, mi] = time.split(":").map(Number);
      const start = new Date(y, m - 1, d, h, mi);
      if (event.floatingEnd) {
        const [ed, et] = event.floatingEnd.split("T");
        const [ey, em, edd] = ed.split("-").map(Number);
        const [eh, emi] = et.split(":").map(Number);
        const end = new Date(ey, em - 1, edd, eh, emi);
        const endFmt = new Intl.DateTimeFormat(locale, { timeStyle: "short" });
        return `${fmt.format(start)} – ${endFmt.format(end)}`;
      }
      return fmt.format(start);
    }
    return "—";
  }, [event, locale, t]);

  return (
    <div className="flex flex-col gap-3 text-sm">
      <div>
        <p className="mb-1 text-xs font-medium text-muted-foreground">{t("time")}</p>
        <p className="whitespace-pre-line">{timeText}</p>
      </div>
      {event.description && (
        <div>
          <p className="mb-1 text-xs font-medium text-muted-foreground">
            {t("descriptionLabel")}
          </p>
          <p className="whitespace-pre-line text-muted-foreground">{event.description}</p>
        </div>
      )}
      {event.url && (
        <div>
          <a
            href={event.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-sm text-primary underline-offset-4 hover:underline"
          >
            <ExternalLinkIcon data-icon="default" className="size-3.5" />
            {t("link")}
          </a>
        </div>
      )}
    </div>
  );
}
