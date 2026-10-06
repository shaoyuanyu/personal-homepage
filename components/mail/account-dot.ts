import type { CSSProperties } from "react";

/**
 * 账号色点（MAIL-AGENT.md 4.2：避开等级配色色相，用青/紫/橙/玫红一档；整串静态类名）。
 * 工具栏账号 chips、列表行的账号点列、底栏账号一览共用。
 */
const ACCOUNT_DOT: Record<string, string> = {
  cyan: "bg-cyan-600 dark:bg-cyan-400",
  violet: "bg-violet-600 dark:bg-violet-400",
  orange: "bg-orange-600 dark:bg-orange-400",
  pink: "bg-pink-600 dark:bg-pink-400",
  teal: "bg-teal-600 dark:bg-teal-400",
};

/** 命名色走静态类名；hex/任意 CSS 色走内联 style（账号配置里写的是 #0ea5e9 这类值） */
export function accountDotProps(color: string): { className: string; style?: CSSProperties } {
  const cls = ACCOUNT_DOT[color];
  if (cls) return { className: cls };
  if (color) return { className: "", style: { backgroundColor: color } };
  return { className: "bg-muted-foreground" };
}
