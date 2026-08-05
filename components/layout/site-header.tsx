import { useTranslations } from "next-intl";
import { MenuIcon } from "lucide-react";

import { Link } from "@/lib/i18n/navigation";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import { LocaleSwitcher } from "@/components/layout/locale-switcher";

/* Y-Fork 图标：与浏览器标签页 favicon（app/icon.svg）保持同一图形 */
function YForkIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="size-4 shrink-0">
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

const navItems = [
  { href: "/", key: "home" },
  { href: "/publications", key: "publications" },
  { href: "/talks", key: "talks" },
  { href: "/projects", key: "projects" },
  { href: "/blog", key: "blog" },
  { href: "/nav", key: "nav" },
] as const;

export function SiteHeader() {
  const t = useTranslations("nav");
  const s = useTranslations("site");

  return (
    <header className="sticky top-0 z-40 w-full border-b bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="mx-auto flex h-14 max-w-5xl items-center justify-between gap-4 px-4 sm:px-6">
        {/* Logo：Y-Fork 图标 + 标语 */}
        <Link
          href="/"
          className="flex items-center gap-1.5 font-mono text-sm font-semibold tracking-tight"
        >
          <YForkIcon />
          {s("tagline")}
        </Link>

        {/* Desktop nav */}
        <nav className="hidden items-center gap-1 md:flex">
          {navItems.map((item) => (
            <Button key={item.key} variant="ghost" size="sm" render={<Link href={item.href} />}>
              {t(item.key)}
            </Button>
          ))}
        </nav>

        <div className="flex items-center gap-1">
          <ThemeToggle />
          <LocaleSwitcher />
          {/* Mobile nav */}
          <Sheet>
            <SheetTrigger
              render={<Button variant="ghost" size="icon-sm" className="md:hidden" aria-label={t("menu")} />}
            >
              <MenuIcon data-icon="default" />
            </SheetTrigger>
            <SheetContent side="right" className="w-64">
              <SheetTitle className="sr-only">{t("menu")}</SheetTitle>
              <nav className="flex flex-col gap-1 pt-4">
                {navItems.map((item) => (
                  <Button key={item.key} variant="ghost" size="sm" className="justify-start" render={<Link href={item.href} />}>
                    {t(item.key)}
                  </Button>
                ))}
              </nav>
            </SheetContent>
          </Sheet>
        </div>
      </div>
    </header>
  );
}
