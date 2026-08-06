"use client";

import { Fragment, useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import {
  AwardIcon,
  BookOpenIcon,
  LayersIcon,
  LayoutGridIcon,
  PresentationIcon,
  RotateCcwIcon,
  SearchIcon,
} from "lucide-react";

import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Empty } from "@/components/ui/empty";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { ccf, type CcfEntry } from "@/lib/data";

type TypeFilter = "all" | "conf" | "jour";
type LevelFilter = "all" | "A" | "B" | "C";

/** 领域英文名（数据中只有官方中文名） */
const FIELD_EN: Record<string, string> = {
  计算机体系结构: "Architecture, Parallel & Distributed Computing, Storage",
  计算机网络: "Computer Networks",
  网络与信息安全: "Network & Information Security",
  软件工程: "Software Engineering, System Software & Programming Languages",
  数据库: "Databases, Data Mining & Content Retrieval",
  计算机科学理论: "Computer Science Theory",
  计算机图形学与多媒体: "Computer Graphics & Multimedia",
  人工智能: "Artificial Intelligence",
  人机交互与普适计算: "HCI & Ubiquitous Computing",
  交叉: "Interdisciplinary & Emerging",
};

/* 领域名以「/」为界拆分后的第一段即官方领域短名，便于做键与展示 */
const FIELD_KEY = (field: string) => field.split("/")[0];

/* 级别专属配色：徽章文字 + 行首色条 */
const LEVEL_STYLE = {
  A: {
    badge: "bg-red-500/10 text-red-600 ring-red-600/20 dark:bg-red-500/15 dark:text-red-400",
    bar: "bg-red-500",
  },
  B: {
    badge: "bg-blue-500/10 text-blue-600 ring-blue-600/20 dark:bg-blue-500/15 dark:text-blue-400",
    bar: "bg-blue-500",
  },
  C: {
    badge: "bg-emerald-500/10 text-emerald-600 ring-emerald-600/20 dark:bg-emerald-500/15 dark:text-emerald-400",
    bar: "bg-emerald-500",
  },
} as const;

function LevelBadge({ level }: { level: CcfEntry["l"] }) {
  const t = useTranslations("ccf.levels");
  return (
    <Badge
      variant="outline"
      className={`w-7 shrink-0 justify-center rounded-md text-xs font-bold ring-1 ring-inset ${LEVEL_STYLE[level].badge}`}
      aria-label={`${level} ${t("class")}`}
    >
      {level}
    </Badge>
  );
}

function EntryRow({ entry, type }: { entry: CcfEntry; type: "conf" | "jour" }) {
  const t = useTranslations("ccf");
  return (
    <li className="group relative flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-muted/60">
      {/* 级别色条 */}
      <span
        aria-hidden
        className={`absolute inset-y-1 left-0 w-[3px] rounded-r-full opacity-0 transition-opacity group-hover:opacity-100 ${LEVEL_STYLE[entry.l].bar}`}
      />
      <span className="w-28 shrink-0 truncate font-mono text-[13px] font-semibold tracking-tight sm:w-32">
        {entry.a}
      </span>
      <span
        className="min-w-0 flex-1 truncate text-sm text-muted-foreground transition-colors group-hover:text-foreground/80"
        title={entry.n}
      >
        {entry.n}
      </span>
      <Badge
        variant="secondary"
        className="hidden shrink-0 text-[10px] font-normal text-muted-foreground sm:inline-flex"
      >
        {type === "conf" ? t("typeConference") : t("typeJournal")}
      </Badge>
      <LevelBadge level={entry.l} />
    </li>
  );
}

/** 组内会议/期刊分区的小标题（仅当两者同时存在时出现） */
function TypeDivider({ type }: { type: "conf" | "jour" }) {
  const t = useTranslations("ccf");
  return (
    <li
      aria-hidden
      className="border-t bg-muted/40 px-4 py-1.5 text-[11px] font-medium tracking-wide text-muted-foreground/70"
    >
      {type === "conf" ? t("typeConference") : t("typeJournal")}
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
            highlight
              ? "bg-primary/15 text-primary"
              : "bg-muted text-muted-foreground"
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

export function CcfDirectory() {
  const t = useTranslations("ccf");
  const locale = useLocale();
  const isZh = locale === "zh";

  const [query, setQuery] = useState("");
  const [type, setType] = useState<TypeFilter>("all");
  const [level, setLevel] = useState<LevelFilter>("all");
  const [field, setField] = useState<string>("all");

  // 保持官方领域顺序去重
  const fields = useMemo(() => {
    const seen = new Set<string>();
    const list: string[] = [];
    for (const e of [...ccf.conferences, ...ccf.journals]) {
      const key = FIELD_KEY(e.f);
      if (!seen.has(key)) {
        seen.add(key);
        list.push(e.f);
      }
    }
    return list;
  }, []);

  const fieldName = (f: string) => (isZh ? f : FIELD_EN[FIELD_KEY(f)] ?? f);

  const { confs, jours } = useMemo(() => {
    const q = query.trim().toLowerCase();
    const match = (e: CcfEntry) => {
      if (level !== "all" && e.l !== level) return false;
      if (field !== "all" && FIELD_KEY(e.f) !== FIELD_KEY(field)) return false;
      if (!q) return true;
      return e.a.toLowerCase().includes(q) || e.n.toLowerCase().includes(q);
    };
    return {
      confs: ccf.conferences.filter(match),
      jours: ccf.journals.filter(match),
    };
  }, [query, level, field]);

  // 按领域分组（保持官方顺序）；组内：会议在前（按级别、缩写），期刊在后
  const groups = useMemo(() => {
    const byField = (list: CcfEntry[]) => {
      const m = new Map<string, CcfEntry[]>();
      for (const e of list) {
        const key = FIELD_KEY(e.f);
        if (!m.has(key)) m.set(key, []);
        m.get(key)!.push(e);
      }
      return m;
    };
    const cm = byField(confs);
    const jm = byField(jours);
    return fields
      .map((f) => {
        const key = FIELD_KEY(f);
        const list =
          type === "all"
            ? [...(cm.get(key) ?? []), ...(jm.get(key) ?? [])]
            : type === "conf"
              ? (cm.get(key) ?? [])
              : (jm.get(key) ?? []);
        return { field: f, list };
      })
      .filter((g) => g.list.length > 0);
  }, [confs, jours, fields, type]);

  const total = ccf.conferences.length + ccf.journals.length;
  // 实际渲染条数（与分组结果一致）
  const shown = groups.reduce((acc, g) => acc + g.list.length, 0);
  const classACount =
    ccf.conferences.filter((e) => e.l === "A").length +
    ccf.journals.filter((e) => e.l === "A").length;

  const resetFilters = () => {
    setQuery("");
    setType("all");
    setLevel("all");
    setField("all");
  };

  const scrollToField = (index: number) => {
    document
      .getElementById(`ccf-field-${index}`)
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <div className="flex flex-col gap-8">
      {/* 统计卡片 */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard
          icon={LayersIcon}
          value={total}
          label={t("statsTotal")}
          highlight
        />
        <StatCard
          icon={PresentationIcon}
          value={ccf.conferences.length}
          label={t("statsConferences")}
        />
        <StatCard
          icon={BookOpenIcon}
          value={ccf.journals.length}
          label={t("statsJournals")}
        />
        <StatCard
          icon={AwardIcon}
          value={classACount}
          label={t("statsClassA")}
        />
      </div>

      {/* sticky 筛选栏 */}
      <div className="sticky top-14 z-30 rounded-2xl border bg-background/85 px-3 py-3 shadow-sm backdrop-blur supports-[backdrop-filter]:bg-background/70">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative w-full sm:w-64 lg:w-72">
            <SearchIcon
              className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted-foreground"
              data-icon="inline-start"
            />
            <Input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("searchPlaceholder")}
              className="pl-10"
              aria-label={t("searchPlaceholder")}
            />
          </div>

          <ToggleGroup
            value={[type]}
            onValueChange={(v) => setType((v[0] as TypeFilter) ?? "all")}
            className="ccf-segmented flex-wrap"
          >
            <ToggleGroupItem value="all">{t("typeAll")}</ToggleGroupItem>
            <ToggleGroupItem value="conf">{t("typeConference")}</ToggleGroupItem>
            <ToggleGroupItem value="jour">{t("typeJournal")}</ToggleGroupItem>
          </ToggleGroup>

          <ToggleGroup
            value={[level]}
            onValueChange={(v) => setLevel((v[0] as LevelFilter) ?? "all")}
            className="ccf-segmented flex-wrap"
          >
            <ToggleGroupItem value="all">{t("levelAll")}</ToggleGroupItem>
            <ToggleGroupItem value="A">A</ToggleGroupItem>
            <ToggleGroupItem value="B">B</ToggleGroupItem>
            <ToggleGroupItem value="C">C</ToggleGroupItem>
          </ToggleGroup>

          <Select value={field} onValueChange={setField}>
            <SelectTrigger
              size="sm"
              className="min-w-44 max-w-64 bg-muted/50 hover:bg-muted/80 dark:bg-input/40 dark:hover:bg-input/60"
            >
              <SelectValue>
                <LayoutGridIcon className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate" title={field === "all" ? t("fieldAll") : fieldName(field)}>
                  {field === "all" ? t("fieldAll") : fieldName(field)}
                </span>
              </SelectValue>
            </SelectTrigger>
            {/* w-max 让面板随内容自适应宽度，保证领域全称完整显示 */}
            <SelectContent className="w-max min-w-72 max-w-[min(28rem,calc(100vw-2rem))] rounded-xl p-1 shadow-lg">
              <SelectItem
                value="all"
                className="rounded-md py-1.5 pr-8 pl-2 data-[selected]:font-medium"
              >
                {t("fieldAll")}
              </SelectItem>
              {fields.map((f) => (
                <SelectItem
                  key={f}
                  value={f}
                  className="rounded-md py-1.5 pr-8 pl-2 data-[selected]:font-medium"
                >
                  {fieldName(f)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Badge
            variant="outline"
            className="ml-auto hidden shrink-0 font-normal tabular-nums text-muted-foreground lg:inline-flex"
          >
            {shown} {t("items")}
          </Badge>
        </div>
      </div>

      {/* 领域快速导航：换行排列，避免横向拖动 */}
      <nav aria-label={t("jumpLabel")} className="flex flex-wrap gap-1.5">
        {fields.map((f, i) => (
          <Button
            key={f}
            type="button"
            variant="outline"
            size="sm"
            className="shrink-0 rounded-full text-xs"
            onClick={() => scrollToField(i)}
          >
            {fieldName(f)}
          </Button>
        ))}
      </nav>

      {/* 匹配统计 */}
      <p className="text-xs text-muted-foreground">
        {t("stats", {
          total,
          conferences: ccf.conferences.length,
          journals: ccf.journals.length,
          matched: shown,
        })}
      </p>

      {groups.length === 0 ? (
        <Empty title={t("empty")}>
          <Button variant="outline" size="sm" onClick={resetFilters}>
            <RotateCcwIcon />
            {t("resetFilters")}
          </Button>
        </Empty>
      ) : (
        /* 按领域分组 */
        groups.map((g, gi) => (
          <section
            key={g.field}
            id={`ccf-field-${gi}`}
            className="flex scroll-mt-44 flex-col gap-3"
          >
            <div className="flex items-center justify-between gap-4 border-b pb-2">
              <h2 className="flex items-center gap-2.5 text-base font-semibold tracking-tight">
                <span
                  aria-hidden
                  className="h-4 w-1 shrink-0 rounded-full bg-primary/70"
                />
                {fieldName(g.field)}
              </h2>
              <Badge variant="secondary" className="shrink-0 tabular-nums">
                {g.list.length} {t("items")}
              </Badge>
            </div>
            <ul className="divide-y divide-border/60 overflow-hidden rounded-xl border bg-card">
              {g.list.map((e, ei) => {
                const isConf = ccf.conferences.includes(e);
                const prev = ei > 0 ? g.list[ei - 1] : null;
                const prevIsConf = prev ? ccf.conferences.includes(prev) : null;
                return (
                  <Fragment key={`${isConf ? "conf" : "jour"}-${e.a}-${e.l}-${e.n}`}>
                    {prev && prevIsConf !== isConf && (
                      <TypeDivider type={isConf ? "conf" : "jour"} />
                    )}
                    <EntryRow entry={e} type={isConf ? "conf" : "jour"} />
                  </Fragment>
                );
              })}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}
