import { Suspense } from "react";
import { getTranslations, setRequestLocale } from "next-intl/server";

import { requireOwner } from "@/lib/auth/owner";
import { ComposeForm } from "@/components/mail/compose-form";

type Props = {
  params: Promise<{ locale: string }>;
};

export async function generateMetadata({ params }: Props) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "mail" });
  return {
    title: t("composeTitle"),
    robots: { index: false, follow: false },
  };
}

/** 写邮件（主人专属）；?replyTo=<messageId> 进入回复模式 */
export default async function MailComposePage({ params }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);

  await requireOwner();

  const t = await getTranslations("mail");

  return (
    <div className="w-full mx-auto max-w-3xl px-4 py-12 sm:px-6">
      <div className="mb-8 flex flex-col gap-2">
        <h1 className="text-3xl font-bold">{t("composeTitle")}</h1>
      </div>
      {/* useSearchParams 需要 Suspense 边界 */}
      <Suspense>
        <ComposeForm />
      </Suspense>
    </div>
  );
}
