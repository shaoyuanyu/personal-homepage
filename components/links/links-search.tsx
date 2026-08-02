"use client";

import { useMemo, useState } from "react";
import { Icon } from "@iconify/react";
import { useLocale, useTranslations } from "next-intl";
import { SearchIcon, GlobeIcon } from "lucide-react";

import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty } from "@/components/ui/empty";
import type { NavLinkGroup } from "@/lib/data";

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
                    {link.icon ? (
                      <Icon icon={link.icon} className="size-4 shrink-0 text-muted-foreground" />
                    ) : (
                      <GlobeIcon className="size-4 shrink-0 text-muted-foreground" />
                    )}
                    <a
                      href={link.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="truncate group-hover:underline"
                    >
                      {link.name}
                    </a>
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
