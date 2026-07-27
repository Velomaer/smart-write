import { createHash } from "node:crypto";
import { closeSync, fdatasyncSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";

/** sha256 fingerprint of a file's content — the identity used for CAS optimistic locking. */
export function fingerprint(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Session-scoped map: absolute path -> fingerprint at last read. Cleared on process restart (intentional). */
export const readRegistry = new Map<string, string>();

/** Mechanism 6: temp file + fsync + atomic rename, so a file is never observed half-written. */
export function atomicWrite(path: string, content: string): void {
  const dir = dirname(path) || ".";
  const tmpDir = mkdtempSync(join(dir, ".smartwrite-"));
  const tmp = join(tmpDir, "pending");
  try {
    const fd = openSync(tmp, "w");
    try {
      writeSync(fd, content, null, "utf8");
      fdatasyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Mechanism 5: structural duplicate scan. Approximate (regex, not AST), but reliably catches
 * the typical long-context residue: an entire method / type / import written twice.
 */
export function duplicateScan(content: string): string[] {
  const warnings: string[] = [];
  const patterns: Array<{ re: RegExp; label: string }> = [
    // method signature: modifiers + return type + name(...) {
    { re: /\b(?:public|private|protected)?\s*(?:static\s+)?[\w<>\[\],\s]+?\s+(\w+)\s*\([^)]*\)\s*\{/g, label: "方法" },
    { re: /\b(?:class|interface|enum)\s+(\w+)/g, label: "类型" },
    { re: /^\s*import\s+([\w.]+);/gm, label: "import" },
  ];
  for (const { re, label } of patterns) {
    const counts = new Map<string, number>();
    for (const m of content.matchAll(re)) {
      const name = m[1];
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    for (const [name, n] of counts) {
      if (n >= 2) warnings.push(`${label} \`${name}\` 出现 ${n} 次`);
    }
  }
  return warnings;
}

export function countOccurrences(haystack: string, needle: string): number {
  if (needle === "") return 0;
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

export function lineCount(text: string): number {
  if (text === "") return 0;
  let n = 1;
  for (const ch of text) if (ch === "\n") n++;
  return n;
}

/** Discriminated result of a smart_edit attempt — the structured signal the reflector consumes. */
export type EditResult =
  | { kind: "ok"; message: string }
  | { kind: "noop"; message: string }
  | { kind: "preview"; message: string }
  | { kind: "warn"; errorType: "Duplicate"; message: string }
  | { kind: "err"; errorType: "Unread" | "Stale" | "NotFound" | "Ambiguous" | "VerifyFail"; message: string };

/** Render a unified-style before/after block for one anchor replacement (preview only). */
function buildDiff(oldStr: string, newStr: string): string {
  const minus = oldStr.split("\n").map((l) => `- ${l}`).join("\n");
  const plus = newStr === "" ? "  (删除，无新增内容)" : newStr.split("\n").map((l) => `+ ${l}`).join("\n");
  return `${minus}\n${plus}`;
}

/**
 * Pure decision + effect for one guarded edit. Sequence: read-registry gate (M1) ->
 * CAS fingerprint (M2) -> idempotency (M4) -> unique anchor (M3) -> atomic write (M6) ->
 * post-read verify + dup scan (M5). Returns a typed result; performs the write only when safe.
 *
 * When `preview` is true, all gates (M1-M4) still run, but instead of writing it returns a
 * diff of the pending change (and pre-warns if the write would create a duplicate). Nothing
 * touches disk and the read registry is left untouched, so a following real edit re-validates CAS.
 */
export function performSmartEdit(path: string, oldStr: string, newStr: string, preview = false): EditResult {
  // Mechanism 1: must have been read this session.
  if (!readRegistry.has(path)) {
    return { kind: "err", errorType: "Unread", message: `ERR[Unread] 该文件本轮未读取，请先 read_file 再改：${path}` };
  }

  const disk = readFileSync(path, "utf8");

  // Mechanism 2: CAS — disk fingerprint must match what we last read.
  if (fingerprint(disk) !== readRegistry.get(path)) {
    return {
      kind: "err",
      errorType: "Stale",
      message: `ERR[Stale] ${path} 磁盘已被改动（现 ${lineCount(disk)} 行），你的上下文过期。请重新 read_file 后再改，切勿覆盖。`,
    };
  }

  // Mechanism 4: idempotency — already in the target state, do not append a second time.
  if (!disk.includes(oldStr) && newStr !== "" && disk.includes(newStr)) {
    return { kind: "noop", message: "OK[NoOp] 目标状态已存在，判定上次已生效，跳过。" };
  }

  // Mechanism 3: unique anchor — the core defense against duplicate residue.
  const n = countOccurrences(disk, oldStr);
  if (n === 0) {
    return { kind: "err", errorType: "NotFound", message: "ERR[NotFound] 锚点不存在，你的 old 是旧版本/幻觉。请重新 read_file，不要硬写。" };
  }
  if (n > 1) {
    return { kind: "err", errorType: "Ambiguous", message: `ERR[Ambiguous] 锚点出现 ${n} 次，盲替会产生重复。请给 old 带上下文使其唯一。` };
  }

  const updated = disk.replace(oldStr, newStr);

  // Preview (dry-run): all gates passed, but do not write. Return the diff and pre-warn on duplicates.
  if (preview) {
    const diff = buildDiff(oldStr, newStr);
    const dups = duplicateScan(updated);
    const warn = dups.length > 0 ? `\n⚠ 应用后可能残留：${dups.join("; ")}` : "";
    const delta = lineCount(updated) - lineCount(disk);
    return {
      kind: "preview",
      message: `PREVIEW ${path}（行数变化 ${delta >= 0 ? "+" : ""}${delta}，未写入）\n${diff}${warn}\n\n确认无误后，用相同 old/new 再调一次（preview=false）实际写入。`,
    };
  }

  atomicWrite(path, updated);

  // Mechanism 5: post-write read-back self-check.
  const after = readFileSync(path, "utf8");
  if (newStr !== "" && !after.includes(newStr)) {
    return { kind: "err", errorType: "VerifyFail", message: "ERR[VerifyFail] 写后回读未找到 new，疑似写入失败。" };
  }
  const dups = duplicateScan(after);
  if (dups.length > 0) {
    // Fingerprint still advances: the write did happen; this is a warning for human confirmation.
    readRegistry.set(path, fingerprint(after));
    return { kind: "warn", errorType: "Duplicate", message: `WARN[Duplicate] 写入成功但检测到残留：${dups.join("; ")}。请人工确认是否回滚。` };
  }

  readRegistry.set(path, fingerprint(after));
  const delta = lineCount(after) - lineCount(disk);
  return { kind: "ok", message: `OK 编辑成功，行数变化 ${delta >= 0 ? "+" : ""}${delta}。` };
}