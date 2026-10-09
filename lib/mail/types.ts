/** 与 webmaild API 对应的返回类型（前端与 route handler 共用，纯类型无运行时依赖） */

export interface MailAccount {
  id: string;
  displayName: string;
  email: string;
  provider: string;
  color: string;
  folders: string[];
  enabled: boolean;
  /** 发件人姓名（随邮件发出的 From 显示名；与备注名 displayName 区分，2026-10-06） */
  senderName?: string;
  /** 连接字段（账号管理弹窗的编辑表单预填用；webmaild /accounts 返回，无密码） */
  imapHost?: string;
  imapPort?: number;
  imapSecure?: boolean;
  smtpHost?: string;
  smtpPort?: number;
  smtpSecure?: boolean;
  /** 登录用户名（凭据的 username，非密码） */
  username?: string;
  /** INBOX 未读数（4.2 / 4.8；webmaild /accounts 返回） */
  unread?: number;
  /** 本地已同步的邮件副本数（删除账号的确认弹窗用它说明会清掉多少；webmaild /accounts 返回） */
  localMessages?: number;
}

export interface MailCopyRef {
  accountId: string;
  folder: string;
  uid: number;
}

export interface MailListItem {
  messageId: string;
  date: string | null;
  subject: string;
  fromAddr: string;
  fromName: string;
  /** 收件人（列表行对发件邮件显示「发给 X」，4.9） */
  to: MailAddress[];
  snippet: string;
  size: number;
  truncated: boolean;
  seen: boolean;
  flagged: boolean;
  /** 是否有可下载附件（不含内嵌图，4.2） */
  hasAttach: boolean;
  copies: MailCopyRef[];
  accounts: string[];
}

export interface MailAddress {
  name?: string;
  address?: string;
}
export interface MailAttachmentMeta {
  index: number;
  filename: string;
  contentType: string;
  size: number;
  cid: string | null;
  inline: boolean;
  /**
   * 「附件没随同步下载」（2026-10-08 附件门控）：本地只留了正文与内嵌图，
   * 点这个附件时才向服务器取那一个部件（几秒）。⚠ 序号以清单为准，补取整封后也不变。
   */
  deferred?: boolean;
}

/** 发信时的附件输入（base64），与 webmail 包的 SendAttachment 对应 */
export interface SendAttachmentInput {
  filename: string;
  contentType?: string;
  contentBase64: string;
}

/**
 * 「我的账号」：站主自己的收发地址（4.10 通讯录 / 写信自动补全共用）。
 *
 * - `account` = webmail 注册表里的账号（能站内发信）
 * - `agent` = agent@ 信箱，只能从 mailagentd 的只读视图拿到（站内不以它发信，4.3）
 */
export interface MailOwnAddress {
  id: string;
  name: string;
  email: string;
  kind: "account" | "agent";
}

export interface MailDetail extends MailListItem {
  cc: MailAddress[];
  /** 原始邮件头（按原文顺序与折行；2026-10-07 取证用） */
  headers?: { key: string; line: string }[];
  text: string;
  html: string;
  remoteBlocked: number;
  attachments: MailAttachmentMeta[];
  /**
   * 本地留存的是**精简原文**（正文 + 内嵌图，附件按需）——见 webmail/src/mime.ts。
   * 与 `truncated` 的区别：truncated 且**非** partial = 连正文都没有（只存了索引）。
   */
  partial?: boolean;
  /** 引用链（库键 mid:<normalized> 形式，4.7）；回复时续链用 */
  refs?: string[];
  /** 发件人已存进通讯录时的联系人 id；null = 未保存（「存入通讯录」按钮态） */
  fromContactId?: string | null;
}

export interface MailListResponse {
  items: MailListItem[];
  next: string | null;
}

/**
 * 服务器上的文件夹（webmaild `GET /folders`，2026-10-07）。
 * `specialUse` 是 RFC 6154 的特殊用途标志（`\Sent` / `\Drafts` / `\Trash` / `\Junk`…），
 * 服务商不支持该扩展时由 webmaild 按本地化名字推断（阿里云的「已发送 / 草稿 / 垃圾邮件 /
 * 已删除邮件」都能认出来），认不出为空串。
 */
export interface MailFolder {
  path: string;
  name: string;
  delimiter: string;
  specialUse: string;
  specialUseSource: string;
  selectable: boolean;
}

/** 通讯录：手动维护的联系人（webmaild /contacts） */
export interface MailContact {
  id: string;
  name: string;
  email: string;
  note: string;
  /** 归属账号 id；'' = 本地联系人（不归属任何账号），4.14 */
  account: string;
  createdAt: string;
  updatedAt: string;
}

/** 自动收录的通信对象（不落表，webmaild 从 messages 表现算） */
export interface MailKnownSender {
  name: string;
  email: string;
  /** 通信次数 */
  times: number;
  /** 最近一次通信时间（ISO） */
  lastSeen: string | null;
  /** 该地址出现在哪些账号的往来里（4.14 按账号筛选） */
  accounts: string[];
}

/** 写信自动补全的返回（/contacts/suggest）：已保存联系人在前，收录在后 */
export interface MailContactSuggest {
  contacts: MailContact[];
  known: MailKnownSender[];
}

/**
 * 服务器端草稿（2026-10-06；webmaild /drafts）：写信页自动保存、草稿箱列表消费。
 *
 * - `kind` / `kindRef`：找回逻辑——new（全新写信，ref 空）/ reply（回复，ref = 原信
 *   messageId）/ forward（转发，ref 同）。从同一原信再次进入写信页时恢复对应草稿。
 * - 地址字段保存**原文串**（不解析成数组，保真优先）；附件不随草稿保存。
 */
export interface MailDraft {
  id: string;
  kind: "new" | "reply" | "forward";
  kindRef: string;
  accountId: string;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  body: string;
  readReceipt: boolean;
  inReplyTo: string;
  references: string[];
  createdAt: string;
  updatedAt: string;
}
