"use client";

import { useTranslations } from "next-intl";
import { ArrowLeftIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { Link } from "@/lib/i18n/navigation";
import { buttonVariants } from "@/components/ui/button";

/**
 * 邮件子页面（写邮件 / 通讯录 / agent 邮件）的页头（MAIL-AGENT.md 4.13）。
 *
 * 三页统一版式：**左上角**一条 ghost「返回邮件」（`-ml-2` 光学对齐到内容左缘）→ `h1` → 可选描述。
 *
 * - **为什么返回入口在左而不是右**：它是「离开本页」的导航动作，与页面标题同属一条阅读线；
 *   页头右上角留给页面自己的动作（`/mail` 的通讯录 / 账号 / agent 邮件三颗入口）。
 * - **为什么单独占一行、而不是挤在 `h1` 左侧**：挤在标题左侧会把标题整体右推，
 *   与下方描述、正文的左缘错开一截（视觉上像页面歪了）；单独一行则标题仍与下方内容对齐。
 * - ⚠ 返回文案取 `mail.backToMail`（返回邮件），与 `/mail` 的 `h1`「邮件」对齐。
 *   **勿写成**「返回列表」（那是站内邮箱视图里对列表的说法，见 `mail.backToList`）、
 *   也不要「返回收件箱」（本站没有「收件箱」这个概念，用户 2026-10 反馈会与标题对不上）。
 * - ⚠ 三页的页头**都用这个组件**，别各写一份——此前通讯录把返回按钮放在右上角、
 *   文案还是「返回收件箱」，与写邮件页两套写法（用户反馈）。
 */
export function MailPageHeader({ title, description }: { title: string; description?: string }) {
  const t = useTranslations("mail");
  return (
    <div className="mb-8 flex flex-col gap-2">
      <div>
        <Link
          href="/mail"
          data-slot="button"
          className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "-ml-2")}
        >
          <ArrowLeftIcon data-icon="default" />
          {t("backToMail")}
        </Link>
      </div>
      <h1 className="text-3xl font-bold">{title}</h1>
      {description ? <p className="text-muted-foreground">{description}</p> : null}
    </div>
  );
}
