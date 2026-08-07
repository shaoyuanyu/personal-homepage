"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import {
  AwardIcon,
  BookOpenIcon,
  LayersIcon,
  PresentationIcon,
  RotateCcwIcon,
  SearchIcon,
} from "lucide-react";

import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Empty } from "@/components/ui/empty";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { ccf, type CcfEntry } from "@/lib/data";

type TypeFilter = "all" | "conf" | "jour";
type LevelFilter = "all" | "A" | "B" | "C";

/* 领域 → URL 短键（避免中文过长与编码问题） */
const FIELD_KEYS: Record<string, string> = {
  计算机体系结构: "arch",
  计算机网络: "net",
  网络与信息安全: "sec",
  软件工程: "se",
  数据库: "db",
  计算机科学理论: "theory",
  计算机图形学与多媒体: "graphics",
  人工智能: "ai",
  人机交互与普适计算: "hci",
  交叉: "inter",
};

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

/* 短键 → 完整领域名（模块级静态构建） */
const KEY_TO_FIELD = new Map<string, string>();
for (const e of [...ccf.conferences, ...ccf.journals]) {
  const key = FIELD_KEYS[FIELD_KEY(e.f)];
  if (key && !KEY_TO_FIELD.has(key)) KEY_TO_FIELD.set(key, e.f);
}

/* 合法领域名集合（校验 localStorage 恢复数据） */
const ALL_FIELDS = new Set(KEY_TO_FIELD.values());

/* localStorage 记忆键：从导航/论文页无参数进入时恢复上次筛选 */
const STORAGE_KEY = "ccf:filters";

type SavedFilters = {
  fields?: string[];
  type?: TypeFilter;
  level?: LevelFilter;
  q?: string;
};

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
  // 多选领域集合；空数组 = 全部领域
  const [selectedFields, setSelectedFields] = useState<string[]>([]);

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

  const toggleField = (f: string) => {
    setSelectedFields((prev) =>
      prev.includes(f) ? prev.filter((x) => x !== f) : [...prev, f],
    );
  };

  const { confs, jours } = useMemo(() => {
    const q = query.trim().toLowerCase();
    const match = (e: CcfEntry) => {
      if (level !== "all" && e.l !== level) return false;
      if (
        selectedFields.length > 0 &&
        !selectedFields.some((f) => FIELD_KEY(f) === FIELD_KEY(e.f))
      )
        return false;
      if (!q) return true;
      return e.a.toLowerCase().includes(q) || e.n.toLowerCase().includes(q);
    };
    return {
      confs: ccf.conferences.filter(match),
      jours: ccf.journals.filter(match),
    };
  }, [query, level, selectedFields]);

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
    setSelectedFields([]);
  };

  // 首次挂载恢复筛选状态：URL 查询参数优先（可分享/可刷新），
  // 无参数时回退到 localStorage 的上次记忆（导航页/论文页入口进入也不丢）
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const t = p.get("type");
    const l = p.get("level");
    const keys = (p.get("fields") ?? "").split(",").filter(Boolean);
    const q = p.get("q");

    if (t || l || keys.length || q !== null) {
      setQuery(q ?? "");
      if (t === "conf" || t === "jour") setType(t);
      if (l === "A" || l === "B" || l === "C") setLevel(l);
      setSelectedFields(
        keys
          .map((k) => KEY_TO_FIELD.get(k))
          .filter((f): f is string => Boolean(f)),
      );
    } else {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
          const saved = JSON.parse(raw) as SavedFilters;
          setQuery(saved.q ?? "");
          if (saved.type === "conf" || saved.type === "jour") setType(saved.type);
          if (saved.level === "A" || saved.level === "B" || saved.level === "C")
            setLevel(saved.level);
          setSelectedFields(
            (saved.fields ?? []).filter((f) => ALL_FIELDS.has(f)),
          );
        }
      } catch {
        // localStorage 不可用或数据损坏时静默忽略
      }
    }
  }, []);

  // 筛选状态变化时同步：URL（可分享）+ localStorage（记忆上次筛选）。
  // 跳过首次渲染：客户端导航可能重复挂载组件，若首次就用默认 state 写入，
  // 会覆盖 localStorage 里的记忆，导致恢复失效。
  const hasPersisted = useRef(false);
  useEffect(() => {
    if (!hasPersisted.current) {
      hasPersisted.current = true;
      return;
    }
    const p = new URLSearchParams();
    if (selectedFields.length > 0) {
      p.set(
        "fields",
        selectedFields.map((f) => FIELD_KEYS[FIELD_KEY(f)]).join(","),
      );
    }
    if (type !== "all") p.set("type", type);
    if (level !== "all") p.set("level", level);
    const q = query.trim();
    if (q) p.set("q", q);
    const qs = p.toString();
    const url = qs
      ? `${window.location.pathname}?${qs}`
      : window.location.pathname;
    window.history.replaceState(null, "", url);

    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          fields: selectedFields,
          type,
          level,
          q,
        } satisfies SavedFilters),
      );
    } catch {
      // 隐私模式等场景下写入失败时静默忽略
    }
  }, [type, level, selectedFields, query]);

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

          <Badge
            variant="outline"
            className="ml-auto hidden shrink-0 font-normal tabular-nums text-muted-foreground lg:inline-flex"
          >
            {shown} {t("items")}
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
          const selected = selectedFields.includes(f);
          return (
            <Button
              key={f}
              type="button"
              variant={selected ? "default" : "outline"}
              size="sm"
              className="rounded-full text-xs"
              onClick={() => toggleField(f)}
              aria-pressed={selected}
            >
              {fieldName(f)}
            </Button>
          );
        })}
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
