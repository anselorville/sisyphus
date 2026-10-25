import { describe, expect, it } from "vitest";

import {
  CODE_ROLE_MANIFEST,
  DEVICE_ROLE_MANIFEST,
  GENERAL_ROLE_MANIFEST,
  INSPECTOR_ROLE_MANIFEST,
  MAIL_ROLE_MANIFEST,
  MEMORY_ROLE_MANIFEST,
  SCRIBE_ROLE_MANIFEST,
  WEB_ROLE_MANIFEST,
} from "../../src/roles/manifests.js";
import { ReflexRouter } from "../../src/routing/reflex-router.js";

// Same registration order as src/index.ts: provider order is match priority.
const providers = [
  GENERAL_ROLE_MANIFEST,
  CODE_ROLE_MANIFEST,
  WEB_ROLE_MANIFEST,
  DEVICE_ROLE_MANIFEST,
  MAIL_ROLE_MANIFEST,
  INSPECTOR_ROLE_MANIFEST,
  MEMORY_ROLE_MANIFEST,
  SCRIBE_ROLE_MANIFEST,
].map((manifest) => ({ roleId: manifest.id, capabilities: manifest.capabilities }));

function roleFor(transcript: string): string | undefined {
  return new ReflexRouter().route(transcript, { capabilityProviders: providers }).roleId;
}

describe("routing by what people actually say", () => {
  it.each([
    ["帮我看看最近收到了哪些邮件", "mail"],
    ["给张三发一封邮件，说明天开会", "mail"],
    ["我的收件箱里有没有未读的", "mail"],
    ["check my email", "mail"],
    ["后端服务还在运行吗", "device"],
    ["帮我重启一下后端", "device"],
    ["看一下服务状态", "device"],
    ["今天上海的天气怎么样", "web"],
  ])("%s -> %s", (transcript, role) => {
    expect(roleFor(transcript)).toBe(role);
  });

  it("leaves ordinary conversation to the general worker", () => {
    const decision = new ReflexRouter().route("你好，请用一句话介绍你自己", { capabilityProviders: providers });

    expect(decision.kind).toBe("general_worker");
  });
});
