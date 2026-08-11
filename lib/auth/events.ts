/**
 * 登录态变化事件名：登录/登出成功后 window 广播，
 * 导航栏（OwnerNavItem）与偏好 hook（useOwnerPreferences）等共同监听。
 * 登出时 pathname 可能不变，仅靠路由变化无法感知，必须靠事件刷新。
 */
export const OWNER_AUTH_CHANGED_EVENT = "owner-auth-changed";
