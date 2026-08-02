import type { Metadata } from "next";
import { useLocale, useTranslations } from "next-intl";

import { BlogSearch, type PostMeta } from "@/components/blog/blog-search";
import { posts } from "@/lib/data";

export const metadata: Metadata = {
  title: "Blog",
  description: "Technical notes and research thoughts",
};

export default function BlogPage() {
  const t = useTranslations("blog");
  const locale = useLocale();

  const localePosts: PostMeta[] = posts
    .filter((p) => p.locale === locale)
    .sort((a, b) => b.date.localeCompare(a.date))
    .map((p) => ({
      title: p.title,
      date: p.date,
      tags: p.tags,
      summary: p.summary,
      slug: p.slug,
    }));

  return (
    <div className="mx-auto max-w-5xl px-4 py-12 sm:px-6">
      <div className="mb-8 flex flex-col gap-2">
        <h1 className="text-3xl font-bold tracking-tight">{t("title")}</h1>
        <p className="text-muted-foreground">{t("description")}</p>
      </div>
      <BlogSearch posts={localePosts} />
    </div>
  );
}
