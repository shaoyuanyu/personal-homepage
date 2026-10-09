// 账号色板生成器 —— 账号色点从「手挑的 Tailwind 档位」改成**按公式算出来的一组色**。
//
// 输入只有两个数：浅色明度 L、深色明度 L（深色比浅色亮一档，因为底色是近黑）。
// 其余全部导出：
//   · 彩度 C = min(各色相在该明度下的 sRGB 彩度上限) —— 保证五个色**真的一样彩度**
//     （直接写死 C 会因为某些色相超色域而被静默截断，"统一"就成了空话）；
//   · 色相 = 五个现有色相族（由旧 Tailwind 600 档锚定，色相不变，只换明度/彩度）；
//   · 顺序 = 「每次取离已用色最远」的贪心解（脚本会验算，保证前 k 个色最分得开）。
//
// 用法：
//   node scripts/gen-account-colors.mjs                 # 默认 L=0.73 / 0.81
//   node scripts/gen-account-colors.mjs 0.78 0.86       # 浅 L / 深 L
//   node scripts/gen-account-colors.mjs --scanL         # 扫明度，看彩度上限与对比度
//   node scripts/gen-account-colors.mjs --bands "0.78 0.86" "0.73 0.81"   # JSON（给取证脚本）
//   node scripts/gen-account-colors.mjs --check           # 只检查 account-dot.ts 有没有漂移（不一致则退出码 1）
//
// 为什么不按「账号数量」动态重排颜色：账号色是**身份标识**，加第三个账号时把前两个的颜色
// 也换掉会让人认不出谁是谁。所以顺序固定为贪心序 —— 第 1、2 个账号天然拿到差距最大的一对。

import { readFileSync } from "node:fs";

// ---------------- 颜色数学（sRGB ↔ OKLab/OKLCH，Björn Ottosson） ----------------
const lin = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const gam = (v) => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);
const hex2rgb = (h) => [0, 2, 4].map((i) => parseInt(h.replace("#", "").slice(i, i + 2), 16));
const rgb2hex = (rgb) =>
  "#" + rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");
const rgb2oklab = ([r, g, b]) => {
  const R = lin(r / 255), G = lin(g / 255), B = lin(b / 255);
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
};
const oklab2rgb = ([L, a, b]) => {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3;
  const R = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const G = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const B = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
  return [R, G, B].map(gam);
};
/** 是否在 sRGB 内（留 5e-4 余量，避免浮点误差把边界值判成越界） */
const inGamut = (L, C, h) => {
  const r = (h * Math.PI) / 180;
  return oklab2rgb([L, C * Math.cos(r), C * Math.sin(r)]).every((v) => v >= -0.0005 && v <= 1.0005);
};
/** 某色相在该明度下 sRGB 能给的最大彩度 */
const maxChroma = (L, h) => {
  let lo = 0, hi = 0.4;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (inGamut(L, mid, h)) lo = mid;
    else hi = mid;
  }
  return lo;
};
const fromLCH = (L, C, h) => {
  const r = (h * Math.PI) / 180;
  return rgb2hex(oklab2rgb([L, C * Math.cos(r), C * Math.sin(r)]).map((v) => Math.max(0, Math.min(1, v)) * 255));
};
const lchOf = (hex) => {
  const [L, a, b] = rgb2oklab(hex2rgb(hex));
  return { L, C: Math.hypot(a, b), h: ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360 };
};
const dE = (h1, h2) => {
  const [l1, a1, b1] = rgb2oklab(hex2rgb(h1)), [l2, a2, b2] = rgb2oklab(hex2rgb(h2));
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2) * 100;
};
const minDE = (cs) => {
  let m = Infinity, pair = [0, 1];
  for (let i = 0; i < cs.length; i++)
    for (let j = i + 1; j < cs.length; j++)
      if (dE(cs[i], cs[j]) < m) [m, pair] = [dE(cs[i], cs[j]), [i, j]];
  return { min: m, pair };
};
/** WCAG 对比度（色点虽小，仍要看得见 —— 尤其列表行那个 6px 的） */
const contrast = (h1, h2) => {
  const lum = (h) => {
    const [r, g, b] = hex2rgb(h).map((v) => lin(v / 255));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [a, b] = [lum(h1), lum(h2)].sort((x, y) => y - x);
  return (a + 0.05) / (b + 0.05);
};

// ---------------- 色相族（名字 → 锚定色，只取色相） ----------------
// ⚠ 名字要同时出现在三处：本表、`components/mail/account-dot.ts` 的 ACCOUNT_COLOR_NAMES、
//   `webmail/src/accounts.ts` 的 ACCOUNT_COLOR_PALETTE（同 SENT_FOLDER_NAMES 的约定）。
const ANCHORS = [
  ["cyan", "#0891b2"],
  ["pink", "#db2777"],
  ["violet", "#7c3aed"],
  ["orange", "#ea580c"],
  ["teal", "#0d9488"],
];
const HUES = ANCHORS.map(([name, hex]) => [name, lchOf(hex).h]);

const DEFAULT = { lightL: 0.7, darkL: 0.78 };
const numbers = process.argv.slice(2).map(Number).filter((n) => !Number.isNaN(n));
const P = numbers.length >= 2 ? { lightL: numbers[0], darkL: numbers[1] } : DEFAULT;
const C_CAP = numbers.length >= 3 ? numbers[2] : 0.13; // 观感上限：再高就"艳"了

/** 一组 (L) 下的色板：C 由各色相色域上限取最小值导出 */
function palette(lightL, darkL) {
  const lightC = Math.min(C_CAP, ...HUES.map(([, h]) => maxChroma(lightL, h)));
  const darkC = Math.min(C_CAP, ...HUES.map(([, h]) => maxChroma(darkL, h)));
  const light = HUES.map(([, h]) => fromLCH(lightL, lightC, h));
  const dark = HUES.map(([, h]) => fromLCH(darkL, darkC, h));
  return { lightL, darkL, lightC, darkC, light, dark };
}

/** 贪心序：每次取离已用色最远的一个（用浅色档判定；深色档色相相同，必然同序） */
function greedyOrder(lightL, C) {
  const rest = [...HUES];
  const picked = [rest.shift()];
  while (rest.length) {
    let best = 0, bestScore = -Infinity;
    for (let i = 0; i < rest.length; i++) {
      const score = Math.min(...picked.map(([, h]) => dE(fromLCH(lightL, C, h), fromLCH(lightL, C, rest[i][1]))));
      if (score > bestScore) [bestScore, best] = [score, i];
    }
    picked.push(rest.splice(best, 1)[0]);
  }
  return picked.map(([n]) => n);
}

/**
 * 报告：按 `ACCOUNT_COLOR_NAMES` 的**声明顺序**出图（顺序是给观感用的，见下），
 * 同时算出「贪心最优顺序」作对照 —— 统一明度/彩度之后，两者的最小 ΔE 只差几个百分点，
 * 所以顺序不再是关键；旧实现里"顺序决定差距"的脆弱性正是被这一步消掉的。
 */
const report = (p) => {
  const declared = HUES.map(([n]) => n);
  const greedy = greedyOrder(p.lightL, p.lightC);
  const order = declared;
  const idx = order.map((n) => HUES.findIndex(([m]) => m === n));
  const light = idx.map((i) => p.light[i]);
  const dark = idx.map((i) => p.dark[i]);
  const gl = greedy.map((n) => p.light[HUES.findIndex(([m]) => m === n)]);
  const l = minDE(light), d = minDE(dark);
  const cLight = light.map((c) => contrast(c, "#ffffff"));
  const cDark = dark.map((c) => contrast(c, "#0a0a0a"));
  const achL = light.map(lchOf), achD = dark.map(lchOf);
  const spread = (xs) => Math.max(...xs) - Math.min(...xs);
  return {
    order,
    light,
    dark,
    minLight: l.min,
    minDark: d.min,
    contrastLight: Math.min(...cLight),
    lines: [
      `参数：浅色 L=${p.lightL}（导出 C=${p.lightC.toFixed(3)}）／深色 L=${p.darkL}（导出 C=${p.darkC.toFixed(3)}）`,
      `彩度上限来源：${HUES.map(([n, h]) => `${n} ${maxChroma(p.lightL, h).toFixed(3)}`).join("  ")}`,
      `色板顺序（声明）：${order.join(" → ")}`,
      `　贪心最优顺序：${greedy.join(" → ")} —— 声明顺序最小 ΔE ${l.min.toFixed(1)} vs 贪心 ${minDE(gl).min.toFixed(1)}` +
        `（差 ${((1 - l.min / minDE(gl).min) * 100).toFixed(0)}%：统一明度/彩度后任意两色都 ≥0.95×2C，顺序不再关键）`,
      `最小 OKLab ΔE：浅色 ${l.min.toFixed(1)}（${order[l.pair[0]]}↔${order[l.pair[1]]}）／深色 ${d.min.toFixed(1)}`,
      `统一度检验：浅色 L 极差 ${spread(achL.map((x) => x.L)).toFixed(3)}、C 极差 ${spread(achL.map((x) => x.C)).toFixed(3)}` +
        `　深色 L 极差 ${spread(achD.map((x) => x.L)).toFixed(3)}、C 极差 ${spread(achD.map((x) => x.C)).toFixed(3)}`,
      `对比度：浅色对白底最低 ${Math.min(...cLight).toFixed(2)}:1（逐个 ${cLight.map((x) => x.toFixed(2)).join(" ")}）`,
      `　　　　深色对近黑最低 ${Math.min(...cDark).toFixed(2)}:1`,
      "",
      "--- 粘进 components/mail/account-dot.ts（顺序即 ACCOUNT_COLOR_NAMES） ---",
      "const ACCOUNT_DOT: Record<string, string> = {",
      ...order.map((n, i) => `  ${n}: "bg-[${light[i]}] dark:bg-[${dark[i]}]",`),
      "};",
      "",
      `浅色 ${light.join(" ")}`,
      `深色 ${dark.join(" ")}`,
    ],
  };
};

if (process.argv.includes("--bands")) {
  const specs = process.argv.slice(process.argv.indexOf("--bands") + 1).filter((a) => /^[\d.\s]+$/.test(a));
  console.log(
    JSON.stringify(
      specs.map((spec) => {
        const [l, d] = spec.split(/\s+/).map(Number);
        const r = report(palette(l, d));
        return {
          spec,
          light: r.light,
          dark: r.dark,
          order: r.order,
          minLight: r.minLight,
          minDark: r.minDark,
          contrastLight: r.contrastLight,
        };
      }),
    ),
  );
} else if (process.argv.includes("--scanL")) {
  console.log("明度 → 可统一的彩度上限 / 浅色对比度 / 最小 ΔE（C 取观感上限 0.13 与色域限制的较小者）");
  console.log("   L     导出C   浅色最低对比度   浅色最小ΔE   深色最小ΔE");
  for (let L = 0.6; L <= 0.86001; L += 0.02) {
    const p = palette(L, Math.min(0.95, L + 0.08));
    const r = report(p);
    console.log(
      `  ${L.toFixed(2)}   ${p.lightC.toFixed(3)}    ${r.contrastLight.toFixed(2)}:1          ` +
        `${r.minLight.toFixed(1)}        ${minDE(r.dark).min.toFixed(1)}`,
    );
  }
} else {
  const cur = ["#0092b8", "#e60076", "#7f22fe", "#f54a00", "#009689"];
  const curDark = ["#00d3f2", "#fb64b6", "#a684ff", "#ff8904", "#00d5be"];
  console.log("=== 现状基线（Tailwind 600 / 深色 400）===");
  console.log(
    `  浅色最小 ΔE ${minDE(cur).min.toFixed(1)}　对白底最低对比度 ${Math.min(...cur.map((c) => contrast(c, "#ffffff"))).toFixed(2)}:1`,
  );
  console.log(
    `  深色最小 ΔE ${minDE(curDark).min.toFixed(1)}　对近黑最低对比度 ${Math.min(...curDark.map((c) => contrast(c, "#0a0a0a"))).toFixed(2)}:1`,
  );
  console.log("\n=== 生成结果 ===");
  for (const line of report(palette(P.lightL, P.darkL)).lines) console.log(line);
}

// ---------------- 漂移检查：account-dot.ts 里的值是不是本脚本算出来的 ----------------
// 手改 hex（或改了 L/C 却忘了重跑）在这里会立刻现形——色板值只有这一个来源。
if (process.argv.includes("--check") || !process.argv.includes("--bands")) {
  const r = report(palette(P.lightL, P.darkL));
  const src = readFileSync(new URL("../components/mail/account-dot.ts", import.meta.url), "utf8");
  const body = src.slice(src.indexOf("const ACCOUNT_DOT"), src.indexOf("export const ACCOUNT_COLOR_NAMES"));
  const drift = [];
  r.order.forEach((name, i) => {
    const m = body.match(new RegExp(`${name}:\\s*"([^"]+)"`));
    const want = `bg-[${r.light[i]}] dark:bg-[${r.dark[i]}]`;
    if (m?.[1] !== want) drift.push(`  ${name}: 文件里 ${m?.[1] ?? "(缺失)"} ≠ 生成 ${want}`);
  });
  if (drift.length) {
    console.log("\n❌ account-dot.ts 与生成器不一致（色板漂移）：");
    console.log(drift.join("\n"));
    console.log("   → 把上面那段 map 贴回去，或改 L/C 后重跑本脚本。");
    if (process.argv.includes("--check")) process.exit(1);
  } else {
    console.log("\n✅ 与 components/mail/account-dot.ts 一致（无漂移）");
  }
}
