import { getTranslations, setRequestLocale } from "next-intl/server";

import { decodeMessageId } from "@/lib/mail/id";
import { MessageView } from "@/components/mail/message-view";

type Props = {
  params: Promise<{ locale: string; id: string }>;
};

export async function generateMetadata({ params }: Props) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "mail" });
  return {
    title: t("title"),
    robots: { index: false, follow: false },
  };
}

/**
 * 单封邮件（主人专属）；id 为 base64url 编码的 messageId（`lib/mail/id.ts`）。
 *
 * 只渲染右栏内容——外壳（页面标题、入口、左栏列表、两栏布局）在
 * `(mailbox)/layout.tsx` 的 `MailShell` 里，`requireOwner` 也由那儿统一守卫。
 */
export default async function MailMessagePage({ params }: Props) {
  const { locale, id } = await params;
  setRequestLocale(locale);

  return <MessageView messageId={decodeMessageId(id)} />;
}
