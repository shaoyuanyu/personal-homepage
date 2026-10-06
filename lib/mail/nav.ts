/**
 * 邮件「列表 ⇄ 详情」跳转的 Next router 选项（MAIL-AGENT.md 4.12）。
 *
 * 宽屏（≥lg = 1024px）下列表常驻左栏，详情在右栏原地切换——
 * 此时若按默认行为 `scroll: true`，每打开一封信都会把窗口滚回顶部，
 * 左侧列表跟着跳回第一条，翻到第 30 封点开就丢失位置。
 * 窄屏是整页跳转，滚到顶部才是对的（否则会停在上一篇的滚动位置）。
 */
export function mailNavOptions(): { scroll: boolean } {
  if (typeof window === "undefined") return { scroll: true };
  return { scroll: !window.matchMedia("(min-width: 64rem)").matches };
}
