#!/usr/bin/env node
/**
 * 同步中科院分区表（升级版）期刊数据（来源：hitfyd/ShowJCR 社区仓库，
 * 数据源自分区表官网 advanced.fenqubiao.com 官方发布）。
 *
 * 方案：直接抓取 ShowJCR 仓库的 FQBJCR20xx-UTF8.csv 原始文件（GitHub raw，
 *   零依赖行级 CSV 解析），仅保留「计算机科学」大类期刊。
 *
 * 用法：pnpm fetch:cas → 写入 lib/data/cas-2025.json（提交入库）。
 * 也可手动指定年份：pnpm fetch:cas -- --year=2024
 *
 * 输出字段（与 lib/data/cas.ts 的 CasEntry 对齐）：
 *   rows[]: n 刊名 | i ISSN/EISSN | w WoS 收录 | top 是否 Top
 *           m [大类, 分区, 大类排名, 大类总数]
 *           s[] [JCR 学科(规范英文), 中文名, 分区, 学科内排名, 学科内总数]
 *   subjects[]: 全部 JCR 学科（含 zh/en 双语，供筛选/展示）
 *   stats: { zones: {分区: 期刊数}, top: Top 期刊数 }
 */

import fs from "node:fs";
import path from "node:path";

const OUT_FILE = () =>
  path.join(import.meta.dirname, "../lib/data/cas-2025.json");
const USER_AGENT =
  "Mozilla/5.0 (compatible; personal-homepage-cas/1.0; +https://shaoyuanyu.cn)";
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 3000;

/** 只保留「计算机科学」大类（当前页面范围） */
const MAIN_FIELD = "计算机科学";

/** 常见 JCR 学科中文名 → 规范英文短名（展示用；其余回退英文原名） */
const SUBJECT_EN = {
  "计算机：信息系统": "Computer Science, Information Systems",
  "计算机：人工智能": "Computer Science, Artificial Intelligence",
  "工程：电子与电气": "Engineering, Electrical & Electronic",
  "计算机：理论方法": "Computer Science, Theory & Methods",
  "计算机：软件工程": "Computer Science, Software Engineering",
  "电信学": "Telecommunications",
  "计算机：跨学科应用": "Computer Science, Interdisciplinary Applications",
  "自动化与控制系统": "Automation & Control Systems",
  "计算机：硬件": "Computer Science, Hardware & Architecture",
  "机器人学": "Robotics",
  "计算机：控制论": "Computer Science, Cybernetics",
  "应用数学": "Mathematics, Applied",
  "成像科学与照相技术": "Imaging Science & Photographic Technology",
  "运筹学与管理科学": "Operations Research & Management Science",
  "光学": "Optics",
  "工程：综合": "Engineering, Multidisciplinary",
  "仪器仪表": "Instruments & Instrumentation",
  "数学跨学科应用": "Mathematics, Interdisciplinary Applications",
  "运输科技": "Transportation Science & Technology",
  "神经科学": "Neurosciences",
  "人体工程学": "Ergonomics",
  "工程：工业": "Engineering, Industrial",
  "综合性期刊": "Multidisciplinary Sciences",
  "统计学与概率论": "Statistics & Probability",
  "工程：机械": "Engineering, Mechanical",
  "图书情报与档案管理": "Information Science & Library Science",
  "声学": "Acoustics",
  "语言与语言学": "Language & Linguistics",
  "语言学": "Linguistics",
  "物理：应用": "Physics, Applied",
  "数学": "Mathematics",
  "工程：生物医学": "Engineering, Biomedical",
  "工程：制造": "Engineering, Manufacturing",
  "工程：宇航": "Engineering, Aerospace",
  "社会学": "Sociology",
  "社会科学：数理方法": "Social Sciences, Mathematical Methods",
  "材料科学：生物材料": "Materials Science, Biomaterials",
  "纳米科技": "Nanoscience & Nanotechnology",
  "社会科学：跨领域": "Social Sciences, Interdisciplinary",
  "工程：土木": "Engineering, Civil",
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 默认数据源：ShowJCR 仓库内中科院分区表原始 CSV（raw.githubusercontent） */
function defaultUrl(year) {
  return `https://raw.githubusercontent.com/hitfyd/ShowJCR/master/%E4%B8%AD%E7%A7%91%E9%99%A2%E5%88%86%E5%8C%BA%E8%A1%A8%E5%8F%8AJCR%E5%8E%9F%E5%A7%8B%E6%95%B0%E6%8D%AE%E6%96%87%E4%BB%B6/FQBJCR${year}-UTF8.csv`;
}

/** 将「分区 1 [3/58]」拆为 [分区, 排名, 总数]；无法解析返回 null */
function parseRank(raw) {
  const s = (raw ?? "").trim();
  if (!s) return null;
  const m = s.match(/^([1-4])\s*\[(\d+)\/(\d+)\]$/);
  if (!m) return null;
  return [m[1], Number(m[2]), Number(m[3])];
}

/** 从「英文全名 中文名」提取中文名（无中文则返回 null） */
function zhFromName(name) {
  const m = (name ?? "").trim().match(/([\u4e00-\u9fff].*)$/);
  return m ? m[1].trim() : null;
}

/** 中文名 → 规范英文（数据内展示用小类名）；未知回退 null（调用方用原英文名） */
function enForSubject(zh) {
  return SUBJECT_EN[zh] ?? null;
}

/** 首字母标题化（“COMPUTER SCIENCE, THEORY & METHODS” → “Computer Science, Theory & Methods”） */
function toTitleCase(s) {
  return s
    .toLowerCase()
    .split(/(\s+)/)
    .map((w) => (/^[a-z]/.test(w) ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join("");
}

/** 去除原 CSV 单元格首尾空格（原文件单元格常以空格开头/结尾） */
function stripCell(s) {
  return (s ?? "").replace(/^\s+|\s+$/g, "");
}

/**
 * 零依赖标准 CSV 行解析（单行，处理双引号转义字段）。
 * 数据文件部分单元格含逗号（如 "COMPUTER SCIENCE, THEORY & METHODS …"）并用
 * 双引号包裹，不能简单 split(",")。
 * @returns {string[]}
 */
function parseCsvLine(line) {
  const cells = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        // 连续两个引号 = 转义引号；否则退出引号态
        if (line[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      cells.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  cells.push(cur);
  return cells;
}

/**
 * 拉取并解析最新分区表（网络请求 + 行级解析 + 过滤为计算机科学大类）。
 * @param {number} year 分区表年份
 * @param {string} [url] 数据源 CSV URL（覆盖默认 GitHub raw，便于镜像/本地验证）
 * @returns {Promise<{fetchedAt: string, version: string, source: string, count: number, rows: object[], subjects: object[], stats: object}>}
 */
export async function fetchCas(year = 2025, url = defaultUrl(year)) {
  let lastErr = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      console.log(`拉取分区数据（${attempt}/${MAX_ATTEMPTS}）: ${url}`);
      const res = await fetch(url, {
        headers: { "User-Agent": USER_AGENT },
        // 30s 超时：raw.githubusercontent 在国内可能极慢/超时，可加长或换镜像
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
      const text = await res.text();
      if (!text.trim()) throw new Error("内容为空");

      const lines = text.split(/\r?\n/);
      // 表头：Journal,年份,ISSN/EISSN,...,大类,大类分区,Top,小类1...
      const header = parseCsvLine(lines[0]).map((h) => stripCell(h));
      const mainCol = header.indexOf("大类");
      const zoneCol = header.indexOf("大类分区");
      const topCol = header.indexOf("Top");
      const wosCol = header.indexOf("Web of Science");
      if (mainCol < 0 || zoneCol < 0 || topCol < 0 || wosCol < 0) {
        throw new Error(`表头格式变化：${header.join(",")}`);
      }
      // 小类列名：小类1..6 / 小类1分区..6分区（两种语言版本列名可能为 1..6 前中文一致）
      const subNameCols = [1, 2, 3, 4, 5, 6]
        .map((k) => header.indexOf(`小类${k}`))
        .filter((i) => i >= 0);
      const subZoneCols = [1, 2, 3, 4, 5, 6]
        .map((k) => header.indexOf(`小类${k}分区`))
        .filter((i) => i >= 0);

      const subjectZhSet = new Map(); // 中文名 → 原英文名（若可解析）
      const rows = [];

      for (const line of lines.slice(1)) {
        if (!line.trim()) continue;
        const cells = parseCsvLine(line).map((c) => stripCell(c));
        if (cells.length <= mainCol) continue;
        const mainField = cells[mainCol];
        if (mainField !== MAIN_FIELD) continue;

        const issn = cells[2] ?? "";
        const wos = cells[wosCol] ?? "";
        const top = (cells[topCol] ?? "") === "是";
        const mainRank = parseRank(cells[zoneCol]);
        if (!mainRank) continue;

        const subs = [];
        for (let i = 0; i < subNameCols.length; i++) {
          const name = cells[subNameCols[i]] ?? "";
          if (!name || name === "—" || name === "-") continue;
          const zone = parseRank(cells[subZoneCols[i]] ?? "");
          if (!zone) continue;
          const zh = zhFromName(name);
          const enFull = zh ? name.slice(0, -(zh.length + 1)).trim() : name;
          if (zh) subjectZhSet.set(zh, enFull);
          subs.push([enFull, zh, zone[0], zone[1], zone[2]]);
        }

        rows.push({
          n: cells[0],
          i: issn,
          w: wos,
          top,
          m: [MAIN_FIELD, mainRank[0], mainRank[1], mainRank[2]],
          s: subs,
        });
      }

      if (rows.length === 0) {
        throw new Error("解析结果为空（大类字段或行结构变化？）");
      }

      // 排序：分区升序 → 大类排名升序 → 刊名
      rows.sort(
        (a, b) =>
          a.m[1].localeCompare(b.m[1]) ||
          a.m[2] - b.m[2] ||
          a.n.toLowerCase().localeCompare(b.n.toLowerCase()),
      );

      // 规范化学科英文名：优先规范短名，其次用标题化的原英文名
      const subjectEn = new Map(); // zh → 规范英文
      for (const [zh, enFull] of subjectZhSet) {
        const canon = enForSubject(zh) ?? toTitleCase(enFull);
        subjectEn.set(zh, canon);
      }
      for (const row of rows) {
        row.s = row.s.map(([enFull, zh, l, r, t]) => [
          subjectEn.get(zh) ?? toTitleCase(enFull) ?? enFull,
          zh,
          l,
          r,
          t,
        ]);
      }

      const subjects = [...subjectEn.entries()]
        .map(([zh, en]) => ({ zh, en }))
        .sort((a, b) => a.zh.localeCompare(b.zh, "zh-Hans-CN"));

      const zones = {};
      let topCount = 0;
      for (const row of rows) {
        zones[row.m[1]] = (zones[row.m[1]] ?? 0) + 1;
        if (row.top) topCount += 1;
      }

      const date = new Date();
      return {
        fetchedAt: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`,
        version: String(year),
        source: "hitfyd/ShowJCR (FQBJCR 原始数据文件, 官方分区表导出)",
        count: rows.length,
        rows,
        subjects,
        stats: { zones, top: topCount },
      };
    } catch (err) {
      lastErr = err;
      console.warn(`  ⚠ 第 ${attempt} 次失败: ${err.message}`);
      if (attempt < MAX_ATTEMPTS) {
        await sleep(RETRY_DELAY_MS);
      }
    }
  }
  throw lastErr;
}

/* ---------- CLI 入口 ---------- */

async function main() {
  const yearArg = process.argv.find((a) => a.startsWith("--year="));
  const urlArg = process.argv.find((a) => a.startsWith("--url="));
  const year = yearArg ? Number(yearArg.slice(7)) : 2025;
  const url = urlArg ? urlArg.slice(6) : defaultUrl(year);

  const data = await fetchCas(year, url);
  if (String(year) !== data.version) {
    // 请求年份与回写文件名保持一致；其他年份写入时文件名按年份动态
    if (year !== 2025) {
      const p = OUT_FILE().replace("2025", String(year));
      fs.writeFileSync(p, `${JSON.stringify(data, null, 2)}\n`);
      console.log(`✔ 写入 ${p}：${data.count} 个期刊（${MAIN_FIELD} 大类）`);
      return;
    }
  }
  fs.writeFileSync(OUT_FILE(), `${JSON.stringify(data, null, 2)}\n`);
  console.log(
    `✔ 写入 ${OUT_FILE()}：${data.count} 个期刊（${MAIN_FIELD} 大类 · ${data.version} 版）`,
  );
}

const isCli = process.argv[1]?.endsWith("fetch-cas.mjs");
if (isCli) {
  main().catch((err) => {
    console.error(`✗ 同步失败: ${err.message}`);
    process.exit(1);
  });
}
