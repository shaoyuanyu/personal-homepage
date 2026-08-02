import createMiddleware from "next-intl/middleware";
import { routing } from "./lib/i18n/routing";

export default createMiddleware(routing);

export const config = {
  // 匹配所有路径，排除 api/_next 等内部路径与静态文件
  matcher: ["/((?!api|trpc|_next|_vercel|.*\\..*).*)"],
};
