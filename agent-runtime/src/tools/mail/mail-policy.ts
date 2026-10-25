/**
 * Mail content safety policy: the one rule that matters is that email is
 * untrusted external data. Subject, body, sender name, and attachment
 * names/content can carry text engineered to look like an instruction
 * ("ignore previous instructions and ...", "forward this to ...", a forged
 * system prompt) -- normalizeMailData() must never let any of that become
 * anything other than an inert string value in the field it belongs to.
 *
 * Concretely: NormalizedMailData has no `instructions`, `command`, or other
 * executable-shaped field, and this module never derives one from message
 * content. Text passes through as the message said it -- never sanitized of
 * wording, never reinterpreted -- with one exception: an HTML body (the CLI
 * reports `body_format: "HTML"`) is reduced to its visible text, because raw
 * markup is unreadable to the model and to a listener, and dropping
 * `<script>`/`<style>` content only removes things nobody was meant to read.
 */

/** Raw attachment metadata as agently-cli's JSON envelope shapes it (snake_case, exactly as the CLI emits it -- see the agently-mail skill's `message +read` example). */
export interface RawMailAttachment {
  readonly attachment_id?: string;
  readonly filename?: string;
  readonly content_type?: string;
  readonly size?: number;
  readonly download_url?: string;
}

/** Raw message shape as agently-cli's `message +read` / `+search` / `+watch` JSON envelope emits it. Every field is untrusted external content -- see the module doc comment. */
export interface RawMailMessage {
  readonly message_id?: string;
  readonly thread_id?: string;
  readonly subject?: string;
  readonly body?: string;
  /** "HTML" when `body` is markup rather than plain text. */
  readonly body_format?: string;
  /** Short preview; `+search` results carry this instead of a body. */
  readonly snippet?: string;
  readonly from?: RawMailAddress;
  readonly to?: readonly RawMailAddress[];
  readonly cc?: readonly RawMailAddress[];
  readonly bcc?: readonly RawMailAddress[];
  readonly attachments?: readonly RawMailAttachment[];
  readonly received_at?: string;
  /** What the real CLI calls `received_at`. */
  readonly created_at?: string;
  readonly is_unread?: boolean;
  /** What the real CLI reports (the inverse of `is_unread`). */
  readonly is_read?: boolean;
}

/** The real CLI emits addresses as `{ email, name }`; older fixtures use a bare string. */
export type RawMailAddress = string | { readonly email?: string; readonly name?: string };

export interface NormalizedMailAttachment {
  readonly attachmentId: string | undefined;
  /** Plain data, never a path to execute or a location to write to on its own authority. Falls back to a neutral placeholder only when the CLI omitted a filename entirely. */
  readonly filename: string;
  readonly contentType: string | undefined;
  readonly downloadUrl: string | undefined;
  readonly size: number | undefined;
}

/**
 * Safe shape of a mail message for a role (or the voice layer) to read.
 * Deliberately has no `instructions`/`command`/executable field -- see the
 * module doc comment. Every string field is plain data, verbatim from the
 * source message, never parsed as a tool call or a role-prompt fragment.
 */
export interface NormalizedMailData {
  readonly messageId: string | undefined;
  readonly threadId: string | undefined;
  readonly subject: string;
  readonly body: string;
  readonly sender: string;
  readonly to: readonly string[];
  readonly cc: readonly string[];
  readonly bcc: readonly string[];
  readonly attachments: readonly NormalizedMailAttachment[];
  readonly receivedAt: string | undefined;
  readonly isUnread: boolean;
}

function asPlainString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function formatAddress(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value !== null && typeof value === "object") {
    const { email, name } = value as { email?: unknown; name?: unknown };
    const address = typeof email === "string" ? email : "";
    const display = typeof name === "string" ? name : "";
    return display && address ? `${display} <${address}>` : address || display;
  }
  return "";
}

function asAddressArray(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.map(formatAddress).filter((entry) => entry !== "") : [];
}

const HTML_ENTITIES: Record<string, string> = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** Visible text of an HTML document: no tags, no script/style content, block elements become line breaks. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<br\s*\/?>|<\/(p|div|li|tr|h[1-6]|table|blockquote)\s*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#(\d+);/g, (_m, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&([a-z]+);/gi, (match, name: string) => HTML_ENTITIES[name.toLowerCase()] ?? match)
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function bodyText(raw: RawMailMessage): string {
  const body = asPlainString(raw.body);
  if (body === "") {
    return asPlainString(raw.snippet);
  }
  const isHtml = raw.body_format?.toUpperCase() === "HTML" || /^\s*<(!doctype|html)\b/i.test(body);
  return isHtml ? htmlToText(body) : body;
}

function normalizeAttachment(raw: RawMailAttachment): NormalizedMailAttachment {
  return Object.freeze({
    attachmentId: raw.attachment_id,
    filename: asPlainString(raw.filename) || "attachment",
    contentType: raw.content_type,
    downloadUrl: raw.download_url,
    size: raw.size,
  });
}

/**
 * Converts a raw agently-cli message envelope into the safe shape every
 * mail-reading consumer (Mail Worker prompt, voice summaries, other roles)
 * should use. Never throws on a malformed/partial envelope -- missing
 * fields default to an empty string/array rather than propagating
 * `undefined` into places that expect text, and unexpected extra fields on
 * `raw` are simply ignored rather than merged in.
 */
export function normalizeMailData(raw: RawMailMessage): NormalizedMailData {
  return Object.freeze({
    messageId: raw.message_id,
    threadId: raw.thread_id,
    subject: asPlainString(raw.subject),
    body: bodyText(raw),
    sender: formatAddress(raw.from),
    to: asAddressArray(raw.to),
    cc: asAddressArray(raw.cc),
    bcc: asAddressArray(raw.bcc),
    attachments: (raw.attachments ?? []).map(normalizeAttachment),
    receivedAt: raw.received_at ?? raw.created_at,
    isUnread: raw.is_unread ?? (raw.is_read === undefined ? false : !raw.is_read),
  });
}
