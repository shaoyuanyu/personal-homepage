import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { ArrowLeftIcon, ArrowRightIcon, CalendarIcon, ClockIcon } from "lucide-react";

import { MDXContent } from "@/components/blog/mdx-content";
import { PostToc } from "@/components/blog/post-toc";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Link } from "@/lib/i18n/navigation";
import { formatDate } from "@/lib/utils/format";
import { posts, profile } from "@/lib/data";
import { routing } from "@/lib/i18n/routing";

type Props = {
  params: Promise<{ locale: string; slug: string }>;
};

export function generateStaticParams() {
  return posts.map((post) => ({ locale: post.locale, slug: post.slug }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale, slug } = await params;
  const post = posts.find((p) => p.locale === locale && p.slug === slug);
  if (!post) return {};
  return { title: post.title, description: post.summary };
}

export default async function PostPage({ params }: Props) {
  const { locale, slug } = await params;
  const t = await getTranslations("blog");

  const post = posts.find((p) => p.locale === locale && p.slug === slug);
  if (!post) notFound();

  // 同语言文章按日期排序，计算上一篇（更旧）/下一篇（更新）
  const localePosts = posts
    .filter((p) => p.locale === locale)
    .sort((a, b) => b.date.localeCompare(a.date));
  const index = localePosts.findIndex((p) => p.slug === slug);
  const older = localePosts[index + 1]; // 上一篇（更早发布）
  const newer = localePosts[index - 1]; // 下一篇（更晚发布）

  // BlogPosting 结构化数据：文章详情页收录（headline/日期/作者）
  const siteUrl = process.env.SITE_URL ?? "https://shaoyuanyu.cn";
  // 默认语言（zh）不带前缀，其他语言带 /en 前缀
  const urlPrefix = locale === routing.defaultLocale ? "" : `/${locale}`;
  const blogPostJsonLd = {
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    headline: post.title,
    description: post.summary,
    datePublished: post.date,
    dateModified: post.date,
    inLanguage: locale,
    author: { "@type": "Person", name: profile.name, url: siteUrl },
    publisher: { "@type": "Person", name: profile.name, url: siteUrl },
    mainEntityOfPage: {
      "@type": "WebPage",
      "@id": `${siteUrl}${urlPrefix}/blog/${post.slug}`,
    },
  };

  const adjacentCard = (
    post: (typeof posts)[number],
    label: string,
    isNext: boolean,
  ) => (
    <Link
      href={`/blog/${post.slug}`}
      className={`group flex flex-col gap-1 rounded-lg border p-4 transition-colors hover:border-foreground/20 hover:bg-accent/50 ${
        isNext ? "text-right" : ""
      }`}
    >
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {isNext ? (
          <>
            {t("nextPost")}
            <ArrowRightIcon className="size-3.5" />
          </>
        ) : (
          <>
            <ArrowLeftIcon className="size-3.5" />
            {t("previousPost")}
          </>
        )}
      </span>
      <span className="font-medium group-hover:underline">{post.title}</span>
    </Link>
  );

  return (
    <div className="mx-auto max-w-5xl px-4 py-12 sm:px-6">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(blogPostJsonLd) }}
      />
      <Button variant="ghost" size="sm" className="mb-8 -ml-2" render={<Link href="/blog" />}>
        <ArrowLeftIcon data-icon="inline-start" />
        {t("backToBlog")}
      </Button>

      <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_16rem] lg:gap-12">
        <article className="min-w-0">
          <header className="mb-8 flex flex-col gap-3">
            <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">{post.title}</h1>
            <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <CalendarIcon className="size-4" />
                <time>{formatDate(post.date, locale)}</time>
              </span>
              <span className="flex items-center gap-1.5">
                <ClockIcon className="size-4" />
                {t("readingTime", { minutes: post.meta.readingTime })}
              </span>
              {post.tags.map((tag) => (
                <Badge key={tag} variant="secondary">{tag}</Badge>
              ))}
            </div>
            <Separator />
          </header>

          <div className="prose prose-neutral max-w-none dark:prose-invert">
            <MDXContent code={post.body} />
          </div>

          {/* 上一篇 / 下一篇 */}
          <div className="mt-10 grid gap-4 sm:grid-cols-2">
            {older ? adjacentCard(older, t("previousPost"), false) : <span />}
            {newer ? adjacentCard(newer, t("nextPost"), true) : <span />}
          </div>
        </article>

        {/* 右侧目录（仅桌面端显示） */}
        <aside className="hidden lg:block">
          <PostToc toc={post.toc} />
        </aside>
      </div>
    </div>
  );
}
