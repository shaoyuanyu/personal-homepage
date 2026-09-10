/**
 * CCF 等级 / 中科院分区 的配色（单一事实来源）。
 *
 * ccf · cas · deadlines · venues 四页此前各自内联重复定义了同一套色板，
 * 改一处颜色需要同步四个文件（且极易漏改）。现统一收敛到此处。
 *
 * ---- 配色原则（可访问性）----
 * 徽章都是「小字号 + 彩色」的组合，最容易被忽略的对比度陷阱，故固定为：
 *   浅色：`text-*-700` on `bg-*-50`  → 对比度 4.9~6.4:1（达 WCAG AA 正文 4.5:1）
 *   深色：`text-*-400` on `bg-*-500/15` → 对比度 ≥ 6:1
 * 此前用 `text-*-600` + `bg-*-500/10`，浅色下只有 3.2~4.1:1（未达 AA），
 * 且半透明底叠加在灰底上会进一步变脏，故改为实色 50 号底。
 *
 * ⚠ Tailwind 按字面扫描，以下类名必须**整串静态写出**，不可用模板字符串拼接
 *   （如 `text-${tone}-700` 会被漏掉导致样式丢失）。
 *
 * ⚠ 色相语义固定，勿随意调换：A/1区=红（最高）→ B/2区=蓝 → C/3区=绿 → 4区=琥珀。
 *   `none`（未收录）必须用中性灰，不得借用彩色——否则游客会误读为「有等级」。
 */

/** 等级色相 */
export type GradeTone = "red" | "blue" | "emerald" | "amber" | "neutral";

/** 徽章胶囊：浅色底 + 深色字 + 内描边；深浅色模式各一套 */
export const TONE_CHIP: Record<GradeTone, string> = {
  red: "bg-red-50 text-red-700 ring-red-700/20 dark:bg-red-500/15 dark:text-red-400",
  blue: "bg-blue-50 text-blue-700 ring-blue-700/20 dark:bg-blue-500/15 dark:text-blue-400",
  emerald:
    "bg-emerald-50 text-emerald-700 ring-emerald-700/20 dark:bg-emerald-500/15 dark:text-emerald-400",
  amber:
    "bg-amber-50 text-amber-700 ring-amber-700/20 dark:bg-amber-500/15 dark:text-amber-400",
  neutral: "bg-muted text-muted-foreground ring-border",
};

/** 行首 hover 色条（3px 竖条） */
export const TONE_BAR: Record<GradeTone, string> = {
  red: "bg-red-500",
  blue: "bg-blue-500",
  emerald: "bg-emerald-500",
  amber: "bg-amber-500",
  neutral: "bg-border",
};

/** 学科分区圆点（列表里的极小标识） */
export const TONE_DOT: Record<GradeTone, string> = {
  red: "bg-red-500",
  blue: "bg-blue-500",
  emerald: "bg-emerald-500",
  amber: "bg-amber-500",
  neutral: "bg-muted-foreground/40",
};

/** CCF 推荐等级 → 色相 */
export const CCF_LEVEL_TONE: Record<string, GradeTone> = {
  A: "red",
  B: "blue",
  C: "emerald",
  none: "neutral",
};

/** 中科院分区 → 色相 */
export const CAS_ZONE_TONE: Record<string, GradeTone> = {
  1: "red",
  2: "blue",
  3: "emerald",
  4: "amber",
};

/** 取 CCF 等级徽章类名（未收录 → 中性） */
export function ccfChipClass(level: string | null | undefined): string {
  return TONE_CHIP[CCF_LEVEL_TONE[level ?? "none"] ?? "neutral"];
}

/** 取中科院分区徽章类名（无分区 → 中性） */
export function casChipClass(zone: number | string | null | undefined): string {
  return TONE_CHIP[CAS_ZONE_TONE[String(zone ?? "")] ?? "neutral"];
}

/** 取中科院分区圆点类名（无分区 → 中性） */
export function casDotClass(zone: number | string | null | undefined): string {
  return TONE_DOT[CAS_ZONE_TONE[String(zone ?? "")] ?? "neutral"];
}

/** 取行首色条类名（CCF 等级） */
export function ccfBarClass(level: string | null | undefined): string {
  return TONE_BAR[CCF_LEVEL_TONE[level ?? "none"] ?? "neutral"];
}

/** 取行首色条类名（中科院分区） */
export function casBarClass(zone: number | string | null | undefined): string {
  return TONE_BAR[CAS_ZONE_TONE[String(zone ?? "")] ?? "neutral"];
}
