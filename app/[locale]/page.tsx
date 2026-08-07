import { useLocale, useTranslations } from "next-intl";
import {
  ArrowRightIcon,
  BrainCircuitIcon,
  GraduationCapIcon,
  MailIcon,
  MapPinIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
} from "lucide-react";

import { Hero } from "@/components/sections/hero";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { Link } from "@/lib/i18n/navigation";
import { formatDate } from "@/lib/utils/format";
import { profile, posts } from "@/lib/data";

const interestIcons = {
  "ai-safety": ShieldCheckIcon,
  interpretability: BrainCircuitIcon,
  "continual-learning": RefreshCwIcon,
} as const;

export default function HomePage() {
  const locale = useLocale();
  const t = useTranslations("home");
  const lang = locale === "zh" ? "zh" : "en";

  const latestPosts = posts
    .filter((p) => p.locale === locale)
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 3);

  // Person 结构化数据：帮助搜索引擎（Google 学术等）正确索引个人主页
  const siteUrl = process.env.SITE_URL ?? "https://shaoyuanyu.cn";
  const personJsonLd = {
    "@context": "https://schema.org",
    "@type": "Person",
    name: profile.name,
    url: siteUrl,
    image: `${siteUrl}${profile.avatar}`,
    email: `mailto:${profile.email}`,
    jobTitle: profile.title[lang],
    affiliation: {
      "@type": "Organization",
      name: profile.institution[lang],
    },
    alumniOf: profile.education.map((edu) => ({
      "@type": "CollegeOrUniversity",
      name: edu.institution[lang],
    })),
    sameAs: Object.values(profile.socials).filter(Boolean),
  };

  return (
    <div className="mx-auto max-w-5xl px-4 sm:px-6">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(personJsonLd) }}
      />
      <Hero />

      {/* 研究方向（暂无内容时隐藏） */}
      {profile.researchInterests.length > 0 && (
        <section className="py-8">
          <div className="mb-4 flex items-center gap-3">
            <h2 className="text-xl font-semibold tracking-tight">{t("researchInterests")}</h2>
            <Separator className="flex-1" />
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            {profile.researchInterests.map((interest) => {
              const Icon = interestIcons[interest.key as keyof typeof interestIcons] ?? BrainCircuitIcon;
              return (
                <Card key={interest.key} className="border-dashed">
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2 text-base">
                      <Icon className="size-5 text-muted-foreground" />
                      {interest[lang]}
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-sm text-muted-foreground">
                      {t(`interestDescriptions.${interest.key}`)}
                    </p>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </section>
      )}

      {/* 最新博客 */}
      <section className="py-8">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <h2 className="text-xl font-semibold tracking-tight">{t("blog")}</h2>
            <Separator className="hidden flex-1 sm:block" />
          </div>
          <Button variant="ghost" size="sm" render={<Link href="/blog" />}>
            {t("viewAllBlog")}
            <ArrowRightIcon data-icon="inline-end" />
          </Button>
        </div>
        <div className="flex flex-col gap-3">
          {latestPosts.map((post) => (
            <Card key={post.slug}>
              <CardHeader className="py-4">
                <CardTitle className="text-base">
                  <Link href={`/blog/${post.slug}`} className="hover:underline">
                    {post.title}
                  </Link>
                </CardTitle>
                <CardDescription className="flex items-center gap-2 text-xs">
                  <time>{formatDate(post.date, locale)}</time>
                  <span aria-hidden>·</span>
                  {post.tags.map((tag) => (
                    <Badge key={tag} variant="outline">{tag}</Badge>
                  ))}
                </CardDescription>
              </CardHeader>
            </Card>
          ))}
        </div>
      </section>

      {/* 教育经历 + 联系方式 */}
      <section className="grid gap-8 py-8 pb-14 sm:grid-cols-2">
        <div>
          <h2 className="mb-4 flex items-center gap-2 text-xl font-semibold tracking-tight">
            <GraduationCapIcon className="size-5 text-muted-foreground" />
            {t("education")}
          </h2>
          <div className="flex flex-col gap-4">
            {profile.education.map((edu) => (
              <div key={edu.period} className="flex flex-col gap-0.5">
                <p className="text-sm font-medium">{edu[lang]}</p>
                <p className="text-sm text-muted-foreground">{edu.institution[lang]}</p>
                <p className="font-mono text-xs text-muted-foreground">{edu.period}</p>
              </div>
            ))}
          </div>
        </div>

        <div>
          <h2 className="mb-4 text-xl font-semibold tracking-tight">{t("contact")}</h2>
          <div className="flex flex-col gap-3 text-sm">
            <p className="flex items-center gap-2 text-muted-foreground">
              <MailIcon className="size-4" />
              <a href={`mailto:${profile.email}`} className="hover:text-foreground hover:underline">
                {profile.email}
              </a>
            </p>
            <p className="flex items-center gap-2 text-muted-foreground">
              <MapPinIcon className="size-4" />
              {profile.location[lang]}
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
