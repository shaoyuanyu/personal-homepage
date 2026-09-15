"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { CopyIcon, KeyRoundIcon, ShuffleIcon, Trash2Icon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "@/components/ui/toast";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PREFERENCE_KEYS } from "@/lib/preferences/registry";
import { useOwnerPreferences } from "@/lib/preferences/use-owner-preferences";

/** 复制到剪贴板：优先 Clipboard API，失败回退 execCommand（非 HTTPS 环境可用） */
async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
  }
}

type CredStatus = {
  configured: boolean;
  source: "file" | "env" | null;
  user: string | null;
  password: string | null;
  pending: boolean;
};

/**
 * CalDAV 凭证设置（站主专属，挂在「我的日历」工具栏）：
 * 查看用户名/密码明文、修改用户名密码、一键随机重置。保存后运行时优先使用
 * 文件凭证（data/caldav.json），未设置时回退服务器环境变量。
 * 密码变更会登记重置队列，VPS crontab 每分钟同步到 Radicale（页面显示 pending 提示）。
 * 服务器地址由部署环境决定（环境变量 CALDAV_URL），不在网站内配置。
 */
export function CalendarSettings({ onSaved }: { onSaved?: () => void }) {
  const t = useTranslations("calendar");
  // 显示偏好（每周起始日）：登录跨设备同步 / 游客 localStorage
  const { prefs, setPref } = useOwnerPreferences();
  const weekStart =
    prefs[PREFERENCE_KEYS.CALENDAR_WEEK_START] === "monday" ? "monday" : "sunday";
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<CredStatus | null>(null);
  const [user, setUser] = useState("");
  const [password, setPassword] = useState("");
  // 随机重置后返回的新密码（高亮展示一次，之后可随时在状态区查看）
  const [freshPassword, setFreshPassword] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 待确认的破坏性操作（替换原生 window.confirm） */
  const [confirmKind, setConfirmKind] = useState<"reset" | "clear" | null>(null);

  // 打开时拉取当前状态（含密码明文，仅站主可访问该接口），预填用户名
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setError(null);
    setFreshPassword(null);
    fetch("/api/calendar/credentials")
      .then((r) => r.json().catch(() => null))
      .then((data: CredStatus | null) => {
        if (!cancelled && data) {
          setStatus(data);
          setUser(data.user ?? "");
          setPassword("");
        }
      })
      .catch(() => {
        if (!cancelled) setError(t("settingsLoadFailed"));
      });
    return () => {
      cancelled = true;
    };
  }, [open, t]);

  async function handleSave() {
    if (saving) return;
    const trimmedUser = user.trim();
    if (!trimmedUser) {
      setError(t("settingsUserRequired"));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/calendar/credentials", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          user: trimmedUser,
          password: password || undefined,
        }),
      });
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
      toast.add({ title: t("settingsSaved"), type: "success" });
      setOpen(false);
      onSaved?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("settingsSaveFailed"));
    } finally {
      setSaving(false);
    }
  }

  async function handleReset() {
    if (resetting) return;
    setResetting(true);
    setError(null);
    try {
      const res = await fetch("/api/calendar/credentials", { method: "POST" });
      const data = (await res.json().catch(() => null)) as {
        error?: string;
        user?: string;
        password?: string;
      } | null;
      if (!res.ok || !data?.password) {
        throw new Error(data?.error ?? `HTTP ${res.status}`);
      }
      // 更新展示状态：新密码高亮显示，等待 VPS 同步到 Radicale
      setStatus({
        configured: true,
        source: "file",
        user: data.user ?? null,
        password: data.password,
        pending: true,
      });
      setFreshPassword(data.password);
      setUser(data.user ?? "");
      setPassword("");
      onSaved?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("settingsSaveFailed"));
    } finally {
      setResetting(false);
    }
  }

  async function handleClear() {
    if (clearing) return;
    setClearing(true);
    setError(null);
    try {
      const res = await fetch("/api/calendar/credentials", { method: "DELETE" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // 清除后重新拉取状态：有环境变量凭证则回退显示，否则显示未配置
      const data = (await fetch("/api/calendar/credentials")
        .then((r) => r.json())
        .catch(() => null)) as CredStatus | null;
      toast.add({ title: t("settingsCleared"), type: "success" });
      setStatus(data);
      setUser(data?.user ?? "");
      setPassword("");
      onSaved?.();
    } catch {
      setError(t("settingsSaveFailed"));
    } finally {
      setClearing(false);
    }
  }

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={() => setOpen(true)}
        aria-label={t("settings")}
      >
        <KeyRoundIcon data-icon="default" />
        <span className="hidden sm:inline">{t("settings")}</span>
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("settingsDialogTitle")}</DialogTitle>
            <DialogDescription>{t("settingsDialogDescription")}</DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-4">
            {/* 显示偏好：每周起始日（切换后主视图实时生效，偏好持久化） */}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Label>{t("weekStart")}</Label>
              <Tabs
                value={weekStart}
                onValueChange={(v) => {
                  if (v === "sunday" || v === "monday") {
                    setPref(PREFERENCE_KEYS.CALENDAR_WEEK_START, v);
                  }
                }}
              >
                <TabsList aria-label={t("weekStart")}>
                  <TabsTrigger value="sunday">
                    {t("weekStartSunday")}
                  </TabsTrigger>
                  <TabsTrigger value="monday">
                    {t("weekStartMonday")}
                  </TabsTrigger>
                </TabsList>
              </Tabs>
            </div>
            <div aria-hidden className="border-t" />

            {/* 当前状态：用户名 + 密码明文（仅站主可见）+ 待同步提示 */}
            {status?.configured && (
              <div className="flex flex-col gap-1 rounded-lg border bg-muted/40 px-3 py-2 text-xs">
                <p className="text-muted-foreground">
                  {status.source === "file"
                    ? t("settingsConfigured", { user: status.user ?? "" })
                    : t("settingsUsingEnv", { user: status.user ?? "" })}
                </p>
                {/* ⚠ 标签（zh「当前密码」是中文）走无衬线，只有密码值走等宽——
                    否则中文会进入等宽族、拉取 1.3MB 的 cjk 分片；
                    分开后中英两页都是「标签 sans + 值 mono」，天然对称。 */}
                <p className="flex items-center gap-1.5 text-sm text-foreground">
                  <span className="shrink-0 text-muted-foreground">
                    {t("settingsPasswordLabel")}:
                  </span>
                  <span className="min-w-0 flex-1 font-mono break-all">
                    {status.password ?? "—"}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={t("settingsCopy")}
                    title={t("settingsCopy")}
                    className="size-5 shrink-0"
                    onClick={async () => {
                      if (!status.password) return;
                      await copyText(status.password);
                      toast.add({ title: t("settingsCopied"), type: "success" });
                    }}
                  >
                    <CopyIcon data-icon="default" className="size-3.5" />
                  </Button>
                </p>
                {status.pending && (
                  <p className="text-amber-600 dark:text-amber-400">
                    {t("settingsPending")}
                  </p>
                )}
              </div>
            )}
            {!status?.configured && (
              <div className="rounded-lg border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                <p>{t("settingsNotConfigured")}</p>
              </div>
            )}

            {/* 随机重置后的新密码：高亮展示一次，附复制按钮 */}
            {freshPassword && (
              <div className="flex flex-col gap-1 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-xs">
                <p className="flex items-center justify-between gap-2">
                  <span className="font-semibold text-primary">
                    {t("settingsResetDone")}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={t("settingsCopy")}
                    title={t("settingsCopy")}
                    className="size-5 shrink-0 text-primary"
                    onClick={async () => {
                      await copyText(freshPassword);
                      toast.add({ title: t("settingsCopied"), type: "success" });
                    }}
                  >
                    <CopyIcon data-icon="default" className="size-3.5" />
                  </Button>
                </p>
                <p className="break-all font-mono text-sm text-foreground">
                  {freshPassword}
                </p>
              </div>
            )}

            <div className="flex flex-col gap-2">
              <Label htmlFor="caldav-user">{t("settingsUser")}</Label>
              <Input
                id="caldav-user"
                value={user}
                onChange={(e) => setUser(e.target.value)}
                placeholder="caladmin"
                autoComplete="username"
                maxLength={200}
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="caldav-password">{t("settingsPassword")}</Label>
              <Input
                id="caldav-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={
                  status?.configured
                    ? t("settingsPasswordKeep")
                    : t("settingsPasswordRequired")
                }
                autoComplete="new-password"
                maxLength={200}
              />
            </div>

            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>

          <DialogFooter className="flex items-center justify-between gap-2 sm:justify-between">
            {status?.configured ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setConfirmKind("clear")}
                disabled={clearing}
              >
                <Trash2Icon data-icon="default" />
                {t("settingsClear")}
              </Button>
            ) : (
              <span />
            )}
            <div className="flex flex-wrap items-center justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setConfirmKind("reset")}
                disabled={resetting || !status?.configured}
              >
                <ShuffleIcon data-icon="default" />
                {t("settingsReset")}
              </Button>
              {/* 不设底部「关闭」——右上角 X 是全站统一的关闭入口（用户指定） */}
              <Button size="sm" onClick={handleSave} disabled={saving}>
                {t("settingsSave")}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/*
       * 破坏性操作确认（替换原生 window.confirm：原生弹窗不随明暗主题、样式与站内
       * 脱节、移动端观感突兀，且阻塞主线程）。⚠ 渲染在设置弹窗之外，故数据到达前
       * 设置弹窗关闭时会一并关掉确认弹窗。
       */}
      <ConfirmDialog
        open={confirmKind !== null}
        onOpenChange={(next) => {
          if (!next) setConfirmKind(null);
        }}
        title={confirmKind === "clear" ? t("settingsClearConfirm") : t("settingsResetConfirm")}
        confirmLabel={confirmKind === "clear" ? t("settingsClear") : t("settingsReset")}
        pending={confirmKind === "clear" ? clearing : resetting}
        onConfirm={() => {
          const kind = confirmKind;
          setConfirmKind(null);
          if (kind === "clear") void handleClear();
          else if (kind === "reset") void handleReset();
        }}
      />
    </>
  );
}
