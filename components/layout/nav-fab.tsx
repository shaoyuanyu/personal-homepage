"use client";

import { useEffect, useRef } from "react";
import { CompassIcon } from "lucide-react";
import { useTranslations } from "next-intl";

import { Link, usePathname } from "@/lib/i18n/navigation";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * 导航悬浮球：除导航页外全站显示。
 * 固定在视口右下角（垂直位置不随页面内容高度变化），
 * 当页脚（版权/备案栏）滚入视口时自动上移避让，永不遮挡页脚。
 */
export function NavFab() {
  const t = useTranslations("navPage");
  const pathname = usePathname();
  const fabRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = fabRef.current;
    const footer = document.querySelector("footer");
    if (!el || !footer) return;

    const FAB_BOTTOM = 20; // 对应 bottom-5
    const GAP = 12; // 悬浮球与页脚保持的间距

    let raf = 0;
    const update = () => {
      raf = 0;
      const rect = footer.getBoundingClientRect();
      // 悬浮球底部需停在页脚顶部上方 GAP 处；页脚未进入视口时 offset 为 0（贴视口底部）
      const offset = Math.max(
        0,
        Math.min(window.innerHeight - rect.top - FAB_BOTTOM + GAP, window.innerHeight - 96),
      );
      el.style.transform = `translateY(${-offset}px)`;
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };

    update();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  // 导航页自身不显示悬浮球
  if (pathname === "/nav") {
    return null;
  }

  return (
    <div
      ref={fabRef}
      className="fixed right-5 bottom-5 z-40 transition-transform duration-200 ease-out sm:right-6 sm:bottom-6"
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <Link
              href="/nav"
              aria-label={t("fabLabel")}
              className="flex size-12 items-center justify-center rounded-full bg-gradient-to-br from-primary to-primary/85 text-primary-foreground shadow-lg shadow-primary/25 ring-1 ring-white/20 transition-all duration-200 hover:scale-105 hover:shadow-xl hover:shadow-primary/30 active:scale-95"
            />
          }
        >
          <CompassIcon className="size-5" />
        </TooltipTrigger>
        <TooltipContent side="left">{t("fabLabel")}</TooltipContent>
      </Tooltip>
    </div>
  );
}
