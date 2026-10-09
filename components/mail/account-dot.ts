import type { CSSProperties } from "react";

/**
 * 账号色点（MAIL-AGENT.md 4.2）。
 *
 * ⚠ **值是算出来的，不是手挑的**——`scripts/gen-account-colors.mjs` 生成，改动请改脚本再重跑，
 *   不要手改这里的 hex（手改就等于又回到"挑档位"，下一轮还得再挑一次）。
 *
 * 生成规则（脚本里的完整推导）：
 *   · 色相：沿用五个色相族（由旧 Tailwind 600 档锚定），避开等级配色（CCF A/B/C、中科院 1-4 区）
 *     与列表行方向角标的 emerald/amber；
 *   · 明度：浅色 L=0.70、深色 L=0.78（深色底近黑，要更亮）；
 *   · 彩度：**导出**，= min(五个色相在该明度下的 sRGB 彩度上限) = 0.124/0.123
 *     —— 写死彩度会让超出 sRGB 的色相被静默截断，"一样彩度"就成了空话；
 *   · 结果：五个色**明度极差 0.001、彩度极差 0.001**（实测回读），即"一样浅、一样柔"。
 *
 * ⚠ 2026-10-09 之前是 Tailwind 600 / 400 档：明度与彩度各不相同（pink-600 彩度 0.25、teal-600 仅 0.11），
 *   同屏里有的色显得重、有的轻，用户反馈「太艳、太丑」。现在整组色的最小 OKLab ΔE **7.9**（浅色），
 *   与旧组的 7.8 持平 —— 观感明显更柔和，可分辨度没有下降。
 *   ⚠ 最弱的一对仍是 **cyan ↔ teal**（色相只差 33°）：这是"避开红/蓝/绿/琥珀 + 深色下不撞方向角标
 *   emerald"的代价。要拉开它只能给第 5 个色换到绿色系（撞方向角标）或暖褐色系，**换之前先问用户**。
 *
 * ⚠ 顺序（= ACCOUNT_COLOR_NAMES）只影响"第 k 个账号拿到哪个色"。旧实现里顺序很关键（贪心序能把
 *   第 2 个账号的距离从 24.5 提到 31.1）；统一明度/彩度后**任意两色的 ΔE 都 ≥0.95×2C**，顺序的影响
 *   降到 0%（脚本实测：声明顺序 7.9 = 贪心最优 7.9），所以顺序按观感定：先蓝后粉。
 */
const ACCOUNT_DOT: Record<string, string> = {
  cyan: "bg-[#1eafd5] dark:bg-[#47c9ef]",
  pink: "bg-[#dc7c9a] dark:bg-[#f895b3]",
  violet: "bg-[#a28fe4] dark:bg-[#baa8ff]",
  orange: "bg-[#de8360] dark:bg-[#fa9c78]",
  teal: "bg-[#00b7a8] dark:bg-[#3dd1c1]",
};

/**
 * 色板名，顺序 = 账号管理弹窗里色板的排列顺序。
 * ⚠ 与后端 `webmail/src/accounts.ts` 的 `ACCOUNT_COLOR_PALETTE` 是**同一套名字、同一顺序**，
 *   改动必须两处同步（同 SENT_FOLDER_NAMES 的约定）。
 */
export const ACCOUNT_COLOR_NAMES = ["cyan", "pink", "violet", "orange", "teal"] as const;

export type AccountColorName = (typeof ACCOUNT_COLOR_NAMES)[number];

/**
 * 历史遗留色 → 色板名。
 *
 * ⚠ 老版本的缺省色是**写死的** `#0ea5e9`（天蓝），凡「按色板避让」的地方都必须把它当成
 *   `cyan` 占位：不然新建账号预选的「第一个没人用的色」又会落回同一种蓝，正是用户报的
 *   那个问题（同一屏两个一模一样的色点）。值与 `webmail/src/accounts.ts` 同步。
 * ⚠ 渲染时也走这个别名（见 `accountDotProps`）：色板换成"柔和档"之后，若注册表里的 `#0ea5e9`
 *   还按原样画，它就会比同组色艳一大截——同一个账号在两处显示不同色（2026-10-09 用户报过一次）。
 */
const LEGACY_COLOR_ALIAS: Record<string, AccountColorName> = { "#0ea5e9": "cyan" };

/**
 * 颜色的比较键：色板名原样、历史缺省色归到对应色板名、其余（自定义 hex）原样小写。
 * **只用于比较/避让**——存储值保持用户配置的原样。
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

/**
 * 命名色走静态类名；hex/任意 CSS 色走内联 style（账号配置里写的是 #0ea5e9 这类值）。
 *
 * ⚠ 先过 `accountColorKey`：历史缺省色 `#0ea5e9` 要按 `cyan` 的类名渲染，不能落到内联 style
 *   ——否则它会以原本那个偏艳的天蓝画出来，与同组其它色不是一套（同一个账号在底栏与弹窗里一致，
 *   但和别的账号摆在一起显得突兀）。
 */
export function accountDotProps(color: string): { className: string; style?: CSSProperties } {
  const cls = ACCOUNT_DOT[accountColorKey(color)];
  if (cls) return { className: cls };
  if (color) return { className: "", style: { backgroundColor: color } };
  return { className: "bg-muted-foreground" };
}
