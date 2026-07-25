import { describe, expect, it } from "vitest";

import type { ActiveTaskRef } from "../../src/routing/interruption-router.js";
import { InterruptionRouter } from "../../src/routing/interruption-router.js";

const activeTask: ActiveTaskRef = { taskId: "task-1", roleId: "code" };

describe("InterruptionRouter.classify", () => {
  const router = new InterruptionRouter();

  it.each([
    ["停，别说了", "stop_speech"],
    ["取消这个任务", "cancel"],
    ["不是这样，改成只跑单元测试", "steer"],
    ["做完以后把结果发邮件", "follow_up"],
  ] as const)("maps %s to %s", (text, expected) => {
    expect(router.classify(text, activeTask).kind).toBe(expected);
  });

  it("classifies a plain unrelated new request as new_task", () => {
    expect(router.classify("帮我查一下北京今天的天气", activeTask).kind).toBe("new_task");
  });

  it("classifies as new_task when there is no active task at all", () => {
    expect(router.classify("帮我写一封邮件", undefined).kind).toBe("new_task");
  });

  describe("stop_speech and cancel do not require an active task", () => {
    it("still recognizes an explicit stop phrase with no activeTask", () => {
      expect(router.classify("停，别说了", undefined).kind).toBe("stop_speech");
    });

    it("still recognizes an explicit cancel phrase with no activeTask", () => {
      expect(router.classify("取消这个任务", undefined).kind).toBe("cancel");
    });
  });

  describe("steer/follow_up require an active task to bind to", () => {
    it("falls back to new_task for a correction phrase with no activeTask", () => {
      expect(router.classify("不是这样，改成只跑单元测试", undefined).kind).toBe("new_task");
    });

    it("falls back to new_task for a follow-up phrase with no activeTask", () => {
      expect(router.classify("做完以后把结果发邮件", undefined).kind).toBe("new_task");
    });
  });

  describe("priority ordering", () => {
    it("prefers stop_speech over cancel when both phrases are present", () => {
      expect(router.classify("别说了，取消这个任务", activeTask).kind).toBe("stop_speech");
    });

    it("prefers cancel over steer/follow_up phrasing", () => {
      expect(router.classify("取消这个任务，不是这样的", activeTask).kind).toBe("cancel");
    });
  });

  describe("short ambiguous tokens require the whole utterance to match (exact tier)", () => {
    it("does not treat '停' inside an unrelated sentence about parking as stop_speech", () => {
      const result = router.classify("停车场那边人很多，不知道能不能停", activeTask);
      expect(result.kind).toBe("new_task");
    });

    it("still recognizes a bare '停' as stop_speech", () => {
      expect(router.classify("停", activeTask).kind).toBe("stop_speech");
    });

    it("tolerates trailing punctuation on a bare exact phrase", () => {
      expect(router.classify("停。", activeTask).kind).toBe("stop_speech");
      expect(router.classify("取消！", activeTask).kind).toBe("cancel");
    });

    it("does not treat '取消' mentioned mid-sentence about something else as cancel", () => {
      const result = router.classify("这个项目的预算被取消了", activeTask);
      expect(result.kind).toBe("new_task");
    });
  });

  describe("taskId propagation", () => {
    it("attaches the active task's id to cancel/steer/follow_up classifications", () => {
      expect(router.classify("取消这个任务", activeTask).taskId).toBe(activeTask.taskId);
      expect(router.classify("不是这样，改成只跑单元测试", activeTask).taskId).toBe(activeTask.taskId);
      expect(router.classify("做完以后把结果发邮件", activeTask).taskId).toBe(activeTask.taskId);
    });

    it("new_task classifications never carry a taskId", () => {
      expect(router.classify("帮我查一下北京今天的天气", activeTask).taskId).toBeUndefined();
    });
  });

  describe("English phrasing", () => {
    it.each([
      ["please stop talking now", "stop_speech"],
      ["cancel the task", "cancel"],
    ] as const)("maps %s to %s", (text, expected) => {
      expect(router.classify(text, activeTask).kind).toBe(expected);
    });
  });
});
