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

  const shortLesson = lesson.length > 80 ? lesson.slice(0, 80) : lesson;
  const line = `- [${slug}](rules/${slug}.md) — ${shortLesson}\n`;
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
 * Aggregate all persisted edit rules into one injectable markdown block:
 * the INDEX overview plus the full body of every rule under rules/.
 * Returns "" when nothing has been remembered yet, so callers can skip injection.
 */
export function loadRules(): string {
  if (!existsSync(INDEX)) return "";
  const parts: string[] = [readFileSync(INDEX, "utf8").trim()];

  if (existsSync(RULES_DIR)) {
    for (const f of readdirSync(RULES_DIR).sort()) {
      if (f.endsWith(".md")) parts.push(readFileSync(join(RULES_DIR, f), "utf8").trim());
    }
  }

  // Only the default template exists (no real rules) -> nothing worth injecting.
  return parts.length > 1 ? parts.join("\n\n---\n\n") : "";
}