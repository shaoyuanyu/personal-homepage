#!/usr/bin/env node
/**
 * 从 arXiv API 自动同步论文到 content/publications.yaml
 *
 * 用法：ARXIV_AUTHOR="Yu_Shaoyuan" node scripts/sync-papers.mjs
 * 依赖：Node 18+（内置 fetch）
 *
 * 逻辑：
 * 1. 查询 arXiv 作者的全部论文
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

async function main() {
  console.log(`正在从 arXiv 同步作者「${AUTHOR}」的论文...`);
  const res = await fetch(API_URL, {
    headers: { "User-Agent": "ysy-homepage-sync/1.0" },
  });
  if (!res.ok) {
    console.error(`arXiv API 请求失败: ${res.status}`);
    process.exit(1);
  }
  const xml = await res.text();

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
  console.error(err);
  process.exit(1);
});
