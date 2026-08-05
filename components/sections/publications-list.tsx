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

  // 按年份分组（倒序）
  const groups = useMemo(() => {
    const map = new Map<number, Publication[]>();
    for (const pub of filtered) {
      const list = map.get(pub.year) ?? [];
      list.push(pub);
      map.set(pub.year, list);
    }
    return [...map.entries()].sort((a, b) => b[0] - a[0]);
  }, [filtered]);

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

      {/* 列表：按年份倒序 */}
      {groups.length === 0 && <Empty title={t("empty")} />}
      {groups.map(([year, pubs]) => (
        <div key={year} className="flex flex-col gap-3">
          <div className="flex items-center gap-3">
            <h2 className="font-mono text-lg font-semibold tracking-tight">{year}</h2>
            <Separator className="flex-1" />
          </div>
          {pubs.map((pub) => (
            <PublicationCard key={pub.key} pub={pub} isMe={isMe} />
          ))}
        </div>
      ))}
    </div>
  );
}
