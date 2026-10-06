"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import {
  ArrowDownLeftIcon,
  ArrowUpRightIcon,
  DownloadIcon,
  FileTextIcon,
  MailIcon,
  PaperclipIcon,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia } from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "@/components/ui/toast";

/**
 * `/mail/agent` 只读入口（MAIL-AGENT.md 4.3 / 第八节第 5 步）：
 * agent 视角的原始邮件（时间线）+ 处理台账（判定/推理/工具调用/待确认）。
 * 本组件不调任何写接口——唯二的 POST 是待确认队列的确认/丢弃（人操作）。
 * 不渲染 HTML 邮件、不加载任何远程内容（4.4）：只展示头部原文与纯文本。
 */

// ---------- 类型（与 maild /agent/* 端点对应） ----------

interface TimelineItem {
  messageId: string;
  date: string;
  direction: "in" | "out";
  subject: string;
  fromAddr: string;
  fromName: string;
  toJson: string;
  snippet: string;
  truncated: boolean;
  folders: string[];
  seen: boolean;
}

interface PartInfo {
  kind: "text" | "html" | "attachment";
  contentType: string;
  size: number;
  filename?: string;
}

interface Rfc822Ref {
  index: number;
  filename?: string;
  size: number;
}

interface ParsedView {
  headersRaw: string;
  subject: string;
  from: string;
  date: string | null;
  messageId: string | null;
  parts: PartInfo[];
  text: string;
  rfc822: Rfc822Ref[];
}

interface JudgmentInfo {
  verdict: string;
  labels_json: string;
  confidence: number;
  model: string;
  prompt_version: string;
  judged_at: string;
}

interface MessageDetail extends ParsedView {
  messageId: string;
  direction: "in" | "out";
  copies: { accountId: string; folder: string; uid: number; flags: string }[];
  judgment: JudgmentInfo | null;
  reasoningCount: number;
}

interface JudgmentItem extends JudgmentInfo {
  message_id: string;
  subject: string | null;
  from_addr: string | null;
  date: string | null;
}

interface ReasoningItem {
  id: number;
  run_kind: string;
  trace: string | null;
  summary: string | null;
  model: string;
  prompt_version: string;
  tokens: number | null;
  started_at: string;
  finished_at: string;
}

interface LedgerItem {
  id: number;
  ts: string;
  tool: string;
  ok: number;
  message_id: string | null;
  detail_json: string;
  error: string | null;
}

interface PendingItem {
  id: number;
  created_at: string;
  to_json: string;
  subject: string;
  text: string;
}

// ---------- 展示辅助 ----------

function formatDate(dateIso: string | null, locale: string): string {
  if (!dateIso) return "";
  const d = new Date(dateIso);
  const sameDay = d.toDateString() === new Date().toDateString();
  return d.toLocaleString(locale, sameDay
    ? { hour: "2-digit", minute: "2-digit" }
    : { month: "short", day: "numeric" });
}

function formatDateTime(dateIso: string | null, locale: string): string {
  if (!dateIso) return "";
  return new Date(dateIso).toLocaleString(locale, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 时间线分组（4.9）：今天 / 昨天 / 更早（按自然日边界，非 24 小时窗） */
type DayGroup = "groupToday" | "groupYesterday" | "groupEarlier";
const DAY_GROUPS: DayGroup[] = ["groupToday", "groupYesterday", "groupEarlier"];

function dayGroupOf(dateIso: string): DayGroup {
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diff = startOfDay(new Date()) - startOfDay(new Date(dateIso));
  if (diff <= 0) return "groupToday";
  if (diff <= 86_400_000) return "groupYesterday";
  return "groupEarlier";
}

/**
 * 方向徽章配色 = 站点收发件的唯一配色（2026-10-05 统一，勿各自改色）：
 * 收件 emerald / 发件 amber —— 与列表、详情页的方向角标和视图 Tabs 下划线同源。
 * 选色约束：避开未读蓝点（blue）与星标（前景色），同屏不撞色（详见 MAIL-AGENT.md 4.9）。
 */
const DIR_CLASS = {
  in: "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-400/30 dark:bg-emerald-500/15 dark:text-emerald-400",
  out: "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-400/30 dark:bg-amber-500/15 dark:text-amber-400",
} as const;

const VERDICT_CLASS: Record<string, string> = {
  important: "border-red-200 bg-red-50 text-red-700 dark:border-red-400/30 dark:bg-red-500/15 dark:text-red-400",
  normal: "border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-400/30 dark:bg-blue-500/15 dark:text-blue-400",
  noise: "border-border bg-muted text-muted-foreground",
};

function DirBadge({ dir }: { dir: "in" | "out" }) {
  const t = useTranslations("mail.agent");
  const Icon = dir === "in" ? ArrowDownLeftIcon : ArrowUpRightIcon;
  return (
    <Badge variant="outline" className={cn("gap-0.5", DIR_CLASS[dir])} data-slot="agent-dir-badge">
      <Icon data-icon="default" aria-hidden />
      {t(dir === "in" ? "dirIn" : "dirOut")}
    </Badge>
  );
}

function VerdictBadge({ verdict }: { verdict: string }) {
  const t = useTranslations("mail.agent");
  const key = `verdict${verdict.charAt(0).toUpperCase()}${verdict.slice(1)}` as
    | "verdictImportant"
    | "verdictNormal"
    | "verdictNoise";
  return (
    <Badge variant="outline" className={VERDICT_CLASS[verdict] ?? VERDICT_CLASS.noise}>
      {t(key)}
    </Badge>
  );
}

/** 原始头部块：逐字内容走等宽（字体策略：逐字代码），折行保持 */
function HeadersBlock({ raw }: { raw: string }) {
  return (
    <pre className="max-h-56 overflow-auto rounded-lg border border-border bg-muted/40 p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-all">
      {raw}
    </pre>
  );
}

function PartsList({ parts }: { parts: PartInfo[] }) {
  return (
    <ul className="space-y-1" data-slot="agent-parts">
      {parts.map((p, i) => (
        <li key={i} className="flex items-center gap-2 text-xs text-muted-foreground">
          {p.kind === "attachment" ? (
            <PaperclipIcon className="size-3" aria-hidden />
          ) : (
            <FileTextIcon className="size-3" aria-hidden />
          )}
          <span className="font-mono">{p.contentType}</span>
          {p.filename && <span className="truncate">{p.filename}</span>}
          <span className="tabular-nums">{formatSize(p.size)}</span>
        </li>
      ))}
    </ul>
  );
}

/** 内嵌的 message/rfc822 邮件（4.3：就地展开，当场可核）；更深层的嵌套不再展开（看 .eml 原件） */
function Rfc822View({ data }: { data: ParsedView }) {
  const t = useTranslations("mail.agent");
  const locale = useLocale();
  return (
    <div className="space-y-3 rounded-lg border border-border p-3" data-slot="agent-rfc822">
      <div className="space-y-1">
        <div className="text-sm font-medium">{data.subject || t("noSubject")}</div>
        <div className="text-xs text-muted-foreground">
          {data.from}
          {data.date ? ` · ${formatDateTime(data.date, locale)}` : ""}
        </div>
      </div>
      <details>
        <summary className="cursor-pointer text-xs text-muted-foreground">{t("detailHeaders")}</summary>
        <HeadersBlock raw={data.headersRaw} />
      </details>
      <PartsList parts={data.parts} />
      {data.text && (
        <pre className="whitespace-pre-wrap text-sm leading-relaxed">{data.text}</pre>
      )}
    </div>
  );
}

// ---------- 时间线页签 ----------

function TimelineTab() {
  const t = useTranslations("mail.agent");
  const tm = useTranslations("mail");
  const locale = useLocale();
  const [items, setItems] = useState<TimelineItem[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(false);

  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<MessageDetail | null>(null);
  const [rfc822Data, setRfc822Data] = useState<Record<number, ParsedView | "loading">>({});

  const load = useCallback(async (before?: string | null) => {
    const params = new URLSearchParams();
    if (before) params.set("before", before);
    const res = await fetch(`/api/mail/agent/timeline?${params}`);
    if (!res.ok) throw new Error(`${res.status}`);
    const data = (await res.json()) as { items: TimelineItem[]; next: string | null };
    setItems((prev) => (before ? [...prev, ...data.items] : data.items));
    setNext(data.next);
  }, []);

  useEffect(() => {
    load()
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  }, [load]);

  const openMessage = useCallback(async (messageId: string) => {
    setOpenId(messageId);
    setDetail(null);
    setRfc822Data({});
    const res = await fetch(`/api/mail/agent/message/${encodeURIComponent(messageId)}`);
    if (res.ok) setDetail((await res.json()) as MessageDetail);
  }, []);

  const expandRfc822 = useCallback(
    async (index: number) => {
      if (!openId) return;
      setRfc822Data((prev) => ({ ...prev, [index]: "loading" }));
      const res = await fetch(
        `/api/mail/agent/message/${encodeURIComponent(openId)}/rfc822/${index}`
      );
      if (res.ok) {
        const data = (await res.json()) as ParsedView;
        setRfc822Data((prev) => ({ ...prev, [index]: data }));
      }
    },
    [openId]
  );

  // 时间线按「今天 / 昨天 / 更早」分组（4.9）
  // ⚠ 必须在早返回之前调用（hooks 不能条件化）
  const groups = useMemo(() => {
    const buckets: Record<DayGroup, TimelineItem[]> = {
      groupToday: [],
      groupYesterday: [],
      groupEarlier: [],
    };
    for (const m of items) buckets[dayGroupOf(m.date)].push(m);
    return DAY_GROUPS.map((key) => ({ key, rows: buckets[key] })).filter((g) => g.rows.length > 0);
  }, [items]);

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <Spinner label={tm("loading")} />
      </div>
    );
  }
  if (error) {
    return <p className="py-12 text-center text-sm text-muted-foreground">{t("loadFailed")}</p>;
  }
  if (items.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <MailIcon aria-hidden />
          </EmptyMedia>
          <EmptyDescription>{t("empty")}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <>
      <div data-slot="agent-timeline">
        {groups.map((g) => (
          <section key={g.key}>
            <h3 className="px-2 pt-4 pb-1 text-xs font-medium text-muted-foreground first:pt-0">
              {t(g.key)}
            </h3>
            <ul className="divide-y divide-border">
              {g.rows.map((m) => (
                <li key={m.messageId}>
                  <button
                    type="button"
                    onClick={() => openMessage(m.messageId)}
                    className="flex w-full items-center gap-3 py-3 text-left hover:bg-muted/40 rounded-lg px-2 -mx-2"
                  >
                    <DirBadge dir={m.direction} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">
                        {m.subject || t("noSubject")}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {m.direction === "in" ? m.fromName || m.fromAddr : m.fromAddr}
                        {m.snippet ? ` · ${m.snippet}` : ""}
                      </span>
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                      {formatDate(m.date, locale)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
      {next && (
        <div className="mt-4 flex justify-center">
          <Button
            variant="outline"
            size="sm"
            disabled={loadingMore}
            onClick={() => {
              setLoadingMore(true);
              load(next).finally(() => setLoadingMore(false));
            }}
          >
            {t("loadMore")}
          </Button>
        </div>
      )}

      <Dialog open={openId !== null} onOpenChange={(open) => !open && setOpenId(null)}>
        <DialogContent className="grid max-h-[85vh] grid-cols-[minmax(0,1fr)] overflow-y-auto sm:max-w-2xl!">
          {detail ? (
            <>
              <DialogHeader>
                <DialogTitle className="leading-snug">
                  <span className="mr-2 inline-block align-middle">
                    <DirBadge dir={detail.direction} />
                  </span>
                  {detail.subject || t("noSubject")}
                </DialogTitle>
                <DialogDescription>
                  {detail.from}
                  {detail.date ? ` · ${formatDateTime(detail.date, locale)}` : ""}
                </DialogDescription>
              </DialogHeader>

              {(detail.judgment || detail.reasoningCount > 0) && (
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  {detail.judgment && (
                    <>
                      <VerdictBadge verdict={detail.judgment.verdict} />
                      <span className="font-mono">
                        {detail.judgment.model} · {detail.judgment.prompt_version}
                      </span>
                    </>
                  )}
                  {detail.reasoningCount > 0 && (
                    <span>{t("reasoningCount", { count: detail.reasoningCount })}</span>
                  )}
                </div>
              )}

              <div className="text-xs text-muted-foreground">
                {t("copies")}：
                {detail.copies.map((c) => `${c.accountId}/${c.folder}`).join("、")}
              </div>

              <section className="space-y-2">
                <h3 className="text-xs font-medium text-muted-foreground">{t("detailHeaders")}</h3>
                <HeadersBlock raw={detail.headersRaw} />
              </section>

              <section className="space-y-2">
                <h3 className="text-xs font-medium text-muted-foreground">{t("detailStructure")}</h3>
                <PartsList parts={detail.parts} />
                {detail.rfc822.map((r) => (
                  <div key={r.index} className="space-y-2">
                    {rfc822Data[r.index] === undefined && (
                      <Button variant="ghost" size="sm" onClick={() => expandRfc822(r.index)}>
                        {t("expandRfc822")}
                        {r.filename ? `（${r.filename}）` : ""}
                      </Button>
                    )}
                    {rfc822Data[r.index] === "loading" && <Spinner label={tm("loading")} />}
                    {rfc822Data[r.index] !== undefined && rfc822Data[r.index] !== "loading" && (
                      <Rfc822View data={rfc822Data[r.index] as ParsedView} />
                    )}
                  </div>
                ))}
              </section>

              {detail.text && (
                <section className="space-y-2">
                  <h3 className="text-xs font-medium text-muted-foreground">{t("detailBody")}</h3>
                  <pre className="whitespace-pre-wrap rounded-lg border border-border p-3 text-sm leading-relaxed">
                    {detail.text}
                  </pre>
                </section>
              )}

              <div>
                <a
                  href={`/api/mail/agent/message/${encodeURIComponent(detail.messageId)}/eml`}
                  download
                  className={buttonVariants({ variant: "outline", size: "sm" })}
                  data-slot="button"
                >
                  <DownloadIcon data-icon="default" aria-hidden />
                  {t("downloadEml")}
                </a>
              </div>
            </>
          ) : (
            <div className="flex justify-center py-12">
              <Spinner label={tm("loading")} />
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

// ---------- 台账页签 ----------

function PendingSection() {
  const t = useTranslations("mail.agent");
  const [items, setItems] = useState<PendingItem[]>([]);
  const [busy, setBusy] = useState<number | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/mail/agent/pending-sends");
    if (res.ok) setItems(((await res.json()) as { items: PendingItem[] }).items);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const act = async (id: number, action: "confirm" | "discard") => {
    setBusy(id);
    try {
      const res = await fetch(`/api/mail/agent/pending-sends/${id}/${action}`, { method: "POST" });
      if (!res.ok) throw new Error(`${res.status}`);
      toast.add({ title: t(action === "confirm" ? "confirmed" : "discarded"), type: "success" });
      await load();
    } catch {
      toast.add({ title: t("actionFailed"), type: "error" });
    } finally {
      setBusy(null);
    }
  };

  return (
    <section data-slot="agent-pending">
      {items.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("pendingEmpty")}</p>
      ) : (
        <ul className="space-y-2">
          {items.map((p) => (
            <li key={p.id} className="rounded-lg border border-border p-3">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{p.subject}</div>
                  <div className="truncate text-xs text-muted-foreground">
                    → {(JSON.parse(p.to_json) as string[]).join("、")}
                  </div>
                </div>
                <div className="flex shrink-0 gap-2">
                  <Button size="sm" disabled={busy === p.id} onClick={() => act(p.id, "confirm")}>
                    {t("confirmSend")}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy === p.id}
                    onClick={() => act(p.id, "discard")}
                  >
                    {t("discardSend")}
                  </Button>
                </div>
              </div>
              <p className="mt-2 line-clamp-2 text-xs text-muted-foreground">{p.text}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ReasoningList({ messageId }: { messageId: string }) {
  const t = useTranslations("mail.agent");
  const tm = useTranslations("mail");
  const locale = useLocale();
  const [items, setItems] = useState<ReasoningItem[] | null>(null);

  useEffect(() => {
    fetch(`/api/mail/agent/reasoning?message=${encodeURIComponent(messageId)}`)
      .then((r) => (r.ok ? r.json() : { items: [] }))
      .then((d) => setItems((d as { items: ReasoningItem[] }).items));
  }, [messageId]);

  if (!items) return <Spinner label={tm("loading")} />;
  return (
    <ul className="space-y-3" data-slot="agent-reasoning">
      {items.map((r) => (
        <li key={r.id} className="space-y-2 rounded-lg border border-border p-3">
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <Badge variant="outline">{t(`runKind.${r.run_kind}` as never)}</Badge>
            <span className="font-mono">
              {r.model} · {r.prompt_version}
            </span>
            {r.tokens != null && <span className="tabular-nums">{r.tokens} tokens</span>}
            <span className="tabular-nums">{formatDateTime(r.started_at, locale)}</span>
          </div>
          {r.trace && (
            <div className="space-y-1">
              <div className="text-xs font-medium">{t("reasoningTrace")}</div>
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-lg bg-muted/40 p-2 text-xs leading-relaxed">
                {r.trace}
              </pre>
            </div>
          )}
          {r.summary && (
            <div className="space-y-1">
              <div className="text-xs font-medium text-muted-foreground">{t("reasoningSummary")}</div>
              <pre className="whitespace-pre-wrap text-xs leading-relaxed">{r.summary}</pre>
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

function JudgmentsSection() {
  const t = useTranslations("mail.agent");
  const locale = useLocale();
  const [items, setItems] = useState<JudgmentItem[]>([]);

  useEffect(() => {
    fetch("/api/mail/agent/judgments?limit=100")
      .then((r) => (r.ok ? r.json() : { items: [] }))
      .then((d) => setItems((d as { items: JudgmentItem[] }).items));
  }, []);

  if (items.length === 0) {
    return <p className="text-xs text-muted-foreground">{t("judgmentsEmpty")}</p>;
  }

  // 推理详情用 Accordion 折叠（4.9），可同时展开多条对照
  return (
    <Accordion multiple data-slot="agent-judgments">
      {items.map((j) => (
        <AccordionItem key={j.message_id} value={j.message_id}>
          <AccordionTrigger className="gap-2 hover:no-underline">
            <span className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
              <VerdictBadge verdict={j.verdict} />
              <span className="min-w-0 flex-1 truncate text-left text-sm">
                {j.subject || t("noSubject")}
              </span>
              {(JSON.parse(j.labels_json) as string[]).map((l) => (
                <Badge key={l} variant="outline" className="text-muted-foreground">
                  {l}
                </Badge>
              ))}
              <span className="text-xs text-muted-foreground tabular-nums">
                {Math.round(j.confidence * 100)}%
              </span>
              <span className="text-xs font-normal text-muted-foreground tabular-nums">
                {formatDateTime(j.judged_at, locale)}
              </span>
            </span>
          </AccordionTrigger>
          <AccordionContent>
            <ReasoningList messageId={j.message_id} />
          </AccordionContent>
        </AccordionItem>
      ))}
    </Accordion>
  );
}

function LedgerSection() {
  const t = useTranslations("mail.agent");
  const locale = useLocale();
  const [items, setItems] = useState<LedgerItem[]>([]);

  useEffect(() => {
    fetch("/api/mail/agent/ledger?limit=100")
      .then((r) => (r.ok ? r.json() : { items: [] }))
      .then((d) => setItems((d as { items: LedgerItem[] }).items));
  }, []);

  return (
    <section data-slot="agent-ledger">
      {items.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("ledgerEmpty")}</p>
      ) : (
        <ul className="divide-y divide-border">
          {items.map((l) => (
            <li key={l.id} className="py-2">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="text-muted-foreground tabular-nums">
                  {formatDateTime(l.ts, locale)}
                </span>
                <span className="font-mono">{l.tool}</span>
                <Badge
                  variant="outline"
                  className={
                    l.ok
                      ? "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-400/30 dark:bg-emerald-500/15 dark:text-emerald-400"
                      : "border-red-200 bg-red-50 text-red-700 dark:border-red-400/30 dark:bg-red-500/15 dark:text-red-400"
                  }
                >
                  {l.ok ? t("ok") : t("failed")}
                </Badge>
                {l.message_id && (
                  <span className="max-w-64 truncate font-mono text-muted-foreground">
                    {l.message_id}
                  </span>
                )}
                {l.error && <span className="text-destructive">{l.error}</span>}
              </div>
              {l.detail_json !== "{}" && (
                <details className="mt-1">
                  <summary className="cursor-pointer text-xs text-muted-foreground">detail</summary>
                  <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-muted/40 p-2 font-mono text-xs">
                    {JSON.stringify(JSON.parse(l.detail_json), null, 2)}
                  </pre>
                </details>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function LedgerTab() {
  const t = useTranslations("mail.agent");
  // 台账三段 Card 分区（4.9）：待确认 / 判定 / 工具调用
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>{t("pendingTitle")}</CardTitle>
        </CardHeader>
        <CardContent>
          <PendingSection />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{t("judgmentsTitle")}</CardTitle>
        </CardHeader>
        <CardContent>
          <JudgmentsSection />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{t("ledgerTitle")}</CardTitle>
        </CardHeader>
        <CardContent>
          <LedgerSection />
        </CardContent>
      </Card>
    </div>
  );
}

export function AgentView() {
  const t = useTranslations("mail.agent");
  return (
    <Tabs defaultValue="timeline">
      <TabsList>
        <TabsTrigger value="timeline">{t("tabTimeline")}</TabsTrigger>
        <TabsTrigger value="ledger">{t("tabLedger")}</TabsTrigger>
      </TabsList>
      <TabsContent value="timeline" className="pt-6">
        <TimelineTab />
      </TabsContent>
      <TabsContent value="ledger" className="pt-6">
        <LedgerTab />
      </TabsContent>
    </Tabs>
  );
}
