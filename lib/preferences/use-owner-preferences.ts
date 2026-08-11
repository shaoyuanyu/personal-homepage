"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { OWNER_AUTH_CHANGED_EVENT } from "@/lib/auth/events";
import {
  PREFERENCE_KEYS,
  sanitizePreference,
} from "@/lib/preferences/registry";

export type OwnerPreferences = Record<string, unknown>;

/**
 * 主人偏好 hook：登录时偏好存服务器（跨设备同步），游客回退 localStorage。
 *
 * 约定（新功能接入方式）：
 * 1. 在 lib/preferences/registry.ts 注册 key + sanitize 函数；
 * 2. 本 hook 内部以 key 为 localStorage 键名（与既有 ccf:filters 一致）；
 * 3. 登录后若服务器缺失某 key 而 localStorage 有，自动迁移一次并上传。
 *
 * 返回：
 * - ready：登录态与偏好已加载完成（恢复 UI 状态前应等待）
 * - isOwner：当前是否登录
 * - prefs：全部已知偏好（owner 来自服务器 / 游客来自 localStorage）
 * - setPref(key, value)：更新偏好（owner 防抖 PATCH 服务器，游客写 localStorage）
 *
 * 限制：单用户低并发；owner 会话内不轮询，跨设备需刷新页面感知。
 */
export function useOwnerPreferences() {
  const [ready, setReady] = useState(false);
  const [isOwner, setIsOwner] = useState(false);
  const [prefs, setPrefs] = useState<OwnerPreferences>({});
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 加载偏好：挂载 + 登录态变化（登录/登出）时重新加载
  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      setReady(false);

      // 1. 确认登录态
      let owner = false;
      try {
        const r = await fetch("/api/auth/me");
        const data = (await r.json().catch(() => null)) as
          | { owner?: boolean }
          | null;
        owner = data?.owner === true;
      } catch {
        // 网络异常按游客处理
      }
      if (cancelled) return;
      setIsOwner(owner);

      if (owner) {
        // 2a. 主人：从服务器加载；同时把 localStorage 里服务器缺失的
        //     已知偏好迁移上传一次（游客期间的选择登录后不丢）
        let server: OwnerPreferences = {};
        try {
          const r = await fetch("/api/preferences");
          const data = (await r.json().catch(() => null)) as
            | { preferences?: OwnerPreferences }
            | null;
          if (cancelled) return;
          server = data?.preferences ?? {};
        } catch {
          // 网络异常：按无服务器偏好处理（后续写入仍会尝试）
        }
        if (cancelled) return;
        setPrefs(server);

        const migration: OwnerPreferences = {};
        for (const key of Object.values(PREFERENCE_KEYS)) {
          if (server[key] !== undefined) continue;
          const local = readLocal(key);
          if (local !== null) {
            const clean = sanitizePreference(key, local);
            if (clean !== null) migration[key] = clean;
          }
        }
        if (Object.keys(migration).length > 0) {
          try {
            const r = await fetch("/api/preferences", {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(migration),
            });
            const data = (await r.json().catch(() => null)) as
              | { preferences?: OwnerPreferences }
              | null;
            if (!cancelled && data?.preferences) setPrefs(data.preferences);
          } catch {
            // 迁移失败不阻塞：服务器下次写入时自然带上
          }
        }
      } else {
        // 2b. 游客：从 localStorage 恢复全部已知偏好（结构清洗后）
        const local: OwnerPreferences = {};
        for (const key of Object.values(PREFERENCE_KEYS)) {
          const raw = readLocal(key);
          if (raw !== null) {
            const clean = sanitizePreference(key, raw);
            if (clean !== null) local[key] = clean;
          }
        }
        if (!cancelled) setPrefs(local);
      }
      if (!cancelled) setReady(true);
    };

    load();
    window.addEventListener(OWNER_AUTH_CHANGED_EVENT, load);
    return () => {
      cancelled = true;
      window.removeEventListener(OWNER_AUTH_CHANGED_EVENT, load);
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, []);

  /** 更新偏好：立即生效（乐观更新）；owner 防抖 500ms 提交服务器 */
  const setPref = useCallback(
    (key: string, value: unknown) => {
      const clean = sanitizePreference(key, value);
      if (clean === null) return; // 结构非法：静默丢弃
      setPrefs((prev) => ({ ...prev, [key]: clean }));

      if (isOwner) {
        if (saveTimer.current) clearTimeout(saveTimer.current);
        saveTimer.current = setTimeout(() => {
          fetch("/api/preferences", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ [key]: clean }),
          })
            .then((r) => r.json().catch(() => null))
            .then((data: { preferences?: OwnerPreferences } | null) => {
              if (data?.preferences) setPrefs(data.preferences);
            })
            .catch(() => {
              // 网络失败静默：下次改动会重试；刷新后从服务器读回旧值
            });
        }, 500);
      } else {
        writeLocal(key, clean);
      }
    },
    [isOwner],
  );

  return { ready, isOwner, prefs, setPref };
}

function readLocal(key: string): unknown | null {
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? null : (JSON.parse(raw) as unknown);
  } catch {
    return null; // 隐私模式 / 数据损坏
  }
}

function writeLocal(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // 写入失败静默（隐私模式等）
  }
}
