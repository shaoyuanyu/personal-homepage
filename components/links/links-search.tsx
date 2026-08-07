"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { SearchIcon, GlobeIcon, CompassIcon } from "lucide-react";

import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty } from "@/components/ui/empty";
import { Link } from "@/lib/i18n/navigation";
import type { NavLinkGroup } from "@/lib/data";

type NavLink = NavLinkGroup["links"][number];

/** 站内页面链接（url 以 / 开头）：用本站罗盘图标，不做 favicon 探测 */
function isInternal(url: string) {
  return url.startsWith("/");
}

/**
 * 外部链接图标：构建期已由 scripts/fetch-favicons.mjs 缓存到本站
 * /favicons/{hostname}.{svg|png}，运行时不再依赖 Google/iconify 境外服务；
 * 加载失败时兜底为地球图标。
 *
 * 注意：SSR 输出的 <img> 若在 React hydration 绑定 onError 之前就 404，
 * error 事件会被错过，因此 mount 后还需主动检查一次破图状态。
 */
function LinkIcon({ link }: { link: NavLink }) {
  const [failed, setFailed] = useState(false);
  const imgRef = useRef<HTMLImageElement | null>(null);

  useEffect(() => {
    const el = imgRef.current;
    if (el && el.complete && el.naturalWidth === 0) {
      setFailed(true);
    }
  }, []);

  if (isInternal(link.url)) {
    return <CompassIcon className="size-4 shrink-0 text-muted-foreground" />;
  }

  if (failed) {
    return <GlobeIcon className="size-4 shrink-0 text-muted-foreground" />;
  }

  const hostname = new URL(link.url).hostname;
  const src = link.icon
    ? `/favicons/${hostname}.svg`
    : `/favicons/${hostname}.png`;

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      ref={imgRef}
      src={src}
      alt=""
      width={16}
      height={16}
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className="size-4 shrink-0 opacity-80 grayscale transition-all duration-200 group-hover:opacity-100 group-hover:grayscale-0 dark:brightness-0 dark:invert"
    />
  );
}

export function LinksSearch({ groups }: { groups: NavLinkGroup[] }) {
  const t = useTranslations("navPage");
  const locale = useLocale();
  const lang = locale === "zh" ? "zh" : "en";
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return groups;
    return groups
      .map((g) => ({
        ...g,
        links: g.links.filter(
          (l) =>
            l.name.toLowerCase().includes(q) ||
            (l.desc?.[lang] ?? "").toLowerCase().includes(q),
        ),
      }))
      .filter((g) => g.links.length > 0);
  }, [groups, query, lang]);

  return (
    <div className="flex flex-col gap-8">
      <div className="relative max-w-md">
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

      {filtered.length === 0 && <Empty title={t("noResults")} />}

      {filtered.map((group) => (
        <section key={group.group[lang]} className="flex flex-col gap-4">
          <h2 className="text-lg font-semibold tracking-tight">{group.group[lang]}</h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {group.links.map((link) => (
              <Card key={link.name} className="group transition-colors hover:border-primary/40">
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center gap-2 text-sm font-medium">
                    <LinkIcon link={link} />
                    {isInternal(link.url) ? (
                      <Link
                        href={link.url}
                        className="truncate underline-offset-4 group-hover:underline"
                      >
                        {link.name}
                      </Link>
                    ) : (
                      <a
                        href={link.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="truncate group-hover:underline"
                      >
                        {link.name}
                      </a>
                    )}
                  </CardTitle>
                </CardHeader>
                {link.desc && (
                  <CardContent className="pb-3">
                    <p className="line-clamp-2 text-xs text-muted-foreground">{link.desc[lang]}</p>
                  </CardContent>
                )}
              </Card>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
