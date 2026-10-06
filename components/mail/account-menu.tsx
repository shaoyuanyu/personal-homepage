"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { CheckIcon, ChevronDownIcon } from "lucide-react";
import { useTranslations } from "next-intl";

import { cn } from "@/lib/utils";
import { accountDotProps } from "@/components/mail/account-dot";
import { accountLabel } from "@/components/mail/account-label";
import { MOTION_SIZE, TOOLBAR_MS } from "@/components/mail/motion";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { MailAccount } from "@/lib/mail/types";

/** SSR 安全的 layout effect（服务端渲染退化为 useEffect）——数据到货时把 labelW 的
 *  重测提前到 paint 之前，见下方测量 effect 的注释 */
const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/**
 * 账号选择下拉（2026-10-05 用户定稿，A 方案：工具行留在左侧栏）：单选——「全部账号」或某个账号。
 *
 * 显示格式（2026-10-05 用户定稿）：
 * - **触发器**：具体账号 = 两行（上行账号名、下行邮箱，text-xs 弱化色、无 `<>` 包裹）——
 *   横向只占「两行中最宽的行」，比单行 `名<邮箱>` 省 ≈28px；「全部账号」= 单行 +
 *   字号放大一档（text-base）、垂直居中在固定的 h-9 里（切换账号工具栏高度不变）；
 * - 菜单项、底栏悬浮提示、写邮件页发件账号选择沿用单行 `accountLabel()`（`名<邮箱>`）——
 *   那些是紧凑列表 / 提示场景，两行会变笨重。
 *
 * ⚠ 宽度预算：触发器宽由外层通过 `maxW` 算好传进来（行宽 − 固定开销 − 写邮件完整态宽），
 *   **不要在这里写死 max-w 类**——它同时是 flex-wrap 的换行闸门（超了会把「写邮件」
 *   挤到第二行，2026-10-05 实测过），而写邮件宽是语言相关的（中文「写邮件」74px；英文
 *   原 Compose 95px、同日改名 Write 后 68px），写死常量必然在某一语言下算错。实测参考：
 *   行 1 = 384px 时两行版 `我 / me@mail.shaoyuanyu.cn` 触发器自然宽 198（文本 145 + 装饰
 *   53）+ 写邮件（中文 74 / 英文 68）+ 固定开销 108 ≤ 384 —— 两种语言都完整放得下；只有
 *   窄屏（行宽 ≈313px）才会截断账号邮箱（写邮件文字保持完整，2026-10-05 定稿的优先级）。
 * - 触发器的邮箱行用 text-xs + text-muted-foreground（小一档 + 弱化色）：天然形成
 *   「主名 + 次地址」层级，且截断时两行各自 truncate； * ⚠ 触发器左内边距是 pl-0.5（2026-10-05 用户定稿）：比 Button 默认的 px-2.5 小，
 *   目的是让「全部账号」的文字左缘与下方行 2 的「全部」tab（px 更窄）对齐——
 *   实测原状两者字号相同（14px）但左缘差 8px，上下看起来别扭；改 padding 而非字号。 * - `collapsed`（搜索展开时）：名称段收到 `collapsedLabelW`（**动态**：名字实际宽
 *   与 4 字取小 + 色点/余量，1-2 字不留空），邮箱行淡出压扁（见 AccountText）——
 *   截断名」，邮箱行淡出压扁）——2026-10-05 用户定稿，替换了早期的「头像框」
 *   （与列表头像不一致且丑，照搬列表头像也不合适）。宽度过渡由外层 max-width 驱动，
 *   搜索框「展开」的动效就是它（见 mail-client 行 1）——
 *   ⚠ 因此账号 Button **不能用 flex-1**（宽度会被 flex 锁定、动画失效），只能靠
 *   `max-w-54` 限住 hypothetical 宽来保证不换行；
 * - 菜单项带色点与未读数；状态永远可见（触发器就是当前值）。
 *
 * 宽度分配（2026-10-05 定稿）：触发器装配宽度由外层 `maxW` 决定（行宽 − 固定开销 −
 * 写邮件完整态宽）——装不下时**截断账号**（两行各自 truncate，完整值在悬浮 title 与
 * 下拉菜单里），「写邮件」保持完整。⚠ 原「按需求宽把写邮件缩为图标」的自适应规则已
 * 整体移除（二稿）：两行版账号把需求宽降到 198px 后中文天然放得下，规则只剩英文触发
 * （时名 Compose 95px），表现为写邮件常驻图标态、搜索取消也不恢复（用户两次报障后弃用；
 * 英文文案同日改 Write 68px，两种语言均完整放得下）。
 */
export function AccountMenu({
  accounts,
  value,
  onChange,
  collapsed,
  maxW,
  allLabel,
  extraItems,
  collapsedNameMaxPx,
  countOverride,
  accountName,
}: {
  accounts: MailAccount[];
  /** "all" 或账号 id（含 extraItems 里的档位值） */
  value: string;
  onChange: (value: string) => void;
  /** 搜索展开时压缩为紧凑形态 */
  collapsed?: boolean;
  /** 触发器 max-width（px；外层按行宽算出） */
  maxW?: number;
  /** 「全部」档的文案（默认「全部账号」；联系人面板传「全部联系人」） */
  allLabel?: string;
  /** 「全部」之后、账号之前插入的额外单选档（联系人面板的「本地联系人」：
   *  value `@local`、label「本地联系人」；单行形态、无色点、不显示账号数） */
  extraItems?: { value: string; label: string }[];
  /** 收窄态名字的最大宽度（px）；默认 4 个汉字。「全部联系人」是 5 字，放宽到 64 才完整 */
  collapsedNameMaxPx?: number;
  /** 「全部」档的计数（默认 = 账号数量）；联系人面板传联系人总数，
   *  否则「全部联系人 (1)」的 (1) 会被读成「1 个联系人」（实际是账号数，语义错位） */
  countOverride?: number;
  /** 账号档名称的自定义格式化（默认 displayName||email）；联系人面板传「{名}的联系人」
   *  ——只换名字，邮箱行照旧（邮箱仍在 title / 菜单里） */
  accountName?: (account: MailAccount) => string;
}) {
  const t = useTranslations("mail");
  const current = accounts.find((a) => a.id === value) ?? null;
  /** 额外单选档（联系人面板的「本地联系人」）：命中时与「全部」同形态（单行、无邮箱行） */
  const extra = extraItems?.find((i) => i.value === value) ?? null;
  /** 「全部」档的文案（默认「全部账号」；联系人面板传「全部联系人」） */
  const all = allLabel ?? t("filterAllAccounts");
  /** 单行标题（title / 悬浮用）：`名<邮箱>` 形式，菜单与底栏同源（accountLabel） */
  const label = current ? accountLabel(current) : (extra?.label ?? all);
  /**
   * 触发器两行文案（2026-10-05 用户定稿）：上行账号名、下行邮箱（不再用 `<>`——
   * 两行布局天然分开两者，横向省出「名字 + 尖括号」≈ 28px）。
   * 无备注名时上行直接是邮箱、下行空；「全部」与额外档位时上行是它、下行空（高度恒定）。
   * ⚠ accountName 只替换上行名字（联系人面板「我的联系人」），下行邮箱行**照旧显示**
   * ——用户 2026-10-05 明确：改的是名字，邮箱不能因此消失。
   */
  const name = current
    ? accountName
      ? accountName(current)
      : current.displayName || current.email
    : (extra?.label ?? all);
  // 邮箱行：只有「无备注名的账号」（上行本身就是邮箱）才省略，避免上下重复
  const email = current && current.displayName ? current.email : "";
  const countValue = countOverride ?? accounts.length;
  const dot = accountDotProps(current?.color ?? "");
  // 展开 / 压缩两态都是同一段过渡：max-width + 字号 + 高度 —— 曲线与时长统一走 MOTION_SIZE / MOTION_TEXT（motion.ts）

  // 宽度探针：量完整文案的固有宽（absolute + invisible，不参与布局）——
  // 自用：名称段的 max-width 展开终值（labelW）。
  // ⚠ 色点只在选中具体账号时渲染（「全部账号」没有）：两处宽度都要按实际结构算——
  //   多算的 14px 会变成过渡「空转」直接表现为反弹（2026-10-05 逐帧采样实测 +4px 峰）。
  const probeRef = useRef<HTMLSpanElement>(null);
  const nameProbeRef = useRef<HTMLSpanElement>(null);
  const [labelW, setLabelW] = useState(0);
  const [nameW12, setNameW12] = useState(0);
  const hasDot = !!current;
  // ⚠ 用 layout effect（不是普通 effect）：计数（(n)）异步到货时，要在 **paint 之前**
  //   把 labelW 重测到「含计数」的值——否则「(1)」插入名称段的同一帧会把名字挤到
  //   「max-width − 计数宽」（59px）并上屏一帧，用户看到「全部联...」闪现
  //   （2026-10-05 用户报「先显示『全部联...』再显示『全部联系人』」的一半根因）。
  useIsoLayoutEffect(() => {
    const el = probeRef.current;
    if (!el) return;
    const inset = hasDot ? LABEL_INSET_PX : 0;
    const report = () => {
      const w = el.offsetWidth;
      // ⚠ `w === 0` = 不可测场景（display:none 下的挂载：直达 /mail/compose 时 MailClient
      //   整体被隐藏）——**保留旧值，勿写入 2px 的塌缩**（labelW = 0 + inset + 2 → 名称段
      //   max-width 2px → 触发器塌成 41px、名字被裁；用户报「邮箱 ⇄ 写邮件往返后账号组件
      //   出问题」的根因）。labelW 为 0 时名称段不设 max-width（自然宽），与量到真值等价。
      if (w === 0) return;
      setLabelW(w + inset + TRIGGER_SPARE_PX);
      const nameW = nameProbeRef.current?.offsetWidth ?? 0;
      if (nameW > 0) setNameW12(nameW);
    };
    report();
    // 字体加载完成后重测（Inter 未就绪时量出的文字宽偏小）
    void (document.fonts?.ready ?? Promise.resolve()).then(report).catch(() => {});
    // ⚠ countValue 必须在依赖里：探针装有计数段（「(n)」≈30px），而计数是异步到货的
    //   （账号列表 / 联系人总数都是 fetch 后才有）——不重测的话 labelW 停在「不含计数」
    //   的旧值，名称段 max-width 少 30px，「全部联系人 (n)」会被裁成「全部…」
    //   （2026-10-05 联系人面板实测）。邮箱状态此前只是靠字体 effect 的时序侥幸未暴露。
  }, [label, hasDot, countValue]);

  /**
   * 收起态（搜索展开时）名称段的宽度上限：**min(名字实际宽, 4 字) + 色点/间距 + 余量**。
   * 2026-10-05 用户定稿：1-2 字的名字只占自己的宽（不留 4 字的空）；微信名等
   * 超过 4 字的截到 4 字（名字 12px × 4 = 48）。
   */
  const collapsedNameMax = collapsedNameMaxPx ?? COLLAPSED_MAX_NAME_PX;
  const collapsedLabelW =
    Math.min(nameW12 || collapsedNameMax, collapsedNameMax) +
    (hasDot ? LABEL_INSET_PX : 0) +
    TRIGGER_SPARE_PX;

  /**
   * 「过渡进行中」标记（2026-10-05 定稿）：仅在 `collapsed` 变化后的 TOOLBAR_MS 内为真，
   * 邮箱行据此把 `text-ellipsis` 摸掉（留纯裁切）——见 AccountText 里的说明。
   * ⚠ 用计时器而不是 onTransitionEnd：事件会被子元素冒泡干扰，且过渡被打断时可能永远
   *   不触发（卡死成「永远没有省略号」）；计时器每次状态变化都重新武装，不会卡。
   */
  const [animating, setAnimating] = useState(false);
  // ⚠ 开启时机必须与 collapsed 的变化**同一次渲染**（不能放 effect 里——effect 在 paint
  //   之后，那一次渲染没有过渡类 → 收窄会瞬跳而不是动画）。用渲染期派生（React 官方
  //   「根据 props 调整 state」模式）：diff 到变化 → 本组件立即重渲染（paint 之前）。
  const [prevCollapsed, setPrevCollapsed] = useState(collapsed);
  if (prevCollapsed !== collapsed) {
    setPrevCollapsed(collapsed);
    setAnimating(true);
  }
  useEffect(() => {
    if (!animating) return;
    const timer = window.setTimeout(() => setAnimating(false), TOOLBAR_MS + 40);
    return () => window.clearTimeout(timer);
  }, [animating]);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            aria-label={t("filterAccountLabel")}
            title={label}
            className="h-9 min-w-0 shrink pl-[9px]"
            style={maxW ? { maxWidth: `${maxW}px` } : undefined}
          >
            {/* 名称段（色点 + 账号文案）：展开态上限 = labelW（自然宽）；收起态（搜索展开时）
                收到 collapsedLabelW（动态：名字实际宽与 4 字取小 + 色点），邮箱行同时淡出
                并压扁（见 AccountText）。
                ⚠ max-width 的展开终值必须是**自然宽**而非固定大值：终值远大于自然宽时
                过渡前段是「空转」→ 宽度先弹后收（2026-10-05 用户报「反复反弹」，
                逐帧采样证实 100→113→64）。用自然宽后总宽数学上严格单调 */}
            <span
              className={cn(
                // ⚠ max-width 用 MOTION_SIZE（无 overshoot 的 ease-out，见 motion.ts）：
                //   弹簧曲线的 overshoot 会让收缩冲过目标值（如 28 → 短暂 21），名字行
                //   可用宽只剩 7px，12px 的名字被裁出省略号 → 回弹后才恢复（2026-10-05
                //   用户报的「先闪 `...` 再缩」的最后一层，逐帧采样实证 nameOverflow 4 帧）。
                //   字号也走 MOTION_SIZE（同曲线）——展开时字号若抢先到位，容器还差 2~3px
                //   会裁出 1 帧省略号（2026-10-05 close 第 9 帧实测）；同曲线则余量逐帧恒定。
                "flex min-w-0 items-center gap-1.5",
                // ⚠ 过渡只在「collapsed 切换动画窗口」（animating）里开：常开的话，**数据
                //   到货导致的 labelW 变化**（82 → 105，计数进预算）也会被动画化——名字
                //   从 59px 用 300ms 爬回 80px，视觉上就是「先『全部联...』再慢慢变全」
                //   （2026-10-05 用户报的后一半根因）。非动画窗口里 maxWidth 瞬跳，配合
                //   layout-effect 重测 → 裁切一帧都不上屏。
                animating && "transition-[max-width]",
                animating && MOTION_SIZE,
              )}
              style={{ maxWidth: collapsed ? collapsedLabelW : labelW || undefined }}
            >
              {current && (
                <span className={cn("size-2 shrink-0 rounded-full", dot.className)} style={dot.style} aria-hidden />
              )}
              {/* 名称 + 数量：两者之间**不用 flex gap**——「(n)」自带的 NBSP 前缀
                  必须随它一起折叠（见 AccountCount），否则收起态会残留 6px 把名字裁掉 */}
              <span className="flex min-w-0 items-center">
                <AccountText name={name} email={email} collapsed={collapsed} animating={animating} />
                {!current && !extra && countValue > 0 && (
                  <AccountCount count={countValue} collapsed={collapsed} />
                )}
              </span>
            </span>
            <ChevronDownIcon data-icon="default" className="shrink-0 text-muted-foreground" aria-hidden />
            {/* 测量探针：完整文案固有宽（invisible + absolute，不进布局、不可见；aria-hidden
                保证不影响可访问名，data-slot 供调试/E2E 排除）。
                ⚠ `[&_*]:transition-none` 是必需的：探针里的文案带 transition-[font-size]，
                 而两行/单行两种形态字号不同（14 ↔ 16px）——切换账号时过渡会让 offsetWidth
                 读到「过渡起始帧」的旧值：labelW 被写成偏小的 58（= 4×14+2，而 16px 的
                 「全部账号」需要 66）且不再更新，真实名称段随即被裁成「全部…」
                 （2026-10-05 实测：我 → 全部账号 后触发）。测量工具不参与动画。 */}
            <span
              ref={probeRef}
              aria-hidden
              data-slot="account-label-probe"
              className="pointer-events-none invisible absolute flex items-center whitespace-nowrap [&_*]:transition-none"
            >
              <AccountText name={name} email={email} />
              {/* 数量要一起量进宽度预算（探针永远按展开态量，不传 collapsed） */}
              {!current && !extra && countValue > 0 && <AccountCount count={countValue} />}
            </span>
            {/* 12px 名字探针（收起态宽度用，字号与 AccountText 收起态一致；
                同样禁用过渡——它也是测量工具） */}
            <span
              ref={nameProbeRef}
              aria-hidden
              className="pointer-events-none invisible absolute whitespace-nowrap text-xs [&_*]:transition-none"
            >
              {name}
            </span>
          </Button>
        }
      />
      <DropdownMenuContent align="start" className="w-auto min-w-56 max-w-[32rem]">
        {/* ⚠ 用普通菜单项 + 自绘勾选，**勿用 DropdownMenuRadioGroup/RadioItem**：
            项目实测（真实 Chromium，2026-10-05）RadioItem 选择后，触发器的下一次
            点击会被 Base UI 内部吞掉（菜单开→立即 cancelOpen 关闭，重开失效一次）——
            普通菜单项无此问题，站内其它菜单（主题 / 我的）也全是普通项。
            功能等价：点选即关闭、当前项右侧打勾。 */}
        <DropdownMenuItem onClick={() => onChange("all")} className="pr-6">
          {all}
          {value === "all" && <MenuCheck />}
        </DropdownMenuItem>
        {(extraItems ?? []).map((item) => (
          <DropdownMenuItem key={item.value} onClick={() => onChange(item.value)} className="pr-6">
            <span className="min-w-0 truncate">{item.label}</span>
            {value === item.value && <MenuCheck />}
          </DropdownMenuItem>
        ))}
        {accounts.map((a) => {
          const d = accountDotProps(a.color);
          return (
            <DropdownMenuItem
              key={a.id}
              onClick={() => onChange(a.id)}
              title={accountLabel(a)}
              className="pr-6"
            >
              <span className={cn("size-2 shrink-0 rounded-full", d.className)} style={d.style} aria-hidden />
              <span className="min-w-0 truncate">{accountLabel(a)}</span>
              {a.unread ? (
                <span className="ml-auto shrink-0 text-xs tabular-nums text-muted-foreground">
                  {a.unread}
                </span>
              ) : null}
              {value === a.id && <MenuCheck />}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * 本组件的动效曲线已收敛到 `components/mail/motion.ts`（2026-10-05 用户定稿：
 * 工具栏统一联动）——**字号与尺寸/透明度用同一条 ease-out**。
 * 为什么要同曲线：容器宽与文本宽是比例关系，只有 f(t) 相同，「容器宽 − 内容宽」才逐帧
 * 恒定（2px 余量永远够用）；字号抢先或落后都会在某一方向裁出 1~2 帧省略号。
 * 历史教训（三次「先闪 `...` 再缩」）：① 邮箱行淡出不同步（visibility 改瞬变修复）；
 * ② 字号与宽度曲线不同步（统一曲线修复）；③ 宽度 overshoot（换无过冲曲线修复）。
 */

/** 名称段内部缩进：色点 8 + 点与文字间距 6（探针只量文本；max-width 终值要含这两段） */
const LABEL_INSET_PX = 14;

/**
 * 收起态（搜索展开时）名字的字号与宽度上限（2026-10-05 用户定稿）：字号缩小一档到
 * 12px（AccountText 收起用 text-xs）；宽度上限 = 4 个汉字（12 × 4 = 48，使「全部账号」
 * 恰好完整）。⚠ 实际收起宽是**动态**的：`min(名字实际宽, 48) + 色点 + 余量`——
 * 1-2 字的名字只占自己的宽（不留 4 字的空），由 nameW12 探针实测。
 */
const COLLAPSED_NAME_FONT_PX = 12;
const COLLAPSED_MAX_NAME_PX = COLLAPSED_NAME_FONT_PX * 4;

/**
 * 亚像素余量（2026-10-05 用户报「右侧有空间却截断」后加）：`offsetWidth` / `scrollWidth`
 * 都是**取整**值，而 `text-overflow: ellipsis` 在**亚像素溢出**时也会吃掉一整个字符换成
 * 省略号（视觉上像「差好几个字符」）——labelW 与需求宽都留 2px 余量，不让文本卡在临界。
 */
const TRIGGER_SPARE_PX = 2;

/** 当前项勾选（右侧绝对定位，与 shadcn 的项指示器同位；aria-hidden，语义由触发器承担） */
function MenuCheck() {
  return (
    <span className="pointer-events-none absolute right-2 flex items-center" aria-hidden>
      <CheckIcon className="size-4" />
    </span>
  );
}

/**
 * 「全部账号 (n)」的数量段（2026-10-05 用户定稿，替换掉此前挂在按钮右上角的角标）。
 *
 * ⚠ 用与写邮件文字段同款的「grid 轨道 1fr↔0fr + 透明度」收放，**不能**在收起时直接卸载：
 *   触发器宽度由**内容**驱动（见 labelW 的说明）——内容瞬间少一截会让宽度瞬跳，
 *   搜索框「向左弹出」的联动动画就断了。轨道与透明度同曲线同窗口 ⇒
 *   可见宽 = 全宽 × opacity，仍是同一段运动（见 motion.ts）。
 * ⚠ 前缀 NBSP（`\u00A0`）必须写在**内层**（跟着轨道一起折叠）：若用 flex gap 或 padding
 *   做间距，收起后会残留一段宽度，把收起态的名字挤出省略号（收起上限 4 字，余量只有 2px）。
 * ⚠ 数量必须同时出现在**测量探针**里（AccountMenu 的探针分支），否则 labelW 量不到它，
 *   展开态会被 max-width 裁掉（同日修过同类的「全部…」截断 bug）。
 */
function AccountCount({ count, collapsed }: { count: number; collapsed?: boolean }) {
  return (
    <span
      data-slot="account-count"
      className={cn(
        "grid shrink-0 transition-[grid-template-columns]",
        MOTION_SIZE,
        collapsed ? "grid-cols-[0fr]" : "grid-cols-[1fr]",
      )}
    >
      <span
        className={cn(
          "overflow-hidden whitespace-nowrap text-base text-muted-foreground transition-opacity",
          MOTION_SIZE,
          collapsed ? "opacity-0" : "opacity-100",
        )}
      >
        {`\u00A0(${count})`}
      </span>
    </span>
  );
}

/**
 * 触发器内的账号文案（2026-10-05 用户定稿）：
 * - 具体账号（有备注名）= **两行**：上行账号名（主字号）、下行邮箱（text-xs 弱化色，
 *   不再用 `<>` 包裹——两行布局天然分开两者）；
 * - 无邮箱的形态（「全部账号」、或没填备注名的账号——那时 name 本身就是邮箱）= **单行**：
 *   字号放大一档（text-base）——只占一行时若仍用 14px，在 36px 高的按钮里会显得
 *   又小又浮在上面（用户定稿：单行 + 加大 + 垂直居中）。
 * ⚠ 收起态（collapsed，搜索展开时）：字号缩小一档（14/16 → 12，font-size 过渡）
 *   并截断到 ≤ 4 个汉字（外层 maxWidth 由 collapsedLabelW 动态限制，4 字上限使
 *   「全部账号」恰好完整）；邮箱行同时**淡出并把高度压到 0**（h-4 → h-0 过渡），
 *   使名字行平滑上移、单行居中——而不是被外层 max-width 裁出「半截邮箱」。
 * ⚠ 按钮高度 h-9 固定：单行 / 两行内容都在其中垂直居中，**切换账号不改变工具栏高度**。
 * ⚠ 菜单项不用这个组件（菜单是紧凑单行列表，继续用 `accountLabel()` 的 `名<邮箱>`）。
 */
function AccountText({
  name,
  email,
  collapsed,
  animating,
}: {
  name: string;
  email?: string;
  collapsed?: boolean;
  /** 过渡进行中：邮箱行去掉省略号（纯裁切，见下方注释） */
  animating?: boolean;
}) {
  if (!email) {
    return (
      <span
        className={cn(
          "min-w-0 truncate text-base transition-[font-size]",
          MOTION_SIZE,
          collapsed && "text-xs",
        )}
      >
        {name}
      </span>
    );
  }
  return (
    <span className="flex min-w-0 flex-col items-start text-left leading-tight">
      <span
        className={cn(
          "w-full truncate text-sm transition-[font-size]",
          MOTION_SIZE,
          collapsed && "text-xs",
        )}
      >
        {name}
      </span>
      <span
        data-slot="account-email"
        className={cn(
          // ⚠ 过渡期间用「纯裁切」（overflow-hidden + nowrap、不带省略号）：展开/收起的中途
          //   容器必然比邮箱窄（邮箱就是最宽的那行——容器要到 t≈270ms 才装得下它），
          //   `truncate` 会在这段时间闪出「…」——被裁的字符是「还没长出来」而不是「被截断」；
          //   硬裁切读起来是擦除式揭示（wipe，右缘随容器一起移动），省略号读起来是坏数据。
          //   过渡结束后恢复 `text-ellipsis`：那时若真被裁（长邮箱 + 窄行预算）该显示省略号。
          "w-full overflow-hidden whitespace-nowrap text-xs leading-4 text-muted-foreground transition-[height,opacity]",
          MOTION_SIZE,
          !animating && "text-ellipsis",
          // ⚠ `invisible`（visibility）必须**瞬变**（不在 transition 列表里）：收起时宽度
          //   收缩（ease 前段快）会在 ~50ms 内就把邮箱裁出省略号，而它自己的淡出要 300ms——
          //   不同步会出现「先闪一个 `...` 再消失」（2026-10-05 用户报）。visibility 立即
          //   置 hidden 后，它仍保留布局宽（撑住外层 max-width 过渡的收缩动画），但不可见。
          collapsed ? "invisible h-0 opacity-0" : "h-4 opacity-100",
        )}
      >
        {email}
      </span>
    </span>
  );
}
