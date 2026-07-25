import { describe, expect, it } from "vitest";
import { INITIAL_ECOLOGY_STATE, reduceEcologyStatus, type EcologyWireEvent } from "./useEcologyStatus";

describe("reduceEcologyStatus", () => {
  it("starts unknown for both bands and a disconnected sidecar", () => {
    expect(INITIAL_ECOLOGY_STATE).toEqual({
      ecology: "unknown",
      food: "unknown",
      sidecarConfigured: false,
      sidecarConnected: false,
    });
  });

  it("applies a poll result wholesale", () => {
    const next = reduceEcologyStatus(INITIAL_ECOLOGY_STATE, {
      type: "__poll_result__",
      ecology: "prosperous",
      food: "conserving",
      sidecarConfigured: true,
      sidecarConnected: true,
    });
    expect(next).toEqual({
      ecology: "prosperous",
      food: "conserving",
      sidecarConfigured: true,
      sidecarConnected: true,
    });
  });

  it("a live ecology.state.changed event updates only the ecology band, not food", () => {
    const afterPoll = reduceEcologyStatus(INITIAL_ECOLOGY_STATE, {
      type: "__poll_result__",
      ecology: "prosperous",
      food: "reserve",
      sidecarConfigured: true,
      sidecarConnected: true,
    });
    const next = reduceEcologyStatus(afterPoll, { type: "ecology.state.changed", state: "hibernating" });
    expect(next.ecology).toBe("hibernating");
    expect(next.food).toBe("reserve");
  });

  it("a live budget.updated event updates only the food band, not ecology", () => {
    const afterPoll = reduceEcologyStatus(INITIAL_ECOLOGY_STATE, {
      type: "__poll_result__",
      ecology: "prosperous",
      food: "reserve",
      sidecarConfigured: true,
      sidecarConnected: true,
    });
    const next = reduceEcologyStatus(afterPoll, { type: "budget.updated", state: "hibernating" });
    expect(next.food).toBe("hibernating");
    expect(next.ecology).toBe("prosperous");
  });

  it("a malformed/unknown state value does not blank out a previously known-good band", () => {
    const afterPoll = reduceEcologyStatus(INITIAL_ECOLOGY_STATE, {
      type: "__poll_result__",
      ecology: "prosperous",
      food: "reserve",
      sidecarConfigured: true,
      sidecarConnected: true,
    });
    const next = reduceEcologyStatus(afterPoll, { type: "ecology.state.changed", state: "not-a-real-band" });
    expect(next.ecology).toBe("prosperous");
  });

  it("ignores wire events unrelated to ecology/budget", () => {
    const next = reduceEcologyStatus(INITIAL_ECOLOGY_STATE, { type: "task.created" } as unknown as EcologyWireEvent);
    expect(next).toBe(INITIAL_ECOLOGY_STATE);
  });
});
