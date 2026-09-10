"use client";

import { Fragment, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import {
  ChevronDownIcon,
  CompassIcon,
  LogInIcon,
  LogOutIcon,
  UserRoundIcon,
} from "lucide-react";

import { Link, usePathname, useRouter } from "@/lib/i18n/navigation";
import { OWNER_AUTH_CHANGED_EVENT } from "@/lib/auth/events";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/**
 * 顶部导航右侧区块（登录态感知），拆为两个组件：
 * - OwnerNavItem（渲染在 <nav> 内）：「导航」链接（带地图图标 + 左侧分隔
 *   竖线，与功能导航区分隔）——游客/登录布局下内容相同，直接渲染；
 *   「速记」「日历」为主人专属单列入口（owner-only span，仅登录态显示）。
 * - OwnerAccountItem（渲染在右侧工具栏，贴深色模式切换左侧）：游客「登录」
 *   按钮（LogInIcon）/ 登录态「我的空间」菜单（UserRoundIcon，仅权限类操作，
 *   如退出登录；后续网站管理/权限管理等放此处）。移动端工具栏隐藏该区，
 *   入口由移动端 Sheet 内的同名组件提供。
 *
 * 双布局机制（刷新零跳变的关键）：
 * - 游客布局与登录布局在 SSR 都渲染（结构固定 → 无 hydration mismatch），
 *   可见性由 CSS 类控制（.guest-only/.owner-only，见 globals.css），
 *   display:none 的布局不占宽，故首帧宽度即最终宽度；
 * - app/layout.tsx 的内联 script 在首帧 paint 前读 localStorage 设置
 *   <html>.owner-logged-in，登录用户刷新时首帧即登录布局，无需等待网络往返；
 * - OwnerNavItem 挂载后同步 html class 与缓存（读缓存恢复、/api/auth/me
 *   后台校验、owner-auth-changed 事件驱动），保证与服务器状态一致
 *   （会话过期/跨设备时以服务器为准）；OwnerAccountItem 的可见性同样由
 *   html class 驱动，登出时调用共享的 syncOwnerClass。
 */

// 登录态缓存（与 app/layout.tsx 内联 script 共用键名）与 html class 名
const OWNER_CACHE_KEY = "owner:auth";
const OWNER_CLASS = "owner-logged-in";

// 同步 html class（与 CSS 可见性规则联动；OwnerNavItem 后台校验与
// OwnerAccountItem 登出共用）
function syncOwnerClass(next: boolean) {
  document.documentElement.classList.toggle(OWNER_CLASS, next);
}

export function OwnerNavItem({ className }: { className?: string }) {
  const t = useTranslations("nav");
  const pathname = usePathname();

  // 挂载/路径变化时：恢复缓存登录态 → 后台校验 → 订阅登录/登出事件
  useEffect(() => {
    let cancelled = false;
    let requestId = 0;

    // 1. 同步恢复上次登录态（与首帧内联 script 同源，正常情况下无变化）
    try {
      const v = window.localStorage.getItem(OWNER_CACHE_KEY);
      if (v === "1") syncOwnerClass(true);
      else if (v === "0") syncOwnerClass(false);
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
            syncOwnerClass(next);
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

  // 分隔竖线 + 间距：把「导航」与左侧功能导航区（博客/日历）分隔。
  // 仅在桌面内联导航（≥lg，见 site-header.tsx）中显示；移动端 Sheet 与
  // 中宽度汉堡菜单中均隐藏（纵向列表无需分隔）。
  const sep = (
    <span aria-hidden="true" className="mx-1.5 hidden h-4 w-px bg-border/60 lg:block" />
  );

  return (
    <Fragment>
      {/* 速记/日历：主人专属单列入口（owner-only，SSR 渲染；游客时
          display:none 不占宽，登录态由 html.owner-logged-in 控制） */}
      <span className={`owner-only ${className ?? ""}`}>
        <Link
          href="/ideas"
          data-slot="button"
          aria-label={t("ideas")}
          className={buttonVariants({ variant: "ghost", size: "sm" })}
        >
          {t("ideas")}
        </Link>

        <Link
          href="/calendar"
          data-slot="button"
          aria-label={t("calendar")}
          className={buttonVariants({ variant: "ghost", size: "sm" })}
        >
          {t("calendar")}
        </Link>
      </span>

      {sep}

      {/* 「导航」：游客/登录布局内容相同，直接渲染（带地图图标，与普通
          纯文字导航项区分——游客最需要的功能入口） */}
      <Link
        href="/nav"
        data-slot="button"
        aria-label={t("nav")}
        className={buttonVariants({
          variant: "ghost",
          size: "sm",
          className: className ?? undefined,
        })}
      >
        <CompassIcon data-icon="default" />
        {t("nav")}
      </Link>
    </Fragment>
  );
}

/** 右侧工具栏账号区：游客「登录」/ 登录态「我的空间」菜单（贴深色模式切换
 *  左侧；移动端工具栏隐藏，入口由移动端 Sheet 内的同名组件提供）。
 *  mobile 模式（移动端 Sheet 内）：登录态为可展开的「我的」——点击后内联
 *  展开子项列表（非浮动气泡，符合移动端惯例），便于后续继续追加子项。 */
export function OwnerAccountItem({
  className,
  mobile = false,
}: {
  className?: string
  mobile?: boolean
}) {
  const t = useTranslations("nav");
  const router = useRouter();
  const [open, setOpen] = useState(false);

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
    syncOwnerClass(false);
    window.dispatchEvent(new Event(OWNER_AUTH_CHANGED_EVENT));
    router.push("/");
    router.refresh();
  }

  return (
    <Fragment>
      {/* 游客：登录（guest-only；登录态时 display:none 不占宽） */}
      <span className={`guest-only ${className ?? ""}`}>
        <Link
          href="/login"
          data-slot="button"
          aria-label={t("login")}
          className={buttonVariants({ variant: "ghost", size: "sm" })}
        >
          <LogInIcon data-icon="default" />
          {t("login")}
        </Link>
      </span>

      {/* 登录态：我的空间（owner-only；仅权限类操作入口） */}
      <span className={`owner-only ${className ?? ""}`}>
        {mobile ? (
          /* 移动端：点击「我的」内联展开子项（不用下拉气泡） */
          <>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setOpen((v) => !v)}
              aria-label={t("owner")}
              aria-expanded={open}
            >
              <UserRoundIcon data-icon="default" />
              {t("owner")}
              <ChevronDownIcon
                data-icon="default"
                className={`transition-transform duration-200 ${open ? "rotate-180" : ""}`}
              />
            </Button>
            {open && (
              <Button
                variant="destructive"
                size="sm"
                onClick={() => void handleLogout()}
                aria-label={t("logout")}
                className="animate-in fade-in slide-in-from-top-1 duration-150"
              >
                <LogOutIcon data-icon="default" />
                {t("logout")}
              </Button>
            )}
          </>
        ) : (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={t("owner")}
                >
                  <UserRoundIcon data-icon="default" />
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
        )}
      </span>
    </Fragment>
  );
}
