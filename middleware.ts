import createMiddleware from "next-intl/middleware";
import { NextRequest, NextResponse } from "next/server";
import { routing } from "./lib/i18n/routing";

const handleI18nRouting = createMiddleware(routing);

export default function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // 旧链接兼容：zh 已为默认语言放根路径，/zh/xxx 301 → /xxx
  // （next-intl 的 as-needed 模式不会自动重定向带前缀的默认语言 URL）
  if (pathname === "/zh" || pathname.startsWith("/zh/")) {
    const url = request.nextUrl.clone();
    url.pathname = pathname === "/zh" ? "/" : pathname.slice("/zh".length);
    return NextResponse.redirect(url, 301);
  }

  return handleI18nRouting(request);
}

export const config = {
  // 匹配所有路径，排除 api/_next 等内部路径与静态文件
  matcher: ["/((?!api|trpc|_next|_vercel|.*\\..*).*)"],
};
