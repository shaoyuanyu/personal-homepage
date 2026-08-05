import Image from "next/image";
import { Icon } from "@iconify/react";
import { useLocale, useTranslations } from "next-intl";
import { MailIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { profile } from "@/lib/data";

const socialIcons: Record<string, string> = {
  github: "simple-icons:github",
  googleScholar: "academicons:google-scholar",
  semanticScholar: "academicons:semantic-scholar",
  orcid: "academicons:orcid",
  twitter: "simple-icons:x",
  zhihu: "simple-icons:zhihu",
  bilibili: "simple-icons:bilibili",
};

export function Hero() {
  const locale = useLocale();
  const t = useTranslations("hero");
  const lang = locale === "zh" ? "zh" : "en";

  const socials = Object.entries(profile.socials)
    .filter(([, url]) => url)
    .map(([key, url]) => ({ key, url, icon: socialIcons[key] }))
    .filter((s) => s.icon);

  return (
    <section className="flex flex-col-reverse items-center gap-8 py-12 sm:py-16 md:flex-row md:items-start md:gap-12">
      {/* 头像 */}
      <div className="shrink-0">
        {/* unoptimized：GIF 为动画头像，跳过图片优化以保留动画帧 */}
        <Image
          src={profile.avatar}
          alt={profile.name}
          width={168}
          height={168}
          priority
          unoptimized
          className="size-36 rounded-full border object-cover ring-1 ring-border md:size-42"
        />
      </div>

      {/* 文字信息 */}
      <div className="flex flex-col items-center gap-4 text-center md:items-start md:text-left">
        <div className="flex flex-col gap-1.5">
          <p className="text-sm text-muted-foreground">{t("hello")}</p>
          <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
            {profile.name}
          </h1>
          <p className="text-lg text-muted-foreground">
            {profile.title[lang]} · {profile.institution[lang]}
          </p>
        </div>

        <p className="max-w-xl text-sm leading-relaxed text-muted-foreground">
          {profile.bio[lang]}
        </p>

        {/* 研究方向 Badge（暂无内容时不显示） */}
        {profile.researchInterests.length > 0 && (
          <div className="flex flex-wrap items-center justify-center gap-2 md:justify-start">
            {profile.researchInterests.map((interest) => (
              <Badge key={interest.key} variant="secondary">
                {interest[lang]}
              </Badge>
            ))}
          </div>
        )}

        {/* 社交链接 */}
        <div className="mt-1 flex flex-wrap items-center justify-center gap-1 md:justify-start">
          {socials.map((social) => (
            <Button
              key={social.key}
              variant="ghost"
              size="icon-sm"
              render={
                <a href={social.url} target="_blank" rel="noopener noreferrer" aria-label={social.key} />
              }
            >
              <Icon icon={social.icon} data-icon="default" className="text-base" />
            </Button>
          ))}
          <Button
            variant="ghost"
            size="icon-sm"
            render={<a href={`mailto:${profile.email}`} aria-label="Email" />}
          >
            <MailIcon data-icon="default" className="text-base" />
          </Button>
        </div>
      </div>
    </section>
  );
}
