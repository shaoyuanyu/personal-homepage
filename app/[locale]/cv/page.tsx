import type { Metadata } from "next";
import { useLocale, useTranslations } from "next-intl";
import { DownloadIcon, GraduationCapIcon, MailIcon, MapPinIcon, WrenchIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { profile } from "@/lib/data";

export const metadata: Metadata = {
  title: "CV",
  description: "Curriculum Vitae",
};

const skills = ["Python", "PyTorch", "AI Safety", "LLM", "Machine Learning"]; // TODO: 替换为真实技能

export default function CVPage() {
  const t = useTranslations("cv");
  const locale = useLocale();
  const lang = locale === "zh" ? "zh" : "en";

  const timeline = [...profile.experience, ...profile.education];

  return (
    <div className="mx-auto max-w-3xl px-4 py-12 sm:px-6">
      <div className="mb-8 flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <h1 className="text-3xl font-bold tracking-tight">{t("title")}</h1>
          <p className="text-muted-foreground">{t("description")}</p>
        </div>
        <div>
          <Button size="sm" render={<a href="/cv.pdf" target="_blank" rel="noopener noreferrer" />}>
            <DownloadIcon data-icon="inline-start" />
            {t("download")}
          </Button>
        </div>
      </div>

      <div className="flex flex-col gap-6">
        {/* 联系信息 */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">{t("contact")}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2 text-sm text-muted-foreground">
            <p className="flex items-center gap-2">
              <MailIcon className="size-4" />
              <a href={`mailto:${profile.email}`} className="hover:text-foreground hover:underline">
                {profile.email}
              </a>
            </p>
            <p className="flex items-center gap-2">
              <MapPinIcon className="size-4" />
              {profile.location[lang]}
            </p>
          </CardContent>
        </Card>

        {/* 经历时间线 */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <GraduationCapIcon className="size-4 text-muted-foreground" />
              {t("education")}
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-5">
            {timeline.map((item) => (
              <div key={item.period + item.zh} className="relative pl-5">
                <span
                  aria-hidden
                  className="absolute top-1.5 left-0 size-2 rounded-full bg-primary/60"
                />
                <p className="text-sm font-medium">{item[lang]}</p>
                <p className="text-sm text-muted-foreground">{item.institution[lang]}</p>
                <p className="font-mono text-xs text-muted-foreground">{item.period}</p>
              </div>
            ))}
          </CardContent>
        </Card>

        {/* 技能 */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <WrenchIcon className="size-4 text-muted-foreground" />
              {t("skills")}
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            {skills.map((skill) => (
              <span
                key={skill}
                className="rounded-full border px-3 py-1 text-xs text-muted-foreground"
              >
                {skill}
              </span>
            ))}
          </CardContent>
        </Card>
      </div>
      <Separator className="mt-8" aria-hidden />
    </div>
  );
}
