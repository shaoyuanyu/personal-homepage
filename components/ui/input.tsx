import * as React from "react"
import { Input as InputPrimitive } from "@base-ui/react/input"

import { cn } from "@/lib/utils"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  // 输入框规范（2026-10-06 用户指定，勿改回）：① 边框 2px——1x 屏上 1px 圆角
  // 描边的弧线段抗锯齿后只剩约七成墨量、比直线浅；2px 是弧线满覆盖的最小整数档。
  // ② 聚焦 = 只加光晕（ring-2 ring-ring/40，同写邮件头部 BARE_CONTROL），不给
  // 边框换深色——深色描边会放大圆角弧线的问题，纯光晕观感更干净（详解见 CLAUDE.md）
  return (
    <InputPrimitive
      type={type}
      data-slot="input"
      className={cn(
        "h-8 w-full min-w-0 rounded-lg border-2 border-input bg-transparent px-2.5 py-1 text-base transition-colors outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/40 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30 dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
        className
      )}
      {...props}
    />
  )
}

export { Input }
