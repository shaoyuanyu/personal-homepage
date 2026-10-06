import { getTranslations, setRequestLocale } from "next-intl/server";

import { requireOwner } from "@/lib/auth/owner";
import { ContactsClient } from "@/components/mail/contacts-client";
import { MailPageHeader } from "@/components/mail/mail-page-header";

type Props = {
  params: Promise<{ locale: string }>;
};

export async function generateMetadata({ params }: Props) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "mail" });
  return {
    title: t("contacts.title"),
    robots: { index: false, follow: false },
  };
}

/** 通讯录（主人专属）：手动维护的联系人 + 邮件自动收录的通信地址 */
export default async function MailContactsPage({ params }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);

  await requireOwner();

  const t = await getTranslations("mail");

  return (
    <div className="w-full mx-auto max-w-6xl px-4 py-12 sm:px-6">
      {/* 页头（左上角返回 / 标题 / 描述）由共享组件统一，见 MAIL-AGENT.md 4.13 */}
      <MailPageHeader title={t("contacts.title")} description={t("contacts.description")} />
      <ContactsClient />
    </div>
  );
}
