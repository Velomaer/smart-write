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
 * Cap on how many rule bodies get injected at session start. The store grows unbounded
 * over a project's life, but injection cost must not: only the highest-hits (most-repeated)
 * rules are worth the tokens. The long tail stays listed in INDEX and readable on demand.
 * Tune here if injection feels too heavy or too thin.
 */
const MAX_INJECTED_RULES = 30;

/** Read the `hits:` count from a rule's frontmatter; missing/malformed (e.g. hand-written) -> 1. */
function parseHits(body: string): number {
  const m = body.match(/hits:\s*(\d+)/);
  return m ? parseInt(m[1], 10) : 1;
}

/**
 * Aggregate persisted edit rules into one injectable markdown block: the INDEX overview plus
 * the full body of the top-MAX_INJECTED_RULES rules by hit count. Bodies beyond the cap are
 * omitted (but still summarized in INDEX and readable via their rules/ path), so injection cost
 * stays bounded as the store grows. The omission is announced, never silent.
 * Returns "" when nothing has been remembered yet, so callers can skip injection.
 */
export function loadRules(): string {
  if (!existsSync(INDEX)) return "";
  const parts: string[] = [readFileSync(INDEX, "utf8").trim()];

  if (existsSync(RULES_DIR)) {
    const rules = readdirSync(RULES_DIR)
      .filter((f) => f.endsWith(".md"))
      .map((f) => {
        const body = readFileSync(join(RULES_DIR, f), "utf8").trim();
        return { f, body, hits: parseHits(body) };
      })
      // Highest hits first; ties broken by filename so output is deterministic across runs.
      .sort((a, b) => b.hits - a.hits || a.f.localeCompare(b.f));

    for (const r of rules.slice(0, MAX_INJECTED_RULES)) parts.push(r.body);

    const omitted = rules.length - Math.min(rules.length, MAX_INJECTED_RULES);
    if (omitted > 0) {
      parts.push(`（另有 ${omitted} 条低频规则未全量注入，摘要见上方 INDEX，需要时按 rules/ 路径读取。）`);
    }
  }

  // Only the default template exists (no real rules) -> nothing worth injecting.
  return parts.length > 1 ? parts.join("\n\n---\n\n") : "";
}