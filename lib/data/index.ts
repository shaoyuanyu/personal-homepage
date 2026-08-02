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
