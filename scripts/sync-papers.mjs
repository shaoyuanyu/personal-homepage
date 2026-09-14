#!/usr/bin/env node
/**
 * 从 arXiv API 自动同步论文到 content/publications.yaml
 *
 * 用法：ARXIV_AUTHOR="Yu_Shaoyuan" node scripts/sync-papers.mjs
 * 依赖：Node 18+（内置 fetch）
 *
 * 逻辑：
 * 1. 查询 arXiv 作者的全部论文（限流/临时故障带退避重试）
 * 2. 解析标题/作者/年份/摘要链接
 * 3. 与 publications.yaml 现有条目按 arxiv id 去重合并
 * 4. 新条目追加到文件头部
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const AUTHOR = process.env.ARXIV_AUTHOR;
if (!AUTHOR) {
  console.error("请设置 ARXIV_AUTHOR 环境变量（arXiv 作者名）");
  process.exit(1);
}

const FILE = join(process.cwd(), "content", "publications.yaml");
const API_URL =
  "https://export.arxiv.org/api/query?search_query=" +
  encodeURIComponent(`au:${AUTHOR}`) +
  "&sortBy=submittedDate&sortOrder=descending&max_results=50";

// ⚠ arXiv 的 export API 对共享云 IP（GitHub runner）与异常 UA 经常直接回 429/503
//   （2026-09 实测：一次定期同步就是 `arXiv API 请求失败: 429` 挂掉的），
//   故必须带退避重试。UA 按 arXiv API 条款带上站点地址作为联系方式。
const USER_AGENT =
  "Mozilla/5.0 (compatible; personal-homepage-papers/1.0; +https://shaoyuanyu.cn)";
const MAX_ATTEMPTS = 4; // 首次 + 3 次重试
const BASE_RETRY_DELAY_MS = 5000;
const MAX_RETRY_DELAY_MS = 30_000;
/** 限流与临时故障可重试；其余 4xx（如参数错误）直接失败 */
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

/** 简易 XML 解析（仅处理本脚本需要的结构） */
function extractAll(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "g");
  const out = [];
  let m;
  while ((m = re.exec(xml)) !== null) out.push(m[1]);
  return out;
}

function stripTags(html) {
  return html.replace(/<[^>]+>/g, "").trim();
}

/**
 * 退避时长：优先听 Retry-After（秒数或 HTTP 日期），缺失时按 5s / 10s / 20s
 * 指数退避（上限 30s）。
 */
function retryDelayMs(res, attempt) {
  const ra = res?.headers?.get("retry-after")?.trim();
  if (ra) {
    const secs = Number(ra);
    if (Number.isFinite(secs) && secs > 0) return Math.min(secs * 1000, MAX_RETRY_DELAY_MS);
    const at = Date.parse(ra);
    if (Number.isFinite(at) && at > Date.now())
      return Math.min(at - Date.now(), MAX_RETRY_DELAY_MS);
  }
  return Math.min(BASE_RETRY_DELAY_MS * 2 ** (attempt - 1), MAX_RETRY_DELAY_MS);
}

/**
 * 取回 arXiv 响应体：限流（429）与临时故障（5xx）重试，其余状态码与网络错误
 * （网络错误可重试）按下方分支处理；超出重试次数后抛出最后一次错误。
 */
async function fetchWithRetry(url) {
  let lastErr = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let res = null;
    let retryable = true;
    try {
      console.log(`请求 arXiv API（${attempt}/${MAX_ATTEMPTS}）`);
      res = await fetch(url, {
        headers: { "User-Agent": USER_AGENT },
        // 30s 超时：避免网络卡死时挂起过久（Node 18+ 原生支持）
        signal: AbortSignal.timeout(30_000),
      });
      if (res.ok) return await res.text();
      lastErr = new Error(`HTTP ${res.status}`);
      retryable = RETRYABLE_STATUS.has(res.status);
    } catch (err) {
      lastErr = err;
    }
    if (!retryable) throw lastErr;
    if (attempt < MAX_ATTEMPTS) {
      const wait = retryDelayMs(res, attempt);
      console.warn(`  ⚠ 第 ${attempt} 次失败（${lastErr.message}），${Math.round(wait / 1000)}s 后重试`);
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
  throw lastErr;
}

async function main() {
  console.log(`正在从 arXiv 同步作者「${AUTHOR}」的论文...`);
  const xml = await fetchWithRetry(API_URL);

  const entries = extractAll(xml, "entry");
  const newItems = [];

  for (const entry of entries) {
    const title = stripTags(extractAll(entry, "title")[0] ?? "").replace(/\s+/g, " ");
    const idRaw = extractAll(entry, "id")[0] ?? "";
    const arxivId = idRaw.match(/abs\/([^v]+)/)?.[1] ?? "";
    const year = new Date(extractAll(entry, "published")[0] ?? "").getFullYear();
    const authors = extractAll(entry, "name").map((n) => stripTags(n));
    const venue = extractAll(entry, "title")[0] ? "arXiv preprint" : "arXiv preprint";

    if (!arxivId || !title) continue;

    newItems.push({
      key: `arxiv_${arxivId.replace(/\./g, "")}`,
      title,
      authors,
      venue,
      year,
      type: "preprint",
      arxiv: arxivId,
    });
  }

  console.log(`arXiv 返回 ${newItems.length} 篇论文`);

  // 读取现有 YAML
  const existing = readFileSync(FILE, "utf8");
  const existingIds = new Set(
    [...existing.matchAll(/arxiv:\s*["']?([\d.]+)/g)].map((m) => m[1]),
  );

  const fresh = newItems.filter((item) => !existingIds.has(item.arxiv));
  if (fresh.length === 0) {
    console.log("没有新论文，无需更新");
    process.exit(0);
  }

  console.log(`发现 ${fresh.length} 篇新论文，写入文件...`);

  // 生成新条目的 YAML 片段（插入到 publications: 之后）
  const block = fresh
    .map((p) => {
      const authors = p.authors.map((a) => `      - "${a.replace(/"/g, '\\"')}"`).join("\n");
      return `  - key: ${p.key}\n    title: "${p.title.replace(/"/g, '\\"')}"\n    authors:\n${authors}\n    venue: ${p.venue}\n    year: ${p.year}\n    type: preprint\n    arxiv: "${p.arxiv}"`;
    })
    .join("\n");

  const updated = existing.replace(
    /(^publications:\n)/,
    `$1${block}\n`,
  );

  writeFileSync(FILE, updated);
  console.log(`已更新 ${FILE}，新增 ${fresh.length} 条`);
}

main().catch((err) => {
  console.error(`arXiv 论文同步失败（已尝试 ${MAX_ATTEMPTS} 次）：${err.message}`);
  process.exit(1);
});
