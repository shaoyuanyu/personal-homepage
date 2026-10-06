"use client";

import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useTranslations } from "next-intl";
import { BookUserIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import type { MailContactSuggest, MailOwnAddress } from "@/lib/mail/types";

/** 收件人分隔符（与 compose-form 发送时的 split 口径一致） */
const SEPARATORS = /[,;，；]/;

interface Suggestion {
  name: string;
  email: string;
  /** contact = 已保存联系人；known = 自动收录；own = 我自己的地址（4.10） */
  kind: "contact" | "known" | "own";
  times?: number;
}

/** 当前正在输入的 token = 最后一个分隔符之后的部分 */
function currentToken(value: string): { prefix: string; token: string } {
  let idx = -1;
  for (let i = value.length - 1; i >= 0; i--) {
    if (SEPARATORS.test(value[i])) {
      idx = i;
      break;
    }
  }
  return { prefix: value.slice(0, idx + 1), token: value.slice(idx + 1).trim() };
}

/**
 * 收件人输入框：按当前 token 调 /api/mail/contacts/suggest 补全
 * （自己的地址在前、已保存联系人其次、自动收录最后）。
 * 键盘：↓/↑ 移动，Enter/Tab 选中，Esc 关闭。
 */
export function RecipientInput({
  id,
  value,
  onValueChange,
  placeholder,
  own,
  className,
}: {
  id: string;
  value: string;
  onValueChange: (v: string) => void;
  placeholder?: string;
  /** 「我的账号」（4.10）：本地过滤、排在最前，且同样地址不再重复出现 */
  own?: MailOwnAddress[];
  /** 输入框样式透传（表单头行内用「无边框」覆写，见 compose-form 的 BARE_CONTROL） */
  className?: string;
}) {
  const t = useTranslations("mail");
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const fetchTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const blurTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const seq = useRef(0);

  const query = useCallback(
    (token: string) => {
      clearTimeout(fetchTimer.current);
      if (!token) {
        setSuggestions([]);
        setOpen(false);
        return;
      }
      // 自己的地址本地过滤（不走接口）：输入自己的地址是最常被漏掉的一种补全
      const needle = token.toLowerCase();
      const mine: Suggestion[] = (own ?? [])
        .filter(
          (o) => o.email.toLowerCase().includes(needle) || o.name.toLowerCase().includes(needle),
        )
        .map((o) => ({ name: o.name, email: o.email, kind: "own" as const }));
      const mineEmails = new Set((own ?? []).map((o) => o.email.toLowerCase()));

      fetchTimer.current = setTimeout(async () => {
        const mySeq = ++seq.current;
        try {
          const res = await fetch(`/api/mail/contacts/suggest?q=${encodeURIComponent(token)}`);
          if (!res.ok) return;
          const data = (await res.json()) as MailContactSuggest;
          if (mySeq !== seq.current) return; // 只采纳最后一次查询（防抖外的乱序保护）
          const items: Suggestion[] = [
            ...mine,
            ...data.contacts
              .filter((c) => !mineEmails.has(c.email.toLowerCase()))
              .map((c) => ({ name: c.name, email: c.email, kind: "contact" as const })),
            ...data.known
              .filter((k) => !mineEmails.has(k.email.toLowerCase()))
              .map((k) => ({ name: k.name, email: k.email, kind: "known" as const, times: k.times })),
          ];
          setSuggestions(items);
          setActive(items.length > 0 ? 0 : -1);
          setOpen(items.length > 0);
        } catch {
          // 网络失败：不弹建议，不打断输入
        }
      }, 200);
    },
    [own],
  );

  const pick = useCallback(
    (s: Suggestion) => {
      const { prefix } = currentToken(value);
      // 选中后补一个分隔符，方便继续输入下一个收件人
      onValueChange(`${prefix}${s.email}, `);
      setOpen(false);
      setSuggestions([]);
    },
    [value, onValueChange],
  );

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (!open || suggestions.length === 0) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActive((a) => (a + 1) % suggestions.length);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActive((a) => (a - 1 + suggestions.length) % suggestions.length);
      } else if (e.key === "Enter" || e.key === "Tab") {
        if (active >= 0) {
          e.preventDefault();
          pick(suggestions[active]);
        }
      } else if (e.key === "Escape") {
        setOpen(false);
      }
    },
    [open, suggestions, active, pick],
  );

  // 卸载时清掉挂起的防抖
  useEffect(
    () => () => {
      clearTimeout(fetchTimer.current);
      clearTimeout(blurTimer.current);
    },
    [],
  );

  return (
    <div className="relative">
      <Input
        id={id}
        value={value}
        placeholder={placeholder}
        autoComplete="off"
        role="combobox"
        aria-expanded={open}
        aria-controls={`${id}-suggestions`}
        aria-autocomplete="list"
        className={className}
        onChange={(e) => {
          onValueChange(e.target.value);
          query(currentToken(e.target.value).token);
        }}
        onKeyDown={onKeyDown}
        onFocus={() => query(currentToken(value).token)}
        onBlur={() => {
          // 延迟关闭：让 mousedown 先命中建议项
          blurTimer.current = setTimeout(() => setOpen(false), 150);
        }}
      />
      {open && (
        <ul
          id={`${id}-suggestions`}
          role="listbox"
          aria-label={t("contacts.suggestions")}
          className="absolute inset-x-0 top-full z-50 mt-1 overflow-hidden rounded-xl border border-border bg-popover shadow-md"
          data-slot="recipient-suggestions"
        >
          {suggestions.map((s, i) => (
            <li key={`${s.kind}:${s.email}`} role="option" aria-selected={i === active}>
              <button
                type="button"
                className={cn(
                  "flex w-full items-center gap-2 px-3 py-2 text-left text-sm",
                  i === active ? "bg-accent" : "hover:bg-accent/50",
                )}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(s);
                }}
                onMouseEnter={() => setActive(i)}
              >
                <BookUserIcon
                  className={cn(
                    "size-3.5 shrink-0",
                    s.kind === "own" ? "text-primary" : "text-muted-foreground",
                  )}
                  aria-hidden
                />
                <span className="min-w-0 flex-1 truncate">
                  {s.name ? `${s.name} ` : ""}
                  <span className="text-muted-foreground">{s.name ? `<${s.email}>` : s.email}</span>
                </span>
                {s.kind === "own" ? (
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {t("contacts.ownBadge")}
                  </span>
                ) : null}
                {s.kind === "known" && s.times ? (
                  <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                    {t("contacts.knownTimes", { count: s.times })}
                  </span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
