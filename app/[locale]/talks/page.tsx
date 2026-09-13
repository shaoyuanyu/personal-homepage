import { useLocale, useTranslations } from "next-intl";
import { CalendarIcon, DownloadIcon, ExternalLinkIcon, MapPinIcon, PresentationIcon } from "lucide-react";

import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Separator } from "@/components/ui/separator";
import { pageMetadata } from "@/lib/i18n/metadata";
import { formatDate } from "@/lib/utils/format";
import { talks } from "@/lib/data";

type Props = {
  params: Promise<{ locale: string }>;
};

export async function generateMetadata({ params }: Props) {
  return pageMetadata(params, "talks");
}

export default function TalksPage() {
  const t = useTranslations("talks");
  const locale = useLocale();

  const sorted = [...talks].sort((a, b) => b.date.localeCompare(a.date));

  return (
    <div className="w-full mx-auto max-w-5xl px-4 py-12 sm:px-6">
      <div className="mb-8 flex flex-col gap-2">
        <h1 className="text-3xl font-bold">{t("title")}</h1>
        <p className="text-muted-foreground">{t("description")}</p>
      </div>

{sorted.length === 0 && (
              <Empty>
                <EmptyMedia variant="icon">
                  <PresentationIcon aria-hidden />
                </EmptyMedia>
                <EmptyHeader>
                  <EmptyTitle>{t("empty")}</EmptyTitle>
                </EmptyHeader>
              </Empty>
            )}

      <div className="flex flex-col gap-6">
        {sorted.map((talk) => (
          <Card key={talk.title + talk.date}>
            <CardContent className="flex flex-col gap-3 sm:flex-row sm:gap-6">
              {/* 日期 */}
              <div className="flex shrink-0 flex-col items-start gap-1 sm:w-28">
                <span className="font-mono text-sm font-semibold">{formatDate(talk.date, locale, { year: "numeric" })}</span>
                <span className="font-mono text-xs text-muted-foreground">
                  {formatDate(talk.date, locale, { month: "long", day: "numeric" })}
                </span>
              </div>

              <div className="flex min-w-0 flex-col gap-1.5">
                <h2 className="flex items-start gap-2 text-base font-medium">
                  <PresentationIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  {talk.title}
                </h2>
                <p className="text-sm text-muted-foreground">{talk.event}</p>
                {talk.location && (
                  <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <MapPinIcon className="size-3.5" />
                    {talk.location}
                  </p>
                )}
                {(talk.url || talk.slides) && (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {talk.url && (
                      <a
                        href={talk.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        data-slot="button"
                        className={buttonVariants({ variant: "ghost", size: "sm" })}
                      >
                        <ExternalLinkIcon data-icon="inline-start" />
                        Link
                      </a>
                    )}
                    {talk.slides && (
                      <a
                        href={talk.slides}
                        target="_blank"
                        rel="noopener noreferrer"
                        data-slot="button"
                        className={buttonVariants({ variant: "ghost", size: "sm" })}
                      >
                        <DownloadIcon data-icon="inline-start" />
                        Slides
                      </a>
                    )}
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
      <Separator className="my-2" aria-hidden />
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <CalendarIcon className="size-3.5" />
        {sorted.length} talks
      </p>
    </div>
  );
}
