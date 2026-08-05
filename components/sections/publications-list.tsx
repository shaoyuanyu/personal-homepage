"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";

import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Empty } from "@/components/ui/empty";
import { Separator } from "@/components/ui/separator";
import { PublicationCard } from "@/components/sections/publication-card";
import type { Publication } from "@/lib/data";

type TypeFilter = "all" | "conference" | "journal" | "preprint";

/** 列表按类型分区块展示，顺序：会议 → 期刊 → 预印本 → 学位论文 */
const sections = [
  { type: "conference", labelKey: "sections.conference" },
  { type: "journal", labelKey: "sections.journal" },
  { type: "preprint", labelKey: "sections.preprint" },
  { type: "thesis", labelKey: "sections.thesis" },
] as const;

export function PublicationsList({
  publications,
  myName,
}: {
  publications: Publication[];
  myName: string;
}) {
  const t = useTranslations("publications");
  const [type, setType] = useState<TypeFilter>("all");
  const [year, setYear] = useState<string>("all");

  // 标记本人：作者名去除 `*` 后与姓名匹配
  const isMe = (author: string) =>
    author.replace("*", "").trim().toLowerCase() === myName.toLowerCase();

  const years = useMemo(
    () => [...new Set(publications.map((p) => p.year))].sort((a, b) => b - a),
    [publications],
  );

  const filtered = useMemo(
    () =>
      publications.filter(
        (p) => (type === "all" || p.type === type) && (year === "all" || String(p.year) === year),
      ),
    [publications, type, year],
  );

  /** 按年份分组（倒序） */
  const groupByYear = (pubs: Publication[]) => {
    const map = new Map<number, Publication[]>();
    for (const pub of pubs) {
      const list = map.get(pub.year) ?? [];
      list.push(pub);
      map.set(pub.year, list);
    }
    return [...map.entries()].sort((a, b) => b[0] - a[0]);
  };

  return (
    <div className="flex flex-col gap-6">
      {/* 过滤栏 */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <ToggleGroup
          value={[type]}
          onValueChange={(v) => v[0] && setType(v[0] as TypeFilter)}
          aria-label="Filter by type"
        >
          <ToggleGroupItem value="all">{t("filter.all")}</ToggleGroupItem>
          <ToggleGroupItem value="conference">{t("filter.conference")}</ToggleGroupItem>
          <ToggleGroupItem value="journal">{t("filter.journal")}</ToggleGroupItem>
          <ToggleGroupItem value="preprint">{t("filter.preprint")}</ToggleGroupItem>
        </ToggleGroup>

        {years.length > 1 && (
          <Select
            value={year}
            onValueChange={(v) => v !== null && setYear(v)}
          >
            <SelectTrigger className="w-36" aria-label={t("filter.year")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all" label={t("filter.all")}>
                {t("filter.all")}
              </SelectItem>
              {years.map((y) => (
                <SelectItem key={y} value={String(y)} label={String(y)}>
                  {y}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      {/* 按类型分区块：会议论文 / 期刊论文 / 预印本 / 学位论文 */}
      {filtered.length === 0 && <Empty title={t("empty")} />}
      {sections.map((section) => {
        const pubs = filtered.filter((p) => p.type === section.type);
        if (pubs.length === 0) return null;
        return (
          <div key={section.type} className="flex flex-col gap-3">
            <div className="flex items-center gap-3">
              <h2 className="text-lg font-semibold tracking-tight">{t(section.labelKey)}</h2>
              <Separator className="flex-1" />
            </div>
            {groupByYear(pubs).map(([year, yearPubs]) => (
              <div key={year} className="flex flex-col gap-3">
                <div className="flex items-center gap-3">
                  <h3 className="font-mono text-sm font-medium text-muted-foreground">{year}</h3>
                  <Separator className="flex-1" />
                </div>
                {yearPubs.map((pub) => (
                  <PublicationCard key={pub.key} pub={pub} isMe={isMe} />
                ))}
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}
