import { describe, expect, it } from "vitest";

import type { ActiveTaskRef } from "../../src/routing/interruption-router.js";
import type { CapabilityProvider, RouteState } from "../../src/routing/reflex-router.js";
import { ReflexRouter } from "../../src/routing/reflex-router.js";

const activeTask: ActiveTaskRef = { taskId: "task-1", roleId: "code" };

describe("ReflexRouter.route priority order", () => {
  const router = new ReflexRouter();

  describe("tier 1: explicit stop/cancel phrases", () => {
    it("routes an explicit stop phrase to stop_speech", () => {
      const decision = router.route("停，别说了", { activeTask });
      expect(decision.kind).toBe("stop_speech");
      expect(decision.taskId).toBe(activeTask.taskId);
    });

    it("routes an explicit cancel phrase to cancel", () => {
      const decision = router.route("取消这个任务", { activeTask });
      expect(decision.kind).toBe("cancel");
      expect(decision.taskId).toBe(activeTask.taskId);
    });

    it("stop/cancel win even while an elevation dialog is open", () => {
      const decision = router.route("取消这个任务", {
        activeTask,
        pendingElevation: { requestId: "req-1", taskId: activeTask.taskId },
      });
      expect(decision.kind).toBe("cancel");
    });
  });

  describe("tier 2: answers to the currently-open elevation dialog", () => {
    it("classifies an approval phrase as elevation_response(approved=true)", () => {
      const decision = router.route("好的，没问题", {
        pendingElevation: { requestId: "req-1", taskId: "task-9" },
      });
      expect(decision.kind).toBe("elevation_response");
      expect(decision.approved).toBe(true);
      expect(decision.taskId).toBe("task-9");
    });

    it("classifies a denial phrase as elevation_response(approved=false)", () => {
      const decision = router.route("不可以，还没准备好", {
        pendingElevation: { requestId: "req-1", taskId: "task-9" },
      });
      expect(decision.kind).toBe("elevation_response");
      expect(decision.approved).toBe(false);
    });

    it("falls through to later tiers when no elevation dialog is open", () => {
      const decision = router.route("好的，没问题", {});
      expect(decision.kind).not.toBe("elevation_response");
    });

    it("falls through past an unanswered elevation dialog to the general worker", () => {
      const decision = router.route("今天天气怎么样", {
        pendingElevation: { requestId: "req-1" },
      });
      expect(decision.kind).toBe("general_worker");
    });
  });

  describe("tier 3: steer/follow_up against the active task", () => {
    it("routes an explicit correction phrase to steer", () => {
      const decision = router.route("不是这样，改成只跑单元测试", { activeTask });
      expect(decision.kind).toBe("steer");
      expect(decision.taskId).toBe(activeTask.taskId);
    });

    it("routes an explicit follow-up phrase to follow_up", () => {
      const decision = router.route("做完以后把结果发邮件", { activeTask });
      expect(decision.kind).toBe("follow_up");
      expect(decision.taskId).toBe(activeTask.taskId);
    });
  });

  describe("tier 4: capability-tag match", () => {
    const capabilityProviders: readonly CapabilityProvider[] = [
      { roleId: "mail", capabilities: ["邮件", "mail"] },
      { roleId: "web", capabilities: ["网页", "网站"] },
    ];

    it("routes a new request to the role whose capability tag matches", () => {
      const decision = router.route("帮我查一下邮件", { capabilityProviders });
      expect(decision.kind).toBe("capability_match");
      expect(decision.roleId).toBe("mail");
      expect(decision.matchedCapability).toBe("邮件");
    });

    it("first matching provider wins when multiple providers are configured", () => {
      const decision = router.route("帮我看看网站和邮件", { capabilityProviders });
      expect(decision.roleId).toBe("mail"); // mail provider listed first, "邮件" also present
    });

    it("capability match takes priority over a stress escalation that would otherwise fire", () => {
      const decision = router.route("帮我查一下邮件", {
        capabilityProviders,
        stress: { threatensAvailability: true },
      });
      expect(decision.kind).toBe("capability_match");
    });
  });

  describe("tier 5: Stress Judge escalation", () => {
    it("escalates to activate_specialists on a moderate stress signal", () => {
      const decision = router.route("这是一个从没见过的复杂请求", {
        stress: { consecutiveRouteFailures: 2 },
      });
      expect(decision.kind).toBe("stress_escalation");
      expect(decision.stressDecision).toBe("activate_specialists");
    });

    it("escalates to spawn_intelligence_caste on a severe stress signal", () => {
      const decision = router.route("这是一个从没见过的复杂请求", {
        stress: { threatensAvailability: true },
      });
      expect(decision.kind).toBe("stress_escalation");
      expect(decision.stressDecision).toBe("spawn_intelligence_caste");
    });

    it("never returns a free-text answer for a stress escalation, only the fixed decision enum", () => {
      const decision = router.route("这是一个从没见过的复杂请求", {
        stress: { novelDomain: true },
      });
      expect(["stay_baseline", "activate_specialists", "spawn_intelligence_caste"]).toContain(
        decision.stressDecision,
      );
    });
  });

  describe("tier 6: General Worker fallback", () => {
    it("falls back to the general worker for a plain unrelated request", () => {
      const decision = router.route("今天天气怎么样", {});
      expect(decision.kind).toBe("general_worker");
      expect(decision.roleId).toBe("general");
    });

    it("honors a custom general worker role id", () => {
      const decision = router.route("今天天气怎么样", { generalWorkerRoleId: "custom-general" });
      expect(decision.roleId).toBe("custom-general");
    });
  });

  it("never calls an LLM: route() is synchronous and returns a plain object, not a Promise", () => {
    const result = router.route("今天天气怎么样", {});
    expect(result).not.toBeInstanceOf(Promise);
    expect(typeof result.kind).toBe("string");
  });
});

describe("ReflexRouter.route performance", () => {
  it("keeps rule-routing p95 under 2ms across 100,000 calls", () => {
    const router = new ReflexRouter();
    const capabilityProviders: readonly CapabilityProvider[] = [
      { roleId: "mail", capabilities: ["邮件", "mail"] },
      { roleId: "web", capabilities: ["网页", "web"] },
    ];

    const samples: ReadonlyArray<readonly [string, RouteState]> = [
      ["停，别说了", {}],
      ["取消这个任务", { activeTask }],
      ["不是这样，改成只跑单元测试", { activeTask }],
      ["做完以后把结果发邮件", { activeTask }],
      ["帮我查一下邮件", { capabilityProviders }],
      ["今天天气怎么样", {}],
      ["好的，没问题", { pendingElevation: { requestId: "req-1" } }],
      ["不可以，还没准备好", { pendingElevation: { requestId: "req-1" } }],
      ["这是一个全新的、从未见过的复杂请求", { stress: { hasKnownRoute: false } }],
      ["这是一个全新的、从未见过的复杂请求", { stress: { threatensAvailability: true } }],
    ];

    const ITERATIONS = 100_000;
    const durationsMs: number[] = new Array(ITERATIONS);

    for (let i = 0; i < ITERATIONS; i += 1) {
      const sample = samples[i % samples.length]!;
      const [text, state] = sample;
      const startedAt = performance.now();
      router.route(text, state);
      durationsMs[i] = performance.now() - startedAt;
    }

    durationsMs.sort((a, b) => a - b);
    const p95Index = Math.min(durationsMs.length - 1, Math.ceil(0.95 * durationsMs.length) - 1);
    const p95 = durationsMs[p95Index]!;

    // Design target (.proj-init/04-...-software-design.md 15.5): p95 < 10ms
    // on real Raspberry Pi hardware. This benchmark asserts a much tighter
    // <2ms bound on the dev machine running the test suite, leaving
    // headroom for slower hardware -- per Task 10 step 6.
    expect(p95).toBeLessThan(2);
  });
});
