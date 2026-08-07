import type { MetadataRoute } from "next";
import { routing } from "@/lib/i18n/routing";
import { posts } from "@velite/index";

// 站点对外 URL：构建时通过 SITE_URL 注入（见 Dockerfile ARG）；默认 HTTPS
const BASE_URL = process.env.SITE_URL ?? "https://shaoyuanyu.cn";

const staticRoutes = ["", "/publications", "/talks", "/projects", "/blog", "/nav"] as const;

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
    for (const post of posts.filter((p) => p.locale === locale)) {
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
