"use client";

import { useEffect } from "react";

import { TooltipProvider } from "@/components/ui/tooltip";
import { ThemeProvider } from "@/components/layout/theme-provider";
import { ToastProvider, ToastViewport } from "@/components/ui/toast";

/**
 * 应用根部的客户端 Providers（挂在 `app/[locale]/layout.tsx` 内）。
 *
 * ⚠ `<html data-hydrated="true">` 是给 E2E 的**机器可校验就绪信号**，勿删：
 * SSR 出的 HTML 在 `domcontentloaded` 时已完整可见，但此刻 React 合成事件尚未
 * 挂载——此时 click / fill 会被**静默丢弃**（不报错、无 console 警告，Playwright
 * 的 click 本身还会正常返回），后续断言就变得莫名其妙。
 * 本机（离 VPS 近）hydration 约在 DCL 后 ~100ms 完成，恰好盖住这个窗口，测试
 * 侥幸全过；CI runner 在海外、站点在国内 VPS，JS chunk 晚到数秒，首个交互必丢
 * （曾致 CD Smoke Test 3 条用例红：语言切换菜单、/venues 搜索 ×2）。
 * Providers 是 hydration 提交中最外层的客户端组件，effect 在已 hydration 的子
 * 组件之后执行，故属性置位即代表整棵树可交互。
 *
 * 局限：只在**整页加载**时置位；客户端路由跳转后的新树不会重新置位（同一页面内
 * 仍是 SPA，交互能力本就在，故无需重置）。
 */
export function Providers({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    document.documentElement.dataset.hydrated = "true";
  }, []);

  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      <TooltipProvider>
        <ToastProvider>
          {children}
          <ToastViewport />
        </ToastProvider>
      </TooltipProvider>
    </ThemeProvider>
  );
}
