/**
 * 人机验证管线（T27/T28/T29 共用件 + T32 模式化 + Turnstile 任务统一栅栏）：
 *
 * - generateQuestion：纯函数出题（注入 rng 可测）——a,b ∈ [1,9]，a+b 或
 *   （a ≥ b 时）a-b；正确答案 + 3 个互异干扰项乱序。按钮只携带所选值
 *   （"v:<n>"），正确答案只落 users.verify_answer。
 * - buildChallenge：math / button 整数题产物 { text, answer, keyboard }。
 * - sendVerificationCode：三模式统一出题顺序（design §8）——
 *   settings 快照 → 生成 nonce/hash（统一栅栏，三模式共用）→ **条件预留**
 *   （bot/user、未封禁、未验证、预期 mode/enabled/generation）→ 发送
 *   Telegram → CAS 回填 msgId（匹配 hash/generation）→ 失败按 hash/generation
 *   CAS 清理。Turnstile 模式发送 web_app 按钮（私聊 Mini App 入口）；
 *   验证关闭期间 / 凭据或 origin 不可用时不发送无法完成的 Mini App 请求
 *   （warn 跳过，绝不自动降级弱模式）；math / button 的关闭期间超限出题
 *   保持既有行为（CAS 匹配快照的实际 enabled 值，不要求恒 true）。
 * - handleVerifyCallback：答题回调。预检 = 题面归属 + 栅栏非空；正确答案
 *   走单条条件 UPDATE 最终裁决（completeCallbackVerification：hash/msgId/
 *   answer/generation/mode/enabled），只有 meta.changes=1 的获胜者执行成功
 *   副作用；答错换题固定预检时的 math/button 模式 + 新请求预留 + CAS 保存。
 * - announceVerificationPassed：共享成功通知（题面编辑 + 置顶真值刷新），
 *   错误策略显式注入——callback 保持 retryable 抛 / permanent warn；网页
 *   入口两种失败都 warn（D1 已提交，不回滚、不向客户端谎报失败）。
 *
 * 失败语义（design.md §四 + §10，binding）：
 * | 环节                          | retryable               | permanent          |
 * | 出题 send（门内提示）          | 抛（slot 已耗，宁丢一条） | warn 吞（清理栅栏） |
 * | 答题链 answerCb / edit 题 /    | 抛（重推收敛到失效分支，  | warn 继续          |
 * | edit 置顶（callback 策略）     |  幂等）                  |                    |
 * | 成功通知（web 策略）           | warn 吞                  | warn 吞            |
 * 系统消息（题面 / 提示 / 置顶编辑）一律不入 messages 账本。
 */
import {
  formatRateLimitVerifyButton,
  formatRateLimitVerifyQuestion,
  formatRateLimitVerifyTurnstile,
  formatVerifyButtonQuestion,
  formatVerifyQuestion,
  formatVerifyTurnstileQuestion,
  VERIFY_BUTTON_LABEL,
  VERIFY_EXPIRED_NOTICE,
  VERIFY_PASSED_TEXT,
  VERIFY_PASSED_TOAST,
  VERIFY_RETRY_PREFIX,
  VERIFY_TURNSTILE_BUTTON_LABEL,
  VERIFY_WRONG_TOAST,
} from "../copy";
import { parsePublicBaseUrl, parseSupportChatId } from "../env";
import { createVerifyRequest } from "../verification/request";
import { composePinnedText } from "./pinned";
import { findTopicByUser } from "../store/topics";
import { getVerificationSettings, type VerificationSettings } from "../store/settings";
import {
  attachVerifyMessage,
  clearVerificationRequest,
  completeCallbackVerification,
  getGovernanceSnapshot,
  reserveVerificationRequest,
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

/**
 * 纯按钮模式的单按钮键盘（T32）：唯一按钮即唯一合法答案 0（"v:0"）——
 * 与 optionsKeyboard 同为「载荷只携带所选值」形态，判卷路径完全复用。
 */
export function buttonKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [[{ text: VERIFY_BUTTON_LABEL, callback_data: "v:0" }]],
  };
}

/** 出题场景：普通新题（验证门）或超限重验（提示含限频数字，T29） */
export type VerificationSendKind =
  | { type: "question" }
  | { type: "overflow"; limit: number };

/** math / button 的整数题产物：text（题面正文）/ answer（落库）/ keyboard */
export interface IntegerChallenge {
  kind: "math" | "button";
  text: string;
  answer: number;
  keyboard: InlineKeyboardMarkup;
}

/** turnstile 的网页请求产物：web_app 按钮 + 请求标识（nonce 只进 URL） */
export interface TurnstileChallenge {
  kind: "turnstile";
  text: string;
  keyboard: InlineKeyboardMarkup;
  /** 原始随机标识（= URL 查询参数 r；D1 只存其 SHA-256 摘要） */
  nonce: string;
  /** SHA-256(nonce)：预留 / 回填 / 清理 / 最终裁决共用的栅栏键 */
  hash: string;
  /** 到期时间（创建 + 600 秒；design §3 常量） */
  expiresAt: string;
}

export type VerificationChallenge = IntegerChallenge | TurnstileChallenge;

/**
 * 统一出题（T32 模式化 + Turnstile 扩展）——math / button 纯构造：
 *
 * - math（默认）：现状数学题——题头 / 超限前缀文案（含 limit 数字）+ 4 选项
 *   按钮乱序，answer 只落库；
 * - button：纯按钮题面（超限形态保留同一限频前缀）+ 单按钮 "v:0" +
 *   answer 恒 0——判卷（selected === verifyAnswer）与归属判定零改动复用。
 */
export function buildChallenge(
  mode: "math" | "button",
  kind: VerificationSendKind,
): IntegerChallenge {
  if (mode === "button") {
    return {
      kind: "button",
      text:
        kind.type === "question"
          ? formatVerifyButtonQuestion()
          : formatRateLimitVerifyButton(kind.limit),
      answer: 0,
      keyboard: buttonKeyboard(),
    };
  }
  const question = generateQuestion();
  return {
    kind: "math",
    text:
      kind.type === "question"
        ? formatVerifyQuestion(question.expression)
        : formatRateLimitVerifyQuestion(kind.limit, question.expression),
    answer: question.answer,
    keyboard: optionsKeyboard(question.options),
  };
}

/**
 * turnstile 挑战的页面入口 origin：PUBLIC_BASE_URL（有效时优先，固定
 * canonical 地址）否则下传的可信请求 origin。返回 null = 无可用 HTTPS
 * origin（无法产出可打开的 Mini App 入口）。
 */
export function resolveVerifyOrigin(env: Cloudflare.Env, requestOrigin?: string): string | null {
  return parsePublicBaseUrl(env)?.origin ?? requestOrigin ?? null;
}

/**
 * 组装 turnstile 网页请求挑战（nonce/hash/到期同刻生成，页内完成 Siteverify）。
 * origin 不可用 / 凭据未配置 → null（调用方 warn 跳过，绝不发无法完成的
 * Mini App 请求，也绝不自动降级到弱模式）。
 */
export async function buildTurnstileChallenge(
  env: Cloudflare.Env,
  kind: VerificationSendKind,
  requestOrigin?: string,
): Promise<TurnstileChallenge | null> {
  const siteKey = env.TURNSTILE_SITE_KEY?.trim();
  const secretKey = env.TURNSTILE_SECRET_KEY?.trim();
  if (!siteKey || !secretKey) return null; // 凭据不齐：发出去也没法完成
  const origin = resolveVerifyOrigin(env, requestOrigin);
  if (origin === null) return null;
  const request = await createVerifyRequest(new Date(), 600_000);
  return {
    kind: "turnstile",
    text:
      kind.type === "question"
        ? formatVerifyTurnstileQuestion()
        : formatRateLimitVerifyTurnstile(kind.limit),
    keyboard: {
      inline_keyboard: [
        [
          {
            text: VERIFY_TURNSTILE_BUTTON_LABEL,
            web_app: { url: `${origin}/verify?r=${request.nonce}` },
          },
        ],
      ],
    },
    nonce: request.nonce,
    hash: request.hash,
    expiresAt: request.expiresAt as string,
  };
}

/**
 * 出题并发送到用户私聊（验证门 / 首联包 / 超限合并消息共用）。
 *
 * 统一顺序（design §8）：settings 快照 → 生成请求（三模式共用栅栏）→
 * **条件预留**（WHERE 含未封禁 / 未验证 / 当前实际配置 = 快照——预留与快照
 * 之间发生切换则预留失败，放弃本轮，重推重新走完整流程）→ 发送 → CAS 回填
 * msgId（匹配 hash/generation）→ 失败按 hash/generation CAS 清理。
 *
 * - math / button：保留既有题面 / 判卷形态，expiresAt=null（不新增题目超时）；
 *   关闭验证期间的超限出题路径 CAS 匹配快照的实际 enabled 值（不要求恒 true），
 *   行为零变化；
 * - turnstile：验证关闭期间 / 凭据或 origin 不可用 → warn 跳过（不发无法
 *   完成的 Mini App 请求，绝不自动降级弱模式）；发送的消息 answer 恒 null，
 *   请求 600 秒到期。
 *
 * sendMessage retryable → 尽力清理栅栏后抛（重推重出题，slot 已耗——宁丢
 * 一条不轰炸）；permanent → 清理栅栏后 warn 吞。参数 origin 来自 webhook
 * 请求（PUBLIC_BASE_URL 优先，见 resolveVerifyOrigin）。
 */
export async function sendVerificationCode(
  env: Cloudflare.Env,
  botId: number,
  userId: number,
  kind: VerificationSendKind = { type: "question" },
  requestOrigin?: string,
): Promise<void> {
  const settings: VerificationSettings = await getVerificationSettings(env.HODOR_DB);

  let text: string;
  let keyboard: InlineKeyboardMarkup;
  let answer: number | null;
  let fenceHash: string;
  let expiresAt: string | null;
  if (settings.verifyMode === "turnstile") {
    if (!settings.verifyEnabled) {
      // 关闭验证期间的限频路径：撤验证已由调用方完成；Mini App 请求在关闭
      // 期间永远无法完成——不发（重开验证后的下一条消息自然重出）
      console.warn(
        `[verify] user ${userId}: turnstile 模式且验证关闭，跳过出题（不发无法完成的网页请求）`,
      );
      return;
    }
    const turnstile = await buildTurnstileChallenge(env, kind, requestOrigin);
    if (turnstile === null) {
      console.warn(
        `[verify] user ${userId}: turnstile 凭据或公网地址不可用，跳过出题（绝不降级到弱模式；请检查 TURNSTILE_* 与 PUBLIC_BASE_URL / 请求 origin）`,
      );
      return;
    }
    text = turnstile.text;
    keyboard = turnstile.keyboard;
    answer = null;
    fenceHash = turnstile.hash;
    expiresAt = turnstile.expiresAt;
  } else {
    const integer = buildChallenge(settings.verifyMode, kind);
    const identity = await createVerifyRequest(new Date(), null);
    text = integer.text;
    keyboard = integer.keyboard;
    answer = integer.answer;
    fenceHash = identity.hash;
    expiresAt = null;
  }

  // 条件预留（先于发送）：0 行 = 快照读取后配置 / 治理态已变化，放弃本轮
  const reserved = await reserveVerificationRequest(
    env.HODOR_DB,
    botId,
    userId,
    {
      mode: settings.verifyMode,
      enabled: settings.verifyEnabled,
      generation: settings.verifyGeneration,
    },
    { hash: fenceHash, expiresAt },
  );
  if (!reserved) return;

  const client = createTelegramClient(env.TELEGRAM_BOT_TOKEN);
  const sent = await client.sendMessage({
    chat_id: userId,
    text,
    reply_markup: keyboard,
  });
  if (!sent.ok) {
    // 失败清理：仅当当前请求仍是本轮这个挑战（绝不误删并发的新挑战）；
    // 清理自身的失败不掩盖原始发送错误
    try {
      await clearVerificationRequest(env.HODOR_DB, botId, userId, {
        hash: fenceHash,
        generation: settings.verifyGeneration,
      });
    } catch {
      // 清理失败：重推后预留新请求会原子替换，无需在此处理
    }
    if (sent.kind === "retryable") {
      throw new Error(sent.errorMessage ?? "sendMessage retryable");
    }
    console.warn(
      `[verify] user ${userId}: 验证题发送 permanent，跳过（栅栏已清理）：${sent.errorMessage ?? "no detail"}`,
    );
    return;
  }
  // CAS 回填（D1 失败原样抛 → 重推重出题，旧题消息自然失效；0 行 = 挑战
  // 已被替换 / 作废，屏幕上的旧消息由归属判定拦下）
  await attachVerifyMessage(
    env.HODOR_DB,
    botId,
    userId,
    { hash: fenceHash, generation: settings.verifyGeneration },
    { msgId: sent.result.message_id, answer },
  );
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

/** 成功通知的错误策略：telegram = retryable 抛 / permanent warn；web = 全部 warn */
export type PassedNoticePolicy = "telegram" | "web";

function consumeEditFailure(
  userId: number,
  stage: string,
  policy: PassedNoticePolicy,
  error: { kind: "retryable" | "permanent"; errorMessage?: string },
): void {
  if (policy === "telegram" && error.kind === "retryable") {
    throw new Error(error.errorMessage ?? `${stage} retryable`);
  }
  console.warn(
    `[verify] user ${userId}: ${stage}${error.kind === "retryable" ? " retryable（web 策略 warn 吞）" : " permanent"}，跳过：${error.errorMessage ?? "no detail"}`,
  );
}

/**
 * 共享成功通知（design §10）：题面消息编辑为通过提示 + 置顶验证行按库内
 * 真值刷新。两条入口共享内容与顺序；错误策略显式注入——callback 策略保持
 * 阶段 4 语义（retryable 抛给 webhook 重推、permanent warn），web 策略两种
 * 失败都 warn（D1 已提交，通知失败绝不撤销验证、绝不向客户端谎报失败）。
 */
export async function announceVerificationPassed(
  env: Cloudflare.Env,
  client: TelegramClient,
  botId: number,
  userId: number,
  params: { chatId: number; messageId: number },
  policy: PassedNoticePolicy,
): Promise<void> {
  // 防御：调用方（callback / 网页路由）已先行解析并校验 SUPPORT_CHAT_ID；
  // 真到了 null 说明部署配置坏了——按 retryable 抛出让 5xx 暴露问题
  const supportChatId = parseSupportChatId(env);
  if (supportChatId === null) throw new Error("verify: SUPPORT_CHAT_ID 无效");

  const passed = await client.editMessageText({
    chat_id: params.chatId,
    message_id: params.messageId,
    text: VERIFY_PASSED_TEXT,
  });
  if (!passed.ok) {
    consumeEditFailure(userId, "通过提示编辑", policy, passed);
  }

  // 置顶验证行 → ✅（存量用户已有 topic 且已置顶才刷；否则下次 4a/4b 自然带
  // 新值）。文本组装走共享助手（快照真值 + topic note + settings 三态）。
  const topic = await findTopicByUser(env.HODOR_DB, botId, userId);
  if (!topic || topic.pinned_msg_id === null) return;
  const pinnedText = await composePinnedText(env.HODOR_DB, botId, userId);
  if (pinnedText === null) return;
  const refreshed = await client.editMessageText({
    chat_id: supportChatId,
    message_id: topic.pinned_msg_id,
    text: pinnedText,
  });
  if (!refreshed.ok) {
    consumeEditFailure(userId, "置顶验证行刷新", policy, refreshed);
  }
}

/**
 * 处理私聊题面按钮回调（webhook classify=callback 派发）。
 *
 * 1. data 非 `v:<数字>` / 无 message → 静默完成（毒丸防护，零 API 调用）；
 * 2. 预检（读一次快照 + 一次配置，之后的裁决全部以二者为锚）：行不存在 /
 *    栅栏 hash 为空（含升级前的旧 pending）/ verify_msg_id ≠ 回调消息 ID →
 *    提示「题目已失效」并完成——旧题 / 他人代答 / 重放 / 已清空全被拦；
 * 3. 答错：toast + 固定**预检模式**重出（math / button——绝不 await 后按
 *    可能已切换的 Turnstile 模式重构造整数题）：新请求预留 → edit 原消息 →
 *    CAS 保存（换题绝不恢复已被配置切换 / 新请求作废的旧 pending）；
 * 4. 答对：单条条件 UPDATE 最终裁决（completeCallbackVerification，含栅栏 /
 *    未封禁 / 未验证 / 预检配置），只有获胜者执行成功副作用（toast → 题面
 *    编辑 → 置顶刷新，telegram 错误策略）。
 */
export async function handleVerifyCallback(
  env: Cloudflare.Env,
  botId: number,
  callback: TelegramCallbackQueryRef,
): Promise<void> {
  // 防御：classify fail-closed 已挡 env 畸形，正常到不了这里（同 inbound 姿态）
  if (parseSupportChatId(env) === null) throw new Error("verify: SUPPORT_CHAT_ID 无效");

  // 1. 毒丸防护：载荷非 v:<数字>（含缺 message）→ 静默完成
  const message = callback.message;
  const data = typeof callback.data === "string" ? callback.data : "";
  const match = data.match(/^v:(\d+)$/);
  if (!message || !match) return;
  const selected = Number(match[1]);

  const client = createTelegramClient(env.TELEGRAM_BOT_TOKEN);

  // 2. 预检（同一时刻的快照 + 配置即本轮回调的裁决锚点）
  const snapshot = await getGovernanceSnapshot(env.HODOR_DB, botId, callback.from.id);
  const settings = await getVerificationSettings(env.HODOR_DB);
  if (
    snapshot === null ||
    snapshot.verifyRequestHash === null ||
    snapshot.verifyRequestGeneration === null ||
    snapshot.verifyMsgId !== message.message_id
  ) {
    await answerQuery(client, callback.id, VERIFY_EXPIRED_NOTICE);
    return;
  }
  const fence = {
    hash: snapshot.verifyRequestHash,
    generation: snapshot.verifyRequestGeneration,
  };

  // 3. 答错：固定预检模式原位重出（edit 同一消息——无新 push，频控面为零）。
  //    turnstile 模式的挑战没有整数按钮，此处 mode 必为 math/button；若快照
  //    与配置出现该矛盾（理论不可达），按「已失效」防御收敛
  if (selected !== snapshot.verifyAnswer) {
    if (settings.verifyMode === "turnstile") {
      await answerQuery(client, callback.id, VERIFY_EXPIRED_NOTICE);
      return;
    }
    await answerQuery(client, callback.id, VERIFY_WRONG_TOAST);
    const challenge = buildChallenge(settings.verifyMode, { type: "question" });
    // 新请求预留（新 hash；旧请求作废由预留原子完成）——0 行 = 配置 / 治理
    // 态已变化，本轮绝不 edit 屏幕消息（不得恢复已作废的旧 pending）
    const identity = await createVerifyRequest(new Date(), null);
    const reserved = await reserveVerificationRequest(
      env.HODOR_DB,
      botId,
      callback.from.id,
      {
        mode: settings.verifyMode,
        enabled: settings.verifyEnabled,
        generation: settings.verifyGeneration,
      },
      { hash: identity.hash, expiresAt: null },
    );
    if (!reserved) return;
    const edited = await client.editMessageText({
      chat_id: message.chat.id,
      message_id: message.message_id,
      // 重试前缀（copy 定稿）+ 模式化题面——math 模式下与阶段 4 文案逐字一致
      text: `${VERIFY_RETRY_PREFIX}${challenge.text}`,
      reply_markup: challenge.keyboard,
    });
    if (!edited.ok) {
      if (edited.kind === "retryable") {
        throw new Error(edited.errorMessage ?? "editMessageText retryable");
      }
      // permanent（如题面消息已被删）：栅栏已替换但屏幕未更新——旧消息回调
      // 会被预检（msgId 已空）拦下；下一次消息重新出题，语义自洽
      console.warn(
        `[verify] user ${callback.from.id}: 答错重出 permanent，跳过（旧消息回调将按已失效收敛）：${edited.errorMessage ?? "no detail"}`,
      );
      return;
    }
    // CAS 保存（匹配新 hash/generation）：0 行 = 预留后又被替换——屏幕新题
    // 由预检拦下，库内绝不出现无人持有的 pending
    await attachVerifyMessage(
      env.HODOR_DB,
      botId,
      callback.from.id,
      { hash: identity.hash, generation: settings.verifyGeneration },
      { msgId: message.message_id, answer: challenge.answer },
    );
    return;
  }

  // 4. 答对：单条条件 UPDATE 最终裁决（DB 真值先行）——meta.changes=1 才是
  //    本回调真实完成（重放 / 并发 / 换题 / 封禁 / 切换全部 0 行收敛失效）
  const won = await completeCallbackVerification(
    env.HODOR_DB,
    botId,
    callback.from.id,
    { ...fence, mode: settings.verifyMode, enabled: settings.verifyEnabled },
    { msgId: message.message_id, answer: snapshot.verifyAnswer ?? selected },
  );
  if (!won) {
    await answerQuery(client, callback.id, VERIFY_EXPIRED_NOTICE);
    return;
  }

  // 获胜者独享成功副作用（telegram 策略：retryable 抛重推 / permanent warn）
  await answerQuery(client, callback.id, VERIFY_PASSED_TOAST);
  await announceVerificationPassed(
    env,
    client,
    botId,
    callback.from.id,
    { chatId: message.chat.id, messageId: message.message_id },
    "telegram",
  );
}
