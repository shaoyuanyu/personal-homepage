#!/usr/bin/env node
/**
 * 主人登录一次性设置脚本：
 *   1. 生成 TOTP 共享密钥（base32）与 AUTH_SECRET，写入 .env
 *   2. 生成 5 个一次性恢复码，写入 .env
 *   3. 打印 otpauth:// URI 与终端二维码 → 用 Microsoft Authenticator 等扫码绑定
 *
 * 用法：pnpm totp:setup           # 首次设置
 *       pnpm totp:setup --force   # 重新生成（旧密钥立即失效，需重新扫码）
 */
import { randomInt, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import QRCode from "qrcode";
import { Secret, TOTP } from "otpauth";

const envPath = join(process.cwd(), ".env");
const force = process.argv.includes("--force");

// 恢复码字符集：去掉易混淆的 0O1I
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function generateRecoveryCodes(count = 5) {
  const codes = [];
  for (let i = 0; i < count; i++) {
    const raw = Array.from({ length: 16 }, () =>
      CODE_CHARS[randomInt(CODE_CHARS.length)],
    ).join("");
    codes.push(
      `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}`,
    );
  }
  return codes;
}

/** 更新 .env：已存在的键原位替换，否则追加 */
function writeEnv(entries) {
  const existing = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  const lines = existing.split("\n");
  for (const [key, value] of Object.entries(entries)) {
    const idx = lines.findIndex((l) => l.startsWith(`${key}=`));
    const line = `${key}=${value}`;
    if (idx >= 0) lines[idx] = line;
    else lines.push(line);
  }
  writeFileSync(envPath, lines.join("\n"), "utf8");
}

function main() {
  const existingSecret = process.env.TOTP_SECRET;
  if (existingSecret && !force) {
    console.error(
      "⚠️  .env 已存在 TOTP_SECRET。如需重新生成（旧密钥立即失效），请加 --force：",
    );
    console.error("   pnpm totp:setup --force");
    process.exit(1);
  }
  if (force) {
    console.log("⚠️  正在重新生成密钥，旧 TOTP_SECRET 与恢复码将立即失效。\n");
  }

  const totpSecret = new Secret({ size: 20 }).base32;
  const authSecret = randomBytes(32).toString("hex");
  const recoveryCodes = generateRecoveryCodes(5);

  writeEnv({
    TOTP_SECRET: totpSecret,
    AUTH_SECRET: authSecret,
    RECOVERY_CODES: recoveryCodes.join(","),
  });
  console.log(`✅ 已写入 ${envPath}\n`);

  const uri = new TOTP({
    secret: totpSecret,
    label: "shaoyuanyu.cn",
    issuer: "Yu Shaoyuan",
  }).toString();

  console.log("════════════════════════════════════════════");
  console.log(" 第 1 步：用 Authenticator 扫码绑定");
  console.log("（Microsoft Authenticator / Google Authenticator 均可）");
  console.log("════════════════════════════════════════════");
  console.log(uri, "\n");
  QRCode.toString(uri, { type: "terminal", small: true })
    .then((qr) => console.log(qr))
    .then(() => {
      console.log("\n════════════════════════════════════════════");
      console.log(" 第 2 步：保存以下一次性恢复码（手机丢失时备用）");
      console.log(" 每个码仅可使用一次，请妥善保管：");
      console.log("════════════════════════════════════════════");
      recoveryCodes.forEach((code, i) => console.log(`  ${i + 1}. ${code}`));
      console.log(
        "\n⚠️  恢复码仅本次显示，不会再次打印。建议立即截图或抄录。",
      );
      console.log("然后打开 /login，输入 App 中的 6 位验证码完成首次登录。");
    })
    .catch((err) => {
      console.error("二维码生成失败（不影响设置）：", err.message);
      console.log(`也可手动输入此 URI 添加账户：\n${uri}`);
    });
}

main();
