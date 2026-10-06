import { getTranslations, setRequestLocale } from "next-intl/server";

import { requireOwner } from "@/lib/auth/owner";
import { AgentView } from "@/components/mail/agent-view";
import { MailPageHeader } from "@/components/mail/mail-page-header";
import { pageMetadata } from "@/lib/i18n/metadata";

type Props = {
  params: Promise<{ locale: string }>;
};

export async function generateMetadata({ params }: Props) {
  return {
    ...(await pageMetadata(params, "mail.agent")),
    robots: { index: false, follow: false },
  };
}

/** agent@ 的只读入口（MAIL-AGENT.md 4.3）：排查与建立信任，页面无任何写操作 */
export default async function MailAgentPage({ params }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);

  await requireOwner();

  const t = await getTranslations("mail.agent");

  return (
    <div className="w-full mx-auto max-w-6xl px-4 py-12 sm:px-6">
      {/* 页头（左上角返回 / 标题 / 描述）由共享组件统一，见 MAIL-AGENT.md 4.13 */}
      <MailPageHeader title={t("title")} description={t("description")} />
      <AgentView />
    </div>
  );
}
