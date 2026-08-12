import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";

import { isOwner } from "@/lib/auth/owner";
import {
  clearCalDavCredentials,
  getCalDavStatus,
  queueCalDavPasswordReset,
  readCalDavCredentials,
  writeCalDavCredentials,
} from "@/lib/caldav/store";

/**
 * GET/PUT/DELETE/POST /api/calendar/credentials — 站主在「日历」页面管理 CalDAV 凭证（主人专属）。
 *
 * - GET     返回状态（configured / source / user / password / pending）。
 *           **含密码明文**：页面仅站主可访问（isOwner 守卫，游客 401），单站主场景无泄露面。
 * - PUT     body { user, password? }：user 必填；password 缺省时保留原密码（首次必填）。
 *           密码变更时同步登记重置队列（VPS crontab 应用到 Radicale htpasswd）。
 * - POST    随机重置密码：服务器生成强随机密码 → 更新网站侧凭证 + 登记重置队列，
 *           返回 { user, password }（新密码展示一次，之后可在 GET 中随时查看）。
 * - DELETE  清除网站内保存的凭证（回退环境变量）。
 *
 * 只管理用户名/密码；服务器地址由部署环境决定（环境变量 CALDAV_URL），不在此配置。
 * 凭证写入 data/caldav.json（原子写入 + chmod 600），运行时优先于环境变量。
 */

const MAX_LEN = 200;

export async function GET() {
  if (!(await isOwner())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.json(getCalDavStatus());
}

/** 更新凭证：写入网站侧 + 密码变更时登记重置队列（供 VPS 同步 Radicale） */
function applyCredentials(user: string, password: string, resetApplied: boolean) {
  writeCalDavCredentials({ user, password });
  if (resetApplied) {
    queueCalDavPasswordReset(user, password);
  }
}

export async function PUT(req: Request) {
  if (!(await isOwner())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await req.json().catch(() => null)) as {
    user?: unknown;
    password?: unknown;
  } | null;
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "参数不合法" }, { status: 400 });
  }

  // 用户名：必填、非空、限长
  const user = typeof body.user === "string" ? body.user.trim() : "";
  if (!user || user.length > MAX_LEN) {
    return NextResponse.json({ error: "用户名不合法" }, { status: 400 });
  }

  // 密码：填写则更新；留空保留原密码（首次设置必须填写）
  let password: string;
  let changed = false;
  if (typeof body.password === "string" && body.password) {
    password = body.password;
    if (password.length > MAX_LEN) {
      return NextResponse.json({ error: "密码不合法" }, { status: 400 });
    }
    changed = true;
  } else {
    const existing = readCalDavCredentials();
    if (existing) {
      password = existing.password;
    } else {
      return NextResponse.json(
        { error: "首次设置必须填写密码" },
        { status: 400 },
      );
    }
  }

  applyCredentials(user, password, changed);
  return NextResponse.json({ ok: true });
}

/** 随机重置密码：服务器生成强随机密码并同步登记（VPS crontab 应用到 Radicale） */
export async function POST() {
  if (!(await isOwner())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // 需先有账号（用户名来自当前配置；未配置时 400）
  const status = getCalDavStatus();
  if (!status.configured || !status.user) {
    return NextResponse.json(
      { error: "请先设置用户名与密码后再重置" },
      { status: 400 },
    );
  }

  // 强随机密码：24 字节 base64url（32 字符，高熵）
  const password = randomBytes(24).toString("base64url");
  applyCredentials(status.user, password, true);
  return NextResponse.json({ user: status.user, password });
}

export async function DELETE() {
  if (!(await isOwner())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  clearCalDavCredentials();
  return NextResponse.json({ ok: true });
}
