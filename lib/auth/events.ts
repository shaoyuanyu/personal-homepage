/**
 * 登录态变化事件名：登录/登出成功后 window 广播，
 * 导航栏（OwnerNavItem）与偏好 hook（useOwnerPreferences）等共同监听。
 * 登出时 pathname 可能不变，仅靠路由变化无法感知，必须靠事件刷新。
 */
export const OWNER_AUTH_CHANGED_EVENT = "owner-auth-changed";

/**
 * 登录态缓存键（localStorage，值 "1"/"0"）：由 app/layout.tsx 的首帧内联
 * 脚本与 OwnerNavItem 共同读写；任何「需要先于网络判定登录态」的客户端
 * 组件（如邮件全局提醒）都读它——游客据此完全不发 owner-gated 请求。
 * ⚠ 内联脚本无法 import，键名字面量在 app/layout.tsx 里另有一份，改键需两处同步。
 */
export const OWNER_CACHE_KEY = "owner:auth";
