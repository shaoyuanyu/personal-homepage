import type { NextRequest } from "next/server";

import { globalMap } from "@/lib/utils/global-state";

/**
 * 登录限流（内存实现）：单实例容器场景足够；
 * 进程重启即清零，可接受（暴力破解者同样受 Docker 重启周期影响）。
 *
 * ⚠ 计数器必须挂在 `globalThis` 上：Next.js 会**逐请求重新求值模块**，
 *   模块级 `new Map` 每次都是空表 → 限流静默失效（实测连试 12 次都不锁）。
 *   详见 `lib/utils/global-state.ts`。
 */

const MAX_ATTEMPTS = 5; // 失败 5 次
const LOCK_MS = 15 * 60 * 1000; // 锁定 15 分钟

interface RateEntry {
  count: number;
  lockedUntil: number;
}

const attempts = globalMap<string, RateEntry>("auth:rate-limit");

/**
 * 取客户端 IP（用于限流分桶）。
 *
 * ⚠ **不要取 `x-forwarded-for` 的第一段**：仓库部署文档里的 nginx 配置是
 *   `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`——它是**追加**，
 *   客户端自己发一个假的 `X-Forwarded-For` 就会落在第一段，取首段等于把限流开关
 *   交给攻击者（每请求换一个假 IP 即可无限试码）。
 *   同一配置里还有 `proxy_set_header X-Real-IP $remote_addr;`，它是**覆盖**（客户端
 *   传的值会被丢弃），所以优先取它；退而取 `x-forwarded-for` 的**最后一段**
 *   （反代追加的那一跳 = 真实客户端），绝不取首段。
 */
export function getClientIp(req: NextRequest): string {
  const realIp = req.headers.get("x-real-ip");
  if (realIp) return realIp.trim();
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) {
    const parts = forwarded.split(",").map((p) => p.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1]!;
  }
  // 直连（无反代）时 Next 会把 socket 地址写进 x-forwarded-for；再退就是同一桶
  return "unknown";
}

export function isRateLimited(key: string): boolean {
  const entry = attempts.get(key);
  if (!entry) return false;
  if (entry.lockedUntil > Date.now()) return true;
  // ⚠ **只能清「已经过期的锁」，不能在每次未锁定时都 delete**：
  //   本函数在每次请求开头都会被调用，若无条件删除，则 `recordFailure` 刚记下的
  //   失败次数会在下一个请求开头被抹掉 → 计数永远回到 0，限流永远不触发
  //   （这是一个纯逻辑缺陷：即使状态共享正确、连试上百次也不会锁）。
  if (entry.lockedUntil > 0) attempts.delete(key);
  return false;
}

export function recordFailure(key: string): void {
  const entry = attempts.get(key) ?? { count: 0, lockedUntil: 0 };
  entry.count += 1;
  if (entry.count >= MAX_ATTEMPTS) {
    entry.lockedUntil = Date.now() + LOCK_MS;
  }
  attempts.set(key, entry);
}

export function clearRateLimit(key: string): void {
  attempts.delete(key);
}
