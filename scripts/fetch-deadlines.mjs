#!/usr/bin/env node
/**
 * 同步 CCF 会议 deadline 数据（来源：ccfddl/ccf-deadlines 社区仓库）。
 *
 * 方案：拉取 ccfddl 官方发布的合并文件 allconf.yml（GitHub Pages），
 *   本地行级解析（结构固定，零依赖），归一化时区，只保留当年+次年。
 *
 * 双入口：
 *   - CLI：pnpm fetch:deadlines [--url <u>] → 写入 lib/data/deadlines.json（提交入库）
 *   - 模块：import { fetchDeadlines } → 返回数据对象（供 /api/deadlines/sync 复用）
 *
 * 输出字段（与 lib/data/deadlines.ts 的 DeadlineConf 对齐）：
 *   a 缩写 | n 全称 | l CCF 等级(A/B/C，""=未收录) | f 领域（CCF 官方中文名）
 *   d DBLP 链接 | years[]: y 年份 / link 官网 / tz 归一化时区(IANA)
 *   date 会议时间描述 / place 地点 / timeline[]: t 时间 / c 备注 / k 类型(abstract|paper)
 */

import fs from "node:fs";
import path from "node:path";

const DEFAULT_URL =
  process.env.DEADLINES_URL ??
  "https://ccfddl.com/conference/allconf.yml";
// CLI 输出路径（运行时计算：import.meta.dirname 在 Next 打包环境下不可用，
// 且本模块会被 /api/deadlines/sync 导入，顶层不可有环境相关副作用）
const OUT_FILE = () => path.join(process.cwd(), "lib/data/deadlines.json");
const USER_AGENT =
  "Mozilla/5.0 (compatible; personal-homepage-deadlines/1.0; +https://shaoyuanyu.cn)";
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 3000;

/* ---------- 时区归一化（→ IANA 名，供 Intl.DateTimeFormat 使用） ---------- */

/** 常见时区缩写 → IANA（消除歧义、适配夏令时） */
const TZ_ABBR = {
  AoE: "Etc/GMT+12",
  PT: "America/Los_Angeles",
  PST: "America/Los_Angeles",
  PDT: "America/Los_Angeles",
  EST: "America/New_York",
  EDT: "America/New_York",
  CST: "America/Chicago",
  CDT: "America/Chicago",
  MST: "America/Denver",
  MDT: "America/Denver",
  CET: "Europe/Paris",
  CEST: "Europe/Paris",
  BST: "Europe/London",
  IST: "Asia/Kolkata",
  JST: "Asia/Tokyo",
  KST: "Asia/Seoul",
  SGT: "Asia/Singapore",
  HKT: "Asia/Hong_Kong",
};

/**
 * 归一化时区字符串。
 * 注意 Etc/GMT±X 的符号与直觉相反：Etc/GMT+8 = UTC-8（POSIX 约定）。
 */
function normalizeTz(tz) {
  const t = (tz ?? "").trim();
  if (!t || t === "UTC" || t === "GMT") return "UTC";
  if (t in TZ_ABBR) return TZ_ABBR[t];
  const m = t.match(/^(?:UTC|GMT)([+-]\d{1,2})$/);
  if (m) {
    const off = Number(m[1]);
    return off === 0 ? "UTC" : `Etc/GMT${off > 0 ? "-" : "+"}${Math.abs(off)}`;
  }
  // 含斜杠视为 IANA 名直接保留；其余未知值原样保留（UI 兜底不转换）
  return t;
}

/** ccfddl 的 sub 分类码 → CCF 官方领域名（与 ccf-2026.json 的 f 字段一致） */
const SUB_FIELDS = {
  DS: "计算机体系结构/并行与分布计算/存储系统",
  NW: "计算机网络",
  SC: "网络与信息安全",
  SE: "软件工程/系统软件/程序设计语言",
  DB: "数据库/数据挖掘/内容检索",
  CT: "计算机科学理论",
  CG: "计算机图形学与多媒体",
  AI: "人工智能",
  HI: "人机交互与普适计算",
  MX: "交叉/综合/新兴",
};

/* ---------- 极简 YAML 行解析器（针对 ccfddl 固定结构，零依赖） ---------- */

/** 去掉引号与行内注释 */
function cleanScalar(raw) {
  let v = raw.trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1);
  }
  return v.replace(/\s+#.*$/, "").trim();
}

/**
 * 解析 allconf.yml → 会议原始对象数组。
 *
 * ccfddl 的缩进风格不统一（数组项可能与父键同级，如 `  confs:` 下 `  - year:`），
 * 因此按「内容模式」驱动解析，不依赖绝对缩进：
 * { title, description, sub, rankCcf, dblp,
 *   confs: [{ year, link, timezone, date, place,
 *             timeline: [{a?: 摘要, t?: 全文, c?: 备注}] }] }
 */
function parseConferences(text) {
  const confs = [];
  let cur = null;
  let curYear = null;
  let curTl = null;
  let inTimeline = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    // 新会议
    if (line.startsWith("- title:")) {
      cur = { title: cleanScalar(line.slice(8)), confs: [] };
      confs.push(cur);
      curYear = null;
      curTl = null;
      inTimeline = false;
      continue;
    }
    if (!cur) continue;

    // 新年份条目
    if (line.startsWith("- year:")) {
      curYear = { year: Number(cleanScalar(line.slice(7))) || 0, timeline: [] };
      cur.confs.push(curYear);
      curTl = null;
      inTimeline = false;
      continue;
    }

    // 会议级字段
    if (line.startsWith("description:")) {
      cur.description = cleanScalar(line.slice(12));
      inTimeline = false;
      continue;
    }
    if (line.startsWith("sub:")) {
      cur.sub = cleanScalar(line.slice(4));
      inTimeline = false;
      continue;
    }
    if (line.startsWith("dblp:")) {
      cur.dblp = cleanScalar(line.slice(5));
      inTimeline = false;
      continue;
    }
    if (line.startsWith("ccf:")) {
      cur.rankCcf = cleanScalar(line.slice(4));
      continue;
    }

    // timeline 上下文（含 - 前缀新条目与追加键两种写法）
    if (inTimeline && curYear) {
      if (line.startsWith("- abstract_deadline:")) {
        curTl = { a: cleanScalar(line.slice(20)) };
        curYear.timeline.push(curTl);
        continue;
      }
      if (line.startsWith("- deadline:")) {
        curTl = { t: cleanScalar(line.slice(11)) };
        curYear.timeline.push(curTl);
        continue;
      }
      if (line.startsWith("abstract_deadline:")) {
        if (curTl) curTl.a = cleanScalar(line.slice(18));
        continue;
      }
      if (line.startsWith("deadline:")) {
        if (curTl) curTl.t = cleanScalar(line.slice(9));
        continue;
      }
      if (line.startsWith("comment:")) {
        if (curTl) curTl.c = cleanScalar(line.slice(8));
        continue;
      }
    }

    // 年份级字段
    if (curYear) {
      if (line.startsWith("timeline:")) {
        inTimeline = true;
        curTl = null;
        continue;
      }
      if (line.startsWith("link:")) {
        curYear.link = cleanScalar(line.slice(5));
        inTimeline = false;
        continue;
      }
      if (line.startsWith("timezone:")) {
        curYear.timezone = cleanScalar(line.slice(9));
        inTimeline = false;
        continue;
      }
      if (line.startsWith("date:")) {
        curYear.date = cleanScalar(line.slice(5));
        inTimeline = false;
        continue;
      }
      if (line.startsWith("place:")) {
        curYear.place = cleanScalar(line.slice(6));
        inTimeline = false;
        continue;
      }
    }
  }
  return confs;
}

/* ---------- 转换与过滤 ---------- */

const DEADLINE_RE = /^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}(:\d{2})?)?$/;

function isValidDeadline(t) {
  return DEADLINE_RE.test(t ?? "") && t !== "TBD";
}

/** 原始对象 → 站内格式（保留当年与次年，过滤无效 deadline） */
function toOutput(confs, nowYear) {
  const out = [];
  for (const c of confs) {
    const years = [];
    for (const y of c.confs ?? []) {
      if (!Number.isInteger(y.year) || y.year < nowYear || y.year > nowYear + 1) continue;
      // 一轮（timeline 项）可能同时含摘要与全文截止，展平为独立条目
      const timeline = [];
      for (const e of y.timeline ?? []) {
        if (e.a && isValidDeadline(e.a)) timeline.push({ k: "abstract", t: e.a });
        if (e.t && isValidDeadline(e.t)) {
          timeline.push({ t: e.t, ...(e.c ? { c: e.c } : {}) });
        }
      }
      if (timeline.length === 0) continue;
      years.push({
        y: y.year,
        ...(y.link ? { link: y.link } : {}),
        tz: normalizeTz(y.timezone),
        ...(y.date ? { date: y.date } : {}),
        ...(y.place ? { place: y.place } : {}),
        timeline,
      });
    }
    if (years.length === 0) continue;
    out.push({
      a: c.title,
      n: c.description ?? "",
      l: c.rankCcf === "A" || c.rankCcf === "B" || c.rankCcf === "C" ? c.rankCcf : "",
      f: SUB_FIELDS[c.sub] ?? "",
      ...(c.dblp ? { d: `https://dblp.org/db/conf/${c.dblp}/` } : {}),
      years,
    });
  }
  out.sort((x, y) => x.a.localeCompare(y.a));
  return out;
}

/* ---------- 核心同步逻辑（CLI 与 API 共用） ---------- */

/**
 * 拉取并解析最新会议数据（网络请求 + 行级解析 + 过滤最近两年）。
 * 数据源偶发连接超时（ccfddl.com），内置 3 次重试。
 * @param {string} [url] 数据源 URL
 * @returns {Promise<{fetchedAt: string, source: string, conferences: object[]}>}
 */
export async function fetchDeadlines(url = DEFAULT_URL) {
  let lastErr = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      console.log(`拉取会议数据（${attempt}/${MAX_ATTEMPTS}）: ${url}`);
      const res = await fetch(url, {
        headers: { "User-Agent": USER_AGENT },
        // 30s 超时：避免网络卡死时挂起过久（Node 22 原生支持）
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
      const text = await res.text();
      console.log(`  原始大小: ${(text.length / 1024).toFixed(0)} KB`);

      const parsed = parseConferences(text);
      if (parsed.length === 0) throw new Error("解析结果为空，疑似格式变化，请检查");

      const nowYear = new Date().getFullYear();
      const conferences = toOutput(parsed, nowYear);
      if (conferences.length === 0) throw new Error("转换结果为空");

      return {
        fetchedAt: new Date().toISOString().slice(0, 10),
        source: "ccfddl/ccf-deadlines (allconf.yml)",
        conferences,
      };
    } catch (err) {
      lastErr = err;
      console.warn(`  ⚠ 第 ${attempt} 次失败: ${err.message}`);
      if (attempt < MAX_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      }
    }
  }
  throw lastErr;
}

/* ---------- CLI 入口 ---------- */

async function main() {
  const urlArg = process.argv.find((a) => a.startsWith("--url="));
  const url = urlArg ? urlArg.slice(6) : DEFAULT_URL;

  const data = await fetchDeadlines(url);

  fs.mkdirSync(path.dirname(OUT_FILE()), { recursive: true });
  fs.writeFileSync(OUT_FILE(), `${JSON.stringify(data, null, 2)}\n`);
  console.log(
    `✔ 写入 ${OUT_FILE()}：${data.conferences.length} 个会议（保留最近两年）`,
  );
}

// 仅作为 CLI 直接执行时运行（被 /api/deadlines/sync 导入时不触发副作用）
const isCli = process.argv[1]?.endsWith("fetch-deadlines.mjs");
if (isCli) {
  main().catch((err) => {
    console.error(`✗ 同步失败: ${err.message}`);
    process.exit(1);
  });
}
