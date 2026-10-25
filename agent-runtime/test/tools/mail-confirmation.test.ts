import { describe, expect, it } from "vitest";

import { MailConfirmationGate } from "../../src/tools/mail/mail-confirmation.js";

describe("MailConfirmationGate", () => {
  it("refuses to confirm in the same turn it was prepared", () => {
    const gate = new MailConfirmationGate();
    gate.noteUserUtterance("给张三发邮件");
    const pending = gate.prepare("send:a", "send to a", "mail");

    expect(gate.consume(pending.id, "send:a")).toEqual({ ok: false, reason: expect.stringContaining("has not said yes") });
  });

  it("confirms once the user has spoken since, and only once", () => {
    const gate = new MailConfirmationGate();
    gate.noteUserUtterance("给张三发邮件");
    const pending = gate.prepare("send:a", "send to a", "mail");
    gate.noteUserUtterance("好，发吧");

    expect(gate.consume(pending.id, "send:a")).toEqual({ ok: true });
    expect(gate.consume(pending.id, "send:a").ok).toBe(false);
  });

  it("does not treat just any later utterance as consent", () => {
    const gate = new MailConfirmationGate();
    const pending = gate.prepare("send:a", "send to a", "mail");

    gate.noteUserUtterance("今天天气怎么样");
    gate.noteUserUtterance("好像要下雨");
    gate.noteUserUtterance("嗯……让我想想");

    expect(gate.consume(pending.id, "send:a").ok).toBe(false);
    expect(gate.pendingRoleId()).toBe("mail");
  });

  it("unlocks only on a recorded confirm; unrelated and unclear answers change nothing", () => {
    const gate = new MailConfirmationGate();
    const pending = gate.prepare("send:a", "send to a", "mail");

    gate.recordAnswer("unrelated");
    gate.recordAnswer("unclear");
    expect(gate.consume(pending.id, "send:a").ok).toBe(false);

    gate.recordAnswer("confirm");
    expect(gate.consume(pending.id, "send:a").ok).toBe(true);
  });

  it("a confirm recorded BEFORE the action was prepared does not count", () => {
    const gate = new MailConfirmationGate();
    gate.recordAnswer("confirm");
    const pending = gate.prepare("send:a", "send to a", "mail");

    expect(gate.consume(pending.id, "send:a").ok).toBe(false);
  });

  it("exposes the pending question for the decision layer, and drops it on a decline", () => {
    const gate = new MailConfirmationGate();
    expect(gate.pendingQuestion()).toBeUndefined();
    gate.prepare("send:a", "send 'hi' to a@b.com", "mail");

    expect(gate.pendingQuestion()).toEqual({ summary: "send 'hi' to a@b.com", roleId: "mail" });
    gate.recordAnswer("decline");
    expect(gate.pendingQuestion()).toBeUndefined();
  });

  it("treats different arguments as a different action", () => {
    const gate = new MailConfirmationGate();
    const pending = gate.prepare("send:a", "send to a", "mail");
    gate.noteUserUtterance("好");

    expect(gate.consume(pending.id, "send:b")).toEqual({ ok: false, reason: expect.stringContaining("differ") });
  });

  it("rejects an unknown id", () => {
    expect(new MailConfirmationGate().consume("mc_nope", "x").ok).toBe(false);
  });

  it("expires after the ttl", () => {
    let now = 1_000;
    const gate = new MailConfirmationGate({ now: () => now, ttlMs: 60_000 });
    const pending = gate.prepare("send:a", "send to a", "mail");
    gate.noteUserUtterance("好");
    now += 61_000;

    expect(gate.consume(pending.id, "send:a").ok).toBe(false);
    expect(gate.pendingRoleId()).toBeUndefined();
  });

  it("remembers which role is waiting for the answer", () => {
    const gate = new MailConfirmationGate();
    expect(gate.pendingRoleId()).toBeUndefined();
    gate.prepare("send:a", "send to a", "mail");

    expect(gate.pendingRoleId()).toBe("mail");
  });

  it("withdraws a pending action when the user refuses", () => {
    const gate = new MailConfirmationGate();
    const pending = gate.prepare("send:a", "send to a", "mail");

    gate.noteUserUtterance("算了，不发了");

    expect(gate.pendingRoleId()).toBeUndefined();
    expect(gate.consume(pending.id, "send:a").ok).toBe(false);
  });

  it("preparing the identical action again replaces the earlier id", () => {
    const gate = new MailConfirmationGate();
    const first = gate.prepare("send:a", "send to a", "mail");
    const second = gate.prepare("send:a", "send to a", "mail");
    gate.noteUserUtterance("好");

    expect(second.id).not.toBe(first.id);
    expect(gate.consume(first.id, "send:a").ok).toBe(false);
    expect(gate.consume(second.id, "send:a").ok).toBe(true);
  });
});
