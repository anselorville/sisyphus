import { describe, expect, it } from "vitest";

import { MailConfirmationGate } from "../../src/tools/mail/mail-confirmation.js";

describe("MailConfirmationGate", () => {
  it("refuses to confirm in the same turn it was prepared", () => {
    const gate = new MailConfirmationGate();
    gate.noteUserUtterance("给张三发邮件");
    const pending = gate.prepare("send:a", "send to a", "mail");

    expect(gate.consume(pending.id, "send:a")).toEqual({ ok: false, reason: expect.stringContaining("has not answered") });
  });

  it("confirms once the user has spoken since, and only once", () => {
    const gate = new MailConfirmationGate();
    gate.noteUserUtterance("给张三发邮件");
    const pending = gate.prepare("send:a", "send to a", "mail");
    gate.noteUserUtterance("好，发吧");

    expect(gate.consume(pending.id, "send:a")).toEqual({ ok: true });
    expect(gate.consume(pending.id, "send:a").ok).toBe(false);
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
