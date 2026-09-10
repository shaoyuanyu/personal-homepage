/**
 * 「期刊会议速查」（Venue Explorer）数据整合层。
 *
 * 把三份独立数据源合并为两套可联合检索的行：
 * - 会议：CCF 推荐会议 ∪ ccfddl 收录会议（deadlines）
 *   连接键 = 缩写（大小写不敏感）；ccfddl 侧贡献截稿时间线 / 会期 / 地点 / 官网。
 * - 期刊：中科院计算机大类期刊 ∪ CCF 推荐期刊
 *   连接键 = 确定性规范化刊名（小写、去前导 The、& → and、去标点折叠）。
 *   只做精确等值匹配，杜绝模糊匹配误配（曾验证过 token 嵌入会张冠李戴，
 *   如 The Computer Journal 被嵌入匹配到 Future Generation Computer Systems）。
 *
 * 纯数据模块：构建期一次性执行；搜索评分等交互逻辑在客户端组件完成。
 */
import {
  ccf as rawCcf,
  cas as rawCas,
  deadlines as rawDeadlines,
  type CasSub,
  type CasZone,
  type DeadlineYear,
} from "./index";

/* ------------------------------------------------------------------ */
/* 领域词表（与 /ccf、/deadlines 页面同源；搜索词与展示共用）           */
/* ------------------------------------------------------------------ */

/** 领域名以「/」为界拆分后的第一段即官方短键 */
export const FIELD_KEY = (f: string) => f.split("/")[0];

/** 领域短键 → 英文名（CCF 官方领域英文译名） */
export const FIELD_EN: Record<string, string> = {
  计算机体系结构: "Architecture, Parallel & Distributed Computing, Storage",
  计算机网络: "Computer Networks",
  网络与信息安全: "Network & Information Security",
  软件工程: "Software Engineering, System Software & Programming Languages",
  数据库: "Databases, Data Mining & Content Retrieval",
  计算机科学理论: "Computer Science Theory",
  计算机图形学与多媒体: "Computer Graphics & Multimedia",
  人工智能: "Artificial Intelligence",
  人机交互与普适计算: "HCI & Ubiquitous Computing",
  交叉: "Interdisciplinary & Emerging",
};

/* ------------------------------------------------------------------ */
/* 规范化（精确匹配 / 搜索词归一）                                      */
/* ------------------------------------------------------------------ */

/** 名称规范化（连接键）：小写 → 去前导 the → & → and → 去标点折叠为单空格 */
export function normName(s: string): string {
  return s
    .toLowerCase()
    .replace(/^the\s+/, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** 搜索词规范化：小写 → & 去除 → 全去非字母数字直接拼接（宽容 & / 空格差异） */
export function normSearch(s: string): string {
  return s
    .toLowerCase()
    .replace(/&/g, " ")
    .replace(/[^a-z0-9]/g, "")
    .replace(/\s+/g, "");
}

/* ------------------------------------------------------------------ */
/* 会议行                                                              */
/* ------------------------------------------------------------------ */

export type VenueConference = {
  /** 缩写 */
  a: string;
  /** 全称（CCF 名优先；ccfddl-only 会议以其自身名兜底） */
  n: string;
  /** CCF 等级 A/B/C；"" = 未收录（不在 CCF 推荐目录） */
  l: "A" | "B" | "C" | "";
  /** 领域短键（CCF 官方中文名首段；ccfddl-only 会议直接用其领域名） */
  f: string;
  /** 领域完整官方中文名（斜杠全名，仅 CCF 收录时存在） */
  fFull?: string;
  /** DBLP venue 页链接 */
  d?: string;
  /** 是否收录于 CCF 推荐目录 */
  inCcf: boolean;
  /** ccfddl 年份数据（截稿时间线 / 会期 / 地点 / 官网），无则为 [] */
  years: DeadlineYear[];
};

type CcfEntryLike = { a: string; n: string; l: string; f: string; d?: string };

/** 会议行构建（纯函数，构建期与测试均可调用） */
export function makeVenueConferences(
  ccfConfs: CcfEntryLike[],
  dlConfs: { a: string; n: string; l: string; f: string; d?: string; years: DeadlineYear[] }[],
): VenueConference[] {
  const key = (a: string) => a.toLowerCase().replace(/[^a-z0-9]/g, "");
  const dlMap = new Map<string, (typeof dlConfs)[number]>();
  for (const c of dlConfs) dlMap.set(key(c.a), c);

  const rows: VenueConference[] = [];
  const seen = new Set<string>();
  for (const c of ccfConfs) {
    const k = key(c.a);
    seen.add(k);
    const dl = dlMap.get(k);
    rows.push({
      a: c.a,
      n: c.n,
      l: c.l as VenueConference["l"],
      f: FIELD_KEY(c.f),
      fFull: c.f,
      d: c.d,
      inCcf: true,
      years: dl?.years ?? [],
    });
  }
  // ccfddl-only 会议（未收录 CCF，或缩写与 CCF 目录不一致的别名）
  for (const c of dlConfs) {
    const k = key(c.a);
    if (seen.has(k)) continue;
    seen.add(k);
    rows.push({
      a: c.a,
      n: c.n || c.a,
      l: (c.l || "") as VenueConference["l"],
      f: c.f ? FIELD_KEY(c.f) : "",
      d: c.d,
      inCcf: false,
      years: c.years ?? [],
    });
  }
  return rows;
}

/* ------------------------------------------------------------------ */
/* 期刊行                                                              */
/* ------------------------------------------------------------------ */

export type VenueJournal = {
  /** CCF 缩写（CCF 收录时存在） */
  a?: string;
  /** 刊名（CCF 名优先，保证缩写/领域一致；CAS-only 用其官方刊名） */
  n: string;
  /** CCF 等级 A/B/C；"" = 不在 CCF 推荐目录 */
  l: "A" | "B" | "C" | "";
  /** 领域短键（仅 CCF 收录时有） */
  f?: string;
  /** DBLP venue 页链接 */
  d?: string;
  /** 中科院大类分区 1-4（CAS 收录时有） */
  zone?: CasZone;
  /** 是否 Top 期刊 */
  top?: boolean;
  /** 中科院大类内排名 / 总数 */
  rank?: number;
  casTotal?: number;
  /** ISSN/EISSN（"xxxx-xxxx/yyyy-yyyy"） */
  issn?: string;
  /** WoS 收录类型（SCIE / SSCI / ESCI…） */
  w?: string;
  /** 小类（JCR 学科）分区列表 */
  subs?: CasSub[];
};

type CasRowLike = {
  n: string;
  i: string;
  w: string;
  top: boolean;
  m: [string, CasZone, number, number];
  s: CasSub[];
};

/** CAS 行 → 期刊行的可合并子集（CAS 侧全部可选字段） */
type CasSide = Partial<Pick<VenueJournal, "zone" | "top" | "rank" | "casTotal" | "issn" | "w" | "subs">>;

function casSide(row: CasRowLike): CasSide {
  return {
    zone: row.m[1],
    top: row.top,
    rank: row.m[2],
    casTotal: row.m[3],
    issn: row.i,
    w: row.w,
    subs: row.s,
  };
}

/** 期刊行构建：CAS 全量 + CCF 目录（名称精确匹配挂载评级），CCF 名优先 */
export function makeVenueJournals(
  ccfJours: CcfEntryLike[],
  casRows: CasRowLike[],
): VenueJournal[] {
  const casByName = new Map<string, CasRowLike>();
  for (const r of casRows) {
    const k = normName(r.n);
    if (!casByName.has(k)) casByName.set(k, r);
  }
  const used = new Set<string>();

  const rows: VenueJournal[] = [];
  for (const c of ccfJours) {
    const k = normName(c.n);
    // CCF 目录中跨领域期刊会按领域各出一行（缩写/等级/链接相同、领域不同，
    // 原 /ccf 页按领域分组展示属期望行为），此处按规范刊名去重保留首行——
    // 否则搜索结果出现同刊多行且 React key（刊名）重复。
    if (used.has(k)) continue;
    used.add(k);
    const casHit = casByName.get(k);
    rows.push({
      a: c.a,
      n: c.n,
      l: c.l as VenueJournal["l"],
      f: FIELD_KEY(c.f),
      d: c.d,
      ...(casHit ? casSide(casHit) : {}),
    });
  }
  // CAS-only 期刊（不在 CCF 推荐目录）
  for (const r of casRows) {
    const k = normName(r.n);
    if (used.has(k)) continue;
    used.add(k);
    rows.push({
      n: r.n,
      l: "",
      ...casSide(r),
    });
  }
  return rows;
}

/* ------------------------------------------------------------------ */
/* 构建期实例化                                                        */
/* ------------------------------------------------------------------ */

export const venueConferences: VenueConference[] = makeVenueConferences(
  rawCcf.conferences,
  rawDeadlines,
);

export const venueJournals: VenueJournal[] = makeVenueJournals(
  rawCcf.journals,
  rawCas.rows,
);

/** 汇总统计（页面头部/说明文案用） */
export const venueStats = {
  conferences: venueConferences.length,
  journals: venueJournals.length,
  ccfConferences: rawCcf.conferences.length,
  ccfJournals: rawCcf.journals.length,
  /** CCF 期刊 ∩ 中科院（精确匹配） */
  dualRankedJournals: venueJournals.filter((j) => j.l !== "" && j.zone).length,
};
