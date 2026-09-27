"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import {
  CircleAlertIcon,
  InboxIcon,
  RefreshCwIcon,
  SquarePenIcon,
  StarIcon,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { Link, useRouter } from "@/lib/i18n/navigation";
import { encodeMessageId } from "@/lib/mail/id";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia } from "@/components/ui/empty";
import type { MailAccount, MailListItem, MailListResponse } from "@/lib/mail/types";

/** 账号色点（4.2：避开等级配色色相，用青/紫/橙/玫红一档；整串静态类名） */
const ACCOUNT_DOT: Record<string, string> = {
  cyan: "bg-cyan-600 dark:bg-cyan-400",
  violet: "bg-violet-600 dark:bg-violet-400",
  orange: "bg-orange-600 dark:bg-orange-400",
  pink: "bg-pink-600 dark:bg-pink-400",
  teal: "bg-teal-600 dark:bg-teal-400",
};

function accountDotClass(color: string): string {
  return ACCOUNT_DOT[color] ?? "bg-muted-foreground";
}

function formatDate(dateIso: string | null, locale: string): string {
  if (!dateIso) return "";
  const d = new Date(dateIso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return d.toLocaleString(locale, sameDay
    ? { hour: "2-digit", minute: "2-digit" }
    : { month: "short", day: "numeric" });
}

/** 邮件合并视图：默认全部账号合并，工具栏可筛选单账号（4.2） */
export function MailClient() {
  const t = useTranslations("mail");
  const router = useRouter();

  const [accounts, setAccounts] = useState<MailAccount[]>([]);
  const [accountFilter, setAccountFilter] = useState<string>("all");
  const [q, setQ] = useState("");
  const [items, setItems] = useState<MailListItem[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const searchTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const load = useCallback(
    async (opts: { account: string; q: string; before?: string | null; append?: boolean }) => {
      const params = new URLSearchParams();
      if (opts.account !== "all") params.set("account", opts.account);
      if (opts.q.trim()) params.set("q", opts.q.trim());
      if (opts.before) params.set("before", opts.before);
      const res = await fetch(`/api/mail/messages?${params}`);
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? `${res.status}`);
      const data = (await res.json()) as MailListResponse;
      setItems((prev) => (opts.append ? [...prev, ...data.items] : data.items));
      setNext(data.next);
    },
    [],
  );

  // 账号列表（筛选 chips 与色点）
  useEffect(() => {
    fetch("/api/mail/accounts")
      .then((r) => (r.ok ? r.json() : []))
      .then((data: MailAccount[]) => setAccounts(data.filter((a) => a.enabled)))
      .catch(() => {});
  }, []);

  // 初始与筛选/搜索变化时加载（搜索框 300ms 防抖）
  useEffect(() => {
    setLoading(true);
    setError(null);
    clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => {
      load({ account: accountFilter, q })
        .catch((err) => setError(err instanceof Error ? err.message : String(err)))
        .finally(() => setLoading(false));
    }, 300);
    return () => clearTimeout(searchTimer.current);
  }, [accountFilter, q, load]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    setError(null);
    try {
      await fetch("/api/mail/sync", { method: "POST" });
      await load({ account: accountFilter, q });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRefreshing(false);
    }
  }, [accountFilter, q, load]);

  const loadMore = useCallback(async () => {
    if (!next) return;
    setLoadingMore(true);
    try {
      await load({ account: accountFilter, q, before: next, append: true });
    } finally {
      setLoadingMore(false);
    }
  }, [next, accountFilter, q, load]);

  const accountName = useMemo(() => {
    const map = new Map(accounts.map((a) => [a.id, a]));
    return (id: string) => map.get(id);
  }, [accounts]);

  return (
    <div className="flex flex-col gap-4">
      {/* 工具栏：账号筛选 + 搜索 + 刷新 + 写邮件 */}
      <div className="flex flex-wrap items-center gap-2">
        <ToggleGroup
          value={[accountFilter]}
          onValueChange={(v) => setAccountFilter(v[0] ?? "all")}
          className="flex-wrap"
        >
          <ToggleGroupItem value="all" size="sm">{t("filterAll")}</ToggleGroupItem>
          {accounts.map((a) => (
            <ToggleGroupItem key={a.id} value={a.id} size="sm">
              <span className={cn("mr-1.5 inline-block size-2 rounded-full", accountDotClass(a.color))} />
              {a.displayName}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <div className="ml-auto flex items-center gap-2">
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t("searchPlaceholder")}
            className="w-40 sm:w-56"
            aria-label={t("searchPlaceholder")}
          />
          <Button variant="outline" size="sm" onClick={refresh} disabled={refreshing}>
            {refreshing ? <Spinner /> : <RefreshCwIcon data-icon="default" />}
            {t("refresh")}
          </Button>
          <Link
            href="/mail/compose"
            data-slot="button"
            className={buttonVariants({ size: "sm" })}
          >
            <SquarePenIcon data-icon="default" />
            {t("compose")}
          </Link>
        </div>
      </div>

      {error && (
        <p className="flex items-center gap-2 text-sm text-destructive">
          <CircleAlertIcon className="size-4" aria-hidden />
          {t("loadFailed")}：{error}
        </p>
      )}

      {loading ? (
        <p className="flex items-center gap-2 py-12 justify-center text-sm text-muted-foreground">
          <Spinner label={t("loading")} />
          {t("loading")}
        </p>
      ) : items.length === 0 ? (
        <Empty>
          <EmptyMedia variant="icon">
            <InboxIcon aria-hidden />
          </EmptyMedia>
          <EmptyHeader>
            <EmptyDescription>{q ? t("emptySearch") : t("empty")}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ul className="divide-y divide-border rounded-xl border border-border" data-slot="mail-list">
          {items.map((m) => (
            <li key={m.messageId}>
              <button
                type="button"
                onClick={() => router.push(`/mail/message/${encodeMessageId(m.messageId)}`)}
                className="flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-accent/50"
              >
                {/* 账号色点：归属任何时候可见（4.2） */}
                <span className="mt-1.5 flex shrink-0 gap-1" title={m.accounts.map((id) => accountName(id)?.displayName ?? id).join("、")}>
                  {m.accounts.map((id) => (
                    <span
                      key={id}
                      className={cn("inline-block size-2 rounded-full", accountDotClass(accountName(id)?.color ?? ""))}
                    />
                  ))}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline gap-2">
                    <span className={cn("truncate text-sm", !m.seen && "font-semibold")}>
                      {m.fromName || m.fromAddr}
                    </span>
                    {m.flagged && <StarIcon className="size-3.5 shrink-0 fill-amber-500 text-amber-500" aria-label={t("flagged")} />}
                    <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums">
                      {formatDate(m.date, t("localeTag"))}
                    </span>
                  </span>
                  <span className={cn("block truncate text-sm", !m.seen ? "font-medium" : "text-muted-foreground")}>
                    {m.subject || t("noSubject")}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">{m.snippet}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {next && !loading && (
        <div className="flex justify-center">
          <Button variant="outline" size="sm" onClick={loadMore} disabled={loadingMore}>
            {loadingMore ? <Spinner /> : null}
            {t("loadMore")}
          </Button>
        </div>
      )}
    </div>
  );
}
