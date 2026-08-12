import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

/**
 * 站主 CalDAV 凭证存储层：单文件 JSON 持久化（data/caldav.json）。
 * 与 ideas.json 同款原子写入（tmp + rename）；凭证文件额外 chmod 600（仅属主可读写）。
 *
 * 只存用户名+密码；服务器地址由部署环境决定（环境变量 CALDAV_URL，
 * VPS compose 注入 http://radicale:5232），无需也不应通过 UI 配置。
 * 读取优先级：网站内设置的文件凭证 > 环境变量（CALDAV_USER / CALDAV_PASSWORD）。
 *
 * 密码变更同步 Radicale：网站侧更新凭证后写入 data/caldav-reset.json 队列，
 * VPS crontab（scripts/apply-calendar-reset.sh，每分钟）检测到后更新 htpasswd 并删除队列。
 */

export interface CalDavCredentials {
  user: string;
  password: string;
}

export type CalDavStatus = {
  configured: boolean;
  /** 凭证来源：file=网站设置；env=服务器环境变量；null=未配置 */
  source: "file" | "env" | null;
  user: string | null;
  /** 密码明文（仅站主会话可见；环境变量来源时亦回传，便于「查看账号密码」） */
  password: string | null;
  /** 是否有待应用的密码变更（已写入队列、尚未被 VPS 同步到 Radicale） */
  pending: boolean;
};

/** 数据目录：compose 绑定挂载 ./data:/app/data；本地开发为项目根 data/ */
const DATA_DIR = process.env.DATA_DIR ?? join(process.cwd(), "data");
const CRED_FILE = join(DATA_DIR, "caldav.json");
const RESET_QUEUE = join(DATA_DIR, "caldav-reset.json");

// 确保 data 目录对部署用户可读写：容器进程是目录属主（uid 1001），
// 而 VPS crontab（scripts/apply-calendar-reset.sh，部署用户 ysy）需要读取/删除
// 重置队列文件——由属主授权其他用户写目录（VPS 单用户场景，风险可控）。
try {
  chmodSync(DATA_DIR, 0o777);
} catch {
  // 非属主（本地开发等）时静默忽略
}

/** 读取文件凭证；文件缺失/损坏/字段非法返回 null */
export function readCalDavCredentials(): CalDavCredentials | null {
  try {
    if (!existsSync(CRED_FILE)) return null;
    const parsed = JSON.parse(readFileSync(CRED_FILE, "utf8")) as CalDavCredentials;
    if (
      typeof parsed.user === "string" &&
      parsed.user.trim() &&
      typeof parsed.password === "string" &&
      parsed.password
    ) {
      return {
        user: parsed.user.trim(),
        password: parsed.password,
      };
    }
    return null;
  } catch {
    // 文件损坏/非法：按未配置处理（下次写入会覆盖重建）
    return null;
  }
}

/** 写入文件凭证（原子 + 600 权限） */
export function writeCalDavCredentials(cred: CalDavCredentials): void {
  mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${CRED_FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(cred, null, 2)}\n`, "utf8");
  // 凭证文件仅属主可读写（容器内 nextjs 用户 uid 1001 即属主）
  chmodSync(tmp, 0o600);
  renameSync(tmp, CRED_FILE);
}

/** 清除文件凭证（回退到环境变量）；文件不存在时静默 */
export function clearCalDavCredentials(): void {
  try {
    if (existsSync(CRED_FILE)) unlinkSync(CRED_FILE);
  } catch {
    // 忽略删除失败
  }
}

/** 完整运行时配置（文件凭证优先，环境变量回退）；baseUrl 缺失时视为未配置 */
export function getCalDavConfig(): {
  baseUrl: string;
  user: string;
  password: string;
} | null {
  const baseUrl = process.env.CALDAV_URL;
  const file = readCalDavCredentials();
  if (file) {
    // 服务器地址只来自环境变量（部署环境决定），凭证文件只覆盖用户名/密码
    if (!baseUrl) return null;
    return { baseUrl, user: file.user, password: file.password };
  }
  const user = process.env.CALDAV_USER;
  const password = process.env.CALDAV_PASSWORD;
  if (!baseUrl || !user || !password) return null;
  return { baseUrl, user, password };
}

/** 状态查询（含密码明文，供 GET /api/calendar/credentials —— 仅站主可访问） */
export function getCalDavStatus(): CalDavStatus {
  const pending = existsSync(RESET_QUEUE);
  const file = readCalDavCredentials();
  if (file) {
    return {
      configured: true,
      source: "file",
      user: file.user,
      password: file.password,
      pending,
    };
  }
  const user = process.env.CALDAV_USER;
  const password = process.env.CALDAV_PASSWORD;
  if (user && password) {
    return { configured: true, source: "env", user, password, pending };
  }
  return { configured: false, source: null, user: null, password: null, pending };
}

/**
 * 登记密码变更到重置队列（供 VPS crontab 应用到 Radicale htpasswd）。
 * 同时原子写入 data/caldav-reset.json；覆盖式写（同一时刻只有一个待应用变更）。
 * 队列文件权限 644：容器属主(1001) 写入，VPS 部署用户（crontab 以 ysy 运行）需要读取——
 * 若为 600 会导致 crontab 读不到而被误删（曾致密码不同步、日历 401）。
 */
export function queueCalDavPasswordReset(user: string, password: string): void {
  mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${RESET_QUEUE}.${process.pid}.tmp`;
  writeFileSync(
    tmp,
    `${JSON.stringify({ user, password, requestedAt: Date.now() }, null, 2)}\n`,
    "utf8",
  );
  chmodSync(tmp, 0o644);
  renameSync(tmp, RESET_QUEUE);
}
