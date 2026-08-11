import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

/**
 * 主人偏好存储层：单文件 JSON 持久化（data/preferences.json）。
 * 与 ideas.json 同模式：单主人、低并发、小数据量；零第三方依赖；
 * 写入采用「临时文件 + 原子 rename」，进程中断也不会损坏已有数据。
 *
 * 结构：Record<preferenceKey, value>；value 由 lib/preferences/registry.ts 校验。
 */

export type Preferences = Record<string, unknown>;

/** 数据目录：compose 绑定挂载 ./data:/app/data；本地开发为项目根 data/ */
const DATA_DIR = process.env.DATA_DIR ?? join(process.cwd(), "data");
const PREFS_FILE = join(DATA_DIR, "preferences.json");

function readAll(): Preferences {
  try {
    if (!existsSync(PREFS_FILE)) return {};
    const parsed = JSON.parse(readFileSync(PREFS_FILE, "utf8")) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Preferences;
    }
    return {};
  } catch {
    // 文件损坏/非法：按空对象处理（下次写入会覆盖重建），不抛错影响页面
    return {};
  }
}

function writeAll(prefs: Preferences): void {
  mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${PREFS_FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(prefs, null, 2)}\n`, "utf8");
  renameSync(tmp, PREFS_FILE);
}

/** 全部偏好（仅含已持久化的 key） */
export function getPreferences(): Preferences {
  return readAll();
}

/** 合并写入；value 为 null 时删除该 key；返回写入后的全量 */
export function setPreferences(patch: Record<string, unknown>): Preferences {
  const prefs = readAll();
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete prefs[key];
    else prefs[key] = value;
  }
  writeAll(prefs);
  return prefs;
}
