"use client";

import { useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { OWNER_AUTH_CHANGED_EVENT } from "@/lib/auth/events";

/**
 * 管理登录表单：输入 6 位 TOTP 验证码（或 16 位恢复码）。
 * 输满即自动提交；提交结果由 API 返回，成功跳转首页。
 */
export function LoginForm() {
  const t = useTranslations("login");
  const router = useRouter();
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<"totp" | "recovery">("totp");

  async function submit(value = code) {
    if (loading) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/totp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: value }),
      });
      if (res.ok) {
        window.dispatchEvent(new Event(OWNER_AUTH_CHANGED_EVENT));
        router.push("/");
        router.refresh();
        return;
      }
      const data = await res.json().catch(() => null);
      setError(
        data?.error === "rate_limited" ? t("error.rateLimited") : t("error.invalid"),
      );
    } catch {
      setError(t("error.network"));
    } finally {
      setLoading(false);
      setCode("");
    }
  }

  function handleChange(value: string) {
    const clean = value.replace(/\s/g, "");
    setCode(clean);
    // TOTP 满 6 位数字 / 恢复码满 16 位（含连字符最多 19 位）→ 自动提交
    if (/^\d{6}$/.test(clean) || /^[A-Za-z0-9-]{16,19}$/.test(clean)) {
      void submit(clean);
    }
  }

  // 切换 验证码 / 恢复码 输入模式（placeholder、inputMode 联动，清空已输入内容）
  function toggleMode() {
    setMode((m) => (m === "totp" ? "recovery" : "totp"));
    setCode("");
    setError(null);
  }

  return (
    <form
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        void submit();
      }}
      className="flex flex-col gap-6"
    >
      <div className="grid gap-2">
        <div className="flex items-center">
          <label htmlFor="auth-code" className="text-sm font-bold leading-none">
            {t("codeLabel")}
          </label>
          <button
            type="button"
            onClick={toggleMode}
            className="ml-auto inline-block text-sm underline-offset-4 hover:underline"
          >
            {mode === "totp" ? t("useRecovery") : t("useTotp")}
          </button>
        </div>
        <Input
          id="auth-code"
          value={code}
          onChange={(e) => handleChange(e.target.value)}
          placeholder={mode === "totp" ? t("codePlaceholder") : t("recoveryPlaceholder")}
          autoComplete="one-time-code"
          inputMode={mode === "totp" ? "numeric" : "text"}
          autoFocus
          disabled={loading}
          aria-invalid={error != null}
          className="h-12 font-mono"
        />
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </div>
      <Button type="submit" disabled={loading} className="h-11 w-full">
        {loading ? t("submitting") : t("submit")}
      </Button>
      <p className="text-balance text-sm text-muted-foreground">{t("totpHint")}</p>
    </form>
  );
}
