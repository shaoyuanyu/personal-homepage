"use client";

import { useTranslations } from "next-intl";
import {
  CheckIcon,
  MailCheckIcon,
  MailOpenIcon,
  SquareCheckBigIcon,
  SquareXIcon,
  Trash2Icon,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

/**
 * 多选批量操作条（2026-10-07，MAIL-AGENT.md 4.16）：进入选择模式后在列表上方出现。
 *
 * 形态（2026-10-07 用户验收后重做，六条反馈里的 1/2/3/5/6 都落在这里）：
 * - 左栏内容宽只有 384px——动作**不能**平铺文字，一律图标 + `aria-label` / `title`。
 * - ⚠ **没有「退出」按钮**（2026-10-07 用户指定：它太突兀）。出口是隐式的：再点一次工具栏
 *   的「选择」按钮（它的可访问名在选中态变成「退出多选」）、点列表空白处、或按 Esc
 *   （见 MailClient 的 onListBlankClick / onListKeyDown）。
 * - ⚠ **没有「移动」**（用户指定）：文件夹视图删除后（见 4.15 一），站内看不到任何
 *   非默认文件夹，盲选一个目标搬过去、结果再也无从核对——这个动作失去了意义。
 *   整理动作只留本条的「删除」与详情页的「标为垃圾邮件」。
 * - 「全选」是**开关**（用户指定）：全选后再点一次 = 取消全选。图标随状态从 ☑ 变 ☒，
 *   `aria-pressed` 一并表状态——此前是全选后按钮直接 disabled，用户点了没反应。
 * - 两个标记动作的**可用性跟着选中项走**（用户指定）：选中的全都已读 → 「标为已读」禁用；
 *   全都未读 → 「标为未读」禁用；混合选中时两个都可用（点哪个都是有意义的批量动作）。
 *   判据由调用方算好传进来（`allSeen` / `allUnseen`，空选中时为 false）。
 * - 图标语义对齐既有约定：「全部标为已读」用 `MailCheckIcon`，故这里「标为已读」同图标；
 *   「标为未读」用 `MailOpenIcon`——与列表行内、详情页工具栏那枚「标为未读」完全一致
 *   （2026-10-07 用户指出此前两枚图标恰好装反了）。
 * - 选中计数做成 primary 色调的胶囊：它是这个模式的**状态**，比一行灰字更该被一眼看到；
 *   计数为 0 时退回中性灰，避免"还没选就先喊"。
 * - 批量标记走 webmaild 的 `POST /flags {messageIds}`（每账号一次连接、每文件夹一次
 *   STORE）；批量删除复用既有的 `POST /delete`（本来就是副本数组口径，多选正好用上）。
 */
export function MailBatchBar({
  count,
  total,
  busy,
  allSeen,
  allUnseen,
  onMarkSeen,
  onMarkUnseen,
  onDelete,
  onToggleAll,
}: {
  count: number;
  /** 当前列表已加载的封数（「全选」的范围） */
  total: number;
  busy: boolean;
  /** 选中的邮件**全部**已读（此时「标为已读」无事可做） */
  allSeen: boolean;
  /** 选中的邮件**全部**未读（此时「标为未读」无事可做） */
  allUnseen: boolean;
  onMarkSeen: () => void;
  onMarkUnseen: () => void;
  onDelete: () => void;
  /** 全选 / 取消全选（同一个按钮：已全选时再点即清空） */
  onToggleAll: () => void;
}) {
  const t = useTranslations("mail");
  const allSelected = total > 0 && count === total;

  return (
    <div
      data-slot="mail-batch-bar"
      className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border bg-muted/40 px-2 py-1.5"
    >
      <span
        data-slot="mail-batch-count"
        className={cn(
          "ml-0.5 rounded-full px-2 py-0.5 text-xs font-medium tabular-nums transition-colors",
          count > 0 ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground",
        )}
      >
        {t("batchSelected", { count })}
      </span>
      {/* 处理中：没有「退出」按钮之后，这里是 busy 唯一的落点（不要挪进胶囊里——
          胶囊宽度会随文字变，跳动比多一个 12px 圆环更显眼） */}
      {busy && <Spinner data-slot="mail-batch-spinner" />}
      <span className="h-4 w-px shrink-0 bg-border" aria-hidden />
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={allSelected ? t("batchClearAll") : t("batchSelectAll")}
        title={allSelected ? t("batchClearAll") : t("batchSelectAll")}
        aria-pressed={allSelected}
        disabled={busy || total === 0}
        onClick={onToggleAll}
        className="aria-pressed:bg-primary/10 aria-pressed:text-primary"
      >
        {allSelected ? <SquareXIcon /> : <SquareCheckBigIcon />}
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={t("markRead")}
        title={t("markRead")}
        disabled={busy || count === 0 || allSeen}
        onClick={onMarkSeen}
      >
        <MailCheckIcon />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={t("markUnread")}
        title={t("markUnread")}
        disabled={busy || count === 0 || allUnseen}
        onClick={onMarkUnseen}
      >
        <MailOpenIcon />
      </Button>
      {/* 破坏性动作单独一档配色（站内 destructive variant）：一眼看出它和其它三个不同 */}
      <Button
        variant="destructive"
        size="icon-sm"
        aria-label={t("delete")}
        title={t("delete")}
        disabled={busy || count === 0}
        onClick={onDelete}
      >
        <Trash2Icon />
      </Button>
    </div>
  );
}

/**
 * 选择模式下行首的复选框：**纯视觉**（`aria-hidden` + `pointer-events-none`）——
 * 勾选由整行按钮承担（触屏上点整行比点 16px 的方框可靠得多），`aria-pressed` 在按钮上，
 * 读屏与 E2E 都用它。
 *
 * ⚠ 2026-10-07 用户反馈「复选框有点丑」，故**不再用原生 `<input type=checkbox>`**：
 *   原生控件的外观由浏览器决定，`accent-color` 只能改选中的填充色，**方框的圆角、描边、
 *   勾形一律改不了**（16px 下就是一枚系统灰框）。这里按站内的勾选语言自绘：未选 = 1px
 *   描边方框（`border-input`），选中 = primary 实心 + 白色勾，尺寸与原来一致（size-4），
 *   行布局不变。
 */
export function MailRowCheckbox({ checked }: { checked: boolean }) {
  return (
    <span
      aria-hidden="true"
      data-slot="mail-row-checkbox"
      data-checked={checked ? "" : undefined}
      className={cn(
        "pointer-events-none grid size-4 shrink-0 place-items-center self-center rounded-[5px] border transition-colors",
        checked ? "border-primary bg-primary text-primary-foreground" : "border-input bg-background",
      )}
    >
      <CheckIcon
        className={cn("size-3 transition-opacity", checked ? "opacity-100" : "opacity-0")}
        strokeWidth={3.5}
      />
    </span>
  );
}
