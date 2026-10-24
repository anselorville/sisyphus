import { describe, expect, it } from "vitest";

import { normalizeForSpeech } from "../../src/roles/pi-event-adapter.js";

describe("normalizeForSpeech", () => {
  it("strips bold and italic markers but keeps the words", () => {
    expect(normalizeForSpeech("**日常问答和解释**——概念、常识")).toBe("日常问答和解释——概念、常识");
    expect(normalizeForSpeech("这是 *重点* 内容")).toBe("这是 重点 内容");
  });

  it("drops a lone marker whose partner is in another streamed chunk", () => {
    expect(normalizeForSpeech("**两条底线**——没做完的事我会说还在跑，不会编一个结果给你；")).toBe(
      "两条底线——没做完的事我会说还在跑，不会编一个结果给你；",
    );
    expect(normalizeForSpeech("还有一点**")).toBe("还有一点");
  });

  it("removes heading and list markers", () => {
    expect(normalizeForSpeech("## 小标题")).toBe("小标题");
    expect(normalizeForSpeech("- 第一点\n- 第二点")).toBe("第一点，第二点");
    expect(normalizeForSpeech("1. 先开机\n2) 再登录")).toBe("先开机，再登录");
  });

  it("reads links and images as their label and drops code", () => {
    expect(normalizeForSpeech("详见[官方文档](https://example.com/docs)")).toBe("详见官方文档");
    expect(normalizeForSpeech("![架构图](a.png)如上")).toBe("架构图如上");
    expect(normalizeForSpeech("运行 `npm test` 即可")).toBe("运行 npm test 即可");
    expect(normalizeForSpeech("先看这段：\n```ts\nconst a = 1;\n```\n然后继续")).toBe("先看这段：，然后继续");
  });

  it("turns line breaks into a single spoken pause", () => {
    expect(normalizeForSpeech("第一句\n\n第二句")).toBe("第一句，第二句");
  });

  it("leaves ordinary spoken text untouched", () => {
    expect(normalizeForSpeech("我是 Marcus，你的语音助手。")).toBe("我是 Marcus，你的语音助手。");
  });
});
