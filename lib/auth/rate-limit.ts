import type { NextRequest } from "next/server";

/**
 * 登录限流（内存实现）：单实例容器场景足够；
 * 进程重启即清零，可接受（暴力破解者同样受 Docker 重启周期影响）。
 */

const MAX_ATTEMPTS = 5; // 失败 5 次
const LOCK_MS = 15 * 60 * 1000; // 锁定 15 分钟

interface RateEntry {
  count: number;
  lockedUntil: number;
}

const attempts = new Map<string, RateEntry>();

/** 取客户端 IP：nginx 反代下优先 x-forwarded-for 第一跳 */
export function getClientIp(req: NextRequest): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim();
  return req.headers.get("x-real-ip") ?? "unknown";
}

export function isRateLimited(key: string): boolean {
  const entry = attempts.get(key);
  if (!entry) return false;
  if (entry.lockedUntil > Date.now()) return true;
  attempts.delete(key);
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
