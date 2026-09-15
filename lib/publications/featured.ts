/**
 * 首页「论文」区块的选取规则与置顶（pin）操作 —— 纯函数，无副作用。
 *
 * 数据来源分两半（这也是本模块唯一的「运行时状态」）：
 *   * 论文本身 = 构建期内容层（`content/publications.yaml`，手工维护）
 *   * 置顶列表 = 站主偏好 `publications:pinned`（`data/preferences.json`）
 * 故首页的选取必须在**服务端**做（`lib/publications/pinned.ts` 读偏好文件），
 * 客户端只负责置顶开关的交互与乐观更新。
 */
import type { Publication } from "@/lib/data";

import { PINNED_LIMIT } from "./constants";

/**
 * 取出首页要展示的论文。
 *
 * @param publications 全部论文（`content/publications.yaml` 的顺序）
 * @param pinnedKeys   被置顶的论文 key，**顺序即展示顺序**
 * @param limit        最多展示几篇（默认 `PINNED_LIMIT`）
 *
 * 规则：有置顶 → 按置顶顺序取（已失效的 key 自动跳过；全部失效则回退最新）；
 *       无置顶 → 按 year 倒序取最新 `limit` 篇（同一年内保持文件顺序）。
 */
export function selectFeatured(
  publications: readonly Publication[],
  pinnedKeys: readonly string[],
  limit: number = PINNED_LIMIT,
): Publication[] {
  if (pinnedKeys.length > 0) {
    const byKey = new Map(publications.map((pub) => [pub.key, pub]));
    const pinned = pinnedKeys
      .map((key) => byKey.get(key))
      .filter((pub): pub is Publication => pub !== undefined);
    if (pinned.length > 0) return pinned.slice(0, limit);
  }
  // ⚠ Array.prototype.sort 是稳定排序：同一年内保持数据文件里的先后顺序
  return [...publications].sort((a, b) => b.year - a.year).slice(0, limit);
}

/** 本次展示的是否为「置顶」结果（决定区块标题用「精选论文」还是「最新论文」） */
export function isPinnedSelection(
  featured: readonly Publication[],
  pinnedKeys: readonly string[],
): boolean {
  return featured.some((pub) => pinnedKeys.includes(pub.key));
}

/**
 * 置顶 / 取消置顶一篇论文。
 *
 * 顺序语义：**新置顶的追加在末尾** —— 置顶顺序 = 你整理的顺序，
 * 新增一篇不会把已有的置顶挤位（首页顺序因此保持稳定）。
 * 上限 `PINNED_LIMIT`（超出时截断；UI 会在达到上限时先提示，不静默丢弃）。
 */
export function togglePinned(
  pinnedKeys: readonly string[],
  key: string,
  limit: number = PINNED_LIMIT,
): string[] {
  if (pinnedKeys.includes(key)) return pinnedKeys.filter((k) => k !== key);
  return [...pinnedKeys, key].slice(0, limit);
}
