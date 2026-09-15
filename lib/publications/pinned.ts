/**
 * 置顶论文列表的**服务端**读取（读 `data/preferences.json`）。
 *
 * ⚠ 只能从 server component / route handler 调用（内部用了 node:fs）。
 *   客户端组件的置顶交互走 `useOwnerPreferences()` + registry 的 sanitize，
 *   两边共用同一份结构校验，避免读写不一致。
 */
import { PREFERENCE_KEYS, sanitizePreference } from "@/lib/preferences/registry";
import { getPreferences } from "@/lib/preferences/store";

/**
 * 站主置顶的论文 key（顺序即展示顺序）。
 * 文件缺失 / 损坏 / 值非法 → 空数组（首页随即回退到「最新 n 篇」）。
 */
export function getPinnedKeys(): string[] {
  const raw = getPreferences()[PREFERENCE_KEYS.PUBLICATIONS_PINNED];
  const clean = sanitizePreference(PREFERENCE_KEYS.PUBLICATIONS_PINNED, raw);
  return Array.isArray(clean) ? (clean as string[]) : [];
}
