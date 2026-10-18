/**
 * Receipt ack generator: turns a user transcript into a context-aware,
 * non-repetitive acknowledgement ("上海的天气啊，我看看" instead of the
 * canned customer-service phrasing "好的，我在处理。").
 *
 * The theme is extracted with a small deterministic heuristic (no LLM --
 * the ack must fire within ~700ms and cost nothing): drop question/request
 * particles and filler, keep the core noun phrase. A rotating template
 * pool keeps consecutive acks from sounding identical.
 */

const FILLER_RE =
  /(?:请|帮我|帮|查一下|查|搜索一下|搜索|搜一下|搜|找一下|找|看看|看一下|确认一下|确认|了解一下|了解|一下|一?下|我想|我要|能(?:不)?能|可以|请问|麻烦|你|您|啊|呢|吗|吧|呀|哦|嗯|好|那|什么|怎么|为啥|为什么|有没有|哪些|几个|多少|如何|咋|呢)/g;

const TEMPLATES = [
  "{theme}啊，我看看。",
  "你说{theme}？我查一下。",
  "嗯，{theme}，我确认一下。",
  "{theme}？我来看看。",
];

const DEFAULT_ACK = "嗯，我先看看。";

export interface AckGeneratorOptions {
  readonly templates?: readonly string[];
}

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
  private readonly templates: readonly string[];
  private cursor = 0;

  constructor(options: AckGeneratorOptions = {}) {
    this.templates = options.templates ?? TEMPLATES;
  }

  /** Builds an ack for `transcript`; falls back to the generic ack when no theme can be extracted. */
  build(transcript: string): string {
    const theme = extractTheme(transcript);
    if (theme === undefined) {
      return DEFAULT_ACK;
    }
    const template = this.templates.length > 0 ? this.templates[this.cursor % this.templates.length] : undefined;
    if (template === undefined) {
      return DEFAULT_ACK;
    }
    this.cursor += 1;
    return template.replace("{theme}", theme);
  }
}
