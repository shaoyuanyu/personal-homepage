/**
 * 页面 URL 里的消息 id 编码：messageId 形如 `mid:xxx@yyy.local`，含点号，
 * 而 middleware 的 matcher 排除带点号的路径（静态文件约定），不编码会绕过
 * i18n 中间件导致 404。base64url 只含 [-_A-Za-z0-9]，没有这个冲突。
 * 仅页面路由使用；/api/mail/* 不走 i18n 中间件，继续用原始 id。
 */

export function encodeMessageId(id: string): string {
  const bytes = new TextEncoder().encode(id);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeMessageId(encoded: string): string {
  const b64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/**
 * 列表序的 sessionStorage 键（MAIL-AGENT.md 4.9）：列表页每次加载后写入当前
 * messageId 顺序，详情页读取以提供「上一封 / 下一封」导航（失配则隐藏）。
 */
export const MAIL_LIST_ORDER_KEY = "mail:listOrder";
