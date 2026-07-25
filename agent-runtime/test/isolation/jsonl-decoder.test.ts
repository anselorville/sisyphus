import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { JsonlDecoder } from "../../src/isolation/jsonl-decoder.js";

// U+2028 LINE SEPARATOR, built via a TS escape rather than embedded as a raw
// multi-byte character in this file's own source text (keeps the file
// unambiguous ASCII; the runtime value is the real character either way).
// Per the real `pi --mode rpc` protocol's framing note (see
// node_modules/@earendil-works/pi-coding-agent/docs/rpc.md): U+2028/U+2029
// are legal, unescaped, inside a JSON string, and must never be treated as
// a record boundary the way Node's readline (or another Unicode-aware line
// splitter) would.
const LINE_SEPARATOR = String.fromCharCode(0x2028);

describe("JsonlDecoder (Step 2 mandated test)", () => {
  it("splits only on LF and preserves unicode separators", () => {
    const decoder = new JsonlDecoder();
    // Double backslash here: the *buffer's own bytes* must contain a
    // literal backslash-u-2028 (a JSON-escaped separator) for JSON.parse
    // itself to decode -- the decoded value must come back as the real
    // U+2028 character, never stripped, and never treated as a second
    // record boundary.
    const records = decoder.push(Buffer.from('{"text":"a\\u2028b"}\n{"id":2}\n'));

    expect(records).toHaveLength(2);
    expect(records[0]!["text"]).toBe(`a${LINE_SEPARATOR}b`);
    expect(records[1]!["id"]).toBe(2);
  });
});

describe("JsonlDecoder -- fuller coverage", () => {
  it("buffers a partial line across push() calls until the terminating LF arrives", () => {
    const decoder = new JsonlDecoder();

    expect(decoder.push(Buffer.from('{"id":1,"tex'))).toEqual([]);
    expect(decoder.push(Buffer.from('t":"done"}\n'))).toEqual([{ id: 1, text: "done" }]);
  });

  it("frames multiple records delivered in a single push() call", () => {
    const decoder = new JsonlDecoder();
    const records = decoder.push(Buffer.from('{"n":1}\n{"n":2}\n{"n":3}\n'));

    expect(records).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
  });

  it("does not let malformed JSON on one line corrupt subsequent valid lines", () => {
    const invalid: Array<{ raw: string }> = [];
    const decoder = new JsonlDecoder({ onInvalidLine: (raw) => invalid.push({ raw }) });

    const records = decoder.push(Buffer.from('{"ok":1}\nnot json at all\n{"ok":2}\n'));

    expect(records).toEqual([{ ok: 1 }, { ok: 2 }]);
    expect(invalid).toEqual([{ raw: "not json at all" }]);
  });

  it("silently drops malformed lines when no onInvalidLine hook is given", () => {
    const decoder = new JsonlDecoder();
    expect(() => decoder.push(Buffer.from('not json\n{"ok":1}\n'))).not.toThrow();
    expect(decoder.push(Buffer.from(""))).toEqual([]);
  });

  it("strips a trailing CR from CRLF-terminated lines, per the real protocol's stated leniency", () => {
    const decoder = new JsonlDecoder();
    const records = decoder.push(Buffer.from('{"n":1}\r\n{"n":2}\n'));

    expect(records).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it("never splits on a literal (unescaped) separator embedded directly in the JSON text", () => {
    const decoder = new JsonlDecoder();
    // Built via template interpolation of LINE_SEPARATOR so the resulting
    // buffer's raw bytes contain the 3-byte UTF-8 encoding of U+2028
    // directly, with no JSON escape sequence at all -- legal JSON (only
    // U+0000-U+001F must be escaped), and must still be treated as part of
    // the string value, never a line boundary.
    const records = decoder.push(Buffer.from(`{"text":"a${LINE_SEPARATOR}b"}\n`, "utf8"));

    expect(records).toEqual([{ text: `a${LINE_SEPARATOR}b` }]);
  });

  it("splits a record across a chunk boundary that falls mid-multibyte-codepoint", () => {
    const decoder = new JsonlDecoder();
    const full = Buffer.from(`{"text":"a${LINE_SEPARATOR}b"}\n`, "utf8");
    // U+2028 encodes to 3 bytes (0xE2 0x80 0xA8); split inside that
    // sequence so neither push() call sees a complete UTF-8 codepoint.
    const splitAt = full.indexOf(0xe2) + 1;

    expect(decoder.push(full.subarray(0, splitAt))).toEqual([]);
    expect(decoder.push(full.subarray(splitAt))).toEqual([{ text: `a${LINE_SEPARATOR}b` }]);
  });

  it("ignores a blank line (stray extra LF) without producing a record or an error", () => {
    const invalid: unknown[] = [];
    const decoder = new JsonlDecoder({ onInvalidLine: (raw) => invalid.push(raw) });

    const records = decoder.push(Buffer.from('{"n":1}\n\n{"n":2}\n'));

    expect(records).toEqual([{ n: 1 }, { n: 2 }]);
    expect(invalid).toEqual([]);
  });

  it("never imports node:readline", () => {
    // Matches an actual import/require of the module by its quoted
    // specifier -- not the word "readline" anywhere, since this file's own
    // comments legitimately explain *why* readline is avoided.
    const source = readFileSync(path.join(import.meta.dirname, "../../src/isolation/jsonl-decoder.ts"), "utf8");
    expect(source).not.toMatch(/from\s+["'](?:node:)?readline["']/);
    expect(source).not.toMatch(/require\(\s*["'](?:node:)?readline["']\s*\)/);
  });
});
