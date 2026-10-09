"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { useLocale, useTranslations } from "next-intl";
import {
  ArrowDownLeftIcon,
  ArrowLeftRightIcon,
  ArrowUpRightIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  FilePenLineIcon,
  InboxIcon,
  MailCheckIcon,
  MailIcon,
  MailOpenIcon,
  PaperclipIcon,
  RefreshCwIcon,
  SearchIcon,
  SquareCheckBigIcon,
  SquarePenIcon,
  StarIcon,
  Trash2Icon,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { Link, usePathname, useRouter } from "@/lib/i18n/navigation";
import { encodeMessageId, MAIL_LIST_ORDER_KEY } from "@/lib/mail/id";
import { isSentItem } from "@/lib/mail/kind";
import { mailNavOptions } from "@/lib/mail/nav";
import { useOwnAddresses } from "@/lib/mail/use-own-addresses";
import { MAIL_ACCOUNTS_CHANGED_EVENT } from "@/components/mail/accounts-dialog";
import { MAIL_DRAFTS_CHANGED_EVENT } from "@/components/mail/compose-form";
import { MAIL_ITEM_CHANGED_EVENT, type MailItemChange } from "@/components/mail/message-view";
import { MAIL_UNREAD_EVENT } from "@/components/mail/new-mail-notifier";
import { AccountMenu } from "@/components/mail/account-menu";
import { MailBatchBar, MailRowCheckbox } from "@/components/mail/mail-batch-bar";
import { accountDotProps } from "@/components/mail/account-dot";
import { MOTION_SIZE, TOOLBAR_MS } from "@/components/mail/motion";
import { usePublishMailBar } from "@/components/mail/mail-statusbar";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button, buttonVariants } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SearchInput } from "@/components/ui/search-input";
import { type BackfillState } from "@/components/mail/sync-status";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { toast } from "@/components/ui/toast";
import type {
  MailAccount,
  MailDraft,
  MailFolder,
  MailListItem,
  MailListResponse,
} from "@/lib/mail/types";

function formatDate(dateIso: string | null, locale: string): string {
  if (!dateIso) return "";
  const d = new Date(dateIso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return d.toLocaleString(locale, sameDay
    ? { hour: "2-digit", minute: "2-digit" }
    : { month: "short", day: "numeric" });
}

/**
 * 视图切换（2026-10-05 微调，用户定稿）：下划线 Tabs「全部 / 收件（默认）/ 发件 / 草稿 / 垃圾」——
 * 纯方向维度 + 独立的草稿箱（2026-10-06 用户指定：草稿不算入「全部」——草稿来自
 * webmaild /drafts，与 messages 完全分离，只有这个 tab 会读它）
 * + 独立的垃圾箱（2026-10-08 用户要求新增：垃圾是**文件夹**维度，但它是"我该看一眼"的
 * 少数几个位置之一，值一个 tab；见下方 junkFolders 的实现注记）。
 * 「星标」从视图降为与「未读」并列的独立开关，放在 tab 行右侧，
 * 可与任意方向叠加（星标 ∩ 收件 / 发件 / 全部都合法）。
 * - 收件（默认，邮箱的直觉入口）/ 发件 → 服务端 `direction` 参数；全部 → 不带方向参数
 * - 草稿 → 不查 /messages，单独 GET /drafts（行点击进 /mail/compose?draft=<id>）
 * - 垃圾 → 服务端 `folder` 参数（多个 = 并集）：路径先按账号探测（`GET /folders`），
 *   见 junkFolders
 * - 「未读」「星标」两个开关 → `filter` 逗号多值取交集（如 星标+未读 = `filter=flagged,unseen`）；
 *   未读计数「(n)」挂在「未读」开关上（2026-10-05 用户改：原在「收件」tab 徽标——
 *   「发件」不可能有未读，挂在方向 tab 上语义刻意；未读开关与方向无关，语义自然对齐）
 * - tab 下划线着色 = 方向配色（收件 emerald / 发件 amber，与头像方向角标、agent 页方向徽章同源）
 *
 * ⚠ 「文件夹」视图（按任意文件夹浏览）已于 2026-10-07 **删除**（用户定稿，勿加回）：
 * 它把「数据位置」混进「数据切片」，5 个 tab 把右侧两个开关挤到第二行。⚠ 但「垃圾」
 * 不是这个坑的重演——它是**一个固定的特殊用途**（服务商自己认定的 `\Junk`），语义上
 * 与「草稿」（另一个固定特殊用途）同级，不是"让用户随便挑一个文件夹看"。
 * 空间不够时的做法见下方 tab 条的注释（收进 chevron 下拉）。
 */
type ViewFilter = "all" | "received" | "sent" | "drafts" | "junk";

/**
 * 行 1 的固定开销：搜索图标 28 +「全部标为已读」28 + 刷新 28，加四个间距
 * （gap-1.5 = 6px × 4，五个子项之间）。账号触发器与「写邮件」分享剩下的宽
 * （分配规则见组件内「行 1 的宽度分配」注释）。
 * ⚠ 「选择」（多选批量）曾占这里的一个 28px 图标位（2026-10-07 ~ 2026-10-08），代价是
 *   账号触发器从 198 掉到 168：**邮箱那一行被裁掉 30px**（`me@mail.shaoyuanyu.cn` 需
 *   145、只剩 115，实测中英文各裁 30 / 24px）。2026-10-08 按用户要求把它搬进**行内
 *   悬浮气泡栏**（`mail-row-actions`，见列表行），账号这才拿回 198px 的完整宽。
 *   改这一行常量前先重量：`.cache/probe-select-pos.mjs` 会同时报账号宽与邮箱裁切量。
 */
const ROW_FIXED_W = 28 * 3 + 24;

/** 加载占位：列表行骨架（4.9：不用居中 spinner 充数） */
function ListSkeleton() {
  return (
    <ul className="divide-y divide-border rounded-xl border border-border lg:rounded-none lg:border-0" aria-busy="true">
      {Array.from({ length: 6 }, (_, i) => (
        <li key={i} className="flex items-start gap-3 px-4 py-3">
          <Skeleton className="size-8 shrink-0 self-center rounded-full" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <Skeleton className="h-3.5 w-1/3" />
            <Skeleton className="h-3.5 w-2/3" />
            <Skeleton className="h-3 w-1/2" />
          </div>
        </li>
      ))}
    </ul>
  );
}

/**
 * 邮件合并视图：默认全部账号合并，工具栏可筛选账号与状态（4.2）。
 *
 * `backfill` / `firstSync`（2026-10-08）：由 MailShell 的同步状态轮询传下来——有新账号
 * 的**历史回填**（有 x/y 数字）或**首轮还没跑完**（数字还出不来）在跑时，列表每 15 秒
 * 静默重取一次（不带 loading，不闪），于是「最新优先」抓到的邮件会自己冒出来，
 * 用户不必反复手动刷新等结果。
 */
export function MailClient({
  backfill,
  firstSync,
}: {
  backfill?: BackfillState | null;
  firstSync?: boolean;
}) {
  const t = useTranslations("mail");
  const router = useRouter();
  const pathname = usePathname();
  // 右栏正在看哪一封（宽屏两栏布局下左栏据此高亮；窄屏列表被隐藏，无实际影响）
  const activeId = useMemo(
    () => (pathname.startsWith("/mail/message/") ? pathname.slice("/mail/message/".length) : null),
    [pathname],
  );

  const [accounts, setAccounts] = useState<MailAccount[]>([]);
  // 自己的地址（收件人视角的「双向邮件」判定：发件人与收件人都是我的账号，2026-10-06）
  const { ready: ownReady, emails: ownEmails } = useOwnAddresses();
  // 账号筛选（2026-10-05 用户定稿）：单选——"all"（全部账号）或某个账号 id；
  // 控件 = 工具栏行 1 首个下拉（完整显示名称/地址）；底栏只保留只读指示。
  const [accountFilter, setAccountFilter] = useState<string>("all");
  const [view, setView] = useState<ViewFilter>("received");
  const [unseenOnly, setUnseenOnly] = useState(false);
  const [flaggedOnly, setFlaggedOnly] = useState(false);
  /**
   * 垃圾视图（2026-10-08 用户要求新增「垃圾」tab）。
   *
   * 各家的垃圾文件夹名字不同（阿里云「垃圾邮件」、Gmail `[Gmail]/Spam`…），所以路径
   * **由服务端探测**（`GET /folders` 里 `specialUse === "\\Junk"` 的那些），前端只负责
   * 拼 `folder` 参数（每个账号一个，服务端取并集）。路径按账号缓存，账号配置变化时清空。
   * ⚠ 只有**在同步白名单里**的垃圾文件夹才查得到邮件——没同步的文件夹本地根本没有副本。
   *   这一点要作为空态文案说出来，否则「垃圾」页永远空白且没有解释（见 junkNote）。
   */
  const junkCacheRef = useRef<Map<string, { hasFolder: boolean; synced: string[] }>>(new Map());
  const [junkNote, setJunkNote] = useState<"none" | "unsynced" | null>(null);
  /**
   * 多选批量操作（2026-10-07，MAIL-AGENT.md 4.16）：`selectMode` 打开后列表行变成
   * "点一下 = 勾选/取消"（不再跳转），列表上方出现批量操作条。
   * - 选中集合按 **messageId** 记（跨账号合并视图里一行 = 一封邮件，与删除/移动的
   *   "全部副本一起动"口径一致）；
   * - 切换视图 / 账号 / 搜索词时**清空选择**——否则会对看不见的行动手（用户无从核对）；
   * - 草稿视图不参与（草稿有自己的行内删除，也不是 messages 数据源）。
   */
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  /** 批量操作进行中（禁用所有批量按钮，防连点重复提交） */
  const [batchBusy, setBatchBusy] = useState(false);
  const [batchDeleteOpen, setBatchDeleteOpen] = useState(false);
  /**
   * 当前视图下「真正生效」的筛选值（2026-10-06 用户定稿）：「未读」在「发件」「草稿」
   * 「垃圾」不可用（「发件」不可能有未读——与「草稿」同规则；「星标」仅「草稿」不可用，
   * 发件加星是真实用例）。不可用 = 按钮禁用 + **查询不携带** + 显示为关；开关状态本身
   * 保留（收件里开着「未读」切到发件再切回来，仍是开的）。
   * ⚠ 查询与显示（含空态文案）都必须用这份生效值：若查询沿用原始开关，从收件带过来的
   *   「未读」会把发件列表静默压空，而按钮此刻已禁用、用户无法取消它。
   *
   * ⚠ 「垃圾」为什么也在列（2026-10-10 第六轮用户报障后定稿）：**未读 = 收件箱未读**
   * （服务端 `UNSEEN_SQL`，与角标 / 底栏 /「全部标为已读」同一个数）。垃圾箱里的未读
   * 副本不属于「收件箱未读」，所以「垃圾」tab 里带上 `filter=unseen` 只会得到一个空列表，
   * 而开关上的数字却是收件箱那个数——又是「数字说 2、点开 0 封」的自相矛盾。
   * 禁用 + 显示为关，与「发件」同一种处理（垃圾邮件的未读也不该在这里被清点）。
   */
  const unseenActive = unseenOnly && view !== "sent" && view !== "drafts" && view !== "junk";
  const flaggedActive = flaggedOnly && view !== "drafts";
  /** 已提交（触发加载）的搜索词；输入框的即时值另存 qInput（300ms 防抖后提交） */
  const [q, setQ] = useState("");
  const [qInput, setQInput] = useState("");
  /** 搜索展开态（2026-10-05 定稿）：收起时行 1 是一个图标按钮，展开时账号收窄为「色点 + ≤4 字名」 */
  const [searchOpen, setSearchOpen] = useState(false);
  /**
   * 搜索框「退场保留期」（2026-10-05 用户定稿「动画统一联动」）：关闭后让输入框再挂
   * TOOLBAR_MS 播完淡出动画、再卸载成图标——否则输入框会瞬碎，与其它组件的 300ms 联动动画割裂。
   */
  const [searchClosing, setSearchClosing] = useState(false);

  // ---- 行 1 的宽度分配（2026-10-05 定稿，二稿简化）----
  // 规则：「写邮件」**只在搜索展开时**缩为图标；其余任何情况都保持完整文字。宽度预算不够
  // 时由账号自己的 max-width 吸收（超出部分截断，完整值在悬浮 title 与账号下拉里）。
  // ⚠ 曾按「账号需求宽 + 写邮件完整宽 + 固定开销 > 行宽 → 缩写邮件」（单行账号时代
  //   `我<邮箱>` 233px 连中文都放不下的设计）。两行版账号把需求降到 198px 后中文天然放得下，
  //   判据只剩英文触发（Compose 95px，选中「我」差 19px）→ 英文下写邮件**常驻**图标态、搜索
  //   取消也不恢复（2026-10-05 用户两次报障、不接受取舍）→ 规则与探针上报整体移除；英文文案
  //   同日改「Write」（68px），英文下 200 + 68 + 108 = 376 ≤ 384 也完整放得下。写邮件是主
  //   操作，其文字优先级高于账号邮箱的末几个字符。
  // 另：搜索模式（searchOpen）固定缩为图标（2026-10-05 用户要求）——搜索框才是主角。
  // ⚠ 2026-10-05 二稿：「缩为图标」不再是瞬变，而是与账号同曲线动画（gap + grid 轨道 +
  //   文字透明度，见 motion.ts）——写邮件宽度本身就是搜索框（flex-1）宽度的来源之一，
  //   它的收窄与账号收窄是**同一段联动动画**的两个声部。
  const rowRef = useRef<HTMLDivElement>(null);
  const [rowW, setRowW] = useState(384); // 初值 = 桌面左栏内容宽；挂载后按实测（窄屏行 1 是全宽）
  const [composeFullW, setComposeFullW] = useState(0);
  const composeCompact = searchOpen;
  /** 账号触发器的 max-width：除去固定开销与写邮件（按当前形态）的宽全给它 */
  const accountMaxW = Math.max(72, rowW - ROW_FIXED_W - (composeCompact ? 28 : composeFullW));

  useEffect(() => {
    const el = rowRef.current;
    if (!el) return;
    const measure = () => setRowW(el.clientWidth);
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, []);

  // 写邮件「完整态」宽实测（图标态 28px 不更新缓存；字体就绪 / 切语言后重测）
  const composeRef = useRef<HTMLAnchorElement>(null);
  const locale = useLocale();
  useEffect(() => {
    const el = composeRef.current;
    // ⚠ 收起态（含其 300ms 过渡中）不测量：图标态与中间值都会污染缓存，而缩窄判据
    //   要求这个输入与「当前是否已缩」无关（否则会逐帧振荡）
    if (!el || composeCompact) return;
    const measure = () => {
      // 展开过渡中量到的是中间值——getAnimations 排除，等 settle 后再复测终值
      if (el.getAnimations({ subtree: true }).length > 0) return;
      const w = el.offsetWidth;
      if (w > 40) setComposeFullW(w);
    };
    measure();
    const settle = window.setTimeout(measure, TOOLBAR_MS + 80);
    // 字体加载完成后重测（Inter 未就绪时量出的文字宽偏小）
    void (document.fonts?.ready ?? Promise.resolve()).then(measure).catch(() => {});
    return () => window.clearTimeout(settle);
    // ⚠ rowW 也是依赖（2026-10-05 隐藏挂载 bug）：直达 /mail/compose 时本组件在
    //   display:none 下挂载，量不到写邮件宽（offsetWidth = 0 被 `w > 40` 跳过）——
    //   composeFullW 停在 0 → 回邮箱后 accountMaxW 偏宽（384−108−0 = 276）。rowW 在
    //   恢复显示时由 ResizeObserver 从 0 报回实测值（行上已实证），那一刻触发本 effect
    //   重测。⚠ 勿给 rowW 的 measure 加「0 不写入」守卫：那个 0→384 的变化正是本 effect
    //   的重新触发信号（隐藏期的 rowW=0 不可见、无副作用）。
  }, [composeCompact, locale, rowW]);
  const [items, setItems] = useState<MailListItem[]>([]);
  /** 草稿列表（「草稿」tab 专用；null = 尚未加载） */
  const [drafts, setDrafts] = useState<MailDraft[] | null>(null);
  /**
   * 草稿箱两段式读取（2026-10-10：草稿以服务商草稿文件夹为唯一事实源）：
   * ① 先读本地缓存（快）→ 立刻出列表；② 再 `?refresh=1` 去服务商那边对一遍（手机写的
   * 草稿由此进来、服务端删掉的从缓存清掉），回来后原地替换。实测 QQ 那 153 封草的核对
   * 要十几秒（跨境 IMAP），所以不能把它挡在首屏前面。
   */
  const [draftsSyncing, setDraftsSyncing] = useState(false);
  /** 核对失败的账号（下面显示"当前是本地缓存"，别让用户以为草稿箱空了） */
  const [draftErrors, setDraftErrors] = useState<string[]>([]);
  /** 「更早的草稿」折叠区（默认收起：QQ 草稿箱里有 141 封 2014 年起的旧草稿） */
  const [olderDraftsOpen, setOlderDraftsOpen] = useState(false);
  const [next, setNext] = useState<string | null>(null);
  /**
   * 列表游标（草稿箱要视而不见）——2026-10-10：草稿的数据源是 `/drafts` 全量返回、根本没有
   * 分页，但 `next` 还留着上一个邮件视图的游标，于是**草稿列表下面会冒出一个「加载更多」**，
   * 点它只会去拉一页邮件追加到看不见的 `items` 上（哨兵还会自动续页）。
   */
  const pagedNext = view === "drafts" ? null : next;
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  /** 「全部标为已读」执行中（按钮进 spinner） */
  const [markingAll, setMarkingAll] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<MailListItem | null>(null);
  const [deleting, setDeleting] = useState(false);
  /** 待确认删除的草稿（草稿箱行内删除） */
  const [pendingDraftDelete, setPendingDraftDelete] = useState<MailDraft | null>(null);
  const [deletingDraft, setDeletingDraft] = useState(false);
  // 加载序号：只有「最后一次加载」的响应允许落地（连点 tab 时防旧响应覆盖新结果）
  const loadSeqRef = useRef(0);
  // 首次加载完成前显示骨架屏；之后重载保持旧内容（避免每次点筛选都闪一下骨架）
  const hasLoadedRef = useRef(false);
  const listRef = useRef<HTMLUListElement>(null);
  /** 底部哨兵节点：用 **state** 而不是 `useRef` —— 节点被 React 重建时观察器必须重挂，
   *  见下方「无限滚动」的注释（旧实现用 ref、effect 依赖里看不见节点变化，无限滚动静默失效） */
  const [sentinelNode, setSentinelNode] = useState<HTMLDivElement | null>(null);
  /** 哨兵是否落在（含 300px 余量的）视口里 —— 自动续页由它驱动 */
  const [sentinelInView, setSentinelInView] = useState(false);

  const load = useCallback(
    async (opts: {
      account: string;
      view: ViewFilter;
      unseen: boolean;
      flagged: boolean;
      q: string;
      before?: string | null;
      append?: boolean;
      /** 垃圾视图：每个（账号, 路径）一项，服务端取并集（见 junkFolders） */
      folders?: { account: string; path: string }[];
    }) => {
      const params = new URLSearchParams();
      // 完整加载（非「加载更多」）递增序号：先发后到的旧响应会被丢弃（append 不递增，
      // 它只是给当前列表续页，不应作废进行中的刷新）
      const seq = opts.append ? loadSeqRef.current : ++loadSeqRef.current;
      // 账号单选：「全部账号」不传参数（服务端 account 仍支持逗号多值，前端只发单值）
      if (opts.account !== "all") params.set("account", opts.account);
      // 状态：星标 / 未读两个开关可叠加（逗号多值，服务端取交集）
      const status = [opts.flagged ? "flagged" : "", opts.unseen ? "unseen" : ""]
        .filter(Boolean)
        .join(",");
      if (status) params.set("filter", status);
      if (opts.view === "received") params.set("direction", "received");
      if (opts.view === "sent") params.set("direction", "sent");
      if (opts.q.trim()) params.set("q", opts.q.trim());
      // 垃圾视图：每个（账号, 路径）一个 `folder` 参数（服务端并集；⚠ 不用逗号拼，
      // 文件夹名里可以有逗号）
      for (const f of opts.folders ?? []) {
        params.append("folder", f.account ? `${f.account}|${f.path}` : f.path);
      }
      if (opts.before) params.set("before", opts.before);
      const res = await fetch(`/api/mail/messages?${params}`);
      if (seq !== loadSeqRef.current) return; // 过期响应：静默丢弃（连点筛选时的旧结果）
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? `${res.status}`);
      const data = (await res.json()) as MailListResponse;
      if (seq !== loadSeqRef.current) return;
      setItems((prev) => {
        const merged = opts.append ? [...prev, ...data.items] : data.items;
        // 详情页「上一封 / 下一封」按此顺序导航（4.9）
        try {
          window.sessionStorage.setItem(
            MAIL_LIST_ORDER_KEY,
            JSON.stringify(merged.map((m) => m.messageId)),
          );
        } catch {
          // sessionStorage 不可用（隐私模式等）：跳过，详情页导航自动隐藏
        }
        return merged;
      });
      setNext(data.next);
    },
    [],
  );

  // 账号列表（筛选 chips、色点与未读数徽章）
  const loadAccounts = useCallback(() => {
    fetch("/api/mail/accounts")
      .then((r) => (r.ok ? r.json() : []))
      .then((data: MailAccount[]) => setAccounts(data.filter((a) => a.enabled)))
      .catch(() => {});
  }, []);

  /** 草稿箱加载（「草稿」tab 与写信页保存广播共用；数据量小，整表拉取） */
  const loadDrafts = useCallback(async () => {
    // ① 本地缓存先出列表（快、断网也能看）
    try {
      const r = await fetch("/api/mail/drafts");
      const data = (await r.json()) as { items?: MailDraft[]; errors?: { error: string }[] };
      setDrafts(data.items ?? []);
      setDraftErrors((data.errors ?? []).map((e) => e.error));
    } catch {
      setDrafts([]);
      return;
    }
    // ② 再去服务商草稿箱对一遍（手机写的草稿由此进来）。TTL 在后端，来回切 tab 不会再刷。
    setDraftsSyncing(true);
    try {
      const r = await fetch("/api/mail/drafts?refresh=1");
      const data = (await r.json()) as { items?: MailDraft[]; errors?: { error: string }[] };
      setDrafts(data.items ?? []);
      setDraftErrors((data.errors ?? []).map((e) => e.error));
    } catch {
      // 核对失败：留着缓存那份，不打扰（下面会显示"显示的是本地缓存"）
    } finally {
      setDraftsSyncing(false);
    }
  }, []);

  // 草稿视图：进入时加载 + 监听写信页的保存/删除广播（写完回来列表是新数据）
  useEffect(() => {
    if (view !== "drafts") return;
    loadDrafts();
    const onChanged = () => loadDrafts();
    window.addEventListener(MAIL_DRAFTS_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(MAIL_DRAFTS_CHANGED_EVENT, onChanged);
  }, [view, loadDrafts]);

  useEffect(() => {
    loadAccounts();
    // 账号管理弹窗增删账号后广播，筛选 chips 随之刷新
    const onAccountsChanged = () => {
      // 同步文件夹白名单可能刚被改过（勾上「垃圾邮件」等）→ 垃圾视图的路径缓存作废
      junkCacheRef.current.clear();
      loadAccounts();
    };
    window.addEventListener(MAIL_ACCOUNTS_CHANGED_EVENT, onAccountsChanged);
    return () => window.removeEventListener(MAIL_ACCOUNTS_CHANGED_EVENT, onAccountsChanged);
  }, [loadAccounts]);

  // 账号被禁用/删除后，选择失效就回到「全部账号」（否则列表会被一个看不见的条件压空）
  useEffect(() => {
    setAccountFilter((prev) => (prev !== "all" && !accounts.some((a) => a.id === prev) ? "all" : prev));
  }, [accounts]);

  // 搜索收起（Esc / 失焦且为空）：一并清掉已提交的搜索词——避免「搜索框没了、
  // 列表却还停在搜索结果上」的无形状态（2026-10-05 定稿：收起 = 不再搜索）
  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setSearchClosing(true); // 输入框保留 TOOLBAR_MS 播完淡出再卸载（见下方计时 effect）
    setQInput("");
    setQ("");
  }, []);

  // 退场保留期计时：到点卸载输入框（换成图标按钮）；期间重新打开则随依赖变化取消
  useEffect(() => {
    if (!searchClosing || searchOpen) return;
    const timer = window.setTimeout(() => setSearchClosing(false), TOOLBAR_MS + 40);
    return () => window.clearTimeout(timer);
  }, [searchClosing, searchOpen]);

  /**
   * 垃圾视图的文件夹解析（2026-10-08）：当前账号范围内每个账号的 `\Junk` 路径，
   * **只取在同步白名单里的**（没同步的文件夹本地没有副本，查了也是空）。
   * 结果按账号缓存（会话内）；账号配置变化时清空（见 MAIL_ACCOUNTS_CHANGED_EVENT 监听）。
   * 顺带把「一个都没有」的原因写进 junkNote，供空态显示。
   */
  // ⚠ 账号 id 列表用**字符串**当依赖：`loadAccounts()` 每次都会给出新数组（同一批账号、
  //   新引用），若把 `accounts` 直接写进 junkFolders 的依赖，就会波及 loadCurrent →
  //   reload → 「条件变化即加载」的 effect，于是**每次未读计数刷新都会整表重取一次**
  //   （行内点星标后乐观更新被重取结果冲掉——2026-10-08 实测就是这样红的）。
  const accountIdsKey = useMemo(() => accounts.map((a) => a.id).join(","), [accounts]);

  const junkFolders = useCallback(async (): Promise<{ account: string; path: string }[]> => {
    if (view !== "junk") return [];
    const ids = accountFilter === "all" ? accountIdsKey.split(",").filter(Boolean) : [accountFilter];
    const out: { account: string; path: string }[] = [];
    let hasFolder = false;
    for (const id of ids) {
      let hit = junkCacheRef.current.get(id);
      if (!hit) {
        const res = await fetch(`/api/mail/folders?account=${encodeURIComponent(id)}`);
        if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? `${res.status}`);
        const data = (await res.json()) as { folders: MailFolder[]; synced: string[] };
        const paths = data.folders
          .filter((f) => f.specialUse === "\\Junk" && f.selectable)
          .map((f) => f.path);
        hit = { hasFolder: paths.length > 0, synced: paths.filter((p) => data.synced.includes(p)) };
        junkCacheRef.current.set(id, hit);
      }
      hasFolder = hasFolder || hit.hasFolder;
      for (const path of hit.synced) out.push({ account: id, path });
    }
    setJunkNote(out.length ? null : hasFolder ? "unsynced" : "none");
    return out;
  }, [view, accountFilter, accountIdsKey]);

  /**
   * 拉取「当前筛选」的列表——四处调用（初次/筛选变化、刷新、全部标为已读、加载更多）
   * 共用：垃圾视图要先解析文件夹，解析不到就直接给空列表（不查 /messages，
   * 否则会退化成"查全部"）。
   */
  const loadCurrent = useCallback(
    async (opts?: { before?: string | null; append?: boolean }) => {
      const folders = await junkFolders();
      if (view === "junk" && folders.length === 0) {
        setItems([]);
        setNext(null);
        return;
      }
      await load({
        account: accountFilter,
        view,
        unseen: unseenActive,
        flagged: flaggedActive,
        q,
        before: opts?.before,
        append: opts?.append,
        folders,
      });
    },
    [accountFilter, view, unseenActive, flaggedActive, q, load, junkFolders],
  );

  // 拉取当前筛选下的列表（首次 / 筛选变化 / 错误态「重试」按钮共用）
  const reload = useCallback(() => {
    // 草稿视图不查 /messages（loadDrafts 负责）；切回其它 tab 时本 effect 会重跑
    if (view === "drafts") return;
    setLoading(true);
    setError(null);
    loadCurrent()
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => {
        hasLoadedRef.current = true;
        setLoading(false);
      });
  }, [view, loadCurrent]);

  // 搜索词 300ms 防抖后提交（⚠ 防抖只在搜索上；tab / 开关 / 账号切换按下即加载，
  // 否则每次点击都要白等 300ms，观感卡顿——2026-10-05 用户报）
  useEffect(() => {
    const timer = setTimeout(() => setQ(qInput.trim()), 300);
    return () => clearTimeout(timer);
  }, [qInput]);

  // 条件变化即加载（延迟已在搜索词提交处完成，这里不再等待）
  useEffect(() => {
    reload();
  }, [reload]);

  /**
   * 手动刷新（工具栏按钮）。
   *
   * 2026-10-08 修：`POST /sync` 以前会**阻塞到整轮跑完**才返回——新加账号的首轮
   * 抓取要十几分钟到几十分钟，按钮上的 spinner 就跟着转那么久（用户看到的
   * 「加载要很久」就是这个）。现在后端一次只吃一块（见 webmail 仓库 fetcher.ts），
   * 一轮几秒就回来了；同时这里用 AbortController 给它一个上限：无论后端多慢，
   * 按钮最多转 15 秒，之后照常重取列表——刷新按钮的职责是「催一下 + 看到最新」，
   * 不是「等后台干完」。
   */
  const refresh = useCallback(async () => {
    setRefreshing(true);
    setError(null);
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 15_000);
    try {
      await fetch("/api/mail/sync", { method: "POST", signal: controller.signal });
    } catch {
      // 超时/中断不算失败：后台还在跑，进度由底栏状态条显示（不弹错误）
    } finally {
      window.clearTimeout(timer);
    }
    try {
      await loadCurrent();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRefreshing(false);
    }
  }, [loadCurrent]);

  /**
   * 抓取期间的列表自动刷新（2026-10-08）。
   *
   * 新账号的首轮是「最新优先、按块推进」的倒序回填：邮件是一批批冒出来的，
   * 不刷新就只能看见点进来那一刻已有的那些。这里在抓取期间每 15 秒**静默**重取
   * 当前列表（`loadCurrent` 不置 loading，不闪骨架、不打断滚动），抓完就停。
   * 两种「在跑」都算：有回填数字（`backfill`）与首轮刚起步、数字还没出来（`firstSync`）。
   * ⚠ 依赖用 boolean 而不是 `backfill` 对象：状态轮询每 5 秒给一个新对象，
   *   直接依赖它会让定时器每 5 秒重建一次（永远等不到 15 秒）。
   * ⚠ 搜索态不自动刷新：正在看搜索结果时列表自己变会让人困惑。
   */
  const syncing = !!backfill || !!firstSync;
  useEffect(() => {
    if (!syncing || view === "drafts" || q.trim()) return;
    const timer = window.setInterval(() => {
      void loadCurrent().catch(() => {});
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [syncing, view, q, loadCurrent]);

  /**
   * 「全部标为已读」（2026-10-05 用户定稿）：范围 = 当前账号筛选（「全部账号」= 全部账号）；
   * 方向 / 搜索 / 星标不参与——未读本质是收件箱概念（「发件」不可能有未读），清未读按
   * 账号范围最直觉，也与「未读」开关的计数（账号未读之和）同一口径。
   * 成功后计数（账号 unread）与列表都要重取：停在「未读」筛选下时列表会被清空。
   * 部分失败（skipped）不算成功：报错并让重取的列表展示真实状态。
   */
  const markAllRead = useCallback(async () => {
    setMarkingAll(true);
    try {
      const res = await fetch("/api/mail/mark-all-read", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accounts: accountFilter === "all" ? [] : [accountFilter] }),
      });
      if (!res.ok) throw new Error();
      const data = (await res.json()) as { messages: number; skipped: unknown[] };
      if (data.skipped.length > 0) {
        toast.add({ title: t("actionFailed"), type: "error" });
      } else if (data.messages > 0) {
        toast.add({ title: t("markAllReadDone", { count: data.messages }), type: "success" });
      } else {
        toast.add({ title: t("markAllReadNone") });
      }
      await Promise.all([loadAccounts(), loadCurrent()]);
    } catch {
      toast.add({ title: t("actionFailed"), type: "error" });
    } finally {
      setMarkingAll(false);
    }
  }, [accountFilter, loadCurrent, loadAccounts, t]);

  // 多选：选中的列表项（顺序按当前列表）
  const selectedItems = useMemo(
    () => items.filter((m) => selected.has(m.messageId)),
    [items, selected],
  );
  /**
   * 选中项的状态（2026-10-07 用户指定）：全都已读 → 「标为已读」无事可做（禁用）；
   * 全都未读 → 「标为未读」无事可做。混合选中时两个都可用。空选中时两个都为 false，
   * 由 count === 0 负责禁用。
   */
  const allSeen = selectedItems.length > 0 && selectedItems.every((m) => m.seen);
  const allUnseen = selectedItems.length > 0 && selectedItems.every((m) => !m.seen);
  // 视图 / 账号 / 搜索变化时清空选择（选择模式本身保留：用户可能想接着选下一批）
  useEffect(() => {
    setSelected(new Set());
  }, [view, accountFilter, q]);

  const exitSelectMode = useCallback(() => {
    setSelectMode(false);
    setSelected(new Set());
  }, []);

  /**
   * 全选 / 取消全选（同一个按钮，2026-10-07 用户指定）：已全选时再点即清空。
   * ⚠ 判据用 `count === total` 而不是"有没有选中项"——只选了一部分时点它仍是全选。
   */
  const toggleAll = useCallback(() => {
    setSelected((prev) =>
      items.length > 0 && prev.size === items.length
        ? new Set()
        : new Set(items.map((m) => m.messageId)),
    );
  }, [items]);

  const toggleSelect = useCallback((messageId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(messageId)) next.delete(messageId);
      else next.add(messageId);
      return next;
    });
  }, []);

  /** 批量标记（已读 / 未读）：走后端的 messageIds 口径（每账号一次连接、每文件夹一次 STORE） */
  const batchFlags = useCallback(
    async (change: { seen?: boolean; flagged?: boolean }) => {
      const ids = [...selected];
      if (ids.length === 0) return;
      setBatchBusy(true);
      try {
        const res = await fetch("/api/mail/flags", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ messageIds: ids, ...change }),
        });
        if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? `${res.status}`);
        const data = (await res.json()) as { updated: number; skipped: unknown[] };
        if (Array.isArray(data.skipped) && data.skipped.length > 0) {
          toast.add({ title: t("batchPartial"), type: "error" });
        } else {
          toast.add({ title: t("batchDone", { count: ids.length }), type: "success" });
        }
        setSelected(new Set());
        await Promise.all([loadAccounts(), reload()]);
      } catch {
        toast.add({ title: t("actionFailed"), type: "error" });
      } finally {
        setBatchBusy(false);
      }
    },
    [selected, reload, loadAccounts, t],
  );

  /** 批量删除：确认后对该批消息的**全部副本**一起删（与单条删除同一接口同一口径） */
  const batchDelete = useCallback(async () => {
    const copies = selectedItems.flatMap((m) => m.copies);
    if (copies.length === 0) return;
    setBatchBusy(true);
    try {
      const res = await fetch("/api/mail/delete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ copies }),
      });
      if (!res.ok) throw new Error();
      toast.add({ title: t("batchDeleted", { count: selectedItems.length }), type: "success" });
      setBatchDeleteOpen(false);
      setSelected(new Set());
      await Promise.all([loadAccounts(), reload()]);
    } catch {
      toast.add({ title: t("actionFailed"), type: "error" });
    } finally {
      setBatchBusy(false);
    }
  }, [selectedItems, reload, loadAccounts, t]);

  const loadMore = useCallback(async () => {
    // ⚠ `loading`（整体重载）也要拦：重载在飞时续页会把**旧游标**的下一页追加到即将被
    //   替换的列表上（新列表到货后再被覆盖，白下一次请求）
    if (!pagedNext || loadingMore || loading) return;
    setLoadingMore(true);
    try {
      await loadCurrent({ before: pagedNext, append: true });
    } finally {
      setLoadingMore(false);
    }
  }, [pagedNext, loadingMore, loading, loadCurrent]);

  /**
   * 无限滚动（4.9）：底部哨兵进入（扩展）视口即取下一页，「加载更多」按钮保留兜底。
   *
   * ⚠ **2026-10-09 修：这一版必须用「state 驱动」而不是「回调里直接 loadMore」**。
   *   旧实现有两个静默失效点，实测（dev 1440×900）滚轮滑到列表底部 30 次、行数一次都
   *   没涨——**自动续页实际是坏的**，只能手点按钮：
   *   ① 观察目标会**换节点**：哨兵原先挂在 `{next && !loading && …}` 里，`loading` 每次
   *      变化都把哨兵卸载重建；而 effect 依赖是 `[next, loadMore]`，节点换了不会重跑 →
   *      观察器一直盯着**已脱离文档**的旧节点，永不回调（自建 IO 在同一个哨兵上报
   *      `intersecting=true ratio=1.00`，本组件的 IO 一次回调都没有 = 就是这个）；
   *   ② 若 effect 恰好跑在 `loading===true` 那一刻，`sentinelRef.current` 是 null，
   *      旧实现的 `if (!el) return` 直接放弃观察、之后也不会补挂。
   *   现在：哨兵**常驻**（只跟 `next` 走，不再受 `loading` 影响）+ ref 用 callback ref
   *   存进 state（节点变了 effect 必然重挂）+ 交集状态进 state。
   *   用 state 而不是「回调里直接取页」还有第二个好处：IO 只在**交集变化**时回调，
   *   「刷新期间滚到底、刷新完成后视口里还停着哨兵」这种情形回调式会漏（哨兵一直在视口
   *   里、没有新的交集变化），state 驱动会在 `loading` 落回 false 时补上这一次。
   */
  /**
   * 哨兵是否落在「视口 + 300px 余量」内。
   * ⚠ 这是给自动续页做**同步复查**用的：IntersectionObserver 的回调要等下一帧，而
   *   刚追加完一页时 `sentinelInView` 还是旧值（true）——只信 state 会在一瞬间连拉
   *   好几页（实测：把按钮滚进视野那一下连拉了 3 页）。落库前同步量一次 rect 即可
   *   精确判断"哨兵是不是真被上一页推出了余量"。判据与 IO 的 `rootMargin` 保持一致。
   */
  const sentinelNear = useCallback(() => {
    if (!sentinelNode) return false;
    const r = sentinelNode.getBoundingClientRect();
    const margin = 300;
    return r.top <= window.innerHeight + margin && r.bottom >= -margin;
  }, [sentinelNode]);

  useEffect(() => {
    if (!sentinelNode || !pagedNext) return;
    const ob = new IntersectionObserver(
      (entries) => setSentinelInView(entries.some((e) => e.isIntersecting)),
      { rootMargin: "300px" },
    );
    ob.observe(sentinelNode);
    return () => {
      ob.disconnect();
      setSentinelInView(false);
    };
    // `sentinelNode` 是 state（不是 ref 对象）：节点换了这个 effect 会重跑
  }, [pagedNext, sentinelNode]);

  // 哨兵在视口里 + 还有下一页 + 没有任何加载在跑 → 自动续页（同步复查，见 `sentinelNear`）
  useEffect(() => {
    if (!sentinelInView || !pagedNext || loading || loadingMore) return;
    if (!sentinelNear()) return;
    void loadMore();
  }, [sentinelInView, pagedNext, loading, loadingMore, loadMore, sentinelNear]);

  /**
   * 点**空白处**退出选择模式（2026-10-07 用户指定：不设专门的「退出」按钮）。
   * 判据是"点到的不是行、也不是任何可交互元素"——否则会误伤「加载更多」、行内快捷操作
   * （它们在 li 内、是行按钮的兄弟节点）、草稿行内的删除按钮，以及批量条自己。
   * ⚠ 挂在**整个左栏**（工具栏 + tab 行 + 列表）而不是只挂列表滚动区：列表长到填满面板时，
   *   行下方没有空白可点，而工具栏行/tab 行右侧永远留着空白——那是最容易点到的地方。
   */
  const onListBlankClick = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>) => {
      if (!selectMode) return;
      const el = e.target as HTMLElement;
      if (
        el.closest(
          '[data-mail-row], [data-slot="mail-batch-bar"], button, a, input, label, [role="button"], [role="menuitem"]',
        )
      ) {
        return;
      }
      exitSelectMode();
    },
    [selectMode, exitSelectMode],
  );

  // 键盘导航（4.9）：j / ↓ 下一行，k / ↑ 上一行；Enter 由按钮原生激活打开；
  // Esc 退出选择模式（⚠ 弹窗打开时不抢：删除确认弹窗的 Esc 归弹窗自己）
  const onListKeyDown = useCallback((e: KeyboardEvent<HTMLUListElement>) => {
    if (e.key === "Escape" && selectMode) {
      if (typeof document !== "undefined" && document.querySelector('[role="dialog"]')) return;
      e.preventDefault();
      exitSelectMode();
      return;
    }
    const delta = e.key === "j" || e.key === "ArrowDown" ? 1 : e.key === "k" || e.key === "ArrowUp" ? -1 : 0;
    if (delta === 0) return;
    const rows = Array.from(listRef.current?.querySelectorAll<HTMLElement>("[data-mail-row]") ?? []);
    const idx = rows.indexOf(document.activeElement as HTMLElement);
    const target = rows[idx + delta];
    if (idx >= 0 && target) {
      e.preventDefault();
      target.focus();
    }
  }, [selectMode, exitSelectMode]);

  const patchItem = useCallback((messageId: string, change: Partial<MailListItem>) => {
    setItems((prev) => prev.map((m) => (m.messageId === messageId ? { ...m, ...change } : m)));
  }, []);

  /**
   * 一格状态变更的统一落地（2026-10-06）：刷新未读计数（h1 角标 / 未读开关上标 /
   * 底栏 / 账号菜单）+ 更新列表行。详情页（MAIL_ITEM_CHANGED_EVENT）与列表行内
   * 快捷操作都走这里，两处不再各自漏刷。
   * - 删除 → 直接移除该行
   * - 生效中的筛选与变更相关（未读筛选中读了一封 / 星标筛选中改了星标）→ 整表重取，
   *   行该进/该出（只打补丁会让不再匹配筛选的行赖在列表里）
   * - 其余 → 只打补丁（不引网络往返）
   */
  const applyItemChange = useCallback(
    (change: MailItemChange) => {
      loadAccounts();
      if (change.deleted) {
        setItems((prev) => prev.filter((m) => m.messageId !== change.messageId));
        return;
      }
      const affected =
        (unseenActive && change.seen !== undefined) ||
        (flaggedActive && change.flagged !== undefined);
      if (affected) {
        reload();
        return;
      }
      const patch: Partial<MailListItem> = {};
      if (change.seen !== undefined) patch.seen = change.seen;
      if (change.flagged !== undefined) patch.flagged = change.flagged;
      if (Object.keys(patch).length > 0) patchItem(change.messageId, patch);
    },
    [unseenActive, flaggedActive, loadAccounts, reload, patchItem],
  );

  // 详情页的状态操作回传（标为未读/已读、星标、删除）：没有这条链路时，左栏列表行
  // 与计数不会跟随右栏操作（用户报障：「标为未读后仍显示已读，像操作失效」）
  useEffect(() => {
    const onItemChanged = (e: Event) => {
      const detail = (e as CustomEvent<MailItemChange>).detail;
      if (detail?.messageId) applyItemChange(detail);
    };
    window.addEventListener(MAIL_ITEM_CHANGED_EVENT, onItemChanged);
    return () => window.removeEventListener(MAIL_ITEM_CHANGED_EVENT, onItemChanged);
  }, [applyItemChange]);

  // 行内快捷操作（4.9）：星标 / 已读切换，乐观更新、失败回滚
  const postFlags = useCallback(
    async (m: MailListItem, change: { seen?: boolean; flagged?: boolean }) => {
      patchItem(m.messageId, change);
      try {
        const res = await fetch("/api/mail/flags", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ messageId: m.messageId, ...change }),
        });
        if (!res.ok) throw new Error();
        // 计数与筛选跟随（此前只打补丁：h1 角标/底栏要等下个 30s 轮询才更新）
        applyItemChange({ messageId: m.messageId, ...change });
      } catch {
        patchItem(m.messageId, { seen: m.seen, flagged: m.flagged });
        toast.add({ title: t("actionFailed"), type: "error" });
      }
    },
    [patchItem, applyItemChange, t],
  );

  const doDelete = useCallback(async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      const res = await fetch("/api/mail/delete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ copies: pendingDelete.copies }),
      });
      if (!res.ok) throw new Error();
      setItems((prev) => prev.filter((m) => m.messageId !== pendingDelete.messageId));
      toast.add({ title: t("deleted"), type: "success" });
      // 删的正好是右栏正在看的那封：右栏退回占位态（否则会留着一封已删邮件的正文）
      if (activeId === encodeMessageId(pendingDelete.messageId)) router.push("/mail");
      setPendingDelete(null);
    } catch {
      toast.add({ title: t("actionFailed"), type: "error" });
    } finally {
      setDeleting(false);
    }
  }, [pendingDelete, t, activeId, router]);

  /** 草稿删除（草稿箱行内操作，ConfirmDialog 确认后执行） */
  const doDeleteDraft = useCallback(async () => {
    if (!pendingDraftDelete) return;
    setDeletingDraft(true);
    try {
      const res = await fetch(`/api/mail/drafts/${encodeURIComponent(pendingDraftDelete.id)}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error();
      setDrafts((prev) => (prev ?? []).filter((d) => d.id !== pendingDraftDelete.id));
      toast.add({ title: t("draftDeleted"), type: "success" });
      setPendingDraftDelete(null);
    } catch {
      toast.add({ title: t("actionFailed"), type: "error" });
    } finally {
      setDeletingDraft(false);
    }
  }, [pendingDraftDelete, t]);

  const accountName = useMemo(() => {
    const map = new Map(accounts.map((a) => [a.id, a]));
    return (id: string) => map.get(id);
  }, [accounts]);

  /**
   * 列表首行名字位显示的「对方」：收件 = 发件人；发件 = 收件人（多人补「等 N 人」）。
   * 方向由头像右下角的箭头角标（↙ 收件 / ↗ 发件）表达，名字位只放名字——
   * 不再带「发给 」前缀（2026-10-04 用户反馈：文字前缀让列表密密麻麻，改用视觉语言）。
   */
  const peerName = (m: MailListItem) =>
    isSentItem(m.copies) && m.to?.length ? m.to[0].name || m.to[0].address || "" : m.fromName || m.fromAddr;
  const peerLabel = (m: MailListItem) =>
    isSentItem(m.copies) && m.to?.length
      ? (m.to[0].name || m.to[0].address || "") +
        (m.to.length > 1 ? ` ${t("andOthers", { count: m.to.length })}` : "")
      : m.fromName || m.fromAddr;

  /**
   * 双向邮件判定（2026-10-06 用户需求）：发件人与收件人**都是我的账号**——
   * 多为「自己给自己另一个账号发信」，方向角标改用双色双向箭头表示
   * （左半 emerald = 收件色，右半 amber = 发件色）。
   */
  const isDualDirection = (m: MailListItem): boolean => {
    if (!ownReady) return false;
    if (!ownEmails.has(m.fromAddr.toLowerCase())) return false;
    return (m.to ?? []).some((a) => !!a.address && ownEmails.has(a.address.toLowerCase()));
  };

  /**
   * 底栏右侧统计 + 「未读」开关上的数字 + 大标题角标（unreadAll）：**同一个数字** =
   * 「当前账号筛选范围内**收件箱**未读之和」（不限账号 = 各账号之和）。
   *
   * ⚠ 口径（2026-10-10 第六轮定稿）：未读 = 收件箱未读。数字来自 `/accounts` 的
   *   `unread`（服务端只数 INBOX 副本），后端 `filter=unseen` 也改成同一口径——四处
   *   （角标 / 底栏 / 开关数字 / 筛选结果）必须永远一致。曾经的 bug 就是这里数收件箱、
   *   筛选数全部文件夹：开关写 2、点开列出 7 封（含 5 封垃圾箱里的未读）。
   */
  const unreadTotal = useMemo(
    () =>
      accounts
        .filter((a) => accountFilter === "all" || a.id === accountFilter)
        .reduce((sum, a) => sum + (a.unread ?? 0), 0),
    [accounts, accountFilter],
  );

  /**
   * 草稿箱**先按账号筛、再按搜索词筛**（2026-10-10 用户报「草稿不区分所属账户，
   * 用户体验太混乱」）：其它视图都由服务端按 `account` 参数筛，草稿箱此前把两个账号的
   * 草稿混在一起、行上也不标归属——工具栏明明选着某个账号，列表里却出现另一个账号的草稿。
   * ⚠ 顺序很重要：账号是"数据范围"、搜索是"范围内的过滤"，底栏的「已加载 N 封」用前者
   *   （与邮件列表同口径：搜索命中数是列表内容，不是数据范围）。
   */
  const accountDrafts = useMemo(
    () => (drafts ?? []).filter((d) => accountFilter === "all" || d.accountId === accountFilter),
    [drafts, accountFilter],
  );

  /**
   * 「更早的草稿」分界：30 天前的旧草稿收进折叠区（默认收起）。
   * 起因（2026-10-10）：草稿改成以服务商草稿文件夹为唯一事实源之后，用户 QQ 账号里
   * 141 封 2014 年起的旧草稿会一次性进入列表——**数据一封都不少**，只是别拿它们糊住
   * 当前在写的那几封。折叠是展示层的分组，不是过滤（点开就见，不是隐藏）。
   */
  const OLD_DRAFT_MS = 30 * 24 * 60 * 60 * 1000;
  const recentDrafts = useMemo(() => {
    const cutoff = Date.now() - OLD_DRAFT_MS;
    return accountDrafts.filter((d) => Date.parse(d.updatedAt) >= cutoff);
  }, [accountDrafts]);
  const olderDrafts = useMemo(() => {
    const cutoff = Date.now() - OLD_DRAFT_MS;
    return accountDrafts.filter((d) => Date.parse(d.updatedAt) < cutoff);
  }, [accountDrafts]);

  /** 搜索命中的草稿（本地过滤：数据量小；匹配收件人 / 主题 / 正文） */
  const matchedDrafts = useMemo(() => {
    const kw = q.trim().toLowerCase();
    if (!kw) return accountDrafts;
    return accountDrafts.filter(
      (d) =>
        d.to.toLowerCase().includes(kw) ||
        d.subject.toLowerCase().includes(kw) ||
        d.body.toLowerCase().includes(kw),
    );
  }, [accountDrafts, q]);

  /**
   * 列表里真正渲染的行：**搜索时不分「更早」**（否则搜到了却看不见），平时只显示最近 30 天。
   * 旧草稿在 `olderVisible` 里，由折叠区展示（默认收起）。
   */
  const draftSearching = q.trim().length > 0;
  const visibleDrafts = draftSearching ? matchedDrafts : recentDrafts;
  const olderVisible = draftSearching ? [] : olderDrafts;

  /** 全账号未读总数（与账号筛选无关）：广播给大标题的未读角标（读信后立即回正） */
  const unreadAll = useMemo(
    () => accounts.reduce((sum, a) => sum + (a.unread ?? 0), 0),
    [accounts],
  );
  useEffect(() => {
    window.dispatchEvent(new CustomEvent(MAIL_UNREAD_EVENT, { detail: { total: unreadAll } }));
  }, [unreadAll]);

  /**
   * 列表空态文案（2026-10-05 用户指定）：有筛选时把条件说清楚——
   * `暂无「未读」邮件` / `「发件」中暂无「星标」邮件`；「全部」不作为条件显示，
   * 只有「全部 + 无筛选」才回到 `暂无邮件`。搜索词另走 emptySearch。
   * ⚠ 垃圾视图还要说清**为什么是空的**（2026-10-08）：没有垃圾文件夹、或垃圾文件夹
   *   还没进同步白名单——两者都不是"真的没有垃圾邮件"，不能只显示「暂无」。
   */
  const emptyText = useMemo(() => {
    // 草稿视图的空态另有文案（emptyDrafts，见渲染分支），不走邮件空态的键拼装——
    // 否则 `emptyFilter.scope.drafts` 查找落空，next-intl 会在控制台报 MISSING_MESSAGE
    if (view === "drafts") return "";
    if (view === "junk" && junkNote === "none") return t("junkNoFolder");
    if (view === "junk" && junkNote === "unsynced") return t("junkNotSynced");
    // ⚠ 状态键必须显式列出，勿用数组 join("And") 拼：`join` 拼出的是 `unseenAndflagged`
    //   （小写 f），与文案里的 `unseenAndFlagged` 大小写不符 → 查找落空后 next-intl
    //   会把 key 路径原样显示在页面上（2026-10-05 实测踩过，单一开关时不触发）。
    // ⚠ 用「生效值」而非原始开关：发件里带过来的「未读」不参与查询，文案也不能说
    //   「「发件」中暂无「未读」邮件」（失效值与生效值的规则见声明处）
    const statusKey =
      unseenActive && flaggedActive
        ? "unseenAndFlagged"
        : unseenActive
          ? "unseen"
          : flaggedActive
            ? "flagged"
            : "none";
    if (view === "all" && statusKey === "none") return t("empty");
    return t(`emptyFilter.scope.${view}`, { status: t(`emptyFilter.status.${statusKey}`) });
  }, [view, unseenActive, flaggedActive, junkNote, t]);

  // 发布到贯通底栏（5.5）：列表统计 + 账号一览 + 当前筛选，底栏挂在 MailShell
  // ⚠ 加载失败时按「加载中」发布：`已加载 0 封` 会让用户以为真的没有邮件（2026-10-04）
  // 底栏「加载中」：草稿箱有自己的数据源（/drafts），不能一律按邮件列表判
  const barLoading = view === "drafts" ? drafts === null : loading || !!error;
  usePublishMailBar({
    loading: barLoading,
    loaded: view === "drafts" ? accountDrafts.length : items.length,
    unread: view === "drafts" ? 0 : unreadTotal,
    accounts,
    accountFilter,
  });

  /**
   * 草稿行（2026-10-10 抽出来）：最近草稿与「更早的草稿」折叠区共用同一份渲染。
   *
   * ⚠ 草稿改成"服务商草稿文件夹 = 唯一事实源"之后，列表只用 IMAP envelope 拼出来，
   *   **没读过正文 ≠ 没有正文**（`contentLoaded === false`），行里必须如实区分这两件事。
   */
  const renderDraftRow = (d: MailDraft) => (
    <li key={d.id} className="group/row relative">
      <button
        type="button"
        data-mail-row
        onClick={() => router.push(`/mail/compose?draft=${encodeURIComponent(d.id)}`, mailNavOptions())}
        className="flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-accent/50 focus-visible:bg-accent/50 focus-visible:outline-none"
      >
        <span className="shrink-0 self-center">
          <Avatar>
            <AvatarFallback>
              <FilePenLineIcon className="size-4" aria-hidden />
            </AvatarFallback>
          </Avatar>
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span className="truncate text-sm font-semibold">{d.to || t("draftNoRecipient")}</span>
            {/* 账号归属（多账号时）：与邮件列表行**同一套**——只给色点，账号名放 `title`
                （悬浮可见），不写可见文本。第三轮曾在点后面明写备注名（当时为了让
                「草稿不区分所属账户」一眼可见），结果只有这个 tab 多一截文字，用户
                2026-10-10 报「为什么包含账号的备注名？其他 tab 都不这样」——统一回色点。
                ⚠ 两处渲染必须同形：改这里请一并看邮件列表行的同名 marker（`m.accounts`）。 */}
            {accounts.length > 1 && (
              <span
                className="flex shrink-0 items-center gap-0.5"
                title={accountName(d.accountId)?.displayName ?? d.accountId}
                data-slot="draft-account"
              >
                <span
                  className={cn(
                    "inline-block size-1.5 rounded-full",
                    accountDotProps(accountName(d.accountId)?.color ?? "").className,
                  )}
                  style={accountDotProps(accountName(d.accountId)?.color ?? "").style}
                />
              </span>
            )}
            {(d.attachments?.length ?? 0) > 0 && (
              <span
                className="flex shrink-0 items-center gap-0.5 text-xs text-muted-foreground"
                title={d.attachments?.map((a) => a.filename).join("、")}
                data-slot="draft-attachments"
              >
                <PaperclipIcon className="size-3.5" aria-hidden />
                {d.attachments?.length}
              </span>
            )}
            <span className="ml-auto shrink-0 text-xs tabular-nums text-muted-foreground group-hover/row:invisible group-focus-within/row:invisible">
              {formatDate(d.updatedAt, t("localeTag"))}
            </span>
          </span>
          <span className="block truncate text-sm">{d.subject || t("noSubject")}</span>
          <span className="block truncate text-xs text-muted-foreground">
            {d.contentLoaded === false ? t("draftContentNotLoaded") : d.body || t("draftNoBody")}
          </span>
        </span>
      </button>
      {/* 行内操作：hover / 聚焦时显现的删除（草稿没有星标 / 已读状态） */}
      <span
        data-slot="mail-row-actions"
        className="absolute top-2 right-3 hidden items-center gap-0.5 rounded-lg border border-border bg-background p-0.5 shadow-sm group-hover/row:flex group-focus-within/row:flex"
      >
        <Button variant="ghost" size="icon-sm" aria-label={t("deleteDraft")} onClick={() => setPendingDraftDelete(d)}>
          <Trash2Icon />
        </Button>
      </span>
    </li>
  );

  return (
    // 整栏挂「点空白处退出多选」（见 onListBlankClick）：只读状态下这个 handler 直接返回
    // ⚠ `data-slot="mail-list-column"` 是 E2E 的钩子：面板自己的 padding 在**这个根之外**
    //   （点击不会冒泡到 handler），所以「点空白处」的用例必须点在根内部的空白上——
    //   取「工具栏块与批量条之间的行间隙」，那里命中的就是这个根元素
    <div className="flex flex-col gap-4 lg:min-h-0 lg:flex-1" data-slot="mail-list-column" onClick={onListBlankClick}>
      {/*
       * 工具栏（2026-10-05 用户定稿，方案 A：留在左侧栏）：
       *   行 1 = 账号下拉 + 搜索（收起/展开）+ 刷新 + 写邮件；
       *   行 2 = 视图与快捷筛选（下划线 Tabs + 未读/星标开关）。
       * ⚠ 行宽很小（桌面 = 左栏内容 384px）：账号与「写邮件」共享它——不够时账号截断、
       *   「写邮件」保持完整（分配规则见上方「行 1 的宽度分配」）。
       * 底栏只保留只读指示（选「全部账号」时列出合并了哪些账号），不承担筛选。
       */}
      <div className="flex shrink-0 flex-col gap-2">
        {/* 第一行（账号 + 查找 + 操作）：
            - 账号下拉放第一个（2026-10-05 用户定稿）——默认**完整显示**账号名/地址；
            - 搜索收起时是一个图标按钮，点击展开为输入框：账号同时收窄为「色点 + ≤4 字名」，
              搜索框「向左弹出」的观感由账号 / 写邮件两处收窄共同驱动（flex 宽度此消彼长）；
            - `flex-wrap` 是超窄屏的安全网 */}
        <div ref={rowRef} className="flex flex-wrap items-center gap-1.5">
          {accounts.length > 0 && (
            <AccountMenu
              accounts={accounts}
              value={accountFilter}
              onChange={setAccountFilter}
              collapsed={searchOpen}
              maxW={accountMaxW}
            />
          )}
          {/* 搜索区（2026-10-05 用户定稿）：`flex-1` 吸掉剩余空间，让**「搜索 / 刷新 / 写邮件」
              三件套固定在行右端**——切账号 / 搜索展开时它们不左右移动，点击位置稳定。
              代价是账号与搜索之间留一段空白（用户权衡后以此为先，勿再改成左排紧跟）。
              展开时输入框 w-full 占满该区、随账号收窄平滑变宽。
              ⚠ **不能给它固定最小宽**（曾用 min-w-40）：展开动画的每一帧都是「账号（渐变
              收窄中）+ 搜索框 + 固定项」共同布局，最小宽会在动画前半段把行 1 撑爆 →
              flex-wrap 把「写邮件」挤到第二行再弹回。flex-1 + min-w-0 会随账号收缩平滑变宽 */}
          <div className="relative flex min-h-7 min-w-0 flex-1 items-center justify-end">
            {/* 搜索图标（2026-10-05 用户定稿「统一联动」）：常挂载、绝对定位在区域右缘，
                与输入框交叉淡化——不再瞬切。展开时 inert + pointer-events-none：
                不可聚焦、不被读屏命中、不挡输入框/清除钮的点击 */}
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => {
                setSearchClosing(false);
                setSearchOpen(true);
              }}
              aria-label={t("search")}
              title={t("search")}
              inert={searchOpen ? true : undefined}
              className={cn(
                // ⚠ 垂直居中用 `inset-y-0 my-auto`（不用 top-1/2 + -translate-y-1/2）：
                //   带 transform 的绝对定位元素会让 Playwright 的点击命中检查失效
                //   （E2E「合并视图」用例超时实锤：top:0 能点、top:50%+translate 点不到，
                //   hover 同样失败）——按钮的真实位置与命中框必须一致。
                "absolute inset-y-0 right-0 my-auto transition-opacity",
                MOTION_SIZE,
                searchOpen ? "pointer-events-none opacity-0" : "opacity-100",
              )}
            >
              <SearchIcon data-icon="default" />
            </Button>
            {/* 输入框：展开淡入；关闭后再挂 TOOLBAR_MS 播完淡出才卸载（searchClosing，
                fill-mode-forwards 把 0 透明度保持到卸载帧，避免动画结束回弹可见）。
                宽度 = 区域宽（w-full）——区域随账号/写邮件收窄平滑变宽，所以搜索框的
                「向左弹出」与它们的收窄是同一段动画（不加固定最小宽，见下方注释） */}
            {(searchOpen || searchClosing) && (
              <SearchInput
                autoFocus
                value={qInput}
                onChange={(e) => setQInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") closeSearch();
                }}
                onBlur={() => {
                  // 失焦且为空 = 放弃搜索：与 Esc 同一语义（含清词 + 退场动画）
                  if (!qInput.trim()) closeSearch();
                }}
                placeholder={t("searchPlaceholder")}
                clearLabel={t("clearSearch")}
                className={cn(
                  "w-full",
                  !searchOpen && "pointer-events-none",
                  searchOpen ? "animate-in fade-in-0" : "animate-out fade-out-0 fill-mode-forwards",
                  MOTION_SIZE,
                )}
                aria-label={t("searchPlaceholder")}
              />
            )}
          </div>
          {/* 「全部标为已读」（2026-10-05）：范围 = 当前账号筛选（「全部账号」= 全部账号），
              方向 / 搜索 / 星标不参与（未读本质是收件箱概念，见 markAllRead 注释）。
              位置 = 行 1 右端簇的**最左位**（搜索 / 刷新 / 写邮件都不因此移位，保「点击位置
              稳定」）。⚠ 不能放行 2：英文下 Tabs + 两个开关已占 380/384，再挤一个 28px
              图标必然换行（实测 en free = 4px；「未读」开关旁的空间中文够、英文不够）。
              无未读时禁用（title 换成原因说明，避免「点了没反应」）
              ⚠ 「选择」（多选批量）2026-10-07 曾同挂这一簇的最左位，2026-10-08 用户要求
                搬到**行内悬浮气泡栏**：它每行都在，账号邮箱才不再被裁（见 ROW_FIXED_W）。
                **勿加回行 1**——这一簇每多一个 28px 图标，账号选择器就少 28px。 */}
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={markAllRead}
            disabled={markingAll || unreadTotal === 0 || view === "drafts"}
            aria-label={t("markAllRead")}
            title={view === "drafts" || unreadTotal === 0 ? t("markAllReadNone") : t("markAllRead")}
          >
            {markingAll ? <Spinner /> : <MailCheckIcon data-icon="default" />}
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={refresh}
            disabled={refreshing}
            aria-label={t("refresh")}
            title={t("refresh")}
          >
            {refreshing ? <Spinner /> : <RefreshCwIcon data-icon="default" />}
          </Button>
          {/* 「写邮件」：**只在搜索展开时**缩为纯图标（2026-10-05 定稿，二稿不再按行宽
              自适应——见上方「行 1 的宽度分配」）；搜索收起即恢复完整文字。
              ⚠ 2026-10-05 二稿（用户定稿「动画统一联动」）：收起/展开**不再瞬切**——
              同一结构 + 过渡：文字段用 grid 轨道 1fr↔0fr 折叠（纯 CSS 自动宽，无需测量）、
              按钮 gap 同步收到 0、文字 opacity 同步淡出；三者与账号的 max-width 共用
              MOTION_SIZE（300ms ease-out）⇒ 逐帧「可见文字宽 = 全宽 × opacity」，
              是和账号/搜索框同一段运动（见 components/mail/motion.ts）。
              ⚠ 收起态宽 = 边框 2 + 内边距 12 + 图标 14 = 28px，与搜索/刷新图标钮对齐；
              形状保留 sm 的 h-7 与 14px 图标，避免 icon-sm 让图标 14↔16 跳变。
              ⚠ 文字段用 overflow-hidden 裁切而非 `truncate`——省略号会在收窄过程里闪一下
              「…」（账号组件踩过同样的坑）。可访问名恒为链接内文字（收起时仍在 DOM、
              只是被 0 宽裁掉）→ E2E/读屏稳定。
              紧凑内边距（px-1.5/gap-1，完整态中文 ≈74 / 英文 ≈68px）是为 384px 行宽算过的，
              改前先重算行 1 */}
          <Link
            ref={composeRef}
            href="/mail/compose"
            data-slot="button"
            title={composeCompact ? t("compose") : undefined}
            className={cn(
              buttonVariants({ size: "sm" }),
              "gap-1 px-1.5 transition-[gap]",
              MOTION_SIZE,
              composeCompact && "gap-0",
            )}
          >
            <SquarePenIcon data-icon="default" />
            <span
              data-slot="compose-label"
              className={cn(
                "grid transition-[grid-template-columns]",
                MOTION_SIZE,
                composeCompact ? "grid-cols-[0fr]" : "grid-cols-[1fr]",
              )}
            >
              <span
                className={cn(
                  "overflow-hidden whitespace-nowrap transition-opacity",
                  MOTION_SIZE,
                  composeCompact ? "opacity-0" : "opacity-100",
                )}
              >
                {t("compose")}
              </span>
            </span>
          </Link>
        </div>
        {/* 第二行（视图 + 快捷筛选）：左侧下划线 Tabs「全部 / 收件 / 发件」（纯方向视图）；
            右侧两个独立开关「未读」「星标」（2026-10-05 微调，用户定稿：星标不再是视图，
            可与方向叠加；未读从筛选行上提到这里并承接未读计数）。
            ⚠ 计数在两个开关的可访问名之外：aria-hidden，E2E 按名字精确匹配；
            计数形态的取舍见下方「未读」开关的注释 */}
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
          {/* ⚠ 加了「垃圾」tab 之后（2026-10-08），384px 左栏在**英文**下放不下 5 个 tab
              + 右侧两个开关。做法（用户指定"空间不够时做成一个 V 型符号下拉"）：
              给 tab 条套一层 `@container` 量宽盒 + 末尾一个 chevron 下拉，装放不下的视图。

              ⚠ **只在 lg 及以上生效**（两条容器查询前面都挂了 `max-lg:`）：窄屏本来就走
                「整页单栏 + 换行」那套（行上的 `flex-wrap` 是那里的安全网），tab 全部显示、
                chevron 不出现；lg 起左栏固定 26rem、量宽盒是 `lg:flex-1`（宽度确定），
                容器查询才有意义——否则"宽度由内容决定、内容又由宽度决定"会互相打架
                （隐藏 tab → 内容变窄 → 更该隐藏，浏览器只保证一轮求解，结果不可预期）。
              ⚠ 阈值按 lg 下实测的两种宽度取（留给 tab 的宽度：中文 234px / 英文 193px；
                5 个 tab 实测占 232 / 272px）：草稿 13rem（208px）、垃圾 14rem（224px）。
                于是中文 5 个全显示、英文自动收成 3 个 + chevron（3 个 tab + chevron = 190px）。
                ⚠ 改 tab 或开关文案后必须重量：`node .cache/probe-junk-tabs.mjs` */}
          {/* ⚠ `@container` 也必须挂 `lg:`：`container-type: inline-size` 自带**尺寸containment**，
              盒子宽度从此不再由内容决定——窄屏（<lg）下它就缩成 flex 剩余宽、内容溢出到
              右侧开关上（2026-10-08 实测 390px：「垃圾」和「未读」糊在一起）。挂上 `lg:`
              后窄屏是一个普通 div，回到「内容撑开 + flex-wrap 换行」的老行为。 */}
          <div className="flex items-center lg:@container lg:min-w-0 lg:flex-1">
            <Tabs value={view} onValueChange={(v) => setView(v as ViewFilter)}>
              <TabsList variant="line" aria-label={t("viewSwitcherLabel")}>
                <TabsTrigger value="all">{t("filterAll")}</TabsTrigger>
                <TabsTrigger
                  value="received"
                  className="data-active:after:bg-emerald-600 dark:data-active:after:bg-emerald-400"
                >
                  {t("filterReceived")}
                </TabsTrigger>
                <TabsTrigger
                  value="sent"
                  className="data-active:after:bg-amber-600 dark:data-active:after:bg-amber-400"
                >
                  {t("filterSent")}
                </TabsTrigger>
                {/* 草稿箱（2026-10-06 用户指定）：不算入「全部」——草稿是独立数据源
                    （webmaild /drafts），不参与合并视图与未读统计 */}
                <TabsTrigger
                  value="drafts"
                  className="hidden max-lg:inline-flex @min-[13rem]:inline-flex"
                >
                  {t("filterDrafts")}
                </TabsTrigger>
                {/* 垃圾（2026-10-08 用户要求）：同样不算入「全部」；文件夹路径由服务端按
                    `\Junk` 探测（见 junkFolders），不算进任何方向视图 */}
                <TabsTrigger
                  value="junk"
                  className="hidden max-lg:inline-flex @min-[14rem]:inline-flex"
                >
                  {t("filterJunk")}
                </TabsTrigger>
              </TabsList>
            </Tabs>
            {/* 溢出下拉：只在 lg 且 tab 条放不下时出现。⚠ 宽 24px（`w-6`）——英文下
                只剩 3px 余量，用 28px 的 `size-7` 就溢出了。触发器只放图标：带上文字标签
                （如「草稿」）会把宽度撑到 80px 以上，英文那一档立刻放不下。
                当前视图若正好是被收起来的那个，chevron 转成前景色 + 菜单项打勾来提示 */}
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="ghost"
                    aria-label={t("moreViews")}
                    title={t("moreViews")}
                    aria-haspopup="menu"
                    className={cn(
                      "h-8 w-6 shrink-0 px-0 text-muted-foreground max-lg:hidden @min-[14rem]:hidden",
                      (view === "drafts" || view === "junk") && "text-foreground",
                    )}
                  >
                    <ChevronDownIcon className="size-4" aria-hidden />
                  </Button>
                }
              />
              <DropdownMenuContent align="start" className="w-auto min-w-28">
                {(["drafts", "junk"] as const).map((v) => (
                  <DropdownMenuItem key={v} onClick={() => setView(v)}>
                    {v === "drafts" ? t("filterDrafts") : t("filterJunk")}
                    {view === v && <CheckIcon className="ml-auto size-4" aria-hidden />}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          {/* 开关的「状态由图标本身承担」（2026-10-05 用户定稿，勿改回纯文字 chip——
              「未读」纯文字读不出开/关；也不用勾选框/开关组件，理由见 MAIL-AGENT.md 4.9）：
              未读 = 蓝点（亮起即开启，与头像未读点同色）；星标 = 星形线框 → 实心。
              ⚠ `multiple` 必须显式传：Base UI ToggleGroup 默认单选，不传则两开关互斥。
              ⚠ 值用「生效值」（2026-10-06 用户定稿，「垃圾」于 2026-10-10 第六轮加入）：
              「未读」在「发件」「草稿」「垃圾」禁用且显示为关——「发件」不可能有未读、
              「垃圾」里的未读不算收件箱未读（见 unseenActive 声明处） */}
          <ToggleGroup
            multiple
            value={[unseenActive ? "unseen" : "", flaggedActive ? "flagged" : ""].filter(Boolean)}
            onValueChange={(v) => {
              setUnseenOnly(v.includes("unseen"));
              setFlaggedOnly(v.includes("flagged"));
            }}
            aria-label={t("filterQuickLabel")}
          >
            <ToggleGroupItem
              value="unseen"
              size="sm"
              disabled={view === "drafts" || view === "sent" || view === "junk"}
              className="aria-pressed:bg-blue-600/10 aria-pressed:text-blue-700 dark:aria-pressed:bg-blue-400/15 dark:aria-pressed:text-blue-400"
            >
              <span
                aria-hidden="true"
                className="size-2 rounded-full bg-blue-600 opacity-25 transition-opacity group-aria-pressed/toggle:opacity-100 dark:bg-blue-400"
              />
              {/* 未读计数（2026-10-05 用户定稿二稿「无胶囊角标」）：数量 = 当前账号
                  筛选范围内 INBOX 未读之和（与底栏统计同口径 unreadTotal）；0 不渲染。
                  ⚠ 口径（2026-10-10 第六轮起）：**未读 = 收件箱未读**，全站只有一个「未读」
                  数字——角标 / 底栏 / 本开关 / 后端 `filter=unseen` 四处同一口径。此前
                  `filter=unseen` 是「任一副本无 \Seen」，把垃圾箱里的未读也算进来，于是
                  开关写 2、点开却列出 7 封（用户 2026-10-10 报障）。搜索词生效时本数字
                  仍是「账号范围内的收件箱未读」这个统计量（不是当前搜索结果数）——这是
                  「全站同一个数」方案的代价，已知并接受。
                  形态：与标签同栖一个行内流，`align-super` 抬成「未读」右上角的上标角标——
                  **不带括号、不带胶囊底、不指定颜色**（继承开关文字色：未按下 = 普通前景，
                  按下 = 随标签变蓝）——继承色同时意味着对比度与标签同档（白底 ≈13:1、
                  按下态 ≈5.9:1），无需单独校准。
                  ⚠ 与标签之间没有 flex gap（那是 flex 容器子节点的间距，只在同一行内流的
                  两个行内盒之间不生效）——包裹 <span> 让文本与计数成为一个流，仅给 2px 间距。
                  ⚠ aria-hidden：开关可访问名保持「未读」（E2E 按名字精确匹配；计数另有
                  底栏「未读 n」文本供读屏） */}
              <span className="whitespace-nowrap">
                {t("filterUnseen")}
                {unreadTotal > 0 && (
                  <span
                    data-slot="unseen-count"
                    aria-hidden="true"
                    className="ml-0.5 align-super text-xs leading-none tabular-nums"
                  >
                    {unreadTotal}
                  </span>
                )}
              </span>
            </ToggleGroupItem>
            <ToggleGroupItem value="flagged" size="sm" disabled={view === "drafts"}>
              <StarIcon className="transition-colors group-aria-pressed/toggle:fill-foreground" aria-hidden />
              {t("filterFlagged")}
            </ToggleGroupItem>
          </ToggleGroup>
        </div>
      </div>

      {/* 多选批量操作条（多选批量）：只在选择模式下出现，位于列表之上、不随列表滚动。
          「退出多选」就在这条栏的最右端（✕，单实例）；另有隐式出口：点列表空白处、按 Esc */}
      {selectMode && view !== "drafts" && (
        <MailBatchBar
          count={selected.size}
          total={items.length}
          busy={batchBusy}
          allSeen={allSeen}
          allUnseen={allUnseen}
          onMarkSeen={() => void batchFlags({ seen: true })}
          onMarkUnseen={() => void batchFlags({ seen: false })}
          onDelete={() => setBatchDeleteOpen(true)}
          onToggleAll={toggleAll}
          onExit={exitSelectMode}
        />
      )}

      {/*
       * 列表滚动区（4.12）：宽屏下**始终**填满面板剩余高度——面板高度只由视口决定，
       * 与「全部 / 未读 / 星标」筛出的邮件多少无关（曾随筛选结果长短伸缩，用户反馈）。
       * 空态与加载骨架也在这块里居中，故少邮件时面板不会缩成一小条。
       * 右侧滚动条自带在面板内边距之内，与面板边框留出一段边距。
       */}
      <div
        data-slot="mail-list-scroll"
        className="flex min-h-0 flex-col lg:flex-1 lg:overflow-y-auto"
      >
        {/* 加载态（2026-10-05 改）：骨架屏只用于**首次**加载；重载时保留旧列表并淡到 60%
            （与日历的更新中同一语言）——此前每次点 tab/开关都整个换成骨架、再换回来，
            用户报「列表闪烁抖动」；顺带把「加载中」的观感从「消失重来」变成「原地更新」 */}
        {view === "drafts" ? (
          // 草稿箱（2026-10-10 起：**服务商的草稿文件夹是唯一事实源**，本地表只是暂存 + 解析缓存）
          // - 先出本地缓存、再 `?refresh=1` 去服务端对一遍（手机写的草稿由此进来，见 loadDrafts）；
          // - 行点击进写信页继续编辑（站内打开时按需抓原文解析）；
          // - 30 天前的旧草稿收进折叠区（数据一封不少，只是不糊住当前在写的那几封）。
          drafts === null ? (
            <ListSkeleton />
          ) : visibleDrafts.length === 0 && olderVisible.length === 0 ? (
            <Empty>
              <EmptyMedia variant="icon">
                <FilePenLineIcon aria-hidden />
              </EmptyMedia>
              <EmptyHeader>
                <EmptyDescription>{q ? t("emptySearch") : t("emptyDrafts")}</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <>
              {(draftsSyncing || draftErrors.length > 0) && (
                <p
                  data-slot="drafts-sync-note"
                  className="mb-2 flex items-center gap-2 px-1 text-xs text-muted-foreground"
                >
                  {draftsSyncing ? (
                    <>
                      <Spinner /> {t("draftsSyncing")}
                    </>
                  ) : (
                    t("draftsCacheNote")
                  )}
                </p>
              )}
              <ul
                className="divide-y divide-border rounded-xl border border-border lg:rounded-none lg:border-0"
                data-slot="mail-draft-list"
              >
                {visibleDrafts.map(renderDraftRow)}
              </ul>
              {olderVisible.length > 0 && (
                <div className="mt-2">
                  <button
                    type="button"
                    data-slot="drafts-older-toggle"
                    aria-expanded={olderDraftsOpen}
                    onClick={() => setOlderDraftsOpen((o) => !o)}
                    className="flex items-center gap-1 rounded-md px-1 py-1 text-xs text-muted-foreground hover:text-foreground"
                  >
                    {olderDraftsOpen ? (
                      <ChevronDownIcon className="size-3.5" aria-hidden />
                    ) : (
                      <ChevronRightIcon className="size-3.5" aria-hidden />
                    )}
                    {t("draftsOlder", { count: olderVisible.length })}
                  </button>
                  {olderDraftsOpen && (
                    <ul
                      className="divide-y divide-border rounded-xl border border-border lg:rounded-none lg:border-0"
                      data-slot="mail-draft-list-older"
                    >
                      {olderVisible.map(renderDraftRow)}
                    </ul>
                  )}
                </div>
              )}
            </>
          )
        ) : loading && !hasLoadedRef.current ? (
          <ListSkeleton />
        ) : error ? (
          /*
           * 加载失败（2026-10-04 用户反馈）：只给友好文案 + 重试，
           * **不回显 `webmaild_unreachable` 这类内部错误码**（用户看不懂也没法处理），
           * 也不能退化成「暂无邮件」空态——那会让人以为真的没有邮件。
           * 全局服务健康由面板顶部的告警条负责，这里只解释「列表为什么空着」。
           */
          <Empty>
            <EmptyMedia variant="icon">
              <CircleAlertIcon aria-hidden />
            </EmptyMedia>
            <EmptyHeader>
              <EmptyTitle>{t("loadFailed")}</EmptyTitle>
              <EmptyDescription>{t("loadFailedHint")}</EmptyDescription>
            </EmptyHeader>
            <Button variant="outline" size="sm" onClick={reload}>
              <RefreshCwIcon data-icon="default" />
              {t("retry")}
            </Button>
          </Empty>
        ) : items.length === 0 ? (
          <Empty>
            <EmptyMedia variant="icon">
              <InboxIcon aria-hidden />
            </EmptyMedia>
            <EmptyHeader>
              <EmptyDescription>{q ? t("emptySearch") : emptyText}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ul
            ref={listRef}
            onKeyDown={onListKeyDown}
            aria-busy={loading || undefined}
            className={cn(
              "divide-y divide-border rounded-xl border border-border transition-opacity lg:rounded-none lg:border-0",
              loading && "opacity-60",
            )}
            data-slot="mail-list"
          >
          {items.map((m) => {
            const sent = isSentItem(m.copies);
            const dual = isDualDirection(m);
            return (
            <li key={m.messageId} className="group/row relative">
              <button
                type="button"
                data-mail-row
                aria-current={activeId === encodeMessageId(m.messageId) || undefined}
                aria-pressed={selectMode ? selected.has(m.messageId) : undefined}
                onClick={() =>
                  selectMode
                    ? toggleSelect(m.messageId)
                    : router.push(`/mail/message/${encodeMessageId(m.messageId)}`, mailNavOptions())
                }
                className={cn(
                  "flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-accent/50 focus-visible:bg-accent/50 focus-visible:outline-none",
                  activeId === encodeMessageId(m.messageId) && "bg-accent/60",
                )}
              >
                {/* 选择模式：行首一个复选框（纯视觉，勾选由整行按钮承担——触屏上点整行
                    比点 16px 的方框可靠得多；`aria-pressed` 在按钮上，读屏与 E2E 用它） */}
                {selectMode && <MailRowCheckbox checked={selected.has(m.messageId)} />}
                {/* 左列：发件人头像（每行都有，结构整齐）+ 两个角标，各占一角互不重叠：
                    - 右上 = 未读蓝点（勿改回 bg-primary 灰点、勿改回独立圆点列）
                    - 右下 = 方向角标（2026-10-04 用户定稿）：↙ 收件 / ↗ 发件，双向都标
                      （用户指定「收件也需要标记」）；徽章底中性，箭头按方向着色
                      （收件 emerald / 发件 amber，与 tab 下划线、agent 页徽章同色） */}
                <span className="relative shrink-0 self-center">
                  <Avatar>
                    <AvatarFallback>
                      {peerName(m).charAt(0).toUpperCase()}
                    </AvatarFallback>
                  </Avatar>
                  {!m.seen && (
                    <span
                      data-slot="mail-unread-badge"
                      aria-label={t("filterUnseen")}
                      className="absolute -top-0.5 -right-0.5 size-2.5 rounded-full bg-blue-600 ring-2 ring-background dark:bg-blue-400"
                    />
                  )}
                  <span
                    data-slot="mail-direction-badge"
                    data-direction={dual ? "both" : sent ? "sent" : "received"}
                    role="img"
                    aria-label={dual ? t("directionBoth") : sent ? t("filterSent") : t("filterReceived")}
                    className="absolute -right-1 -bottom-1 flex size-3.5 items-center justify-center rounded-full border border-border bg-background text-muted-foreground"
                  >
                    {dual ? (
                      /* 双向（收 / 发都是我的账号，2026-10-06 用户指定）：双色双向箭头——
                         同一枚 ArrowLeftRight 叠两次，**按横向中线**切（上支 = 收件色 / 下支 = 发件色），
                         每支箭头各自保持单色；整体再 **-45° 斜过来**，与单箭头角标同斜向
                         （转后 = 绿 ↙ 收件 + 橙 ↗ 发件，与 ArrowDownLeft / ArrowUpRight 一致）。
                         ⚠ 勿改回「按竖向中线」切：图标是上下两支箭头组成（上支 y∈[2,12]、
                            下支 y∈[12,22]，中线 y=12 恰好是两支之间的空白），竖向切会把
                            两支箭头各自劈成半绿半橙（绿头橙尾 / 橙头绿尾），14px 下像一张
                            颜色断开的坏图（2026-10-06 用户报障，截图取证后修正）。
                         ⚠ 旋转必须 -45°（逆时针）：+45° 会转成绿 ↖ / 橙 ↘，与「收到 ↙ /
                            发出 ↗」反向；转后两支箭头墨迹 9.2px、间距 5px，均在 12px 盒内不溢出 */
                      <span className="relative block size-3 -rotate-45" aria-hidden>
                        <ArrowLeftRightIcon
                          className="absolute inset-0 size-3 text-emerald-600 dark:text-emerald-400"
                          style={{ clipPath: "inset(0 0 50% 0)" }}
                        />
                        <ArrowLeftRightIcon
                          className="absolute inset-0 size-3 text-amber-600 dark:text-amber-400"
                          style={{ clipPath: "inset(50% 0 0 0)" }}
                        />
                      </span>
                    ) : sent ? (
                      <ArrowUpRightIcon className="size-2.5 text-amber-600 dark:text-amber-400" aria-hidden />
                    ) : (
                      <ArrowDownLeftIcon className="size-2.5 text-emerald-600 dark:text-emerald-400" aria-hidden />
                    )}
                  </span>
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline gap-2">
                    {/* 已读/未读三通道区分（勿只靠颜色）：未读 = 蓝角标 + 加粗 + 前景色时间；已读整行次要色退到背景。
                        ⚠ 首行名字位永远是「对方」：收件 = 发件人、发件 = 收件人（方向看头像角标，见 peerLabel） */}
                    <span className={cn("truncate text-sm", m.seen ? "text-muted-foreground" : "font-semibold")}>
                      {peerLabel(m)}
                    </span>
                    {accounts.length > 1 && (
                      <span
                        className="flex shrink-0 items-center gap-0.5"
                        title={m.accounts.map((id) => accountName(id)?.displayName ?? id).join("、")}
                      >
                        {m.accounts.map((id) => (
                          <span
                            key={id}
                            className={cn("inline-block size-1.5 rounded-full", accountDotProps(accountName(id)?.color ?? "").className)}
                            style={accountDotProps(accountName(id)?.color ?? "").style}
                          />
                        ))}
                      </span>
                    )}
                    {m.flagged && <StarIcon className="size-3.5 shrink-0 fill-foreground" aria-label={t("flagged")} />}
                    {m.hasAttach && <PaperclipIcon className="size-3.5 shrink-0 text-muted-foreground" aria-label={t("hasAttachment")} />}
                    <span
                      className={cn(
                        "ml-auto shrink-0 text-xs tabular-nums group-hover/row:invisible group-focus-within/row:invisible",
                        m.seen ? "text-muted-foreground" : "font-medium text-foreground",
                      )}
                    >
                      {formatDate(m.date, t("localeTag"))}
                    </span>
                  </span>
                  <span className={cn("block truncate text-sm", m.seen ? "text-muted-foreground" : "font-semibold")}>
                    {m.subject || t("noSubject")}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">{m.snippet}</span>
                </span>
              </button>
              {/* 行内快捷操作（4.9）：hover / 键盘聚焦时显现（日期同时让位）；
                  与行主按钮是兄弟节点，避免嵌套交互元素。
                  ⚠ 「选择」（多选批量）2026-10-08 按用户要求从工具栏行 1 **搬到这里**
                    （行 1 那 28px 挤掉了账号选择器里的邮箱地址）——**它只是入口**，
                    退出在批量条最右端那枚 ✕。
                  ⚠ **选择模式下整条气泡栏不渲染**（含这里的 ☑ 与星标/已读/删除）：此刻整行
                    点击 = 勾选，摆一排行内动作会打架。⚠ 曾试过「选中模式只留 ☑ 当出口」——
                    那个位置是 **per-row** 的：桌面端「点进来那行保有焦点 + 鼠标移到另一行」
                    会同时冒两枚，触屏端气泡栏常显、每行一枚（6 行 = 6 枚「退出多选」），
                    用户 2026-10-08 截图报障。单例动作必须挂在单例容器里。
                    ⚠ 用条件渲染而非 `hidden` 属性：`globals.css` 里那条
                    `[data-slot="mail-row-actions"][hidden] { display: none !important }`
                    已随之删除（类选择器优先级高于 `[hidden]` 的 UA 规则，属性写法压不住
                    hover），**别改回属性写法**。`@media (hover:none)` 的常显规则与结构无关，
                    仍然有效（触屏上这条气泡栏一直可见，也是触屏进多选的入口） */}
              {!selectMode && (
                <span
                  data-slot="mail-row-actions"
                  className="absolute top-2 right-3 hidden items-center gap-0.5 rounded-lg border border-border bg-background p-0.5 shadow-sm group-hover/row:flex group-focus-within/row:flex"
                >
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t("batchEnter")}
                    title={t("batchEnter")}
                    onClick={() => setSelectMode(true)}
                  >
                    <SquareCheckBigIcon />
                  </Button>
                  {/* 分隔线：把「选择」（模式的开关，作用于整张列表）与后三个**作用于本行**
                      的动作分开——否则四枚图标并排，☑ 会被读成「第四个行内动作」。
                      形态抄批量条里「计数 | 动作」那道分隔线（h-4 w-px bg-border） */}
                  <span className="h-4 w-px shrink-0 bg-border" aria-hidden />
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={m.flagged ? t("unflag") : t("flag")}
                    aria-pressed={m.flagged}
                    onClick={() => postFlags(m, { flagged: !m.flagged })}
                  >
                    <StarIcon className={cn(m.flagged && "fill-foreground")} />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={m.seen ? t("markUnread") : t("markRead")}
                    onClick={() => postFlags(m, { seen: !m.seen })}
                  >
                    {m.seen ? <MailOpenIcon /> : <MailIcon />}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t("delete")}
                    onClick={() => setPendingDelete(m)}
                  >
                    <Trash2Icon />
                  </Button>
                </span>
              )}
            </li>
            );
          })}
          </ul>
        )}

        {/* 无限滚动哨兵 + 「加载更多」兜底：随列表一起滚（不再固定在外壳底部）。
            ⚠ **哨兵常驻**（外层只判 `next`，**不判 `loading`**）：它一旦被 `loading` 卸载重建，
              IntersectionObserver 就会盯着旧节点失效（→ 无限滚动静默死掉，见上方「无限滚动」）。
              只有「加载更多」按钮跟随 `loading` 隐藏（重载期间列表在换，按钮没有意义）。 */}
        {pagedNext && (
          <div className="flex shrink-0 flex-col items-center gap-2">
            <div ref={setSentinelNode} className="h-px w-full" aria-hidden />
            {!loading && (
              /*
               * ⚠ 这一枚的观感有两条硬约束（2026-10-09 用户在真实浏览器里报「滚动到底弹出加载提示
               *   时先是深黑、再变浅灰，还叠影/卡顿」）：
               *   ① **不许用基类的 `disabled:opacity-50` 渐隐**：基类还带 `transition-all`，于是
               *      「1 → 0.5」的渐隐会被真的画出来（实测 opacity 1 → 0.82 → 0.5）——ghost 按钮
               *      本是透明底 + 近黑文字，看起来就是「深黑转浅灰」；`transition-colors` 只留
               *      颜色过渡，`disabled:opacity-100` 保住不透明度（禁用语义仍由 `disabled` 给）。
               *   ② **图标槽必须常驻、尺寸固定，但空闲时里面什么都不放**：旧写法
               *      `{loadingMore ? <Spinner/> : null}` 是条件插入第一个子节点 → 按钮宽度
               *      78 → 98px，又因 `items-center` 居中，x 跟着左跳 10px（实测 330.5 → 320.5）。
               *      续页快时 150ms 过渡被反复打断，深色图标与浅灰中间态同屏 = 用户说的
               *      「相互叠加」。现在槽位（14px）**永远在布局里**：空闲留白、加载时原地换成
               *      `Spinner` → 按钮盒子与文案位置**一格都不动**。
               *      ⚠ 空闲槽里**不要放任何图标**（2026-10-09 用户实测）：先放过一枚 `ChevronDownIcon`
               *      表示"下面还有"，用户看到的就是「加载完了这枚 ⌄ 怎么还在」——它会被当成
               *      "卡住的加载指示"。留白虽然让按钮比原来宽 34px，但按钮是 ghost（无底色边框），
               *      看不出盒子，只有文案的位置要紧。
               *   ③ **`pr-7`（28px）不是随手写的**：左侧固定开销 = `pl-2.5`(10) + 槽(14) + `gap-1`(4)
               *      = 28px。右内边距给同样的 28px，文案才真正居中（否则会偏右 9px，实测
               *      「文案中心 − 列中心 = +9px」）。且槽位永远占位、只换内容 → 空闲/加载两态
               *      文案位置**逐像素相同**（实测两态 rect 完全一致）。
               */
              <Button
                variant="ghost"
                size="sm"
                data-slot="mail-load-more"
                aria-busy={loadingMore || undefined}
                onClick={loadMore}
                disabled={loadingMore}
                className="pr-7 transition-colors disabled:opacity-100"
              >
                <span className="flex size-3.5 shrink-0 items-center justify-center" aria-hidden>
                  {loadingMore && <Spinner className="size-3.5" />}
                </span>
                {t("loadMore")}
              </Button>
            )}
          </div>
        )}
      </div>

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && setPendingDelete(null)}
        title={t("deleteConfirmTitle")}
        description={t("deleteConfirmBody")}
        confirmLabel={t("delete")}
        pending={deleting}
        onConfirm={doDelete}
      />

      {/* 批量删除确认：与单条删除同一套站内确认弹窗（破坏性操作不用原生 confirm） */}
      <ConfirmDialog
        open={batchDeleteOpen}
        onOpenChange={setBatchDeleteOpen}
        title={t("batchDeleteTitle", { count: selected.size })}
        description={t("batchDeleteBody")}
        confirmLabel={t("delete")}
        pending={batchBusy}
        onConfirm={() => void batchDelete()}
      />

      {/* 草稿删除确认（草稿箱行内删除；破坏性操作不用原生 confirm） */}
      <ConfirmDialog
        open={pendingDraftDelete !== null}
        onOpenChange={(open) => !open && setPendingDraftDelete(null)}
        title={t("deleteDraftConfirmTitle")}
        description={t("deleteDraftConfirmBody")}
        confirmLabel={t("deleteDraft")}
        pending={deletingDraft}
        onConfirm={doDeleteDraft}
      />
    </div>
  );
}
