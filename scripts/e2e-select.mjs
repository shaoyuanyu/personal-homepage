#!/usr/bin/env node
/**
 * 按「本次改动涉及的路径」挑选需要跑的 E2E 子集（本地迭代 + CI 共用）。
 *
 * 设计原则（**保守优先**，宁可多跑不可漏跑）：
 *   1. 跨模块的结构性用例**永远跑**（`ALWAYS`）：字体策略、排版与可访问性规格、
 *      空态与可点区域、页面可达性、主题切换、关键资源、旧链接与 SEO。它们逐页扫描
 *      大量路由，任何 UI/样式/文案改动都可能影响——**也正是整套用例里最耗时的部分**。
 *   2. 任何「共享代码」被改动（`SHARED`：components/ui、layout、providers、
 *      globals.css、messages、lib/utils、lib/data/index.ts、e2e 自身…）→ **直接全量**。
 *   3. 只有在改动**完全落在某个功能目录内**时，才把范围收窄到「ALWAYS + 该功能组」。
 *      收窄能剪掉的只是与该改动无关的功能用例（日历 / Deadline / 速查 / 速记 /
 *      登录 / 偏好），它们的代码路径确实没被碰过。
 *   4. 判不出结果（无 base、force push、首次提交…）→ 全量。
 *
 * 用法：
 *   node scripts/e2e-select.mjs            # 打印 --grep 用的正则（空 = 全量）
 *   node scripts/e2e-select.mjs --dry-run  # 打印决策过程（选了哪些组、为什么）
 *   node scripts/e2e-select.mjs --base origin/main
 *
 * ⚠ 修改本文件的映射表时：新增功能组要同时给出「其专属路径」；把某条路径挪进
 *   `SHARED` 会让改动它的提交退化为全量（这是安全的默认方向）。
 */
import { execFileSync } from "node:child_process";

/** 永远执行的 describe（跨模块的结构性检查） */
const ALWAYS = [
  "页面可达性",
  "旧链接与 SEO 资源",
  "字体策略（按角色）",
  "排版与可访问性规格",
  "空态与可点区域",
  "主题切换（顶部栏）",
  "关键资源",
];

/** 功能组：改动命中任一 pattern → 该 describe 需要跑 */
const GROUPS = [
  {
    describe: "我的日历（主人专属）",
    paths: [
      /^components\/calendar\//,
      /^components\/reui\/event-calendar\//,
      /^app\/\[locale\]\/calendar\//,
      /^app\/api\/calendar\//,
      /^lib\/caldav\//,
      /^lib\/ical\.ts$/,
    ],
  },
  {
    describe: "Deadline 手动同步（主人专属）",
    paths: [
      /^components\/deadlines\//,
      /^app\/\[locale\]\/deadlines\//,
      /^app\/api\/deadlines\//,
      /^content\/deadlines-overrides\.yaml$/,
      /^scripts\/fetch-deadlines\.mjs$/,
      /^lib\/data\/deadlines\.json$/,
      /^lib\/ical\.ts$/, // 会议事件的 UID / SUMMARY 由它生成，两个功能共用
    ],
  },
  {
    describe: "Venue Explorer（期刊会议速查）",
    paths: [
      /^components\/venues\//,
      /^app\/\[locale\]\/venues\//,
      /^lib\/data\/venue\.ts$/,
    ],
  },
  {
    describe: "Idea 速记（主人专属）",
    paths: [
      /^components\/ideas\//,
      /^app\/\[locale\]\/ideas\//,
      /^app\/api\/ideas\//,
      /^lib\/ideas\//,
    ],
  },
  {
    describe: "主人登录（TOTP）",
    paths: [
      /^components\/auth\//,
      /^app\/\[locale\]\/login\//,
      /^app\/api\/auth\//,
      /^lib\/auth\//,
    ],
  },
  {
    describe: "主人偏好持久化（服务器）",
    paths: [/^lib\/preferences\//, /^app\/api\/preferences\//],
  },
];

/**
 * 共享路径：命中即退化为「全量」。
 * 这些改动会影响所有页面/所有功能，无法安全判断影响面。
 */
const SHARED = [
  /^components\/ui\//,
  /^components\/layout\//,
  /^components\/providers\.tsx$/,
  /^components\/sections\//,
  /^components\/analytics\//,
  /^components\/blog\//,
  /^app\/globals\.css$/,
  /^app\/fonts/,
  /^app\/layout\.tsx$/,
  /^app\/not-found\.tsx$/,
  /^app\/\[locale\]\/layout\.tsx$/,
  /^app\/\[locale\]\/page\.tsx$/,
  /^app\/\[locale\]\/(blog|publications|projects|talks|nav|ccf|cas)\//,
  /^app\/\[locale\]\/opengraph-image\.tsx$/,
  /^app\/(sitemap|robots)\.ts$/,
  /^app\/feed\.xml\//,
  /^lib\/(utils|i18n|data\/index|data\/blog|data\/conference|og-fonts|bibtex)\b/,
  /^messages\//,
  /^content\/(profile|nav-links|publications|projects|talks)\.yaml$/,
  /^content\/posts\//,
  /^middleware\.ts$/,
  /^(next|velite|postcss|eslint)\.config\.\w+$/,
  /^package\.json$/,
  /^pnpm-lock\.yaml$/,
  /^tsconfig\.json$/,
  /^e2e\//,
  /^\.github\//,
  /^scripts\//, // 构建/数据/字体子集化等工具链改动影响面广，一律全量
];

function changedFiles(base) {
  const out = new Set();
  /** 逐行执行 git 并把结果按行返回（不 trim 行首——`status --porcelain` 的状态码前有空格） */
  const pick = (args, { raw = false } = {}) => {
    try {
      const lines = execFileSync("git", args, { encoding: "utf8" })
        .split("\n")
        .filter((l) => l.length > 0);
      return raw ? lines : lines.map((s) => s.trim()).filter(Boolean);
    } catch {
      return null;
    }
  };

  // 已提交的改动（base..HEAD）。base 不可用（force push / 浅克隆 / 首次提交）→ 返回 null
  const committed = pick(["diff", "--name-only", `${base}...HEAD`]);
  if (committed === null) return null;
  committed.forEach((f) => out.add(f));

  // 未提交（含暂存）与未跟踪的改动 —— 本地迭代时最需要
  // porcelain 格式：XY<space>PATH（前两位是状态，第 3 位起是路径，**不能 trim**）
  const status = pick(["status", "--porcelain"], { raw: true });
  if (status) {
    for (const line of status) {
      if (line.length < 4) continue;
      const f = line.slice(3).trim();
      // rename 形式 "old -> new"
      const name = f.includes(" -> ") ? f.split(" -> ")[1].trim() : f;
      out.add(name);
    }
  }
  return [...out];
}

function select(base) {
  const files = changedFiles(base);
  if (files === null || files.length === 0) {
    return files === null
      ? { full: true, reason: `无法取得 ${base} 的 diff（force push / 浅克隆 / 首次提交）` }
      : { full: true, reason: "没有检测到改动" };
  }

  const sharedHits = files.filter((f) => SHARED.some((re) => re.test(f)));
  if (sharedHits.length) {
    return {
      full: true,
      reason: `改动命中共享代码（影响面无法判定）：${sharedHits.slice(0, 3).join(", ")}${sharedHits.length > 3 ? ` 等 ${sharedHits.length} 个` : ""}`,
    };
  }

  const describes = [...ALWAYS];
  const matched = [];
  for (const g of GROUPS) {
    const hit = files.find((f) => g.paths.some((re) => re.test(f)));
    if (hit) {
      describes.push(g.describe);
      matched.push(`${g.describe} ← ${hit}`);
    }
  }

  // 改动不落在任何已知功能目录内 → 保守起见全量（可能是新增目录/未登记的模块）
  if (matched.length === 0) {
    return { full: true, reason: "改动不在任何已知功能目录内（保守起见全量）" };
  }

  return { full: false, describes: [...new Set(describes)], matched, files };
}

const argv = process.argv.slice(2);
const baseArgIdx = argv.indexOf("--base");
const base = baseArgIdx >= 0 ? argv[baseArgIdx + 1] : "origin/main";
const dryRun = argv.includes("--dry-run");
const result = select(base);

if (dryRun) {
  console.log(`基准: ${base}`);
  console.log(result.full ? `→ 全量（${result.reason}）` : `→ 收窄`);
  if (!result.full) {
    console.log(`   改动文件 ${result.files.length} 个：${result.files.slice(0, 8).join(", ")}${result.files.length > 8 ? " …" : ""}`);
    console.log(`   命中的功能组：\n     ${result.matched.join("\n     ")}`);
    console.log(`   要跑的 describe：\n     ${result.describes.join("\n     ")}`);
  }
  process.exit(0);
}

if (result.full) {
  // 空正则 = 匹配全部
  console.error(`[e2e-select] 全量运行（${result.reason}）`);
  process.stdout.write("");
} else {
  console.error(`[e2e-select] 收窄到 ${result.describes.length} 组：${result.describes.join(" / ")}`);
  process.stdout.write(result.describes.join("|"));
}
