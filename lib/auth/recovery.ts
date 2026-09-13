/**
 * 一次性恢复码：手机丢失 / Authenticator 不可用时的备用登录通道。
 * 码在 pnpm totp:setup 时生成并存入 .env（RECOVERY_CODES，逗号分隔），
 * 验证通过即作废（内存记录；进程重启后重置——码明文存于服务器 .env，
 * 泄露面与服务器本身等同，此取舍可接受）。
 *
 * ⚠ 已用码集合必须挂在 `globalThis` 上：Next.js 会逐请求重新求值模块，
 *   模块级 `new Set` 每次都是空集 → “一次性”名存实亡（同一码可反复使用）。
 */

import { globalSet } from "@/lib/utils/global-state";

const usedCodes = globalSet<string>("auth:used-recovery-codes");

function normalize(code: string): string {
  return code.replace(/[\s-]/g, "").toUpperCase();
}

/** 校验恢复码（格式 XXXX-XXXX-XXXX-XXXX，忽略大小写与分隔符） */
export function verifyRecoveryCode(code: string): boolean {
  const stored = (process.env.RECOVERY_CODES ?? "").split(",").map(normalize);
  const normalized = normalize(code);
  if (!normalized || usedCodes.has(normalized)) return false;
  if (!stored.includes(normalized)) return false;
  usedCodes.add(normalized);
  return true;
}
