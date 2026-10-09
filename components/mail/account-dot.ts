import type { CSSProperties } from "react";

/**
 * 账号色点（MAIL-AGENT.md 4.2：避开等级配色色相，用青/紫/橙/玫红/蓝绿一档；整串静态类名）。
 * 工具栏账号 chips、列表行的账号点列、底栏账号一览共用。
 */
const ACCOUNT_DOT: Record<string, string> = {
  cyan: "bg-cyan-600 dark:bg-cyan-400",
  violet: "bg-violet-600 dark:bg-violet-400",
  orange: "bg-orange-600 dark:bg-orange-400",
  pink: "bg-pink-600 dark:bg-pink-400",
  teal: "bg-teal-600 dark:bg-teal-400",
};

/**
 * 色板顺序 = 分配顺序 = 账号管理弹窗里色板的排列顺序。
 *
 * ⚠ 这是**「每次取离已用色最远」的贪心解**（浅色 600 档 OKLab ΔE：cyan→pink 31.1、
 *   再 violet 24.5、再 orange 15.4、最后 teal 6.9）：按顺序取第一个未占用的色，就等于
 *   「每次挑一个跟已有账号差距最大的」——第 1、2 个账号拿到的是色板里差距最大的一对。
 *   ⚠ 唯一弱项是**第 5 个**（teal 与 cyan ΔE 只有 6.9，肉眼难分）：要到第 5 个账号才会遇到。
 *
 * ⚠ 与后端 `webmail/src/accounts.ts` 的 `ACCOUNT_COLOR_PALETTE` 是**同一套名字、同一顺序**，
 *   改动必须两处同步（同 SENT_FOLDER_NAMES 的约定）；顺序决定「下一个没被占用的颜色」是哪个，
 *   两边不一致时新建账号拿到的颜色会与弹窗里的高亮对不上。
 */
export const ACCOUNT_COLOR_NAMES = ["cyan", "pink", "violet", "orange", "teal"] as const;

export type AccountColorName = (typeof ACCOUNT_COLOR_NAMES)[number];

/**
 * 历史遗留色 → 色板名。
 *
 * ⚠ 老版本的缺省色是**写死的** `#0ea5e9`（天蓝），凡「按色板避让」的地方都必须把它当成
 *   `cyan` 占位：不然新建账号预选的「第一个没人用的色」又会落回同一种蓝，正是用户报的
 *   那个问题（同一屏两个一模一样的色点）。值与 `webmail/src/accounts.ts` 同步。
 */
const LEGACY_COLOR_ALIAS: Record<string, AccountColorName> = { "#0ea5e9": "cyan" };

/**
 * 颜色的比较键：色板名原样、历史缺省色归到对应色板名、其余（自定义 hex）原样小写。
 * **只用于比较/避让，不用于存储**——存储值保持用户配置的原样。
 */
export function accountColorKey(color: string): string {
  const c = color.trim().toLowerCase();
  return LEGACY_COLOR_ALIAS[c] ?? c;
}

/**
 * 下一个未被占用的账号色（`used` = 现有账号的颜色）。
 *
 * ⚠ 存在的理由同后端：缺省色若是常量，从界面加进来的账号就全是同一个颜色，色点没有信息
 *   （2026-10-09 用户报「账号指示器中多个账号之间的颜色没有区别」）。这里是**弹窗里的预选**
 *   ——真正落盘的颜色以后端为准（后端同样避让已占用的色）。
 */
export function nextAccountColor(used: Iterable<string>): string {
  const taken = new Set([...used].map(accountColorKey));
  return (
    ACCOUNT_COLOR_NAMES.find((c) => !taken.has(c)) ??
    ACCOUNT_COLOR_NAMES[taken.size % ACCOUNT_COLOR_NAMES.length]
  );
}

/** 命名色走静态类名；hex/任意 CSS 色走内联 style（账号配置里写的是 #0ea5e9 这类值） */
export function accountDotProps(color: string): { className: string; style?: CSSProperties } {
  const cls = ACCOUNT_DOT[color];
  if (cls) return { className: cls };
  if (color) return { className: "", style: { backgroundColor: color } };
  return { className: "bg-muted-foreground" };
}
