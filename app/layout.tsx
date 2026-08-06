import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
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
        {children}
      </body>
    </html>
  );
}
