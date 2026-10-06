import type { MailAccount } from "@/lib/mail/types";

/**
 * 账号显示文案（2026-10-05 用户定稿，尖括号形式）：
 * - 有备注名 → 「备注名<邮箱>」——只显示备注名无法辨识是哪个邮箱；
 * - 无备注名 → 直接显示邮箱。
 * 工具栏账号下拉（触发器 + 菜单项）、底栏账号一览的悬浮提示共用同一格式。
 */
export function accountLabel(account: Pick<MailAccount, "displayName" | "email">): string {
  return account.displayName ? `${account.displayName}<${account.email}>` : account.email;
}

/**
 * 发件人显示文案（写信页的「发件人」下拉，2026-10-06 用户定稿）：**实际外发身份**——
 * 发件人姓名（senderName）随邮件发出，写信页所见即收件人所见；无发件人姓名时只
 * 显示邮箱地址（**从不会回落到备注名**——那是仅站内可见的本地信息，见 types.ts 的
 * senderName 注释）。
 */
export function senderLabel(account: Pick<MailAccount, "senderName" | "email">): string {
  return account.senderName ? `${account.senderName}<${account.email}>` : account.email;
}
