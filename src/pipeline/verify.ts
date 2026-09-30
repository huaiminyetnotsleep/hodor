/**
 * 数学题人机验证管线（T27/T28/T29 共用件）：
 *
 * - generateQuestion：纯函数出题（注入 rng 可测）——a,b ∈ [1,9]，a+b 或
 *   （a ≥ b 时）a-b；正确答案 + 3 个互异干扰项（同答案值域 [0,18]）乱序。
 *   按钮只携带所选值（"v:<n>"），正确答案只落 users.verify_answer，
 *   绝不进消息正文 / callback_data。
 * - sendVerificationCode：出题并发送（inbound 验证门与超限共用）——
 *   **先送达后落库**：sendMessage 成功才 setPendingVerification；
 *   落库失败原样抛（D1 → retryable 重推重出题，旧题消息自然失效）。
 * - handleVerifyCallback：答题回调。归属判定收敛为单道检查
 *   `verify_msg_id === cb.message.message_id`——旧题 / 他人代答 / 重放 /
 *   已清空全部被拦（提示题目已失效）。
 *
 * 失败语义（design.md §四，binding）：
 * | 环节                          | retryable               | permanent          |
 * | 出题 send（门内提示）          | 抛（slot 已耗，宁丢一条） | warn 吞（不落库）  |
 * | 答题链 answerCb / edit 题 /    | 抛（重推收敛到失效分支，  | warn 继续          |
 * | edit 置顶                     |  幂等）                  |                    |
 * 系统消息（题面 / 提示 / 置顶编辑）一律不入 messages 账本。
 */
import {
  formatPinnedInfo,
  formatRateLimitVerifyQuestion,
  formatVerifyQuestion,
  formatVerifyRetryQuestion,
  VERIFY_EXPIRED_NOTICE,
  VERIFY_PASSED_TEXT,
  VERIFY_PASSED_TOAST,
  VERIFY_WRONG_TOAST,
} from "../copy";
import { parseSupportChatId } from "../env";
import { findTopicByUser } from "../store/topics";
import {
  getGovernanceSnapshot,
  markVerified,
  setPendingVerification,
} from "../store/users";
import { createTelegramClient } from "../telegram/client";
import type {
  InlineKeyboardMarkup,
  TelegramClient,
} from "../telegram/types";
import type { TelegramCallbackQueryRef } from "./classify";

/** 算子值域上限：a,b ∈ [1,9]（design.md §二.4） */
const OPERAND_MAX = 9;
/** 答案值域：a-b ∈ [0,8]、a+b ∈ [2,18]，取并集 [0,18]（干扰项同值域） */
const ANSWER_MIN = 0;
const ANSWER_MAX = 18;
/** 选项数：1 个正确答案 + 3 个互异干扰项 */
const OPTION_COUNT = 4;

/** 出题结果：expression 供 copy 组装正文，options 顺序即按钮顺序 */
export interface GeneratedQuestion {
  /** 算式（如 "3 + 5 = ?"） */
  expression: string;
  /** 正确答案（只落 users.verify_answer） */
  answer: number;
  /** 4 个互异选项（含答案），乱序 */
  options: number[];
}

/** Fisher-Yates 洗牌（rng 须返回 [0,1) 均匀随机数，对齐 Math.random） */
function shuffled(values: readonly number[], rng: () => number): number[] {
  const arr = [...values];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * 出一道数学题（纯函数，注入 rng 供测试确定性断言）。
 *
 * 减法仅当 a ≥ b（避免负数答案），两种算式对半随机；干扰项从
 * 「答案值域内除答案外的全部取值」洗牌取前 3——候选池有限，绝不死循环。
 */
export function generateQuestion(rng: () => number = Math.random): GeneratedQuestion {
  const a = 1 + Math.floor(rng() * OPERAND_MAX);
  const b = 1 + Math.floor(rng() * OPERAND_MAX);
  const useSubtraction = a >= b && rng() < 0.5;
  const answer = useSubtraction ? a - b : a + b;
  const expression = `${a} ${useSubtraction ? "-" : "+"} ${b} = ?`;

  const candidates: number[] = [];
  for (let value = ANSWER_MIN; value <= ANSWER_MAX; value++) {
    if (value !== answer) candidates.push(value);
  }
  const distractors = shuffled(candidates, rng).slice(0, OPTION_COUNT - 1);
  return { expression, answer, options: shuffled([answer, ...distractors], rng) };
}

/**
 * 题面按钮：单行 4 个选项，callback_data 只携带所选值（"v:<n>"）——
 * 服务端按库内 verify_answer 判卷，按钮载荷里没有任何「哪 个是对的」信息。
 */
export function optionsKeyboard(options: readonly number[]): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      options.map((value) => ({ text: String(value), callback_data: `v:${value}` })),
    ],
  };
}

/** 出题场景：普通新题（验证门）或超限重验（提示含限频数字，T29） */
export type VerificationSendKind =
  | { type: "question" }
  | { type: "overflow"; limit: number };

/**
 * 出题并发送到用户私聊（验证门 / 首联包 / 超限合并消息共用）。
 *
 * 文案由 copy.ts 组装（超限形态含 limit 数字）；按钮为 4 选项 inline 键盘。
 * sendMessage retryable → 抛（重推重出题，slot 已耗——宁丢一条不轰炸）；
 * permanent → warn 吞且**不落库**（题未送达，库内不留 pending 态）。
 */
export async function sendVerificationCode(
  env: Cloudflare.Env,
  botId: number,
  userId: number,
  kind: VerificationSendKind = { type: "question" },
): Promise<void> {
  const question = generateQuestion();
  const text =
    kind.type === "question"
      ? formatVerifyQuestion(question.expression)
      : formatRateLimitVerifyQuestion(kind.limit, question.expression);

  const client = createTelegramClient(env.TELEGRAM_BOT_TOKEN);
  const sent = await client.sendMessage({
    chat_id: userId,
    text,
    reply_markup: optionsKeyboard(question.options),
  });
  if (!sent.ok) {
    if (sent.kind === "retryable") {
      throw new Error(sent.errorMessage ?? "sendMessage retryable");
    }
    console.warn(
      `[verify] user ${userId}: 验证题发送 permanent，跳过（不落库题目字段）：${sent.errorMessage ?? "no detail"}`,
    );
    return;
  }
  // 先送达后落库：D1 失败原样抛（→ retryable 重推重出题，旧题消息自然失效）
  await setPendingVerification(env.HODOR_DB, botId, userId, {
    answer: question.answer,
    msgId: sent.result.message_id,
  });
}

/** answerCallbackQuery 三态消费：retryable → 抛（重推）；permanent → warn 吞 */
async function answerQuery(
  client: TelegramClient,
  callbackQueryId: string,
  text: string,
): Promise<void> {
  const answered = await client.answerCallbackQuery({ callbackQueryId, text });
  if (!answered.ok) {
    if (answered.kind === "retryable") {
      throw new Error(answered.errorMessage ?? "answerCallbackQuery retryable");
    }
    console.warn(
      `[verify] callback ${callbackQueryId}: answerCallbackQuery permanent，跳过：${answered.errorMessage ?? "no detail"}`,
    );
  }
}

/**
 * 处理私聊题面按钮回调（webhook classify=callback 派发）。
 *
 * 1. data 非 `v:<数字>` / 无 message → 静默完成（毒丸防护，零 API 调用）；
 * 2. 归属判定：行不存在或 verify_msg_id ≠ 回调消息 ID（含已清空）→
 *    提示「题目已失效」并完成——旧题 / 他人代答 / 重放全部被此一道拦截；
 * 3. 答错：toast + **同一消息原位重出新题新按钮**（edit，无新 push、
 *    不占提示频控）+ 落库新答案（同 msgId）；
 * 4. 答对：markVerified（DB 真值先行）→ toast → 题面改通过提示 →
 *    有 topic 且已置顶则 editMessageText 刷新为 ✅ 已验证。
 */
export async function handleVerifyCallback(
  env: Cloudflare.Env,
  botId: number,
  callback: TelegramCallbackQueryRef,
): Promise<void> {
  // 防御：classify fail-closed 已挡 env 畸形，正常到不了这里（同 inbound 姿态）
  const supportChatId = parseSupportChatId(env);
  if (supportChatId === null) throw new Error("verify: SUPPORT_CHAT_ID 无效");

  // 1. 毒丸防护：载荷非 v:<数字>（含缺 message）→ 静默完成
  const message = callback.message;
  const data = typeof callback.data === "string" ? callback.data : "";
  const match = data.match(/^v:(\d+)$/);
  if (!message || !match) return;
  const selected = Number(match[1]);

  const client = createTelegramClient(env.TELEGRAM_BOT_TOKEN);

  // 2. 归属判定（单道检查收敛全部失效形态）
  const snapshot = await getGovernanceSnapshot(env.HODOR_DB, botId, callback.from.id);
  if (snapshot === null || snapshot.verifyMsgId !== message.message_id) {
    await answerQuery(client, callback.id, VERIFY_EXPIRED_NOTICE);
    return;
  }

  // 3. 答错：原位重出（edit 同一消息——无新 push，频控面为零）
  if (selected !== snapshot.verifyAnswer) {
    await answerQuery(client, callback.id, VERIFY_WRONG_TOAST);
    const question = generateQuestion();
    const edited = await client.editMessageText({
      chat_id: message.chat.id,
      message_id: message.message_id,
      text: formatVerifyRetryQuestion(question.expression),
      reply_markup: optionsKeyboard(question.options),
    });
    if (!edited.ok) {
      if (edited.kind === "retryable") {
        throw new Error(edited.errorMessage ?? "editMessageText retryable");
      }
      // permanent（如题面消息已被删）：保持旧答案判定不变——屏幕题面未换，
      // 库内答案也不换，用户下一次点击仍按旧题判卷，语义自洽
      console.warn(
        `[verify] user ${callback.from.id}: 答错重出 permanent，跳过（保留旧题判定）：${edited.errorMessage ?? "no detail"}`,
      );
      return;
    }
    await setPendingVerification(env.HODOR_DB, botId, callback.from.id, {
      answer: question.answer,
      msgId: message.message_id,
    });
    return;
  }

  // 4. 答对：DB 真值先行（重放 / 并发第二次落入上面的失效分支，幂等）
  await markVerified(env.HODOR_DB, botId, callback.from.id);
  await answerQuery(client, callback.id, VERIFY_PASSED_TOAST);

  const passed = await client.editMessageText({
    chat_id: message.chat.id,
    message_id: message.message_id,
    text: VERIFY_PASSED_TEXT,
  });
  if (!passed.ok) {
    if (passed.kind === "retryable") {
      throw new Error(passed.errorMessage ?? "editMessageText retryable");
    }
    console.warn(
      `[verify] user ${callback.from.id}: 通过提示编辑 permanent，跳过：${passed.errorMessage ?? "no detail"}`,
    );
  }

  // 置顶验证行 → ✅（存量用户已有 topic 且已置顶才刷；否则下次 4a/4b 自然带新值）
  const topic = await findTopicByUser(env.HODOR_DB, botId, callback.from.id);
  if (!topic || topic.pinned_msg_id === null) return;
  const refreshed = await client.editMessageText({
    chat_id: supportChatId,
    message_id: topic.pinned_msg_id,
    text: formatPinnedInfo({
      id: callback.from.id,
      first_name: snapshot.firstName,
      last_name: snapshot.lastName,
      username: snapshot.username,
      firstSeenAt: snapshot.firstSeenAt,
      isVerified: true,
    }),
  });
  if (!refreshed.ok) {
    if (refreshed.kind === "retryable") {
      throw new Error(refreshed.errorMessage ?? "editMessageText retryable");
    }
    console.warn(
      `[verify] user ${callback.from.id}: 置顶验证行刷新 permanent，跳过：${refreshed.errorMessage ?? "no detail"}`,
    );
  }
}
