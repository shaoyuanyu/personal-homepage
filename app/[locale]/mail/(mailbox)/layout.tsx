import { getTranslations, setRequestLocale } from "next-intl/server";
import { BookUserIcon, BotIcon } from "lucide-react";

import { requireOwner } from "@/lib/auth/owner";
import { AccountsDialog } from "@/components/mail/accounts-dialog";
import { MailShell } from "@/components/mail/mail-shell";
import { MailUnreadBadge } from "@/components/mail/new-mail-notifier";
import { Link } from "@/lib/i18n/navigation";
import { buttonVariants } from "@/components/ui/button";

type Props = {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
};

/**
 * 信箱外壳（`/mail` 与 `/mail/message/:id` 共用，MAIL-AGENT.md 4.12）。
 *
 * 列表（`MailClient`）挂在这里而不是页面里：两个路由共用同一个 layout 实例，
 * 客户端导航时不会重新挂载 —— 翻列表、搜关键词、点开一封、再回列表，
 * 滚动位置与筛选状态都还在。页面（`children`）只负责右栏那部分。
 *
 * `/mail/contacts`、`/mail/agent` 不在这个路由组内，仍是各自独立的整页（不套两栏外壳）；
 * `/mail/compose` 已并入本组——桌面端在右栏内撰写（左列表保持可见）、窄屏整页，
 * 与 `/mail/message/:id` 同一套「右栏子页面」规则（用户 2026-10-05：入口就在工具栏面板里，
 * 点击却整页跳走，很割裂）。
 */
export default async function MailboxLayout({ children, params }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);

  await requireOwner();

  const t = await getTranslations("mail");

  return (
    // ⚠ 容器宽度 = 站点标准列 `max-w-6xl`（与 site-header / site-footer / 其它页面一致）。
    //   页面的内容宽度与左右边界必须与站点栏线完全一致，宽出或窄出都会立刻看出。
    //   宽屏下页面锁定为「视口高度 − 站点上下装饰」：站点头部（h-14 = 3.5rem + 1px 底边框）
    //   + 页脚（border-t 1px + py-6 ×2 + 一行 text-xs = 4.0625rem，共 122px）。
    //   于是面板高度只由视口决定，与「全部 / 未读 / 星标」筛出多少邮件无关（4.12）：
    //   少邮件时面板不缩成一小条，多邮件时列表在面板内部滚动、页面本身不滚（页脚正好在折线处）。
    //   窄屏保持自然文档流（整页滚动），与手机邮件客户端一致。
    <div className="mx-auto flex w-full max-w-6xl flex-col px-4 py-12 sm:px-6 lg:h-[calc(100dvh_-_3.5rem_-_1px_-_4.0625rem)] lg:overflow-hidden">
      <div className="mb-8 flex shrink-0 flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex flex-col gap-2">
          {/* 未读角标（2026-10-06 用户需求）：大标题右上角，新邮件到达时播放弹跳动画
              （见 MailUnreadBadge / new-mail-notifier.tsx） */}
          <h1 className="text-3xl font-bold">
            {t("title")}
            <MailUnreadBadge />
          </h1>
          <p className="text-muted-foreground">{t("description")}</p>
        </div>
        <div className="flex items-center gap-2">
          {/* 通讯录（联系人 CRUD + 自动收录） */}
          <Link
            href="/mail/contacts"
            data-slot="button"
            className={buttonVariants({ variant: "outline", size: "sm" })}
          >
            <BookUserIcon data-icon="default" aria-hidden />
            {t("contacts.entry")}
          </Link>
          {/* 账号管理（增删邮箱账号，保存前做 IMAP/SMTP 连接测试） */}
          <AccountsDialog />
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
      </div>
      <MailShell>{children}</MailShell>
    </div>
  );
}
