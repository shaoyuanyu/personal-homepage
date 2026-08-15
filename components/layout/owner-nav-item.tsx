"use client";

import { Fragment, useEffect, useState } from "react";
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
 * 登录态来源：挂载/路径变化时请求 /api/auth/me，并监听 owner-auth-changed
 * 事件（登录/登出后广播，登出时路径可能不变，仅靠 pathname 无法感知）。
 * 查询期间渲染同尺寸占位，避免导航栏布局跳动。
 */

export function OwnerNavItem({ className }: { className?: string }) {
  const t = useTranslations("nav");
  const pathname = usePathname();
  const router = useRouter();
  const [owner, setOwner] = useState<boolean | null>(null);

  // 重新查询登录态（事件触发或路径变化）
  useEffect(() => {
    let cancelled = false;
    let requestId = 0;
    const refresh = () => {
      // 保留上次已知登录态渲染，不先回退到占位：若每次路由切换都先
      // setOwner(null) 再异步恢复，导航项宽度会来回跳变（占位 116px
      // vs 实际按钮），nav 居中布局下所有链接随之横向抖动。登录/登出
      // 由事件驱动刷新，此时宽度变化属合理反馈。
      const id = ++requestId;
      fetch("/api/auth/me")
        .then((r) => r.json().catch(() => null))
        .then((data: { owner?: boolean } | null) => {
          if (!cancelled && id === requestId) setOwner(data?.owner === true);
        })
        .catch(() => {
          if (!cancelled && id === requestId) setOwner(false);
        });
    };

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
      className={className}
    >
      {t("nav")}
    </Button>
  );

  if (owner === null) {
    // 占位：覆盖四个按钮的总宽度，避免布局跳动
    return (
      <span aria-hidden className="flex items-center gap-1">
        <span className="size-9" />
        <span className="size-9" />
        <span className="size-9" />
        <span className="size-9" />
      </span>
    );
  }

  if (owner) {
    return (
      <Fragment>
        {/* 高频功能：单列入口（纯文字，与顶部其他导航项一致） */}
        <Button
          variant="ghost"
          size="sm"
          render={<Link href="/ideas" />}
          aria-label={t("ideas")}
          className={className}
        >
          {t("ideas")}
        </Button>

      {/* 我的日历：单列入口（主人专属，月视图展示 CalDAV 事件） */}
      <Button
        variant="ghost"
        size="sm"
        render={<Link href="/calendar" />}
        aria-label={t("calendar")}
        className={className}
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
              className={className}
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
      </Fragment>
    );
  }

  return (
    <Fragment>
      {navButton}
      <Button
        variant="ghost"
        size="sm"
        render={<Link href="/login" />}
        aria-label={t("login")}
        className={className}
      >
        {t("login")}
      </Button>
    </Fragment>
  );
}
