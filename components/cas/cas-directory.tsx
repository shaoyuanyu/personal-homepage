"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import {
  BookOpenIcon,
  BookMarkedIcon,
  RotateCcwIcon,
  ShieldCheckIcon,
  TagsIcon,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { SearchInput } from "@/components/ui/search-input";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useOwnerPreferences } from "@/lib/preferences/use-owner-preferences";
import { cas, type CasEntry, type CasSub, type CasZone } from "@/lib/data";
import { casBarClass, casChipClass, casDotClass } from "@/lib/design/grade";

type ZoneFilter = "all" | "1" | "2" | "3" | "4";
type TopFilter = "all" | "top" | "non";

/* ---- 分区专属配色：见 lib/design/grade.ts（与 ccf / deadlines / venues 同一事实来源）---- */

/** Top 期刊徽章（行内标题旁金色胶囊） */
function TopBadge({ show }: { show: boolean }) {
  const t = useTranslations("cas");
  if (!show) return null;
  return (
    <Badge
      variant="outline"
      className="eyebrow-label shrink-0 px-2 py-0 font-semibold text-amber-700 ring-amber-700/30 dark:text-amber-500 dark:ring-amber-500/30"
    >
      {t("topBadge")}
    </Badge>
  );
}

/** 期刊名里的 WoS 收录（ESCI 等灰色、SCIE 主色、On Hold 警示色） */
function WosChip({ w }: { w: string }) {
  const t = useTranslations("cas");
  const clean = w.replace(/OnHold|Suppressed/g, "").trim();
  const onHold = /OnHold|Suppressed/.test(w);
  const isS = clean.includes("SCIE") || clean.includes("SSCI");
  return (
    <Badge
      variant="secondary"
      className={`eyebrow-label hidden shrink-0 font-normal sm:inline-flex ${
        onHold
          ? "text-amber-700 dark:text-amber-500"
          : isS
            ? "text-primary"
            : "text-muted-foreground"
      }`}
    >
      {clean || w}
      {onHold ? ` · ${t("wosOnHold")}` : ""}
    </Badge>
  );
}

/* ---- 小类（JCR 学科）chips 展示（超宽屏常驻列；窄屏收进图标 tooltip） ---- */

/** 学科分区点色：整串静态类由 lib/design/grade.ts 提供 */

/** 学科本地化显示名 */
function subName(sub: CasSub, isZh: boolean) {
  return isZh ? sub.zh : sub.en;
}

/**
 * 期刊行小类信息：
 * - 超宽屏（xl+）：右侧常驻小类列（色点 + 本地化名 + 排名，hover 有中英对照 tooltip）
 * - 窄屏（< xl）：折叠为一个学科图标，hover 弹出完整小类列表
 */
function Subjects({ entry }: { entry: CasEntry }) {
  const t = useTranslations("cas");
  const isZh = useLocale() === "zh";

  return (
    <>
      {/* 超宽屏常驻列 */}
      <span className="hidden max-w-md shrink-0 flex-col items-end gap-1 xl:flex">
        {entry.s.map((sub) => (
          <span
            key={sub.en}
            className="inline-flex max-w-full items-center gap-1.5 overflow-hidden text-ellipsis whitespace-nowrap text-xs leading-none text-muted-foreground"
            title={t("subjectTooltip", {
              zh: sub.zh,
              en: sub.en,
              rank: sub.r,
              total: sub.t,
            })}
          >
            <span
              aria-hidden
              className={`size-1 shrink-0 rounded-full ${casDotClass(sub.l)}`}
            />
            <span className="truncate">{subName(sub, isZh)}</span>
            <span className="shrink-0 tabular-nums text-muted-foreground">
              {sub.l} [{sub.r}/{sub.t}]
            </span>
          </span>
        ))}
      </span>

      {/* 窄屏：学科图标 + hover 弹出完整小类列表 */}
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label={t("subjectsLabel")}
              className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground xl:hidden"
            />
          }
        >
          <TagsIcon className="size-3.5" aria-hidden />
        </TooltipTrigger>
        <TooltipContent side="left" align="start" className="max-w-xs">
          <span className="flex w-full flex-col gap-1.5 py-0.5">
            {/* 小类学科标题：**不用 .eyebrow-label**——zh 文案是中文，放等宽会拉取
                1.3MB 的 cjk 分片，且中英文案（小类学科 / JCR Subjects）会不对称。 */}
            <span className="block text-xs font-semibold text-background/85">
              {t("subjectsLabel")}
            </span>
            {entry.s.map((sub) => (
              <span
                key={sub.en}
                className="flex min-w-0 items-baseline gap-1.5 text-left"
              >
                <span
                  aria-hidden
                  className={`mt-1.5 size-1 shrink-0 self-start rounded-full ${casDotClass(sub.l)}`}
                />
                {/* 中英对照名（当前语言在前） */}
                <span className="min-w-0 leading-snug">
                  {subName(sub, isZh)}
                  <span className="text-background/60"> · {isZh ? sub.en : sub.zh}</span>
                </span>
                <span className="ml-auto shrink-0 tabular-nums text-background/70">
                  {sub.l} [{sub.r}/{sub.t}]
                </span>
              </span>
            ))}
          </span>
        </TooltipContent>
      </Tooltip>
    </>
  );
}

/* ---- 分区徽章（大类分区号） ---- */
function ZoneBadge({ zone }: { zone: CasZone }) {
  const t = useTranslations("cas");
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      <Badge
        variant="outline"
        className={`eyebrow-label w-7 shrink-0 justify-center rounded-md font-bold ring-1 ring-inset ${casChipClass(zone)}`}
        aria-label={`${zone} ${t("zone")}`}
      >
        {zone}
      </Badge>
    </span>
  );
}

/* ---- 数据展示主表行 ---- */
function EntryRow({ entry }: { entry: CasEntry }) {
  const t = useTranslations("cas");
  // entry.m = [大类中文名, 分区, 大类内排名, 大类内总数]
  const [, mainZone, mainRank, mainTotal] = entry.m;
  return (
    <li className="group relative flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-muted/60">
      {/* 分区色条 */}
      <span
        aria-hidden
        className={`absolute inset-y-1 left-0 w-[3px] rounded-r-full opacity-0 transition-opacity group-hover:opacity-100 ${casBarClass(mainZone)}`}
      />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 truncate text-sm font-medium tracking-tight">
            {entry.n}
          </span>
          <TopBadge show={entry.top} />
        </span>
        <span className="truncate text-xs text-muted-foreground">
          {entry.i ? `ISSN ${entry.i}` : ""}
          <span className="mx-1.5 text-muted-foreground">·</span>
          {t("rank")} {mainRank}/{mainTotal}
          <WosChip w={entry.w} />
        </span>
      </span>
      <Subjects entry={entry} />
      <ZoneBadge zone={mainZone} />
    </li>
  );
}

/** 顶部统计卡片 */
function StatCard({
  icon: Icon,
  value,
  label,
  highlight = false,
}: {
  icon: typeof BookOpenIcon;
  value: number | string;
  label: string;
  highlight?: boolean;
}) {
  return (
    <Card
      className={`py-0 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md ${
        highlight ? "border-primary/30 bg-primary/5" : "hover:border-border"
      }`}
    >
      <CardContent className="flex items-center gap-3 p-3.5 sm:p-4">
        <div
          className={`flex size-9 shrink-0 items-center justify-center rounded-lg ${
            highlight
              ? "bg-primary/15 text-primary"
              : "bg-muted text-muted-foreground"
          }`}
        >
          <Icon className="size-5" />
        </div>
        <div className="min-w-0">
          <p className="text-xl font-mono leading-none font-semibold tracking-tight">
            {value}
          </p>
          <p className="mt-1.5 truncate text-xs text-muted-foreground">{label}</p>
        </div>
      </CardContent>
    </Card>
  );
}

export function CasDirectory() {
  const t = useTranslations("cas");

  const { ready, prefs, setPref } = useOwnerPreferences();

  const [query, setQuery] = useState("");
  const [zone, setZone] = useState<ZoneFilter>("all");
  const [top, setTop] = useState<TopFilter>("all");

  /** 期刊是否命中某分区（大类） */
  const entryInZone = (e: CasEntry, z: string) => e.m[1] === z;

  /** 期刊名 → ISSN 搜索词（数据无缩写字段，ISSN 兜底） */
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

  const filtered = useMemo(() => {
    const q = norm(query.trim());
    return cas.rows.filter((e) => {
      if (zone !== "all" && !entryInZone(e, zone)) return false;
      if (top === "top" && !e.top) return false;
      if (top === "non" && e.top) return false;
      if (!q) return true;
      return (
        norm(e.n).includes(q) ||
        norm(e.i).includes(q) ||
        norm(e.w).includes(q) ||
        e.s.some((s) => norm(s.en).includes(q) || norm(s.zh).includes(q))
      );
    });
  }, [query, zone, top]);

  const shown = filtered.length;
  const zones = useMemo(() => {
    const count: Record<string, number> = { "1": 0, "2": 0, "3": 0, "4": 0 };
    for (const e of cas.rows) count[e.m[1]] += 1;
    return count;
  }, []);

  const resetFilters = () => {
    setQuery("");
    setZone("all");
    setTop("all");
  };

  // 偏好持久化 key（与 ccf:filters 同模式：游客 localStorage / 主人服务器）
  const STORAGE_KEY = "cas:filters";

  type SavedFilters = {
    q?: string;
    zone?: ZoneFilter;
    top?: TopFilter;
  };

  // 首次恢复：URL 参数优先 → 偏好
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current) return;
    const p = new URLSearchParams(window.location.search);
    const z = p.get("zone");
    const tp = p.get("top");
    const q = p.get("q");
    if (z || tp || q !== null) {
      if (q !== null) setQuery(q);
      if (z === "1" || z === "2" || z === "3" || z === "4") setZone(z);
      if (tp === "top" || tp === "non") setTop(tp);
      restored.current = true;
      return;
    }
    if (!ready) return; // 偏好加载中
    restored.current = true;
    const saved = prefs[STORAGE_KEY] as SavedFilters | undefined;
    if (saved) {
      setQuery(saved.q ?? "");
      if (saved.zone === "1" || saved.zone === "2" || saved.zone === "3" || saved.zone === "4")
        setZone(saved.zone);
      if (saved.top === "top" || saved.top === "non") setTop(saved.top);
    }
  }, [ready, prefs]);

  // 状态变化 → URL + 偏好（跳过首次挂载，避免覆盖已存偏好）
  const hasPersisted = useRef(false);
  useEffect(() => {
    if (!hasPersisted.current) {
      hasPersisted.current = true;
      return;
    }
    const p = new URLSearchParams();
    if (zone !== "all") p.set("zone", zone);
    if (top !== "all") p.set("top", top);
    const q = query.trim();
    if (q) p.set("q", q);
    const qs = p.toString();
    const url = qs ? `${window.location.pathname}?${qs}` : window.location.pathname;
    window.history.replaceState(null, "", url);
    setPref(STORAGE_KEY, { q, zone, top } satisfies SavedFilters);
  }, [zone, top, query, setPref]);

  const statsZ1 = zones["1"];
  const total = cas.rows.length;
  const topCount = cas.rows.filter((e) => e.top).length;

  return (
    <div className="flex flex-col gap-8">
      {/* 统计卡片 */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard icon={BookOpenIcon} value={total} label={t("statsTotal")} highlight />
        <StatCard icon={BookMarkedIcon} value={statsZ1} label={t("statsZone1")} />
        <StatCard icon={ShieldCheckIcon} value={topCount} label={t("statsTop")} />
        <StatCard
          icon={BookOpenIcon}
          value={cas.rows.filter((e) => e.w.includes("SCIE")).length}
          label={t("statsSCIE")}
        />
      </div>

      {/* sticky 筛选栏 */}
      <div className="sticky top-14 z-30 rounded-2xl border bg-background/85 px-3 py-3 shadow-sm backdrop-blur supports-[backdrop-filter]:bg-background/70">
        <div className="flex flex-wrap items-center gap-2">
          <SearchInput
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("searchPlaceholder")}
            className="w-full sm:w-64 lg:w-72"
            clearLabel={t("clearSearch")}
            aria-label={t("searchPlaceholder")}
          />

          <ToggleGroup
            value={[zone]}
            onValueChange={(v) => setZone((v[0] as ZoneFilter) ?? "all")}
            className="ccf-segmented flex-wrap"
            aria-label={t("zoneAllLabel")}
          >
            <ToggleGroupItem value="all">{t("zoneAll")}</ToggleGroupItem>
            <ToggleGroupItem value="1">{t("zone1")}</ToggleGroupItem>
            <ToggleGroupItem value="2">{t("zone2")}</ToggleGroupItem>
            <ToggleGroupItem value="3">{t("zone3")}</ToggleGroupItem>
            <ToggleGroupItem value="4">{t("zone4")}</ToggleGroupItem>
          </ToggleGroup>

          <ToggleGroup
            value={[top]}
            onValueChange={(v) => setTop((v[0] as TopFilter) ?? "all")}
            className="ccf-segmented flex-wrap"
            aria-label={t("topFilter")}
          >
            <ToggleGroupItem value="all">{t("topAll")}</ToggleGroupItem>
            <ToggleGroupItem value="top">{t("topOnly")}</ToggleGroupItem>
            <ToggleGroupItem value="non">{t("topNone")}</ToggleGroupItem>
          </ToggleGroup>

          {/* ⚠ 不要用 font-mono：本元素含中文「本」（同 CCF 页的「项」）。 */}
          <Badge
            variant="outline"
            className="ml-auto hidden shrink-0 tabular-nums font-normal text-muted-foreground lg:inline-flex"
          >
            {shown} {t("items")}
          </Badge>
        </div>
      </div>

      {/* 小类学科筛选已移除：页面仅按大类分区/Top/搜索过滤，期刊行内仍展示所属小类信息 */}

      {/* 匹配统计 */}
      <p className="text-xs text-muted-foreground">
        {t("stats", { total, z1: statsZ1, top: topCount, matched: shown })}
      </p>

      {shown === 0 ? (
        <Empty>
          <EmptyMedia variant="icon">
            <BookMarkedIcon aria-hidden />
          </EmptyMedia>
          <EmptyHeader>
            <EmptyTitle>{t("empty")}</EmptyTitle>
          </EmptyHeader>
          <Button variant="outline" size="sm" onClick={resetFilters}>
            <RotateCcwIcon />
            {t("resetFilters")}
          </Button>
        </Empty>
      ) : (
        <ul className="divide-y divide-border/60 overflow-hidden rounded-xl border bg-card">
          {filtered.map((e) => (
            <EntryRow key={e.n} entry={e} />
          ))}
        </ul>
      )}
    </div>
  );
}
