"use client";

import { CompassIcon } from "lucide-react";
import { useTranslations } from "next-intl";

import { Link, usePathname } from "@/lib/i18n/navigation";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

/**
 * 导航悬浮球：除导航页外全站右下角显示，点击跳转到学术导航页。
 */
export function NavFab() {
  const t = useTranslations("navPage");
  const pathname = usePathname();

  // 导航页自身不显示悬浮球
  if (pathname === "/nav") {
    return null;
  }

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger
          render={
            <Link
              href="/nav"
              aria-label={t("fabLabel")}
              className="fixed right-5 bottom-5 z-40 flex size-12 items-center justify-center rounded-full bg-gradient-to-br from-primary to-primary/85 text-primary-foreground shadow-lg shadow-primary/25 ring-1 ring-white/20 transition-all duration-200 hover:scale-105 hover:shadow-xl hover:shadow-primary/30 active:scale-95 sm:right-6 sm:bottom-6"
            />
          }
        >
          <CompassIcon className="size-5" />
        </TooltipTrigger>
        <TooltipContent side="left">{t("fabLabel")}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
