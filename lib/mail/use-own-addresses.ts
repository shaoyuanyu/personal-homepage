"use client";

import { useEffect, useMemo, useState } from "react";

import type { MailOwnAddress } from "@/lib/mail/types";

/** 两套注册表条目共有的字段（webmail 是 displayName，maild 也是 displayName） */
interface RawAddress {
  id?: string;
  displayName?: string;
  email?: string;
  enabled?: boolean;
}

/**
 * 归一化：webmaild 的 `/accounts` 返回裸数组，maild 的 `/agent/accounts` 返回
 * `{ items }`——两种形状都收；缺地址或 `enabled: false` 的丢掉。
 */
function normalize(data: unknown, kind: MailOwnAddress["kind"]): MailOwnAddress[] {
  const raw = Array.isArray(data) ? data : (data as { items?: unknown } | null)?.items;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((r): r is RawAddress => !!r && typeof r === "object")
    .filter((r) => typeof r.email === "string" && r.email.includes("@") && r.enabled !== false)
    .map((r) => ({
      id: typeof r.id === "string" && r.id ? r.id : r.email!,
      name: typeof r.displayName === "string" ? r.displayName : "",
      email: r.email!,
      kind,
    }));
}

/**
 * 站主自己的全部收发地址 = webmail 账号注册表 + agent 信箱（MAIL-AGENT.md 4.10）。
 * 通讯录「我的账号」与写信页的收件人补全共用。
 *
 * - **去重按地址小写**：同一地址在两套注册表里都出现时保留 webmail 那条（能发信），
 *   顺序为「webmail 账号（注册表顺序）→ agent」。
 * - ⚠ agent 那条走 `/api/mail/agent/accounts`（maild 的只读视图）。**maild 没起时
 *   静默降级成「只有 webmail 账号」**——不报错、不阻塞，与顶部栏未读徽点同一处理方式。
 */
export function useOwnAddresses(): {
  ready: boolean;
  own: MailOwnAddress[];
  emails: Set<string>;
} {
  const [own, setOwn] = useState<MailOwnAddress[]>([]);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const get = (path: string) =>
      fetch(path)
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null);
    void Promise.all([get("/api/mail/accounts"), get("/api/mail/agent/accounts")]).then(
      ([mine, agent]) => {
        if (cancelled) return;
        const seen = new Set<string>();
        const merged: MailOwnAddress[] = [];
        for (const a of [...normalize(mine, "account"), ...normalize(agent, "agent")]) {
          const key = a.email.toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);
          merged.push(a);
        }
        setOwn(merged);
        setReady(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const emails = useMemo(() => new Set(own.map((o) => o.email.toLowerCase())), [own]);
  return { ready, own, emails };
}
