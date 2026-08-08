#!/usr/bin/env node
/**
 * 为 CCF 推荐目录生成 DBLP venue 链接。
 *
 * 方案：抓取 DBLP 完整会议/期刊索引页（分页），本地建立
 *   URL 缩写 + venue 全称 的映射表，再与 CCF 条目匹配。
 * 优点：请求量小（约 60 页 vs API 逐条 1000+ 次），规避 API 限流。
 *
 * 用法：pnpm fetch:ccf-dblp
 * 匹配结果写入 lib/data/ccf-2026.json 的 `d` 字段（断点续传：已有值跳过）。
 */

import fs from "node:fs";
import path from "node:path";

const DATA_FILE = path.join(import.meta.dirname, "../lib/data/ccf-2026.json");
const PAGE_INTERVAL_MS = 2500;
const RETRY_DELAY_MS = 30000;
const MAX_RETRIES = 4;
const USER_AGENT =
  "Mozilla/5.0 (compatible; personal-homepage-ccf-dblp/1.0; +https://shaoyuanyu.cn)";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 归一化：小写 + 去非字母数字 */
const normalize = (s) => (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

/** 抓取一页 HTML（带 429/403 退避重试） */
async function fetchHtml(url) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
    if (res.status === 429 || res.status === 403) {
      if (attempt > MAX_RETRIES) throw new Error(`重试耗尽: ${url}`);
      console.warn(`  ⚠ HTTP ${res.status}，等待 ${RETRY_DELAY_MS / 1000}s 重试 (${attempt}/${MAX_RETRIES})`);
      await sleep(RETRY_DELAY_MS);
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
    return await res.text();
  }
}

/**
 * 抓取某类索引的全部页（?pos=0,100,...），提取 venue 列表。
 * @param {"conf" | "journals"} kind
 * @returns {Map<string, {name: string, url: string}>} URL 段缩写 → venue 信息
 */
async function fetchVenueIndex(kind) {
  const venues = new Map();
  let pos = 0;
  let pages = 0;

  for (;;) {
    const url = `https://dblp.org/db/${kind}/index.html${pos ? `?pos=${pos}` : ""}`;
    let html;
    try {
      html = await fetchHtml(url);
    } catch (err) {
      console.warn(`  ⚠ ${kind} 索引第 ${pages + 1} 页抓取失败（终止）: ${err.message}`);
      break;
    }

    // 提取 venue 链接：<a href="https://dblp.org/db/<kind>/<abbrev>/">Name</a>
    const linkRe = new RegExp(
      `<a href="https://dblp\\.org/db/${kind}/([a-z0-9+/]+)/"[^>]*>(.*?)</a>`,
      "g",
    );
    let m;
    let found = 0;
    while ((m = linkRe.exec(html)) !== null) {
      const abbrev = m[1];
      const name = m[2].replace(/<[^>]+>/g, "").trim();
      if (!venues.has(abbrev)) {
        venues.set(abbrev, {
          name,
          url: `https://dblp.org/db/${kind}/${abbrev}/`,
        });
      }
      found += 1;
    }
    pages += 1;

    // 翻页：存在 [next N entries] 且本页有链接才继续
    const hasNext = /\[next \d+ entries\]/.test(html);
    console.log(`  ${kind} 第 ${pages} 页 (pos=${pos})：${found} 条${hasNext ? "，继续" : "，结束"}`);
    if (!hasNext || found === 0) break;

    pos += 100;
    await sleep(PAGE_INTERVAL_MS);
  }

  console.log(`  ${kind} 索引完成：共 ${venues.size} 个 venue（${pages} 页）`);
  return venues;
}

/** 从 CCF 条目匹配 venue（缩写精确 → 名称/缩写模糊） */
function matchVenue(entry, type, confMap, jourMap) {
  const wantConf = type === "conf";
  const map = wantConf ? confMap : jourMap;
  const acronymNorm = normalize(entry.a);
  const nameNorm = normalize(entry.n);

  // 1) 缩写 → URL 段精确匹配
  if (acronymNorm) {
    const direct = map.get(acronymNorm);
    if (direct) return direct;
  }

  // 2) 模糊匹配：全称包含关系 / 缩写出现在 venue 名中
  let best = null;
  let bestScore = -1;
  for (const [abbrev, v] of map) {
    const venNorm = normalize(v.name);
    let score = -1;
    if (nameNorm && venNorm.includes(nameNorm)) score = venNorm.length; // 名称越短越精确
    else if (nameNorm && nameNorm.includes(venNorm) && venNorm.length >= 12) {
      score = 10000 - venNorm.length; // 全称包含 venue 名（期刊全称带前缀）
    }
    if (acronymNorm && score < 0 && venNorm.includes(acronymNorm) && venNorm.length >= 8) {
      score = 20000 - venNorm.length; // "NeurIPS: Conference on ..."
    }
    if (score > bestScore) {
      bestScore = score;
      best = v;
    }
  }
  return bestScore >= 0 ? best : null;
}

async function main() {
  const data = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));

  console.log("抓取 DBLP 会议索引…");
  const confMap = await fetchVenueIndex("conf");
  console.log("抓取 DBLP 期刊索引…");
  const jourMap = await fetchVenueIndex("journals");

  const entries = [
    ...data.conferences.map((e) => ({ e, type: "conf" })),
    ...data.journals.map((e) => ({ e, type: "jour" })),
  ];

  let matched = 0;
  let skipped = 0;
  const missed = [];

  for (const { e, type } of entries) {
    // 断点续传：已生成链接的条目直接跳过
    if (e.d) {
      skipped += 1;
      continue;
    }

    const v = matchVenue(e, type, confMap, jourMap);
    e.d = v?.url ?? "";
    if (e.d) {
      matched += 1;
      console.log(`✓ ${type === "conf" ? "会议" : "期刊"} ${e.a.padEnd(22)} → ${e.d}`);
    } else {
      missed.push(`${type}: ${e.a || "(无缩写)"} — ${e.n}`);
      console.log(`✗ ${type === "conf" ? "会议" : "期刊"} ${e.a.padEnd(22)} → 未匹配`);
    }
  }

  fs.writeFileSync(DATA_FILE, JSON.stringify(data));
  const total = entries.length;
  const nowMatched = total - skipped - missed.length;
  console.log(
    `\n完成：共 ${total} 条，本次新增 ${nowMatched} 条（跳过已有 ${skipped} 条），仍缺 ${missed.length} 条`,
  );
  if (missed.length > 0) {
    console.log("\n未匹配条目（需人工补查）：");
    for (const m of missed) console.log(`  - ${m}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
