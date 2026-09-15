/**
 * 主人偏好 key 注册表与结构校验。
 *
 * 服务器端（/api/preferences）与客户端（use-owner-preferences）共用：
 * - 服务器：PATCH 时白名单 + 清洗，拒绝未知 key / 非法值
 * - 客户端：从 localStorage 恢复时结构清洗；登录迁移时校验
 *
 * 新增偏好功能时：在此注册 key 并提供 sanitize 函数（只做结构校验，
 * 不含业务语义；非法返回 null）。
 */
import { PINNED_LIMIT } from "@/lib/publications/constants";

/** 全部已知偏好 key（值语义见各 sanitize 函数注释） */
export const PREFERENCE_KEYS = {
  /** CCF 推荐目录页筛选（领域/类型/级别/搜索词） */
  CCF_FILTERS: "ccf:filters",
  /** 我的日历每周起始日（"sunday" 周日 / "monday" 周一；缺省=周日） */
  CALENDAR_WEEK_START: "calendar:weekStart",
  /** CAS 分区表页筛选（分区/仅 Top/搜索词） */
  CAS_FILTERS: "cas:filters",
  /** 首页论文区块的置顶（pin）列表：论文 key 数组，顺序即首页展示顺序 */
  PUBLICATIONS_PINNED: "publications:pinned",
} as const;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const LEVELS = ["all", "A", "B", "C"] as const;
const TYPES = ["all", "conf", "jour"] as const;

/** ccf:filters → { fields?: string[], type?, level?, q? } */
function sanitizeCcfFilters(v: unknown): unknown | null {
  if (!isRecord(v)) return null;
  const out: Record<string, unknown> = {};

  // 领域名数组（≤ 20 项，单项 ≤ 40 字符；过滤非法项）
  if (v.fields !== undefined) {
    if (!Array.isArray(v.fields)) return null;
    out.fields = v.fields
      .filter((f) => typeof f === "string" && f.length > 0 && f.length <= 40)
      .slice(0, 20);
  }
  // 类型 / 级别枚举
  if (v.type !== undefined) {
    if (!TYPES.includes(v.type as (typeof TYPES)[number])) return null;
    out.type = v.type;
  }
  if (v.level !== undefined) {
    if (!LEVELS.includes(v.level as (typeof LEVELS)[number])) return null;
    out.level = v.level;
  }
  // 搜索词（≤ 100 字符）
  if (v.q !== undefined) {
    if (typeof v.q !== "string" || v.q.length > 100) return null;
    out.q = v.q;
  }
  return out;
}

const ZONES = ["all", "1", "2", "3", "4"] as const;

/** cas:filters → { q?, zone?, top? }（2026-09 移除小类多选后仅含 3 字段） */
function sanitizeCasFilters(v: unknown): unknown | null {
  if (!isRecord(v)) return null;
  const out: Record<string, unknown> = {};
  if (v.zone !== undefined) {
    if (!ZONES.includes(v.zone as (typeof ZONES)[number])) return null;
    out.zone = v.zone;
  }
  if (v.top !== undefined) {
    if (v.top !== "all" && v.top !== "top" && v.top !== "non") return null;
    out.top = v.top;
  }
  if (v.q !== undefined) {
    if (typeof v.q !== "string" || v.q.length > 100) return null;
    out.q = v.q;
  }
  return out;
}

const VALIDATORS: Record<string, (v: unknown) => unknown | null> = {
  [PREFERENCE_KEYS.CCF_FILTERS]: sanitizeCcfFilters,
  [PREFERENCE_KEYS.CALENDAR_WEEK_START]: sanitizeCalendarWeekStart,
  [PREFERENCE_KEYS.CAS_FILTERS]: sanitizeCasFilters,
  [PREFERENCE_KEYS.PUBLICATIONS_PINNED]: sanitizePublicationsPinned,
};

/**
 * publications:pinned → string[]（论文 key）
 * 清洗：丢掉非字符串/空串/超长项，去重（保序），截断到置顶上限 `PINNED_LIMIT`。
 * ⚠ 上限以「首页展示篇数」为准 —— 置顶超过 n 篇没有意义（首页只显示 n 篇）。
 */
function sanitizePublicationsPinned(v: unknown): unknown | null {
  if (!Array.isArray(v)) return null;
  const keys = v.filter(
    (k): k is string => typeof k === "string" && k.length > 0 && k.length <= 100,
  );
  return [...new Set(keys)].slice(0, PINNED_LIMIT);
}

/** calendar:weekStart → "sunday" | "monday"（其他值非法） */
function sanitizeCalendarWeekStart(v: unknown): unknown | null {
  return v === "sunday" || v === "monday" ? v : null;
}

export function isKnownPreferenceKey(key: string): boolean {
  return key in VALIDATORS;
}

/** 校验并清洗；未知 key 或非法值返回 null */
export function sanitizePreference(key: string, value: unknown): unknown | null {
  const fn = VALIDATORS[key];
  return fn ? fn(value) : null;
}
