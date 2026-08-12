import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NextResponse } from "next/server";

import { isOwner } from "@/lib/auth/owner";
import { deadlinesOverrides, mergeDeadlines, type DeadlineConf } from "@/lib/data";
import { fetchDeadlines } from "@/scripts/fetch-deadlines.mjs";

/**
 * POST /api/deadlines/sync — 手动立即同步会议 deadline 数据（主人专属）。
 *
 * 拉取 ccfddl 最新数据 → 与覆盖层合并 → 写入运行时数据文件 data/deadlines.json。
 * /deadlines 页面为动态渲染，优先读取该文件，因此刷新页面即可看到新数据。
 *
 * 限流：单实例内存记录，60 秒内重复请求返回 429。
 */

const DATA_DIR = process.env.DATA_DIR ?? join(process.cwd(), "data");
const LIVE_FILE = join(DATA_DIR, "deadlines.json");

const MIN_INTERVAL_MS = 60_000;
let lastSyncAt = 0;

export async function POST() {
  // API 守卫：游客一律 401（勿用 requireOwner——那是页面 redirect 语义）
  if (!(await isOwner())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const now = Date.now();
  if (now - lastSyncAt < MIN_INTERVAL_MS) {
    return NextResponse.json(
      { error: "同步过于频繁，请稍后再试" },
      { status: 429 },
    );
  }

  try {
    const data = await fetchDeadlines();
    // .mjs 无类型标注，结构由 fetch 脚本保证，此处显式断言
    const conferences = mergeDeadlines(
      data.conferences as DeadlineConf[],
      deadlinesOverrides,
    );
    const out = {
      fetchedAt: data.fetchedAt,
      source: data.source,
      conferences,
    };

    // 原子写入（与 ideas/preferences 存储同款：tmp + rename）
    mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${LIVE_FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify(out));
    renameSync(tmp, LIVE_FILE);

    lastSyncAt = Date.now();
    return NextResponse.json({
      ok: true,
      fetchedAt: out.fetchedAt,
      total: conferences.length,
    });
  } catch (err) {
    console.error("[deadlines/sync]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "同步失败" },
      { status: 502 },
    );
  }
}
