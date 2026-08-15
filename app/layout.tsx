import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";

import { UmamiTracker } from "@/components/analytics/umami-tracker";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

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

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
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
