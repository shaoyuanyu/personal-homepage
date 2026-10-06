"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { BookUserIcon, CheckIcon, MailsIcon, PlusIcon, SearchIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { Link } from "@/lib/i18n/navigation";
import { useOwnAddresses } from "@/lib/mail/use-own-addresses";
import { AccountMenu } from "@/components/mail/account-menu";
import { accountDotProps } from "@/components/mail/account-dot";
import { MOTION_SIZE } from "@/components/mail/motion";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { SearchInput } from "@/components/ui/search-input";
import { Spinner } from "@/components/ui/spinner";
import type { MailAccount, MailContact, MailKnownSender } from "@/lib/mail/types";

/** 「本地联系人」筛选项的保留值（`@` 不在账号 id 字符集 `[a-z0-9-]` 里，不会与账号相撞） */
const LOCAL_FILTER = "@local";

/** 头像首字母（与通讯录页同口径：有名字取名字首字，否则取邮箱首字母） */
function avatarLetter(name: string, email: string): string {
  const n = name.trim();
  if (n) return n.slice(0, 1).toUpperCase();
  return (email.trim()[0] ?? "?").toUpperCase();
}

/**
 * 左栏联系人面板（4.14；只在 `/mail/compose` 路由显示，占用邮件列表那条左栏）。
 *
 * 写信时最需要的是「找人」——把联系人放在手边，点一下加入收件人（跨组件通过
 * `mail:add-recipient` 事件通知 ComposeForm；站内已有的跨树广播模式）。
 *
 * 数据 = 两个已存在的接口：已保存联系人（/contacts）+ 自动收录的往来对象（/contacts/known）。
 * **筛选与搜索都在前端做**（数据量小：最多几百人），切档位零延迟，也不给后端加参数面。
 *
 * 筛选档位（4.14 用户定稿的归属模型）：
 * - 「全部联系人」：两者都显示；
 * - 「本地联系人」：只显示不归属任何账号的（手动保存的默认归属）；
 * - 「账号 X」：已保存中归属为 X 的 + 往来中与 X 出现过的人（known 的 accounts 含 X）。
 *
 * ⚠ 视觉语言与通讯录页一致：已保存 = 实线卡片 + 实心头像；未保存的往来对象 =
 *   虚线边框 + 淡底 + 虚线轮廓头像（「临时 / 尚未收录」）。
 */
export function MailContactsPane() {
  const t = useTranslations("mail");
  const [accounts, setAccounts] = useState<MailAccount[]>([]);
  const [contacts, setContacts] = useState<MailContact[] | null>(null);
  const [known, setKnown] = useState<MailKnownSender[] | null>(null);
  const [filter, setFilter] = useState<string>("all");
  const [q, setQ] = useState("");
  /** 搜索展开态（与邮箱状态同一套交互：常态图标、点击展开、Esc / 失焦且为空收起） */
  const [searchOpen, setSearchOpen] = useState(false);
  /** 最近一次「加入收件人」的邮箱（行内 ✓ 反馈，1.6s 后自动消退） */
  const [added, setAdded] = useState<string | null>(null);
  // 自己的地址不属于「联系人」（4.10 既定规则：只出现在「我的账号」里）——
  // 通讯录页同样过滤；ready 之前不过滤（数据还在加载），避免闪动
  const { ready: ownReady, emails: ownEmails } = useOwnAddresses();

  useEffect(() => {
    fetch("/api/mail/accounts")
      .then((r) => (r.ok ? r.json() : []))
      .then((d: MailAccount[]) => setAccounts(d))
      .catch(() => {});
    fetch("/api/mail/contacts")
      .then((r) => (r.ok ? r.json() : { items: [] }))
      .then((d: { items: MailContact[] }) => setContacts(d.items))
      .catch(() => setContacts([]));
    fetch("/api/mail/contacts/known?limit=200")
      .then((r) => (r.ok ? r.json() : { items: [] }))
      .then((d: { items: MailKnownSender[] }) => setKnown(d.items))
      .catch(() => setKnown([]));
  }, []);

  useEffect(() => {
    if (added === null) return;
    const timer = setTimeout(() => setAdded(null), 1600);
    return () => clearTimeout(timer);
  }, [added]);

  const visibleContacts = useMemo(() => {
    const kw = q.trim().toLowerCase();
    return (contacts ?? []).filter((c) => {
      if (ownReady && ownEmails.has(c.email.toLowerCase())) return false;
      const accts = c.account ? [c.account] : [];
      const inFilter =
        filter === "all" ||
        (filter === LOCAL_FILTER ? accts.length === 0 : accts.includes(filter));
      const hit = !kw || c.name.toLowerCase().includes(kw) || c.email.toLowerCase().includes(kw);
      return inFilter && hit;
    });
  }, [contacts, filter, q, ownReady, ownEmails]);

  const visibleKnown = useMemo(() => {
    const kw = q.trim().toLowerCase();
    return (known ?? []).filter((k) => {
      if (ownReady && ownEmails.has(k.email.toLowerCase())) return false;
      const inFilter =
        filter === "all" ||
        (filter === LOCAL_FILTER ? k.accounts.length === 0 : k.accounts.includes(filter));
      const hit = !kw || k.name.toLowerCase().includes(kw) || k.email.toLowerCase().includes(kw);
      return inFilter && hit;
    });
  }, [known, filter, q, ownReady, ownEmails]);

  /** 收起搜索：清空关键词（列表恢复全量；否则收起后列表仍被过滤着，看不出原因）。
   *  只对「空内容失焦 / Esc」生效——点列表项造成的失焦不关（q 非空时保持），
   *  可以连续点搜索结果里的多个人。 */
  const closeSearch = () => {
    setSearchOpen(false);
    setQ("");
  };

  /** 展开时聚焦输入框（SearchInput 不支持透传 inputRef，从它的 wrapper 里找） */
  const searchWrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (searchOpen) searchWrapRef.current?.querySelector("input")?.focus();
  }, [searchOpen]);

  /** 加入收件人：只广播意图，去重由 ComposeForm 负责（它才持有收件人状态） */
  const addRecipient = (email: string) => {
    window.dispatchEvent(new CustomEvent<string>("mail:add-recipient", { detail: email }));
    setAdded(email);
  };

  const loading = contacts === null && known === null;
  /** 「全部联系人 (n)」的 n = 联系人总数（已保存 + 往来，剔除自己）；
   *  不随搜索/档位变化（那是筛选结果数，不是总量） */
  const totalCount = useMemo(() => {
    const isOwn = (email: string) => ownReady && ownEmails.has(email.toLowerCase());
    return (
      (contacts ?? []).filter((c) => !isOwn(c.email)).length +
      (known ?? []).filter((k) => !isOwn(k.email)).length
    );
  }, [contacts, known, ownReady, ownEmails]);
  const listEmpty = visibleContacts.length === 0 && visibleKnown.length === 0;

  /** 账号 id → 色点（联系人行与底栏图例共用「邮箱列表同一套颜色逻辑」） */
  const colorOf = (accountId: string) => accounts.find((a) => a.id === accountId)?.color ?? "";
  const nameOf = (accountId: string) =>
    accounts.find((a) => a.id === accountId)?.displayName ?? accountId;

  return (
    <div className="flex flex-col gap-4 lg:min-h-0 lg:flex-1">
      {/* 工具栏：档位筛选 + 搜索 + 返回邮箱（与邮件左栏行 1 同一水平线、同一套形态） */}
      <div className="flex shrink-0 items-center gap-1.5">
        {/* 筛选器 = 邮件左栏的账号选择器本体（AccountMenu，2026-10-05 用户定稿「直接复用」）：
            同款两行/单行触发器、搜索展开时同款收窄联动；差异只有文案（全部账号 → 全部联系人）
            与额外一档「本地联系人」（extraItems）。
            ⚠ maxW 按行宽算：384（行宽）− 40（搜索图标 28 + gaps 12）− 86（「返回邮箱」完整态）。
            ⚠ collapsedNameMaxPx=96：「全部联系人」「我的联系人」「Agent的联系人」
            在收窄态（12px）都要能完整显示（默认的 4 字上限会截断；96 下搜索框展开
            仍有 ≈248px，验证过）。
            ⚠ accountName：「我」→「我的联系人」（用户 2026-10-05 反馈：写邮件页选账号档时
            显示账号本名会让人以为在筛邮件，加「的联系人」后功能自明）。 */}
        <AccountMenu
          accounts={accounts}
          value={filter}
          onChange={setFilter}
          collapsed={searchOpen}
          maxW={258}
          allLabel={t("contactsPane.filterAll")}
          extraItems={[{ value: LOCAL_FILTER, label: t("contactsPane.filterLocal") }]}
          collapsedNameMaxPx={96}
          countOverride={totalCount}
          accountName={(a) => t("contactsPane.accountFilter", { name: a.displayName || a.email })}
        />
        {/* 搜索区（2026-10-05 用户定稿：与邮箱状态同一套伸缩交互）——常态是一个图标
            按钮，点击向左展开为输入框；Esc / 失焦且为空收起。
            展开的「伸缩」与邮箱状态同构（三件套同曲线联动，见 MOTION_SIZE）：筛选器收窄
            （AccountMenu collapsed）+ 输入框自身从右向左生长（w-7 ↔ w-full）。
            ⚠ 常挂载（不用条件渲染）：宽度过渡需要起止两帧都在 DOM 里。 */}
        <div className="relative flex min-h-7 min-w-0 flex-1 items-center justify-end">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setSearchOpen(true)}
            aria-label={t("search")}
            title={t("search")}
            inert={searchOpen ? true : undefined}
            className={cn(
              "absolute inset-y-0 right-0 my-auto transition-opacity",
              MOTION_SIZE,
              searchOpen ? "pointer-events-none opacity-0" : "opacity-100",
            )}
          >
            <SearchIcon data-icon="default" />
          </Button>
          <div
            ref={searchWrapRef}
            className={cn(
              "relative transition-[width,opacity]",
              MOTION_SIZE,
              searchOpen ? "w-full opacity-100" : "pointer-events-none w-7 opacity-0",
            )}
          >
            <SearchInput
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") closeSearch();
              }}
              onBlur={() => {
                if (!q.trim()) closeSearch();
              }}
              placeholder={t("contactsPane.searchPlaceholder")}
              clearLabel={t("clearSearch")}
              aria-label={t("contactsPane.searchPlaceholder")}
              tabIndex={searchOpen ? undefined : -1}
              className="w-full"
            />
          </div>
        </div>
        {/* 「返回邮箱」：回到邮箱视图（收件箱 / 发件箱）。位置 = 原「写邮件」按钮在邮箱
            状态的位置（行 1 最右端），两态对称；搜索展开时同「写邮件」一样缩为图标
            （搜索框才是主角），动效同源（gap + 文字轨道 + 透明度）。
            图标 = Mails（多封信，表示收件箱 + 发件箱的全景；2026-10-05 用户从候选中选定，
            替换了邮筒与返回箭头两版）。
            窄屏下左栏整体隐藏，出口在撰写表单顶部（lg:hidden 的「返回邮件」）。 */}
        <Link
          href="/mail"
          data-slot="button"
          title={searchOpen ? t("backToMailbox") : undefined}
          className={cn(
            buttonVariants({ size: "sm" }),
            "shrink-0 gap-1 px-1.5 transition-[gap]",
            MOTION_SIZE,
            searchOpen && "gap-0",
          )}
        >
          <MailsIcon data-icon="default" />
          <span
            data-slot="mailbox-label"
            className={cn(
              "grid transition-[grid-template-columns]",
              MOTION_SIZE,
              searchOpen ? "grid-cols-[0fr]" : "grid-cols-[1fr]",
            )}
          >
            <span
              className={cn(
                "overflow-hidden whitespace-nowrap transition-opacity",
                MOTION_SIZE,
                searchOpen ? "opacity-0" : "opacity-100",
              )}
            >
              {t("backToMailbox")}
            </span>
          </span>
        </Link>
      </div>

      {/* 列表滚动区（与邮件列表同一条高度链：工具栏固定、列表滚动） */}
      <div className="flex min-h-0 flex-col lg:flex-1 lg:overflow-y-auto" data-slot="contacts-pane-scroll">
        {loading ? (
          <p className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
            <Spinner label={t("loading")} />
            {t("loading")}
          </p>
        ) : listEmpty ? (
          <Empty>
            <EmptyMedia variant="icon">
              <BookUserIcon aria-hidden />
            </EmptyMedia>
            <EmptyHeader>
              <EmptyTitle>{t("contactsPane.empty")}</EmptyTitle>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="flex flex-col gap-4">
            {visibleContacts.length > 0 && (
              <ul
                className="divide-y divide-border rounded-xl border border-border"
                data-slot="contacts-pane-list"
              >
                {visibleContacts.map((c) => (
                  <ContactRow
                    key={c.id}
                    name={c.name}
                    email={c.email}
                    added={added === c.email}
                    onAdd={addRecipient}
                    dots={
                      c.account
                        ? [{ key: c.account, color: colorOf(c.account), title: nameOf(c.account) }]
                        : [{ key: "@local", color: "", title: t("contactsPane.filterLocal") }]
                    }
                  />
                ))}
              </ul>
            )}
            {visibleKnown.length > 0 && (
              <ul
                className="divide-y divide-border rounded-xl border border-dashed border-border bg-muted/30"
                data-slot="contacts-pane-known"
              >
                {visibleKnown.map((k) => (
                  <ContactRow
                    key={k.email}
                    name={k.name}
                    email={k.email}
                    dashed
                    added={added === k.email}
                    onAdd={addRecipient}
                    dots={(k.accounts ?? []).map((id) => ({
                      key: id,
                      color: colorOf(id),
                      title: nameOf(id),
                    }))}
                  />
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** 联系人归属色点数据：账号 = 账号色；本地联系人 = 空色（accountDotProps 回退中性灰） */
interface ContactDot {
  key: string;
  /** 空串 = 本地联系人（灰点） */
  color: string;
  /** 悬浮提示（账号名 / 「本地联系人」） */
  title: string;
}

/** 联系人行：整行可点 = 加入收件人；行尾 hover 显示「+」，点击后短暂显示 ✓；
 *  名字后带归属账号色点（与 /mail 列表行的账号点列同一套颜色逻辑，2026-10-06） */
function ContactRow({
  name,
  email,
  dashed,
  added,
  onAdd,
  dots,
}: {
  name: string;
  email: string;
  dashed?: boolean;
  added: boolean;
  onAdd: (email: string) => void;
  dots: ContactDot[];
}) {
  const t = useTranslations("mail");
  return (
    <li>
      <button
        type="button"
        onClick={() => onAdd(email)}
        title={added ? t("contactsPane.added") : t("contactsPane.add")}
        className="group/row flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-accent/50 focus-visible:bg-accent/50 focus-visible:outline-none"
      >
        <Avatar
          className={cn(
            "size-8 shrink-0",
            dashed && "[&::after]:border-dashed [&::after]:border-muted-foreground/40",
          )}
        >
          <AvatarFallback className={cn("text-xs", dashed && "bg-transparent")}>
            {avatarLetter(name, email)}
          </AvatarFallback>
        </Avatar>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="truncate text-sm">{name || email}</span>
            {dots.length > 0 && (
              <span
                data-slot="contact-account-dots"
                className="flex shrink-0 items-center gap-0.5"
                title={dots.map((d) => d.title).join("、")}
              >
                {dots.map((d) => {
                  const dot = accountDotProps(d.color);
                  return (
                    <span
                      key={d.key}
                      className={cn("inline-block size-2 rounded-full", dot.className)}
                      style={dot.style}
                    />
                  );
                })}
              </span>
            )}
          </span>
          {name && <span className="block truncate text-xs text-muted-foreground">{email}</span>}
        </span>
        <span className="shrink-0 text-muted-foreground" aria-hidden>
          {added ? (
            <CheckIcon className="size-4 text-emerald-600 dark:text-emerald-400" />
          ) : (
            <PlusIcon className="size-4 opacity-0 transition-opacity group-hover/row:opacity-100 group-focus-visible/row:opacity-100" />
          )}
        </span>
      </button>
    </li>
  );
}
