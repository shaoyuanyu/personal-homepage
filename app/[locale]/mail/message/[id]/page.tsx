import { getTranslations, setRequestLocale } from "next-intl/server";

import { requireOwner } from "@/lib/auth/owner";
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

/** 单封邮件详情（主人专属）；id 为 base64url 编码的 messageId（lib/mail/id.ts） */
export default async function MailMessagePage({ params }: Props) {
  const { locale, id } = await params;
  setRequestLocale(locale);

  await requireOwner();

  return (
    <div className="w-full mx-auto max-w-3xl px-4 py-12 sm:px-6">
      <MessageView messageId={decodeMessageId(id)} />
    </div>
  );
}
