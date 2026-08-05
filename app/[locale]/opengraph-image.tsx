import { readFileSync } from "node:fs";
import path from "node:path";
import { ImageResponse } from "next/og";

import { routing } from "@/lib/i18n/routing";
import { profile } from "@/lib/data";

export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export const alt =
  "Yu Shaoyuan | AI Safety · LLM Interpretability · Continual Learning";

/** Y-Fork 品牌标记（与 app/icon.svg 同一图形） */
const Y_FORK = (stroke: string) => (
  <svg viewBox="0 0 24 24" width={88} height={88} aria-hidden="true">
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

/** 头像静态帧（GIF 第一帧），构建时内联为 data URI，供 ImageResponse 渲染 */
const AVATAR_DATA_URI = (() => {
  const file = path.join(process.cwd(), "public", "images", "avatar-og.png");
  return `data:image/png;base64,${readFileSync(file).toString("base64")}`;
})();

export default async function OpenGraphImage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const lang = locale === "zh" ? "zh" : "en";
  const subtitle = profile.researchInterests
    .map((i) => i[lang])
    .join("  ·  ");

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "0 96px",
          background: "#fafaf9",
        }}
      >
        {/* 左半：品牌标记 + 姓名 + 研究方向 */}
        <div style={{ display: "flex", flexDirection: "column" }}>
          {Y_FORK("#1c1917")}
          <div
            style={{
              marginTop: 36,
              fontSize: 76,
              fontWeight: 700,
              letterSpacing: "-0.03em",
              color: "#1c1917",
            }}
          >
            {profile.name}
          </div>
          <div
            style={{
              marginTop: 24,
              width: 96,
              height: 6,
              background: "#1c1917",
            }}
          />
          <div
            style={{
              marginTop: 26,
              fontSize: 28,
              letterSpacing: "0.02em",
              color: "#78716c",
            }}
          >
            {subtitle}
          </div>
        </div>

        {/* 右半：圆形头像 */}
        <img
          src={AVATAR_DATA_URI}
          width={264}
          height={264}
          alt=""
          style={{
            borderRadius: "50%",
            border: "10px solid #e7e5e4",
            objectFit: "cover",
          }}
        />
      </div>
    ),
    { ...size }
  );
}
