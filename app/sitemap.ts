import type { MetadataRoute } from "next";
import { routing } from "@/lib/i18n/routing";
import { listPosts } from "@/lib/data";

// 站点对外 URL：构建时通过 SITE_URL 注入（见 Dockerfile ARG）；默认 HTTPS
const BASE_URL = process.env.SITE_URL ?? "https://shaoyuanyu.cn";

const staticRoutes = [
  "",
  "/publications",
  "/talks",
  "/projects",
  "/blog",
  "/nav",
  "/ccf",
  "/cas",
  "/deadlines",
  "/venues",
] as const;

export default function sitemap(): MetadataRoute.Sitemap {
  const entries: MetadataRoute.Sitemap = [];

  for (const locale of routing.locales) {
    // 默认语言（zh）不带前缀，其他语言带 /en 前缀
    const prefix = locale === routing.defaultLocale ? "" : `/${locale}`;
    for (const route of staticRoutes) {
      entries.push({
        url: `${BASE_URL}${prefix}${route}`,
        lastModified: new Date(),
        changeFrequency: "monthly",
        priority: route === "" ? 1 : 0.8,
      });
    }
    // 全部文章在每个语言下都有 URL（缺译文的回退显示原文，见 lib/data/blog.ts）
    for (const post of listPosts(locale)) {
      entries.push({
        url: `${BASE_URL}${prefix}/blog/${post.slug}`,
        lastModified: new Date(post.date),
        changeFrequency: "monthly",
        priority: 0.6,
      });
    }
  }

  return entries;
}
