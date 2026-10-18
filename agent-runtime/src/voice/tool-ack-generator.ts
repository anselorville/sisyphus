/**
 * Short, action-shaped acknowledgements for tool execution.
 *
 * These phrases are deliberately local and deterministic: they fire at the
 * exact `tool.started` boundary, do not spend an LLM round trip, and never
 * claim that the tool has already produced a result.
 */

const TOOL_ACKS: Readonly<Record<string, readonly string[]>> = {
  web_search: ["我查一下。", "我搜一下。", "我来查。"],
  web_fetch: ["我看看。", "我读一下。", "我看一眼。"],
  read: ["我看一下。", "我先看看。"],
  bash: ["我执行一下。", "我跑个命令。"],
  mail_search: ["我查一下邮件。", "我找一下邮件。"],
  mail_read: ["我看看这封邮件。", "我读一下邮件。"],
  mail_send: ["我帮你发。", "我来发出去。"],
  mail_reply: ["我帮你回复。", "我来回这封邮件。"],
};

const DEFAULT_ACKS = ["我来。", "我处理一下。", "稍等。"] as const;

export class ToolAckGenerator {
  private cursor = 0;

  /** Builds the next short acknowledgement for a concrete tool name. */
  build(toolName: string): string {
    const normalizedName = toolName.trim().toLowerCase();
    const variants = TOOL_ACKS[normalizedName] ?? DEFAULT_ACKS;
    const text = variants[this.cursor % variants.length];
    this.cursor += 1;
    return text ?? DEFAULT_ACKS[0];
  }
}
