import { beforeEach, describe, expect, it } from "vitest";

import { CapabilityGateway } from "../../../src/tools/capability-gateway.js";
import { DiplomacyOfficer } from "../../../src/tools/diplomacy-officer.js";
import { AgentlyCliError, AgentlyMailClient, MailElevationRequiredError } from "../../../src/tools/mail/agently-mail.js";
import type { AgentlyCliCall, AgentlyCliTransport, MailSendRequest } from "../../../src/tools/mail/agently-mail.js";

/**
 * Fake CLI harness, scoped to this test file. Records every argv array
 * agently-mail.ts would have spawned `agently-cli` with (never touches a
 * real process -- that's SpawnAgentlyCliTransport, exercised in production
 * only) and replays queued {exitCode, data, error} results in FIFO order.
 */
class FakeAgentlyCliTransport implements AgentlyCliTransport {
  readonly calls: Array<readonly string[]> = [];
  private readonly queue: AgentlyCliCall[] = [];

  queueResult(result: AgentlyCliCall): void {
    this.queue.push(result);
  }

  async run(args: readonly string[]): Promise<AgentlyCliCall> {
    this.calls.push(args);
    const next = this.queue.shift();
    if (!next) {
      throw new Error(`FakeAgentlyCliTransport: no queued result for call ${JSON.stringify(args)}`);
    }
    return next;
  }
}

/** Enough independently-addressed recipients to cross DiplomacyOfficer's default bulkAudienceThreshold (20). */
function bulkCampaign(count: number): MailSendRequest {
  return {
    to: Array.from({ length: count }, (_, index) => `user${index}@example.com`),
    subject: "Campaign",
    body: "Bulk message",
  };
}

describe("AgentlyMailClient", () => {
  let cli: FakeAgentlyCliTransport;
  let gateway: CapabilityGateway;
  let mail: AgentlyMailClient;

  beforeEach(() => {
    cli = new FakeAgentlyCliTransport();
    // Real DiplomacyOfficer + real CapabilityGateway, exactly as Task 11
    // shipped them -- this adapter must let their existing rules decide
    // ALLOW vs ELEVATE (default bulkAudienceThreshold: 20), not reimplement
    // bulk-detection itself.
    gateway = new CapabilityGateway({ officer: new DiplomacyOfficer() });
    mail = new AgentlyMailClient({ gateway, transport: cli });
  });

  describe("two-phase confirmation protocol", () => {
    it("automatically completes two CLI phases for a single email", async () => {
      cli.queueResult({ exitCode: 8, data: { confirmation_token: "ctk_1", summary: "send to a@example.com" } });
      cli.queueResult({ exitCode: 0, data: { message_id: "msg_1" } });
      const result = await mail.send({ to: ["a@example.com"], subject: "Hi", body: "Hello" });
      expect(result.messageId).toBe("msg_1");
      expect(cli.calls).toHaveLength(2);
    });

    it("requires elevation for bulk delivery", async () => {
      await expect(mail.send(bulkCampaign(50))).rejects.toMatchObject({ code: "ELEVATION_REQUIRED" });
      expect(cli.calls).toHaveLength(0);
    });

    it("passes the identical phase-1 arguments in phase 2, plus the confirmation token", async () => {
      cli.queueResult({ exitCode: 8, data: { confirmation_token: "ctk_2" } });
      cli.queueResult({ exitCode: 0, data: { message_id: "msg_2" } });
      await mail.send({ to: ["a@example.com"], subject: "Hi", body: "Hello" });

      expect(cli.calls[1]).toEqual([...cli.calls[0]!, "--confirmation-token", "ctk_2"]);
    });

    it("a handful of CC/BCC recipients is not bulk purely because count > 1", async () => {
      cli.queueResult({ exitCode: 8, data: { confirmation_token: "ctk_3" } });
      cli.queueResult({ exitCode: 0, data: { message_id: "msg_3" } });
      const result = await mail.send({
        to: ["a@example.com"],
        cc: ["b@example.com", "c@example.com"],
        subject: "Hi",
        body: "Hello",
      });
      expect(result.messageId).toBe("msg_3");
      expect(cli.calls).toHaveLength(2);
    });

    it("carries requestId/target over onto the reshaped elevation error", async () => {
      const error = await mail.send(bulkCampaign(30)).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(MailElevationRequiredError);
      const elevation = error as MailElevationRequiredError;
      expect(elevation.requestId).toBeTruthy();
      expect(elevation.target).toContain("30 recipient(s)");
    });

    it("reply and forward also drive the two-phase protocol, and elevate the same way as send", async () => {
      cli.queueResult({ exitCode: 8, data: { confirmation_token: "ctk_4" } });
      cli.queueResult({ exitCode: 0, data: { message_id: "msg_4" } });
      const replied = await mail.reply({ messageId: "msg_orig", body: "thanks" });
      expect(replied.messageId).toBe("msg_4");
      expect(cli.calls).toHaveLength(2);

      await expect(
        mail.forward({ messageId: "msg_orig", to: bulkCampaign(25).to, body: "fyi" }),
      ).rejects.toMatchObject({ code: "ELEVATION_REQUIRED" });
      expect(cli.calls).toHaveLength(2); // the elevated forward added zero further CLI calls
    });
  });

  describe("exit-code contract", () => {
    it("retries on exit code 1 (server error) up to the retry budget before succeeding", async () => {
      cli.queueResult({ exitCode: 1 });
      cli.queueResult({ exitCode: 1 });
      cli.queueResult({ exitCode: 0, data: { messages: [] } });

      const results = await mail.search({ query: "invoice" });

      expect(results).toEqual([]);
      expect(cli.calls).toHaveLength(3);
    });

    it("gives up after exhausting the retry budget on a persistent exit code 4", async () => {
      cli.queueResult({ exitCode: 4 });
      cli.queueResult({ exitCode: 4 });
      cli.queueResult({ exitCode: 4 });

      await expect(mail.search({ query: "invoice" })).rejects.toThrow(AgentlyCliError);
      expect(cli.calls).toHaveLength(3);
    });

    it.each([2, 3, 6])("never retries on exit code %i", async (exitCode) => {
      cli.queueResult({ exitCode, error: { message: `boom ${exitCode}` } });

      await expect(mail.search({ query: "invoice" })).rejects.toThrow(`boom ${exitCode}`);
      expect(cli.calls).toHaveLength(1);
    });

    it("honors Retry-After before retrying on exit code 7, then succeeds", async () => {
      const waited: number[] = [];
      const patientMail = new AgentlyMailClient({
        gateway,
        transport: cli,
        sleep: async (ms) => {
          waited.push(ms);
        },
      });
      cli.queueResult({ exitCode: 7, error: { retryAfterMs: 1500 } });
      cli.queueResult({ exitCode: 0, data: { messages: [] } });

      await patientMail.search({ query: "invoice" });

      expect(waited).toEqual([1500]);
      expect(cli.calls).toHaveLength(2);
    });
  });

  describe("read-shaped and trash operations", () => {
    it("read() normalizes the returned message and never needs a confirmation token", async () => {
      cli.queueResult({
        exitCode: 0,
        data: { message: { message_id: "msg_5", subject: "Re: report", body: "see attached", from: "a@example.com" } },
      });

      const message = await mail.read("msg_5");

      expect(message.messageId).toBe("msg_5");
      expect(message.subject).toBe("Re: report");
      expect(cli.calls).toHaveLength(1);
    });

    it("trash() is reversible (soft delete) and still completes the two-phase protocol autonomously", async () => {
      cli.queueResult({ exitCode: 8, data: { confirmation_token: "ctk_5" } });
      cli.queueResult({ exitCode: 0, data: {} });

      await mail.trash("msg_6");

      expect(cli.calls).toHaveLength(2);
      expect(cli.calls[1]).toEqual(["message", "+trash", "--id", "msg_6", "--confirmation-token", "ctk_5"]);
    });

    it("download() saves an attachment via a single CLI call, with no confirmation phase", async () => {
      cli.queueResult({ exitCode: 0, data: { saved_to: "./downloads/report.pdf" } });

      const result = await mail.download({ messageId: "msg_7", attachmentId: "att_1" });

      expect(result.savedTo).toBe("./downloads/report.pdf");
      expect(cli.calls).toHaveLength(1);
    });
  });
});
