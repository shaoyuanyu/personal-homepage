/**
 * 博客文章聚合层（多语言）。
 *
 * 内容约定：文章放在 `content/posts/{zh,en}/<file>.mdx`，frontmatter 的 `slug` 是
 * **文章标识**，不是「语言版本标识」——同一 slug 同时出现在 zh/ 与 en/ 下即视为
 * 同一篇文章的两个语言版本。
 *
 * 由此推出两条规则：
 * 1. slug 只需**在同一语言内唯一**。velite 的 `s.slug()` 做的是集合级（跨语言）唯一
 *    校验，同名即报 duplicate value，故 schema 改用普通字符串字段（velite.config.ts），
 *    唯一性在本模块按 `(locale, slug)` 校验，重复时抛出可定位的错误。
 * 2. 每个语言下都列出**全部文章**：缺该语言版本时回退显示原文（默认语言 zh），
 *    即「只有中文版的文章在 /en/blog 下也显示中文原文」。
 */
import { posts as rawPosts } from "@velite/index";

import { routing } from "@/lib/i18n/routing";

/** 单个语言版本的文章（velite 集合条目） */
export type LocalizedPost = (typeof rawPosts)[number];

type Locale = (typeof routing.locales)[number];

/** 一篇文章：一个 slug + 各语言版本 */
export type BlogArticle = {
  slug: string;
  translations: Partial<Record<Locale, LocalizedPost>>;
};

/** 缺目标语言版本时回退到的语言（站点原文语言） */
const FALLBACK_LOCALE: Locale = routing.defaultLocale;

function isLocale(value: string): value is Locale {
  return (routing.locales as readonly string[]).includes(value);
}

/** 按 slug 聚合各语言版本；同一语言内 slug 重复 / 语言目录非法时抛错（构建期失败） */
function groupArticles(input: readonly LocalizedPost[]): BlogArticle[] {
  const bySlug = new Map<string, BlogArticle>();

  for (const post of input) {
    if (!isLocale(post.locale)) {
      throw new Error(
        `[blog] 无法识别的语言目录 "${post.locale}"（content/${post.source}）：` +
          `content/posts/ 下只允许 ${routing.locales.join(" / ")} 子目录`,
      );
    }

    const article = bySlug.get(post.slug) ?? { slug: post.slug, translations: {} };
    const existing = article.translations[post.locale];
    if (existing) {
      throw new Error(
        `[blog] slug "${post.slug}" 在语言 "${post.locale}" 下重复：` +
          `content/${existing.source} 与 content/${post.source}。` +
          `同一语言内 slug 必须唯一；若两篇是同一篇文章的翻译，` +
          `请让它们共用同一 slug 但分处 zh/ 与 en/ 目录。`,
      );
    }

    article.translations[post.locale] = post;
    bySlug.set(post.slug, article);
  }

  return [...bySlug.values()];
}

/** 全部文章（按 slug 聚合后的唯一列表） */
export const blogArticles: BlogArticle[] = groupArticles(rawPosts);

/** 解析文章在某语言下实际展示的版本：目标语言 → 默认语言 → 任一存在的版本 */
export function resolvePost(article: BlogArticle, locale: string): LocalizedPost {
  const { translations } = article;
  const post =
    (isLocale(locale) ? translations[locale] : undefined) ??
    translations[FALLBACK_LOCALE] ??
    routing.locales.map((l) => translations[l]).find(Boolean);

  // groupArticles 保证每篇文章至少有一个版本，这里只是收窄类型
  if (!post) {
    throw new Error(`[blog] 文章 "${article.slug}" 没有任何语言版本`);
  }
  return post;
}

/** 某语言下的全部文章（缺失版本回退原文），按实际展示版本的日期倒序 */
export function listPosts(locale: string): LocalizedPost[] {
  return blogArticles
    .map((article) => resolvePost(article, locale))
    .sort((a, b) => b.date.localeCompare(a.date));
}

/** 按 slug + 语言取文章（内容已按语言回退）；文章不存在返回 undefined */
export function getPost(locale: string, slug: string): LocalizedPost | undefined {
  const article = blogArticles.find((a) => a.slug === slug);
  return article ? resolvePost(article, locale) : undefined;
}

/**
 * SSG 静态参数：每篇文章在每个语言下都有 URL。
 * 内容可能回退为原文，这是有意为之（见文件头注释）。
 */
export function blogStaticParams(): { locale: string; slug: string }[] {
  return routing.locales.flatMap((locale) =>
    blogArticles.map((article) => ({ locale, slug: article.slug })),
  );
}
