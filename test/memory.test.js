import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const memoryDir = mkdtempSync(join(tmpdir(), "smart-write-memory-test-"));
process.env.SMART_WRITE_MEMORY_DIR = memoryDir;

const { loadRules, loadRulesForFile, rememberFailure } = await import("../dist/memory.js");

after(() => rmSync(memoryDir, { recursive: true, force: true }));

test("global rules merge across files by error type and cause code", () => {
  const root = join(memoryDir, "project");
  const first = join(root, "src", "A.java");
  const second = join(root, "src", "B.java");

  rememberFailure(first, "Duplicate", "锚点必须唯一。", {
    scope: "global", causeCode: "NON_UNIQUE_ANCHOR", projectRoot: root, projectId: "demo",
  });
  rememberFailure(second, "Duplicate", "锚点必须唯一。", {
    scope: "global", causeCode: "NON_UNIQUE_ANCHOR", projectRoot: root, projectId: "demo",
  });

  const globalDir = join(memoryDir, "rules", "global");
  const files = readdirSync(globalDir).filter((file) => file.endsWith(".json"));
  assert.equal(files.length, 1);
  const record = JSON.parse(readFileSync(join(globalDir, files[0]), "utf8"));
  assert.equal(record.hits, 2);
  assert.equal(record.lessons[0].hits, 2);
  assert.equal(record.examples.length, 2);
});

test("same error type with different causes stays separate", () => {
  const root = join(memoryDir, "project");
  rememberFailure(join(root, "C.java"), "Duplicate", "避免重复提交。", {
    scope: "global", causeCode: "REPEATED_SUBMIT", projectRoot: root, projectId: "demo",
  });
  const files = readdirSync(join(memoryDir, "rules", "global"));
  assert.equal(files.length, 2);
});

test("file rules distinguish same basename by path and recall exact target", () => {
  const root = join(memoryDir, "project");
  const first = join(root, "module-a", "Config.java");
  const second = join(root, "module-b", "Config.java");

  rememberFailure(first, "Stale", "模块 A 会被生成器修改。", {
    scope: "file", causeCode: "EXTERNAL_MODIFICATION", projectRoot: root, projectId: "demo",
  });
  rememberFailure(second, "Stale", "模块 B 会被格式化器修改。", {
    scope: "file", causeCode: "EXTERNAL_MODIFICATION", projectRoot: root, projectId: "demo",
  });

  const scopedDir = join(memoryDir, "rules", "scoped", "demo");
  assert.equal(readdirSync(scopedDir).filter((file) => file.endsWith(".json")).length, 2);
  const recalled = loadRulesForFile(first, { projectRoot: root, projectId: "demo" });
  assert.match(recalled, /模块 A 会被生成器修改/);
  assert.doesNotMatch(recalled, /模块 B 会被格式化器修改/);
  assert.match(recalled, /锚点必须唯一/);
});

test("three-argument call defaults to a file-scoped GENERIC rule", () => {
  const message = rememberFailure(join(memoryDir, "Legacy.java"), "NotFound", "重新读取后生成锚点。");
  assert.match(message, /已沉淀文件规则/);
  const injected = loadRules();
  assert.match(injected, /# 全局规则/);
  assert.match(injected, /# 文件特例摘要/);
  assert.match(injected, /recall_edit_rules/);
});

test("implicit project ids distinguish repositories with the same basename", () => {
  const firstRoot = join(memoryDir, "company-a", "backend");
  const secondRoot = join(memoryDir, "company-b", "backend");
  rememberFailure(join(firstRoot, "src", "Config.java"), "Stale", "公司 A 项目规则。", {
    scope: "file", causeCode: "EXTERNAL_MODIFICATION", projectRoot: firstRoot,
  });
  rememberFailure(join(secondRoot, "src", "Config.java"), "Stale", "公司 B 项目规则。", {
    scope: "file", causeCode: "EXTERNAL_MODIFICATION", projectRoot: secondRoot,
  });

  const projects = readdirSync(join(memoryDir, "rules", "scoped"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("backend-"));
  assert.equal(projects.length, 2);
});

test("rules_old is archive-only and never injected or recalled", () => {
  const archiveDir = join(memoryDir, "rules_old");
  mkdirSync(archiveDir, { recursive: true });
  writeFileSync(join(archiveDir, "archived.md"), "ARCHIVED_RULE_MUST_NOT_LOAD", "utf8");

  assert.doesNotMatch(loadRules(), /ARCHIVED_RULE_MUST_NOT_LOAD/);
  assert.doesNotMatch(loadRulesForFile(join(memoryDir, "Legacy.java")), /ARCHIVED_RULE_MUST_NOT_LOAD/);
});
