import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { ArrowLeftIcon, CalendarIcon } from "lucide-react";

import { MDXContent } from "@/components/blog/mdx-content";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Link } from "@/lib/i18n/navigation";
import { formatDate } from "@/lib/utils/format";
import { posts } from "@/lib/data";

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

  return (
    <article className="mx-auto max-w-3xl px-4 py-12 sm:px-6">
      <Button variant="ghost" size="sm" className="mb-8 -ml-2" render={<Link href="/blog" />}>
        <ArrowLeftIcon data-icon="inline-start" />
        {t("backToBlog")}
      </Button>

      <header className="mb-8 flex flex-col gap-3">
        <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">{post.title}</h1>
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <CalendarIcon className="size-4" />
            <time>{formatDate(post.date, locale)}</time>
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
    </article>
  );
}
