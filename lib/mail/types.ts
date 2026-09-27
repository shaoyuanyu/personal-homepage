/** 与 webmaild API 对应的返回类型（前端与 route handler 共用，纯类型无运行时依赖） */

export interface MailAccount {
  id: string;
  displayName: string;
  email: string;
  provider: string;
  color: string;
  folders: string[];
  enabled: boolean;
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
  snippet: string;
  size: number;
  truncated: boolean;
  seen: boolean;
  flagged: boolean;
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
}

/** 发信时的附件输入（base64），与 webmail 包的 SendAttachment 对应 */
export interface SendAttachmentInput {
  filename: string;
  contentType?: string;
  contentBase64: string;
}

export interface MailDetail extends MailListItem {
  to: MailAddress[];
  cc: MailAddress[];
  text: string;
  html: string;
  remoteBlocked: number;
  attachments: MailAttachmentMeta[];
}

export interface MailListResponse {
  items: MailListItem[];
  next: string | null;
}
