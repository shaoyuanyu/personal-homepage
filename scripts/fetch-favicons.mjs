#!/usr/bin/env node
/**
 * 构建时抓取「学术导航」页面的外部站点图标，自托管到 public/favicons/。
 *
 * 背景：运行时直接引用 Google favicon / iconify API 在中国大陆网络下
 * 不稳定（手机浏览器尤为明显）。改为在构建阶段（GitHub Actions 海外
 * runner 网络通畅）把图标下载进镜像，用户访问时从本站服务器加载。
 *
 * 命名规则（与 components/links/links-search.tsx 的 LinkIcon 保持一致）：
 *   - 配置了 iconify 图标的链接 → public/favicons/{hostname}.svg
 *   - 未配置图标的链接       → public/favicons/{hostname}.png
 *
 * 单个站点下载失败仅打印警告并跳过（组件有 onError 地球图标兜底），
 * 绝不阻塞构建。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = resolve(root, "public/favicons");
const YAML_PATH = resolve(root, "content/nav-links.yaml");
const CONCURRENCY = 6;
const TIMEOUT_MS = 15_000;

const GOOGLE_FAVICON = (hostname) =>
  `https://www.google.com/s2/favicons?domain=${hostname}&sz=64`;
const ICONIFY_SVG = (icon) => `https://api.iconify.design/${icon}.svg`;
/** Google 未收录时回退：直接抓取站点根路径的 favicon.ico（浏览器按内容解码，扩展名不影响） */
const SITE_FAVICON = (hostname) => `https://${hostname}/favicon.ico`;

// ---- 极简 YAML 解析：按条目块提取 url / icon（文件结构固定，不引入依赖）----
function parseTargets(yaml) {
  const blocks = yaml.split(/(?=^\s+- name:)/m);
  const targets = [];
  for (const block of blocks) {
    const urlMatch = block.match(/url:\s*"([^"]+)"/);
    if (!urlMatch) continue;
    const url = urlMatch[1];
    if (url.startsWith("/")) continue; // 站内链接无图标
    let hostname;
    try {
      hostname = new URL(url).hostname;
    } catch {
      continue;
    }
    const iconMatch = block.match(/icon:\s*([\w:-]+)/);
    targets.push({ hostname, icon: iconMatch?.[1] });
  }
  return targets;
}

/** 并发受限的 map */
async function pMap(items, fn, limit) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (cursor < items.length) {
        const idx = cursor++;
        results[idx] = await fn(items[idx]);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

/** 校验内容确实是图片（按魔数嗅探，防止 SPA 兜底页把 HTML 当图标返回） */
function looksLikeImage(buf, ext) {
  if (ext === "svg") {
    return buf.subarray(0, 256).includes(Buffer.from("<svg"));
  }
  return (
    (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) || // PNG
    (buf[0] === 0x00 && buf[1] === 0x00 && buf[2] === 0x01 && buf[3] === 0x00) || // ICO
    (buf[0] === 0xff && buf[1] === 0xd8) || // JPEG
    (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) // GIF
  );
}

async function fetchImage(src) {
  const res = await fetch(src, {
    headers: { "User-Agent": "ysy-personal-homepage/favicon-fetcher" },
    redirect: "follow",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 100) throw new Error("empty body");
  return buf;
}

async function download(target) {
  const ext = target.icon ? "svg" : "png";
  const file = resolve(OUT_DIR, `${target.hostname}.${ext}`);
  const primary = target.icon
    ? ICONIFY_SVG(target.icon)
    : GOOGLE_FAVICON(target.hostname);
  try {
    let buf;
    try {
      buf = await fetchImage(primary);
    } catch (primaryErr) {
      // 未配置 icon 时允许回退到站点自身 /favicon.ico
      if (target.icon) throw primaryErr;
      console.warn(`  ! ${target.hostname}: ${primaryErr.message}，尝试站点 favicon.ico`);
      buf = await fetchImage(SITE_FAVICON(target.hostname));
    }
    if (!looksLikeImage(buf, ext)) {
      throw new Error("下载内容不是有效图片（可能是 HTML 兜底页）");
    }
    await writeFile(file, buf);
    console.log(`  ✓ ${target.hostname}  (${ext}, ${buf.length} B)`);
    return true;
  } catch (err) {
    console.warn(`  ✗ ${target.hostname}: ${err.message}`);
    return false;
  }
}

const yaml = await readFile(YAML_PATH, "utf8");
const targets = parseTargets(yaml);
if (targets.length === 0) {
  console.error("未在 content/nav-links.yaml 中找到外部链接，退出。");
  process.exit(1);
}

await mkdir(OUT_DIR, { recursive: true });
console.log(`抓取 ${targets.length} 个站点图标到 public/favicons/ …`);
const results = await pMap(targets, download, CONCURRENCY);
const ok = results.filter(Boolean).length;

console.log(
  `完成：${ok}/${targets.length} 个图标已缓存（失败项由页面组件的地球图标兜底）。`,
);
