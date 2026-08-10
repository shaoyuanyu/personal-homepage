"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "@/lib/i18n/navigation";
import {
  CheckIcon,
  CircleIcon,
  LoaderCircleIcon,
  LogOutIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia } from "@/components/ui/empty";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { Idea, IdeaStatus } from "@/lib/ideas/store";

type Filter = "all" | IdeaStatus;

/**
 * 想法速记管理面板（仅主人可见）：
 * 快速记录 + 筛选 + 行内编辑 + 完成切换 + 删除。
 * 所有变更乐观更新，失败回滚并提示。
 */
export function IdeasManager({ initialIdeas }: { initialIdeas: Idea[] }) {
  const t = useTranslations("ideas");
  const locale = useLocale();
  const router = useRouter();

  const [ideas, setIdeas] = useState<Idea[]>(initialIdeas);
  const [filter, setFilter] = useState<Filter>("all");
  const [input, setInput] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // 相对时间格式化（"3 分钟前"），整点刷新保持新鲜
  const rtf = useMemo(() => new Intl.RelativeTimeFormat(locale, { numeric: "auto" }), [locale]);
  const [, forceTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => forceTick((n) => n + 1), 60_000);
    return () => clearInterval(id);
  }, []);

  function formatRelativeTime(ts: number): string {
    const diff = ts - Date.now();
    const abs = Math.abs(diff);
    const [unit, value] =
      abs < 60_000
        ? (["second", Math.round(diff / 1000)] as const)
        : abs < 3_600_000
          ? (["minute", Math.round(diff / 60_000)] as const)
          : abs < 86_400_000
            ? (["hour", Math.round(diff / 3_600_000)] as const)
            : (["day", Math.round(diff / 86_400_000)] as const);
    return rtf.format(value, unit);
  }

  function formatFullTime(ts: number): string {
    return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(ts);
  }

  async function handleCreate() {
    const content = input.trim();
    if (!content || submitting) return;
    setSubmitting(true);
    setError(null);
    const prev = ideas;
    try {
      const res = await fetch("/api/ideas", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });
      const data = (await res.json().catch(() => null)) as { idea?: Idea } | null;
      if (!res.ok || !data?.idea) throw new Error("create failed");
      setIdeas((list) => [data.idea!, ...list]);
      setInput("");
      inputRef.current?.focus();
    } catch {
      setIdeas(prev);
      setError(t("error.save"));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleToggleStatus(idea: Idea) {
    const next: IdeaStatus = idea.status === "open" ? "done" : "open";
    const prev = ideas;
    setIdeas((list) =>
      list.map((i) => (i.id === idea.id ? { ...i, status: next, updatedAt: Date.now() } : i)),
    );
    setError(null);
    try {
      const res = await fetch(`/api/ideas/${idea.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: next }),
      });
      if (!res.ok) throw new Error("update failed");
    } catch {
      setIdeas(prev);
      setError(t("error.save"));
    }
  }

  async function handleSaveEdit(idea: Idea) {
    const content = editingText.trim();
    if (!content || content === idea.content) {
      setEditingId(null);
      return;
    }
    const prev = ideas;
    setIdeas((list) =>
      list.map((i) => (i.id === idea.id ? { ...i, content, updatedAt: Date.now() } : i)),
    );
    setEditingId(null);
    setError(null);
    try {
      const res = await fetch(`/api/ideas/${idea.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });
      if (!res.ok) throw new Error("update failed");
    } catch {
      setIdeas(prev);
      setError(t("error.save"));
    }
  }

  async function handleDelete(idea: Idea) {
    if (!window.confirm(t("deleteConfirm"))) return;
    const prev = ideas;
    setIdeas((list) => list.filter((i) => i.id !== idea.id));
    setError(null);
    try {
      const res = await fetch(`/api/ideas/${idea.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("delete failed");
    } catch {
      setIdeas(prev);
      setError(t("error.delete"));
    }
  }

  function handleLogout() {
    void (async () => {
      await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
      router.push("/");
      router.refresh();
    })();
  }

  const visible = useMemo(() => {
    if (filter === "all") return ideas;
    return ideas.filter((i) => i.status === filter);
  }, [ideas, filter]);

  const counts = useMemo(
    () => ({
      all: ideas.length,
      open: ideas.filter((i) => i.status === "open").length,
      done: ideas.filter((i) => i.status === "done").length,
    }),
    [ideas],
  );

  return (
    <div className="flex flex-col gap-6">
      {/* 快速记录 */}
      <form
        className="flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void handleCreate();
        }}
      >
        <Textarea
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void handleCreate();
            }
          }}
          placeholder={t("placeholder")}
          aria-label={t("placeholder")}
          rows={3}
          disabled={submitting}
          className="resize-none"
        />
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">{t("hint")}</p>
          <Button type="submit" disabled={submitting || !input.trim()} size="sm">
            {submitting ? (
              <LoaderCircleIcon className="animate-spin" />
            ) : (
              <PlusIcon />
            )}
            {t("add")}
          </Button>
        </div>
      </form>

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      {/* 筛选：Base UI ToggleGroup 的 value 恒为数组（单选时最多一个元素） */}
      <ToggleGroup
        value={filter === "all" ? [] : [filter]}
        onValueChange={(v) => {
          const next = v[0];
          if (next === "open" || next === "done") setFilter(next);
        }}
        className="w-fit"
      >
        <ToggleGroupItem value="all">
          {t("filters.all")}
          <Badge variant="secondary" className="ml-1 h-4 px-1 text-[10px] tabular-nums">
            {counts.all}
          </Badge>
        </ToggleGroupItem>
        <ToggleGroupItem value="open">
          {t("filters.open")}
          <Badge variant="secondary" className="ml-1 h-4 px-1 text-[10px] tabular-nums">
            {counts.open}
          </Badge>
        </ToggleGroupItem>
        <ToggleGroupItem value="done">
          {t("filters.done")}
          <Badge variant="secondary" className="ml-1 h-4 px-1 text-[10px] tabular-nums">
            {counts.done}
          </Badge>
        </ToggleGroupItem>
      </ToggleGroup>

      {/* 列表 */}
      {visible.length === 0 ? (
        <Empty className="py-12">
          <EmptyMedia variant="icon">
            <PencilIcon />
          </EmptyMedia>
          <EmptyHeader>
            <EmptyDescription>
              {ideas.length === 0 ? t("empty") : t("emptyFiltered")}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ul className="flex flex-col gap-2">
          {visible.map((idea) => (
            <li
              key={idea.id}
              data-idea-status={idea.status}
              className="group flex items-start gap-3 rounded-xl border p-3.5 transition-colors hover:bg-muted/40"
            >
              {/* 完成切换 */}
              <button
                type="button"
                onClick={() => void handleToggleStatus(idea)}
                aria-label={
                  idea.status === "open" ? t("markDone") : t("restore")
                }
                className={`mt-0.5 shrink-0 rounded-full p-0.5 transition-colors ${
                  idea.status === "done"
                    ? "text-primary"
                    : "text-muted-foreground hover:text-primary"
                }`}
              >
                {idea.status === "done" ? (
                  <CheckIcon className="size-5" />
                ) : (
                  <CircleIcon className="size-5" />
                )}
              </button>

              {/* 内容 */}
              <div className="min-w-0 flex-1">
                {editingId === idea.id ? (
                  <Textarea
                    value={editingText}
                    onChange={(e) => setEditingText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        void handleSaveEdit(idea);
                      }
                      if (e.key === "Escape") setEditingId(null);
                    }}
                    rows={3}
                    autoFocus
                    className="resize-none"
                  />
                ) : (
                  <p
                    className={`whitespace-pre-wrap break-words text-sm leading-relaxed ${
                      idea.status === "done"
                        ? "text-muted-foreground line-through decoration-muted-foreground/40"
                        : ""
                    }`}
                  >
                    {idea.content}
                  </p>
                )}
                <div className="mt-1.5 flex items-center gap-2 text-xs text-muted-foreground">
                  <time
                    dateTime={new Date(idea.createdAt).toISOString()}
                    title={formatFullTime(idea.createdAt)}
                  >
                    {formatRelativeTime(idea.createdAt)}
                  </time>
                  {idea.status === "done" && (
                    <Badge variant="outline" className="h-4 px-1 text-[10px]">
                      {t("filters.done")}
                    </Badge>
                  )}
                </div>
              </div>

              {/* 操作 */}
              <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                {editingId === idea.id ? (
                  <>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => void handleSaveEdit(idea)}
                      aria-label={t("save")}
                    >
                      <CheckIcon />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => setEditingId(null)}
                      aria-label={t("cancel")}
                    >
                      <XIcon />
                    </Button>
                  </>
                ) : (
                  <>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => {
                        setEditingId(idea.id);
                        setEditingText(idea.content);
                      }}
                      aria-label={t("edit")}
                    >
                      <PencilIcon />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="text-destructive hover:text-destructive"
                      onClick={() => void handleDelete(idea)}
                      aria-label={t("delete")}
                    >
                      <Trash2Icon />
                    </Button>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* 退出登录 */}
      <div className="mt-2 border-t pt-4">
        <Button variant="ghost" size="sm" onClick={handleLogout}>
          <LogOutIcon />
          {t("logout")}
        </Button>
      </div>
    </div>
  );
}
