import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth/session";

/**
 * 服务端授权辅助：判断当前请求是否为站点主人。
 * 使用 cookies() 会使路由动态渲染（不再 SSG）——主人专属页面天然如此。
 */

/** 当前请求是否为主人 */
export async function isOwner(): Promise<boolean> {
  const store = await cookies();
  return verifySessionToken(store.get(SESSION_COOKIE)?.value);
}

/** 主人专属页面守卫：未登录重定向到登录页 */
export async function requireOwner(): Promise<void> {
  if (!(await isOwner())) {
    redirect("/login");
  }
}
