import { NextResponse } from "next/server";

import { isOwner } from "@/lib/auth/owner";

/** 登录态查询：供导航栏等客户端组件判断主人/游客，决定是否显示主人入口 */
export async function GET() {
  return NextResponse.json({ owner: await isOwner() });
}
