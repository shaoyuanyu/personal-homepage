"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type ReactNode } from "react";
import { useLocale, useTranslations } from "next-intl";
import { enUS as enUSDateFns, zhCN as zhCNDateFns } from "date-fns/locale";
import { enUS as enUSRdp, zhCN as zhCNRdp } from "react-day-picker/locale";
import {
  BellIcon,
  CalendarClockIcon,
  CalendarDaysIcon,
  CameraIcon,
  ClipboardCheckIcon,
  ExternalLinkIcon,
  FileCheckIcon,
  FileTextIcon,
  RefreshCwIcon,
  Trash2Icon,
  TriangleAlertIcon,
} from "lucide-react";
import type { DropdownProps } from "react-day-picker";

import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { CalendarSettings } from "@/components/calendar/calendar-settings";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "@/components/ui/toast";
import { TooltipProvider } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { PREFERENCE_KEYS } from "@/lib/preferences/registry";
import { useOwnerPreferences } from "@/lib/preferences/use-owner-preferences";
import {
  EventCalendar,
  useEventCalendarNavigation,
  type EventCalendarApi,
  type EventCalendarRenderEventProps,
} from "@/components/reui/event-calendar/event-calendar";
import { EventCalendarContent } from "@/components/reui/event-calendar/event-calendar-content";
import type { EventCalendarI18nOverrides } from "@/components/reui/event-calendar/event-calendar-i18n";
import {
  EventCalendarNav,
  EventCalendarNavNext,
  EventCalendarNavPrev,
  EventCalendarToolbar,
} from "@/components/reui/event-calendar/event-calendar-nav";
import type {
  CalendarEvent,
  EventCalendarOccurrence,
  EventCalendarRangeInfo,
  EventCalendarSlotInfo,
} from "@/components/reui/event-calendar/event-calendar-types";
import type { ParsedIcsAppointment } from "@/lib/ical";

/* ---------------- 日期工具（无依赖） ---------------- */

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** 日程 → 本地开始时间 Date（列表排序共用） */
function appointmentStartDate(ev: ParsedIcsAppointment): Date {
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

/** 日程当天的时间前缀（HH:mm，本地）；全天/无时刻返回 null */
function appointmentTimePrefix(ev: ParsedIcsAppointment, locale: string): string | null {
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

/** 日程时间文本（详情 Dialog 与日程 tooltip 共用） */
function formatAppointmentTimeText(
  event: ParsedIcsAppointment,
  locale: string,
  allDayLabel: string,
): string {
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
      return `${dayFmt.format(start)} – ${dayFmt.format(end)} · ${allDayLabel}`;
    }
    return `${dayFmt.format(start)} · ${allDayLabel}`;
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
}

/* ---------------- REUI EventCalendar 日程映射 ---------------- */

/** 会议 DDL 常见节点分类（摘要/全文/注册/Camera-ready/通知；个人日程归 other） */
type DdlCategory =
  | "abstract"
  | "paper"
  | "registration"
  | "camera"
  | "notification"
  | "other";

/** 按 summary 关键词归类；个人日程（无 DDL 节点词）归 other */
function categorizeAppointment(ev: ParsedIcsAppointment): DdlCategory {
  const s = ev.summary.toLowerCase();
  if (/摘要|abstract|submission/.test(s)) return "abstract";
  if (/全文|论文|paper/.test(s)) return "paper";
  if (/注册|registration|register/.test(s)) return "registration";
  if (/camera|相机|ready/.test(s)) return "camera";
  if (/通知|notification|notify/.test(s)) return "notification";
  return "other";
}

/** 类别 → 颜色/图标/标签（badgeClass 为完整类名，避免动态拼接 Tailwind 类） */
const CATEGORY: Record<
  DdlCategory,
  {
    labelKey: string;
    color: string;
    icon: ReactNode;
    badgeClass: string;
  }
> = {
  abstract: {
    labelKey: "catAbstract",
    color: "var(--color-violet-500)",
    icon: <FileTextIcon className="size-3.5" aria-hidden="true" />,
    badgeClass:
      "bg-violet-500/10 text-violet-600 dark:bg-violet-500/15 dark:text-violet-400",
  },
  paper: {
    labelKey: "catPaper",
    color: "var(--color-sky-500)",
    icon: <FileCheckIcon className="size-3.5" aria-hidden="true" />,
    badgeClass: "bg-sky-500/10 text-sky-600 dark:bg-sky-500/15 dark:text-sky-400",
  },
  registration: {
    labelKey: "catRegistration",
    color: "var(--color-amber-500)",
    icon: <ClipboardCheckIcon className="size-3.5" aria-hidden="true" />,
    badgeClass:
      "bg-amber-500/10 text-amber-600 dark:bg-amber-500/15 dark:text-amber-400",
  },
  camera: {
    labelKey: "catCamera",
    color: "var(--color-emerald-500)",
    icon: <CameraIcon className="size-3.5" aria-hidden="true" />,
    badgeClass:
      "bg-emerald-500/10 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-400",
  },
  notification: {
    labelKey: "catNotification",
    color: "var(--color-rose-500)",
    icon: <BellIcon className="size-3.5" aria-hidden="true" />,
    badgeClass: "bg-rose-500/10 text-rose-600 dark:bg-rose-500/15 dark:text-rose-400",
  },
  other: {
    labelKey: "catOther",
    color: "var(--color-primary)",
    icon: <CalendarDaysIcon className="size-3.5" aria-hidden="true" />,
    badgeClass: "bg-primary/10 text-primary dark:bg-primary/15 dark:text-primary",
  },
};

type AppointmentData = { ics: ParsedIcsAppointment; category: DdlCategory };

/** ParsedIcsAppointment → REUI CalendarEvent（全天 = 本地午夜且 end 排他，定时 = 原始时刻） */
function toCalendarAppointment(ev: ParsedIcsAppointment): CalendarEvent<AppointmentData> {
  const category = categorizeAppointment(ev);
  const data: AppointmentData = { ics: ev, category };
  const base = {
    id: ev.uid,
    title: ev.summary,
    color: CATEGORY[category].color,
    data,
  };
  if (ev.allDayDate) {
    // REUI 约定：全天日程的 start/end 必须是显示时区（浏览器本地）的午夜
    const [y, m, d] = ev.allDayDate.split("-").map(Number);
    const days =
      ev.startUtc !== null && ev.endUtc !== null
        ? Math.max(1, Math.round((ev.endUtc - ev.startUtc) / 86_400_000) + 1)
        : 1;
    return {
      ...base,
      start: new Date(y, m - 1, d),
      end: new Date(y, m - 1, d + days),
      allDay: true,
    };
  }
  if (ev.startUtc !== null) {
    const start = new Date(ev.startUtc);
    const end = ev.endUtc !== null ? new Date(ev.endUtc) : start;
    return {
      ...base,
      start,
      // end 排他且须 > start；缺 DTEND 的异常数据兜底为 1 小时
      end: end > start ? end : new Date(start.getTime() + 3_600_000),
    };
  }
  // 浮时（TZID 降级）：按浏览器本地解释
  const parseFloating = (s?: string): Date | null => {
    if (!s) return null;
    const [date, time] = s.split("T");
    const [y, m, d] = date.split("-").map(Number);
    const [h, mi] = time.split(":").map(Number);
    return new Date(y, m - 1, d, h, mi);
  };
  const start = parseFloating(ev.floatingStart) ?? new Date(0);
  const end = parseFloating(ev.floatingEnd) ?? start;
  return {
    ...base,
    start,
    end: end > start ? end : new Date(start.getTime() + 3_600_000),
  };
}

/* ---------------- 主组件 ---------------- */

export function CalendarView() {
  const t = useTranslations("calendar");
  const locale = useLocale();
  // 周起始：统一默认周日（0）；可在「设置」中切换为周一（偏好持久化）
  const { prefs } = useOwnerPreferences();
  const weekStartsOn =
    prefs[PREFERENCE_KEYS.CALENDAR_WEEK_START] === "monday" ? 1 : 0;
  // 网格容器引用：列表点击跳转后瞬时定位到网格顶部
  const gridRef = useRef<HTMLDivElement>(null);
  // REUI EventCalendar 命令式 API（goTo 跳月等）
  const apiRef = useRef<EventCalendarApi<AppointmentData> | null>(null);

  const [appointments, setAppointments] = useState<ParsedIcsAppointment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ParsedIcsAppointment | null>(null);
  // 日程删除：两步确认（首次点击进入确认态，5 秒内再点执行）
  const [deleting, setDeleting] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 聚焦的选中日期；null = 未聚焦（下方显示本月及未来日程总览）
  const [selectedDate, setSelectedDate] = useState<Date | null>(null);
  // 选中日期的当天日程（聚焦时按需加载，双向联动）
  const [dayAppointments, setDayAppointments] = useState<ParsedIcsAppointment[]>([]);
  const [dayAppointmentsLoading, setDayAppointmentsLoading] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const reloadKeyRef = useRef(0);
  // 本月及未来日程列表（网格下方详细列表，独立于当月网格加载）
  const [upcomingAppointments, setUpcomingAppointments] = useState<ParsedIcsAppointment[]>([]);
  const [upcomingAppointmentsLoading, setUpcomingAppointmentsLoading] = useState(true);
  // 当前显示月份（REUI onDateChange 同步；onSlotClick 判断非当月跳月用）
  const [viewDate, setViewDate] = useState<Date>(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });

  // 聚焦某天时：按需加载当天日程（任意日期均准确，API 有 30s 缓存兜底）
  useEffect(() => {
    if (!selectedDate) {
      setDayAppointments([]);
      return;
    }
    let cancelled = false;
    const fmt = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    setDayAppointmentsLoading(true);
    fetch(`/api/calendar?start=${fmt(selectedDate)}&end=${fmt(selectedDate)}&v=${reloadKey}`)
      .then((r) => r.json().catch(() => null))
      .then((data: { events?: ParsedIcsAppointment[] } | null) => {
        if (!cancelled && data?.events) setDayAppointments(data.events);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setDayAppointmentsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedDate, reloadKey]);

  // 加载当前查看月份 1 日 ~ 之后 7 个月末的日程（网格下方列表；刷新按钮联动）
  useEffect(() => {
    let cancelled = false;
    const start = new Date(viewDate.getFullYear(), viewDate.getMonth(), 1);
    const end = new Date(viewDate.getFullYear(), viewDate.getMonth() + 7, 0);
    const fmt = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    setUpcomingAppointmentsLoading(true);
    fetch(`/api/calendar?start=${fmt(start)}&end=${fmt(end)}&v=${reloadKey}`)
      .then((r) => r.json().catch(() => null))
      .then((data: { events?: ParsedIcsAppointment[] } | null) => {
        if (!cancelled && data?.events) setUpcomingAppointments(data.events);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setUpcomingAppointmentsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [reloadKey, viewDate]);

  // 网格加载：REUI onRangeChange 驱动（挂载时自动触发一次 + 翻月时触发）
  const loadRangeAppointments = useCallback(
    async (range: { start: Date; end: Date }) => {
      const fmt = (d: Date) =>
        `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(
          `/api/calendar?start=${fmt(range.start)}&end=${fmt(range.end)}&v=${reloadKeyRef.current}`,
        );
        if (res.status === 503) {
          setError(t("notConfigured"));
          return;
        }
        if (!res.ok) {
          const data = (await res.json().catch(() => null)) as { error?: string } | null;
          setError(data?.error ?? t("loadFailed"));
          return;
        }
        const data = (await res.json()) as { events: ParsedIcsAppointment[] };
        setAppointments(data.events);
      } catch {
        setError(t("loadFailed"));
      } finally {
        setLoading(false);
      }
    },
    [t],
  );

  // 最近一次可见范围（刷新按钮重取网格用；onRangeChange 只在范围变化时触发）
  const lastRangeRef = useRef<{ start: Date; end: Date } | null>(null);
  const handleRangeChange = useCallback(
    (info: EventCalendarRangeInfo) => {
      lastRangeRef.current = { start: info.range.start, end: info.range.end };
      void loadRangeAppointments(info.range);
    },
    [loadRangeAppointments],
  );
  // 网格月份变化（‹ › 翻月 / 标题日期选择器 / 今日 / 本月 / 点击非当月格 / 列表跳转）→
  // 联动列表：翻月时取消聚焦，下方列表回到「本月及未来日程」总览并跟随新 viewDate。
  // 注：REUI 的 goTo/prev/next 同步触发 onDateChange；jumpToToday、JumpDatePicker、
  // 列表 onJump、非当月格聚焦等路径在 goTo 之后仍会同步 setSelectedDate(目标日期)，
  // React 批处理下最后一次调用生效，聚焦不会被这里误清。
  const handleDateChange = useCallback((d: Date) => {
    setViewDate(new Date(d.getFullYear(), d.getMonth(), 1));
    setSelectedDate(null);
  }, []);

  // 点击日期格 → 聚焦该日期；再次点击已聚焦的当月日期 → 取消聚焦；
  // 点击非当月格子 → 自动跳月并聚焦
  const handleSlotClick = useCallback(
    (slot: EventCalendarSlotInfo) => {
      const d = new Date(
        slot.date.getFullYear(),
        slot.date.getMonth(),
        slot.date.getDate(),
      );
      const inMonth =
        d.getFullYear() === viewDate.getFullYear() &&
        d.getMonth() === viewDate.getMonth();
      if (!inMonth) {
        apiRef.current?.goTo(new Date(d.getFullYear(), d.getMonth(), 1));
        setSelectedDate(d);
        return;
      }
      setSelectedDate((cur) => (cur && sameDay(cur, d) ? null : d));
    },
    [viewDate],
  );

  // 日程 chip 点击 → 打开详情 Dialog
  const handleAppointmentClick = useCallback(
    (occurrence: EventCalendarOccurrence<AppointmentData>) => {
      const ics = occurrence.event.data?.ics;
      if (ics) setSelected(ics);
    },
    [],
  );

  // 自定义日程 chip：单行「类别图标 + 标题」（跟随 reui custom event chips 示例），
  // 颜色随类别（--ec-event-color 由 color prop 注入）
  const renderAppointmentChip = useCallback(
    ({ occurrence }: EventCalendarRenderEventProps<AppointmentData>) => {
      const category = occurrence.event.data?.category;
      if (!category) return undefined;
      return (
        <span className="flex w-full min-w-0 items-center gap-1.5">
          <span className="flex shrink-0 text-(--ec-event-color)">
            {CATEGORY[category].icon}
          </span>
          <span className="truncate font-medium">{occurrence.event.title}</span>
        </span>
      );
    },
    [],
  );

  // 日程 hover tooltip：标题 + 类别·时间 + 描述
  const renderTooltip = useCallback(
    ({ occurrence }: { occurrence: { event: CalendarEvent<AppointmentData> } }) => {
      const category = occurrence.event.data?.category;
      const ics = occurrence.event.data?.ics;
      if (!category || !ics) return undefined;
      return (
        <div className="space-y-0.5">
          <p className="font-medium">{occurrence.event.title}</p>
          <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
            <span
              aria-hidden
              className="size-1.5 shrink-0 rounded-full"
              style={{ backgroundColor: CATEGORY[category].color }}
            />
            {t(CATEGORY[category].labelKey)} ·{" "}
            {formatAppointmentTimeText(ics, locale, t("allDay"))}
          </p>
          {ics.description && (
            <p className="text-muted-foreground line-clamp-3 text-xs whitespace-pre-line">
              {ics.description}
            </p>
          )}
        </div>
      );
    },
    [locale, t],
  );

  // 聚焦 = 灰底 + 日号实心圆圈；今日 = 空心圆圈（无 cell 高亮，由
  // todayClassName 去掉内置实底圆/顶部条）。同日叠加时聚焦优先（实心）。
  // ec-day-focused 标记类配合 globals.css 覆盖日号圆圈样式。
  const dayClassName = useCallback(
    (day: Date) => {
      if (!selectedDate) return undefined;
      if (!sameDay(day, selectedDate)) return undefined;
      return "ec-day-focused bg-primary/10";
    },
    [selectedDate],
  );

  // REUI 内置文案/格式覆盖（复用现有翻译 key）
  const ecI18n = useMemo<EventCalendarI18nOverrides>(
    () => ({
      labels: {
        today: t("jumpToday"),
        previous: t("prevMonth"),
        next: t("nextMonth"),
        allDay: t("allDay"),
        more: (n: number) => t("more", { n }),
        goToDate: t("jumpTo"),
        noEvents: t("empty"),
      },
      formats: {
        monthTitle: locale === "zh" ? "yyyy年M月" : "MMMM yyyy",
        dayTitle: locale === "zh" ? "yyyy年M月d日 EEEE" : "EEEE, MMMM d, yyyy",
      },
    }),
    [locale, t],
  );

  // ParsedIcsAppointment[] → REUI CalendarEvent[]（受控 events，fetch 完成后更新）
  const calendarAppointments = useMemo(
    () => appointments.map(toCalendarAppointment),
    [appointments],
  );

  // 回本月并取消聚焦（下方显示本月及未来日程总览）
  const jumpToThisMonth = () => {
    const now = new Date();
    apiRef.current?.goTo(new Date(now.getFullYear(), now.getMonth(), 1));
    setSelectedDate(null);
  };
  // 今日：跳到今天并聚焦（网格聚焦背景 + 下方当天日程联动）
  const jumpToToday = () => {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    apiRef.current?.goTo(today);
    setSelectedDate(today);
  };
  const refresh = () => {
    // 先推进 ref 再取 state，确保重取时 v 参数已是新值（绕过 API 30s 缓存）
    reloadKeyRef.current += 1;
    setReloadKey(reloadKeyRef.current);
    // 网格范围不变时 onRangeChange 不会重发：显式重取最近范围
    if (lastRangeRef.current) void loadRangeAppointments(lastRangeRef.current);
  };

  // 关闭详情/卸载时复位删除确认态并清理定时器
  useEffect(() => {
    return () => {
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
    };
  }, []);
  const resetDeleteState = () => {
    if (confirmTimer.current) clearTimeout(confirmTimer.current);
    setConfirmingDelete(false);
  };

  // 两步确认后从 CalDAV 删除日程；成功关闭详情并刷新（API 侧已清缓存）
  const handleDelete = async () => {
    if (!selected) return;
    if (!confirmingDelete) {
      setConfirmingDelete(true);
      confirmTimer.current = setTimeout(() => setConfirmingDelete(false), 5000);
      return;
    }
    resetDeleteState();
    setDeleting(true);
    try {
      const res = await fetch(
        `/api/calendar/events/${encodeURIComponent(selected.uid)}`,
        { method: "DELETE" },
      );
      if (res.status === 404) {
        // 日程已被其他客户端删除：同样视为成功，刷新即可
      } else if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        toast.add({ title: data?.error ?? t("deleteFailed"), type: "error" });
        return;
      }
      toast.add({ title: t("deleted"), type: "success" });
      setSelected(null);
      refresh();
    } catch {
      toast.add({ title: t("deleteFailed"), type: "error" });
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div>
      {error ? (
        /* 未配置 / 加载失败：错误提示 + 重试 */
        <div className="flex flex-col items-center gap-4 py-16 text-center">
          <TriangleAlertIcon data-icon="default" className="size-8 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">{error}</p>
          <Button variant="outline" size="sm" onClick={refresh}>
            {t("retry")}
          </Button>
        </div>
      ) : (
        <div ref={gridRef} className="scroll-mt-16">
          {/* 卡片式月视图：REUI EventCalendar（custom event chips 示例布局） */}
          <Card className="w-full py-0">
            <CardContent className="p-0">
              <EventCalendar
                events={calendarAppointments}
                defaultView="month"
                views={["month"]}
                weekStartsOn={weekStartsOn}
                locale={locale === "zh" ? zhCNDateFns : enUSDateFns}
                apiRef={apiRef}
                loading={loading}
                renderEvent={renderAppointmentChip}
                renderEventTooltip={renderTooltip}
                eventTooltip={{ side: "top" }}
                // 站主日历为只读展示：关闭拖拽/缩放/拖选创建
                interactions={{ drag: false, resize: false, selectSlot: false }}
                onEventClick={handleAppointmentClick}
                onSlotClick={handleSlotClick}
                onRangeChange={handleRangeChange}
                onDateChange={handleDateChange}
                dayClassName={dayClassName}
                // 今日改为空心圆圈语义：去掉 REUI 内置的实底圆/顶部条高亮
                todayClassName="bg-transparent border-b-transparent"
                maxEventsPerCell={3}
                i18n={ecI18n}
                className="h-[640px] w-full"
              >
                <div className="flex flex-wrap items-center gap-2 pe-2">
                  <EventCalendarNav
                    className="min-w-0 flex-1"
                    showViewSwitcher={false}
                  >
                    <TooltipProvider delay={600} timeout={300}>
                      {/* 左半区：无边框按钮（‹ 年月 › + 本月/今日） */}
                      {/* 年月显示放在 ‹ › 中间；标题即日期选择器入口（选日期 →
                          跳月并聚焦；REUI 内置 DatePicker 仅跳转不聚焦） */}
                      <div className="flex items-center">
                        <EventCalendarNavPrev />
                        <JumpDatePicker onPick={setSelectedDate} weekStartsOn={weekStartsOn} />
                        <EventCalendarNavNext />
                      </div>
                      <div className="flex items-center gap-0.5">
                        <Button variant="ghost" size="sm" onClick={jumpToThisMonth}>
                          {t("jumpThisMonth")}
                        </Button>
                        <Button variant="ghost" size="sm" onClick={jumpToToday}>
                          {t("jumpToday")}
                        </Button>
                      </div>
                      <div className="grow" />
                    </TooltipProvider>
                  </EventCalendarNav>
                  {/* 右半区：带边框按钮 */}
                  <EventCalendarToolbar>
                    <Button variant="outline" size="sm" onClick={refresh} aria-label={t("refresh")}>
                      <RefreshCwIcon data-icon="default" className={loading ? "animate-spin" : ""} />
                      <span className="hidden sm:inline">{t("refresh")}</span>
                    </Button>
                    {/* CalDAV 凭证设置：保存/清除后自动用新凭证刷新日历 */}
                    <CalendarSettings onSaved={refresh} />
                  </EventCalendarToolbar>
                </div>
                <EventCalendarContent />
              </EventCalendar>
              {/* 颜色指示器：标明各日程颜色对应的语义（类别图例） */}
              <div className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-2 border-t px-4 py-3 text-xs">
                {(Object.keys(CATEGORY) as DdlCategory[]).map((key) => (
                  <span key={key} className="flex items-center gap-1.5">
                    <span
                      aria-hidden
                      className="size-2 rounded-full"
                      style={{ backgroundColor: CATEGORY[key].color }}
                    />
                    {t(CATEGORY[key].labelKey)}
                  </span>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* 双向联动：聚焦某天 → 显示当天日程；未聚焦 → 显示本月及未来日程总览 */}
      {selectedDate ? (
        <DayAppointmentsList
          date={selectedDate}
          events={dayAppointments}
          loading={dayAppointmentsLoading}
          locale={locale}
          onSelect={setSelected}
          onClear={() => setSelectedDate(null)}
        />
      ) : (
        <UpcomingAppointmentsList
          events={upcomingAppointments}
          loading={upcomingAppointmentsLoading}
          locale={locale}
          viewDate={viewDate}
          onJump={(ev) => {
            const d = appointmentStartDate(ev);
            apiRef.current?.goTo(new Date(d.getFullYear(), d.getMonth(), 1));
            setSelectedDate(new Date(d.getFullYear(), d.getMonth(), d.getDate()));
            // 瞬时定位到网格顶部（scroll-mt 避开 sticky header），避免平滑滚动动画的抽动感
            gridRef.current?.scrollIntoView({ behavior: "auto", block: "start" });
          }}
        />
      )}

      {/* 日程详情 Dialog */}
      <Dialog
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open) {
            resetDeleteState();
            setSelected(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {selected && (
                <span
                  aria-hidden
                  className="size-2.5 shrink-0 rounded-full"
                  style={{
                    backgroundColor: CATEGORY[categorizeAppointment(selected)].color,
                  }}
                />
              )}
              <span className="truncate">{selected?.summary ?? ""}</span>
            </DialogTitle>
            <DialogDescription className="sr-only">
              {selected?.summary ?? ""}
            </DialogDescription>
          </DialogHeader>
          {selected && (
            <AppointmentDetails event={selected} locale={locale} />
          )}
          <DialogFooter className="sm:justify-between">
            <Button
              variant={confirmingDelete ? "destructive" : "outline"}
              onClick={handleDelete}
              disabled={deleting}
            >
              {deleting ? (
                <Spinner className="size-4" />
              ) : (
                <Trash2Icon data-icon="default" className="size-4" />
              )}
              {deleting
                ? t("deleting")
                : confirmingDelete
                  ? t("deleteConfirm")
                  : t("deleteAppointment")}
            </Button>
            <Button variant="outline" onClick={() => setSelected(null)}>
              {t("close")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** 跳转日期选择器：月份标题即入口（点击弹出 rdp 日历，选日期 → 跳月并聚焦当天） */
function JumpDatePicker({
  onPick,
  weekStartsOn,
}: {
  onPick: (d: Date) => void;
  weekStartsOn: 0 | 1;
}) {
  const { title, date, goTo } = useEventCalendarNavigation();
  const t = useTranslations("calendar");
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  // 本地时区（rdp timeZone prop，避免 SSR 不一致）
  const [timeZone, setTimeZone] = useState<string | undefined>(undefined);
  const [month, setMonth] = useState<Date>(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });

  useEffect(() => {
    setTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
  }, []);

  // 打开面板时同步到当前显示月（标题可能已被 ‹ › / 今日翻走）
  useEffect(() => {
    if (open) setMonth(new Date(date.getFullYear(), date.getMonth(), 1));
  }, [open, date]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            className="min-w-0 px-1.5 text-base font-semibold tracking-tight"
            aria-label={t("jumpTo")}
          />
        }
      >
        {title}
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0!">
        <Calendar
          mode="single"
          onSelect={(d) => {
            if (!d) return;
            goTo(d);
            onPick(new Date(d.getFullYear(), d.getMonth(), d.getDate()));
            setOpen(false);
          }}
          month={month}
          onMonthChange={setMonth}
          captionLayout="dropdown"
          startMonth={new Date(new Date().getFullYear() - 3, 0, 1)}
          endMonth={new Date(new Date().getFullYear() + 7, 11, 31)}
          locale={locale === "zh" ? zhCNRdp : enUSRdp}
          weekStartsOn={weekStartsOn}
          timeZone={timeZone}
          // 月份/年份下拉用 Base UI Select（shadcn 样式），替代原生 select
          components={{ Dropdown: CalendarDropdown }}
          className="rounded-lg"
        />
      </PopoverContent>
    </Popover>
  );
}

/**
 * rdp v10 的月份/年份下拉：用 Base UI Select 渲染（shadcn 样式），
 * 替代原生 <select>。rdp 通过 options 传选项、onChange 读 target.value。
 */
function CalendarDropdown({
  options,
  value,
  onChange,
  "aria-label": ariaLabel,
}: DropdownProps) {
  const items = options ?? [];
  // Base UI 的 label 自动解析在 popover 内不可靠（会回退显示 value），
  // 显式取选中项 label 传给 SelectValue
  const selectedLabel =
    items.find((o) => String(o.value) === String(value))?.label ?? "";
  return (
    <Select
      value={value !== undefined ? String(value) : undefined}
      onValueChange={(v) => {
        // 复刻原生 select 的 onChange 事件（rdp 只读 target.value）
        onChange?.({
          target: { value: String(v) },
        } as ChangeEvent<HTMLSelectElement>);
      }}
    >
      {/* 原生 select 的其他属性（size/name/事件处理器等）与 Base UI
          SelectTrigger（button）不兼容，只保留 aria-label。
          relative z-10：rdp 的 Nav（absolute）先渲染会盖住下拉触发按钮 */}
      <SelectTrigger
        size="sm"
        aria-label={ariaLabel}
        className="relative z-10 h-7 rounded-(--cell-radius) px-2 text-sm"
      >
        <SelectValue>{selectedLabel}</SelectValue>
      </SelectTrigger>
      <SelectContent className="min-w-24">
        {items.map((opt) => (
          <SelectItem
            key={opt.value}
            value={String(opt.value)}
            disabled={opt.disabled}
          >
            {opt.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** 日程类别彩色标签（列表视图用：彩色小徽章，避免整行染色） */
function CategoryBadge({ category }: { category: DdlCategory }) {
  const t = useTranslations("calendar");
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-px text-[10px] font-semibold",
        CATEGORY[category].badgeClass,
      )}
    >
      {CATEGORY[category].icon}
      {t(CATEGORY[category].labelKey)}
    </span>
  );
}

/** 聚焦某天的当天日程列表：按时间排序，可点击打开详情，「显示全部」返回总览 */
function DayAppointmentsList({
  date,
  events,
  loading,
  locale,
  onSelect,
  onClear,
}: {
  date: Date;
  events: ParsedIcsAppointment[];
  loading: boolean;
  locale: string;
  onSelect: (ev: ParsedIcsAppointment) => void;
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
        (a, b) => appointmentStartDate(a).getTime() - appointmentStartDate(b).getTime(),
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
          const prefix = appointmentTimePrefix(ev, locale);
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
              {/* 类别标签 + 标题 + 描述 */}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <CategoryBadge category={categorizeAppointment(ev)} />
                  <p className="truncate text-sm font-semibold">{ev.summary}</p>
                </div>
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

/** 当前查看月份及之后的日程详细列表：按月份分组、按时间排序，点击跳转到对应月份 */
function UpcomingAppointmentsList({
  events,
  loading,
  locale,
  viewDate,
  onJump,
}: {
  events: ParsedIcsAppointment[];
  loading: boolean;
  locale: string;
  viewDate: Date;
  onJump: (ev: ParsedIcsAppointment) => void;
}) {
  const t = useTranslations("calendar");
  const now = useMemo(() => new Date(), []);
  const viewMonthKey = `${viewDate.getFullYear()}-${viewDate.getMonth() + 1}`;

  const groups = useMemo(() => {
    const sorted = [...events].sort((a, b) => {
      const da = appointmentStartDate(a).getTime();
      const db = appointmentStartDate(b).getTime();
      return da - db;
    });
    const monthFmt = new Intl.DateTimeFormat(locale, {
      year: "numeric",
      month: "long",
    });
    const groups: {
      key: string;
      label: string;
      events: ParsedIcsAppointment[];
    }[] = [];
    for (const ev of sorted) {
      const d = appointmentStartDate(ev);
      const key = `${d.getFullYear()}-${d.getMonth() + 1}`;
      let g = groups.find((x) => x.key === key);
      if (!g) {
        g = { key, label: monthFmt.format(d), events: [] };
        groups.push(g);
      }
      g.events.push(ev);
    }
    // 当前查看月份分组始终保留：无日程时在列表内显示「本月暂无日程」占位
    if (!groups.some((g) => g.key === viewMonthKey)) {
      groups.unshift({
        key: viewMonthKey,
        label: monthFmt.format(viewDate),
        events: [],
      });
    }
    return groups;
  }, [events, locale, viewMonthKey, viewDate]);

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

  if (events.length === 0) {
    return (
      <section className="mt-10">
        {header}
        <Empty className="mt-2">
          <EmptyHeader>
            <EmptyTitle>{t("upcomingEmpty")}</EmptyTitle>
            <EmptyDescription>{t("emptyHint")}</EmptyDescription>
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
            {g.events.length === 0 ? (
              <div className="flex h-16 items-center justify-center rounded-lg border border-dashed bg-card/50 text-sm text-muted-foreground">
                {t("empty")}
              </div>
            ) : (
              <div className="flex flex-col gap-1.5">
                {g.events.map((ev) => {
                  const d = appointmentStartDate(ev);
                  // 早于当前 6 小时视为已过（当天未到的截止仍算未来）
                  const past = d.getTime() < now.getTime() - 6 * 3_600_000;
                  const prefix = appointmentTimePrefix(ev, locale);
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
                      {/* 类别标签 + 标题 + 描述 */}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <CategoryBadge category={categorizeAppointment(ev)} />
                          <p className="truncate text-sm font-semibold">{ev.summary}</p>
                        </div>
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
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

/** 日程详情行（时间 / 描述 / 链接） */
function AppointmentDetails({ event, locale }: { event: ParsedIcsAppointment; locale: string }) {
  const t = useTranslations("calendar");

  const timeText = formatAppointmentTimeText(event, locale, t("allDay"));

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
