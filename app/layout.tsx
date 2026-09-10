import type { Metadata } from "next";
import { getLocale } from "next-intl/server";

import { UmamiTracker } from "@/components/analytics/umami-tracker";
// 字体全部自托管（@fontsource 包 / 自生成分片打包为站内静态资源）：
// - 无衬线 Inter（变量字体 100~900 + 斜体）：功能 UI 与全站默认
// - 衬线 Tinos（Times New Roman 度量兼容替身）+ Noto Serif SC（中文，变量字重）
// - 等宽 Noto Sans Mono CJK SC：见 ./fonts-mono.css（自生成；npm / Google Fonts 均无）
// Inter / Noto Serif SC 用变量版的 index.css：内含按 unicode-range 切分的分片
// @font-face，浏览器只下载页面实际用到的分片——站点含 Montréal / Türkiye 等
// 带变音符号地名，故 latin-ext 分片是必需的。
// 不依赖 Google Fonts —— next/font/google 构建/编译期在线拉取，国内与离线环境会失败或回退
import "@fontsource-variable/inter";
import "@fontsource-variable/inter/wght-italic.css";
import "@fontsource-variable/noto-serif-sc";
import "@fontsource/tinos/latin-400.css";
import "@fontsource/tinos/latin-400-italic.css";
import "@fontsource/tinos/latin-700.css";
import "@fontsource/tinos/latin-700-italic.css";
// 等宽字体的 @font-face（生成物，勿手改）：pnpm fonts:subset 重新生成
import "./fonts-mono.css";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Yu Shaoyuan | M.S. Student",
    template: "%s | Yu Shaoyuan",
  },
  description:
    "M.S. student at SUSTech, Dept. of Computer Science and Engineering. Currently learning.",
  keywords: [
    "Yu Shaoyuan",
    "SUSTech",
    "Computer Science",
    "M.S. Student",
  ],
  // 站点对外 URL：构建时通过 SITE_URL 注入（见 Dockerfile ARG）；默认 HTTPS
  metadataBase: new URL(process.env.SITE_URL ?? "https://shaoyuanyu.cn"),
  openGraph: {
    type: "website",
    locale: "en_US",
    siteName: "Yu Shaoyuan",
  },
  robots: {
    index: true,
    follow: true,
  },
};

/**
 * `<html lang>` 的取值：把路由 locale 映射为 BCP 47 语言标签。
 * zh 站点内容为简体中文，故用 `zh-CN`（比裸 `zh` 更明确，利于屏幕阅读器
 * 选择发音与搜索引擎判定语言）。
 */
const HTML_LANG: Record<string, string> = { zh: "zh-CN", en: "en" };

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // ⚠ `<html>` 只能由根 layout 渲染，而它是两种语言共享的外壳——所以必须在这里
  // 取到语言。不要改用 `html[lang="en"]` 之类的 CSS 钩子：那样拿不到语言，
  // 且 SSR 输出会是错的（静态渲染下根 layout 先于 [locale]/layout 的
  // setRequestLocale 执行，getLocale() 会退回默认语言）。
  //
  // 性能：本站在修复字体/版式前即为「所有页面每次请求 SSR」（构建产物中零个
  // 页面级预渲染 .body、响应头 Cache-Control: no-store），故此处的 getLocale()
  // 不引入任何额外动态渲染开销（实测注入前后每请求服务端处理时间 62~68ms 不变）。
  // 逐页静态化（需在每个 page 补 setRequestLocale）是独立议题，见 CLAUDE.md。
  const locale = await getLocale();

  return (
    <html lang={HTML_LANG[locale] ?? "zh-CN"} suppressHydrationWarning>
      <body className="antialiased">
        {/* 首帧登录态布局：在 paint 前同步读 localStorage 设置 <html> class，
            与 OwnerNavItem 的 .guest-only/.owner-only（globals.css）联动，
            使刷新时首帧即正确导航布局（游客/登录均零跳变）。
            键名须与 components/layout/owner-nav-item.tsx 的 OWNER_CACHE_KEY 一致。 */}
        <script
          dangerouslySetInnerHTML={{
            __html: `try{if(localStorage.getItem("owner:auth")==="1"){document.documentElement.classList.add("owner-logged-in")}}catch(e){}`,
          }}
        />
        {children}
        {/* Umami 自托管统计（仅在线上域名生效） */}
        <UmamiTracker />
      </body>
    </html>
  );
}
