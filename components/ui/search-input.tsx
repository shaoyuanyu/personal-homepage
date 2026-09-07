import * as React from "react"
import { SearchIcon, XIcon } from "lucide-react"

import { cn } from "@/lib/utils"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"

/**
 * shadcn/ui 风格的搜索输入框：左侧放大镜图标 + 右侧「清除」按钮
 * （有内容时显示，点击后清空并自动聚焦回输入框）。
 *
 * 不用原生 `type="search"`：浏览器自绘的清除钮无法样式化、不随主题。
 * 用法与 Input 一致（placeholder / aria-label 等透传）。
 */
function SearchInput({
  className,
  value,
  onChange,
  clearLabel = "Clear",
  ...props
}: React.ComponentProps<"input"> & { clearLabel?: string }) {
  const inputRef = React.useRef<HTMLInputElement>(null)
  const showClear = typeof value === "string" && value.length > 0
  return (
    <div className={cn("relative", className)}>
      <SearchIcon
        data-icon="inline-start"
        aria-hidden
        className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted-foreground"
      />
      <Input
        ref={inputRef}
        type="text"
        value={value}
        onChange={onChange}
        className="pl-9 pr-9"
        {...props}
      />
      {showClear && (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={clearLabel}
          onClick={() => {
            // 受控组件：通过 onChange 同步清空，再聚焦回输入框
            inputRef.current?.focus()
            onChange?.({ target: { value: "" } } as React.ChangeEvent<HTMLInputElement>)
          }}
          className="absolute top-1/2 right-1 size-6 -translate-y-1/2 rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <XIcon aria-hidden />
        </Button>
      )}
    </div>
  )
}

export { SearchInput }
