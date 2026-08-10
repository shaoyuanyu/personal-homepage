import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

/**
 * Idea 速记存储层：单文件 JSON 持久化（data/ideas.json）。
 * 适用场景：单主人、低并发、小数据量；零第三方依赖。
 * 写入采用「临时文件 + 原子 rename」，进程中断也不会损坏已有数据。
 */

export type IdeaStatus = "open" | "done";

export interface Idea {
  id: string; // crypto.randomUUID()
  content: string;
  status: IdeaStatus;
  createdAt: number; // epoch ms
  updatedAt: number;
}

/** 数据目录：compose 绑定挂载 ./data:/app/data；本地开发为项目根 data/ */
const DATA_DIR = process.env.DATA_DIR ?? join(process.cwd(), "data");
const IDEAS_FILE = join(DATA_DIR, "ideas.json");

export const MAX_CONTENT_LENGTH = 4000;

function readAll(): Idea[] {
  try {
    if (!existsSync(IDEAS_FILE)) return [];
    const parsed = JSON.parse(readFileSync(IDEAS_FILE, "utf8")) as unknown;
    return Array.isArray(parsed) ? (parsed as Idea[]) : [];
  } catch {
    // 文件损坏/非法：按空列表处理（下次写入会覆盖重建），不抛错影响页面
    return [];
  }
}

function writeAll(ideas: Idea[]): void {
  mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${IDEAS_FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(ideas, null, 2)}\n`, "utf8");
  renameSync(tmp, IDEAS_FILE);
}

/** 全部 Idea，按创建时间倒序（最新在前） */
export function listIdeas(): Idea[] {
  return readAll().sort((a, b) => b.createdAt - a.createdAt);
}

/** 新建 Idea */
export function createIdea(content: string): Idea {
  const idea: Idea = {
    id: randomUUID(),
    content: content.trim(),
    status: "open",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  const all = readAll();
  all.push(idea);
  writeAll(all);
  return idea;
}

/** 更新 Idea（content / status），不存在返回 null */
export function updateIdea(
  id: string,
  patch: { content?: string; status?: IdeaStatus },
): Idea | null {
  const all = readAll();
  const idea = all.find((i) => i.id === id);
  if (!idea) return null;
  if (patch.content !== undefined) idea.content = patch.content.trim();
  if (patch.status !== undefined) idea.status = patch.status;
  idea.updatedAt = Date.now();
  writeAll(all);
  return idea;
}

/** 删除 Idea，返回是否删除了条目 */
export function deleteIdea(id: string): boolean {
  const all = readAll();
  const next = all.filter((i) => i.id !== id);
  if (next.length === all.length) return false;
  writeAll(next);
  return true;
}
