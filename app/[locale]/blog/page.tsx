import { useLocale, useTranslations } from "next-intl";

import { BlogSearch, type PostMeta } from "@/components/blog/blog-search";
import { pageMetadata } from "@/lib/i18n/metadata";
import { posts } from "@/lib/data";

type Props = {
  params: Promise<{ locale: string }>;
};

export async function generateMetadata({ params }: Props) {
  return {
    ...(await pageMetadata(params, "blog")),
    alternates: {
      types: {
        "application/rss+xml": "/feed.xml",
      },
    },
  };
}

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
    <div className="w-full mx-auto max-w-5xl px-4 py-12 sm:px-6">
      <div className="mb-8 flex flex-col gap-2">
        <h1 className="text-3xl font-bold tracking-tight">{t("title")}</h1>
        <p className="text-muted-foreground">{t("description")}</p>
      </div>
      <BlogSearch posts={localePosts} />
    </div>
  );
}
