/**
 * TranscriptBoard: the Scribe's input record -- a running log of every
 * user/agent utterance in the current session, with a compact "archive"
 * boundary so Scribe LLM calls only ever see NEW (unarchived) text plus the
 * previous task list, never the full session transcript.
 *
 * Token discipline (mirrors coding-agent context compaction): once Scribe
 * has summarized a batch of entries, they are archived -- removed from the
 * active increment and never re-fed to the LLM. The only thing carried
 * forward is the task list Scribe itself produced, which is the compressed
 * summary of everything archived so far.
 */

export interface BoardEntry {
  readonly seq: number;
  readonly speaker: "user" | "agent";
  readonly text: string;
}

export class TranscriptBoard {
  private entries: BoardEntry[] = [];
  private nextSeq = 1;
  private archiveIndex = 0;

  append(speaker: BoardEntry["speaker"], text: string): number {
    const trimmed = text.trim();
    if (trimmed === "") {
      return 0;
    }
    this.entries.push({ seq: this.nextSeq, speaker, text: trimmed });
    this.nextSeq += 1;
    return this.entries.length;
  }

  /** Unarchived entries -- the increment Scribe has not summarized yet. */
  activeEntries(): readonly BoardEntry[] {
    return this.entries.slice(this.archiveIndex);
  }

  /** Total character count of the active increment (threshold input). */
  activeCharCount(): number {
    let total = 0;
    for (const entry of this.activeEntries()) {
      total += entry.text.length;
    }
    return total;
  }

  /** Marks everything up to `seq` as archived. Returns count archived. */
  archiveUpTo(seq: number): number {
    let archived = 0;
    while (this.archiveIndex < this.entries.length) {
      const entry = this.entries[this.archiveIndex];
      if (!entry || entry.seq > seq) {
        break;
      }
      this.archiveIndex += 1;
      archived += 1;
    }
    if (this.archiveIndex > 200) {
      this.entries = this.entries.slice(this.archiveIndex);
      this.archiveIndex = 0;
    }
    return archived;
  }

  get totalEntries(): number {
    return this.entries.length;
  }

  reset(): void {
    this.entries = [];
    this.nextSeq = 1;
    this.archiveIndex = 0;
  }
}
