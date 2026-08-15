import { getTranslations, setRequestLocale } from "next-intl/server";

import { requireOwner } from "@/lib/auth/owner";
import { CalendarView } from "@/components/calendar/calendar-view";
import { pageMetadata } from "@/lib/i18n/metadata";

type Props = {
  params: Promise<{ locale: string }>;
};

export async function generateMetadata({ params }: Props) {
  return {
    ...(await pageMetadata(params, "calendar")),
    robots: { index: false, follow: false },
  };
}

/** 我的日历：主人专属页面（展示站主 CalDAV 日历事件），未登录重定向到登录页 */
export default async function CalendarPage({ params }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);

  await requireOwner();

  const t = await getTranslations("calendar");

  return (
    <div className="mx-auto max-w-5xl px-4 py-12 sm:px-6">
      {/* 标准页头排版（与论文/导航等页面一致） */}
      <div className="mb-8 flex flex-col gap-2">
        <h1 className="text-3xl font-bold tracking-tight">{t("title")}</h1>
        <p className="text-muted-foreground">{t("description")}</p>
      </div>
      <CalendarView />
    </div>
  );
}
