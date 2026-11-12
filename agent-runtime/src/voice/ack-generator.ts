/**
 * Receipt ack generator: turns a user transcript into a context-aware,
 * non-repetitive acknowledgement ("上海的天气啊，我查一下" instead of the
 * canned customer-service phrasing "好的，我在处理。").
 *
 * The theme is extracted with a small deterministic heuristic (no LLM --
 * the ack must fire within ~700ms and cost nothing): drop question/request
 * particles and filler, keep the core noun phrase. A rotating template
 * pool keeps consecutive acks from sounding identical.
 *
 * The verb comes from the action the turn was routed to (see
 * ./ack-gate.ts): only a lookup says "我查一下", only mail mentions mail.
 * Without an action the wording stays neutral ("我看看"), never claiming a
 * search that is not going to happen.
 */

/** What the agent is about to do, as far as the ack's wording is concerned. */
export type AckAction = "lookup" | "mail" | "device" | "think" | "look" | "long" | "neutral";

const FILLER_RE =
  /(?:请|帮我|帮|查一下|查|搜索一下|搜索|搜一下|搜|找一下|找|看看|看一下|确认一下|确认|了解一下|了解|一下|一?下|我想|我要|能(?:不)?能|可以|请问|麻烦|你|您|啊|呢|吗|吧|呀|哦|嗯|好|那|什么|怎么样|怎样|怎么|为啥|为什么|有没有|哪些|几个|多少|如何|咋|呢)/g;

interface TemplateSet {
  /** Templates containing `{theme}`. */
  readonly themed: readonly string[];
  /** Used when no theme can be extracted, or for actions whose wording does not depend on it. */
  readonly plain: readonly string[];
}

const TEMPLATES: Readonly<Record<AckAction, TemplateSet>> = {
  lookup: {
    themed: ["{theme}啊，我查一下。", "你说{theme}？我搜一下。", "{theme}？我来查查。"],
    plain: ["我查一下。", "我搜一下。"],
  },
  mail: { themed: [], plain: ["我看一下邮件。", "邮件啊，我看看。"] },
  device: { themed: [], plain: ["我看一下服务状态。", "我检查一下。"] },
  think: {
    themed: ["{theme}啊，我想想。", "嗯，{theme}，我想一下。"],
    plain: ["嗯，我想想。", "我想一下。"],
  },
  look: {
    themed: ["{theme}啊，我看看。", "{theme}？我来看看。"],
    plain: ["嗯，我先看看。", "我看一下。"],
  },
  long: { themed: [], plain: ["这个要花点时间，我弄好了告诉你。", "这个得做一会儿，好了我叫你。"] },
  neutral: { themed: [], plain: ["嗯，稍等。"] },
};

const DEFAULT_ACTION: AckAction = "look";

/** Extracts a short theme phrase from a transcript, or undefined when nothing usable remains. */
export function extractTheme(text: string): string | undefined {
  const cleaned = text
    .replace(FILLER_RE, "")
    .replace(/[，。！？!?、\s]+/g, "")
    .trim();
  if (cleaned.length < 2) {
    return undefined;
  }
  // Keep at most ~12 chars so the ack stays short and speakable.
  return cleaned.slice(0, 12);
}

export class AckGenerator {
  private cursor = 0;

  /** Builds an ack for `transcript` worded for `action` (default: a neutral "let me look"). */
  build(transcript: string, action: AckAction = DEFAULT_ACTION): string {
    const set = TEMPLATES[action];
    const theme = set.themed.length > 0 ? extractTheme(transcript) : undefined;
    const pool = theme !== undefined ? set.themed : set.plain;
    const template = pool[this.cursor % pool.length] as string;
    this.cursor += 1;
    return theme !== undefined ? template.replace("{theme}", theme) : template;
  }
}
