"use client";

import { Fragment, useEffect } from "react";
import { useTranslations } from "next-intl";
import { LogOutIcon } from "lucide-react";

import { Link, usePathname, useRouter } from "@/lib/i18n/navigation";
import { OWNER_AUTH_CHANGED_EVENT } from "@/lib/auth/events";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/**
 * 导航栏右侧区块（登录态感知）：
 * - 游客：显示「导航」+「登录」按钮（指向 /login）
 * - 已登录：显示「速记」单列入口 +「日历」单列入口 +「导航」+「我的空间」
 *   菜单（仅权限类操作，如退出登录；后续网站管理/权限管理等放此处）
 * 其中「导航」由本组件统一渲染，保证无论是否登录都紧跟最右侧入口
 * （我的/登录）左侧，即固定在从右往左第二个位置。
 *
 * 双布局机制（刷新零跳变的关键）：
 * - 游客布局与登录布局在 SSR 都渲染（结构固定 → 无 hydration mismatch），
 *   可见性由 CSS 类控制（.guest-only/.owner-only，见 globals.css），
 *   display:none 的布局不占宽，故首帧宽度即最终宽度；
 * - app/layout.tsx 的内联 script 在首帧 paint 前读 localStorage 设置
 *   <html>.owner-logged-in，登录用户刷新时首帧即登录布局，无需等待网络往返；
 * - 本组件只负责挂载后同步 html class 与缓存（读缓存恢复、/api/auth/me
 *   后台校验、owner-auth-changed 事件驱动），保证与服务器状态一致
 *   （会话过期/跨设备时以服务器为准）。
 */

// 登录态缓存（与 app/layout.tsx 内联 script 共用键名）与 html class 名
const OWNER_CACHE_KEY = "owner:auth";
const OWNER_CLASS = "owner-logged-in";

export function OwnerNavItem({ className }: { className?: string }) {
  const t = useTranslations("nav");
  const pathname = usePathname();
  const router = useRouter();

  // 同步 html class（与 CSS 可见性规则联动）
  function syncClass(next: boolean) {
    document.documentElement.classList.toggle(OWNER_CLASS, next);
  }

  // 挂载/路径变化时：恢复缓存登录态 → 后台校验 → 订阅登录/登出事件
  useEffect(() => {
    let cancelled = false;
    let requestId = 0;

    // 1. 同步恢复上次登录态（与首帧内联 script 同源，正常情况下无变化）
    try {
      const v = window.localStorage.getItem(OWNER_CACHE_KEY);
      if (v === "1") syncClass(true);
      else if (v === "0") syncClass(false);
    } catch {
      // localStorage 不可用（隐私模式等），跳过缓存恢复
    }

    const refresh = () => {
      // 保留当前可见布局，后台静默刷新：结果与缓存一致时无任何视觉变化。
      // 登录/登出由事件驱动刷新，此时布局切换属合理反馈。
      const id = ++requestId;
      fetch("/api/auth/me")
        .then((r) => r.json().catch(() => null))
        .then((data: { owner?: boolean } | null) => {
          if (!cancelled && id === requestId) {
            const next = data?.owner === true;
            syncClass(next);
            try {
              window.localStorage.setItem(OWNER_CACHE_KEY, next ? "1" : "0");
            } catch {
              // 忽略缓存写入失败
            }
          }
        })
        .catch(() => {
          // 网络异常：保持当前布局，不写缓存（避免覆盖可能有效的登录缓存）
        });
    };

    // 2. 后台校验并订阅登录/登出事件
    refresh();
    window.addEventListener(OWNER_AUTH_CHANGED_EVENT, refresh);
    return () => {
      cancelled = true;
      window.removeEventListener(OWNER_AUTH_CHANGED_EVENT, refresh);
    };
  }, [pathname]);

  async function handleLogout() {
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } catch {
      // 网络异常也照常跳转（会话可能已过期）
    }
    try {
      window.localStorage.removeItem(OWNER_CACHE_KEY);
    } catch {
      // 忽略
    }
    syncClass(false);
    window.dispatchEvent(new Event(OWNER_AUTH_CHANGED_EVENT));
    router.push("/");
    router.refresh();
  }

  // 「导航」链接：始终紧跟最右侧入口（我的/登录）左侧（从右往左第二个）
  const navButton = (
    <Button
      variant="ghost"
      size="sm"
      render={<Link href="/nav" />}
      aria-label={t("nav")}
    >
      {t("nav")}
    </Button>
  );

  // 游客布局：导航 + 登录（SSR 渲染，默认可见；className 供移动端 Sheet 传 w-full）
  const guestLayout = (
    <span className={`guest-only ${className ?? ""}`}>
      {navButton}
      <Button
        variant="ghost"
        size="sm"
        render={<Link href="/login" />}
        aria-label={t("login")}
      >
        {t("login")}
      </Button>
    </span>
  );

  // 登录布局：速记 + 日历 + 导航 + 我的（SSR 渲染，html.owner-logged-in 时可见）
  const ownerLayout = (
    <span className={`owner-only ${className ?? ""}`}>
      {/* 高频功能：单列入口（纯文字，与顶部其他导航项一致） */}
      <Button
        variant="ghost"
        size="sm"
        render={<Link href="/ideas" />}
        aria-label={t("ideas")}
      >
        {t("ideas")}
      </Button>

      {/* 我的日历：单列入口（主人专属，月视图展示 CalDAV 事件） */}
      <Button
        variant="ghost"
        size="sm"
        render={<Link href="/calendar" />}
        aria-label={t("calendar")}
      >
        {t("calendar")}
      </Button>

      {navButton}

      {/* 我的空间：仅权限类操作 */}
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="sm"
              aria-label={t("owner")}
            >
              {t("owner")}
            </Button>
          }
        />
        <DropdownMenuContent align="end">
          {/* 预留：网站管理、权限管理等权限类操作入口 */}
          <DropdownMenuItem variant="destructive" onClick={() => void handleLogout()}>
            <LogOutIcon data-icon="default" />
            {t("logout")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  );

  return (
    <Fragment>
      {guestLayout}
      {ownerLayout}
    </Fragment>
  );
}
