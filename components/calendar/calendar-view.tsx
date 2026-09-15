"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ChangeEvent, type CSSProperties, type ReactNode } from "react";
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
  FilePenLineIcon,
  PencilIcon,
  PlusIcon,
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
import { Textarea } from "@/components/ui/textarea";
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
import {
  conferenceRoundFullLabel,
  conferenceRoundLabel,
  matchedConferenceNode,
  NODE_TIME_TOLERANCE_MS,
  type ParsedIcsAppointment,
} from "@/lib/ical";

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

/**
 * 列表第二行内容：优先结构化字段「地点 · 会期」（本站写入的会议事件），
 * 否则回退描述首行（个人日程的单行描述；旧格式会议事件则是会议全称）。
 * 始终只取单行——多行描述若直接整段塞进列表（nowrap）会被压成一长条再截断。
 */
function appointmentSecondaryLine(ev: ParsedIcsAppointment): string | null {
  const structured = [ev.location, ev.confDates]
    .filter((s): s is string => Boolean(s))
    .join(" · ");
  if (structured) return structured;
  return ev.description?.split(/\r?\n/)[0]?.trim() || null;
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

/** CATEGORIES 属性值（语言中立）→ DdlCategory */
const CATEGORY_BY_KEY: Record<string, DdlCategory> = {
  abstract: "abstract",
  paper: "paper",
  registration: "registration",
  camera: "camera",
  notification: "notification",
};

/**
 * 按 CATEGORIES 属性（新写入事件，标题语言中立，分类权威）归类；
 * 缺失时回退 summary 关键词（兼容旧数据——旧标题如 "ASPLOS 2027 全文" 嵌入过界面语言词）。
 * 个人日程（无 DDL 节点词）归 other。
 */
function categorizeAppointment(ev: ParsedIcsAppointment): DdlCategory {
  for (const c of ev.categories ?? []) {
    const cat = CATEGORY_BY_KEY[c.trim().toLowerCase()];
    if (cat) return cat;
  }
  const s = ev.summary.toLowerCase();
  if (/摘要|abstract|submission/.test(s)) return "abstract";
  if (/全文|论文|paper/.test(s)) return "paper";
  if (/注册|registration|register/.test(s)) return "registration";
  if (/camera|相机|ready/.test(s)) return "camera";
  if (/通知|notification|notify/.test(s)) return "notification";
  return "other";
}

/** 类别 → 颜色/图标/标签（badgeClass 为完整类名，避免动态拼接 Tailwind 类）
 *
 * ⚠ badgeClass 的浅色方案与 `lib/design/grade.ts` 同一套：实色 50 号底 + 700 号字。
 *   曾用 `bg-*-500/10 text-*-600`，浅色下只有 ~4.0:1（未达 AA），且半透明底叠在灰底上会变脏。
 */
const CATEGORY: Record<
  DdlCategory,
  {
    labelKey: string;
    color: string;
    /** 标题里节点名的文字色（与徽章同一套 700/400 token；勿用 500 号——浅色底上不足 AA） */
    textClass: string;
    icon: ReactNode;
    badgeClass: string;
    /** 时间线上**轴线大圆节点**的样式（类别淡底 + 描边 + 图标色，与 badgeClass 同一套 token） */
    dotClass: string;
  }
> = {
  abstract: {
    labelKey: "catAbstract",
    color: "var(--color-violet-500)",
    textClass: "text-violet-700 dark:text-violet-400",
    // ⚠ 图标会在轴线圆内**单独**出现（列窄时名称隐藏），而 `FileText` 与 `FileCheck`
    //   在 14px 下的轮廓几乎不可分（偏偏这两个最常用）→ 「摘要」用「文件 + 笔」。
    //   ⚠ 不用纯 `Pencil`：本弹窗内它已是「编辑备注」按钮的图标（`t("noteEdit")`），会撞车。
    icon: <FilePenLineIcon className="size-3.5" aria-hidden="true" />,
    badgeClass:
      "bg-violet-50 text-violet-700 dark:bg-violet-500/15 dark:text-violet-400",
    dotClass:
      "border-violet-600 bg-violet-600 text-white dark:border-violet-500 dark:bg-violet-500 dark:text-violet-950",
  },
  paper: {
    labelKey: "catPaper",
    color: "var(--color-sky-500)",
    textClass: "text-sky-700 dark:text-sky-400",
    icon: <FileCheckIcon className="size-3.5" aria-hidden="true" />,
    badgeClass: "bg-sky-50 text-sky-700 dark:bg-sky-500/15 dark:text-sky-400",
    dotClass:
      "border-sky-600 bg-sky-600 text-white dark:border-sky-500 dark:bg-sky-500 dark:text-sky-950",
  },
  registration: {
    labelKey: "catRegistration",
    color: "var(--color-amber-500)",
    textClass: "text-amber-700 dark:text-amber-400",
    icon: <ClipboardCheckIcon className="size-3.5" aria-hidden="true" />,
    badgeClass:
      "bg-amber-50 text-amber-700 dark:bg-amber-500/15 dark:text-amber-400",
    dotClass:
      "border-amber-600 bg-amber-600 text-white dark:border-amber-500 dark:bg-amber-500 dark:text-amber-950",
  },
  camera: {
    labelKey: "catCamera",
    color: "var(--color-emerald-500)",
    textClass: "text-emerald-700 dark:text-emerald-400",
    icon: <CameraIcon className="size-3.5" aria-hidden="true" />,
    badgeClass:
      "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-400",
    dotClass:
      "border-emerald-600 bg-emerald-600 text-white dark:border-emerald-500 dark:bg-emerald-500 dark:text-emerald-950",
  },
  notification: {
    labelKey: "catNotification",
    color: "var(--color-rose-500)",
    textClass: "text-rose-700 dark:text-rose-400",
    icon: <BellIcon className="size-3.5" aria-hidden="true" />,
    badgeClass: "bg-rose-50 text-rose-700 dark:bg-rose-500/15 dark:text-rose-400",
    dotClass:
      "border-rose-600 bg-rose-600 text-white dark:border-rose-500 dark:bg-rose-500 dark:text-rose-950",
  },
  other: {
    labelKey: "catOther",
    color: "var(--color-primary)",
    textClass: "text-primary",
    icon: <CalendarDaysIcon className="size-3.5" aria-hidden="true" />,
    badgeClass: "bg-primary/10 text-primary dark:bg-primary/15 dark:text-primary",
    dotClass:
      "border-primary bg-primary text-primary-foreground dark:border-primary dark:bg-primary dark:text-primary-foreground",
  },
};

type AppointmentData = { ics: ParsedIcsAppointment; category: DdlCategory };

/** 是否为投稿节点事件（CATEGORIES 命中已知节点词；个人日程无此标记，第三方日历也不会有） */
function isDeadlineNode(ev: ParsedIcsAppointment): boolean {
  return (ev.categories ?? []).some(
    (c) => c.trim().toLowerCase() in CATEGORY_BY_KEY,
  );
}

/**
 * 洁净标题：本站写入的会议事件用 X-CONF-TITLE（含缩写与年份，不含节点词），其余用 SUMMARY。
 * 列表已用类别徽章表意，故不重复拼接节点词。
 */
function appointmentBaseTitle(ev: ParsedIcsAppointment): string {
  return ev.confTitle || ev.summary;
}

/**
 * 详情弹窗副标题 = 「会议全称 + 届别年份」（如 "… Applications 2026"）。
 * 年份不能省：会议每届一个域名（adma2026.github.io），链接却只有全称就无法辨明是哪一届。
 * 名称题录年份取 `X-CONF-TITLE`（缩写 年份），缺时回退事件年份；名称里已带年份则不再拼。
 * 旧格式事件没有 `X-CONF-NAME`，此时回退描述首行（旧描述首行就是全称）。
 */
function appointmentConfName(ev: ParsedIcsAppointment): string | undefined {
  if (!isDeadlineNode(ev)) return undefined;
  const name = ev.confName || ev.description?.split(/\r?\n/)[0]?.trim();
  if (!name) return undefined;
  if (/(?:19|20)\d{2}$/.test(name.trim())) return name;
  const year =
    ev.confTitle?.match(/(\d{4})\s*$/)?.[1] ??
    String(new Date(appointmentStartDate(ev)).getFullYear());
  return `${name} ${year}`;
}

/**
 * 用户备注 = `DESCRIPTION`（各客户端把它当「备注/描述」框，双向可编辑）。
 * 旧格式节点事件还没迁移（无 X-CONF-NAME）时，描述里存的仍是会议全称，不当作备注。
 */
function appointmentNote(ev: ParsedIcsAppointment): string | undefined {
  if (isDeadlineNode(ev) && !ev.confName) return undefined;
  return ev.description?.trim() || undefined;
}

/**
 * 展示标题：投稿节点事件 = 「洁净标题 · 轮次 节点名」（如 "ADMA 2026 · Poster 全文"）。
 * 事件身份是「某会议的某节点截止提醒」而非会议本体——标题不带节点时，与「截止时间/会议地点」
 * 并置会被误读成「会议于此时此地举办」（语义割裂）。第三方事件（无 CATEGORIES）原样显示。
 * ⚠ 轮次名（Poster / Encore 等）必须有：同一届同一天可能有多条节点日程、且类型相同
 *   （都是「全文」），不带轮次时它们在月视图 tooltip / 列表里长得一模一样。
 */
function appointmentDisplayTitle(
  ev: ParsedIcsAppointment,
  t: (key: string) => string,
): string {
  const base = appointmentBaseTitle(ev);
  if (!isDeadlineNode(ev)) return base;
  const cat = t(CATEGORY[categorizeAppointment(ev)].labelKey);
  const round = conferenceRoundLabel(matchedConferenceNode(ev));
  return `${base} · ${round ? `${round} ${cat}` : cat}`;
}

/** ParsedIcsAppointment → REUI CalendarEvent（全天 = 本地午夜且 end 排他，定时 = 原始时刻） */
function toCalendarAppointment(ev: ParsedIcsAppointment): CalendarEvent<AppointmentData> {
  const category = categorizeAppointment(ev);
  const data: AppointmentData = { ics: ev, category };
  const base = {
    id: ev.uid,
    // 月视图 chip 保持紧凑：只给洁净标题（节点由图标的颜色/形状 + tooltip 表意）
    title: appointmentBaseTitle(ev),
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
  // 网格月份变化（‹ › 翻月 / 标题日期选择器 / 今日 / 本月 / 点击非当月格）→
  // 联动列表：翻月时取消聚焦，下方列表回到「本月及未来日程」总览并跟随新 viewDate。
  // 注：REUI 的 goTo/prev/next 同步触发 onDateChange；jumpToToday、JumpDatePicker、
  // 非当月格聚焦等路径在 goTo 之后仍会同步 setSelectedDate(目标日期)，
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

  // 「+N 更多」触发器内容：手机端格子只有约 50px 宽，完整文案（「还有 3 个」）
  // 会被截断成「还有 3…」→ 窄屏改用「+N」。可访问名不受影响：REUI 会在消费方
  // 自定义触发器内容时用 labels.more(count) 补一个 aria-label
  // （见 event-calendar-month-view.tsx），故两种宽度下读屏结果一致。
  const renderMoreIndicator = useCallback(
    ({ count }: { count: number }) => (
      <>
        <span className="max-sm:hidden">{t("more", { n: count })}</span>
        <span className="hidden max-sm:inline">+{count}</span>
      </>
    ),
    [t],
  );

  // 日程 hover tooltip：标题 + 类别·时间 + 会议全称 + 备注
  const renderTooltip = useCallback(
    ({ occurrence }: { occurrence: { event: CalendarEvent<AppointmentData> } }) => {
      const category = occurrence.event.data?.category;
      const ics = occurrence.event.data?.ics;
      if (!category || !ics) return undefined;
      const subtitle = appointmentConfName(ics) ?? "";
      const note = appointmentNote(ics);
      return (
        <div className="space-y-0.5">
          <p className="font-medium">{appointmentDisplayTitle(ics, t)}</p>
          <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
            <span
              aria-hidden
              className="size-1.5 shrink-0 rounded-full"
              style={{ backgroundColor: CATEGORY[category].color }}
            />
            {t(CATEGORY[category].labelKey)} ·{" "}
            {formatAppointmentTimeText(ics, locale, t("allDay"))}
          </p>
          {subtitle && (
            <p className="text-muted-foreground line-clamp-2 text-xs">{subtitle}</p>
          )}
          {note && (
            <p className="text-muted-foreground line-clamp-3 text-xs whitespace-pre-line">
              {note}
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

  // 弹窗时间线节点的跳转候选：网格 / 当天 / 未来列表三类已加载事件（同届其它节点
  // 可能落在任一列表里；两本日历可能含同一 UID，按 uid 去重）
  const timelineCandidates = useMemo(() => {
    const map = new Map<string, ParsedIcsAppointment>();
    for (const ev of [...appointments, ...dayAppointments, ...upcomingAppointments]) {
      map.set(ev.uid, ev);
    }
    return [...map.values()];
  }, [appointments, dayAppointments, upcomingAppointments]);

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
        <div>
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
                renderMoreIndicator={renderMoreIndicator}
                // 手机端把格子内容改成横向流式（一排圆点）：globals.css 的
                // `.calendar-month-cell-content` 窄屏规则挂在 REUI 提供的这个
                // 类名钩子上（内容容器本身没有 data-slot）
                classNames={{ monthCellContent: "calendar-month-cell-content" }}
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
                // 手机端压缩高度（桌面 h-[640px] 不变）：窄屏格子只放圆点（8px）
                // 不再有标题行，6 行月历用不着 640px；31rem（格高约 64px）刚好装下
                // 「跨天条车道 18px + 圆点行 8px + 「+N」行 16px」中最紧的组合，
                // 且让「月视图 + 下方日程列表」在手机上一屏内同现
                className="h-[31rem] w-full sm:h-[640px]"
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
              {/* 颜色指示器：标明各日程颜色对应的语义（类别图例）
                  颜色走 CSS 变量（而非内联 backgroundColor）：窄屏下网格里的
                  日程是圆点、圆点需要压深一档才达 3:1，图例必须跟着同色，
                  否则「颜色 = 类别」这条索引就对不上了（见 globals.css） */}
              <div className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-2 border-t px-4 py-3 text-xs">
                {(Object.keys(CATEGORY) as DdlCategory[]).map((key) => (
                  <span key={key} className="flex items-center gap-1.5">
                    <span
                      aria-hidden
                      data-slot="calendar-legend-dot"
                      className="size-2 rounded-full"
                      style={
                        {
                          "--legend-color": CATEGORY[key].color,
                        } as CSSProperties
                      }
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
          onSelect={setSelected}
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
        {/* 宽度两档（`min()` 自带"视口 − 2rem"边距，窄屏不会贴边）：
            窄屏 `32rem`(512px) —— 时间线**全宽竖向**（行宽 ≈ 内容宽，与节点数无关）；
            宽屏（lg）`48rem`(768px) —— 才能**左右分栏**（左栏 356px、右栏时间线 320px）。
            ⚠ `min(...)` 自带边距，两个宽度类都必须带 `!`（important）：`DialogContent`
               基础类里的 `sm:max-w-sm`(384) 是**变体类**，会压过无变体的 `max-w-*`
               —— 实测不加 `!` 时 900px 视口下弹窗被顶成 384px（CLAUDE.md 记过这个坑）。
               `lg:` 变体排在无变体之后，所以宽屏仍取 48rem。 */}
        <DialogContent className="max-h-[85vh] overflow-y-auto max-w-[min(calc(100%-2rem),32rem)]! lg:max-w-[min(calc(100%-2rem),48rem)]!">
          {/* 左缘类别色条：一眼区分摘要/全文/…（与 /venues 会议卡同一视觉语言） */}
          {selected && (
            <span
              aria-hidden
              className="absolute inset-y-0 left-0 w-1"
              style={{
                backgroundColor: CATEGORY[categorizeAppointment(selected)].color,
              }}
            />
          )}
          <DialogHeader>
            <DialogTitle className="truncate leading-snug">
              {selected ? <AppointmentDialogTitle event={selected} /> : ""}
            </DialogTitle>
            <DialogDescription
              className={selected && appointmentConfName(selected) ? undefined : "sr-only"}
            >
              {selected && <AppointmentSubtitle event={selected} />}
            </DialogDescription>
          </DialogHeader>
          {selected && (
            /* 主体两档（用户指定）：窄屏 = 上下堆叠（时间线全宽竖向，行宽 ≈ 内容宽）；
               宽屏（lg）= 左右分栏——左栏信息/备注、右栏时间线。分栏后弹窗加宽到 3xl，
               左栏 356px 不比窄屏时更挤，右栏时间线行宽 320px 足够放下完整轮次备注。
               ⚠ 用同一套 DOM + CSS 切换，不做两套组件。 */
            <div className="grid min-w-0 grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
              <div className="flex min-w-0 flex-col gap-4">
                <AppointmentDetails event={selected} locale={locale} />
                <AppointmentNote
                  event={selected}
                  onSaved={(note) => {
                    // 本地先更新（弹窗立即显示新备注），再刷新列表/网格
                    setSelected((prev) =>
                      prev ? { ...prev, description: note || undefined } : prev,
                    );
                    refresh();
                  }}
                />
              </div>
              <div className="min-w-0">
                <AppointmentTimeline
                  event={selected}
                  locale={locale}
                  candidates={timelineCandidates}
                  onJump={(target) => {
                    // 切换到那条节点日程（弹窗原地换内容；网格不动，保持浏览位置）
                    resetDeleteState();
                    setSelected(target);
                  }}
                />
              </div>
            </div>
          )}
          {/* 底部**不放**「关闭」按钮：右上角 X（`DialogContent` 默认渲染的
              `[data-slot=dialog-close]`）已是全站统一的关闭入口，再放一个只是重复的
              可聚焦元素（用户指定）。`sm:justify-start` 让唯一的（破坏性）删除按钮
              留在左侧，避开「主操作位」以防误点。 */}
          <DialogFooter className="sm:justify-start">
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
function CategoryBadge({
  category,
  round,
}: {
  category: DdlCategory;
  /** 轮次短标签（如 "Poster"）：同日同类型的多条日程靠它区分 */
  round?: string | null;
}) {
  const t = useTranslations("calendar");
  return (
    <span
      // `max-w-full` + 内部 `truncate`：轮次名可能很长（如 "September Cycle Submission
      // Deadline"），窄屏下必须能截断而不是撑破行
      className={cn(
        "inline-flex max-w-full min-w-0 shrink-0 items-center gap-1 rounded-full px-1.5 py-px text-xs font-semibold",
        CATEGORY[category].badgeClass,
      )}
    >
      {CATEGORY[category].icon}
      <span className="truncate">
        {round
          ? `${round} ${t(CATEGORY[category].labelKey)}`
          : t(CATEGORY[category].labelKey)}
      </span>
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
          const secondary = appointmentSecondaryLine(ev);
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
                  <span className="font-mono text-sm font-semibold">
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
                  <CategoryBadge category={categorizeAppointment(ev)} round={conferenceRoundLabel(matchedConferenceNode(ev))} />
                  <p className="truncate text-sm font-semibold">{appointmentBaseTitle(ev)}</p>
                </div>
                {secondary && (
                  <p className="truncate text-xs text-muted-foreground">
                    {secondary}
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

/** 当前查看月份及之后的日程详细列表：按月份分组、按时间排序，点击打开日程详情弹窗 */
function UpcomingAppointmentsList({
  events,
  loading,
  locale,
  viewDate,
  onSelect,
}: {
  events: ParsedIcsAppointment[];
  loading: boolean;
  locale: string;
  viewDate: Date;
  onSelect: (ev: ParsedIcsAppointment) => void;
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
        <div className="flex h-24 items-center justify-center gap-2 rounded-lg border bg-card text-sm text-muted-foreground">
          <Spinner className="size-5" label={t("loadingAppointments")} />
          {t("loadingAppointments")}
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
                  const secondary = appointmentSecondaryLine(ev);
                  return (
                    <button
                      key={ev.uid}
                      onClick={() => onSelect(ev)}
                      title={ev.summary}
                      className={`flex items-center gap-2.5 rounded-lg border bg-card p-2.5 text-left transition-colors hover:bg-muted/50 sm:gap-3 sm:p-3 ${
                        past ? "opacity-55" : ""
                      }`}
                    >
                      {/* 日期块：muted 灰底（shadcn 中性） */}
                      <div className="flex w-14 shrink-0 flex-col items-center rounded-lg bg-muted/70 py-1.5 sm:w-16">
                        <span className="font-mono text-sm leading-5 font-semibold text-foreground">
                          {dayFmt.format(d)}
                        </span>
                        <span className="text-xs font-medium text-muted-foreground">
                          {weekdayFmt.format(d)}
                        </span>
                      </div>
                      {/* 类别标签 + 标题 + 描述 */}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <CategoryBadge category={categorizeAppointment(ev)} round={conferenceRoundLabel(matchedConferenceNode(ev))} />
                          <p className="truncate text-sm font-semibold">{appointmentBaseTitle(ev)}</p>
                        </div>
                        {secondary && (
                          <p className="truncate text-xs text-muted-foreground">
                            {secondary}
                          </p>
                        )}
                      </div>
                      {/* 时间 */}
                      <div className="shrink-0 text-right">
                        {prefix ? (
                          <p className="font-mono text-xs font-semibold text-foreground">
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

/**
 * 详情弹窗标题：洁净标题 + **类别色**节点名（如 `NSDI 2027` + 紫色「摘要」）。
 * 个人日程没有节点，原样显示。
 */
function AppointmentDialogTitle({ event }: { event: ParsedIcsAppointment }) {
  const t = useTranslations("calendar");
  if (!isDeadlineNode(event)) return <>{appointmentBaseTitle(event)}</>;
  const category = categorizeAppointment(event);
  const round = conferenceRoundLabel(matchedConferenceNode(event));
  return (
    <>
      {appointmentBaseTitle(event)}
      <span className="text-muted-foreground"> · </span>
      <span className={CATEGORY[category].textClass}>
        {round
          ? `${round} ${t(CATEGORY[category].labelKey)}`
          : t(CATEGORY[category].labelKey)}
      </span>
    </>
  );
}

/**
 * 事件备注（可编辑）：存进事件自身的标准 `COMMENT` 属性——随事件同步（不会被「重新添加」
 * 抹掉，见 caldav 写入路由的备注继承）、删事件即删备注，无需另一份存储。
 */
function AppointmentNote({
  event,
  onSaved,
}: {
  event: ParsedIcsAppointment;
  onSaved: (note: string) => void;
}) {
  const t = useTranslations("calendar");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(appointmentNote(event) ?? "");
  const [saving, setSaving] = useState(false);
  const currentNote = appointmentNote(event);

  // 切换事件（弹窗内换日程）时复位草稿/编辑态
  useEffect(() => {
    setEditing(false);
    setDraft(appointmentNote(event) ?? "");
  }, [event]);

  const save = async () => {
    setSaving(true);
    try {
      const res = await fetch(
        `/api/calendar/events/${encodeURIComponent(event.uid)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ note: draft.trim() }),
        },
      );
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
      onSaved(draft.trim());
      setEditing(false);
      toast.add({ title: t("noteSaved"), type: "success" });
    } catch (err) {
      console.error("[calendar] 备注保存失败", err);
      toast.add({
        title: t("noteSaveFailed"),
        description: err instanceof Error ? err.message : String(err),
        type: "error",
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="text-sm">
      <div className="mb-1 flex items-center gap-1">
        <p className="text-xs font-medium text-muted-foreground">{t("note")}</p>
        {!editing && currentNote && (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t("noteEdit")}
            onClick={() => {
              setDraft(currentNote);
              setEditing(true);
            }}
          >
            <PencilIcon data-icon="default" />
          </Button>
        )}
      </div>
      {editing ? (
        <div className="flex flex-col gap-2">
          <Textarea
            value={draft}
            onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setDraft(e.target.value)}
            placeholder={t("notePlaceholder")}
            maxLength={1000}
            rows={3}
            autoFocus
          />
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={save} disabled={saving}>
              {saving && <Spinner className="size-4" />}
              {t("noteSave")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setEditing(false)}
              disabled={saving}
            >
              {t("noteCancel")}
            </Button>
          </div>
        </div>
      ) : currentNote ? (
        <p className="whitespace-pre-line">{currentNote}</p>
      ) : (
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs font-normal text-muted-foreground hover:text-foreground"
          onClick={() => {
            setDraft("");
            setEditing(true);
          }}
        >
          <PlusIcon data-icon="inline-start" className="size-3.5" />
          {t("noteAdd")}
        </Button>
      )}
    </div>
  );
}

/**
 * 弹窗副标题：会议全称（+届别年份）**本身即该届官网的超链接**（不再单列「打开链接」行）；
 * 无全称时退回展示标题（仅用于无障碍）、无官网时退回纯文本。
 */
function AppointmentSubtitle({ event }: { event: ParsedIcsAppointment }) {
  const t = useTranslations("calendar");
  const name = appointmentConfName(event);
  if (!name) return <>{appointmentDisplayTitle(event, t)}</>;
  if (!event.url) return <>{name}</>;
  return (
    <a
      href={event.url}
      target="_blank"
      rel="noopener noreferrer"
      className="underline underline-offset-4 hover:text-primary"
    >
      {name}
      {/* 末尾的外链图标：提示「整段文字是官网链接」（否则下划线在小字里不够显眼） */}
      <ExternalLinkIcon
        data-icon="inline-end"
        className="ml-1 inline size-3.5 align-[-0.125em]"
      />
    </a>
  );
}

/** 日程详情行（时间 / 会期 / 地点 / 链接）；投稿节点事件的信息已在弹窗头部（标题 + 副标题） */
function AppointmentDetails({ event, locale }: { event: ParsedIcsAppointment; locale: string }) {
  const t = useTranslations("calendar");

  const timeText = formatAppointmentTimeText(event, locale, t("allDay"));
  // 投稿节点事件：事件时间是「截止时刻」，地点是「会议举办地」，另有「会议会期」——
  // 标签必须与会议本体区分，否则会被读成「会议于此时此地举办」
  const deadline = isDeadlineNode(event);

  return (
    <div className="flex flex-col gap-3 text-sm">
      <div>
        {/* 标签带节点名（如「截止时间（摘要）」）：标明是哪个节点的截止 */}
        <p className="mb-1 text-xs font-medium text-muted-foreground">
          {deadline
            ? t("deadlineTimeWithType", {
                node: t(CATEGORY[categorizeAppointment(event)].labelKey),
              })
            : t("time")}
        </p>
        <p className="whitespace-pre-line">{timeText}</p>
      </div>
      {deadline && event.confDates && (
        <div>
          <p className="mb-1 text-xs font-medium text-muted-foreground">
            {t("confDates")}
          </p>
          <p className="whitespace-pre-line">{event.confDates}</p>
        </div>
      )}
      {event.location && (
        <div>
          <p className="mb-1 text-xs font-medium text-muted-foreground">
            {deadline ? t("confPlace") : t("place")}
          </p>
          <p className="whitespace-pre-line">{event.location}</p>
        </div>
      )}
      {/* 备注 = DESCRIPTION，外部客户端可直接看/改；投稿节点事件的会议全称在 X-CONF-NAME，
          作为弹窗副标题展示，两者互不干扰（曾把全称也写在 DESCRIPTION 里，被用户指出不合理） */}
      {/* 官网链接已上提到副标题（会议全称本身即超链接），仅在无全称时单列一行 */}
      {event.url && !appointmentConfName(event) && (
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

/** 时间线节点的短日期（同一年内省略年份；访客本地时区；模块级缓存格式器） */
const nodeDayFmtCache = new Map<string, Intl.DateTimeFormat>();
function formatNodeDay(utc: number, locale: string, withYear: boolean): string {
  const key = `${locale}|${withYear}`;
  let fmt = nodeDayFmtCache.get(key);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat(locale, {
      ...(withYear ? { year: "numeric" as const } : {}),
      month: "numeric",
      day: "numeric",
    });
    nodeDayFmtCache.set(key, fmt);
  }
  return fmt.format(new Date(utc));
}

/** 时间线节点的完整时刻（悬浮提示用；访客本地时区） */
const nodeFullFmtCache = new Map<string, Intl.DateTimeFormat>();
function formatNodeFull(utc: number, locale: string): string {
  let fmt = nodeFullFmtCache.get(locale);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat(locale, {
      dateStyle: "full",
      timeStyle: "short",
    });
    nodeFullFmtCache.set(locale, fmt);
  }
  return fmt.format(new Date(utc));
}

/** 时间线名称的三档：完整轮次备注 → 短标签 → 不显示（只留圆内图标） */
type TimelineLabelMode = "full" | "short" | "none";

/**
 * 节点名称在时间线上的显示预算（px）：判据 `可用宽 >= 文字宽 + TIMELINE_LABEL_EXTRA_PX`。
 * 「可用宽」= 行内的文字列宽 − 日期宽 − gap（竖向时间线里名称与日期同行）。
 *
 * 名称是**纯文字**（无底色/内边距），余量只为两侧留白；图标不参与这个判定——
 * 它固定在轴线圆内、**永远可见**，所以「空间不足」只是少一档文字，不会丢类别信息。
 * ⚠ 名称用**轮次短标签**（`conferenceRoundLabel` 已剥掉尾部流程词，如 `Spring`、`Main`、
 *   `Poster`），都很短、单行放得下；**不要**在这里改回「折两行」——实测原样长标签折两行后
 *   同一届的列「1 行/2 行参差」，观感很差（用户反馈）。
 * ⚠ 用「实际渲染宽度」而非固定阈值：中文「全文」≈23px vs 中文页里的 "Camera-ready" ≈62px，
 *   任何一组定值都必然让一侧错档。
 */
const TIMELINE_LABEL_EXTRA_PX = 8;

/**
 * `useLayoutEffect` 在服务端会告警，故 SSR 时退回 `useEffect`（标准同构写法）。
 */
const useIsomorphicLayoutEffect =
  typeof window !== "undefined" ? useLayoutEffect : useEffect;

/**
 * 会议届别时间线（详情弹窗中间区域，**竖向**）：把「这条事件」放回该届会议的节点序列。
 *
 * 版式（自绘；竖向时间线，见下方「竖向布局」说明）」
 * 与 `c-timeline-7` 的彩色节点）：每列自上而下 = 节点名称（可选）→ 日期 → **轴线上的大圆节点**。
 *
 * - 轴线上的**大圆**（`size-6`）**内嵌该节点类别的图标**（用户指定方案）：图标永远可见，
 *   故「空间不足」只是少一档名称文字，不会丢类别信息；圆的底色/描边/图标色与列表徽章同一套 token；
 * - 名称按「行内可用宽」选三档（完整轮次备注 → 短标签 → 不显示，见 `TIMELINE_LABEL_EXTRA_PX`）——
 *   与「圆内图标」合起来即「宽裕时图标+名称、紧张时仅图标」，但图标从「徽章里的小图标」
 *   升级为「轴线上的大圆」，紧凑档不再显得像妥协；
 * - 圆色 = 该节点类别颜色（与月视图 chip / 列表徽章同一套 token）；
 * - 连线段颜色区分是否已发生：`foreground/20`（浅灰）= 今天之前、`foreground`（近黑）= 今天之后；
 * - 已过节点淡化（**只淡化圆 + 名称 + 日期，不淡化整列**——否则会污染轴线半段），
 *   当前查看的节点在圆上加光晕；
 * - 文字一律**单行**（名称/日期都 `truncate`）：放不下就靠悬浮 `title` 看详情
 *   （完整时刻 + 节点名 + 轮次备注，可点时附「切换到该节点日程」）；
 * - 同届其它节点若也在日历里（已加载事件范围内），该列可点 → 原地切换到那条日程；
 * - **单节点会议不显示**（一列不成时间线），个人日程 / 第三方事件没有 `conference` 字段。
 */
function AppointmentTimeline({
  event,
  locale,
  candidates,
  onJump,
}: {
  event: ParsedIcsAppointment;
  locale: string;
  candidates: ParsedIcsAppointment[];
  onJump: (ev: ParsedIcsAppointment) => void;
}) {
  const t = useTranslations("calendar");
  const listRef = useRef<HTMLOListElement>(null);
  const probeRef = useRef<HTMLSpanElement>(null);
  /**
   * 每个节点的名称显示档位（key = 节点序号；未量出前 `"none"` = SSR/首帧的保守档）：
   * `full` = 完整轮次备注 → `short` = 剥掉流程词的短标签 → `none` = 只留圆内图标。
   * ⚠ 有 `full` 档才符合「空间够就显示完整名称」：竖向行宽 217~396px，最长备注 37 字符
   *   ≈220px 在宽屏分栏（297px）与窄屏（396px）都放得下，只有极窄视口才降到 `short`。
   */
  const [labelModes, setLabelModes] = useState<
    Record<number, TimelineLabelMode>
  >({});
  const conference = event.conference;
  const confAbbr = conference?.abbr;
  const confYear = conference?.year;

  // 长届别（如 VLDB 2027 有 24 个节点）纵向滚动时，把「当前节点」居中显示
  // ⚠ 用 rect 差算位移，不用 scrollIntoView——后者会连带滚动弹窗与页面
  useEffect(() => {
    const list = listRef.current;
    const current = list?.querySelector<HTMLElement>('[aria-current="true"]');
    if (!list || !current) return;
    const listRect = list.getBoundingClientRect();
    const curRect = current.getBoundingClientRect();
    // 竖向：把当前节点滚到**纵向**居中
    list.scrollTop +=
      curRect.top - listRect.top - (listRect.height - curRect.height) / 2;
  }, [event.uid, confAbbr, confYear]);

  /**
   * 名称档位判定：读一次**行内可用宽** + 每种候选文本的**实际渲染宽度**（探针元素）。
   *
   * ⚠ 为什么不用 CSS 容器查询（`@container` + `@max-[…]`）按容器宽判定：
   *   节点列是 flex item，而内容又受容器查询控制 → **互为因果**（内容→尺寸→查询→内容），
   *   浏览器会落到不同「不动点」上。实测同一届的四列本应等宽，却同时出现 57px 与
   *   117.8px 两种宽度、且判定互不一致。故把测量搬到 JS：行宽只由弹窗宽度决定
   *   （内容不参与），布局只解一次，结果稳定可复现。
   * ⚠ 也不用「按语言分组的固定阈值」：中文页的 `camera` 节点文案也是英文
   *   "Camera-ready"，同一组阈值必然让一侧错档（详见 `TIMELINE_LABEL_EXTRA_PX`）。
   */
  const badgeNodes = conference?.nodes;
  useIsomorphicLayoutEffect(() => {
    const ol = listRef.current;
    const probe = probeRef.current;
    if (!ol || !probe || !badgeNodes || badgeNodes.length < 2) return;
    const compute = () => {
      // 竖向：名称与日期**同行**，可用宽 = 文字列宽 − 日期宽 − gap(8)
      const bodies = [
        ...ol.querySelectorAll<HTMLElement>('[data-slot="timeline-node-body"]'),
      ];
      const availW = bodies.length
        ? Math.min(
            ...bodies.map((body) => {
              const date = body.querySelector("time");
              return (
                body.getBoundingClientRect().width -
                (date?.getBoundingClientRect().width ?? 0) -
                8
              );
            }),
          )
        : 0;
      if (availW <= 0) return;
      const next: Record<number, TimelineLabelMode> = {};
      badgeNodes.forEach((n, index) => {
        const category = CATEGORY_BY_KEY[n.kind] ?? "paper";
        const catLabel = t(CATEGORY[category].labelKey);
        const full = conferenceRoundFullLabel(n) ?? catLabel;
        const short = conferenceRoundLabel(n) ?? catLabel;
        probe.textContent = full;
        const fullW = probe.getBoundingClientRect().width;
        probe.textContent = short;
        const shortW = probe.getBoundingClientRect().width;
        next[index] =
          availW >= fullW + TIMELINE_LABEL_EXTRA_PX
            ? "full"
            : availW >= shortW + TIMELINE_LABEL_EXTRA_PX
              ? "short"
              : "none";
      });
      // 只在真的变了时 setState，避免 effect ↔ render 互相触发（探针测量本身不改变列宽）
      setLabelModes((prev) =>
        badgeNodes.every((_, i) => prev[i] === next[i]) ? prev : next,
      );
    };
    compute();
    // 弹窗/视口宽度变化时重算：
    // - `ResizeObserver` 覆盖元素自身尺寸变化（如弹窗内出现/消失滚动条）；
    // - `resize` 覆盖视口变化（RO 在页面被浏览器节流/不可见时不触发，两者互补）。
    const ro = new ResizeObserver(compute);
    ro.observe(ol);
    window.addEventListener("resize", compute);
    // 弹窗入场动画会改变弹窗几何，动画结束后重量一次（此时列宽才是最终值）
    const settleTimer = window.setTimeout(compute, 350);
    // 自托管 Inter 未加载完时量出的文字宽偏小；字体就绪后重量一次
    let cancelled = false;
    void document.fonts?.ready.then(() => {
      if (!cancelled) compute();
    });
    return () => {
      cancelled = true;
      window.clearTimeout(settleTimer);
      window.removeEventListener("resize", compute);
      ro.disconnect();
    };
  }, [event.uid, confAbbr, confYear, locale, badgeNodes, t]);

  if (!conference || conference.nodes.length < 2) return null;

  const now = Date.now();
  const { nodes } = conference;

  /**
   * 当前事件对应的节点（**只取一个**）：它同时决定 `aria-current`、圆上的光晕、
   * 以及纵向自动滚动定位的锚点——**「我在看哪条」必须唯一**，否则同一天多条节点日程
   * （ADMA 2026 的 Poster / Encore）会让指向变模糊（用户指定）。
   */
  // ⚠ 用 `matchedConferenceNode`（优先按 SUMMARY 里的轮次名定位）而不是裸的时刻匹配：
  //   同一天多个节点共用同一截止时刻时（Poster / Encore），时刻匹配只能命中第一个，
  //   打开 Encore 那条会让 Poster 那列亮起来。
  const matched = matchedConferenceNode(event);
  const currentIndex = matched ? nodes.indexOf(matched) : -1;

  // 日期上年份：仅当该节点与「参照节点」（当前节点，无则首个）跨年时显示，保持名称紧凑
  const refYear = new Date(nodes[currentIndex >= 0 ? currentIndex : 0].utc).getFullYear();

  /**
   * 该节点在日历里对应的**另一条**日程（同会议同届 + 时刻一致；只认已加载的事件）。
   * ⚠ 必须排除当前事件自身：同届里两个节点共用同一截止时刻时（ADMA 2026 的
   * 「Poster Paper / Encore Paper」），未命中的那列会找到当前事件而显得「可点」，
   * 点下去却什么都不变。
   */
  const eventAtNode = (utc: number) =>
    candidates.find(
      (ev) =>
        ev.uid !== event.uid &&
        ev.startUtc !== null &&
        ev.conference?.abbr === conference.abbr &&
        ev.conference.year === conference.year &&
        Math.abs(ev.startUtc - utc) <= NODE_TIME_TOLERANCE_MS,
    );

  /** 访客本地时区的「日」键（YYYY-M-D）：判断节点是否与「今天」同一天 */
  const localDayKey = (utc: number) => {
    const d = new Date(utc);
    return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  };
  /** 本地「日」的可比较序号（Y*10000+M*100+D）：判断「今天之前 / 今天 / 今天之后」 */
  const daySeq = (utc: number) => {
    const d = new Date(utc);
    return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
  };
  const todaySeq = daySeq(now);
  const todayKey = localDayKey(now);
  /** 与「今天」同一天的最左节点（无则 -1） */
  const firstSameDayIndex = nodes.findIndex((n) => localDayKey(n.utc) === todayKey);
  /** 首个尚未发生的节点（无则 -1） */
  const boundaryIndex = nodes.findIndex((n) => n.utc > now);

  /**
   * 「今天」列的位置：
   * ① 有事件节点与今天**同一天** → 放在这些节点的**最左侧**（用户指定：「当有一个或多个
   *    事件节点和 Today 节点处于同一天，需要将 Today 节点放在最左侧」）；
   * ② 否则放在首个**尚未发生**节点之前；
   * ③ 都没有（全部已过）→ 追加到末尾。
   * 于是「今天」**总能显示**。
   *
   * ⚠ 「今天」必须像事件节点一样**自己占一列**（见下方 `entries`），不能叠在某个节点列上：
   *   早先的做法是「刻度绝对定位在节点列左缘 + 标签用列内 `text-center`」，刻度在列左缘、
   *   标签却在列中心，于是大部分情况下标签跑到相邻事件节点下方；再用 `boundaryIndex > 0`
   *   跳过「今天早于首个节点」的情形，就导致那种届别根本看不到标记（用户报的两个 bug）。
   *
   * ⚠ 它只是**「今天」的位置标记，不表示时间比例**：各列等宽，与真实间隔无关
   *   （ADMA 2026 的间隔是 14/0/7/35/0 天，却渲染为等宽列），故刻意不做「按时间插位置」
   *   ——那会制造一个不存在的精度（用户确认的方案）。
   * ⚠ 线段颜色**看的就是今天标记的位置**（标记左侧实线浅、右侧实线深，见 `segClassFor`），
   *   而**不是**「当前打开的是哪个节点」。
   */
  const todayIndex =
    firstSameDayIndex >= 0
      ? firstSameDayIndex
      : boundaryIndex >= 0
        ? boundaryIndex
        : nodes.length;

  /** 列序列 = 事件节点 + 一个「今天」标记列（`nodeIndex = -1` 表示「今天」） */
  const entries: { kind: "node" | "today"; nodeIndex: number }[] = [];
  nodes.forEach((_, index) => {
    if (index === todayIndex) entries.push({ kind: "today", nodeIndex: -1 });
    entries.push({ kind: "node", nodeIndex: index });
  });
  if (todayIndex === nodes.length) entries.push({ kind: "today", nodeIndex: -1 });

  /** 某列的「日」键（「今天」列即今天）——用于判断相邻两列是否同一天 */
  const markerDay = (entryIndex: number) => {
    const entry = entries[entryIndex];
    if (!entry) return "";
    return entry.kind === "today" ? todayKey : localDayKey(nodes[entry.nodeIndex].utc);
  };

  /**
   * 半段轴线的样式：
   * - 两端属于**同一天**（含「今天」标记本身，如「今天 → 今天到期的节点」）→ **虚线**：
   *   这段不代表时间跨度，给读者「它们其实是同一时刻」的视觉指引（用户提议）；
   * - 其余以「今天」标记为界（`from >= todayIndex` = 在标记右侧）：左侧实线浅、右侧实线深。
   *
   * ⚠ 判据是「与今天标记的相对位置」：既**不是**「与当前打开的节点的相对位置」（那样会随
   *   打开哪条日程而变），也**不是**「该线段通向的那个节点是否已发生」——后者曾把
   *   「最后一个已过节点 → 今天」那一段画成深色（用户指出：今天左边的线应该是浅色，
   *   因为那段时间确实已经过去了）。
   * ⚠ 用 `foreground` 的两个透明度档位而非写死黑/灰——深色主题下底色本身就是深的，
   *   字面的「深色」不存在，能跨主题成立的只有「实 / 淡」这一相对关系。
   *
   * ⚠ 「已发生」的淡化**不能下在整列（`opacity-55`）上**：祖先 opacity 会衰减整列里的
   *   轴线半段，使同一线段的两个半段（分属相邻两列）渲染深浅不一——实测「已过节点 → 今天」
   *   那段就曾出现一半正常、一半变淡（用户报的「一个线段两种颜色」）。
   *   现在只淡化节点自己的徽章/日期/圆点（见 `dimmed`）。
   */
  const segClassFor = (from: number, to: number) => {
    const dark = from >= todayIndex;
    if (markerDay(from) === markerDay(to)) {
      // ⚠ 竖线段的虚线必须用 `border-l`：`border-t` 在 1px 宽的竖元素上只剩一条 1px 的点，
      //   等于看不见（横向版是 `border-t`，直接平移过来会静默失效）。
      //   颜色额外写 `bg-*`（元素宽 0，不可见）——让 E2E 能像实线段一样只读 backgroundColor 比对。
      return dark
        ? "w-0 border-l border-dashed border-foreground bg-foreground"
        : "w-0 border-l border-dashed border-foreground/20 bg-foreground/20";
    }
    return dark ? "w-px bg-foreground" : "w-px bg-foreground/20";
  };

  return (
    <section
      className="relative flex flex-col gap-2"
      data-slot="appointment-timeline"
    >
      <p className="text-xs font-medium text-muted-foreground">{t("timeline")}</p>
      {/* 竖向时间线：列表纵向排列、超出即**上下滚动**（`max-h` 挡住长届别把弹窗撑爆）。
          行宽 = 弹窗内容宽（窄屏全宽）或右栏宽（宽屏分栏），与节点数**无关**——这是竖向
          相对横向的关键优势（横向每列宽 = 内容宽 ÷ 节点数，24 节点时只剩 45px）。 */}
      <ol
        ref={listRef}
        className="relative flex max-h-[65vh] flex-col overflow-y-auto"
      >
        {entries.map((entry, i) => {
          const isToday = entry.kind === "today";
          const node = entry.kind === "node" ? nodes[entry.nodeIndex] : null;
          const isCurrent = node !== null && entry.nodeIndex === currentIndex;
          // **两条独立通道**（用户指定）：
          //   ① 时间通道：今天之前 → 淡化；今天 → 不淡化（并把日期加重作「今天」的强调）；
          //      今天之后 → 正常。判据只看节点日期。
          //   ② 光晕通道（圆外那圈更大更淡的圆环）→ **只指示点开的那一个节点**（`isCurrent`），
          //      与时间无关——两者可同时生效（如看的这条在今天之前 = 有光晕 + 已淡化）。
          // ⚠ 同日多条节点日程（Poster / Encore）的区分靠**轮次名文字**（见 `appointmentDisplayTitle`），
          //   不靠光晕——光晕必须唯一，否则「我在看哪条」这个指向就模糊了（用户指定）。
          // ⚠ 不要再把光晕挪去当「今天」的标记，也不要让正在查看的节点享「不淡化」豁免。
          const nodeDay = node !== null ? daySeq(node.utc) : 0;
          const dimmed = node !== null && nodeDay < todaySeq;
          const isTodayNode = node !== null && nodeDay === todaySeq;
          const target = node && !isCurrent ? eventAtNode(node.utc) : undefined;
          const category = node ? (CATEGORY_BY_KEY[node.kind] ?? "paper") : "paper";
          /** 类别名（"全文"）：tooltip 用——轮次名 + 类别名 + 原始备注 = 完整信息 */
          const catLabel = node ? t(CATEGORY[category].labelKey) : "";
          /**
           * 名称：**优先完整轮次备注**（`Spring Submission Deadline`）——同一届同一天可能有多条
           * 节点日程、类型还相同（都是"全文"），只有轮次分得开；行宽不够时降级到短标签
           * （`Spring`），再不够就不显示；无轮次备注时回退类别名。
           */
          const nodeFull = node ? (conferenceRoundFullLabel(node) ?? catLabel) : "";
          const nodeShort = node ? (conferenceRoundLabel(node) ?? catLabel) : "";
          const labelMode: TimelineLabelMode = node
            ? (labelModes[entry.nodeIndex] ?? "none")
            : "none";
          const nodeLabel = labelMode === "full" ? nodeFull : nodeShort;
          const details = node
            ? `${formatNodeFull(node.utc, locale)} · ${catLabel}${
                node.comment ? ` · ${node.comment}` : ""
              }`
            : "";

          // 竖向时间线的**一行**：轴线列（竖线 + 圆） + 文字列（名称 + 日期）。
          // 行高固定 `h-12` —— 圆垂直居中、相邻行的竖线自然相接；行高若随内容变，
          // 各行的圆会参差不齐（横向版曾用「固定单行槽」解决同类问题，竖向直接定行高）。
          //
          // ⚠ 语义与横向版完全一致，只是方向从「左→右」变成「上→下」：
          //   「今天」行**上方** = 过去（线浅 `foreground/20`）、**下方** = 未来（线深 `foreground`）。
          const railDot = isToday ? (
            /* 「今天」用**同尺寸的**空心圆（同站点月视图的「今日」语义：空心 = 今天），
               黑描边加粗，不抢事件圆里的类别色 */
            <span
              data-slot="timeline-today-dot"
              className="size-6 shrink-0 rounded-full border-2 border-foreground"
            />
          ) : (
            <span
              data-slot="timeline-node-dot"
              className={cn(
                "flex size-6 shrink-0 items-center justify-center rounded-full border",
                CATEGORY[category].dotClass,
                // 光晕 = 点开的那一个节点（时间维度由淡化表示，两者独立）
                isCurrent && "ring-3 ring-ring/30",
                dimmed && "opacity-55",
              )}
            >
              <span data-slot="timeline-node-icon" className="flex">
                {CATEGORY[category].icon}
              </span>
            </span>
          );

          const rowInner = (
            <>
              {/* 轴线列：上/下半段竖线 + 圆（等分剩余高度 → 圆必然垂直居中） */}
              <span
                aria-hidden
                className="flex w-6 shrink-0 flex-col items-center"
              >
                <span
                  className={cn(
                    "flex-1",
                    i === 0 ? "bg-transparent" : segClassFor(i - 1, i),
                  )}
                />
                {railDot}
                <span
                  className={cn(
                    "flex-1",
                    i === entries.length - 1
                      ? "bg-transparent"
                      : segClassFor(i, i + 1),
                  )}
                />
              </span>
              {/* 文字列：名称（可选）+ 日期（右对齐）。名称放不下就整条不渲染，
                  日期始终在（时间线的最小信息单位），完整信息看整行 `title` */}
              <span
                data-slot="timeline-node-body"
                className="flex min-w-0 flex-1 items-center gap-2"
              >
                {isToday ? (
                  <span
                    data-slot="timeline-today-label"
                    className="min-w-0 truncate text-xs font-medium text-muted-foreground"
                  >
                    {t("timelineToday")}
                  </span>
                ) : (
                  labelMode !== "none" && (
                    <span
                      data-slot="timeline-node-label"
                      className={cn(
                        "min-w-0 truncate text-xs font-medium",
                        CATEGORY[category].textClass,
                        dimmed && "opacity-55",
                      )}
                    >
                      {nodeLabel}
                    </span>
                  )
                )}
                <time
                  data-slot={isToday ? "timeline-today-date" : undefined}
                  className={cn(
                    "ml-auto shrink-0 text-xs tabular-nums",
                    // 「今天」的节点日期加重（时间通道的「高亮」）；其它保持次级色
                    isTodayNode
                      ? "font-medium text-foreground"
                      : "text-muted-foreground",
                    dimmed && "opacity-55",
                  )}
                  dateTime={
                    isToday
                      ? new Date(now).toISOString().slice(0, 10)
                      : new Date(node!.utc).toISOString()
                  }
                >
                  {formatNodeDay(
                    isToday ? now : node!.utc,
                    locale,
                    new Date(isToday ? now : node!.utc).getFullYear() !== refYear,
                  )}
                </time>
              </span>
            </>
          );

          const rowClass =
            "flex h-12 w-full min-w-0 items-stretch gap-2 rounded-lg px-2 text-start";
          const rowKey = isToday
            ? "today"
            : `${node!.utc}-${entry.nodeIndex}`;

          if (isToday) {
            return (
              <li
                key={rowKey}
                data-slot="timeline-today"
                className="flex min-w-0"
              >
                <div className={rowClass}>{rowInner}</div>
              </li>
            );
          }
          return (
            <li
              key={rowKey}
              data-slot="timeline-node"
              data-highlighted={isTodayNode ? "true" : undefined}
              aria-current={isCurrent ? "true" : undefined}
              className="flex min-w-0"
            >
              {target ? (
                <button
                  type="button"
                  title={`${details}\n${t("timelineJump")}`}
                  onClick={() => onJump(target)}
                  className={cn(
                    rowClass,
                    "outline-none transition-colors hover:bg-muted/60 focus-visible:ring-[3px] focus-visible:ring-ring/50",
                  )}
                >
                  {rowInner}
                </button>
              ) : (
                <div title={details} className={rowClass}>
                  {rowInner}
                </div>
              )}
            </li>
          );
})}
      </ol>
      {/* 文字宽度探针：与徽章同字号/字重（`text-xs font-medium`），脱离文档流不参与布局；
          仅用于量出「该名称完整渲染需要多宽」，再与行内可用宽比对选档。 */}
      <span
        ref={probeRef}
        data-slot="timeline-probe"
        aria-hidden="true"
        className="pointer-events-none invisible absolute whitespace-nowrap text-xs font-medium"
      />
    </section>
  );
}
