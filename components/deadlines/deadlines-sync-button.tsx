"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { RefreshCwIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useOwnerPreferences } from "@/lib/preferences/use-owner-preferences";

/**
 * 主人专属：手动立即同步 deadline 数据源（POST 后刷新页面展示最新数据）。
 *
 * 独立为客户端组件，使服务端渲染的页面头部能把按钮排在描述文字右侧，
 * 而非在列表上方独占一行；游客渲染 null，不占位。
 */
export function DeadlinesSyncButton() {
  const t = useTranslations("deadlines");
  const { isOwner } = useOwnerPreferences();
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState("");

  if (!isOwner) return null;

  const handleSync = async () => {
    if (syncing) return;
    setSyncing(true);
    setSyncError("");
    try {
      const r = await fetch("/api/deadlines/sync", { method: "POST" });
      const data = (await r.json().catch(() => null)) as
        | { error?: string }
        | null;
      if (!r.ok) throw new Error(data?.error ?? `HTTP ${r.status}`);
      window.location.reload();
    } catch (err) {
      setSyncError(err instanceof Error ? err.message : String(err));
      setSyncing(false);
    }
  };

  return (
    <div className="flex flex-col items-start gap-1 sm:max-w-56 sm:shrink-0 sm:items-end">
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={handleSync}
        disabled={syncing}
      >
        <RefreshCwIcon
          className={syncing ? "animate-spin" : undefined}
          data-icon="inline-start"
        />
        {syncing ? t("syncing") : t("syncNow")}
      </Button>
      {syncError && (
        <p className="text-xs text-destructive sm:text-right" role="alert">
          {t("syncFailed")}：{syncError}
        </p>
      )}
    </div>
  );
}
