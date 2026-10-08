/**
 * 邮件接口错误的展示文案（2026-10-07 统一）。
 *
 * 规则来自 MAIL-AGENT.md 4.9：**不回显内部错误码**——`webmaild_unreachable` 这类字符串
 * 用户看不懂、也没法处理；但也不能把失败伪装成「没有数据」（那会让人以为真的没有邮件）。
 *
 * 分两类：
 * - **传输层错误**（代理层给的 `webmaild_unreachable`、浏览器 fetch 的 `Failed to fetch`、
 *   401）→ 换成友好文案；
 * - **服务端业务文案**（如「账号 x 找不到『已发送』文件夹」「邮箱地址非法」）→ **原样保留**，
 *   那是可操作的，抹掉反而让人无从下手。
 */
export type MailErrorKind = "unreachable" | "unauthorized" | "business";

export function mailErrorKind(raw: string | null | undefined): MailErrorKind {
  const s = (raw ?? "").trim().toLowerCase();
  if (!s) return "unreachable";
  if (s === "webmaild_unreachable" || s.includes("failed to fetch") || s.includes("fetch failed")) {
    return "unreachable";
  }
  if (s === "unauthorized" || s === "401") return "unauthorized";
  return "business";
}

/** 展示文案：友好文案走 i18n，业务文案原样返回（`t` 只接受这三个键，避免调用方拼错） */
export function mailErrorText(
  raw: string | null | undefined,
  t: (key: "serverUnreachable" | "unauthorized" | "loadFailed") => string,
): string {
  const kind = mailErrorKind(raw);
  if (kind === "unreachable") return t("serverUnreachable");
  if (kind === "unauthorized") return t("unauthorized");
  return (raw ?? "").trim() || t("loadFailed");
}
