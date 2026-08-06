"use client";

import { useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { SearchIcon } from "lucide-react";

import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
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

function LevelBadge({ level }: { level: CcfEntry["l"] }) {
  const t = useTranslations("ccf.levels");
  const style = {
    A: "bg-red-500/10 text-red-600 ring-red-600/20 dark:bg-red-500/15 dark:text-red-400",
    B: "bg-blue-500/10 text-blue-600 ring-blue-600/20 dark:bg-blue-500/15 dark:text-blue-400",
    C: "bg-emerald-500/10 text-emerald-600 ring-emerald-600/20 dark:bg-emerald-500/15 dark:text-emerald-400",
  }[level];

  return (
    <Badge
      variant="outline"
      className={`w-6 justify-center rounded-md ring-1 ring-inset ${style}`}
      aria-label={`${level} ${t("class")}`}
    >
      {level}
    </Badge>
  );
}

function EntryRow({ entry, type }: { entry: CcfEntry; type: "conf" | "jour" }) {
  const t = useTranslations("ccf");
  return (
    <li className="flex items-center gap-3 rounded-lg border border-transparent px-3 py-1.5 transition-colors hover:border-border hover:bg-muted/50">
      <span className="shrink-0 font-mono text-[13px] font-semibold tracking-tight">
        {entry.a}
      </span>
      <span
        className="min-w-0 flex-1 truncate text-sm text-muted-foreground"
        title={entry.n}
      >
        {entry.n}
      </span>
      <Badge
        variant="outline"
        className="hidden shrink-0 text-[10px] text-muted-foreground sm:inline-flex"
      >
        {type === "conf" ? t("typeConference") : t("typeJournal")}
      </Badge>
      <LevelBadge level={entry.l} />
    </li>
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

  return (
    <div className="flex flex-col gap-6">
      {/* 筛选工具条 */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-72">
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
          className="flex-wrap"
        >
          <ToggleGroupItem value="all">{t("typeAll")}</ToggleGroupItem>
          <ToggleGroupItem value="conf">{t("typeConference")}</ToggleGroupItem>
          <ToggleGroupItem value="jour">{t("typeJournal")}</ToggleGroupItem>
        </ToggleGroup>

        <ToggleGroup
          value={[level]}
          onValueChange={(v) => setLevel((v[0] as LevelFilter) ?? "all")}
          className="flex-wrap"
        >
          <ToggleGroupItem value="all">{t("levelAll")}</ToggleGroupItem>
          <ToggleGroupItem value="A">A</ToggleGroupItem>
          <ToggleGroupItem value="B">B</ToggleGroupItem>
          <ToggleGroupItem value="C">C</ToggleGroupItem>
        </ToggleGroup>

        <Select value={field} onValueChange={setField}>
          <SelectTrigger size="sm" className="min-w-44">
            <SelectValue>
              {field === "all" ? t("fieldAll") : fieldName(field)}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("fieldAll")}</SelectItem>
            {fields.map((f) => (
              <SelectItem key={f} value={f}>
                {fieldName(f)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* 统计 */}
      <p className="text-xs text-muted-foreground">
        {t("stats", {
          total,
          conferences: ccf.conferences.length,
          journals: ccf.journals.length,
          matched: shown,
        })}
      </p>

      {groups.length === 0 && <Empty title={t("empty")} />}

      {/* 按领域分组 */}
      {groups.map((g) => (
        <section key={g.field} className="flex flex-col gap-3">
          <div className="flex items-baseline justify-between gap-4 border-b pb-1.5">
            <h2 className="text-lg font-semibold tracking-tight">
              {fieldName(g.field)}
            </h2>
            <span className="shrink-0 text-xs text-muted-foreground">
              {g.list.length} {t("items")}
            </span>
          </div>
          <ul className="flex flex-col gap-0.5">
            {g.list.map((e) => {
              const isConf = ccf.conferences.includes(e);
              return (
                <EntryRow
                  key={`${isConf ? "conf" : "jour"}-${e.a}-${e.l}-${e.n}`}
                  entry={e}
                  type={isConf ? "conf" : "jour"}
                />
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
