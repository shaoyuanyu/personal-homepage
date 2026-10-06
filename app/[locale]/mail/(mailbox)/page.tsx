import { getTranslations, setRequestLocale } from "next-intl/server";
import { MailIcon } from "lucide-react";

import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { pageMetadata } from "@/lib/i18n/metadata";

type Props = {
  params: Promise<{ locale: string }>;
};

export async function generateMetadata({ params }: Props) {
  return {
    ...(await pageMetadata(params, "mail")),
    robots: { index: false, follow: false },
  };
}

/**
 * `/mail` 的右栏（MAIL-AGENT.md 4.12）。
 * 窄屏不显示——`MailShell` 在详情路由以外会给这一栏 `hidden`，列表单独占满屏。
 */
export default async function MailboxPage({ params }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);

  const t = await getTranslations("mail");

  // 宽屏下面板外壳（MailShell）已提供外框，这里只放居中内容，不再描虚线边
  return (
    <Empty className="min-h-[24rem]">
      <EmptyMedia variant="icon">
        <MailIcon aria-hidden />
      </EmptyMedia>
      <EmptyHeader>
        <EmptyTitle>{t("selectMessage")}</EmptyTitle>
        <EmptyDescription>{t("selectMessageHint")}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}
