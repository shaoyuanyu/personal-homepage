import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  CalendarIcon,
  ClockIcon,
  LanguagesIcon,
} from "lucide-react";

import { MDXContent } from "@/components/blog/mdx-content";
import { PostToc } from "@/components/blog/post-toc";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Link } from "@/lib/i18n/navigation";
import { formatDate } from "@/lib/utils/format";
import { blogStaticParams, getPost, listPosts, profile } from "@/lib/data";
import { routing } from "@/lib/i18n/routing";

type Props = {
  params: Promise<{ locale: string; slug: string }>;
};

// 默认语言（zh）不带前缀，其他语言带 /en 前缀
function localePrefix(locale: string): string {
  return locale === routing.defaultLocale ? "" : `/${locale}`;
}

// 每篇文章在每个语言下都有 URL：缺该语言版本时页面回退显示原文
export function generateStaticParams() {
  return blogStaticParams();
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale, slug } = await params;
  const post = getPost(locale, slug);
  if (!post) return {};
  return {
    title: post.title,
    description: post.summary,
    // 正文所在语言的 URL 才是「正本」：若当前语言无译文（页面回退显示原文），
    // canonical 指回原文地址，避免同一内容在 /blog 与 /en/blog 下被重复收录。
    alternates: {
      canonical: `${localePrefix(post.locale)}/blog/${post.slug}`,
    },
  };
}

export default async function PostPage({ params }: Props) {
  const { locale, slug } = await params;
  const t = await getTranslations("blog");

  const post = getPost(locale, slug);
  if (!post) notFound();

  // 相邻文章取「当前语言可见的全部文章」（与列表页同一集合，含回退原文的条目）
  const localePosts = listPosts(locale);
  const index = localePosts.findIndex((p) => p.slug === slug);
  const older = localePosts[index + 1]; // 上一篇（更早发布）
  const newer = localePosts[index - 1]; // 下一篇（更晚发布）

  // BlogPosting 结构化数据：文章详情页收录（headline/日期/作者）
  const siteUrl = process.env.SITE_URL ?? "https://shaoyuanyu.cn";
  const canonicalUrl = `${siteUrl}${localePrefix(post.locale)}/blog/${post.slug}`;
  const blogPostJsonLd = {
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    headline: post.title,
    description: post.summary,
    datePublished: post.date,
    dateModified: post.date,
    // 正文实际语言（回退展示原文时与页面 locale 不同）
    inLanguage: post.locale,
    author: { "@type": "Person", name: profile.name, url: siteUrl },
    publisher: { "@type": "Person", name: profile.name, url: siteUrl },
    mainEntityOfPage: {
      "@type": "WebPage",
      "@id": canonicalUrl,
    },
  };

  const adjacentCard = (
    post: (typeof localePosts)[number],
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
    <div className="w-full mx-auto max-w-5xl px-4 py-12 sm:px-6">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(blogPostJsonLd) }}
      />
      <Link
        href="/blog"
        data-slot="button"
        className={buttonVariants({ variant: "ghost", size: "sm", className: "mb-8 -ml-2" })}
      >
        <ArrowLeftIcon data-icon="inline-start" />
        {t("backToBlog")}
      </Link>

      <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_16rem] lg:gap-12">
        <article className="min-w-0">
          <header className="mb-8 flex flex-col gap-3">
            <h1 className="text-3xl font-bold sm:text-4xl">{post.title}</h1>
            <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <CalendarIcon className="size-4" />
                <time className="font-mono">{formatDate(post.date, locale)}</time>
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

          {/* 回退提示：当前语言无译文时正文显示原文（见 lib/data/blog.ts） */}
          {post.locale !== locale && (
            <p
              data-slot="blog-fallback-notice"
              className="mb-8 flex items-center gap-2 rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground"
            >
              <LanguagesIcon data-icon="default" className="size-3.5 shrink-0" />
              {t("fallbackNotice", {
                language: t(`contentLanguage.${post.locale}`),
              })}
            </p>
          )}

          {/* 长篇正文（全站唯一使用衬线的场景，见 globals.css 字体策略）。
              data-longform：标记「衬线合法区」，供 E2E 断言「.prose 外无衬线」。 */}
          <div data-longform className="prose prose-neutral max-w-none font-serif dark:prose-invert">
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
