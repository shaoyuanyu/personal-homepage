"use client";

import { Fragment, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { LogOutIcon } from "lucide-react";

import { Link, usePathname, useRouter } from "@/lib/i18n/navigation";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/**
 * 导航管理员入口：
 * - 游客：显示「登录」按钮（指向 /login）
 * - 已登录：显示「速记」单列入口 +「我的空间」菜单（仅权限类操作，
 *   如退出登录；后续网站管理/权限管理等放此处，勿放功能入口）
 * 登录态来源：挂载/路径变化时请求 /api/auth/me，并监听 owner-auth-changed
 * 事件（登录/登出后广播，登出时路径可能不变，仅靠 pathname 无法感知）。
 * 查询期间渲染同尺寸占位，避免导航栏布局跳动。
 */
export const OWNER_AUTH_CHANGED_EVENT = "owner-auth-changed";

export function OwnerNavItem({ className }: { className?: string }) {
  const t = useTranslations("nav");
  const pathname = usePathname();
  const router = useRouter();
  const [owner, setOwner] = useState<boolean | null>(null);

  // 重新查询登录态（事件触发或路径变化）
  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      setOwner(null); // 先回到占位态，再重新查询
      fetch("/api/auth/me")
        .then((r) => r.json().catch(() => null))
        .then((data: { owner?: boolean } | null) => {
          if (!cancelled) setOwner(data?.owner === true);
        })
        .catch(() => {
          if (!cancelled) setOwner(false);
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

  if (owner === null) {
    // 占位：覆盖两个按钮的总宽度，避免布局跳动
    return (
      <span aria-hidden className="flex items-center gap-1">
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
    <Button
      variant="ghost"
      size="sm"
      render={<Link href="/login" />}
      aria-label={t("login")}
      className={className}
    >
      {t("login")}
    </Button>
  );
}
