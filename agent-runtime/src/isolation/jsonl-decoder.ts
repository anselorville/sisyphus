/**
 * Strict-LF JSONL framer for the Pi RPC child process's stdout (see
 * ./rpc-chamber.ts) -- and for any other byte stream that must be split
 * into JSON records one-per-line without pulling in Node's `readline`.
 *
 * `readline` is deliberately never used here: per the real `pi --mode rpc`
 * protocol's own framing contract
 * (node_modules/@earendil-works/pi-coding-agent/docs/rpc.md, "Framing"
 * section), a compliant client must split records on LF only, because
 * `readline` (and other generic Unicode-aware line splitters) also treat
 * U+2028 (LINE SEPARATOR) and U+2029 (PARAGRAPH SEPARATOR) as line
 * boundaries -- both of which are legal, unescaped characters *inside* a
 * JSON string value (only U+0000-U+001F must be escaped per RFC 8259).
 * Splitting on them would corrupt a record whose string payload happens to
 * contain one.
 *
 * Implementation note: this decoder scans raw bytes (Buffer#indexOf for the
 * single byte 0x0A) rather than decoding to a JS string first and then
 * splitting -- UTF-8 continuation/lead bytes for any multi-byte code point
 * (including U+2028's 3-byte encoding, 0xE2 0x80 0xA8) never contain the
 * byte value 0x0A, so byte-level scanning is exactly as safe as it is fast,
 * and it also means a chunk boundary that lands mid-codepoint (split across
 * two push() calls) never corrupts decoding -- only complete line
 * byte-ranges are ever passed to Buffer#toString("utf8").
 *
 * Leniency: a trailing CR immediately before the LF is stripped (mirrors
 * the real protocol's stated "accept optional \r\n input" allowance) --
 * this is the one bit of leniency this decoder applies; the search for the
 * record boundary itself is never anything but the literal 0x0A byte.
 */

export type JsonlRecord = Record<string, unknown>;

export interface JsonlDecoderOptions {
  /**
   * Called for each line that fails to decode to a JSON object, with the
   * raw (already CR-stripped) line text and the thrown error (or a
   * descriptive Error if the line parsed but was not a JSON object). A
   * malformed line never throws out of push() and never stops subsequent
   * lines -- in the same push() call or a later one -- from being parsed.
   * Default: malformed lines are silently dropped.
   */
  readonly onInvalidLine?: (raw: string, error: unknown) => void;
}

const LF = 0x0a;
const CR = 0x0d;

/**
 * Incremental strict-JSONL decoder: feed it arbitrarily-chunked Buffers via
 * push(), get back every complete JSON record framed by a literal LF byte
 * since the last call. A line with no terminating LF yet is buffered
 * (verbatim, as bytes) until a future push() call supplies the rest of it --
 * arbitrary chunk boundaries (including mid-multibyte-codepoint) never lose
 * or corrupt data.
 */
export class JsonlDecoder {
  private readonly onInvalidLine: ((raw: string, error: unknown) => void) | undefined;
  private buffered: Buffer = Buffer.alloc(0);

  constructor(options: JsonlDecoderOptions = {}) {
    this.onInvalidLine = options.onInvalidLine;
  }

  /** Appends `chunk` and returns every complete JSON record newly terminated by an LF, in order. Partial trailing bytes (no LF yet) are retained for the next push(). */
  push(chunk: Buffer): readonly JsonlRecord[] {
    this.buffered = Buffer.concat([this.buffered, chunk]);

    const records: JsonlRecord[] = [];
    let start = 0;
    for (;;) {
      const lfIndex = this.buffered.indexOf(LF, start);
      if (lfIndex === -1) {
        break;
      }
      let end = lfIndex;
      if (end > start && this.buffered[end - 1] === CR) {
        end -= 1;
      }
      const line = this.buffered.subarray(start, end).toString("utf8");
      start = lfIndex + 1;
      this.parseLine(line, records);
    }

    this.buffered = this.buffered.subarray(start);
    return records;
  }

  private parseLine(line: string, records: JsonlRecord[]): void {
    if (line.length === 0) {
      // Blank line (e.g. a stray extra LF) -- not an error, just nothing to
      // frame.
      return;
    }
    try {
      const parsed: unknown = JSON.parse(line);
      if (isJsonlRecord(parsed)) {
        records.push(parsed);
      } else {
        this.onInvalidLine?.(line, new Error("JSONL line did not decode to a JSON object"));
      }
    } catch (error) {
      this.onInvalidLine?.(line, error);
    }
  }
}

function isJsonlRecord(value: unknown): value is JsonlRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
