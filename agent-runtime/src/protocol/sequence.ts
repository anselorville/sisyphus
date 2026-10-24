/**
 * Process-wide allocator for the `sequence` of every RealtimeEvent the
 * sidecar originates.
 *
 * Why one allocator, and why time-seeded: the Python bridge
 * (app/realtime/event_bridge.py) de-duplicates sidecar events by `sequence`
 * alone, across everything this process sends. Independent per-module
 * counters (the task executor, diplomacy persistence, the Scribe) used to
 * collide on small integers, and a colliding real event -- say a
 * `voice.speech.enqueue` -- was silently dropped as a "duplicate". The same
 * thing happened after every sidecar restart, because counters restarting at
 * 1 collide with the numbers Python still remembers from the previous run.
 *
 * Seeding from the wall clock, at 1000 sequence numbers per millisecond,
 * makes a restarted process start above anything its predecessor could have
 * used: a process would have to emit over a thousand events per millisecond,
 * sustained, to overtake the clock. The result stays far below
 * Number.MAX_SAFE_INTEGER (about 1.8e15 versus 9e15) until the year 2255.
 * No persisted counter, no shutdown hook, no startup read.
 */
const SEQUENCE_NUMBERS_PER_MS = 1000;

export class EventSequencer {
  private value: number;

  constructor(seed: number = Date.now() * SEQUENCE_NUMBERS_PER_MS) {
    this.value = seed;
  }

  /** Strictly increasing within the process; unique across restarts (see the module comment). */
  next(): number {
    this.value += 1;
    return this.value;
  }
}
