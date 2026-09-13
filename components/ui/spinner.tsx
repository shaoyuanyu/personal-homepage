import { cn } from "@/lib/utils"
import { Loader2Icon } from "lucide-react"

/**
 * 加载指示器。
 *
 * ⚠ **`label` 省略时按「纯装饰」处理（`aria-hidden`）**：多数场景下 spinner
 *   旁边已经有文字（按钮上的「保存中…」、列表的「正在读取日程…」），再报一个
 *   “Loading” 只是噪音；而**单独出现**时它必须能发音——且必须是**当前语言**
 *   （曾硬编码英文 `aria-label="Loading"`，中文站上读屏会念英文）。
 */
function Spinner({
  className,
  label,
  ...props
}: React.ComponentProps<"svg"> & { label?: string }) {
  const shared = {
    "data-slot": "spinner",
    className: cn("size-4 animate-spin", className),
    ...props,
  }
  if (label) {
    return <Loader2Icon role="status" aria-label={label} {...shared} />
  }
  return <Loader2Icon aria-hidden="true" {...shared} />
}

export { Spinner }
