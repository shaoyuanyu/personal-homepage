/**
 * 论文类型 —— **单一事实来源**（single source of truth）。
 *
 * ⚠ 这个数组被三处消费，改动时只需改这里：
 *   1. `velite.config.ts` 的 Publication schema —— 构建期校验数据里的 `type`
 *   2. `/publications` 的类型筛选档位（`publications-list.tsx`）
 *   3. 卡片上的类型徽章文案（走 i18n `publications.types.<type>`）
 *
 * 历史坑：schema 里曾允许 `thesis`，而 UI 的筛选只有「全部/会议/期刊/预印本」三档
 * ——数据合法但筛不出来，属静默漂移。收敛到本文件后不会再出现。
 *
 * ⚠ 新增类型时必须同步补 `messages/{zh,en}.json` 的 `publications.types.<type>`
 *   （缺失会直接抛 next-intl 的 missing message 错误，E2E 会红）。
 */
export const PUBLICATION_TYPES = ["conference", "journal", "preprint", "thesis"] as const;

export type PublicationType = (typeof PUBLICATION_TYPES)[number];

/**
 * 首页「论文」区块的展示篇数，同时也是**置顶（pin）数量上限**。
 *
 * 语义（置顶在 `/publications` 由站主操作，状态存在站主偏好 `publications:pinned`）：
 *   1. 有置顶 → 首页展示被置顶的论文（按置顶顺序），上限本值
 *   2. 无置顶 → 首页展示最新（year 倒序）的 n 篇
 *   3. 完全没有论文 → 首页不渲染该区块
 */
export const PINNED_LIMIT = 5;
