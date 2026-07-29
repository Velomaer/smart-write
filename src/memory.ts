import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { atomicWrite } from "./core.js";

const HERE = dirname(fileURLToPath(import.meta.url));
// dist/memory.js -> ../memory ; src/memory.ts (tsx) -> ../memory . Both resolve to smart-write/memory.
const MEM_DIR = join(HERE, "..", "memory");
const RULES_DIR = join(MEM_DIR, "rules");
const INDEX = join(MEM_DIR, "INDEX.md");

function slugify(input: string): string {
  // Keep Unicode letters/numbers (\p{L}\p{N}) — not just ASCII \w — so that filenames
  // distinguished only by CJK characters (SAI检查手册 vs SAI订单手册) don't collapse to the
  // same slug and overwrite each other's rule file. Only true separators become "-".
  const slug = input
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  // Guard against an all-separator input producing an empty (hidden ".md") filename.
  return slug || "rule";
}

/**
 * One-line summary of a lesson for an index/tail entry: collapse all whitespace to single spaces
 * (so a multi-line lesson can't fold and break the markdown list) and cap the length.
 */
function summarize(lesson: string, max = 80): string {
  const oneLine = lesson.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? oneLine.slice(0, max) + "…" : oneLine;
}

/**
 * Persist one smart_edit failure as a long-term rule (frontmatter file + index line).
 * Dedup: an existing rule of the same file+type is strengthened (hits++), never duplicated —
 * otherwise the memory store would grow its own duplicate residue.
 */
export function rememberFailure(file: string, errorType: string, lesson: string): string {
  mkdirSync(RULES_DIR, { recursive: true });

  const slug = slugify(`${basename(file)}-${errorType}`);
  const rulePath = join(RULES_DIR, `${slug}.md`);

  let hits = 1;
  if (existsSync(rulePath)) {
    const prev = readFileSync(rulePath, "utf8");
    const m = prev.match(/hits:\s*(\d+)/);
    hits = m ? parseInt(m[1], 10) + 1 : 2;
  }

  const body =
    `---\n` +
    `name: ${slug}\n` +
    `type: feedback\n` +
    `trigger: 编辑 ${file} 之前\n` +
    `hits: ${hits}\n` +
    `---\n\n` +
    `${lesson}\n\n` +
    `（根因类型：${errorType}；已触发 ${hits} 次）\n`;
  atomicWrite(rulePath, body);

  const line = `- [${slug}](rules/${slug}.md) — ${summarize(lesson)}\n`;
  let idx = existsSync(INDEX) ? readFileSync(INDEX, "utf8") : "# 编辑规则记忆索引\n\n开局注入：新会话开始时先读本文件，遵守其中已沉淀的规则。\n\n";
  if (!idx.includes(`(rules/${slug}.md)`)) {
    // Guarantee a newline boundary: a hand-written INDEX may end on a comment or a line with no
    // trailing "\n", and bare `idx += line` would glue that line to the rule line (broken markdown).
    if (idx.length > 0 && !idx.endsWith("\n")) idx += "\n";
    idx += line;
    atomicWrite(INDEX, idx);
  }

  return `已沉淀规则 ${slug}（第 ${hits} 次）。`;
}

/**
 * Cap on how many rule bodies get injected at session start. The store grows unbounded
 * over a project's life, but injection cost must not: only the highest-hits (most-repeated)
 * rules are worth injecting in full. The long tail is injected as one-line summaries only
 * (path + lesson gist), readable in full on demand. Tune here if injection feels heavy/thin.
 */
const MAX_INJECTED_RULES = 30;

/** Read the `hits:` count from a rule's frontmatter; missing/malformed (e.g. hand-written) -> 1. */
function parseHits(body: string): number {
  const m = body.match(/hits:\s*(\d+)/);
  return m ? parseInt(m[1], 10) : 1;
}

/**
 * Strip a rule file down to the lesson itself — the only part that guides future edits.
 * Drops the YAML frontmatter (name/type/trigger/hits: sorting/bookkeeping metadata, not
 * behavior) and the auto-appended provenance note "（根因类型：…；已触发 N 次）". Both are
 * dead weight in the injected context. Idempotent on hand-written rules that lack either.
 */
function extractLesson(body: string): string {
  return body
    .replace(/^---\n[\s\S]*?\n---\n/, "")
    .replace(/\n*（根因类型：[\s\S]*?）\s*$/, "")
    .trim();
}

/**
 * The human-authored INDEX preamble ONLY — its heading and framing lines, with the
 * auto-appended `- [slug](rules/…)` summary lines and the `<!-- example -->` comments removed.
 * Those summary lines are exactly what we must NOT re-inject: a Top-N rule already contributes
 * its full body below, so its index line would be a duplicate; low-freq summaries are rebuilt
 * fresh from the rules array (source of truth) rather than trusted from INDEX.
 */
function indexHeader(): string {
  if (!existsSync(INDEX)) return "";
  return readFileSync(INDEX, "utf8")
    .replace(/<!--[\s\S]*?-->/g, "")
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("- ["))
    .join("\n")
    .trim();
}

/**
 * Aggregate persisted edit rules into one injectable markdown block:
 *  - a short header (the INDEX preamble, minus its redundant summary lines);
 *  - the full lesson (frontmatter/provenance stripped) of the top-MAX_INJECTED_RULES by hits;
 *  - the remaining low-freq rules as one-line summaries only (path + gist), readable on demand.
 * A Top-N rule therefore appears exactly once (body, no duplicate index line), and injection
 * cost stays bounded as the store grows. Returns "" when nothing has been remembered yet.
 */
export function loadRules(): string {
  if (!existsSync(RULES_DIR)) return "";

  const rules = readdirSync(RULES_DIR)
    .filter((f) => f.endsWith(".md"))
    .map((f) => {
      const body = readFileSync(join(RULES_DIR, f), "utf8");
      return { f, lesson: extractLesson(body), hits: parseHits(body) };
    })
    // Highest hits first; ties broken by filename so output is deterministic across runs.
    .sort((a, b) => b.hits - a.hits || a.f.localeCompare(b.f));

  if (rules.length === 0) return "";

  const header = indexHeader();
  const parts: string[] = header ? [header] : [];

  // High-freq: inject the lesson body only (no frontmatter, no provenance tail, no index line).
  for (const r of rules.slice(0, MAX_INJECTED_RULES)) parts.push(r.lesson);

  // Low-freq: one-line summary + path only, so injection stays bounded. Announced, never silent.
  const tail = rules.slice(MAX_INJECTED_RULES);
  if (tail.length > 0) {
    const lines = tail
      .map((r) => `- [${r.f.replace(/\.md$/, "")}](rules/${r.f}) — ${summarize(r.lesson)}`)
      .join("\n");
    parts.push(`另有 ${tail.length} 条低频规则未注入正文（需要时按 rules/ 路径读取）：\n${lines}`);
  }

  return parts.join("\n\n---\n\n");
}
