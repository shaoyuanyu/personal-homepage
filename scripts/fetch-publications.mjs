#!/usr/bin/env node
/**
 * 构建时从 Semantic Scholar 自动同步个人论文 → content/publications.yaml。
 *
 * 用法：
 *   pnpm fetch:publications            # 自动查找作者并同步
 *   pnpm fetch:publications --dry-run  # 只打印将要写入的内容，不写文件
 *   S2_AUTHOR_ID=xxx pnpm fetch:publications  # 跳过作者搜索（限速/多次命中时用）
 *
 * 行为：
 *   - 作者名取自 content/profile.yaml 的 name 字段
 *   - 与现有 yaml 按 key 去重合并：手工条目优先保留，仅追加新条目
 *   - 作者匹配本人（模糊匹配姓氏+首字母）时在名字后加 `*` 标记
 *   - API 失败 / 无结果：打印警告并保持文件不变（不阻塞构建）
 *
 * 参考：https://api.semanticscholar.org/api-docs/graph
 */
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const YAML_PATH = resolve(root, "content/publications.yaml");
const PROFILE_PATH = resolve(root, "content/profile.yaml");
const API = "https://api.semanticscholar.org/graph/v1";
const TIMEOUT_MS = 20_000;
const DRY_RUN = process.argv.includes("--dry-run");

// ---- 极简 YAML 读取 ----

/** 从 profile.yaml 提取作者名 + 教育/机构关键词（用于消歧重名作者） */
function readProfile(yaml) {
  const name = yaml.match(/^name:\s*["']?([^"'\n]+)["']?\s*$/m)?.[1]?.trim();
  if (!name) throw new Error("profile.yaml 中找不到 name 字段");

  // 收集 institution 字段与 education 块中的机构名（zh/en）
  const texts = [...yaml.matchAll(/institution:\s*["']?([^"'\n]+)["']?/g)].map(
    (m) => m[1].toLowerCase(),
  );
  // 转英文关键词（人名拼音去重后做子串匹配，中文机构名原文匹配）
  const keywords = [
    ...texts,
    ...texts.flatMap((t) =>
      t
        .replace(/[^\u4e00-\u9fff a-z]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length > 2),
    ),
  ].filter((k) => k.length > 2);
  return { name, keywords };
}

/** 作者候选是否与已知教育/机构背景匹配（消歧） */
function matchesAffiliation(candidate, keywords) {
  const aff = (candidate.affiliation ?? "").toLowerCase();
  return keywords.some((k) => aff.includes(k));
}

/** 提取现有 yaml 中所有条目的 key */
function existingKeys(yaml) {
  return [...yaml.matchAll(/^\s*-\s*key:\s*["']?([^"'\s]+)["']?/gm)].map(
    (m) => m[1],
  );
}

// ---- Semantic Scholar API ----

/** 带指数退避重试的 GET（429/5xx 时重试，最多 3 次） */
async function apiGet(path, params = {}) {
  const url = new URL(`${API}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (res.ok) return res.json();
      if (res.status === 429 || res.status >= 500) {
        lastError = new Error(`Semantic Scholar API ${res.status}`);
        console.warn(`  API ${res.status}，${2 ** attempt * 2}s 后重试 (${attempt + 1}/3)`);
        await new Promise((r) => setTimeout(r, 2 ** attempt * 2000));
        continue;
      }
      throw new Error(`Semantic Scholar API ${res.status}: ${url}`);
    } catch (err) {
      if (err.name === "TimeoutError" || err.name === "AbortError") {
        lastError = err;
        console.warn(`  请求超时，${2 ** attempt * 2}s 后重试 (${attempt + 1}/3)`);
        await new Promise((r) => setTimeout(r, 2 ** attempt * 2000));
        continue;
      }
      throw err;
    }
  }
  throw lastError ?? new Error("Semantic Scholar API 请求失败");
}

/** 按名字搜索作者，返回候选列表 */
async function searchAuthor(name) {
  const { data = [] } = await apiGet("/author/search", {
    query: name,
    fields: "name,affiliations,paperCount",
  });
  return data.map((a) => ({
    authorId: a.authorId,
    name: a.name,
    affiliation: a.affiliations?.[0] ?? "",
    paperCount: a.paperCount ?? 0,
  }));
}

const TYPE_MAP = {
  Conference: "conference",
  Journal: "journal",
  Preprint: "preprint",
  Thesis: "thesis",
  Book: "conference",
  "Book Section": "conference",
};

/** 判断作者是否本人（全名相等，或「姓氏 + 名字首字母」匹配） */
function isSelf(authorName, fullName) {
  const norm = (s) =>
    s.toLowerCase().replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim();
  const name = norm(authorName);
  const target = norm(fullName);
  if (!name || !target) return false;
  if (name === target) return true;
  const [last, ...given] = target.split(" ");
  const initial = given.join("")[0]?.toLowerCase();
  return (
    name.split(" ").includes(last) &&
    (initial ? name.split(" ").some((p) => p.startsWith(initial)) : true)
  );
}

// ---- YAML 序列化（手写，结构固定）----

/** JSON 字符串字面量是合法 YAML 双引号标量，直接复用其转义 */
function yamlStr(v) {
  const s = String(v ?? "");
  if (/^[A-Za-z0-9_.\-/]+$/.test(s) && !/^[-0-9]/.test(s)) return s;
  return JSON.stringify(s);
}

function serializeItem(p) {
  const lines = [`  - key: ${yamlStr(p.key)}`, `    title: ${yamlStr(p.title)}`];
  if (p.authors.length > 0) {
    lines.push("    authors:");
    for (const a of p.authors) lines.push(`      - ${yamlStr(a)}`);
  }
  if (p.venue) lines.push(`    venue: ${yamlStr(p.venue)}`);
  lines.push(`    year: ${p.year}`);
  lines.push(`    type: ${p.type}`);
  if (p.url) lines.push(`    url: ${yamlStr(p.url)}`);
  if (p.doi) lines.push(`    doi: ${yamlStr(p.doi)}`);
  if (p.arxiv) lines.push(`    arxiv: ${yamlStr(p.arxiv)}`);
  return lines.join("\n");
}

// ---- 主流程 ----

async function main() {
  const profileYaml = await readFile(PROFILE_PATH, "utf8");
  const { name: fullName, keywords: affiliationKeywords } = readProfile(profileYaml);
  console.log(`[fetch-publications] 作者: ${fullName}`);

  // 1. 解析现有条目 key（手工条目优先保留）
  const yaml = await readFile(YAML_PATH, "utf8");
  const keys = existingKeys(yaml);
  console.log(`[fetch-publications] 现有条目: ${keys.length} 条`);

  // 2. 查找作者（优先环境变量指定；否则按机构背景消歧；否则不自动同步）
  let authorId = process.env.S2_AUTHOR_ID;
  if (!authorId) {
    const candidates = await searchAuthor(fullName);
    if (candidates.length === 0) {
      console.warn("!!! 未在 Semantic Scholar 找到该作者，跳过同步");
      return;
    }
    for (const c of candidates.slice(0, 5)) {
      const hit = matchesAffiliation(c, affiliationKeywords) ? " ← 机构匹配" : "";
      console.log(`  候选: ${c.name} (${c.affiliation}, ${c.paperCount} 篇) [${c.authorId}]${hit}`);
    }
    const matched = candidates.find((c) => matchesAffiliation(c, affiliationKeywords));
    if (matched) {
      authorId = matched.authorId;
      console.log(`[fetch-publications] 按机构背景选中: ${matched.name}`);
    } else {
      console.warn(
        "!!! 未找到与 profile 机构背景匹配的作者（可能重名），跳过同步。",
        "确认作者 ID 后可执行: S2_AUTHOR_ID=xxx pnpm fetch:publications",
      );
      return;
    }
  }
  console.log(`[fetch-publications] 使用作者 ID: ${authorId}`);

  // 3. 拉取论文
  const { data: papers = [] } = await apiGet(`/author/${authorId}/papers`, {
    limit: 100,
    fields: "title,year,venue,publicationVenue,externalIds,citationCount,publicationTypes,authors,url",
  });
  console.log(`[fetch-publications] API 返回 ${papers.length} 篇`);

  const items = papers
    .filter((p) => p.title && p.year)
    .sort((a, b) => b.year - a.year)
    .map((p) => {
      const authors = (p.authors ?? []).map((a) =>
        isSelf(a.name, fullName) ? `${a.name}*` : a.name,
      );
      const types = p.publicationTypes ?? [];
      const type = TYPE_MAP[types[0]] ?? "conference";
      const venue = p.publicationVenue?.name ?? p.venue ?? "";
      const external = p.externalIds ?? {};
      return {
        key: `s2-${p.paperId}`,
        title: p.title,
        authors,
        venue,
        year: p.year,
        type,
        url: p.url ?? "",
        doi: external.DOI ?? "",
        arxiv: external.ArXiv ?? "",
      };
    });

  // 4. 合并：跳过已存在的 key（手工编辑优先）
  const fresh = items.filter((it) => !keys.includes(it.key));
  if (fresh.length === 0) {
    console.log("[fetch-publications] 无新论文，文件不变");
    return;
  }
  console.log(`[fetch-publications] 新增 ${fresh.length} 条，已有 ${items.length - fresh.length} 条跳过`);

  const block = fresh.map(serializeItem).join("\n");
  const header = `# 出版物列表\n# 由 scripts/fetch-publications.mjs 从 Semantic Scholar 自动同步（构建时）。\n# 可手动编辑；下次同步按 key 去重，手工条目优先保留。\n`;

  let out;
  if (/publications:\s*\[\s*\]/.test(yaml)) {
    out = yaml.replace(/publications:\s*\[\s*\]/, `publications:\n${block}`);
  } else {
    out = yaml.replace(/(\n\s*-\s*key:)/, `\n${block}$1`);
  }
  // 若文件是纯注释+空列表，则用生成的头替换
  if (out === yaml) {
    out = `${header}publications:\n${block}\n`;
  }

  if (DRY_RUN) {
    console.log("=== dry-run: 将要写入的内容 ===");
    console.log(out);
    return;
  }
  await writeFile(YAML_PATH, out);
  console.log(`[fetch-publications] 已写入 ${YAML_PATH}`);
}

main().catch((err) => {
  // 网络 / API 故障不阻塞构建
  console.warn("!!! 论文同步失败（构建不受影响）:", err.message);
});
