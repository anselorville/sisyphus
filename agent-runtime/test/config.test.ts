import { describe, expect, it } from "vitest";

import { parseModelRefValue } from "../src/config.js";

describe("parseModelRefValue", () => {
  it("splits '<provider>:<modelId>' on the first colon", () => {
    expect(parseModelRefValue("AGENT_RUNTIME_MODEL_FAST", "deepseek:deepseek-v4-flash")).toEqual({
      provider: "deepseek",
      modelId: "deepseek-v4-flash",
    });
  });

  it("keeps everything after the first colon as the modelId, even if it contains a slash", () => {
    expect(parseModelRefValue("AGENT_RUNTIME_MODEL_DEEP", "openrouter:deepseek/deepseek-v4-pro")).toEqual({
      provider: "openrouter",
      modelId: "deepseek/deepseek-v4-pro",
    });
  });

  it("rejects a value with no colon", () => {
    expect(() => parseModelRefValue("AGENT_RUNTIME_MODEL_FAST", "deepseek-v4-flash")).toThrow(RangeError);
  });

  it("rejects a value with nothing before the colon", () => {
    expect(() => parseModelRefValue("AGENT_RUNTIME_MODEL_FAST", ":deepseek-v4-flash")).toThrow(RangeError);
  });

  it("rejects a value with nothing after the colon", () => {
    expect(() => parseModelRefValue("AGENT_RUNTIME_MODEL_FAST", "deepseek:")).toThrow(RangeError);
  });
});
