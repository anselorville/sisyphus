import { describe, expect, it } from "vitest";

import { DecisionEngine } from "../../src/decision/decision-engine.js";
import { JevClient, parseResponse, type JevTransport } from "../../src/decision/jev-client.js";
import {
  TURN_THRESHOLDS,
  TurnDecider,
  classifyAnswerByRule,
  turnDecisionSpec,
  type TurnInput,
} from "../../src/decision/turn-decision.js";
import { ReflexRouter } from "../../src/routing/reflex-router.js";

const ROLES = [
  { roleId: "general", hint: "everyday chat" },
  { roleId: "web", hint: "live information" },
  { roleId: "mail", hint: "email" },
];

function answers(parts: {
  intent?: Record<string, number>;
  role?: Record<string, number>;
  pending?: Record<string, number>;
}): ReturnType<typeof parseResponse> {
  const choice = (probs: Record<string, number>) => {
    const [name, p] = Object.entries(probs).sort((a, b) => b[1] - a[1])[0]!;
    return { type: "choice", choice: name, confidence: p, probabilities: probs };
  };
  return parseResponse(
    JSON.stringify({
      answers: {
        ...(parts.intent ? { intent: choice(parts.intent) } : {}),
        ...(parts.role ? { role: choice(parts.role) } : {}),
        ...(parts.pending ? { pending_answer: choice(parts.pending) } : {}),
      },
    }),
    5,
  );
}

const input = (overrides: Partial<TurnInput> = {}): TurnInput => ({ transcript: "帮我看看邮件", roles: ROLES, ...overrides });

describe("classifyAnswerByRule", () => {
  it.each([
    ["好", "confirm"],
    ["好，发吧", "confirm"],
    ["嗯，好的", "confirm"],
    ["可以", "confirm"],
    ["ok", "confirm"],
    ["yes, send it", "confirm"],
    ["算了", "decline"],
    ["不要发", "decline"],
    ["不用了", "decline"],
    ["cancel", "decline"],
    ["好像要下雨", "unclear"],
    ["今天天气怎么样", "unclear"],
    ["让我想想", "unclear"],
    ["好，不过把标题改成周报", "unclear"],
    ["", "unclear"],
  ])("%s -> %s", (text, kind) => {
    expect(classifyAnswerByRule(text)).toBe(kind);
  });
});

describe("turnDecisionSpec.buildRequest", () => {
  it("offers cancel/steer/follow-up only while a task is running", () => {
    const idle = turnDecisionSpec.buildRequest(input());
    const busy = turnDecisionSpec.buildRequest(input({ active: { taskId: "t1", roleId: "web", goal: "查天气" } }));

    expect(Object.keys((idle.questions["intent"] as { criteria: object }).criteria).sort()).toEqual(["new_request", "stop_speaking"]);
    expect(Object.keys((busy.questions["intent"] as { criteria: object }).criteria).sort()).toEqual(
      ["cancel_task", "follow_up", "new_request", "steer_task", "stop_speaking"],
    );
    expect(idle.state).toMatchObject({ running_task: null, waiting_for_user_answer: null });
    expect(busy.state).toMatchObject({ running_task: { handled_by: "web", goal: "查天气" } });
  });

  it("builds the role menu from the roles that exist right now, using their hints", () => {
    const { questions } = turnDecisionSpec.buildRequest(input({ roles: [ROLES[0]!, ROLES[2]!] }));

    expect((questions["role"] as { criteria: Record<string, string> }).criteria).toEqual({ general: "everyday chat", mail: "email" });
  });

  it("asks the pending-answer question only when something is waiting for an answer", () => {
    const without = turnDecisionSpec.buildRequest(input());
    const withPending = turnDecisionSpec.buildRequest(input({ pending: { summary: "send 'hi' to a@b.com", roleId: "mail" } }));

    expect(without.questions["pending_answer"]).toBeUndefined();
    expect(Object.keys((withPending.questions["pending_answer"] as { criteria: object }).criteria).sort()).toEqual(
      ["confirm", "decline", "unclear", "unrelated"],
    );
    expect(withPending.state).toMatchObject({ waiting_for_user_answer: { proposed_action: "send 'hi' to a@b.com" } });
  });
});

describe("turnDecisionSpec.interpret", () => {
  it("routes a new request to the specialist Jev picks", () => {
    const out = turnDecisionSpec.interpret(answers({ intent: { new_request: 0.97, stop_speaking: 0.03 }, role: { mail: 0.95, general: 0.03, web: 0.02 } }), input());

    expect(out?.value.route).toMatchObject({ kind: "capability_match", roleId: "mail", matchedCapability: "jev" });
  });

  it("maps the general specialist to the general worker", () => {
    const out = turnDecisionSpec.interpret(answers({ intent: { new_request: 0.99, stop_speaking: 0.01 }, role: { general: 0.9, web: 0.1 } }), input());

    expect(out?.value.route).toMatchObject({ kind: "general_worker", roleId: "general" });
  });

  it("declines to override when the role is not clear", () => {
    expect(turnDecisionSpec.interpret(answers({ intent: { new_request: 0.99, stop_speaking: 0.01 }, role: { general: 0.45, web: 0.4, mail: 0.15 } }), input())).toBeUndefined();
  });

  it("declines when the intent is below its threshold", () => {
    expect(turnDecisionSpec.interpret(answers({ intent: { new_request: 0.5, stop_speaking: 0.5 }, role: { web: 1 } }), input())).toBeUndefined();
  });

  it("demands more certainty to abandon a running task than to start a new request", () => {
    const active = { taskId: "t1", roleId: "web", goal: "g" };
    const probs = (cancel: number) => ({ cancel_task: cancel, new_request: 1 - cancel });

    expect(turnDecisionSpec.interpret(answers({ intent: probs(0.8), role: { general: 1 } }), input({ active }))).toBeUndefined();
    expect(turnDecisionSpec.interpret(answers({ intent: probs(0.9), role: { general: 1 } }), input({ active }))?.value.route).toMatchObject({ kind: "cancel", taskId: "t1" });
    expect(TURN_THRESHOLDS.cancel_task).toBeGreaterThan(TURN_THRESHOLDS.new_request);
  });

  it("maps steer and follow-up onto the running task", () => {
    const active = { taskId: "t9", roleId: "web", goal: "g" };

    expect(turnDecisionSpec.interpret(answers({ intent: { steer_task: 0.9, new_request: 0.1 }, role: { web: 1 } }), input({ active }))?.value.route).toMatchObject({ kind: "steer", taskId: "t9" });
    expect(turnDecisionSpec.interpret(answers({ intent: { follow_up: 0.9, new_request: 0.1 }, role: { web: 1 } }), input({ active }))?.value.route).toMatchObject({ kind: "follow_up", taskId: "t9" });
  });

  it("only treats an utterance as consent at high certainty, and routes the answer back to the asker", () => {
    const pending = { summary: "send 'hi'", roleId: "mail" };
    const run = (confirm: number) =>
      turnDecisionSpec.interpret(
        answers({ intent: { new_request: 0.99, stop_speaking: 0.01 }, role: { general: 1 }, pending: { confirm, decline: 0, unrelated: 1 - confirm, unclear: 0 } }),
        input({ transcript: "好，发吧", pending }),
      );

    expect(run(0.95)?.value).toMatchObject({ answer: "confirm", route: { kind: "capability_match", roleId: "mail", matchedCapability: "pending_confirmation" } });
    // 0.85 is a likely yes -- but not enough to send an email on: it is NOT recorded as consent.
    expect(run(0.85)?.value.answer).not.toBe("confirm");
  });

  it("lets a decisive answer settle the turn even when the general intent is muddled", () => {
    const out = turnDecisionSpec.interpret(
      answers({ intent: { new_request: 0.51, stop_speaking: 0.49 }, role: { general: 0.5, mail: 0.5 }, pending: { confirm: 0.01, decline: 0.95, unrelated: 0.03, unclear: 0.01 } }),
      input({ transcript: "先别发", pending: { summary: "send 'hi'", roleId: "mail" } }),
    );

    expect(out?.value).toMatchObject({ answer: "decline", route: { roleId: "mail", matchedCapability: "pending_confirmation" } });
  });

  it("does not hijack an unrelated request while something is pending", () => {
    const out = turnDecisionSpec.interpret(
      answers({ intent: { new_request: 0.99, stop_speaking: 0.01 }, role: { web: 0.95, general: 0.05 }, pending: { confirm: 0.01, decline: 0.01, unrelated: 0.97, unclear: 0.01 } }),
      input({ transcript: "今天上海天气怎么样", pending: { summary: "send 'hi'", roleId: "mail" } }),
    );

    expect(out?.value).toMatchObject({ answer: "unrelated", route: { roleId: "web" } });
  });

  it("describes outcomes the same way for rule and Jev, so agreement can be measured", () => {
    expect(turnDecisionSpec.describe({ route: { kind: "capability_match", text: "x", roleId: "mail", reason: "r" }, answer: "confirm" })).toBe("capability_match:mail/confirm");
    expect(turnDecisionSpec.describe({ route: { kind: "stop_speech", text: "x", reason: "r" } })).toBe("stop_speech:-");
  });
});

class JevStub implements JevTransport {
  asked = 0;
  constructor(private readonly reply: object) {}
  async request(_m: "GET" | "POST", path: string) {
    if (path === "/v1/models") return { status: 200, body: "{}" };
    this.asked += 1;
    return { status: 200, body: JSON.stringify(this.reply) };
  }
  close(): void {}
}

async function decider(reply: object, mode: "off" | "live") {
  const transport = new JevStub(reply);
  const client = new JevClient({ transport, onWarn: () => {}, keepAliveIntervalMs: 3_600_000 });
  client.start();
  await client.whenWarm();
  return { transport, decider: new TurnDecider({ engine: new DecisionEngine({ client, mode }), reflex: new ReflexRouter() }) };
}

const MAIL_REPLY = {
  answers: {
    intent: { type: "choice", choice: "new_request", confidence: 1, probabilities: { new_request: 0.99, stop_speaking: 0.01 } },
    role: { type: "choice", choice: "mail", confidence: 1, probabilities: { mail: 0.97, general: 0.03 } },
  },
};

describe("TurnDecider", () => {
  it("obeys an explicit stop/cancel command without asking Jev", async () => {
    const { decider: d, transport } = await decider(MAIL_REPLY, "live");

    const out = await d.decide({ transcript: "取消这个任务", roles: ROLES, active: { taskId: "t1", roleId: "web" } }, { activeTask: { taskId: "t1", roleId: "web" } });

    expect(out.route.kind).toBe("cancel");
    expect(transport.asked).toBe(0);
  });

  it("with Jev off, behaves exactly like the rule router", async () => {
    const { decider: d, transport } = await decider(MAIL_REPLY, "off");

    const out = await d.decide(input({ transcript: "你好" }), {});

    expect(out.route).toMatchObject({ kind: "general_worker", roleId: "general" });
    expect(transport.asked).toBe(0);
  });

  it("with Jev live, sends a request the rule keywords would have missed to the right specialist", async () => {
    const { decider: d } = await decider(MAIL_REPLY, "live");

    // No keyword from any role's tag list appears in this sentence.
    const out = await d.decide(input({ transcript: "有没有人给我回信" }), { capabilityProviders: [{ roleId: "mail", capabilities: ["mail", "邮件"] }] });

    expect(out.route).toMatchObject({ kind: "capability_match", roleId: "mail" });
  });

  it("with the rule alone, a pending question's answer still goes back to the asker", async () => {
    const { decider: d } = await decider(MAIL_REPLY, "off");

    const out = await d.decide(input({ transcript: "好，发吧", pending: { summary: "send hi", roleId: "mail" } }), {});

    expect(out).toMatchObject({ answer: "confirm", route: { roleId: "mail" } });
  });
});
