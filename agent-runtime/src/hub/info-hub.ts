/**
 * InfoHub: the swarm's shared information pool ("信息中枢"). Roles do their
 * own work and publish important signals/material here; other roles that
 * need that context subscribe or read it on demand. This is the minimal
 * shared-state substrate the swarm ecology implies: no role talks to
 * another directly, they meet at the hub.
 *
 * Current consumers:
 * - Scribe (../scribe/scribe.ts) publishes the current topic ledger and
 *   topic-change signals.
 * - TaskExecutor (../tasks/task-executor.ts) reads the current topic to
 *   inject conversation context into prompts.
 */

export interface TopicItem {
  readonly id: string;
  readonly phrase: string;
  readonly summary: string;
  readonly status: "active" | "closed";
  readonly updatedAt: string;
}

export interface TopicChangeSignal {
  readonly previous: TopicItem | undefined;
  readonly current: TopicItem;
  readonly material: string;
  readonly at: string;
}

export class InfoHub {
  private topics: readonly TopicItem[] = [];
  private currentTopic: TopicItem | undefined;
  private lastTopicChange: TopicChangeSignal | undefined;
  private listeners = new Set<(signal: TopicChangeSignal) => void>();

  setTopics(topics: readonly TopicItem[], now: () => Date): TopicChangeSignal | undefined {
    const previous = this.currentTopic;
    this.topics = topics;
    this.currentTopic = topics.find((t) => t.status === "active") ?? topics[topics.length - 1];
    if (this.currentTopic === undefined) {
      this.lastTopicChange = undefined;
      return undefined;
    }

    if (previous && previous.id !== this.currentTopic.id) {
      const signal: TopicChangeSignal = {
        previous,
        current: this.currentTopic,
        material: this.buildMaterial(this.currentTopic),
        at: now().toISOString(),
      };
      this.lastTopicChange = signal;
      for (const listener of this.listeners) {
        try {
          listener(signal);
        } catch {
          // a listener must never break the hub
        }
      }
      return signal;
    }
    return undefined;
  }

  getTopics(): readonly TopicItem[] {
    return this.topics;
  }

  getCurrentTopic(): TopicItem | undefined {
    return this.currentTopic;
  }

  getLastTopicChange(): TopicChangeSignal | undefined {
    return this.lastTopicChange;
  }

  /** Context block for prompt injection: current topic + recent change. */
  buildTopicContext(): string {
    const parts: string[] = [];
    if (this.lastTopicChange) {
      parts.push(
        `[话题切换] 从「${this.lastTopicChange.previous?.phrase ?? "无"}」切换到「${this.lastTopicChange.current.phrase}」`,
      );
      parts.push(`[当前话题] ${this.lastTopicChange.current.phrase}: ${this.lastTopicChange.current.summary}`);
    } else if (this.currentTopic) {
      parts.push(`[当前话题] ${this.currentTopic.phrase}: ${this.currentTopic.summary}`);
    }
    return parts.join("\n");
  }

  subscribe(listener: (signal: TopicChangeSignal) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private buildMaterial(topic: TopicItem): string {
    return `${topic.phrase}: ${topic.summary}`;
  }
}
