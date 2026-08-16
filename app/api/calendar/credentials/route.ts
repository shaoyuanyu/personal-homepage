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
 * - PUT     body { user, password? }：user 必填；password 缺省时保留现有密码
 *           （回退链：文件凭证 → 环境变量 CALDAV_PASSWORD → 均无则首次必填报错）。
 *           凭证写入文件后登记同步队列（VPS crontab 应用到 Radicale htpasswd）——
 *           密码变更、首次保存、用户名变更都会触发同步（追加/更新对应用户名）。
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

/** 更新凭证：写入网站侧；需要同步时登记重置队列（供 VPS crontab 同步 Radicale） */
function applyCredentials(user: string, password: string, syncRadicale: boolean) {
  writeCalDavCredentials({ user, password });
  if (syncRadicale) {
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

  // 密码：填写则更新；留空保留现有密码（回退链：文件凭证 → 环境变量 → 报错）。
  // 环境变量来源时（页面显示「使用服务器环境凭证」）留空同样可保存——
  // 新文件凭证继承环境变量密码，避免「显示已配置却要求首次填密码」的语义分裂。
  let password: string;
  let passwordChanged = false;
  if (typeof body.password === "string" && body.password) {
    password = body.password;
    if (password.length > MAX_LEN) {
      return NextResponse.json({ error: "密码不合法" }, { status: 400 });
    }
    passwordChanged = true;
  } else {
    const existing = readCalDavCredentials();
    if (existing) {
      password = existing.password;
    } else if (process.env.CALDAV_PASSWORD) {
      password = process.env.CALDAV_PASSWORD;
    } else {
      return NextResponse.json(
        { error: "首次设置必须填写密码" },
        { status: 400 },
      );
    }
  }

  // 需要同步 Radicale 的情形：密码变更；首次写入文件凭证（无文件凭证）；
  // 用户名与当前文件凭证不同（htpasswd 需追加/更新该用户名，否则日历 API 会 401）。
  // 仅文件凭证已存在且用户名密码均未变时不写队列（避免无意义同步）。
  const file = readCalDavCredentials();
  const syncRadicale = passwordChanged || !file || file.user !== user;

  applyCredentials(user, password, syncRadicale);
  return NextResponse.json({ ok: true });
}

/** 随机重置密码：服务器生成强随机密码并同步登记（VPS crontab 应用到 Radicale） */
export async function POST() {
  if (!(await isOwner())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // 需先有凭证（用户名来自当前配置；未配置时 400）
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
