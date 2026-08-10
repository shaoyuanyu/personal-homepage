import { Secret, TOTP } from "otpauth";

/**
 * TOTP（RFC 6238）封装，基于 otpauth 库。
 * 与 Microsoft Authenticator / Google Authenticator / 1Password 等标准应用互通。
 *
 * 约定：6 位数字、30 秒窗口、HMAC-SHA1、Secret 为 base32 编码，
 * 与主流 Authenticator 应用的默认参数完全一致。
 */

/** 允许的时钟漂移窗口数（前后各 1 个 30s 窗口），容忍手机时间不准 */
const TOTP_WINDOW = 1;

/** 从环境变量读取 TOTP 共享密钥（base32） */
export function getTotpSecret(): string | null {
  return process.env.TOTP_SECRET || null;
}

/** 校验用户输入的 6 位 TOTP 码 */
export function verifyTotp(token: string): boolean {
  const secret = getTotpSecret();
  if (!secret || !/^\d{6}$/.test(token)) return false;
  const totp = new TOTP({ secret });
  return totp.validate({ token, window: TOTP_WINDOW }) !== null;
}

/** 计算指定 Secret 当前窗口的 TOTP 码（设置脚本 / 测试用） */
export function generateTotp(secret: string): string {
  return new TOTP({ secret }).generate();
}

/** 生成新的随机共享密钥（base32，20 字节 = 160 bit，符合 RFC 4226 建议） */
export function createTotpSecret(): string {
  return new Secret({ size: 20 }).base32;
}

/** 生成 otpauth:// URI（Authenticator 扫码添加账户用） */
export function totpKeyUri(
  secret: string,
  label = "shaoyuanyu.cn",
  issuer = "Yu Shaoyuan",
): string {
  return new TOTP({ secret, label, issuer }).toString();
}
