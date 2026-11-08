import { describe, expect, it } from "vitest";
import { toEngineMode } from "./useEngineMode";

describe("toEngineMode", () => {
  it("passes cloud and offline through", () => {
    expect(toEngineMode("cloud")).toBe("cloud");
    expect(toEngineMode("offline")).toBe("offline");
  });

  it("maps the Mac-only oMLX engine to local-dev", () => {
    expect(toEngineMode("omlx")).toBe("local-dev");
  });

  it("falls back to unknown for anything else", () => {
    expect(toEngineMode(undefined)).toBe("unknown");
    expect(toEngineMode("auto")).toBe("unknown");
    expect(toEngineMode(42)).toBe("unknown");
  });
});
