/**
 * 类型安全的数据访问层。
 *
 * Velite 将「文件结构」作为集合条目输出（Array<_output>），
 * YAML 数据文件是 { key: [...] } 包装结构，这里统一解包为
 * 可直接消费的数组，页面/组件只依赖本模块。
 *
 * 类型从 Velite schema 自动推导：
 * 例如 Publication = 集合条目中的数组元素类型。
 */
import {
  navLinks as rawNavLinks,
  posts,
  profile,
  publications as rawPublications,
  projects as rawProjects,
  talks as rawTalks,
} from "@velite/index";

export { posts, profile };

type RawEntry<T> = (T extends readonly (infer E)[] ? E : never) | undefined;
type Field<T, K extends string> = T extends Record<K, infer V> ? V : never;

// 集合条目中的元素类型：{ publications: Publication[] } → Publication
// RawEntry 处理 `rawX[0]` 可能 undefined 的情况（非数组时直接取值）
type Publication = NonNullable<RawEntry<typeof rawPublications>> extends infer E
  ? Field<E, "publications"> extends readonly (infer P)[]
    ? P
    : never
  : never;

type Talk = NonNullable<RawEntry<typeof rawTalks>> extends infer E
  ? Field<E, "talks"> extends readonly (infer T)[]
    ? T
    : never
  : never;

type Project = NonNullable<RawEntry<typeof rawProjects>> extends infer E
  ? Field<E, "projects"> extends readonly (infer P)[]
    ? P
    : never
  : never;

type NavLinkGroup = NonNullable<RawEntry<typeof rawNavLinks>> extends infer E
  ? Field<E, "groups"> extends readonly (infer G)[]
    ? G
    : never
  : never;

export type { NavLinkGroup, Project, Publication, Talk };
export type { Post, Profile } from "@velite/index";

export const publications: Publication[] =
  rawPublications[0]?.publications ?? [];
export const talks: Talk[] = rawTalks[0]?.talks ?? [];
export const projects: Project[] = rawProjects[0]?.projects ?? [];
export const navLinks: NavLinkGroup[] = rawNavLinks[0]?.groups ?? [];

// ---- CCF 推荐目录（静态数据，来源 https://ccf.atom.im/ 2026 第七版）----
import ccfData from "./ccf-2026.json";

export type CcfEntry = {
  /** 缩写 */
  a: string;
  /** 全称 */
  n: string;
  /** 级别 A/B/C */
  l: "A" | "B" | "C";
  /** 专业领域（官方中文名） */
  f: string;
  /** DBLP venue 页链接（脚本生成，可能为空） */
  d?: string;
};

export const ccf = ccfData as {
  version: string;
  edition: number;
  conferences: CcfEntry[];
  journals: CcfEntry[];
};

// ---- 会议 deadline 日历（自动同步自 ccfddl + 本地覆盖层合并）----
import deadlineData from "./deadlines.json";
import { deadlinesOverrides as rawDeadlinesOverrides } from "@velite/index";

export type DeadlineTimelineEntry = {
  /** 截止时间 "YYYY-MM-DD HH:mm:ss" */
  t: string;
  /** 轮次备注（如 "first round"） */
  c?: string;
  /** "abstract" = 摘要截止；"paper" / 缺省 = 全文截止 */
  k?: "abstract" | "paper";
};

export type DeadlineYear = {
  y: number;
  link?: string;
  /** 归一化 IANA 时区（fetch 脚本已处理 AoE/UTC±X/缩写） */
  tz: string;
  date?: string;
  place?: string;
  timeline: DeadlineTimelineEntry[];
};

export type DeadlineConf = {
  /** 缩写 */
  a: string;
  /** 全称 */
  n: string;
  /** CCF 等级 A/B/C；"" = 未收录 */
  l: "A" | "B" | "C" | "";
  /** 领域（CCF 官方中文名，与 ccf 数据同词表） */
  f: string;
  /** DBLP 链接 */
  d?: string;
  years: DeadlineYear[];
};

type OverrideConf = NonNullable<typeof rawDeadlinesOverrides>["conferences"][number];

/** 覆盖层原始数据（API 手动同步时与最新拉取数据重新合并） */
export const deadlinesOverrides: OverrideConf[] =
  rawDeadlinesOverrides?.conferences ?? [];

const rawDeadlines = deadlineData as {
  fetchedAt: string;
  source: string;
  conferences: DeadlineConf[];
};

/**
 * 合并：覆盖层按缩写整体替换自动数据（大小写不敏感）。
 * 构建时合并一次得到静态 `deadlines`；手动同步 API 拉取最新数据后
 * 用同一函数重新合并，保证运行时数据与覆盖层规则一致。
 */
export function mergeDeadlines(
  raw: DeadlineConf[],
  overrides: OverrideConf[],
): DeadlineConf[] {
  const map = new Map<string, DeadlineConf>();
  for (const c of raw) map.set(c.a.toLowerCase(), c);
  for (const o of overrides) {
    const base = map.get(o.a.toLowerCase());
    map.set(o.a.toLowerCase(), {
      ...(base ?? { a: o.a, n: "", l: "", f: "" }),
      ...o,
      l: o.l ?? base?.l ?? "",
      f: o.f ?? base?.f ?? "",
    });
  }
  return [...map.values()].sort((x, y) => x.a.localeCompare(y.a));
}

export const deadlines: DeadlineConf[] = mergeDeadlines(
  rawDeadlines.conferences,
  deadlinesOverrides,
);
export const deadlinesFetchedAt = rawDeadlines.fetchedAt;
