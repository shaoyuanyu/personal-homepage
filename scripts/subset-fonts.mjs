#!/usr/bin/env node
/**
 * 生成等宽字体（Noto Sans Mono CJK SC）的 woff2 文件 + 对应 @font-face CSS。
 *
 * ---- 为什么是这一个字体 ----
 * 等宽这一族全站只用**一个字体**：Noto Sans Mono CJK SC。它的度量是
 * 拉丁 0.5em / 汉字 1.0em，**恰好 2:1**，因此中英混排能精确对齐。
 *（对比：拉丁用普通等宽字体 0.6em + 中文回退 1.0em = 1.667:1，非整数，永远错位。）
 *
 * ---- 为什么必须自己子集化 ----
 * Noto Sans Mono CJK SC **没有任何现成 webfont 来源**：
 *   - npm：@fontsource/noto-sans-mono-cjk-sc 等 8 个候选包全部不存在；
 *   - Google Fonts：Noto Sans Mono CJK SC/JP/KR/TC/HK 全部 HTTP 400（只有拉丁版）；
 *   唯一源是 notofonts 官方仓库的 28.9MB VF（或 16/17MB 静态）OTF，
 *   必须子集化 + 转 woff2 才能上线。
 *
 * ---- ⚠ 不做 unicode-range 分片（2026-09 改，勿改回）----
 * 早期版本输出 latin + cjk 两个分片、靠 unicode-range 路由，期望「只在等宽
 * 遇到汉字时才下载 cjk 分片」。那个期望落空了：`font-mono` 曾被打在若干
 * **含中文的 UI 文案**上（`还剩 2 天`、`681 项`、`758 本`、`63 个会议`、
 * 「当前密码」标签、验证码的中文 placeholder），于是 /ccf、/cas、/deadlines、
 * /login **每次访问都多下 1.3MB**。
 * 那些用法已改回无衬线（数字对齐用 `tabular-nums` 即可，不必切字体族），
 * 但**分片机制本身仍是脆的**：它把「等宽族里有没有汉字」变成性能开关，
 * 而代码注释里写中文是完全正常的事（含中文注释的代码块必须等宽显示）。
 * 故改为**单文件**：一次下载、长期缓存（immutable），不存在「误拉大文件」
 * 这种失败模式，也不必再维护两套 unicode-range。
 *
 *   代价：单文件带上了常用汉字，体积约 0.9MB（原 latin 分片 125KB）。
 *   实测首屏无影响——所有字体族都是 `font-display: swap`，字体不阻塞渲染。
 *
 * ---- 字重 ----
 * 源字体取静态 Regular + Bold 两个（notofonts 的 VF 在部分网络下不可达，
 * 且 pyftmerge 不支持合并可变字体）。声明为：
 *   Regular → font-weight: 400 500
 *   Bold    → font-weight: 600 700
 * 覆盖站内实际用到的 400 / 500 / 600 / 700 四档，且浏览器不会做合成粗体
 *（合成粗体在中文上观感明显发虚）。`font-weight: 100 900` 那种范围声明
 * 用在静态字体上会让浏览器误以为「一个字重全支持」，从而对粗体也不做处理。
 *
 * ---- 输出位置与缓存 ----
 * ⚠ 输出到 `app/fonts/`（不是 `public/`）且 CSS 里写**相对** url()：
 *   `public/` 下的文件不经构建管线，Next.js 对其默认发
 *   `Cache-Control: public, max-age=0`——**每次访问都要发一次条件请求 revalidate**。
 *   相对 url() 会被 webpack 当 asset 处理：自动加**内容哈希**重命名 → 输出到
 *   `_next/static/media/` → 发 `Cache-Control: public, max-age=31536000, immutable`，
 *   与 @fontsource 的 Inter/Tinos 待遇一致。一次下载、永久缓存。
 *   内容哈希同时解决「重跑脚本后文件名不变、已缓存用户永远拿到旧字体」的隐患。
 *   ⚠ 勿改回 `url("/fonts/...")` 绝对路径（webpack 会跳过处理，退回 public/ 语义）。
 *
 * ---- 输出（均提交入库，构建期零网络依赖）----
 *   app/fonts/noto-sans-mono-cjk-sc.woff2        （Regular）
 *   app/fonts/noto-sans-mono-cjk-sc-bold.woff2   （Bold）
 *   app/fonts-mono.css                           （@font-face，导入自 app/layout.tsx）
 *
 * ---- 用法 ----
 *   pnpm fonts:subset                                  # 默认（拉丁 + 常用汉字）
 *   pnpm fonts:subset -- --lean                        # 去掉汉字（≈80KB，仅当确认不用）
 *   pnpm fonts:subset -- --full-han                     # 全 CJK 区块（≈6.9MB）
 *   pnpm fonts:subset -- --regular a.otf --bold b.otf   # 指定本地静态源字体
 *
 * 依赖：Python 的 fontTools（提供 pyftsubset）。可用 PYFTSUBSET 环境变量指定路径。
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HAN_LIST = path.join(ROOT, "scripts", "fonts", "han-common.txt");
const CACHE_DIR = path.join(ROOT, ".cache");
const OUT_DIR = path.join(ROOT, "app", "fonts");
const CSS_OUT = path.join(ROOT, "app", "fonts-mono.css");

/** 官方静态源字体（notofonts/noto-cjk）。--regular / --bold 可覆盖为本地文件。 */
const SOURCE_URLS = {
  regular:
    "https://raw.githubusercontent.com/notofonts/noto-cjk/main/Sans/OTF/SimplifiedChinese/NotoSansMonoCJKsc-Regular.otf",
  bold: "https://raw.githubusercontent.com/notofonts/noto-cjk/main/Sans/OTF/SimplifiedChinese/NotoSansMonoCJKsc-Bold.otf",
};

/** 字体族名（全站唯一等宽族）。 */
const FAMILY = "Noto Sans Mono CJK SC";

/**
 * 拉丁 / 标点 / 符号部分（两个字重都会带上）。
 * 含制表符（U+2500-257F）与方块元素（U+2580-259F）——代码块里的 ASCII 图表要用；
 * 含中文标点（U+3000-303F）与全角形式（U+FF00-FFEF）——中文代码注释的标点。
 */
const LATIN_RANGES = [
  "U+0020-007E", // 基本拉丁
  "U+00A0-024F", // 拉丁 1 补充 + 扩展 A/B（Montréal / Türkiye / Malmö / Poznań）
  "U+02B0-02FF", // 修饰字母
  "U+0300-036F", // 组合附加符号
  "U+1E00-1EFF", // 拉丁扩展附加（越南语等）
  "U+2000-206F", // 常用标点（— – … " " ' '）
  "U+2070-209F", // 上标 / 下标
  "U+20A0-20CF", // 货币符号
  "U+2100-214F", // 字母式符号（™ ℃ №）
  "U+2150-218F", // 数字形式（⅓ ⅳ）
  "U+2190-21FF", // 箭头
  "U+2200-22FF", // 数学运算符
  "U+2300-23FF", // 杂项技术符号（⌘ ⌥）
  "U+2460-24FF", // 带圈字母数字（①②③）
  "U+2500-257F", // 制表符（代码块 ASCII 图）
  "U+2580-259F", // 方块元素（进度条）
  "U+25A0-25FF", // 几何图形（■ ● ▲）
  "U+2600-26FF", // 杂项符号（★ ☀）
  "U+2700-27BF", // 装饰符号（✓ ✗）
  "U+3000-303F", // CJK 标点（、。《》「」）
  "U+FEFF", // 零宽不换行空格
  "U+FF00-FFEF", // 全角形式（，（）Ａ１）
];

/**
 * 「数字上下文里的汉字」—— 中文日期 / 时间 / 相对时间经 Intl 格式化后会带这些字
 *（如 2026年1月10日 · 上午9时 · 3天前 · 还剩 2 天）。
 * 用 `--lean` 时也会保留它们（几 KB），否则日期会掉回系统字体、等宽列错位。
 */
const DATE_HAN = "年月日时分秒周星期上午下午天前刚号点个半小才";

/** 全 CJK 区块（`--full-han` 用）：基本区 + 扩展 A + 兼容表意文字。 */
const FULL_HAN_RANGES = ["U+3400-4DBF", "U+4E00-9FFF", "U+F900-FAFF"];

const args = process.argv.slice(2);
const opt = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const lean = args.includes("--lean");
const fullHan = args.includes("--full-han");

/** 找 pyftsubset：优先 PYFTSUBSET 环境变量，其次 PATH。 */
function resolvePyftsubset() {
  // 注：pyftsubset 没有 --version 参数，用 --help 探测（存在则退出码 0）
  const candidates = [process.env.PYFTSUBSET, "pyftsubset"].filter(Boolean);
  for (const cmd of candidates) {
    try {
      execFileSync(cmd, ["--help"], { stdio: "pipe" });
      return cmd;
    } catch {
      /* 继续尝试下一个 */
    }
  }
  throw new Error(
    "找不到 pyftsubset。请先安装 fontTools（pip install fonttools brotli），\n" +
      "或用 PYFTSUBSET 环境变量指定可执行文件路径。",
  );
}

/** 展开紧凑 unicode-range 字符串 → 码位数组（去重、升序）。 */
function expandRanges(spec) {
  const out = new Set();
  for (const part of spec.split(",")) {
    const s = part.trim().replace(/^U\+/i, "");
    if (!s) continue;
    const [a, b] = s.split("-");
    const start = parseInt(a, 16);
    const end = b ? parseInt(b, 16) : start;
    for (let c = start; c <= end; c += 1) out.add(c);
  }
  return [...out].sort((x, y) => x - y);
}

/**
 * 码位数组 → 紧凑 unicode 区间串（连续区间合并为 `U+START-END`）。
 *
 * ⚠ **区间的结束码位不能再写 `U+` 前缀**（即写 `U+4E0A-4E0B`，不要写
 *   `U+4E0A-U+4E0B`）。pyftsubset 的 `parse_unicodes` 会把 `+`/`U`/`x` 等字符
 *   一律替换成空格再按空白切分，于是 `U+4E0A-U+4E0B` 被劈成 `4E0A-` 与 `4E0B`
 *   两个 token，前者的空 end 会直接抛 `int('', 16)` 的 ValueError。
 *   （上述 `LATIN_RANGES` 本来就是 `U+0020-007E` 这种单前缀写法，故一直没暴露。）
 */
function compactRanges(codepoints) {
  const sorted = [...new Set(codepoints)].sort((a, b) => a - b);
  if (!sorted.length) return "";
  const digits = (n) => n.toString(16).toUpperCase().padStart(4, "0");
  const parts = [];
  let start = sorted[0];
  let prev = sorted[0];
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i] === prev + 1) {
      prev = sorted[i];
      continue;
    }
    parts.push(start === prev ? `U+${digits(start)}` : `U+${digits(start)}-${digits(prev)}`);
    start = sorted[i];
    prev = sorted[i];
  }
  parts.push(start === prev ? `U+${digits(start)}` : `U+${digits(start)}-${digits(prev)}`);
  return parts.join(",");
}

/** 取源字体：优先命令行 / 缓存，其次下载到 .cache/。 */
function ensureSource(weight, override) {
  if (override) {
    if (!existsSync(override)) throw new Error(`源字体不存在：${override}`);
    return override;
  }
  mkdirSync(CACHE_DIR, { recursive: true });
  const name = `NotoSansMonoCJKsc-${weight === "regular" ? "Regular" : "Bold"}.otf`;
  const cache = path.join(CACHE_DIR, name);
  if (existsSync(cache)) {
    console.log(`  复用 ${path.relative(ROOT, cache)}`);
    return cache;
  }
  console.log(`  下载 ${name}（约 16MB，首次较慢）…`);
  try {
    execFileSync(
      "curl",
      ["-fL", "--retry", "3", "--retry-delay", "5", "--connect-timeout", "30", "-o", cache, SOURCE_URLS[weight]],
      { stdio: "inherit" },
    );
  } catch {
    throw new Error(
      `下载源字体（${weight}）失败（raw.githubusercontent.com 在部分网络下不可达）。\n` +
        "可手动下载后指定本地文件，例如：\n" +
        `  curl -fL -o /tmp/${name} \\\n    ${SOURCE_URLS[weight]}\n` +
        `  pnpm fonts:subset -- --${weight} /tmp/${name}`,
    );
  }
  return cache;
}

function subset(pyftsubset, source, unicodes, outFile) {
  const t0 = Date.now();
  execFileSync(
    pyftsubset,
    [
      source,
      `--unicodes=${unicodes}`,
      "--flavor=woff2",
      "--layout-features=*", // 保留全部 OpenType 特性（等宽连字、数字对齐等）
      "--no-hinting",
      "--desubroutinize",
      "--name-IDs=*",
      "--drop-tables+=DSIG",
      `--output-file=${outFile}`,
    ],
    { stdio: "pipe" },
  );
  const kb = statSync(outFile).size / 1024;
  console.log(
    `    ${path.basename(outFile).padEnd(34)} ${kb.toFixed(0).padStart(6)} KB  (${Date.now() - t0}ms)`,
  );
}

function main() {
  const pyftsubset = resolvePyftsubset();

  // ---- 计算码位集合 ----
  let hanSpec = "";
  let hanLabel = "不含汉字（--lean）";
  if (fullHan) {
    hanSpec = FULL_HAN_RANGES.join(",");
    hanLabel = "全 CJK 区块（基本区 + 扩展 A + 兼容）";
  } else if (!lean) {
    const hanText = readFileSync(HAN_LIST, "utf8");
    const han = [...new Set([...hanText].map((c) => c.codePointAt(0)))].sort((a, b) => a - b);
    if (han.length < 2000) {
      throw new Error(
        `scripts/fonts/han-common.txt 内容异常（仅 ${han.length} 字），疑似被截断，拒绝生成。`,
      );
    }
    hanSpec = compactRanges(han);
    hanLabel = `常用汉字 ${han.length} 字（scripts/fonts/han-common.txt）`;
  }

  const dateHan = compactRanges([...DATE_HAN].map((c) => c.codePointAt(0)));
  const unicodes = [LATIN_RANGES.join(","), dateHan, hanSpec].filter(Boolean).join(",");

  console.log("\n生成等宽字体（Noto Sans Mono CJK SC）—— 单文件，不做 unicode-range 分片");
  console.log(`  覆盖：拉丁/标点/符号 + 日期汉字 + ${hanLabel}`);
  console.log(`  码位合计：${expandRanges(unicodes).length}\n`);

  const regularSrc = ensureSource("regular", opt("--regular"));
  const boldSrc = ensureSource("bold", opt("--bold"));

  const regularOut = path.join(OUT_DIR, "noto-sans-mono-cjk-sc.woff2");
  const boldOut = path.join(OUT_DIR, "noto-sans-mono-cjk-sc-bold.woff2");
  mkdirSync(OUT_DIR, { recursive: true });
  subset(pyftsubset, regularSrc, unicodes, regularOut);
  subset(pyftsubset, boldSrc, unicodes, boldOut);

  const face = (file, weightRange, note) => `/* ${note} */
@font-face {
  font-family: "${FAMILY}";
  font-style: normal;
  /* ⚠ 静态字体必须写具体字重区间：写 \`100 900\` 会让浏览器以为一个字重全支持，
     从而对粗体也不做任何处理（粗体与常规长得一样）。见脚本头注释「字重」。 */
  font-weight: ${weightRange};
  font-display: swap;
  /* ⚠ 相对路径（./fonts/…）——由 webpack 接管：加内容哈希、发 immutable 缓存头。
     改回绝对路径 /fonts/… 会退化为 public/ 语义（max-age=0、无哈希）。 */
  src: url("./fonts/${file}") format("woff2");
}`;

  const css = `/* ⚠ 本文件由 scripts/subset-fonts.mjs 生成，请勿手动编辑。
   重新生成：pnpm fonts:subset
   （等宽字体族 ${FAMILY}；单文件、无 unicode-range 分片，见脚本头注释） */

${face("noto-sans-mono-cjk-sc.woff2", "400 500", "Regular：400 / 500（站内 font-normal / font-medium）")}

${face("noto-sans-mono-cjk-sc-bold.woff2", "600 700", "Bold：600 / 700（站内 font-semibold / font-bold）")}
`;
  writeFileSync(CSS_OUT, css, "utf8");

  console.log(`\n  @font-face 已写入 ${path.relative(ROOT, CSS_OUT)}`);
  console.log(
    `  字体已写入 ${path.relative(ROOT, OUT_DIR)}/（经 webpack 输出到 _next/static/media/，带内容哈希 + immutable）`,
  );
  console.log("  完成。记得提交 app/fonts/*.woff2 与 app/fonts-mono.css。\n");
}

main();
