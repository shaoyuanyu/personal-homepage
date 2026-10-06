"use client";

import type { ReactNode } from "react";

import { cn } from "@/lib/utils";
import { usePathname } from "@/lib/i18n/navigation";
import { MailClient } from "@/components/mail/mail-client";
import { MailContactsPane } from "@/components/mail/mail-contacts-pane";
import { MailBarProvider, MailStatusbar } from "@/components/mail/mail-statusbar";
import { useSyncStatus } from "@/components/mail/sync-status";

/**
 * 信箱两栏外壳（MAIL-AGENT.md 4.12）。
 *
 * - **≥lg**：左右两栏收进**同一个带边框的面板**（中缝 `border-l` 分隔），像真正的
 *   邮件客户端；左「列表」固定 26rem + 右「详情」自适应。grid 默认 `align-items: stretch`，
 *   两栏同高——左列表再长，右栏的 sticky 容器也有行程可走，于是能「边翻列表边看信」。
 *   右栏自带 `overflow-y-auto`：长邮件在右栏内部滚动，不影响左侧列表位置。
 * - **<lg**：不套面板（单列卡片列表 + 整页详情 / 撰写），只显示当前路由该显示的那一栏，
 *   列表 ⇄ 子页面整页切换，与手机邮件客户端一致。
 *
 * ⚠ 面板模式下列表自己的卡片边框被摘掉（`lg:border-0`，见 MailClient），由外壳统一描边；
 *   两栏各自带内边距（lg:p-4 / lg:p-6），内容不碰面板边缘，故**无需 overflow-hidden**——
 *   那会把右栏的 sticky 圈进不滚动的裁剪盒里，「边翻列表边看信」立刻失效。
 * ⚠ 用 `hidden lg:flex` 而非条件渲染：SSR 与首帧结构固定，无 hydration 跳变；
 *   两栏都在 DOM 里，客户端导航时 layout 不会重新挂载，列表的
 *   滚动位置 / 已加载分页 / 筛选 / 搜索词全部保留（这正是列表挂在 layout 上的原因）。
 * ⚠ 宽屏下外壳由页面锁死高度（4.12），故两栏都改成「撑满 + 内部滚动」：
 *   左栏滚动区在 MailClient 内部（工具栏固定、列表滚动），右栏自带 `overflow-y-auto`。
 *   旧的 `sticky` 方案是给「页面会滚动」准备的，页面不再滚动后它已无意义。
 * ⚠ 行模板用 `minmax(0,1fr)` 而非默认 `auto`：auto 行会被内容顶高（长列表/长邮件
 *   又把外壳撑出可视区），`minmax(0,1fr)` 把行高钉死为容器高，超出的部分交给内部滚动。
 * ⚠ 贯通底栏（5.5）：面板边框移到了外层包裹 div（网格不再自己描边），底栏是网格
 *   下方的 `shrink-0` 行、`border-t` 贯通整个面板宽度——列表滚动区让出这一行，
 *   面板总高不变（E2E「面板高度」锁定）。窄屏详情视图下底栏整体隐藏（与右栏同规则）。
 * ⚠ `useSyncStatus()` 提到这里调用（唯一轮询点），status/rel 下传底栏——两处各调
 *   一次会变成双份定时器 + 双份请求。状态**只在底栏显示**（2026-10-04 用户指定：
 *   底栏已经是状态条，不再在面板顶部另开一条告警栏）。
 */
export function MailShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  // 「右栏子页面」= 详情（/mail/message/:id）与撰写（/mail/compose）：桌面端显示在右栏，
  // 窄屏整页占满（列表隐藏）；其余路由（/mail）只显示列表栏。
  const isSubpage =
    pathname.startsWith("/mail/message/") || pathname.startsWith("/mail/compose");
  // 撰写路由：左栏换成联系人面板（4.14）
  const isCompose = pathname.startsWith("/mail/compose");
  // 邮件详情路由（窄屏整页详情、底栏没有位置）
  const isMessage = pathname.startsWith("/mail/message/");
  const { status, rel } = useSyncStatus();

  return (
    <MailBarProvider>
      <div className="flex flex-col gap-4 lg:min-h-0 lg:flex-1">
        <div className="flex min-w-0 flex-col gap-4 lg:min-h-0 lg:flex-1 lg:gap-0 lg:rounded-xl lg:border lg:border-border">
          <div className="grid gap-6 lg:min-h-0 lg:flex-1 lg:grid-cols-[26rem_minmax(0,1fr)] lg:grid-rows-[minmax(0,1fr)] lg:gap-0">
      <div
        data-slot="mail-pane-list"
        className={cn(
          "min-w-0 lg:flex lg:min-h-0 lg:flex-col lg:p-4",
          isSubpage && "hidden lg:flex",
        )}
      >
        {/* 邮件列表：撰写路由下让位给联系人面板（4.14），但**保持挂载**（display:none）——
            滚动位置 / 筛选 / 搜索词都留着，写完回来不用重来。
            ⚠ compose 时整个包装 div 用 `hidden`：它没有 lg:flex，任何宽度都不显示。 */}
        <div className={cn(isCompose ? "hidden" : "lg:flex lg:min-h-0 lg:flex-1 lg:flex-col")}>
          <MailClient />
        </div>
        {isCompose && <MailContactsPane />}
      </div>
      <div
        data-slot="mail-pane-detail"
        className={cn(
          "min-w-0 lg:flex lg:min-h-0 lg:flex-col lg:border-l lg:border-border",
          !isSubpage && "hidden lg:flex",
        )}
      >
        {/* ⚠ 垂直内边距与左栏一致（py-4）：两栏首行（筛选组 / 操作栏）同一水平线 */}
        <div className="min-w-0 lg:flex lg:min-h-0 lg:flex-1 lg:flex-col lg:overflow-y-auto lg:px-6 lg:py-4">
          {children}
        </div>
      </div>
          </div>
          {/* 底栏显示规则（2026-10-05 定稿）：邮件详情（窄屏整页）隐藏；/mail 与撰写页都显示
              ——撰写页的底栏承载草稿状态（已自动保存 / 保存失败），见 MailStatusbar 与 ComposeForm */}
          <MailStatusbar status={status} rel={rel} className={isMessage ? "hidden lg:block" : undefined} />
        </div>
      </div>
    </MailBarProvider>
  );
}
