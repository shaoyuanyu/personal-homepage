import type { MetadataRoute } from "next";
import { routing } from "@/lib/i18n/routing";
import { posts } from "@velite/index";

const BASE_URL = "https://example.com"; // TODO: 替换为正式域名

const staticRoutes = ["", "/publications", "/talks", "/projects", "/blog", "/nav", "/cv"] as const;

export default function sitemap(): MetadataRoute.Sitemap {
  const entries: MetadataRoute.Sitemap = [];

  for (const locale of routing.locales) {
    for (const route of staticRoutes) {
      entries.push({
        url: `${BASE_URL}/${locale}${route}`,
        lastModified: new Date(),
        changeFrequency: "monthly",
        priority: route === "" ? 1 : 0.8,
      });
    }
    for (const post of posts.filter((p) => p.locale === locale)) {
      entries.push({
        url: `${BASE_URL}/${locale}/blog/${post.slug}`,
        lastModified: new Date(post.date),
        changeFrequency: "monthly",
        priority: 0.6,
      });
    }
  }

  return entries;
}
