import type { MailCopyRef } from "./types";

/**
 * 「已发送」类文件夹名（与 webmail 端 `detectSentFolder` 的回退名单一致，
 * 见 webmail/src/write.ts）：优先看 `\Sent` 特殊用途标志，回退这组常见名。
 *
 * ⚠ 前端只能按**名字精确匹配**（列表/详情返回的 copies 里只有 folder 名，
 * 不含 special-use 标志）。判定失败时按「收件」显示 = 优雅降级，
 * 不会把收到的邮件误标成「已发送」；本站账号的文件夹是「已发送」。
 * 若将来某个账号用了自定义名（如 Outbox），在 webmail 端加字段才是根治办法。
 */
const SENT_FOLDER_NAMES = new Set([
  "sent",
  "sent items",
  "sent messages",
  "已发送邮件",
  "已发送",
]);

/**
 * 这封邮件是不是「我发出的」：全部副本都落在「已发送」类文件夹。
 *
 * 收到的邮件必然有 INBOX 副本（webmail 只同步 INBOX + 已发送），
 * 故「副本全在已发送」= 自己发出的。用于列表行显示发件人还是「发给 X」、
 * 以及详情页隐藏「回复 / 快速回复」（2026-10-04 用户反馈后加的收件/发件区分）。
 */
export function isSentItem(copies: MailCopyRef[] | undefined): boolean {
  return (
    !!copies?.length &&
    copies.every((c) => SENT_FOLDER_NAMES.has(c.folder.trim().toLowerCase()))
  );
}
