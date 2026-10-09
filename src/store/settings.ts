/**
 * settings 表 store：验证开关、验证模式与验证配置版本（阶段 5 T31/T32 +
 * Turnstile 任务 10-09-turnstile-verification）。
 *
 * settings 是全局单份的运行时开关（多 bot 维度拆分属阶段 8，本阶段契约
 * 即全局；docs/guide/database.md）。存库而非环境变量的产品语义是「命令
 * 切换即时生效、重部署不丢」——因此**不做缓存**：每条入站消息直读（单条
 * IN 点查），缓存会引入失效窗口破坏即时性。
 *
 * 契约：读侧行缺失 / 值非法一律回默认（verifyEnabled: true / verifyMode:
 * "math" / verifyGeneration: 0）——存量部署零感知；写侧走 applyVerificationConfigChange
 * 的事务化 batch：**真变化**（模式或开关任一实际改变）才在一个 db.batch 内
 * 推进 verify_generation + 清空全部 pending（含 Turnstile 四列）+ UPSERT 设置；
 * 同值重复设置（幂等）不推进版本、不清 pending，且该判定以**事务内实际状态**
 * 为准（SQL 条件子查询），不依赖事务前的 JS 快照——并发命令不会误清新请求。
 * is_verified / verified_at 在任何路径都不被触碰。
 */

/** 验证模式三态（Turnstile 任务起新增 "turnstile"） */
export type VerifyMode = "math" | "button" | "turnstile";

/** 验证配置（/verifymode、验证门、出题栅栏与动态帮助的统一数据源） */
export interface VerificationSettings {
  /** 验证门总开关（settings.verify_enabled = "1"/"0"） */
  verifyEnabled: boolean;
  /** 验证模式（settings.verify_mode = "math"/"button"/"turnstile"） */
  verifyMode: VerifyMode;
  /**
   * 实例验证配置版本（settings.verify_generation）：每次模式 / 开关真变化 +1
   * （SQL 内递增）；行缺失按 0 解释。出题时作为挑战的配置快照写入
   * users.verify_request_generation，网页最终 CAS / 回调最终 CAS 据此拒绝
   * 「切出去再切回来」后复活的旧请求。
   */
  verifyGeneration: number;
}

/** settings 各键的缺省语义（与读侧解析一致；数据库文档为唯一事实源） */
const MODE_DEFAULT = "math";
const ENABLED_DEFAULT = "1";
const GENERATION_DEFAULT = 0;

/**
 * 读取验证配置快照：**单条 SELECT** 同时取 enabled / mode / generation 三键
 * （不同时刻的多次查询会拼出从未存在过的组合，网页完成链要求原子快照）。
 * 逐键按「先解析、不轻信输入」判定：verify_enabled 仅 "1"/"0" 有效、
 * verify_mode 仅三模式字面量有效、verify_generation 仅非负整数有效，
 * 其余（缺失 / 脏值）各键独立回默认。
 */
export async function getVerificationSettings(db: D1Database): Promise<VerificationSettings> {
  const rows = await db
    .prepare(
      "SELECT key, value FROM settings WHERE key IN ('verify_enabled', 'verify_mode', 'verify_generation')",
    )
    .all<{ key: string; value: string }>();

  let enabledRaw: string | undefined;
  let modeRaw: string | undefined;
  let generationRaw: string | undefined;
  for (const row of rows.results) {
    if (row.key === "verify_enabled") enabledRaw = row.value;
    else if (row.key === "verify_mode") modeRaw = row.value;
    else if (row.key === "verify_generation") generationRaw = row.value;
  }

  const generation = Number(generationRaw);
  return {
    verifyEnabled: enabledRaw === "1" ? true : enabledRaw === "0" ? false : true,
    verifyMode:
      modeRaw === "math" || modeRaw === "button" || modeRaw === "turnstile"
        ? modeRaw
        : MODE_DEFAULT,
    verifyGeneration:
      generationRaw !== undefined &&
      generationRaw.trim() !== "" &&
      Number.isSafeInteger(generation) &&
      generation >= 0
        ? generation
        : GENERATION_DEFAULT,
  };
}

/** 写验证开关（/verifyon /verifyoff 的唯一写入口）：事务化，真变化才清 pending */
export async function setVerificationEnabled(
  db: D1Database,
  enabled: boolean,
): Promise<void> {
  await applyVerificationConfigChange(db, { enabled });
}

/** 写验证模式（/verifymode 显式设置的唯一写入口）：事务化，真变化才清 pending */
export async function setVerificationMode(db: D1Database, mode: VerifyMode): Promise<void> {
  await applyVerificationConfigChange(db, { mode });
}

/** 配置变化补丁：本事务要落库的键（至少一项；命令层一次只改一项） */
export interface VerificationConfigPatch {
  mode?: VerifyMode;
  enabled?: boolean;
}

/**
 * 事务化配置变化（唯一写入口）：一个 db.batch（D1 事务）内按固定顺序执行——
 *
 * ① 清空全部 pending（含 Turnstile 四列）：仅当「事务内的当前实际配置」与
 *    补丁不同（真变化）才产生行变更——条件是 SQL 子查询而非 JS 快照，并发
 *    命令 / 重推不会误清新挑战；无 pending 行时零变更（幂等）。
 * ② 推进 verify_generation：同一真变化条件下 INSERT 缺行 / 原地 +1（版本
 *    递增在 SQL 中完成，不先 JS 读 +1）；条件不满足时 SELECT 无行、零写入。
 * ③④ UPSERT 新的 mode / enabled（无条件，重复同值无害）。
 *
 * ①②必须先于③④：条件子查询读到的是**变更前**的实际配置；③④写完新值后
 * 条件恒假，若乱序会让真变化漏清 pending。is_verified / verified_at 任何
 * 语句都不触碰（不强制已验证用户重验）。
 */
export async function applyVerificationConfigChange(
  db: D1Database,
  patch: VerificationConfigPatch,
): Promise<void> {
  if (patch.mode === undefined && patch.enabled === undefined) return;

  /* ---- 真变化条件（引用变更前的实际配置；mode/enabled 缺行回各自默认） ---- */
  const conditions: string[] = [];
  const conditionParams: string[] = [];
  if (patch.mode !== undefined) {
    conditions.push(`COALESCE((SELECT value FROM settings WHERE key = 'verify_mode'), ?) <> ?`);
    conditionParams.push(MODE_DEFAULT, patch.mode);
  }
  if (patch.enabled !== undefined) {
    conditions.push(
      `COALESCE((SELECT value FROM settings WHERE key = 'verify_enabled'), ?) <> ?`,
    );
    conditionParams.push(ENABLED_DEFAULT, patch.enabled ? "1" : "0");
  }
  const changeNeeded = `(${conditions.join(" OR ")})`;

  const clearPending = db.prepare(
    `UPDATE users SET
       verify_answer = NULL, verify_msg_id = NULL,
       verify_request_hash = NULL, verify_request_expires_at = NULL,
       verify_request_generation = NULL, verify_submit_not_before = NULL
     WHERE (verify_msg_id IS NOT NULL OR verify_request_hash IS NOT NULL)
       AND ${changeNeeded}`,
  );
  const bumpGeneration = db.prepare(
    `INSERT INTO settings (key, value)
       SELECT 'verify_generation', '1' WHERE ${changeNeeded}
     ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(settings.value AS INTEGER) + 1 AS TEXT)`,
  );
  const statements: D1PreparedStatement[] = [
    clearPending.bind(...conditionParams),
    bumpGeneration.bind(...conditionParams),
  ];
  if (patch.mode !== undefined) {
    statements.push(upsertSettingStatement(db, "verify_mode", patch.mode));
  }
  if (patch.enabled !== undefined) {
    statements.push(upsertSettingStatement(db, "verify_enabled", patch.enabled ? "1" : "0"));
  }
  await db.batch(statements);
}

/** settings 单键 UPSERT：无行插入、有行覆写（幂等，重推安全） */
function upsertSettingStatement(db: D1Database, key: string, value: string): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .bind(key, value);
}
