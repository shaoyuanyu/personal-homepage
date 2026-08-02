/** 日期格式化：ISO 字符串 → 本地化显示 */
export function formatDate(
  iso: string,
  locale: string,
  options: Intl.DateTimeFormatOptions = { year: "numeric", month: "long", day: "numeric" },
): string {
  return new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en-US", options).format(new Date(iso));
}

/** 短日期：YYYY-MM-DD */
export function formatDateShort(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10);
}
