/**
 * classifyUpdate 纯函数直测（分流规则 + fail-closed 决策 +  callback 分流
 * + General /broadcast 专用分类 + General 全局命令放行）：私聊 / 客服群带 thread /
 * 客服群无 thread（General：/broadcast 进广播路径、全局配置命令与 /help 放行
 * outbound，其余 ignore）/ 其他群 / 超级群非客服 /
 * 私聊 callback_query（验证题按钮）→ callback、群内 / 畸形 callback → ignore、
 * 无 message 且无 callback_query（edited_message）/ 畸形形态 /
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

/** 私聊题面按钮 callback_query 构造（overrides 直接覆盖顶层键） */
function callbackQuery(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "cb-1",
    from: { id: 7001, first_name: "Alice" },
    message: { message_id: 55, chat: { id: 7001, type: "private" } },
    data: "v:7",
    ...overrides,
  };
}

function callbackUpdate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { update_id: 9005, callback_query: callbackQuery(overrides) };
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

 it("客服群无 thread 且首 token 为 /broadcast → broadcast（全用户广播专用入口）", () => {
    const supportGeneral = (text: string) =>
      message({
        from: { id: 111111111, first_name: "Admin" },
        chat: { id: SUPPORT_CHAT_ID, type: "supergroup" },
        text,
      });
    expect(classifyUpdate(update(supportGeneral("/broadcast")), SUPPORT_CHAT_ID)).toBe("broadcast");
    expect(classifyUpdate(update(supportGeneral("/broadcast@hodor_bot 标题\n正文")), SUPPORT_CHAT_ID)).toBe("broadcast");
    expect(classifyUpdate(update(supportGeneral("/broadcast 标题")), SUPPORT_CHAT_ID)).toBe("broadcast");
 // thread 字段若存在但非法，不能误降级为 General 广播
    expect(
      classifyUpdate(
        update({ ...supportGeneral("/broadcast 标题"), message_thread_id: 0 }),
        SUPPORT_CHAT_ID,
      ),
    ).toBe("ignore");
    expect(
      classifyUpdate(
        update({ ...supportGeneral("/broadcast 标题"), message_thread_id: "100" }),
        SUPPORT_CHAT_ID,
      ),
    ).toBe("ignore");
 // 前缀巧合 / 非命令 / 普通 General 消息仍 ignore
    expect(classifyUpdate(update(supportGeneral("/broadcasts xx")), SUPPORT_CHAT_ID)).toBe("ignore");
    expect(classifyUpdate(update(supportGeneral("普通群聊")), SUPPORT_CHAT_ID)).toBe("ignore");
 // text 缺失（非字符串）→ ignore
    const noText = message({
      from: { id: 111111111, first_name: "Admin" },
      chat: { id: SUPPORT_CHAT_ID, type: "supergroup" },
    });
    expect(classifyUpdate(update(noText), SUPPORT_CHAT_ID)).toBe("ignore");
 // 带 thread 的 /broadcast 走 outbound（命令管线在 topic 内只提示去 General）
    const inTopic = message({
      from: { id: 111111111, first_name: "Admin" },
      chat: { id: SUPPORT_CHAT_ID, type: "supergroup" },
      text: "/broadcast 标题\n正文",
      message_thread_id: 100,
    });
    expect(classifyUpdate(update(inTopic), SUPPORT_CHAT_ID)).toBe("outbound");
  });

 it("客服群 General 全局命令→ outbound（执行门在 commands 层）", () => {
    const supportGeneral = (text: string, extra: Record<string, unknown> = {}) =>
      message({
        from: { id: 111111111, first_name: "Admin" },
        chat: { id: SUPPORT_CHAT_ID, type: "supergroup" },
        text,
        ...extra,
      });
 // 放行集合七个命令，含 @bot 后缀形态
    for (const text of [
      "/verifyon",
      "/verifyoff",
      "/verifymode",
      "/verifymode_math",
      "/verifymode_button",
      "/verifymode_turnstile",
      "/help",
      "/verifymode@hodor_bot",
      "/verifymode_turnstile@hodor_bot",
    ]) {
      expect(classifyUpdate(update(supportGeneral(text)), SUPPORT_CHAT_ID)).toBe("outbound");
    }
  });

 it("General 非放行命令 / 前缀巧合 / 普通文本仍 ignore（不扩大中继范围）", () => {
    const supportGeneral = (text: string) =>
      message({
        from: { id: 111111111, first_name: "Admin" },
        chat: { id: SUPPORT_CHAT_ID, type: "supergroup" },
        text,
      });
    for (const text of [
      "/ban",
      "/note 仅咨询",
      "/archive",
      "/broadcasts",
      "/verifymodes",
      "/helpx",
      "/verifymode_butto",
      "/HELP",
      "普通群聊",
    ]) {
      expect(classifyUpdate(update(supportGeneral(text)), SUPPORT_CHAT_ID)).toBe("ignore");
    }
  });

 it("General 放行命令带非法 thread 字段 → ignore（不误降级）；带合法 thread → 正常 outbound", () => {
    const supportGeneral = (text: string, extra: Record<string, unknown>) =>
      message({
        from: { id: 111111111, first_name: "Admin" },
        chat: { id: SUPPORT_CHAT_ID, type: "supergroup" },
        text,
        ...extra,
      });
    expect(
      classifyUpdate(update(supportGeneral("/help", { message_thread_id: 0 })), SUPPORT_CHAT_ID),
    ).toBe("ignore");
    expect(
      classifyUpdate(
        update(supportGeneral("/verifymode_math", { message_thread_id: "100" })),
        SUPPORT_CHAT_ID,
      ),
    ).toBe("ignore");
    expect(
      classifyUpdate(update(supportGeneral("/help", { message_thread_id: 100 })), SUPPORT_CHAT_ID),
    ).toBe("outbound");
  });

 it("私聊中的 /broadcast 仍是 inbound（不会进入客服群广播分类）", () => {
    const privateCommand = message({
      chat: { id: 7001, type: "private" },
      text: "/broadcast 标题\n正文",
    });
    expect(classifyUpdate(update(privateCommand), SUPPORT_CHAT_ID)).toBe("inbound");
  });

 it("其他群组 → ignore（含其他群的 /broadcast：广播绝不从外群发起）", () => {
    const msg = message({ chat: { id: -1009876543210, type: "supergroup" } });
    expect(classifyUpdate(update(msg), SUPPORT_CHAT_ID)).toBe("ignore");
    const foreignBroadcast = message({
      chat: { id: -1009876543210, type: "supergroup" },
      text: "/broadcast 标题\n正文",
    });
    expect(classifyUpdate(update(foreignBroadcast), SUPPORT_CHAT_ID)).toBe("ignore");
  });

 it("非客服的普通 group → ignore", () => {
    const msg = message({ chat: { id: -777, type: "group" } });
    expect(classifyUpdate(update(msg), SUPPORT_CHAT_ID)).toBe("ignore");
  });
});

describe("classify: callback_query 分流（验证题按钮）", () => {
 it("私聊题面回调（id / from.id / message_id / chat.type 全合法）→ callback", () => {
    expect(classifyUpdate(callbackUpdate(), SUPPORT_CHAT_ID)).toBe("callback");
  });

 it("id 非字符串（缺失 / 数字）→ ignore（畸形 id 不进 answerCallbackQuery，形态防护在分流层收口）", () => {
    expect(classifyUpdate(callbackUpdate({ id: undefined }), SUPPORT_CHAT_ID)).toBe("ignore");
    expect(classifyUpdate(callbackUpdate({ id: 12345 }), SUPPORT_CHAT_ID)).toBe("ignore");
  });

 it("客服群内回调（chat.id = SUPPORT_CHAT_ID）→ group_callback（wipe 确认键盘）", () => {
    expect(
      classifyUpdate(
        callbackUpdate({ message: { message_id: 55, chat: { id: SUPPORT_CHAT_ID, type: "supergroup" } } }),
        SUPPORT_CHAT_ID,
      ),
    ).toBe("group_callback");
  });

 it("其他群内回调（非客服群）→ ignore（不存在合法按钮形态）", () => {
    expect(
      classifyUpdate(
        callbackUpdate({ message: { message_id: 55, chat: { id: -1009876543210, type: "supergroup" } } }),
        SUPPORT_CHAT_ID,
      ),
    ).toBe("ignore");
  });

 it("缺 message（极老客户端形态）→ ignore", () => {
    expect(classifyUpdate(callbackUpdate({ message: undefined }), SUPPORT_CHAT_ID)).toBe("ignore");
  });

 it("from 缺 id / 非对象 → ignore（归属判定无依据，零副作用）", () => {
    expect(classifyUpdate(callbackUpdate({ from: {} }), SUPPORT_CHAT_ID)).toBe("ignore");
    expect(classifyUpdate(callbackUpdate({ from: "alice" }), SUPPORT_CHAT_ID)).toBe("ignore");
  });

 it("message.message_id / chat.id 非数字 → ignore", () => {
    expect(
      classifyUpdate(callbackUpdate({ message: { message_id: "55", chat: { id: 7001, type: "private" } } }), SUPPORT_CHAT_ID),
    ).toBe("ignore");
    expect(
      classifyUpdate(callbackUpdate({ message: { message_id: 55, chat: { id: "7001", type: "private" } } }), SUPPORT_CHAT_ID),
    ).toBe("ignore");
  });

 it("data 形态不在分流职责内（v:<n> 判定在 verify 管线毒丸防护）——任意 data 都 callback", () => {
    expect(classifyUpdate(callbackUpdate({ data: "junk" }), SUPPORT_CHAT_ID)).toBe("callback");
    expect(classifyUpdate(callbackUpdate({ data: undefined }), SUPPORT_CHAT_ID)).toBe("callback");
  });
});

describe("classify: 无 message / 畸形形态", () => {
 it("edited_message（无 .message）→ ignore", () => {
    const edited = { update_id: 9002, edited_message: message() };
    expect(classifyUpdate(edited, SUPPORT_CHAT_ID)).toBe("ignore");
  });

 it("callback_query 无 message 字段 → ignore", () => {
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

describe("classify: Telegram 原生 forum topic 状态事件", () => {
 it("客服群带合法 thread 的 forum_topic_closed / reopened → topic_event", () => {
    const base = {
      chat: { id: SUPPORT_CHAT_ID, type: "supergroup" },
      message_thread_id: 123,
    };
    expect(
      classifyUpdate(update(message({ ...base, forum_topic_closed: {} })), SUPPORT_CHAT_ID),
    ).toBe("topic_event");
    expect(
      classifyUpdate(update(message({ ...base, forum_topic_reopened: {} })), SUPPORT_CHAT_ID),
    ).toBe("topic_event");
  });

 it("其他群、缺 thread、双事件或畸形事件 → ignore", () => {
    expect(
      classifyUpdate(
        update(message({ chat: { id: -1009876543210, type: "supergroup" }, message_thread_id: 123, forum_topic_closed: {} })),
        SUPPORT_CHAT_ID,
      ),
    ).toBe("ignore");
    expect(
      classifyUpdate(update(message({ chat: { id: SUPPORT_CHAT_ID, type: "supergroup" }, forum_topic_closed: {} })), SUPPORT_CHAT_ID),
    ).toBe("ignore");
    expect(
      classifyUpdate(
        update(message({
          chat: { id: SUPPORT_CHAT_ID, type: "supergroup" },
          message_thread_id: 123,
          forum_topic_closed: {},
          forum_topic_reopened: {},
        })),
        SUPPORT_CHAT_ID,
      ),
    ).toBe("ignore");
    expect(
      classifyUpdate(
        update(message({ chat: { id: SUPPORT_CHAT_ID, type: "supergroup" }, message_thread_id: 123, forum_topic_closed: null })),
        SUPPORT_CHAT_ID,
      ),
    ).toBe("ignore");
    expect(
      classifyUpdate(
        update(message({ message_id: "not-an-id", chat: { id: SUPPORT_CHAT_ID, type: "supergroup" }, message_thread_id: 123, forum_topic_closed: {} })),
        SUPPORT_CHAT_ID,
      ),
    ).toBe("ignore");
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

 it("合法形态的私聊 callback → 同样 ignore（fail-closed 覆盖新分流）", () => {
    expect(classifyUpdate(callbackUpdate(), null)).toBe("ignore");
  });
});
