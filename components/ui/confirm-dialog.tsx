"use client";

import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";

/**
 * 站内统一的「破坏性操作」确认弹窗。
 *
 * ⚠ **勿改回 `window.confirm`**（曾用于删除速记、重置/清除 CalDAV 凭证共 3 处）：
 *   原生弹窗不随明暗主题、样式与站内完全脱节、移动端观感突兀，且**阻塞主线程**；
 *   与站内既有的「自绘确认」（`/calendar` 删除日程）也不一致。
 *
 * 用法（受控）：把「点击 → 弹窗 → 确认」拆成两段，确认后才真正执行。
 * 弹窗内容带 `data-slot="confirm-dialog"`，便于与页面主弹窗区分（同页可能同时存在）。
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel,
  destructive = true,
  pending = false,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** 确认按钮用「危险」色（删除类默认 true；非破坏性动作用 false） */
  destructive?: boolean;
  /** 执行中：禁用按钮并显示 spinner，避免重复提交 */
  pending?: boolean;
  onConfirm: () => void;
}) {
  const t = useTranslations("misc");
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // 执行中不允许关闭（避免「点了取消但请求已发出」的错觉）
        if (pending) return;
        onOpenChange(next);
      }}
    >
      <DialogContent data-slot="confirm-dialog" className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="leading-snug">{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <DialogFooter>
          <Button
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={() => onOpenChange(false)}
          >
            {cancelLabel ?? t("cancel")}
          </Button>
          <Button
            variant={destructive ? "destructive" : "default"}
            size="sm"
            disabled={pending}
            onClick={onConfirm}
          >
            {pending && <Spinner data-icon="inline-start" />}
            {confirmLabel ?? t("confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
