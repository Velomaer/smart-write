import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { atomicWrite, fingerprint } from "./core.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const MEM_DIR = process.env.SMART_WRITE_MEMORY_DIR
  ? resolve(process.env.SMART_WRITE_MEMORY_DIR)
  : join(HERE, "..", "memory");
const RULES_DIR = join(MEM_DIR, "rules");
const GLOBAL_RULES_DIR = join(RULES_DIR, "global");
const SCOPED_RULES_DIR = join(RULES_DIR, "scoped");
const INDEX = join(MEM_DIR, "INDEX.md");

const MAX_GLOBAL_RULES = 20;
const MAX_SCOPED_SUMMARIES = 10;
const MAX_LESSON_VARIANTS = 5;
const MAX_EXAMPLES = 10;

export type MemoryScope = "global" | "file";

export interface RememberFailureOptions {
  scope?: MemoryScope;
  causeCode?: string;
  projectRoot?: string;
  projectId?: string;
}

export interface LessonVariant {
  text: string;
  hash: string;
  hits: number;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface RuleExample {
  projectId: string;
  relativePath: string;
  hits: number;
  lastSeenAt: string;
}

export interface RuleRecord {
  schemaVersion: 2;
  id: string;
  scope: MemoryScope;
  errorType: string;
  causeCode: string;
  hits: number;
  createdAt: string;
  updatedAt: string;
  lessons: LessonVariant[];
  examples: RuleExample[];
  target?: { projectId: string; relativePath: string; pathHash: string };
}

interface RuleContext {
  scope: MemoryScope;
  errorType: string;
  causeCode: string;
  projectId: string;
  relativePath: string;
  pathHash: string;
  id: string;
  rulePath: string;
}

function slugify(input: string): string {
  const slug = input
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return slug || "rule";
}

function normalizePath(input: string): string {
  const normalized = input.replace(/\\/g, "/").replace(/^\.\/+/, "");
  // Windows paths are case-insensitive; preserve case on case-sensitive platforms.
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function normalizeLesson(input: string): string {
  return input.replace(/\s+/g, " ").replace(/[，。；：、,.\s;:]/g, "").trim().toLowerCase();
}

function summarize(lesson: string, max = 80): string {
  const oneLine = lesson.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? oneLine.slice(0, max) + "…" : oneLine;
}

function isInside(root: string, file: string): boolean {
  const rel = relative(root, file);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function resolveContext(file: string, errorType: string, options: RememberFailureOptions): RuleContext {
  const absFile = resolve(file);
  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  const rootName = basename(projectRoot) || "local";
  // Two repositories can share a basename. Hash the root in the implicit id; callers that need a
  // portable cross-machine identity should pass an explicit stable projectId.
  const defaultProjectId = `${slugify(rootName)}-${fingerprint(normalizePath(projectRoot)).slice(0, 8)}`;
  const projectId = slugify(options.projectId?.trim() || defaultProjectId);
  const insideProject = isInside(projectRoot, absFile);
  const relativePath = normalizePath(insideProject ? relative(projectRoot, absFile) : basename(absFile));
  // Keep an outside-project path private in the record, but hash its full identity to avoid collisions.
  const identityPath = normalizePath(insideProject ? relativePath : absFile);
  const pathHash = fingerprint(`${projectId}:${identityPath}`).slice(0, 8);
  const scope = options.scope ?? "file";
  const causeCode = (options.causeCode?.trim() || "GENERIC").toUpperCase();
  const globalId = slugify(`${errorType}-${causeCode}`);
  const fileId = slugify(`${projectId}-${basename(relativePath)}-${pathHash}-${errorType}-${causeCode}`);
  const id = scope === "global" ? globalId : fileId;
  const rulePath = scope === "global"
    ? join(GLOBAL_RULES_DIR, `${id}.json`)
    : join(SCOPED_RULES_DIR, projectId, `${id}.json`);
  return { scope, errorType, causeCode, projectId, relativePath, pathHash, id, rulePath };
}

function readRecord(path: string): RuleRecord {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (
    typeof parsed !== "object" || parsed === null ||
    (parsed as Partial<RuleRecord>).schemaVersion !== 2 ||
    !Array.isArray((parsed as Partial<RuleRecord>).lessons)
  ) throw new Error(`无效的 v2 记忆规则：${path}`);
  return parsed as RuleRecord;
}

function listJsonRules(dir: string, recursive = false): RuleRecord[] {
  if (!existsSync(dir)) return [];
  const records: RuleRecord[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory() && recursive) records.push(...listJsonRules(path, true));
    else if (entry.isFile() && entry.name.endsWith(".json")) {
      try { records.push(readRecord(path)); } catch { /* isolate a corrupt hand-edited record */ }
    }
  }
  return records;
}

function sortRecords(records: RuleRecord[]): RuleRecord[] {
  return records.sort(
    (a, b) => b.hits - a.hits || b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id),
  );
}

function mergeLesson(record: RuleRecord, lesson: string, now: string, increment: number): void {
  const clean = lesson.trim();
  const hash = fingerprint(normalizeLesson(clean)).slice(0, 8);
  const existing = record.lessons.find((item) => item.hash === hash);
  if (existing) {
    existing.hits += increment;
    existing.lastSeenAt = now;
  } else {
    record.lessons.push({ text: clean, hash, hits: increment, firstSeenAt: now, lastSeenAt: now });
  }
  record.lessons.sort(
    (a, b) => b.hits - a.hits || b.lastSeenAt.localeCompare(a.lastSeenAt) || a.hash.localeCompare(b.hash),
  );
  record.lessons = record.lessons.slice(0, MAX_LESSON_VARIANTS);
}

function mergeExample(record: RuleRecord, context: RuleContext, now: string, increment: number): void {
  const existing = record.examples.find(
    (item) => item.projectId === context.projectId && item.relativePath === context.relativePath,
  );
  if (existing) {
    existing.hits += increment;
    existing.lastSeenAt = now;
  } else {
    record.examples.push({
      projectId: context.projectId,
      relativePath: context.relativePath,
      hits: increment,
      lastSeenAt: now,
    });
  }
  record.examples.sort(
    (a, b) => b.hits - a.hits || b.lastSeenAt.localeCompare(a.lastSeenAt) || a.relativePath.localeCompare(b.relativePath),
  );
  record.examples = record.examples.slice(0, MAX_EXAMPLES);
}

function persistObservation(context: RuleContext, lesson: string, increment = 1): RuleRecord {
  const now = new Date().toISOString();
  mkdirSync(dirname(context.rulePath), { recursive: true });
  const record: RuleRecord = existsSync(context.rulePath)
    ? readRecord(context.rulePath)
    : {
        schemaVersion: 2, id: context.id, scope: context.scope,
        errorType: context.errorType, causeCode: context.causeCode,
        hits: 0, createdAt: now, updatedAt: now, lessons: [], examples: [],
        ...(context.scope === "file" ? { target: {
          projectId: context.projectId,
          relativePath: context.relativePath,
          pathHash: context.pathHash,
        } } : {}),
      };
  record.hits += increment;
  record.updatedAt = now;
  mergeLesson(record, lesson, now, increment);
  mergeExample(record, context, now, increment);
  atomicWrite(context.rulePath, JSON.stringify(record, null, 2) + "\n");
  appendIndexLine(record, context.rulePath);
  return record;
}

function appendIndexLine(record: RuleRecord, rulePath: string): void {
  mkdirSync(MEM_DIR, { recursive: true });
  const indexPath = normalizePath(relative(MEM_DIR, rulePath));
  const line = `- [${record.id}](${indexPath}) — [${record.scope}] ${summarize(record.lessons[0]?.text ?? "")}\n`;
  let index = existsSync(INDEX)
    ? readFileSync(INDEX, "utf8")
    : "# 编辑规则记忆索引\n\n开局注入：新会话开始时先读本文件，遵守其中已沉淀的规则。\n\n";
  if (!index.includes(`(${indexPath})`)) {
    if (index.length > 0 && !index.endsWith("\n")) index += "\n";
    atomicWrite(INDEX, index + line);
  }
}

/** Old callers remain valid and default to a file-scoped GENERIC rule. */
export function rememberFailure(
  file: string,
  errorType: string,
  lesson: string,
  options: RememberFailureOptions = {},
): string {
  if (!lesson.trim()) throw new Error("lesson 不能为空");
  const context = resolveContext(file, errorType, options);
  const record = persistObservation(context, lesson);
  return `已沉淀${context.scope === "global" ? "全局" : "文件"}规则 ${record.id}（第 ${record.hits} 次）。`;
}

function indexHeader(): string {
  if (!existsSync(INDEX)) return "# Smart-Write 编辑规则";
  return readFileSync(INDEX, "utf8")
    .replace(/<!--[\s\S]*?-->/g, "")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("- ["))
    .join("\n")
    .trim() || "# Smart-Write 编辑规则";
}

function primaryLesson(record: RuleRecord): string {
  return record.lessons[0]?.text ?? "（规则正文为空）";
}

function renderRecord(record: RuleRecord): string {
  const lessons = record.lessons.slice(0, 3).map((item) => item.text);
  const body = lessons.length === 1
    ? lessons[0]
    : lessons.map((lesson, index) => `${index + 1}. ${lesson}`).join("\n");
  return `## ${record.errorType} / ${record.causeCode}\n\n${body}\n\n> scope=${record.scope}；hits=${record.hits}`;
}

/** Startup injection: full global rules and scoped summaries only. */
export function loadRules(): string {
  const globals = sortRecords(listJsonRules(GLOBAL_RULES_DIR)).slice(0, MAX_GLOBAL_RULES);
  const scoped = sortRecords(listJsonRules(SCOPED_RULES_DIR, true));
  if (globals.length === 0 && scoped.length === 0) return "";
  const parts: string[] = [indexHeader()];
  if (globals.length > 0) parts.push(`# 全局规则\n\n${globals.map(renderRecord).join("\n\n")}`);
  if (scoped.length > 0) {
    const lines = scoped.slice(0, MAX_SCOPED_SUMMARIES)
      .map((rule) => `- ${rule.id}（hits=${rule.hits}）— ${summarize(primaryLesson(rule))}`)
      .join("\n");
    const hidden = Math.max(0, scoped.length - MAX_SCOPED_SUMMARIES);
    parts.push(
      `# 文件特例摘要\n\n${lines}` +
      (hidden > 0 ? `\n\n另有 ${hidden} 条文件特例未在开局注入。` : "") +
      "\n\n编辑具体文件前请调用 `recall_edit_rules` 获取精确规则。",
    );
  }
  return parts.join("\n\n---\n\n");
}

/** Return global rules plus exact file-scoped matches for the requested target. */
export function loadRulesForFile(
  file: string,
  options: Pick<RememberFailureOptions, "projectRoot" | "projectId"> = {},
): string {
  const target = resolveContext(file, "Lookup", { ...options, scope: "file", causeCode: "LOOKUP" });
  const globals = sortRecords(listJsonRules(GLOBAL_RULES_DIR));
  const scoped = sortRecords(listJsonRules(join(SCOPED_RULES_DIR, target.projectId), true))
    .filter((rule) => rule.target?.pathHash === target.pathHash);
  if (globals.length === 0 && scoped.length === 0) {
    return "（当前文件暂无适用的沉淀规则）";
  }
  const parts: string[] = [];
  if (scoped.length > 0) parts.push(`# 当前文件特例\n\n${scoped.map(renderRecord).join("\n\n")}`);
  if (globals.length > 0) parts.push(`# 全局规则\n\n${globals.slice(0, MAX_GLOBAL_RULES).map(renderRecord).join("\n\n")}`);
  return parts.join("\n\n---\n\n");
}
