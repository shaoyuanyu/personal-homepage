"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import {
  ArrowLeftIcon,
  CircleAlertIcon,
  DownloadIcon,
  MailOpenIcon,
  MailIcon,
  ReplyIcon,
  StarIcon,
  Trash2Icon,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { Link, useRouter } from "@/lib/i18n/navigation";
import { buttonVariants } from "@/components/ui/button";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "@/components/ui/toast";
import type { MailAccount, MailDetail } from "@/lib/mail/types";

function fmtAddress(list: { name?: string; address?: string }[]): string {
  return list.map((a) => (a.name ? `${a.name} <${a.address}>` : (a.address ?? ""))).join(", ");
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 单封邮件视图：详情 + 操作（回复 / 标记 / 删除）+ 远程图片逐封加载（4.4） */
export function MessageView({ messageId }: { messageId: string }) {
  const t = useTranslations("mail");
  const router = useRouter();

  const [detail, setDetail] = useState<MailDetail | null>(null);
  const [accounts, setAccounts] = useState<Map<string, MailAccount>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [acting, setActing] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [remoteShown, setRemoteShown] = useState(false);

  // ⚠ React 19 对 dangerouslySetInnerHTML 按「包装对象引用」比较（!==），
  // 每次渲染新建 {__html} 字面量都会触发 innerHTML 无条件重设，
  // 把「显示图片」对占位图的 DOM 改写冲掉。必须 memo 固定引用。
  const bodyInnerHtml = useMemo(
    () => (detail?.html ? { __html: detail.html } : undefined),
    [detail?.html],
  );

  useEffect(() => {
    fetch("/api/mail/accounts")
      .then((r) => (r.ok ? r.json() : []))
      .then((data: MailAccount[]) => setAccounts(new Map(data.map((a) => [a.id, a]))))
      .catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/mail/message/${encodeURIComponent(messageId)}`)
      .then(async (res) => {
        if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? `${res.status}`);
        return res.json();
      })
      .then((data: MailDetail) => {
        if (cancelled) return;
        setDetail(data);
        // 正常 webmail 行为：打开即标已读（对该消息的所有副本一起写，红线 8）
        if (!data.seen) {
          fetch("/api/mail/flags", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ messageId, seen: true }),
          })
            .then((res) => {
              if (res.ok && !cancelled) setDetail((d) => (d ? { ...d, seen: true } : d));
            })
            .catch(() => {});
        }
      })
      .catch((err) => !cancelled && setError(err instanceof Error ? err.message : String(err)));
    return () => {
      cancelled = true;
    };
  }, [messageId]);

  const postFlags = useCallback(
    async (change: { seen?: boolean; flagged?: boolean }) => {
      if (!detail) return;
      setActing(true);
      try {
        const res = await fetch("/api/mail/flags", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ messageId, ...change }),
        });
        if (!res.ok) throw new Error();
        setDetail({ ...detail, ...change });
      } catch {
        toast.add({ title: t("actionFailed"), type: "error" });
      } finally {
        setActing(false);
      }
    },
    [detail, messageId, t],
  );

  const doDelete = useCallback(async () => {
    if (!detail) return;
    setActing(true);
    try {
      const res = await fetch("/api/mail/delete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ copies: detail.copies }),
      });
      if (!res.ok) throw new Error();
      toast.add({ title: t("deleted"), type: "success" });
      router.push("/mail");
    } catch {
      toast.add({ title: t("actionFailed"), type: "error" });
      setActing(false);
    }
  }, [detail, router, t]);

  // 「显示图片」：把占位图换回原远程 URL（4.4：逐封、一次性）
  const showRemoteImages = useCallback(() => {
    bodyRef.current
      ?.querySelectorAll("img[data-remote-src]")
      .forEach((img) => {
        const el = img as HTMLImageElement;
        el.src = el.dataset.remoteSrc!;
        el.removeAttribute("data-remote-src");
      });
    setRemoteShown(true);
  }, []);

  if (error) {
    return (
      <div className="flex flex-col items-start gap-4">
        <Link href="/mail" data-slot="button" className={buttonVariants({ variant: "ghost", size: "sm" })}>
          <ArrowLeftIcon data-icon="default" />
          {t("backToList")}
        </Link>
        <p className="flex items-center gap-2 text-sm text-destructive">
          <CircleAlertIcon className="size-4" aria-hidden />
          {t("loadFailed")}：{error}
        </p>
      </div>
    );
  }

  if (!detail) {
    return (
      <p className="flex items-center gap-2 py-12 justify-center text-sm text-muted-foreground">
        <Spinner label={t("loading")} />
        {t("loading")}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      {/* 操作栏 */}
      <div className="flex flex-wrap items-center gap-2">
        <Link href="/mail" data-slot="button" className={buttonVariants({ variant: "ghost", size: "sm" })}>
          <ArrowLeftIcon data-icon="default" />
          {t("backToList")}
        </Link>
        <div className="ml-auto flex items-center gap-2">
          <Link
            href={`/mail/compose?replyTo=${encodeURIComponent(messageId)}`}
            data-slot="button"
            className={buttonVariants({ variant: "outline", size: "sm" })}
          >
            <ReplyIcon data-icon="default" />
            {t("reply")}
          </Link>
          <Button variant="outline" size="sm" disabled={acting} onClick={() => postFlags({ seen: !detail.seen })}>
            {detail.seen ? <MailOpenIcon data-icon="default" /> : <MailIcon data-icon="default" />}
            {detail.seen ? t("markUnread") : t("markRead")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={acting}
            aria-pressed={detail.flagged}
            onClick={() => postFlags({ flagged: !detail.flagged })}
          >
            <StarIcon className={cn("size-4", detail.flagged && "fill-amber-500 text-amber-500")} data-icon={detail.flagged ? undefined : "default"} />
            {detail.flagged ? t("unflag") : t("flag")}
          </Button>
          <Button variant="outline" size="sm" disabled={acting} onClick={() => setConfirmDelete(true)}>
            <Trash2Icon data-icon="default" />
            {t("delete")}
          </Button>
        </div>
      </div>

      {/* 头部 */}
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-bold tracking-tight">{detail.subject || t("noSubject")}</h1>
        <dl className="flex flex-col gap-1 text-sm">
          <div className="flex gap-2">
            <dt className="w-16 shrink-0 text-muted-foreground">{t("fieldFrom")}</dt>
            <dd className="min-w-0 break-all">{detail.fromName ? `${detail.fromName} <${detail.fromAddr}>` : detail.fromAddr}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="w-16 shrink-0 text-muted-foreground">{t("fieldTo")}</dt>
            <dd className="min-w-0 break-all">{fmtAddress(detail.to)}</dd>
          </div>
          {detail.cc.length > 0 && (
            <div className="flex gap-2">
              <dt className="w-16 shrink-0 text-muted-foreground">{t("fieldCc")}</dt>
              <dd className="min-w-0 break-all">{fmtAddress(detail.cc)}</dd>
            </div>
          )}
          <div className="flex gap-2">
            <dt className="w-16 shrink-0 text-muted-foreground">{t("fieldDate")}</dt>
            <dd className="tabular-nums">{detail.date ? new Date(detail.date).toLocaleString(t("localeTag")) : ""}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="w-16 shrink-0 text-muted-foreground">{t("fieldCopies")}</dt>
            <dd className="text-muted-foreground">
              {detail.copies.map((c) => `${accounts.get(c.accountId)?.displayName ?? c.accountId} · ${c.folder}`).join("；")}
            </dd>
          </div>
        </dl>
      </header>

      {/* 远程内容提示（4.4：默认剥除，显式点击逐封加载一次） */}
      {detail.remoteBlocked > 0 && !remoteShown && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-dashed border-border px-3 py-2 text-sm text-muted-foreground">
          <span>{t("remoteBlocked", { count: detail.remoteBlocked })}</span>
          <Button variant="outline" size="sm" onClick={showRemoteImages}>
            {t("showRemote")}
          </Button>
        </div>
      )}

      {/* 正文 */}
      {detail.html ? (
        <div
          ref={bodyRef}
          className="mail-body overflow-x-auto rounded-xl border border-border bg-background p-4 text-sm leading-relaxed"
          // webmaild 已做过 sanitize + 远程资源剥除（4.4）
          dangerouslySetInnerHTML={bodyInnerHtml}
        />
      ) : (
        <div className="whitespace-pre-wrap rounded-xl border border-border p-4 text-sm leading-relaxed">
          {detail.text || detail.snippet}
        </div>
      )}

      {/* 附件 */}
      {detail.attachments.filter((a) => !a.inline).length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-medium text-muted-foreground">
            {t("attachments", { count: detail.attachments.filter((a) => !a.inline).length })}
          </h2>
          <ul className="flex flex-wrap gap-2">
            {detail.attachments
              .filter((a) => !a.inline)
              .map((a) => (
                <li key={a.index}>
                  <a
                    href={`/api/mail/message/${encodeURIComponent(messageId)}/attachment/${a.index}`}
                    download={a.filename}
                    data-slot="button"
                    className={buttonVariants({ variant: "outline", size: "sm" })}
                  >
                    <DownloadIcon data-icon="default" />
                    {a.filename}
                    <span className="text-xs text-muted-foreground tabular-nums">{fmtSize(a.size)}</span>
                  </a>
                </li>
              ))}
          </ul>
        </section>
      )}

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={t("deleteConfirmTitle")}
        description={t("deleteConfirmBody")}
        confirmLabel={t("delete")}
        pending={acting}
        onConfirm={doDelete}
      />
    </div>
  );
}
