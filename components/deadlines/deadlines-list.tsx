"use client";

import { useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import {
  CalendarDaysIcon,
  CalendarPlusIcon,
  ClockIcon,
  ExternalLinkIcon,
  Globe2Icon,
  LayersIcon,
  MapPinIcon,
  RefreshCwIcon,
  RotateCcwIcon,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Empty } from "@/components/ui/empty";
import { SearchInput } from "@/components/ui/search-input";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { toast } from "@/components/ui/toast";
import { useOwnerPreferences } from "@/lib/preferences/use-owner-preferences";
import { buildIcsText, toIcsUtc } from "@/lib/ical";
import type { DeadlineConf, DeadlineTimelineEntry, DeadlineYear } from "@/lib/data";

/* ---------------- 时区工具（无依赖） ---------------- */

/**
 * 把 "YYYY-MM-DD HH:mm:ss"（tz 时区墙钟时间）转为 UTC 毫秒时间戳。
 * 方法：假想其为 UTC 取 naive 戳，再用 Intl 计算该时刻在 tz 的墙钟与
 * naive 之差得到偏移。tz 无效时按 UTC 兜底。
 */
function zonedToUtcMs(ts: string, tz: string): number {
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

/** 归一化 IANA 时区 → 人类可读展示（Etc/GMT+12 → "UTC-12"） */
function displayTz(tz: string): string {
  const m = tz.match(/^Etc\/GMT([+-])(\d{1,2})$/);
  if (m) {
    const off = Number(m[2]);
    return `UTC${m[1] === "-" ? "+" : "-"}${off}`;
  }
  return tz;
}

/** 浏览器本地时区的 UTC 偏移标注（如 UTC+8 / UTC-4:30），适配夏令时当前偏移 */
function localTzOffset(): string {
  // getTimezoneOffset() = UTC - 本地（分钟），正号表示本地比 UTC 慢
  const offsetMin = -new Date().getTimezoneOffset();
  const sign = offsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return `UTC${sign}${h}${m ? `:${String(m).padStart(2, "0")}` : ""}`;
}

/* ---------------- 领域常量（与 ccf-directory 保持一致） ---------------- */

const FIELD_EN: Record<string, string> = {
  计算机体系结构: "Architecture",
  计算机网络: "Networks",
  网络与信息安全: "Security",
  软件工程: "Software Eng.",
  数据库: "Databases & Mining",
  计算机科学理论: "Theory",
  计算机图形学与多媒体: "Graphics & MM",
  人工智能: "AI",
  人机交互与普适计算: "HCI",
  交叉: "Interdisciplinary",
};

const FIELD_KEY = (f: string) => f.split("/")[0];

const DAY_MS = 86_400_000;

type LevelFilter = "all" | "A" | "B" | "C" | "none";
// 时间轴：去年以来 → 今年以来 → 全部未来 → 未来 30 天 → 未来 90 天
type RangeFilter = "last-year" | "this-year" | "all" | "30" | "90";

const LEVEL_STYLE = {
  A: "bg-red-500/10 text-red-600 ring-red-600/20 dark:bg-red-500/15 dark:text-red-400",
  B: "bg-blue-500/10 text-blue-600 ring-blue-600/20 dark:bg-blue-500/15 dark:text-blue-400",
  C: "bg-emerald-500/10 text-emerald-600 ring-emerald-600/20 dark:bg-emerald-500/15 dark:text-emerald-400",
  none: "bg-muted text-muted-foreground ring-border",
} as const;

const LEVEL_BAR = {
  A: "bg-red-500",
  B: "bg-blue-500",
  C: "bg-emerald-500",
  none: "bg-border",
} as const;

function LevelBadge({ level }: { level: "A" | "B" | "C" | "none" }) {
  const t = useTranslations("deadlines.levels");
  // 全拼显示（CCF-A）而非缩写：后期可能收录 CCF 目录之外的会议
  // （如 CORE 评级），届时可按来源扩展前缀
  const text = level === "none" ? "·" : `CCF-${level}`;
  return (
    <Badge
      variant="outline"
      className={`w-auto min-w-7 shrink-0 justify-center rounded-md px-1.5 text-[10px] font-bold ring-1 ring-inset ${LEVEL_STYLE[level]}`}
      aria-label={level === "none" ? t("none") : `${text} ${t("class")}`}
    >
      {text}
    </Badge>
  );
}

/** 主 deadline 信息（该年份内未来/已过最近的） */
type MainDeadline = {
  utc: number;
  entry: DeadlineTimelineEntry;
  labelKey: "abstract" | "paper";
};

/** 展平条目：会议 × 年份（同一会议不同年份独立成卡） */
type FlatItem = {
  conf: DeadlineConf;
  year: DeadlineYear;
  /** 该年份未来最近的 deadline */
  best: MainDeadline | null;
  /** 该年份已过最近的 deadline */
  bestPast: MainDeadline | null;
};

function StatCard({
  icon: Icon,
  value,
  label,
  highlight = false,
}: {
  icon: typeof LayersIcon;
  value: number;
  label: string;
  highlight?: boolean;
}) {
  return (
    <Card
      className={`transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md ${
        highlight ? "border-primary/30 bg-primary/5" : "hover:border-border"
      }`}
    >
      <CardContent className="flex items-center gap-3 p-3.5 sm:p-4">
        <div
          className={`flex size-9 shrink-0 items-center justify-center rounded-lg ${
            highlight ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground"
          }`}
        >
          <Icon className="size-5" />
        </div>
        <div className="min-w-0">
          <p className="text-xl leading-none font-semibold tracking-tight tabular-nums">
            {value}
          </p>
          <p className="mt-1.5 truncate text-xs text-muted-foreground">{label}</p>
        </div>
      </CardContent>
    </Card>
  );
}

export function DeadlinesList({
  deadlines,
}: {
  deadlines: DeadlineConf[];
}) {
  const t = useTranslations("deadlines");
  const locale = useLocale();
  const isZh = locale === "zh";
  const { isOwner } = useOwnerPreferences();

  const [query, setQuery] = useState("");
  const [level, setLevel] = useState<LevelFilter>("all");
  const [range, setRange] = useState<RangeFilter>("all");
  const [selectedFields, setSelectedFields] = useState<string[]>([]);
  const [openItem, setOpenItem] = useState<FlatItem | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState("");

  /** 手动立即同步（主人专属）：POST 后刷新页面展示最新数据 */
  const handleSync = async () => {
    if (syncing) return;
    setSyncing(true);
    setSyncError("");
    try {
      const r = await fetch("/api/deadlines/sync", { method: "POST" });
      const data = (await r.json().catch(() => null)) as
        | { error?: string }
        | null;
      if (!r.ok) throw new Error(data?.error ?? `HTTP ${r.status}`);
      window.location.reload();
    } catch (err) {
      setSyncError(err instanceof Error ? err.message : String(err));
      setSyncing(false);
    }
  };

  const toggleField = (f: string) => {
    setSelectedFields((prev) =>
      prev.includes(f) ? prev.filter((x) => x !== f) : [...prev, f],
    );
  };

  /** 添加会议事件到站主专属 CalDAV 日历（幂等：UID 稳定，重复添加覆盖） */
  const handleAddToCaldav = async (
    conf: DeadlineConf,
    year: DeadlineYear,
    main: MainDeadline,
    label: string,
  ) => {
    try {
      const r = await fetch("/api/deadlines/caldav", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          a: conf.a,
          n: conf.n,
          year: year.y,
          label,
          labelKey: main.labelKey,
          t: main.entry.t,
          tz: year.tz,
          date: year.date,
          place: year.place,
          link: year.link,
          utc: main.utc,
        }),
      });
      const data = (await r.json().catch(() => null)) as
        | { error?: string }
        | null;
      if (!r.ok) throw new Error(data?.error ?? `HTTP ${r.status}`);
      toast.add({
        title: t("caldavAdded", { conf: `${conf.a} ${year.y}` }),
        type: "success",
      });
    } catch (err) {
      console.error("[caldav] 添加失败", err);
      toast.add({
        title: t("caldavFailed"),
        description: err instanceof Error ? err.message : String(err),
        type: "error",
      });
    }
  };

  /* 展平：会议 × 年份 独立条目（同一会议不同年份不再合并） */
  const { items, total, count30, count90, countYear } = useMemo(() => {
    const now = Date.now();
    const items: FlatItem[] = [];
    for (const conf of deadlines) {
      for (const year of conf.years) {
        let best: MainDeadline | null = null;
        let bestPast: MainDeadline | null = null;
        for (const entry of year.timeline) {
          const utc = zonedToUtcMs(entry.t, year.tz);
          const candidate: MainDeadline = {
            utc,
            entry,
            labelKey: entry.k ?? "paper",
          };
          if (utc >= now) {
            if (!best || utc < best.utc) best = candidate;
          } else if (!bestPast || utc > bestPast.utc) {
            bestPast = candidate;
          }
        }
        if (best || bestPast) items.push({ conf, year, best, bestPast });
      }
    }
    const upcoming = items.filter((i) => i.best);
    return {
      items,
      total: deadlines.length,
      count30: upcoming.filter((i) => i.best!.utc - now < 30 * DAY_MS).length,
      count90: upcoming.filter((i) => i.best!.utc - now < 90 * DAY_MS).length,
      countYear: upcoming.filter((i) => i.best!.utc - now < 365 * DAY_MS).length,
    };
  }, [deadlines]);

  const fields = useMemo(() => {
    const seen = new Set<string>();
    const list: string[] = [];
    for (const c of deadlines) {
      if (!c.f) continue;
      const key = FIELD_KEY(c.f);
      if (!seen.has(key)) {
        seen.add(key);
        list.push(c.f);
      }
    }
    return list;
  }, [deadlines]);

  const filtered = useMemo(() => {
    const now = Date.now();
    // 本地时区的年初（历史档窗口起点）
    const yearStart = new Date(new Date().getFullYear(), 0, 1).getTime();
    const lastYearStart = new Date(new Date().getFullYear() - 1, 0, 1).getTime();
    const q = query.trim().toLowerCase();
    return items
      .filter((i): i is FlatItem => {
        const { conf } = i;
        const isPastRange = range === "last-year" || range === "this-year";
        if (isPastRange) {
          // 历史档：该年份最近一次已过 deadline 落在窗口内才显示
          const start = range === "last-year" ? lastYearStart : yearStart;
          if (!i.bestPast || i.bestPast.utc < start || i.bestPast.utc >= now)
            return false;
        } else {
          // 未来档：只显示未截止；时间范围作用于 deadline
          if (!i.best) return false;
          if (range !== "all" && i.best.utc - now >= Number(range) * DAY_MS)
            return false;
        }
        if (level === "none" ? conf.l !== "" : level !== "all" && conf.l !== level)
          return false;
        if (
          selectedFields.length > 0 &&
          !selectedFields.some((f) => FIELD_KEY(f) === FIELD_KEY(conf.f))
        )
          return false;
        if (q) {
          const a = conf.a.toLowerCase();
          const n = conf.n.toLowerCase();
          if (!a.includes(q) && !n.includes(q)) return false;
        }
        return true;
      })
      .sort((x, y) => {
        const isPastRange = range === "last-year" || range === "this-year";
        if (isPastRange) {
          // 历史档：最近截止的在前（降序）
          return (y.bestPast?.utc ?? 0) - (x.bestPast?.utc ?? 0);
        }
        // 未来档：截止时间升序
        return (x.best?.utc ?? 0) - (y.best?.utc ?? 0);
      });
  }, [items, query, level, range, selectedFields]);

  const resetFilters = () => {
    setQuery("");
    setLevel("all");
    setRange("all");
    setSelectedFields([]);
  };

  const dateFmt = useMemo(
    () =>
      new Intl.DateTimeFormat(isZh ? "zh-CN" : "en-US", {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }),
    [isZh],
  );

  return (
    <div className="flex flex-col gap-8">
      {/* 主人专属：手动立即同步数据源 */}
      {isOwner && (
        <div className="flex flex-col items-end gap-1">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleSync}
            disabled={syncing}
          >
            <RefreshCwIcon
              className={syncing ? "animate-spin" : undefined}
              data-icon="inline-start"
            />
            {syncing ? t("syncing") : t("syncNow")}
          </Button>
          {syncError && (
            <p className="text-xs text-destructive" role="alert">
              {t("syncFailed")}：{syncError}
            </p>
          )}
        </div>
      )}

      {/* 统计卡片 */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard icon={LayersIcon} value={total} label={t("statsTotal")} highlight />
        <StatCard icon={ClockIcon} value={count30} label={t("stats30")} />
        <StatCard icon={ClockIcon} value={count90} label={t("stats90")} />
        <StatCard icon={CalendarDaysIcon} value={countYear} label={t("statsUpcoming")} />
      </div>

      {/* sticky 筛选栏 */}
      <div className="sticky top-14 z-30 rounded-2xl border bg-background/85 px-3 py-3 shadow-sm backdrop-blur supports-[backdrop-filter]:bg-background/70">
        <div className="flex flex-wrap items-center gap-2">
          {/* md 以下搜索框独占一行；md 起弹性伸缩与筛选组同行 */}
          <SearchInput
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("searchPlaceholder")}
            className="w-full md:w-auto md:min-w-44 md:max-w-72 md:flex-1"
            clearLabel={t("clearSearch")}
            aria-label={t("searchPlaceholder")}
          />
          <ToggleGroup
            value={[level]}
            onValueChange={(v) => setLevel((v[0] as LevelFilter) ?? "all")}
            className="ccf-segmented flex-wrap"
          >
            <ToggleGroupItem value="all">{t("levelAll")}</ToggleGroupItem>
            {(["A", "B", "C"] as const).map((l) => (
              <ToggleGroupItem key={l} value={l}>
                {l}
              </ToggleGroupItem>
            ))}
            <ToggleGroupItem value="none">{t("levelNone")}</ToggleGroupItem>
          </ToggleGroup>
          <ToggleGroup
            value={[range]}
            onValueChange={(v) => setRange((v[0] as RangeFilter) ?? "all")}
            // 与搜索框/等级组同行：md 以下弹性占满剩余空间自身滚动，md 起按内容宽度
            className="ccf-segmented max-w-full flex-nowrap overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden max-md:min-w-0 max-md:flex-1 md:flex-none"
          >
            <ToggleGroupItem value="last-year">
              <span className="lg:hidden">{t("rangeLastYearShort")}</span>
              <span className="hidden lg:inline">{t("rangeLastYear")}</span>
            </ToggleGroupItem>
            <ToggleGroupItem value="this-year">
              <span className="lg:hidden">{t("rangeThisYearShort")}</span>
              <span className="hidden lg:inline">{t("rangeThisYear")}</span>
            </ToggleGroupItem>
            <ToggleGroupItem value="all">
              <span className="lg:hidden">{t("rangeAllShort")}</span>
              <span className="hidden lg:inline">{t("rangeAll")}</span>
            </ToggleGroupItem>
            <ToggleGroupItem value="30">
              <span className="lg:hidden">{t("range30Short")}</span>
              <span className="hidden lg:inline">{t("range30")}</span>
            </ToggleGroupItem>
            <ToggleGroupItem value="90">
              <span className="lg:hidden">{t("range90Short")}</span>
              <span className="hidden lg:inline">{t("range90")}</span>
            </ToggleGroupItem>
          </ToggleGroup>
          <Badge
            variant="outline"
            className="ml-auto hidden shrink-0 font-normal tabular-nums text-muted-foreground lg:inline-flex"
          >
            {filtered.length} {t("items")}
          </Badge>
        </div>
      </div>

      {/* 领域多选筛选：可同时勾选多个领域（空 = 全部） */}
      <nav aria-label={t("fieldFilter")} className="flex flex-wrap gap-1.5">
        <Button
          type="button"
          variant={selectedFields.length === 0 ? "default" : "outline"}
          size="sm"
          className="rounded-full text-xs"
          onClick={() => setSelectedFields([])}
          aria-pressed={selectedFields.length === 0}
        >
          {t("fieldAll")}
        </Button>
        {fields.map((f) => {
          const key = FIELD_KEY(f);
          const selected = selectedFields.some((x) => FIELD_KEY(x) === key);
          return (
            <Button
              key={key}
              type="button"
              variant={selected ? "default" : "outline"}
              size="sm"
              className="rounded-full text-xs"
              onClick={() => toggleField(f)}
              aria-pressed={selected}
            >
              {isZh ? f : FIELD_EN[key] ?? f}
            </Button>
          );
        })}
      </nav>

      {/* 匹配统计 */}
      <p className="text-xs text-muted-foreground">
        {t("stats", { total, matched: filtered.length })}
      </p>

      {/* 会议卡片网格（借鉴 ai-deadlines 布局：倒计时醒目 + 地点/会议时间直接展示） */}
      {filtered.length === 0 ? (
        <Empty title={t("empty")}>
          <Button variant="outline" size="sm" onClick={resetFilters}>
            <RotateCcwIcon />
            {t("resetFilters")}
          </Button>
        </Empty>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map(({ conf, year, best, bestPast }) => {
            const levelKey = conf.l === "" ? "none" : conf.l;
            // 历史档（去年以来/今年以来）强制展示最近一次已过 deadline；未来档展示未来最近的
            const isPast =
              range === "last-year" || range === "this-year" || !best;
            const main = isPast ? (bestPast ?? best!) : best!;
            const daysLeft = Math.ceil((main.utc - Date.now()) / DAY_MS);
            const label = t(main.labelKey);
            const countdown = isPast
              ? t("pastDue")
              : daysLeft <= 0
                ? t("dueToday")
                : daysLeft === 1
                  ? t("dueTomorrow")
                  : t("daysLeft", { days: daysLeft });
            // 倒计时 urgency 配色（≤3 天红 / ≤7 天橙 / ≤14 天琥珀 / 其余弱化 / 已截止弱化）
            const urgencyClass = isPast
              ? "text-muted-foreground/60"
              : daysLeft <= 3
                ? "text-red-600 dark:text-red-400"
                : daysLeft <= 7
                  ? "text-orange-600 dark:text-orange-400"
                  : daysLeft <= 14
                    ? "text-amber-600 dark:text-amber-400"
                    : "text-muted-foreground";
            const fieldKey = conf.f ? FIELD_KEY(conf.f) : "";
            return (
              <Card
                key={`${conf.a}-${year.y}`}
                className={`group relative cursor-pointer transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md ${
                  isPast ? "opacity-70 hover:opacity-100" : ""
                }`}
                onClick={() => setOpenItem({ conf, year, best, bestPast })}
              >
                <span
                  aria-hidden
                  className={`absolute inset-y-0 left-0 w-[3px] rounded-r-full opacity-0 transition-opacity group-hover:opacity-100 ${LEVEL_BAR[levelKey]}`}
                />
                <CardContent className="flex h-full flex-col gap-2 p-3">
                  {/* 顶行：缩写 + 年份 + 等级 · 倒计时 */}
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="truncate font-mono text-base font-bold tracking-tight">
                        {conf.a} {year.y}
                      </span>
                      <LevelBadge level={levelKey} />
                    </div>
                    <span className={`shrink-0 text-xs font-medium tabular-nums ${urgencyClass}`}>
                      {countdown}
                    </span>
                  </div>
                  {/* 全称 */}
                  <p
                    className="line-clamp-2 text-sm leading-snug text-muted-foreground transition-colors group-hover:text-foreground/80"
                    title={conf.n}
                  >
                    {conf.n}
                  </p>
                  {/* 领域徽章（独立行，细边框 + 图标；筛选命中时高亮） */}
                  {conf.f && (
                    <span
                      className={`flex w-fit items-center gap-1 rounded-md border px-2 py-0.5 text-[10px] font-medium ${
                        selectedFields.length > 0
                          ? "border-primary/40 bg-primary/5 text-primary"
                          : "border-border bg-muted/40 text-muted-foreground"
                      }`}
                    >
                      <LayersIcon className="size-3 shrink-0" data-icon="inline-start" />
                      {isZh ? fieldKey : FIELD_EN[fieldKey] ?? conf.f}
                    </span>
                  )}
                  {/* 截止时间（浏览器本地时区） */}
                  <div className="flex items-center gap-1.5 pt-1 text-xs tabular-nums text-muted-foreground">
                    <ClockIcon className="size-3.5 shrink-0" data-icon="inline-start" />
                    <span className="font-medium text-foreground">
                      {dateFmt.format(new Date(main.utc))}
                    </span>
                  </div>
                  {/* 地点与会议时间 */}
                  <div className="flex flex-col gap-1 text-xs text-muted-foreground">
                    {year.place && (
                      <div className="flex items-center gap-1.5">
                        <MapPinIcon className="size-3.5 shrink-0" data-icon="inline-start" />
                        <span className="truncate" title={year.place}>
                          {year.place}
                        </span>
                      </div>
                    )}
                    {year.date && (
                      <div className="flex items-center gap-1.5">
                        <CalendarDaysIcon className="size-3.5 shrink-0" data-icon="inline-start" />
                        <span className="truncate" title={year.date}>
                          {year.date}
                        </span>
                      </div>
                    )}
                  </div>
                  {/* 底部操作：官网 + 日历 */}
                  <div className="mt-auto flex items-center justify-between gap-2 border-t pt-2">
                    {year.link ? (
                      <a
                        href={year.link}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        className="inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-primary"
                      >
                        {t("website")}
                        <ExternalLinkIcon className="size-3" data-icon="inline-end" />
                      </a>
                    ) : null}
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        render={
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={t("addToCalendar")}
                            onClick={(e) => e.stopPropagation()}
                          />
                        }
                      >
                        <CalendarPlusIcon data-icon="default" />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        {isOwner && (
                          <DropdownMenuItem
                            onClick={(e) => {
                              // 阻止冒泡：菜单项是卡片组件树子节点，React 合成事件会冒泡到卡片（触发详情 Dialog）
                              e.stopPropagation();
                              handleAddToCaldav(conf, year, main, label);
                            }}
                          >
                            {t("addToCaldav")}
                          </DropdownMenuItem>
                        )}
                        <DropdownMenuItem
                          onClick={(e) => {
                            e.stopPropagation();
                            const params = new URLSearchParams({
                              action: "TEMPLATE",
                              text: `${conf.a} ${year.y} ${label}`,
                              dates: `${toIcsUtc(main.utc)}/${toIcsUtc(main.utc + 3_600_000)}`,
                              details: `${conf.n}\nDeadline: ${main.entry.t} (${displayTz(year.tz)})\nDates: ${year.date ?? ""}\nLocation: ${year.place ?? ""}`,
                              location: year.place ?? "",
                              ctz: "UTC",
                            });
                            window.open(`https://calendar.google.com/calendar/render?${params}`, "_blank");
                          }}
                        >
                          {t("googleCalendar")}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={(e) => {
                            e.stopPropagation();
                            const ics = buildIcsText({
                              uid: `${conf.a}-${year.y}-${Date.now()}@shaoyuanyu.cn`,
                              summary: `${conf.a} ${year.y} ${label}`,
                              description: `${conf.n}\nDeadline: ${main.entry.t} (${displayTz(year.tz)})\nDates: ${year.date ?? ""}\nLocation: ${year.place ?? ""}`,
                              url: year.link,
                              start: main.utc,
                              end: main.utc + 3_600_000,
                            });
                            const blob = new Blob([ics], {
                              type: "text/calendar;charset=utf-8",
                            });
                            const a = document.createElement("a");
                            a.href = URL.createObjectURL(blob);
                            a.download = `${conf.a.toLowerCase()}-${year.y}.ics`;
                            document.body.appendChild(a);
                            a.click();
                            a.remove();
                          }}
                        >
                          {t("icsDownload")}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* 会议详情 Dialog（仅展示点击的会议年份） */}
      <Dialog
        open={openItem !== null}
        onOpenChange={(open) => !open && setOpenItem(null)}
      >
        <DialogContent className="max-w-lg">
          {openItem && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2 text-xl">
                  {openItem.conf.a} {openItem.year.y}
                  <LevelBadge level={openItem.conf.l === "" ? "none" : openItem.conf.l} />
                </DialogTitle>
                <DialogDescription>{openItem.conf.n}</DialogDescription>
              </DialogHeader>
              <div className="space-y-4">
                <div className="rounded-xl border p-3.5">
                  <div className="mb-2 flex flex-wrap items-center gap-2 text-sm font-semibold">
                    {openItem.best && (
                      <Badge variant="secondary" className="text-[10px] font-normal">
                        {t("upcoming")}
                      </Badge>
                    )}
                    <span className="text-xs font-normal text-muted-foreground">
                      {t("localTime", { tz: localTzOffset() })}
                    </span>
                  </div>
                  <ul className="space-y-1.5">
                    {openItem.year.timeline
                      .map((e) => ({ e, utc: zonedToUtcMs(e.t, openItem.year.tz) }))
                      .sort((x, y) => x.utc - y.utc)
                      .map(({ e, utc }, i) => (
                        <li
                          key={`${e.t}-${i}`}
                          className="flex flex-wrap items-baseline gap-x-2 text-sm"
                        >
                          <Badge variant="outline" className="shrink-0 text-[10px] font-normal">
                            {t(e.k ?? "paper")}
                          </Badge>
                          <span className="tabular-nums">
                            {dateFmt.format(new Date(utc))}
                          </span>
                          {e.c && (
                            <span className="text-xs text-muted-foreground">· {e.c}</span>
                          )}
                        </li>
                      ))}
                  </ul>
                  {(openItem.year.date || openItem.year.place) && (
                    <p className="mt-2.5 text-xs text-muted-foreground">
                      {[openItem.year.date, openItem.year.place].filter(Boolean).join(" · ")}
                    </p>
                  )}
                </div>
              </div>
              <DialogFooter className="flex-wrap gap-2">
                {openItem.conf.d && (
                  <a
                    href={openItem.conf.d}
                    target="_blank"
                    rel="noopener noreferrer"
                    data-slot="button"
                    className={buttonVariants({ variant: "outline", size: "sm" })}
                  >
                    <ExternalLinkIcon data-icon="inline-start" />
                    DBLP
                  </a>
                )}
                {openItem.year.link && (
                  <a
                    href={openItem.year.link}
                    target="_blank"
                    rel="noopener noreferrer"
                    data-slot="button"
                    className={buttonVariants({ variant: "outline", size: "sm" })}
                  >
                    <Globe2Icon data-icon="inline-start" />
                    {t("website")}
                  </a>
                )}
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
