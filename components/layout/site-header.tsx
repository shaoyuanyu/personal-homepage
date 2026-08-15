import { useTranslations } from "next-intl";
import { MenuIcon } from "lucide-react";

import { Link } from "@/lib/i18n/navigation";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import { LocaleSwitcher } from "@/components/layout/locale-switcher";
import {
  OwnerAccountItem,
  OwnerNavItem,
} from "@/components/layout/owner-nav-item";

/* Y-Fork 图标：与浏览器标签页 favicon（app/icon.svg）保持同一图形 */
function YForkIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="size-5 shrink-0">
      <g
        fill="none"
        stroke="currentColor"
        strokeWidth="4.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M5 4.5 12 12l7-7.5" />
        <path d="M12 12v8.5" />
      </g>
    </svg>
  );
}

// 注意：「导航」不在数组中——由 OwnerNavItem 统一渲染（带地图图标 + 左侧
// 分隔线），位于 nav 内最右侧；「登录/我的」账号区由 OwnerAccountItem 渲染
// 在右侧工具栏（贴深色模式切换左侧，移动端由 Sheet 提供入口）。
const navItems = [
  { href: "/", key: "home" },
  { href: "/publications", key: "publications" },
  { href: "/talks", key: "talks" },
  { href: "/projects", key: "projects" },
  { href: "/blog", key: "blog" },
] as const;

export function SiteHeader() {
  const t = useTranslations("nav");

  return (
    <header className="sticky top-0 z-40 w-full border-b bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="mx-auto flex h-14 max-w-5xl items-center justify-between gap-4 px-4 sm:px-6">
        {/* Logo：Y-Fork 图标 + 域名（品牌标识，不分语言） */}
        <Link
          href="/"
          className="flex items-center gap-1.5 font-mono text-sm font-semibold tracking-tight"
        >
          <YForkIcon />
          shaoyuanyu.cn
        </Link>

        {/* Desktop nav */}
        <nav className="hidden items-center gap-1 md:flex">
          {navItems.map((item) => (
            <Button key={item.key} variant="ghost" size="sm" render={<Link href={item.href} />}>
              {t(item.key)}
            </Button>
          ))}
          <OwnerNavItem />
        </nav>

        <div className="flex items-center gap-1">
          {/* 账号区（登录/我的）：桌面显示、贴深色模式切换左侧；
              移动端隐藏——入口由下方移动端 Sheet 内的同名组件提供 */}
          <div className="hidden md:block">
            <OwnerAccountItem />
          </div>
          <ThemeToggle />
          <LocaleSwitcher />
          {/* Mobile nav */}
          <Sheet>
            <SheetTrigger
              render={<Button variant="ghost" size="icon-sm" className="md:hidden" aria-label={t("menu")} />}
            >
              <MenuIcon data-icon="default" />
            </SheetTrigger>
            <SheetContent side="right" className="w-72">
              <SheetTitle className="sr-only">{t("menu")}</SheetTitle>
              {/* sheet-nav：移动端触控适配（字号放大、全宽行），见 globals.css */}
              <nav className="sheet-nav flex flex-col gap-1 pt-4">
                {navItems.map((item) => (
                  <Button key={item.key} variant="ghost" size="sm" className="justify-start" render={<Link href={item.href} />}>
                    {t(item.key)}
                  </Button>
                ))}
                {/* sheet-stack：双布局 span 在 Sheet 内改为纵向堆叠全宽；
                    mobile：移动端「我的」点击后内联展开子项（如退出登录），
                    不用下拉气泡 */}
                <OwnerNavItem className="sheet-stack" />
                <OwnerAccountItem className="sheet-stack" mobile />
              </nav>
            </SheetContent>
          </Sheet>
        </div>
      </div>
    </header>
  );
}
