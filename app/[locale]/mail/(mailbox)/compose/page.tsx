import { Suspense } from "react";
import { getTranslations, setRequestLocale } from "next-intl/server";

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

/**
 * 写邮件（主人专属）；`?replyTo=<messageId>` 进入回复 / 回复全部，`?forward=` 转发。
 *
 * 只渲染右栏内容——外壳（两栏布局、左栏列表、`requireOwner` 守卫）在
 * `(mailbox)/layout.tsx` 的 `MailShell` 里，与 `/mail/message/[id]` 同构。
 * 用户 2026-10-05 反馈：入口在工具栏（面板内）里、点击却整页跳走，很割裂
 * ——现在桌面端在右栏内撰写（左列表保持可见，写完 / 写完一半都能接着翻信），
 * 窄屏整页（与详情同规则）；回复 / 转发 / 通讯录「写信」共用本路由，一并受益。
 */
export default async function MailComposePage({ params }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);

  // useSearchParams 需要 Suspense 边界
  return (
    <Suspense>
      <ComposeForm />
    </Suspense>
  );
}
