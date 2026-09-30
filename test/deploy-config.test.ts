// scripts/lib/config.mjs 纯函数单元测试（T05/T06 提前交付）
// 只测 JSONC 剥注释 / 解析 / database_id 原地替换，不触碰 D1 与 SELF；
// 被 import 的 config.mjs 是纯模块（无 process / node:* 引用），可安全运行在
// workerd 沙箱（vitest cloudflare pool）内——workerd 里无法读文件，故 fixture
// 以内嵌字符串形式给出，形状与仓库 wrangler.jsonc 同构。
import { describe, expect, it } from "vitest";
import {
  PLACEHOLDER_DATABASE_ID,
  parseWranglerConfig,
  replaceJsoncString,
  stripJsoncComments,
  withDatabaseId,
} from "../scripts/lib/config.mjs";

// 与仓库 wrangler.jsonc 同构的代表性 fixture：注释（行 + 跨行块）、URL 形
// $schema（字符串内含 //）、占位 database_id
const WRANGLER_JSONC_FIXTURE = [
  "{",
  "  // 编辑器 schema 校验（npm install 后生效）",
  '  "$schema": "https://unpkg.com/wrangler/config-schema.json",',
  "  // Worker 名称，部署后为 <name>.<account>.workers.dev",
  '  "name": "hodor",',
  '  "main": "src/index.ts",',
  "  /* keep_vars：跨部署保留面板变量，",
  "     块注释可跨行 */",
  '  "keep_vars": true,',
  '  "d1_databases": [',
  "    {",
  '      "binding": "HODOR_DB",',
  '      "database_name": "hodor",',
  "      // 占位符常驻仓库：真实 id 只写入构建工作区临时配置",
  `      "database_id": "${PLACEHOLDER_DATABASE_ID}",`,
  '      "migrations_dir": "migrations"',
  "    }",
  "  ]",
  "}",
].join("\n");

const NEW_UUID = "11111111-2222-3333-4444-555555555555";

describe("stripJsoncComments", () => {
  it("移除行注释与块注释后得到可解析的 JSON，字段值不受影响", () => {
    const stripped = stripJsoncComments(WRANGLER_JSONC_FIXTURE);
    expect(JSON.parse(stripped)).toEqual({
      $schema: "https://unpkg.com/wrangler/config-schema.json",
      name: "hodor",
      main: "src/index.ts",
      keep_vars: true,
      d1_databases: [
        {
          binding: "HODOR_DB",
          database_name: "hodor",
          database_id: PLACEHOLDER_DATABASE_ID,
          migrations_dir: "migrations",
        },
      ],
    });
  });

  it("保留字符串字面量内部的 // 与块注释定界序列，只删真注释", () => {
    const text = '{"url": "https://example.com/a//b/*c*/", // 真注释\n"n": 1}';
    expect(JSON.parse(stripJsoncComments(text))).toEqual({
      url: "https://example.com/a//b/*c*/",
      n: 1,
    });
  });

  it("正确处理字符串内的转义引号（不把转义引号当作字符串结束）", () => {
    const text = '{"a": "x \\" // 仍在字符串内"}';
    expect(stripJsoncComments(text)).toBe(text);
  });

  it("行注释剥离后保留换行（行号不漂移）", () => {
    expect(stripJsoncComments('{\n  // 注释\n  "a": 1\n}')).toBe(
      '{\n  \n  "a": 1\n}',
    );
  });
});

describe("parseWranglerConfig", () => {
  it("解析带注释的 wrangler 配置（fixture 与仓库形状一致）", () => {
    const parsed = parseWranglerConfig(WRANGLER_JSONC_FIXTURE);
    expect(parsed.name).toBe("hodor");
    expect(parsed.keep_vars).toBe(true);
    expect(parsed.main).toBe("src/index.ts");
    expect(parsed.d1_databases[0].database_id).toBe(PLACEHOLDER_DATABASE_ID);
    expect(parsed.d1_databases[0].migrations_dir).toBe("migrations");
  });

  it("解析失败时抛出描述性错误", () => {
    expect(() => parseWranglerConfig('{"name": }')).toThrow(/解析失败/);
  });
});

describe("withDatabaseId", () => {
  it("替换占位符为新 uuid，注释与其余字段逐字保留", () => {
    const replaced = withDatabaseId(WRANGLER_JSONC_FIXTURE, NEW_UUID);
    const parsed = parseWranglerConfig(replaced);
    expect(parsed.d1_databases[0].database_id).toBe(NEW_UUID);
    expect(replaced).not.toContain(PLACEHOLDER_DATABASE_ID);
    // 头部注释、跨行块注释、字段旁注释原样存活
    expect(replaced).toContain("// 编辑器 schema 校验（npm install 后生效）");
    expect(replaced).toContain("块注释可跨行");
    expect(replaced).toContain("// 占位符常驻仓库：真实 id 只写入构建工作区临时配置");
    // 其余字段不受影响
    expect(parsed.d1_databases[0].database_name).toBe("hodor");
    expect(parsed.main).toBe("src/index.ts");
  });

  it("非占位符的既有 id 同样被替换", () => {
    const existingId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const fixture = WRANGLER_JSONC_FIXTURE.replace(PLACEHOLDER_DATABASE_ID, existingId);
    const replaced = withDatabaseId(fixture, NEW_UUID);
    expect(parseWranglerConfig(replaced).d1_databases[0].database_id).toBe(NEW_UUID);
    expect(replaced).not.toContain(existingId);
  });

  it("配置缺少 database_id 键时抛错", () => {
    const noId = WRANGLER_JSONC_FIXTURE.replace(
      `      "database_id": "${PLACEHOLDER_DATABASE_ID}",\n`,
      "",
    );
    expect(() => withDatabaseId(noId, NEW_UUID)).toThrow(/database_id/);
  });

  it("database_id 值不是字符串字面量时抛错", () => {
    const badValue = WRANGLER_JSONC_FIXTURE.replace(
      `"${PLACEHOLDER_DATABASE_ID}"`,
      "12345",
    );
    expect(() => withDatabaseId(badValue, NEW_UUID)).toThrow(/字符串字面量/);
  });
});

describe("replaceJsoncString（deploy.mjs 借此把 resolved 配置内的相对路径改写为绝对路径）", () => {
  it("替换顶层字符串值（main → 绝对路径），注释保留", () => {
    const replaced = replaceJsoncString(
      WRANGLER_JSONC_FIXTURE,
      "main",
      "/repo/src/index.ts",
    );
    expect(parseWranglerConfig(replaced).main).toBe("/repo/src/index.ts");
    expect(replaced).toContain("// Worker 名称");
  });

  it("替换嵌套数组元素内的字符串值（d1_databases[0].migrations_dir），其余键不受波及", () => {
    const replaced = replaceJsoncString(
      WRANGLER_JSONC_FIXTURE,
      "d1_databases[0].migrations_dir",
      "/repo/migrations",
    );
    const parsed = parseWranglerConfig(replaced);
    expect(parsed.d1_databases[0].migrations_dir).toBe("/repo/migrations");
    expect(parsed.d1_databases[0].database_id).toBe(PLACEHOLDER_DATABASE_ID);
  });
});
