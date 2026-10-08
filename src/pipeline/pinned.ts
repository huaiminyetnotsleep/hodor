/**
 * 置顶信息组装 / 刷新共享助手（阶段 5 M2，design.md §二.7 / §二.9）：
 *
 * 置顶文本的字段来源此前散落在 inbound ②/③/④、verify 通过链、（M2 起）
 * commands 刷新——note / isRisk / verify 三态接入后每组调用点都要拼一遍
 * 「快照 + topic 行 + settings」的字段集，重复且易漂移。本模块收口：
 *
 * - composePinnedText：唯一组装点——users 行（治理快照：展示列 + isRisk +
 *   isVerified）+ topics 行（note）+ settings（verify 三态映射：disabled
 *   覆盖真值）→ formatPinnedText 文本；users 或 topics 行缺失 → null。
 *   可选 overrides 强制覆盖个别字段（超限 / TTL 降级必须显示 ❌，即便
 *   settings 为其他态）。
 * - editPinnedBestEffort：命令（/note /unnote /risk /unrisk）内置顶刷新——
 *   best-effort（design §三「命令内置顶刷新」行：确认回复已反馈，置顶是
 *   展示面，两种失败均 warn 吞，绝不放大用户消息重发面）。
 * - downgradePinnedToUnverified：inbound ③ 超限 / ② TTL 过期的置顶降级 ❌
 *   （同为 best-effort；强制 verify="unverified"）。
 *
 * 系统消息语义（error-handling spec）：置顶编辑不入 messages 账本。
 */
import { formatPinnedInfo, type PinnedInfoUser } from "../copy";
import { parseSupportChatId } from "../env";
import { findTopicByUser } from "../store/topics";
import { getVerificationSettings } from "../store/settings";
import { getGovernanceSnapshot } from "../store/users";
import type { TelegramClient } from "../telegram/types";

/**
 * 组装某用户置顶信息正文（库内真值单一来源）。
 *
 * verify 三态映射：settings.verifyEnabled=false → "disabled"（关闭期间恒
 * 「未启用」，覆盖库内真值——此时无从谈验证状态）；开启时按快照 is_verified
 * 映射 "verified" / "unverified"。overrides 在组装结果上强制覆盖（如降级路径
 * 强制 ❌）——展开在最后，优先级最高。
 * users 行或 topics 行缺失 → null（无可组装的真值；调用方按需跳过）。
 */
export async function composePinnedText(
  db: D1Database,
  botId: number,
  userId: number,
  overrides?: Partial<PinnedInfoUser>,
): Promise<string | null> {
  const [snapshot, topic, settings] = await Promise.all([
    getGovernanceSnapshot(db, botId, userId),
    findTopicByUser(db, botId, userId),
    getVerificationSettings(db),
  ]);
  if (!snapshot || !topic) return null;
  return formatPinnedInfo({
    id: userId,
    first_name: snapshot.firstName,
    last_name: snapshot.lastName,
    username: snapshot.username,
    firstSeenAt: snapshot.firstSeenAt,
    verify: settings.verifyEnabled
      ? snapshot.isVerified
        ? "verified"
        : "unverified"
      : "disabled",
    isRisk: snapshot.isRisk,
    note: topic.note,
    ...overrides,
  });
}

/**
 * 置顶刷新内核：定位 pinned_msg_id → compose 组文本 → editMessageText。
 *
 * 跳过条件（零 API 调用）：无 topics 映射行 / pinned_msg_id 为 null（尚未
 * 置顶——下次 4a 自然带新值）/ compose 为 null（users 行缺失的竞态窗口）。
 * editMessageText 两种失败（retryable / permanent）均 console.warn 吞：
 * 置顶是 best-effort 展示面（design §三），调用方各自的确认 / 主链反馈
 * 不受影响。
 */
async function editPinned(
  env: Cloudflare.Env,
  client: TelegramClient,
  botId: number,
  userId: number,
  overrides?: Partial<PinnedInfoUser>,
): Promise<void> {
  // 防御：classify 对 SUPPORT_CHAT_ID===null fail-closed，正常到不了这里
  //（同 inbound / verify 姿态）——畸形即无处可 edit，跳过
  const supportChatId = parseSupportChatId(env);
  if (supportChatId === null) return;
  const topic = await findTopicByUser(env.HODOR_DB, botId, userId);
  if (!topic || topic.pinned_msg_id === null) return;
  const text = await composePinnedText(env.HODOR_DB, botId, userId, overrides);
  if (text === null) return;
  const edited = await client.editMessageText({
    chat_id: supportChatId,
    message_id: topic.pinned_msg_id,
    text,
  });
  if (!edited.ok) {
    console.warn(
      `[pinned] user ${userId}: 置顶刷新失败（best-effort 跳过）：${edited.errorMessage ?? "no detail"}`,
    );
  }
}

/**
 * 命令内置顶刷新（/note /unnote /risk /unrisk 在 setter 之后调用）：
 * best-effort——确认回复已保证管理员有反馈，置顶 edit 失败（含消息已被
 * 手工删除等 permanent）绝不阻断命令、绝不抛（重推会重发确认回复）。
 */
export async function editPinnedBestEffort(
  env: Cloudflare.Env,
  client: TelegramClient,
  botId: number,
  userId: number,
): Promise<void> {
  await editPinned(env, client, botId, userId);
}

/**
 * 置顶验证行降级 ❌（inbound ③ 超限撤验证后 / ② TTL 过期撤验证后）：
 * 强制 verify="unverified"——降级时刻的置顶必须显示 ❌，即便 settings
 * 已切到其他态（关闭态的「未启用」是门放行的展示，不是验证失败的展示）。
 * best-effort 与 4b 刷新同款：两种失败均 warn 吞（降级失败不抛断主流程）。
 */
export async function downgradePinnedToUnverified(
  env: Cloudflare.Env,
  client: TelegramClient,
  botId: number,
  userId: number,
): Promise<void> {
  await editPinned(env, client, botId, userId, { verify: "unverified" });
}
