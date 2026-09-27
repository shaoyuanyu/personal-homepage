import createMiddleware from "next-intl/middleware";
import { NextRequest, NextResponse } from "next/server";
import { routing } from "./lib/i18n/routing";

const handleI18nRouting = createMiddleware(routing);

/** mail 子域：整站内容都在 /mail 下（MAIL-AGENT.md 2.1） */
function isMailHost(request: NextRequest): boolean {
  const host = (request.headers.get("host") ?? "").split(":")[0];
  return host === "mail.shaoyuanyu.cn";
}

export default function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // 旧链接兼容：zh 已为默认语言放根路径，/zh/xxx 301 → /xxx
  // （next-intl 的 as-needed 模式不会自动重定向带前缀的默认语言 URL）
  if (pathname === "/zh" || pathname.startsWith("/zh/")) {
    const url = request.nextUrl.clone();
    url.pathname = pathname === "/zh" ? "/" : pathname.slice("/zh".length);
    return NextResponse.redirect(url, 301);
  }

  if (isMailHost(request)) {
    // 在语言前缀之后插入 mail 前缀（/ → /mail，/en → /en/mail，/en/x → /en/mail/x）；
    // /login 例外（登录页公开可用），已在 /mail 下的路径不重复加前缀
    const segs = pathname.split("/").filter(Boolean);
    const hasLocalePrefix = segs.length > 0 && (routing.locales as readonly string[]).includes(segs[0]);
    const rest = hasLocalePrefix ? segs.slice(1) : segs;
    if (rest[0] !== "mail" && rest.join("/") !== "login") {
      const url = request.nextUrl.clone();
      url.pathname = "/" + [...(hasLocalePrefix ? [segs[0]] : []), "mail", ...rest].join("/");
      return handleI18nRouting(new NextRequest(url, request));
    }
  }

  return handleI18nRouting(request);
}

export const config = {
  // 匹配所有路径，排除 api/_next 等内部路径与静态文件
  matcher: ["/((?!api|trpc|_next|_vercel|.*\\..*).*)"],
};
