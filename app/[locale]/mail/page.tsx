import { getTranslations, setRequestLocale } from "next-intl/server";
import { BotIcon } from "lucide-react";

import { requireOwner } from "@/lib/auth/owner";
import { MailClient } from "@/components/mail/mail-client";
import { Link } from "@/lib/i18n/navigation";
import { pageMetadata } from "@/lib/i18n/metadata";
import { buttonVariants } from "@/components/ui/button";

type Props = {
  params: Promise<{ locale: string }>;
};

export async function generateMetadata({ params }: Props) {
  return {
    ...(await pageMetadata(params, "mail")),
    robots: { index: false, follow: false },
  };
}

/** 站内 webmail：主人专属页面，未登录重定向到登录页（MAIL-AGENT.md 4.1） */
export default async function MailPage({ params }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);

  await requireOwner();

  const t = await getTranslations("mail");

  return (
    <div className="w-full mx-auto max-w-5xl px-4 py-12 sm:px-6">
      <div className="mb-8 flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex flex-col gap-2">
          <h1 className="text-3xl font-bold">{t("title")}</h1>
          <p className="text-muted-foreground">{t("description")}</p>
        </div>
        {/* agent@ 只读入口（4.3：专门入口，不进合并视图与账号筛选） */}
        <Link
          href="/mail/agent"
          data-slot="button"
          className={buttonVariants({ variant: "outline", size: "sm" })}
        >
          <BotIcon data-icon="default" aria-hidden />
          {t("agent.entry")}
        </Link>
      </div>
      <MailClient />
    </div>
  );
}
