"use client";

import { useMemo, useState } from "react";
import Fuse from "fuse.js";
import { useLocale, useTranslations } from "next-intl";
import { SearchIcon } from "lucide-react";

import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty } from "@/components/ui/empty";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Link } from "@/lib/i18n/navigation";
import { formatDate } from "@/lib/utils/format";

export type PostMeta = {
  title: string;
  date: string;
  tags: string[];
  summary?: string;
  slug: string;
};

export function BlogSearch({ posts }: { posts: PostMeta[] }) {
  const t = useTranslations("blog");
  const locale = useLocale();
  const [query, setQuery] = useState("");
  const [tag, setTag] = useState("all");

  const allTags = useMemo(
    () => [...new Set(posts.flatMap((p) => p.tags))].sort(),
    [posts],
  );

  const fuse = useMemo(
    () =>
      new Fuse(posts, {
        keys: [
          { name: "title", weight: 0.5 },
          { name: "summary", weight: 0.3 },
          { name: "tags", weight: 0.2 },
        ],
        threshold: 0.35,
      }),
    [posts],
  );

  const results = useMemo(() => {
    const tagFiltered = tag === "all" ? posts : posts.filter((p) => p.tags.includes(tag));
    if (!query.trim()) return tagFiltered;
    return fuse.search(query).map((r) => r.item).filter((p) => tagFiltered.includes(p));
  }, [posts, fuse, query, tag]);

  return (
    <div className="flex flex-col gap-6">
      {/* 搜索 + 标签 */}
      <div className="flex flex-col gap-4">
        <div className="relative">
          <SearchIcon
            data-icon="inline-start"
            className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted-foreground"
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
        {allTags.length > 1 && (
          <ToggleGroup
            value={[tag]}
            onValueChange={(v) => v[0] && setTag(v[0])}
            aria-label={t("tags")}
          >
            <ToggleGroupItem value="all">{t("allTags")}</ToggleGroupItem>
            {allTags.map((t) => (
              <ToggleGroupItem key={t} value={t}>{t}</ToggleGroupItem>
            ))}
          </ToggleGroup>
        )}
      </div>

      {/* 结果 */}
      {results.length === 0 && <Empty title={t("noResults")} />}
      <div className="flex flex-col gap-3">
        {results.map((post) => (
          <Card key={post.slug}>
            <CardHeader className="py-4">
              <CardTitle className="text-base">
                <Link href={`/blog/${post.slug}`} className="hover:underline">
                  {post.title}
                </Link>
              </CardTitle>
              <CardDescription className="flex flex-wrap items-center gap-2 text-xs">
                <time>{formatDate(post.date, locale)}</time>
                {post.tags.map((tag) => (
                  <Badge key={tag} variant="outline">{tag}</Badge>
                ))}
              </CardDescription>
              {post.summary && <p className="text-sm text-muted-foreground">{post.summary}</p>}
            </CardHeader>
          </Card>
        ))}
      </div>
    </div>
  );
}
