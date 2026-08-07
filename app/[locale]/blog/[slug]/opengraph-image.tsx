import { ImageResponse } from "next/og";

import { posts } from "@/lib/data";
import { loadOgFonts, FONT_FAMILY } from "@/lib/og-fonts";

export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
// 构建期需要 fs 读字体缓存，使用 nodejs runtime
export const runtime = "nodejs";

export function generateStaticParams() {
  return posts.map((post) => ({ locale: post.locale, slug: post.slug }));
}

export const alt = "Yu Shaoyuan's blog post";

/** Y-Fork 品牌标记（与 app/icon.svg 同一图形） */
const Y_FORK = (stroke: string) => (
  <svg viewBox="0 0 24 24" width={44} height={44} aria-hidden="true">
    <g
      fill="none"
      stroke={stroke}
      strokeWidth={4.4}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M5 4.5 12 12l7-7.5" />
      <path d="M12 12v8.5" />
    </g>
  </svg>
);

export default async function BlogOpenGraphImage({
  params,
}: {
  params: Promise<{ locale: string; slug: string }>;
}) {
  const { locale, slug } = await params;
  const post = posts.find((p) => p.locale === locale && p.slug === slug);
  if (!post) return new ImageResponse(<div>Not found</div>, size);

  const fonts = await loadOgFonts();
  const titleFontSize = post.title.length > 28 ? 52 : 68;

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "88px 96px",
          background: "#fafaf9",
          fontFamily: FONT_FAMILY,
        }}
      >
        {/* 顶部：品牌标记 + BLOG 标识 */}
        <div style={{ display: "flex", alignItems: "center", gap: 28 }}>
          {Y_FORK("#1c1917")}
          <div
            style={{
              fontSize: 28,
              fontWeight: 700,
              letterSpacing: "0.28em",
              color: "#a8a29e",
            }}
          >
            BLOG
          </div>
        </div>

        {/* 中部：文章标题（最多两行） */}
        <div
          style={{
            display: "flex",
            fontSize: titleFontSize,
            fontWeight: 700,
            lineHeight: 1.25,
            letterSpacing: "-0.02em",
            color: "#1c1917",
            maxWidth: 1000,
          }}
        >
          {post.title}
        </div>

        {/* 底部：日期 + 标签 */}
        <div style={{ display: "flex", alignItems: "center", gap: 24 }}>
          <div
            style={{
              fontSize: 26,
              color: "#78716c",
            }}
          >
            {new Date(post.date).toISOString().slice(0, 10)}
          </div>
          <div style={{ display: "flex", gap: 14 }}>
            {post.tags.map((tag) => (
              <div
                key={tag}
                style={{
                  display: "flex",
                  padding: "10px 22px",
                  borderRadius: 999,
                  fontSize: 22,
                  color: "#57534e",
                  background: "#e7e5e4",
                }}
              >
                {tag}
              </div>
            ))}
          </div>
        </div>
      </div>
    ),
    { ...size, fonts },
  );
}
