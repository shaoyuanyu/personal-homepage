import Image from "next/image";
import { Icon } from "@iconify/react";
import { useLocale, useTranslations } from "next-intl";
import { MailIcon } from "lucide-react";

import { buttonVariants } from "@/components/ui/button";
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
    <section
      data-display-serif
      className="flex flex-col-reverse items-center gap-8 py-12 sm:py-16 md:flex-row md:items-start md:gap-12"
    >
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
          {/* 人名 + 职务行：**衬线的第二个合法角色（display serif）** ——
              对应 Anthropic 首页 `.big-cta_title`（衬线 68.3px / **w500** / lh1.1）
              + `.big-cta_subtitle`（衬线 24px / w400）的「品牌展示标题块」写法。
              大字靠字号撑气场而非字重（Anthropic 用 w500），故此处 w-500 + text-6xl。
              上方问候语仍无衬线（它是 UI 标签语气，与大字衬线形成 register 对比）。 */}
          <h1 className="font-serif text-5xl font-medium sm:text-6xl">
            {profile.name}
          </h1>
          <p className="font-serif text-lg text-muted-foreground">
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
            <a
              key={social.key}
              href={social.url}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={social.key}
              data-slot="button"
              className={buttonVariants({ variant: "ghost", size: "icon-sm" })}
            >
              <Icon icon={social.icon} data-icon="default" className="text-base" />
            </a>
          ))}
          <a
            href={`mailto:${profile.email}`}
            aria-label="Email"
            data-slot="button"
            className={buttonVariants({ variant: "ghost", size: "icon-sm" })}
          >
            <MailIcon data-icon="default" className="text-base" />
          </a>
        </div>
      </div>
    </section>
  );
}
