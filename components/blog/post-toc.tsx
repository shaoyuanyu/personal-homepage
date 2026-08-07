"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { ListTreeIcon } from "lucide-react";

/** Velite `s.toc()` 输出的目录条目 */
export type TocEntry = {
  title: string;
  url: string;
  items: TocEntry[];
};

/** 展开嵌套目录为扁平条目（h2 → h3 顺序） */
function flatten(toc: TocEntry[]): TocEntry[] {
  return toc.flatMap((entry) => [entry, ...flatten(entry.items)]);
}

/**
 * 文章目录（右侧侧栏）。
 * - 链接为 velite 生成的中文锚点（如 #欢迎），点击平滑滚动
 * - IntersectionObserver 高亮当前阅读章节
 * - 无标题时返回 null（不占位）
 */
export function PostToc({ toc }: { toc: TocEntry[] }) {
  const t = useTranslations("blog");
  const [active, setActive] = useState<string>("");

  useEffect(() => {
    const entries = flatten(toc);
    if (entries.length === 0) return;

    const observer = new IntersectionObserver(
      (observed) => {
        for (const entry of observed) {
          if (entry.isIntersecting) {
            setActive(`#${entry.target.id}`);
          }
        }
      },
      // 视口上方 80px 处进入即视为"当前章节"
      { rootMargin: "-80px 0px -70% 0px" },
    );

    for (const entry of entries) {
      const el = document.getElementById(entry.url.slice(1));
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, [toc]);

  if (toc.length === 0) return null;

  const renderItems = (items: TocEntry[], depth: number) => (
    <ul className={depth === 0 ? "space-y-1" : "mt-1 space-y-1 border-l border-border pl-3"}>
      {items.map((entry) => (
        <li key={entry.url}>
          <a
            href={entry.url}
            className={`block rounded-md px-2 py-1 text-sm transition-colors hover:bg-accent hover:text-accent-foreground ${
              active === entry.url
                ? "bg-accent font-medium text-foreground"
                : "text-muted-foreground"
            }`}
          >
            {entry.title}
          </a>
          {entry.items.length > 0 && renderItems(entry.items, depth + 1)}
        </li>
      ))}
    </ul>
  );

  return (
    <nav
      aria-label={t("tableOfContents")}
      className="sticky top-20 max-h-[calc(100svh-6rem)] overflow-y-auto"
    >
      <p className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        <ListTreeIcon className="size-3.5" />
        {t("tableOfContents")}
      </p>
      {renderItems(toc, 0)}
    </nav>
  );
}
