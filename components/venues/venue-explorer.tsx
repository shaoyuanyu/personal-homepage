"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import {
  BookOpenIcon,
  CalendarDaysIcon,
  ExternalLinkIcon,
  FlameIcon,
  Globe2Icon,
  LayersIcon,
  MapPinIcon,
  PresentationIcon,
  SearchIcon,
  TagsIcon,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { SearchInput } from "@/components/ui/search-input";
import {
  casBarClass,
  casChipClass,
  casDotClass,
  ccfBarClass,
  ccfChipClass,
} from "@/lib/design/grade";
import {
  FIELD_EN,
  normSearch,
  venueConferences,
  venueJournals,
  type VenueConference,
  type VenueJournal,
} from "@/lib/data/venue";
import type { DeadlineTimelineEntry, DeadlineYear } from "@/lib/data";
import { localTzOffset, zonedToUtcMs } from "@/lib/utils/tz";

/** 本地化日期时间格式器（模块级缓存） */
const dateFmtCache = new Map<string, Intl.DateTimeFormat>();
function fmtDateTime(utc: number, isZh: boolean): string {
  const key = isZh ? "zh-CN" : "en-US";
  let f = dateFmtCache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(key, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    dateFmtCache.set(key, f);
  }
  return f.format(new Date(utc));
}

/* ---------------- 领域展示（en 精简名，与 /deadlines 页一致） ---------------- */

const FIELD_EN_SHORT: Record<string, string> = {
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

/* ---------------- 徽章/色条配色：见 lib/design/grade.ts ---------------- */

/** 徽章胶囊统一规格：不是「等级色」的胶囊都由 TONE_CHIP 提供底色 */

/* ---------------- deadline 信息计算 ---------------- */

type MainDeadline = {
  utc: number;
  entry: DeadlineTimelineEntry;
  labelKey: "abstract" | "paper";
};

type ConfDeadline = {
  /** 未来最近 deadline（跨年份） */
  future: { utc: number; main: MainDeadline; year: DeadlineYear } | null;
  /** 已过最近 deadline */
  past: { utc: number; main: MainDeadline; year: DeadlineYear } | null;
};

/** 会议整体（跨年份）deadline 摘要：未来最近 + 已过最近 */
function confDeadline(conf: VenueConference, now = Date.now()): ConfDeadline {
  let best: ConfDeadline["future"] = null;
  let bestPast: ConfDeadline["past"] = null;
  for (const year of conf.years) {
    for (const entry of year.timeline) {
      const utc = zonedToUtcMs(entry.t, year.tz);
      const main: MainDeadline = { utc, entry, labelKey: entry.k ?? "paper" };
      if (utc >= now) {
        if (!best || utc < best.utc) best = { utc, main, year };
      } else if (!bestPast || utc > bestPast.utc) {
        bestPast = { utc, main, year };
      }
    }
  }
  return { future: best, past: bestPast };
}

/* ---------------- 徽章小组件 ---------------- */

/** CCF 等级药丸徽章（会议，带 CCF- 前缀，与期刊一致） */
function CcfLevelBadge({ level }: { level: "A" | "B" | "C" | "" }) {
  const t = useTranslations("venues");
  if (!level) {
    return (
      <Badge
        variant="outline"
        className="shrink-0 px-2 py-0 text-xs font-medium text-muted-foreground ring-border"
        aria-label={t("confNotRanked")}
        title={t("confNotRankedTitle")}
      >
        {t("confNotRanked")}
      </Badge>
    );
  }
  return (
    <Badge
      variant="outline"
      className={`eyebrow-label shrink-0 px-2 py-0 font-bold ring-1 ring-inset ${ccfChipClass(level)}`}
      aria-label={`CCF ${level}`}
      title={`CCF-${level}`}
    >
      CCF-{level}
    </Badge>
  );
}

/** CCF 等级药丸徽章（期刊，带 CCF- 前缀与分区数字方徽区分） */
function JourCcfBadge({ level }: { level: "A" | "B" | "C" | "" }) {
  const t = useTranslations("venues");
  if (!level) {
    return (
      <Badge
        variant="outline"
        className="shrink-0 px-2 py-0 text-xs font-medium text-muted-foreground ring-border"
        aria-label={t("jourNotRanked")}
        title={t("jourNotRankedTitle")}
      >
        {t("jourNotRanked")}
      </Badge>
    );
  }
  return (
    <Badge
      variant="outline"
      className={`eyebrow-label shrink-0 px-2 py-0 font-bold ring-1 ring-inset ${ccfChipClass(level)}`}
      aria-label={`CCF ${level}`}
      title={`CCF ${level}`}
    >
      CCF-{level}
    </Badge>
  );
}

/** 中科院大类分区方徽（期刊） */
function CasZoneBadge({ zone }: { zone?: string }) {
  const t = useTranslations("venues");
  if (!zone) {
    return (
      <Badge
        variant="outline"
        className={`eyebrow-label w-7 shrink-0 justify-center rounded-md font-medium ring-border ${casChipClass(zone)}`}
        aria-label={t("casNotRanked")}
        title={t("casNotRankedTitle")}
      >
        —
      </Badge>
    );
  }
  return (
    <Badge
      variant="outline"
      className={`eyebrow-label w-7 shrink-0 justify-center rounded-md font-bold ring-1 ring-inset ${casChipClass(zone)}`}
      aria-label={t("zoneAria", { zone })}
      title={t("zoneAria", { zone })}
    >
      {zone}
    </Badge>
  );
}

/* ---------------- 搜索 ---------------- */

const RESULT_CAP = 24;

function matchScore(q: string, abbr: string, name: string, extra: string[]) {
  const a = normSearch(abbr);
  const n = normSearch(name);
  if (a === q) return 0;
  if (n === q) return 0;
  if (a.startsWith(q)) return 1;
  if (n.startsWith(q)) return 2;
  if (a.includes(q) || n.includes(q)) return 3;
  for (const e of extra) {
    if (e && normSearch(e).includes(q)) return 4;
  }
  return null;
}

/* ================================================================ */
/* 主组件                                                            */
/* ================================================================ */

export function VenueExplorer() {
  const t = useTranslations("venues");
  const locale = useLocale();
  const isZh = locale === "zh";

  const [query, setQuery] = useState("");
  const [openConf, setOpenConf] = useState<VenueConference | null>(null);

  /* URL ?q= 恢复（可分享/刷新） */
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current) return;
    restored.current = true;
    const q = new URLSearchParams(window.location.search).get("q");
    if (q) setQuery(q);
  }, []);

  /* 输入即同步 URL（不做偏好持久化——打开页面即旧搜索词不友好） */
  useEffect(() => {
    const q = query.trim();
    const url = q
      ? `${window.location.pathname}?q=${encodeURIComponent(q)}`
      : window.location.pathname;
    window.history.replaceState(null, "", url);
  }, [query]);

  const { confs, jours, hasQuery } = useMemo(() => {
    const q = normSearch(query.trim());
    if (!q) return { confs: [], jours: [], hasQuery: false };

    const confs = venueConferences
      .map((c) => ({
        c,
        score: matchScore(q, c.a, c.n, [c.f, FIELD_EN[c.f] ?? ""]),
      }))
      .filter((x): x is { c: VenueConference; score: number } => x.score !== null)
      .sort((x, y) => x.score - y.score || x.c.a.localeCompare(y.c.a))
      .slice(0, RESULT_CAP)
      .map((x) => x.c);

    const jours = venueJournals
      .map((j) => ({
        j,
        score: matchScore(q, j.a ?? "", j.n, [
          j.f ?? "",
          FIELD_EN[j.f ?? ""] ?? "",
          j.issn ?? "",
          ...(j.subs ?? []).flatMap((s) => [s.zh, s.en]),
        ]),
      }))
      .filter((x): x is { j: VenueJournal; score: number } => x.score !== null)
      .sort((x, y) => x.score - y.score || x.j.n.localeCompare(y.j.n))
      .slice(0, RESULT_CAP)
      .map((x) => x.j);

    return { confs, jours, hasQuery: true };
  }, [query]);

  /* 热门速查：即将截稿的 CCF-A 会议 + 双顶期刊（CCF-A ∩ 中科院 1 区 Top） */
  const hotConfs = useMemo(() => {
    const now = Date.now();
    return venueConferences
      .map((c) => ({ c, dl: confDeadline(c, now) }))
      .filter((x): x is { c: VenueConference; dl: ConfDeadline } => x.dl.future !== null)
      .filter((x) => x.c.l === "A")
      .sort((x, y) => x.dl.future!.utc - y.dl.future!.utc)
      .slice(0, 6)
      .map((x) => x.c);
  }, []);

  const hotJours = useMemo(
    () =>
      venueJournals
        .filter((j) => j.l === "A" && j.zone === "1" && j.top)
        .sort((x, y) => (x.rank ?? 1e9) - (y.rank ?? 1e9))
        .slice(0, 6),
    [],
  );

  const applyQuery = (v: string) => {
    setQuery(v);
    setOpenConf(null);
  };

  return (
    <div className="flex flex-col gap-8">
      {/* sticky 搜索栏 */}
      <div className="sticky top-14 z-30 rounded-2xl border bg-background/85 px-3 py-3 shadow-sm backdrop-blur supports-[backdrop-filter]:bg-background/70">
        <SearchInput
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("searchPlaceholder")}
          className="w-full"
          clearLabel={t("clearSearch")}
          aria-label={t("searchPlaceholder")}
        />
      </div>

      {!hasQuery ? (
        /* ---------- 默认态：引导 + 热门速查 ---------- */
        <div className="flex flex-col items-center gap-8 pt-4">
          <p className="max-w-xl text-center text-sm text-muted-foreground">
            {t("heroPrompt")}
          </p>

          <div className="w-full space-y-8">
            {/* 热门会议：即将截稿的 CCF-A */}
            <section aria-label={t("hotConfLabel")} className="space-y-3">
              <h2 className="flex items-center gap-2 text-sm font-semibold tracking-tight text-muted-foreground">
                <FlameIcon className="size-4 text-orange-500" aria-hidden />
                {t("hotConfLabel")}
              </h2>
              <div className="flex flex-wrap gap-1.5">
                {hotConfs.map((c) => (
                  <Button
                    key={c.a}
                    type="button"
                    variant="outline"
                    size="sm"
                    className="rounded-full font-mono text-xs"
                    title={c.n}
                    onClick={() => applyQuery(c.a)}
                  >
                    {c.a}
                  </Button>
                ))}
              </div>
            </section>

            {/* 热门期刊：双顶期刊 */}
            <section aria-label={t("hotJourLabel")} className="space-y-3">
              <h2 className="flex items-center gap-2 text-sm font-semibold tracking-tight text-muted-foreground">
                <FlameIcon className="size-4 text-amber-500" aria-hidden />
                {t("hotJourLabel")}
              </h2>
              <div className="flex flex-wrap gap-1.5">
                {hotJours.map((j) => (
                  <Button
                    key={j.n}
                    type="button"
                    variant="outline"
                    size="sm"
                    className="rounded-full font-mono text-xs"
                    title={j.n}
                    onClick={() => applyQuery(j.a || j.n)}
                  >
                    {j.a || j.n.slice(0, 24)}
                  </Button>
                ))}
              </div>
            </section>
          </div>
        </div>
      ) : (
        /* ---------- 结果态：会议 | 期刊 两栏并排 ---------- */
        <div className="flex flex-col gap-6">
          <p className="text-xs text-muted-foreground" role="status">
            {t("stats", { confs: confs.length, jours: jours.length })}
          </p>

          <div className="grid grid-cols-1 gap-8 lg:grid-cols-2 lg:gap-6">
            {/* 会议栏 */}
            <section aria-label={t("confsHeading")} className="min-w-0 space-y-3">
              <h2 className="flex items-center gap-2 text-base font-semibold tracking-tight">
                <PresentationIcon className="size-4 text-muted-foreground" aria-hidden />
                {t("confsHeading")}
                <Badge variant="secondary" className="tabular-nums">
                  {confs.length} {t("confItems")}
                </Badge>
              </h2>
              {confs.length === 0 ? (
                <Empty className="py-10">
                  <EmptyMedia variant="icon">
                    <PresentationIcon aria-hidden />
                  </EmptyMedia>
                  <EmptyHeader>
                    <EmptyTitle>{t("noConf")}</EmptyTitle>
                  </EmptyHeader>
                </Empty>
              ) : (
                <>
                  <ul className="space-y-2.5">
                    {confs.map((c) => (
                      <ConferenceCard
                        key={`${c.a}-${c.n}`}
                        conf={c}
                        isZh={isZh}
                        onOpen={() => setOpenConf(c)}
                      />
                    ))}
                  </ul>
                  {confs.length === RESULT_CAP && (
                    <p className="px-1 text-xs text-muted-foreground">
                      {t("tooMany", { n: RESULT_CAP })}
                    </p>
                  )}
                </>
              )}
            </section>

            {/* 期刊栏 */}
            <section aria-label={t("joursHeading")} className="min-w-0 space-y-3">
              <h2 className="flex items-center gap-2 text-base font-semibold tracking-tight">
                <BookOpenIcon className="size-4 text-muted-foreground" aria-hidden />
                {t("joursHeading")}
                <Badge variant="secondary" className="tabular-nums">
                  {jours.length} {t("jourItems")}
                </Badge>
              </h2>
              {jours.length === 0 ? (
                <Empty className="py-10">
                  <EmptyMedia variant="icon">
                    <BookOpenIcon aria-hidden />
                  </EmptyMedia>
                  <EmptyHeader>
                    <EmptyTitle>{t("noJour")}</EmptyTitle>
                  </EmptyHeader>
                </Empty>
              ) : (
                <>
                  <ul className="space-y-2.5">
                    {jours.map((j) => (
                      <JournalCard key={j.n} jour={j} isZh={isZh} />
                    ))}
                  </ul>
                  {jours.length === RESULT_CAP && (
                    <p className="px-1 text-xs text-muted-foreground">
                      {t("tooMany", { n: RESULT_CAP })}
                    </p>
                  )}
                </>
              )}
            </section>
          </div>

          {confs.length === 0 && jours.length === 0 && (
            <Empty className="py-12">
              <EmptyMedia variant="icon">
                <SearchIcon aria-hidden />
              </EmptyMedia>
              <EmptyHeader>
                <EmptyTitle>{t("noResults")}</EmptyTitle>
                <EmptyDescription>{t("noResultsHint")}</EmptyDescription>
              </EmptyHeader>
              <Button variant="outline" size="sm" onClick={() => applyQuery("")}>
                {t("resetFilters")}
              </Button>
            </Empty>
          )}
        </div>
      )}

      {/* 会议详情 Dialog */}
      <ConfDialog conf={openConf} isZh={isZh} onClose={() => setOpenConf(null)} />
    </div>
  );
}

/* ---------------- 会议卡 ---------------- */

function ConferenceCard({
  conf,
  isZh,
  onOpen,
}: {
  conf: VenueConference;
  isZh: boolean;
  onOpen: () => void;
}) {
  const { future, past } = confDeadline(conf);
  const main = future ?? past;

  return (
    <li className="list-none">
      <button
        type="button"
        onClick={onOpen}
        className="group relative flex w-full cursor-pointer flex-col gap-1.5 rounded-xl border bg-card p-3 text-left transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md"
      >
        {/* 等级色条 */}
        <span
          aria-hidden
          className={`absolute inset-y-2 left-0 w-[3px] rounded-r-full ${
            conf.l ? ccfBarClass(conf.l) : "bg-border"
          }`}
        />
        {/* L1：届别标题（缩写 + 主届年份小号弱化；无简称会议以全名为标题） + CCF 等级徽章 + 领域 */}
        <span className="flex items-center gap-2">
          <span className="flex min-w-0 items-baseline gap-1.5">
            {conf.a ? (
              <span className="truncate font-mono text-base font-medium tracking-tight">
                {conf.a}
              </span>
            ) : (
              <span
                className="min-w-0 truncate text-sm font-medium tracking-tight"
                title={conf.n}
              >
                {conf.n}
              </span>
            )}
            {main && (
              <span className="shrink-0 text-xs font-medium tabular-nums text-muted-foreground">
                {main.year.y}
              </span>
            )}
          </span>
          <CcfLevelBadge level={conf.l} />
          {conf.f && (
            <span className="hidden min-w-0 items-center gap-1 truncate text-xs text-muted-foreground sm:inline-flex">
              <LayersIcon className="size-3 shrink-0" aria-hidden />
              <span className="truncate">
                {isZh ? conf.f : FIELD_EN_SHORT[conf.f] ?? conf.f}
              </span>
            </span>
          )}
        </span>
        {/* L2：全称（无简称时已作标题行，不重复） */}
        {conf.a && (
          <span
            className="truncate text-sm text-muted-foreground transition-colors group-hover:text-foreground/80"
            title={conf.n}
          >
            {conf.n}
          </span>
        )}
        {/* 最近一次会议举办时间（截稿各节点时间在点开卡片后的 Dialog 中查看） */}
        {main?.year.date && (
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <CalendarDaysIcon className="size-3.5 shrink-0" data-icon="inline-start" />
            <span className="tabular-nums" title={main.year.date}>
              {main.year.date}
            </span>
          </span>
        )}
      </button>
    </li>
  );
}

/* ---------------- 期刊卡 ---------------- */

function JournalCard({ jour, isZh }: { jour: VenueJournal; isZh: boolean }) {
  const t = useTranslations("venues");
  const subs = jour.subs ?? [];
  const hasCas = jour.zone !== undefined;

  return (
    <li className="list-none">
      <div className="group relative flex flex-col gap-1.5 rounded-xl border bg-card p-3 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md">
        {/* 分区色条（有 CAS 分区按分区色，否则按 CCF 等级色） */}
        <span
          aria-hidden
          className={`absolute inset-y-2 left-0 w-[3px] rounded-r-full ${
            hasCas
              ? casBarClass(jour.zone!)
              : jour.l
                ? ccfBarClass(jour.l)
                : "bg-border"
          }`}
        />
        {/* L1：刊名 + 中科院分区方徽 */}
        <span className="flex items-center gap-2 pl-0.5">
          <span className="min-w-0 flex-1 truncate text-sm font-medium tracking-tight">
            {jour.n}
          </span>
          <CasZoneBadge zone={jour.zone} />
        </span>
        {/* L2：CCF 药丸徽章 + Top + 缩写/ISSN/排名/DBLP */}
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1 pl-0.5">
          <JourCcfBadge level={jour.l} />
          {jour.top && (
            <Badge
              variant="outline"
              className="eyebrow-label shrink-0 px-2 py-0 font-semibold text-amber-700 ring-amber-700/30 dark:text-amber-500 dark:ring-amber-500/30"
            >
              {t("top")}
            </Badge>
          )}
          <span className="min-w-0 text-xs tabular-nums text-muted-foreground">
            {jour.a && <span className="font-mono font-semibold">{jour.a}</span>}
            {jour.a && jour.issn && (
              <span className="mx-1 text-muted-foreground">·</span>
            )}
            {jour.issn && <span>ISSN {jour.issn}</span>}
            {jour.rank != null && jour.casTotal != null && (
              <>
                <span className="mx-1 text-muted-foreground">·</span>
                {t("rank", { rank: jour.rank, total: jour.casTotal })}
              </>
            )}
          </span>
          {jour.d && (
            <a
              href={jour.d}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`${jour.a ?? jour.n} on DBLP`}
              title="DBLP"
              className="-my-1 ml-auto shrink-0 rounded-md p-1 text-muted-foreground/80 transition-colors hover:bg-muted hover:text-primary"
            >
              <ExternalLinkIcon className="size-3.5" aria-hidden />
            </a>
          )}
        </span>
        {/* L3：小类学科（最多 2 个 + 溢出计数，title 看全量） */}
        {subs.length > 0 && (
          <span
            className="flex min-w-0 items-center gap-1.5 pl-0.5 text-xs text-muted-foreground"
            title={t("subjectsTitle", {
              list: subs.map((s) => (isZh ? s.zh : s.en)).join(" · "),
            })}
          >
            <TagsIcon className="size-3 shrink-0" aria-hidden />
            {subs.slice(0, 2).map((s) => (
              <span key={s.en} className="flex min-w-0 items-center gap-1">
                <span
                  aria-hidden
                  className={`size-1 shrink-0 rounded-full ${casDotClass(s.l)}`}
                />
                <span className="truncate">{isZh ? s.zh : s.en}</span>
              </span>
            ))}
            {subs.length > 2 && (
              <span className="shrink-0 text-muted-foreground">
                {t("subjectMore", { n: subs.length - 2 })}
              </span>
            )}
          </span>
        )}
      </div>
    </li>
  );
}

/* ---------------- 会议详情 Dialog ---------------- */

function ConfDialog({
  conf,
  isZh,
  onClose,
}: {
  conf: VenueConference | null;
  isZh: boolean;
  onClose: () => void;
}) {
  const t = useTranslations("venues");
  const now = Date.now();

  /* 年份：未来仍有截稿的在前，其余按年份降序（最多展示 3 届） */
  const years = useMemo(() => {
    if (!conf) return [];
    const byFuture = (y: DeadlineYear) =>
      y.timeline.some((e) => zonedToUtcMs(e.t, y.tz) >= Date.now());
    return [...conf.years]
      .sort((x, y) => Number(byFuture(y)) - Number(byFuture(x)) || y.y - x.y)
      .slice(0, 3);
  }, [conf]);

  return (
    <Dialog open={conf !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        {conf && (
          <>
            <DialogHeader>
              <DialogTitle className="flex flex-wrap items-center gap-2 text-xl">
                {conf.a ? (
                  <span className="font-mono">{conf.a}</span>
                ) : (
                  <span className="min-w-0">{conf.n}</span>
                )}
                <CcfLevelBadge level={conf.l} />
              </DialogTitle>
              {conf.a && <DialogDescription>{conf.n}</DialogDescription>}
            </DialogHeader>

            <div className="space-y-4">
              {conf.f && (
                <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <LayersIcon className="size-3.5" aria-hidden />
                  {isZh
                    ? conf.fFull ?? conf.f
                    : FIELD_EN[conf.f] ?? FIELD_EN_SHORT[conf.f] ?? conf.f}
                </p>
              )}

              {years.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("noDeadlineInfo")}</p>
              ) : (
                years.map((year) => {
                  const entries = [...year.timeline]
                    .map((e) => ({ e, utc: zonedToUtcMs(e.t, year.tz) }))
                    .sort((x, y) => x.utc - y.utc);
                  const hasFuture = entries.some((x) => x.utc >= now);
                  return (
                    <div key={year.y} className="rounded-xl border p-3.5">
                      <div className="mb-2 flex flex-wrap items-center gap-2">
                        <h3 className="text-sm font-semibold tabular-nums">{year.y}</h3>
                        {hasFuture && (
                          <Badge variant="secondary" className="text-xs font-normal">
                            {t("upcoming")}
                          </Badge>
                        )}
                        <span className="ml-auto text-xs text-muted-foreground">
                          {t("localTz", { tz: localTzOffset() })}
                        </span>
                      </div>
                      {(year.date || year.place) && (
                        <p className="mb-2 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                          {year.date && (
                            <span className="flex items-center gap-1">
                              <CalendarDaysIcon className="size-3.5" aria-hidden />
                              {year.date}
                            </span>
                          )}
                          {year.place && (
                            <span className="flex min-w-0 items-center gap-1">
                              <MapPinIcon className="size-3.5 shrink-0" aria-hidden />
                              <span className="truncate">{year.place}</span>
                            </span>
                          )}
                        </p>
                      )}
                      <ul className="space-y-1.5">
                        {entries.map(({ e, utc }, i) => {
                          const passed = utc < now;
                          return (
                            <li
                              key={`${e.t}-${i}`}
                              className={`flex flex-wrap items-baseline gap-x-2 text-sm ${
                                passed ? "opacity-55" : ""
                              }`}
                            >
                              <Badge
                                variant="outline"
                                className="shrink-0 text-xs font-normal"
                              >
                                {t(e.k ?? "paper")}
                              </Badge>
                              <span className="tabular-nums">
                                {fmtDateTime(utc, isZh)}
                              </span>
                              {e.c && (
                                <span className="text-xs text-muted-foreground">
                                  · {e.c}
                                </span>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                      {year.link && (
                        <p className="mt-2 flex min-w-0 items-center gap-1 text-xs">
                          <Globe2Icon className="size-3.5 shrink-0" aria-hidden />
                          <a
                            href={year.link}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="truncate text-primary underline-offset-4 hover:underline"
                          >
                            {year.link}
                          </a>
                        </p>
                      )}
                    </div>
                  );
                })
              )}
            </div>

            <DialogFooter>
              {conf.d && (
                <a
                  href={conf.d}
                  target="_blank"
                  rel="noopener noreferrer"
                  data-slot="button"
                  className={buttonVariants({ variant: "outline", size: "sm" })}
                >
                  <ExternalLinkIcon data-icon="inline-start" />
                  DBLP
                </a>
              )}
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
