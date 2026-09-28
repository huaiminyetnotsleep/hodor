/**
 * domain · Topic 标题与 display_name 渲染纯函数（S4，docs/02「Topic 标题规则」）。
 *
 * 标题始终由数据库当前状态全量重渲染，绝不在旧标题上做字符串追加/删除（docs/02）；
 * 仅在 Topic 创建与改名刷新两个时机调用（editForumTopic），本模块不触碰任何 IO。
 */

/** Telegram Topic 名称上限（docs/02）；预算按 JS 字符串长度（UTF-16 码元）计，截断只落在 display_name */
export const TITLE_MAX_LENGTH = 128;

const ICON_NORMAL = '👤';
const ICON_WATCHLISTED = '⚠️';
const ICON_BLOCKED = '🔇';

/**
 * 标题图标：封禁优先于高危（docs/02：两标志同时置位时显示 🔇，解封后恢复 ⚠️）。
 * 不定义其他状态图标（docs/02：避免无对应流程的视觉噪音）。
 */
export function titleIcon(blocked: boolean, watchlisted: boolean): string {
  if (blocked) return ICON_BLOCKED;
  if (watchlisted) return ICON_WATCHLISTED;
  return ICON_NORMAL;
}

/**
 * display_name 渲染（docs/03 速查：first_name/last_name/username）：
 * `first last` → username → telegram_user_id 字符串（判空原则，永不返回空串）。
 */
export function renderDisplayName(user: { id: number; first_name: string; last_name?: string; username?: string }): string {
  const fullName = [user.first_name, user.last_name]
    .filter((part) => part !== undefined && part.length > 0)
    .join(' ')
    .trim();
  if (fullName.length > 0) return fullName;
  if (user.username !== undefined && user.username.length > 0) return user.username;
  return String(user.id);
}

export interface TitleInput {
  /** customers.id —— 标题中的 #序号 */
  customerId: number;
  /** 完整显示，永不截断（docs/02：截断只落在 display_name） */
  telegramUserId: number;
  displayName: string;
  blocked: boolean;
  watchlisted: boolean;
}

/**
 * 渲染标题：`{icon} {display_name} {telegram_user_id} · #{customer_id}`（design.md 语义 5）。
 * 预算 128：先扣 icon、空格、telegram_user_id、' · #'、customer_id 等固定部分，
 * 余量截断 display_name（可为空时由调用方先经 renderDisplayName 保证非空）。
 */
export function renderTitle(input: TitleInput): string {
  const icon = titleIcon(input.blocked, input.watchlisted);
  const suffix = ` ${input.telegramUserId} · #${input.customerId}`;
  const nameBudget = Math.max(0, TITLE_MAX_LENGTH - icon.length - 1 - suffix.length);
  const name = input.displayName.length > nameBudget ? input.displayName.slice(0, nameBudget) : input.displayName;
  return `${icon} ${name}${suffix}`;
}
