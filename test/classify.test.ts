/**
 * classifyUpdate 纯函数直测（T15 分流规则 + fail-closed 决策）：
 * 私聊 / 客服群带 thread / 客服群无 thread（General）/ 其他群 / 超级群非客服 /
 * 无 message 的 update（edited_message、callback_query）/ 畸形形态 /
 * supportChatId === null → 全部 ignore（部署配置坏了零副作用）。
 */
import { describe, expect, it } from "vitest";
import { classifyUpdate } from "../src/pipeline/classify";

const SUPPORT_CHAT_ID = -1001234567890;

function message(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    message_id: 1,
    from: { id: 7001, first_name: "Alice" },
    chat: { id: 7001, type: "private" },
    text: "hello",
    ...overrides,
  };
}

function update(messageField?: Record<string, unknown>): Record<string, unknown> {
  return messageField === undefined
    ? { update_id: 9001 }
    : { update_id: 9001, message: messageField };
}

describe("classify: 标准分流", () => {
  it("私聊 → inbound", () => {
    expect(classifyUpdate(update(message()), SUPPORT_CHAT_ID)).toBe("inbound");
  });

  it("客服超级群 + message_thread_id → outbound", () => {
    const msg = message({
      from: { id: 111111111, first_name: "Admin" },
      chat: { id: SUPPORT_CHAT_ID, type: "supergroup" },
      message_thread_id: 100,
    });
    expect(classifyUpdate(update(msg), SUPPORT_CHAT_ID)).toBe("outbound");
  });

  it("客服群同链路但 message_thread_id 非数字 → ignore", () => {
    const msg = message({
      chat: { id: SUPPORT_CHAT_ID, type: "supergroup" },
      message_thread_id: "100",
    });
    expect(classifyUpdate(update(msg), SUPPORT_CHAT_ID)).toBe("ignore");
  });

  it("客服群无 thread（General / 非 topic 消息）→ ignore", () => {
    const msg = message({ chat: { id: SUPPORT_CHAT_ID, type: "supergroup" } });
    expect(classifyUpdate(update(msg), SUPPORT_CHAT_ID)).toBe("ignore");
  });

  it("其他群组 → ignore", () => {
    const msg = message({ chat: { id: -1009876543210, type: "supergroup" } });
    expect(classifyUpdate(update(msg), SUPPORT_CHAT_ID)).toBe("ignore");
  });

  it("非客服的普通 group → ignore", () => {
    const msg = message({ chat: { id: -777, type: "group" } });
    expect(classifyUpdate(update(msg), SUPPORT_CHAT_ID)).toBe("ignore");
  });
});

describe("classify: 无 message / 畸形形态", () => {
  it("edited_message（无 .message）→ ignore", () => {
    const edited = { update_id: 9002, edited_message: message() };
    expect(classifyUpdate(edited, SUPPORT_CHAT_ID)).toBe("ignore");
  });

  it("callback_query（无 .message）→ ignore", () => {
    const cb = { update_id: 9003, callback_query: { id: "1", from: { id: 7001 } } };
    expect(classifyUpdate(cb, SUPPORT_CHAT_ID)).toBe("ignore");
  });

  it("message.chat 缺 id / type / 非对象 → ignore", () => {
    expect(classifyUpdate(update(message({ chat: { type: "private" } })), SUPPORT_CHAT_ID)).toBe("ignore");
    expect(classifyUpdate(update(message({ chat: { id: 7001 } })), SUPPORT_CHAT_ID)).toBe("ignore");
    expect(classifyUpdate(update(message({ chat: null })), SUPPORT_CHAT_ID)).toBe("ignore");
  });

  it("update 本体非对象 → ignore", () => {
    expect(classifyUpdate("nope", SUPPORT_CHAT_ID)).toBe("ignore");
    expect(classifyUpdate(null, SUPPORT_CHAT_ID)).toBe("ignore");
  });
});

describe("classify: supportChatId === null（env 畸形）fail-closed", () => {
  it("私聊 → ignore（宁可零副作用，不产生半吊子转发）", () => {
    expect(classifyUpdate(update(message()), null)).toBe("ignore");
  });

  it("客服群带 thread → ignore", () => {
    const msg = message({
      chat: { id: SUPPORT_CHAT_ID, type: "supergroup" },
      message_thread_id: 100,
    });
    expect(classifyUpdate(update(msg), null)).toBe("ignore");
  });
});
