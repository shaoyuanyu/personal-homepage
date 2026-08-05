"use client";

import { useEffect, useState } from "react";
import { CheckIcon, MonitorIcon, MoonIcon, SunIcon } from "lucide-react";
import { useTheme } from "next-themes";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const themeOptions = [
  { value: "light", icon: SunIcon },
  { value: "dark", icon: MoonIcon },
  { value: "system", icon: MonitorIcon },
] as const;

export function ThemeToggle() {
  const t = useTranslations("theme");
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="ghost" size="icon-sm" aria-label={t("label")}>
            {/* 用 CSS 类跟随已解析主题，避免 hydration 闪烁 */}
            <SunIcon data-icon="default" className="dark:hidden" />
            <MoonIcon data-icon="default" className="hidden dark:block" />
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
