/**
 * 跨请求共享的内存状态。
 *
 * ⚠ **为什么必须挂在 `globalThis` 上（勿改回模块级 `const map = new Map()`）**：
 *   Next.js 15 生产构建下会**逐请求重新求值 route handler 及其依赖模块**。
 *   程序化实测（同一进程内连续 6 次请求同一个 API，把计数写进响应头）：
 *     - `globalThis` 上的计数器：1 → 2 → 3 → 4 → 5 → 6（正常累加）
 *     - 模块级 `let v = new Map` 里的计数：恒为 1（每个请求都是崭新的空表）
 *   因此「模块级变量」在本项目里**不具备跨请求记忆**，会静默失效。实测受影响的
 *   功能：登录限流不锁（可无限试码）、恢复码用后不失效（可重复使用）、日历 30 秒
 *   缓存永不命中、CalDAV 写入 5 秒防抖形同虚设、deadline 手动同步 60 秒限流无效。
 *   这些缺陷都不会报错、也不会让任何既有测试变红，只会在真实使用中「少了一层保护」。
 *
 * 用法：`const attempts = globalMap<...>("rate-limit:attempts")`，
 *      或 `const lastSyncAt = globalValue("deadlines:lastSyncAt", () => 0)`。
 *
 * 键加了统一前缀，避免与其它库（Prisma 客户端单例等）在 `globalThis` 上撞名；
 * 值用可变容器（Map/Set/对象容器）承载，调用方直接就地修改即可。
 */

const PREFIX = "__ysy_homepage__:";

type GlobalBag = Record<string, unknown>;

function bag(): GlobalBag {
  const g = globalThis as unknown as { [key: string]: unknown };
  const holder = g[PREFIX] as GlobalBag | undefined;
  if (holder) return holder;
  const created: GlobalBag = {};
  // 用 defineProperty 避免被某些打包器改成不可枚举/只读
  Object.defineProperty(g, PREFIX, { value: created, writable: true, configurable: true });
  return created;
}

/** 取一个跨请求共享的 Map（首次调用时创建） */
export function globalMap<K, V>(name: string): Map<K, V> {
  const b = bag();
  const existing = b[name];
  if (existing instanceof Map) return existing as Map<K, V>;
  const created = new Map<K, V>();
  b[name] = created;
  return created;
}

/** 取一个跨请求共享的 Set（首次调用时创建） */
export function globalSet<T>(name: string): Set<T> {
  const b = bag();
  const existing = b[name];
  if (existing instanceof Set) return existing as Set<T>;
  const created = new Set<T>();
  b[name] = created;
  return created;
}

/**
 * 取一个跨请求共享的**可变标量容器**（`{ value: T }`）。
 * 不要直接共享裸数字/字符串——那只能读到快照，改不到全局。
 */
export function globalValue<T>(name: string, init: () => T): { value: T } {
  const b = bag();
  const existing = b[name] as { value: T } | undefined;
  if (existing) return existing;
  const created = { value: init() };
  b[name] = created;
  return created;
}
