import { describe, expect, it } from "vitest";

import { htmlToText, normalizeMailData } from "../../src/tools/mail/mail-policy.js";

// Shapes captured from the real agently-cli (`message +search` / `+read`).
describe("normalizeMailData with the real CLI's shapes", () => {
  it("formats address objects, maps created_at, and inverts is_read", () => {
    const message = normalizeMailData({
      message_id: "msg_1",
      subject: "Agent Mail 接入成功",
      snippet: "已为 AL-Mac.local 接入",
      from: { email: "admin@agent.qq.com", name: "Agent Mail 团队" },
      to: [{ email: "me@agent.qq.com", name: "me" }, { email: "bare@x.com" }],
      created_at: "2026-07-23T16:04:14Z",
      is_read: false,
    });

    expect(message.sender).toBe("Agent Mail 团队 <admin@agent.qq.com>");
    expect(message.to).toEqual(["me <me@agent.qq.com>", "bare@x.com"]);
    expect(message.receivedAt).toBe("2026-07-23T16:04:14Z");
    expect(message.isUnread).toBe(true);
    expect(message.body).toBe("已为 AL-Mac.local 接入");
  });

  it("reduces an HTML body to its visible text", () => {
    const message = normalizeMailData({
      body: "<!doctype html><html><head><style>p{color:red}</style></head><body><p>你好&nbsp;世界</p><script>alert(1)</script><div>第二行 &amp; 更多</div></body></html>",
      body_format: "HTML",
    });

    expect(message.body).toBe("你好 世界\n第二行 & 更多");
  });

  it("leaves plain text alone and still accepts the legacy string fixtures", () => {
    const message = normalizeMailData({ body: "a < b", from: "x@y.com", to: ["z@y.com"], is_unread: true, received_at: "t" });

    expect(message).toMatchObject({ body: "a < b", sender: "x@y.com", to: ["z@y.com"], isUnread: true, receivedAt: "t" });
  });

  it("decodes numeric entities and drops comments", () => {
    expect(htmlToText("a<!-- hidden -->&#38;&#x41;")).toBe("a &A");
  });
});
