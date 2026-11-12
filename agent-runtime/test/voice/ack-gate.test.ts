import { describe, expect, it } from "vitest";

import { AckGenerator } from "../../src/voice/ack-generator.js";
import { actionForRole, classifyAckByRule, planAck } from "../../src/voice/ack-gate.js";
import { TrafficCommander } from "../../src/voice/traffic-commander.js";

describe("classifyAckByRule", () => {
  it.each([
    ["你好", "immediate"],
    ["你好。", "immediate"],
    ["嗨，你好呀", "immediate"],
    ["谢谢你", "immediate"],
    ["晚安", "immediate"],
    ["hello", "immediate"],
    ["请用一句话介绍你自己。", "immediate"],
    ["你是谁？", "immediate"],
    ["你好，帮我查一下明天上海的天气", "unknown"],
    ["今天天气怎么样", "unknown"],
    ["帮我看看邮件", "unknown"],
    ["", "unknown"],
  ])("%s -> %s", (text, need) => {
    expect(classifyAckByRule(text)).toBe(need);
  });
});

describe("planAck", () => {
  it("holds back for an immediate answer, with only a late neutral safety net", () => {
    expect(planAck("immediate", "general", { graceMs: 700 })).toEqual({ delayMs: 2_500, action: "neutral" });
    expect(planAck("immediate", "general", { graceMs: 700, immediateSafetyMs: 4_000 })).toEqual({ delayMs: 4_000, action: "neutral" });
  });

  it("words a quick or unknown ack from the routed role", () => {
    expect(planAck("quick", "web", { graceMs: 700 })).toEqual({ delayMs: 700, action: "lookup" });
    expect(planAck("unknown", "mail", { graceMs: 700 })).toEqual({ delayMs: 700, action: "mail" });
    expect(planAck("unknown", "general", { graceMs: 700 })).toEqual({ delayMs: 700, action: "think" });
  });

  it("announces long work up front", () => {
    expect(planAck("long", "web").action).toBe("long");
  });

  it("maps roles to actions, defaulting to a neutral look", () => {
    expect(actionForRole("web")).toBe("lookup");
    expect(actionForRole("device")).toBe("device");
    expect(actionForRole(undefined)).toBe("think");
    expect(actionForRole("code")).toBe("look");
  });
});

describe("AckGenerator wording", () => {
  it("only a lookup says it will search", () => {
    const gen = new AckGenerator();
    const lookups = [0, 1, 2].map(() => gen.build("明天上海的天气怎么样", "lookup"));
    expect(lookups.every((t) => /查|搜/.test(t))).toBe(true);
    expect(lookups.some((t) => t.includes("上海"))).toBe(true);
    for (const action of ["think", "look", "neutral", "mail", "long"] as const) {
      for (let i = 0; i < 4; i += 1) {
        expect(gen.build("请用一句话介绍你自己", action)).not.toMatch(/查|搜/);
      }
    }
  });

  it("strips 怎么样 whole, not leaving a stray 样", () => {
    expect(new AckGenerator().build("明天上海天气怎么样？", "lookup")).toBe("明天上海天气啊，我查一下。");
  });

  it("defaults to a neutral look when no action is given", () => {
    expect(new AckGenerator().build("介绍一下这个项目")).toMatch(/看/);
  });

  it("mail and long acks say what they are about", () => {
    expect(new AckGenerator().build("x", "mail")).toContain("邮件");
    expect(new AckGenerator().build("x", "long")).toMatch(/时间|一会儿/);
  });
});

describe("TrafficCommander with an ack action", () => {
  it("passes the action to the generator", () => {
    const commander = new TrafficCommander({ ackGraceMs: 100, ackGenerator: new AckGenerator() });
    const directive = commander.evaluate({ taskId: "t", running: true, finalTranscriptAtMs: 0, transcript: "帮我看看邮件", ackAction: "mail" }, 200);
    expect(directive?.text).toContain("邮件");
  });
});
