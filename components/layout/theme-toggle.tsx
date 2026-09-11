"use client";

import { useEffect, useState } from "react";
import { CheckIcon, MoonIcon, SunIcon, SunMoonIcon } from "lucide-react";
import { useTheme } from "next-themes";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/**
 * 「所选设置」→ `<html>` 标记类（`[data-theme-icon]` 的可见性开关，见 globals.css）。
 *
 * ⚠ 触发按钮显示的是**所选设置**而非当前生效主题：next-themes 只把解析后的主题
 * 写成 `.dark`（选「跟随系统」时 DOM 里没有「system」这个值），故必须自己标记。
 * 首帧由 app/layout.tsx 的内联 script 在 paint 前设置（零跳变）；下方的 effect
 * 兜住其余情况——内联 script 被 CSP 拦下、其他标签页改了设置等。
 */
const THEME_MARKER: Record<string, string> = {
  light: "theme-light",
  dark: "theme-dark",
  system: "theme-system",
};

const themeOptions = [
  { value: "light", icon: SunIcon },
  { value: "dark", icon: MoonIcon },
  // 「跟随系统」用半日半夜图标（SunMoon）：比显示器图标（= 设备）直观
  { value: "system", icon: SunMoonIcon },
] as const;

export function ThemeToggle() {
  const t = useTranslations("theme");
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  // 标记类与 next-themes 的设置值保持同步（setTheme → theme 变化 → 此处生效）
  useEffect(() => {
    const marker = theme ? THEME_MARKER[theme] : undefined;
    if (!marker) return;
    const root = document.documentElement;
    root.classList.remove(...Object.values(THEME_MARKER));
    root.classList.add(marker);
  }, [theme]);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="ghost" size="icon-sm" aria-label={t("label")}>
            {/* 三个图标都渲染，由 html 标记类择一显示（见 globals.css）：
                纯 CSS 切换 → 无 hydration mismatch、无首帧闪烁，
                且同一时刻只有一个图标占位，按钮宽度恒定。 */}
            <span className="theme-icon" data-theme-icon="light">
              <SunIcon data-icon="default" />
            </span>
            <span className="theme-icon" data-theme-icon="dark">
              <MoonIcon data-icon="default" />
            </span>
            <span className="theme-icon" data-theme-icon="system">
              <SunMoonIcon data-icon="default" />
            </span>
          </Button>
        }
      />
      <DropdownMenuContent align="end">
        {themeOptions.map(({ value, icon: Icon }) => {
          const active = mounted && theme === value;
          return (
            <DropdownMenuItem
              key={value}
              className={active ? "bg-accent text-accent-foreground" : undefined}
              onClick={() => setTheme(value)}
            >
              <Icon data-icon="default" />
              {t(value)}
              {active && <CheckIcon data-icon="default" className="ml-auto" />}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
