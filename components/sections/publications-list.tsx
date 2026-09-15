"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { BookOpenIcon } from "lucide-react";

import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Separator } from "@/components/ui/separator";
import { toast } from "@/components/ui/toast";
import { PublicationCard } from "@/components/sections/publication-card";
import type { Publication } from "@/lib/data";
import { PINNED_LIMIT, PUBLICATION_TYPES, type PublicationType } from "@/lib/publications/constants";
import { togglePinned } from "@/lib/publications/featured";
import { PREFERENCE_KEYS } from "@/lib/preferences/registry";
import { useOwnerPreferences } from "@/lib/preferences/use-owner-preferences";

type TypeFilter = "all" | PublicationType;

export function PublicationsList({
  publications,
  myNames,
  initialPinnedKeys,
}: {
  publications: Publication[];
  /** 我自己的姓名写法（可给多个别名）—— 必须是可序列化值：页面是 server component，函数不过边界 */
  myNames: readonly string[];
  /** 服务端读到的置顶列表（首帧即正确，不闪烁）；登录后由客户端偏好接管 */
  initialPinnedKeys: readonly string[];
}) {
  const t = useTranslations("publications");
  const [type, setType] = useState<TypeFilter>("all");
  const [year, setYear] = useState<string>("all");

  // 置顶（pin）：仅站主可切换，状态存站主偏好（data/preferences.json，跨设备同步）。
  // 游客只读服务端渲染的结果 —— 置顶是「编辑选择」，对所有访客生效，与个人筛选偏好不同。
  const { ready, isOwner, prefs, setPref } = useOwnerPreferences();
  const pinnedKeys: readonly string[] =
    isOwner && ready
      ? ((prefs[PREFERENCE_KEYS.PUBLICATIONS_PINNED] as string[] | undefined) ?? [])
      : initialPinnedKeys;

  /** 置顶 / 取消置顶；已达上限时提示，不静默挤掉已有的置顶 */
  const handleTogglePin = (key: string) => {
    if (!pinnedKeys.includes(key) && pinnedKeys.length >= PINNED_LIMIT) {
      toast.add({ title: t("pinLimit", { n: PINNED_LIMIT }), type: "warning" });
      return;
    }
    setPref(PREFERENCE_KEYS.PUBLICATIONS_PINNED, togglePinned(pinnedKeys, key));
  };

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
      {/* 筛选档位由 PUBLICATION_TYPES 生成（与 schema 单一来源，勿手写档位 ——
          历史上 schema 有 thesis 而 UI 缺这一档，数据合法却筛不出来） */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <ToggleGroup
          value={[type]}
          onValueChange={(v) => v[0] && setType(v[0] as TypeFilter)}
          aria-label={t("filter.aria")}
          // ⚠ 必须允许换行：类型共 4 档，360px 视口下不换行会横向溢出
          className="flex-wrap"
        >
          <ToggleGroupItem value="all">{t("filter.all")}</ToggleGroupItem>
          {PUBLICATION_TYPES.map((publicationType) => (
            <ToggleGroupItem key={publicationType} value={publicationType}>
              {t(`types.${publicationType}`)}
            </ToggleGroupItem>
          ))}
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

      {/* 列表：按年份倒序分组；**同一年内保持数据文件里的先后顺序**（想突出代表作就写在同年前面） */}
      {/* ⚠ 空态文案必须写成 EmptyTitle / EmptyDescription 子元素；写成 <Empty title="…"> 只会落成 DOM 的 title 属性（悬浮提示），用户在页面上看不到任何文字 */}
      {groups.length === 0 && (
        <Empty>
          <EmptyMedia variant="icon">
            <BookOpenIcon aria-hidden />
          </EmptyMedia>
          <EmptyHeader>
            <EmptyTitle>{t("empty")}</EmptyTitle>
            <EmptyDescription>{t("emptyHint")}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
      {groups.map(([year, pubs]) => (
        <div key={year} className="flex flex-col gap-3">
          <div className="flex items-center gap-3">
            <h2 className="font-mono text-lg font-semibold tracking-tight">{year}</h2>
            <Separator className="flex-1" />
          </div>
          {pubs.map((pub) => (
            <PublicationCard
              key={pub.key}
              pub={pub}
              myNames={myNames}
              pinned={pinnedKeys.includes(pub.key)}
              onTogglePin={isOwner ? () => handleTogglePin(pub.key) : undefined}
            />
          ))}
        </div>
      ))}
    </div>
  );
}
