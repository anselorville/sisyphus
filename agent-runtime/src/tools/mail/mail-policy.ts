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
 * content. Every text field passes through verbatim (not sanitized, not
 * stripped, not reinterpreted) -- verbatim pass-through is itself the
 * safety property, since silently rewriting content would hide what the
 * message actually said.
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
  readonly from?: string;
  readonly to?: readonly string[];
  readonly cc?: readonly string[];
  readonly bcc?: readonly string[];
  readonly attachments?: readonly RawMailAttachment[];
  readonly received_at?: string;
  readonly is_unread?: boolean;
}

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

function asStringArray(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
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
    body: asPlainString(raw.body),
    sender: asPlainString(raw.from),
    to: asStringArray(raw.to),
    cc: asStringArray(raw.cc),
    bcc: asStringArray(raw.bcc),
    attachments: (raw.attachments ?? []).map(normalizeAttachment),
    receivedAt: raw.received_at,
    isUnread: raw.is_unread ?? false,
  });
}
