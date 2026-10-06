"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";

import { cn } from "@/lib/utils";
import { accountDotProps } from "@/components/mail/account-dot";
import { accountLabel } from "@/components/mail/account-label";
import { SyncStatusIndicator, type SyncStatus } from "@/components/mail/sync-status";
import type { MailAccount } from "@/lib/mail/types";

/**
 * 贯通底栏（MAIL-AGENT.md 5.5，2026-10-04 用户定稿「贯通」）。
 *
 * 底栏挂在 MailShell（面板边框之内、两栏网格之下），`border-t` 贯通整个面板宽度，
 * 与面板四边围成完整的客户端外框（macOS 邮件 / Outlook 的状态栏都是贯通式）；
 * 只放左半区时分隔线在中缝断掉、右栏下缘空着，像没画完。
 *
 * 三个区（只放有真实数据的东西，不凑数）：
 *   左 = 列表统计（已加载 / 未读）——列表的统计信息放在列表正下方，视觉上下对应
 *   中 = 账号指示（**只读**，2026-10-05 用户定稿）：选「全部账号」时列出正在合并哪些账号
 *        （色点 + 名称）；选具体账号时不显示（工具栏行 1 的账号下拉已表明当前账号）。
 *        **不再承担筛选功能**——筛选在工具栏的账号下拉里（底栏只负责「说明现状」）
 *   右 = 同步状态指示（圆点 + 上次抓取时间；异常时琥珀图标 + 第一条告警的完整文案）——
 *        全局服务健康，与列表无关，放最右；这里是状态**唯一**的显示位置
 *        （2026-10-04 用户指定：底栏已有状态条，不再另开一条顶部告警栏）
 *
 * 数据流：同步健康由 **MailShell** 调 `useSyncStatus()` 轮询后传入（status / rel）。
 * 列表统计 / 账号列表 / 当前筛选
 * 归 MailClient 所有，经 `usePublishMailBar()` 发布上来。两个 context 分开：
 * setter 稳定不变（MailClient 只写、不随 state 重渲染），state 只被底栏订阅
 * （列表每次加载都变，MailClient 若订阅会每次跟着重渲染）。
 */

/** 撰写页的草稿底栏状态：saved = 已落盘（浏览器本地）；error = 本地写入失败（隐私模式 / 配额满）。
 *  `at` = 该状态的发生时刻（saved 用「已保存于 X 秒/分钟前」展示，5s 一跳） */
export type MailDraftBarState = { status: "saved" | "error"; at: number };

/** 底栏发布的状态：列表统计 + 账号指示（只读；筛选在工具栏的账号下拉里） */
interface MailBarState {
  loading: boolean;
  loaded: number;
  unread: number;
  accounts: MailAccount[];
  /** "all" 或账号 id —— 仅用于判断是否显示账号指示（选具体账号时不显示） */
  accountFilter: string;
}

const MailBarStateContext = createContext<MailBarState | null>(null);
const MailBarSetterContext = createContext<((s: MailBarState) => void) | null>(null);
/** 撰写页发布槽：`null` = 不在撰写页；`{ draft }` = 在撰写页（draft 为 null 表示暂无状态） */
const MailBarDraftContext = createContext<{ draft: MailDraftBarState | null } | null>(null);
const MailBarDraftSetterContext = createContext<
  ((d: { draft: MailDraftBarState | null } | null) => void) | null
>(null);

export function MailBarProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<MailBarState | null>(null);
  const [draftBar, setDraftBar] = useState<{ draft: MailDraftBarState | null } | null>(null);
  return (
    <MailBarSetterContext.Provider value={setState}>
      <MailBarStateContext.Provider value={state}>
        <MailBarDraftSetterContext.Provider value={setDraftBar}>
          <MailBarDraftContext.Provider value={draftBar}>{children}</MailBarDraftContext.Provider>
        </MailBarDraftSetterContext.Provider>
      </MailBarStateContext.Provider>
    </MailBarSetterContext.Provider>
  );
}

/** MailClient 把列表统计与账号筛选状态发布到底栏（两者同挂 layout，导航不丢） */
export function usePublishMailBar(state: MailBarState) {
  const setState = useContext(MailBarSetterContext);
  const { loading, loaded, unread, accounts, accountFilter } = state;
  useEffect(() => {
    setState?.({ loading, loaded, unread, accounts, accountFilter });
  }, [setState, loading, loaded, unread, accounts, accountFilter]);
}

/**
 * 撰写页（ComposeForm）发布草稿状态：挂载即标记「正在撰写」（底栏左区换成草稿状态、
 * 中区账号指示隐藏）；卸载自动清除（底栏还原成列表统计）。
 * ⚠ 与 MailClient 的发布走**两个独立 context**，互不覆盖——MailClient 保持挂载期间
 * 仍持有它的统计（卸载草稿槽不会让统计消失）。
 */
export function usePublishDraftBar(draft: MailDraftBarState | null) {
  const setDraftBar = useContext(MailBarDraftSetterContext);
  useEffect(() => {
    setDraftBar?.({ draft });
  }, [setDraftBar, draft]);
  useEffect(() => () => setDraftBar?.(null), [setDraftBar]);
}

/** 每 5 秒一跳的「当前时刻」（草稿相对时间的刷新节拍；未激活时不挂定时器） */
function useNowTick(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

/**
 * 贯通底栏。⚠ 高度预算：底栏是网格下方的 `shrink-0` 行，
 * 列表滚动区让出这一行，面板总高不变（E2E「面板高度」锁定）。
 * ⚠ 窄屏详情视图下整个隐藏（外壳传入 className）：手机端没有常驻状态栏的位置。
 */
export function MailStatusbar({
  status,
  rel,
  className,
}: {
  status: SyncStatus;
  rel: (iso: string) => string;
  className?: string;
}) {
  const t = useTranslations("mail");
  const state = useContext(MailBarStateContext);
  const draftBar = useContext(MailBarDraftContext);
  /** 撰写路由（底栏左区换成草稿状态、中区账号指示隐藏） */
  const composing = draftBar !== null;
  // 草稿相对时间：只在显示 saved 时挂 5s 节拍；超 1 小时不再往上一档（「分钟」封顶 59，
  // 否则会出现「已保存于 300 分钟前」这种数字）
  const draft = draftBar?.draft ?? null;
  const now = useNowTick(draft?.status === "saved");
  let draftSavedText = "";
  if (draft?.status === "saved") {
    const sec = Math.max(0, Math.floor((now - draft.at) / 1000));
    draftSavedText =
      sec < 60
        ? t("draftSavedAgoSeconds", { count: sec })
        : sec < 3600
          ? t("draftSavedAgoMinutes", { count: Math.floor(sec / 60) })
          : t("draftSavedAgoHours", { count: Math.floor(sec / 3600) });
  }
  return (
    <div className={className}>
      <div
        data-slot="mail-statusbar"
        className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-t border-border py-2 text-xs text-muted-foreground lg:px-4"
      >
        {/* 左区：列表统计（仅非撰写路由；撰写页左栏是联系人面板，与列表统计无关） */}
        {!composing &&
          state && (
            /* ⚠ 加载中统计必须**占位**而非卸载（invisible，不是条件渲染）：底栏 chips 是
               `flex-1` 居中，左侧统计一旦从布局中消失，整组 chips 会被重新居中、左右横跳
               ——2026-10-05 用户报「点 tab/开关时「全部账号」闪烁抖动」，实测 x 在 90~209 间振荡 */
            <span
              data-slot="mail-list-stats"
              className={cn("tabular-nums", state.loading && "invisible")}
            >
              {t("listStats", { loaded: state.loaded, unread: state.unread })}
            </span>
          )}
        {/* 账号指示（只读，2026-10-05 用户定稿）：选「全部账号」时列出在合并哪些账号；
            选具体账号时不显示（工具栏下拉已表明当前账号）。不承担筛选。
            ⚠ 必须 `flex-1 justify-center` 居中（2026-10-05 用户反馈）：紧跟统计后面
            会读成「已加载 5 封 · 未读 0 ● 我 · 工作」一整句，与邮件数量分不清 */}
        {!composing && state && state.accounts.length > 0 && state.accountFilter === "all" && (
          <span
            data-slot="mail-statusbar-accounts"
            aria-label={t("accountsOverviewLabel")}
            title={state.accounts.map(accountLabel).join("、")}
            className="hidden min-w-0 flex-1 items-center justify-center gap-1.5 overflow-hidden whitespace-nowrap min-[40rem]:flex"
          >
            {state.accounts.map((a, i) => {
              const d = accountDotProps(a.color);
              return (
                <span key={a.id} className="flex min-w-0 items-center gap-1">
                  {i > 0 && <span aria-hidden>·</span>}
                  <span className={cn("size-2 shrink-0 rounded-full", d.className)} style={d.style} aria-hidden />
                  <span className="max-w-40 truncate">{a.displayName}</span>
                </span>
              );
            })}
          </span>
        )}
        {/* 联系人颜色图例（2026-10-06 用户需求）：撰写路由（左栏是联系人面板）时中区
            改为「颜色 → 归属」图例——面板里每个联系人名字后的色点对应这些账号
            （灰点 = 本地联系人），与 /mail 列表行的账号点列同一套颜色逻辑 */}
        {composing && state && state.accounts.length > 0 && (
          <span
            data-slot="mail-contacts-legend"
            aria-label={t("contactsPane.legendLabel")}
            className="hidden min-w-0 flex-1 items-center justify-center gap-1.5 overflow-hidden whitespace-nowrap min-[40rem]:flex"
          >
            {state.accounts.map((a, i) => {
              const d = accountDotProps(a.color);
              return (
                <span key={a.id} className="flex min-w-0 items-center gap-1">
                  {i > 0 && <span aria-hidden>·</span>}
                  <span className={cn("size-2 shrink-0 rounded-full", d.className)} style={d.style} aria-hidden />
                  <span className="max-w-40 truncate">{a.displayName}</span>
                </span>
              );
            })}
            <span className="flex min-w-0 items-center gap-1">
              <span aria-hidden>·</span>
              <span className="size-2 shrink-0 rounded-full bg-muted-foreground" aria-hidden />
              <span className="max-w-40 truncate">{t("contactsPane.filterLocal")}</span>
            </span>
          </span>
        )}
        {/* 右区（2026-10-06 用户定稿）：撰写页 = 草稿状态（右下角）——「上次收到新邮件」
            在写邮件时不显示（关心的是草稿，不是收信健康）；其余路由 = 同步状态指示。
            草稿状态带相对时间（「草稿自动保存于 X 秒/分钟前」，5s 一跳）——只显示
            「已保存」读不出发酵了多久，刚存完与存完一小时长得一样 */}
        {composing ? (
          draftBar.draft && (
            <span
              data-slot="mail-draft-status"
              className="ml-auto flex items-center gap-1.5"
              title={draftBar.draft.status === "error" ? t("draftSaveFailedHint") : undefined}
            >
              <span
                className={cn(
                  "size-2 shrink-0 rounded-full",
                  draftBar.draft.status === "error"
                    ? "bg-amber-600 dark:bg-amber-400"
                    : "bg-emerald-600 dark:bg-emerald-400",
                )}
                aria-hidden
              />
              {draftBar.draft.status === "error" ? t("draftSaveFailed") : draftSavedText}
            </span>
          )
        ) : (
          <SyncStatusIndicator status={status} rel={rel} className="ml-auto" />
        )}
      </div>
    </div>
  );
}
