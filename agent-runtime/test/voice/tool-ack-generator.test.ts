import { describe, expect, it } from "vitest";

import { ToolAckGenerator } from "../../src/voice/tool-ack-generator.js";

describe("ToolAckGenerator", () => {
  it("uses an action-shaped acknowledgement for web search", () => {
    const generator = new ToolAckGenerator();

    const text = generator.build("web_search");

    expect(text).toMatch(/查|搜/);
    expect(text).not.toBe("好的，我在处理。");
  });

  it("rotates variants for repeated calls without changing the tool mapping", () => {
    const generator = new ToolAckGenerator();

    const first = generator.build("web_fetch");
    const second = generator.build("web_fetch");

    expect(first).not.toBe(second);
    expect(first).toMatch(/看|读/);
    expect(second).toMatch(/看|读/);
  });

  it("falls back to a short neutral action for unknown tools", () => {
    const generator = new ToolAckGenerator();

    const text = generator.build("some_future_tool");

    expect(text).not.toBe("好的，我在处理。");
    expect(text.length).toBeLessThan(12);
  });
});
