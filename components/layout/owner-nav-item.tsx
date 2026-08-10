"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import {
  BookmarkIcon,
  KeyRoundIcon,
  LogOutIcon,
  UserRoundIcon,
} from "lucide-react";

import { Link, usePathname, useRouter } from "@/lib/i18n/navigation";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/**
 * 导航管理员入口：
 * - 游客：显示「登录」按钮（指向 /login）
 * - 已登录：显示「管理员」菜单（想法速记 / 退出登录）
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
    // 占位：与按钮同尺寸，避免布局跳动
    return <span aria-hidden className="size-9" />;
  }

  if (owner) {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="sm"
              aria-label={t("owner")}
              className={className}
            >
              <UserRoundIcon data-icon="default" />
              {t("owner")}
            </Button>
          }
        />
        <DropdownMenuContent align="end">
          <DropdownMenuItem render={<Link href="/admin/ideas" />}>
            <BookmarkIcon data-icon="default" />
            {t("ideas")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onClick={() => void handleLogout()}>
            <LogOutIcon data-icon="default" />
            {t("logout")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
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
      <KeyRoundIcon data-icon="default" />
      {t("login")}
    </Button>
  );
}
