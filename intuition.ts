#!/usr/bin/env bun
// intuition — where omp agents touched a codebase, down to the line.
//
// Reads omp session JSONL files (~/.omp/agent/sessions), extracts every
// file-touching tool call with line ranges (read selectors, edit hunk
// headers, writes), plus static import edges between touched files, and
// emits a self-contained HTML report: nested directory boxes containing
// per-file minimap windows with touched line regions and dependency edges,
// plus a per-file side-by-side diff (vs git HEAD, or first-seen content in
// live mode) and full code view. In live mode, inline review comments are
// journaled to <repo>/.intuition/notes.jsonl. Comments accumulate until the
// reviewer submits the review from the dashboard; submitting continues the
// current omp session headless (omp -p -c --auto-approve) so the agent that
// made the changes addresses every open comment with its own context. While
// comments accumulate, a read-only omp agent (--tools=read,grep,glob) may
// pre-investigate into .intuition/investigation.md — nothing edits the repo
// before submit. The agent replies by appending JSONL records to the journal;
// resolving comments stays with the reviewer.
//
// Each edited file gets a plain-language verdict from three cheap signals:
// change size (added/deleted lines vs the diff base), complexity of the new
// code (nesting + branch density of added lines), and rework (edit events
// that revisit already-edited lines after editing elsewhere). Shown on the
// file window, in the hover tooltip, and folded into risk ordering.
//
// Usage: bun intuition.ts [repoPath] [-o report.html] [--live [-p port]]
// Live mode serves the report at http://localhost:<port>/intuition only.

import { readdirSync, readFileSync, existsSync, statSync, realpathSync, openSync, readSync, closeSync, mkdirSync, appendFileSync, writeFileSync } from "fs";
import { join, resolve, relative, isAbsolute, sep, dirname, basename } from "path";
import { homedir, userInfo } from "os";
import { spawn } from "child_process";

const argv = process.argv.slice(2);
let repoPathArg = ".";
let outPath = "intuition-report.html";
let liveMode = false;
let port = 4747;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "-o" || argv[i] === "--out") outPath = argv[++i];
  else if (argv[i] === "--live") liveMode = true;
  else if (argv[i] === "-p" || argv[i] === "--port") port = parseInt(argv[++i], 10);
  else repoPathArg = argv[i];
}
const repoRoot = realpathSync(resolve(repoPathArg));
const sessionsRoot = join(homedir(), ".omp", "agent", "sessions");

type Kind = "read" | "edit" | "write" | "search" | "exec";
const KINDS: Kind[] = ["read", "edit", "write", "search", "exec"];

/** [startLine, endLine]; end -1 means end-of-file. Empty ranges = whole file. */
type Range = [number, number];

interface Touch {
  ts: number;
  file: string; // repo-relative
  kind: Kind;
  tool: string;
  ranges: Range[];
}

interface SessionData {
  id: string;
  title: string;
  ts: number;
  touches: Touch[];
}

type Json = Record<string, unknown>;

function isObj(v: unknown): v is Json {
  return typeof v === "object" && v !== null;
}

/** Lockstep loose-string read used across all JSON field access. */
function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

const INTERNAL_URI = /^(local|skill|rule|agent|history|artifact|mcp|issue|pr|omp|xd|memory|ssh|https?):\/\//;
const SELECTOR_RE = /(:(raw|conflicts|[\d,+\-$]+))+$/;

/** Parse a read-style selector suffix (`:50-200`, `:5-16,960-973`, `:50+150`) into ranges. */
function parseSelectorRanges(sel: string): Range[] {
  const out: Range[] = [];
  for (const part of sel.split(":")) {
    if (!/^\d/.test(part)) continue;
    for (const item of part.split(",")) {
      const m = /^(\d+)(?:(-)(\d+|\$)?|\+(\d+))?$/.exec(item);
      if (!m) continue;
      const s = parseInt(m[1], 10);
      let e = s;
      if (m[4]) e = s + parseInt(m[4], 10) - 1;
      else if (m[2] && (!m[3] || m[3] === "$")) e = -1;
      else if (m[3]) e = parseInt(m[3], 10);
      out.push([s, e]);
    }
  }
  return out;
}

/** Split `src/foo.ts:50-200` into clean path + ranges. */
function splitSelector(raw: string): { path: string; ranges: Range[] } {
  const m = SELECTOR_RE.exec(raw);
  if (!m) return { path: raw, ranges: [] };
  return { path: raw.slice(0, m.index), ranges: parseSelectorRanges(m[0]) };
}

/** Resolve a path against the session cwd; return repo-relative path or null. */
function toRepoRel(raw: string, cwd: string): string | null {
  if (!raw || INTERNAL_URI.test(raw)) return null;
  let p = raw.trim();
  if (!p || p.includes("*")) return null;
  if (p.startsWith("~")) p = join(homedir(), p.slice(1));
  const abs = isAbsolute(p) ? p : resolve(cwd, p);
  const rel = relative(repoRoot, abs);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
  return rel.split(sep).join("/");
}

const EDIT_HEADER = /^\[([^\]#]+)#[0-9A-Fa-f]{4}\]\s*$/;
// PUT/CUT ops: `PUT N.=M:`, `PUT N*:`, `PUT <N:`, `PUT >N:`, `CUT N.=M`, `CUT N*`
const EDIT_OP = /^(PUT|CUT)\s+(?:([<>])(\d+|\$)|(\d+)(?:\.=(\d+)|(\*))?)/;
const BASH_PATH = /(?:^|[\s"'=(:])((?:\/|\.{1,2}\/|~\/)[\w./@~+-]+)/g;

/** Parse edit-tool input into per-file line ranges (line numbers at edit time). */
function parseEditInput(input: string): Map<string, Range[]> {
  const byFile = new Map<string, Range[]>();
  let current: Range[] | null = null;
  let pendingBlock: Range | null = null; // PUT N*: range, extended by body rows
  for (const line of input.split("\n")) {
    const h = EDIT_HEADER.exec(line);
    if (h) {
      current = byFile.get(h[1]) ?? [];
      byFile.set(h[1], current);
      pendingBlock = null;
      continue;
    }
    if (!current) continue;
    const op = EDIT_OP.exec(line);
    if (op) {
      pendingBlock = null;
      if (op[2]) {
        // insertion at <N / >N ($ = EOF)
        const n = op[3] === "$" ? -1 : parseInt(op[3], 10);
        current.push([n, n]);
      } else if (op[4]) {
        const s = parseInt(op[4], 10);
        if (op[5]) {
          current.push([s, parseInt(op[5], 10)]); // N.=M
        } else if (op[6]) {
          const r: Range = [s, s]; // N* — PUT extends with body length below
          current.push(r);
          if (op[1] === "PUT") pendingBlock = r;
          else r[1] = s + 2; // CUT N* estimate
        } else {
          current.push([s, s]);
        }
      }
      continue;
    }
    if (pendingBlock && line.startsWith("+")) pendingBlock[1]++;
    else pendingBlock = null;
  }
  return byFile;
}

function extractTouches(name: string, args: Json, cwd: string, ts: number): Touch[] {
  const out: Touch[] = [];
  const push = (raw: unknown, kind: Kind, ranges: Range[] = []) => {
    if (typeof raw !== "string") return;
    const rel = toRepoRel(raw, cwd);
    if (rel) out.push({ ts, file: rel, kind, tool: name, ranges });
  };
  const pushIfFile = (raw: string, kind: Kind) => {
    const { path, ranges } = splitSelector(raw.trim());
    const rel = toRepoRel(path, cwd);
    if (rel && existsSync(join(repoRoot, rel)) && statSync(join(repoRoot, rel)).isFile()) {
      out.push({ ts, file: rel, kind, tool: name, ranges });
    }
  };

  switch (name) {
    case "read": {
      const { path, ranges } = splitSelector(str(args.path));
      push(path, "read", ranges);
      break;
    }
    case "write": {
      const p = str(args.path);
      if (p.startsWith("xd://")) {
        // xd device calls: mine file references out of the JSON payload
        try {
          const payload: unknown = JSON.parse(str(args.content));
          if (isObj(payload)) {
            push(payload.file, "read");
            if (Array.isArray(payload.paths)) for (const pp of payload.paths) push(pp, "edit");
          }
        } catch {}
      } else {
        push(p, "write", [[1, -1]]);
      }
      break;
    }
    case "edit": {
      for (const [file, ranges] of parseEditInput(str(args.input))) push(file, "edit", ranges);
      break;
    }
    case "grep":
    case "glob": {
      for (const part of str(args.path).split(";")) pushIfFile(part, "search");
      break;
    }
    case "bash":
    case "eval": {
      const text = str(args.command) || str(args.code);
      const seen = new Set<string>();
      let m: RegExpExecArray | null;
      BASH_PATH.lastIndex = 0;
      while ((m = BASH_PATH.exec(text))) {
        if (seen.has(m[1])) continue;
        seen.add(m[1]);
        pushIfFile(m[1], "exec");
      }
      break;
    }
  }
  return out;
}

function parseSessionFile(path: string): SessionData | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  let header: { id: string; cwd: string; timestamp: string } | null = null;
  let title = "";
  const touches: Touch[] = [];

  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    let e: unknown;
    try {
      e = JSON.parse(t);
    } catch {
      continue;
    }
    if (!isObj(e)) continue;
    if (e.type === "title" || e.type === "title_change") {
      if (str(e.title)) title = str(e.title);
      continue;
    }
    if (e.type === "session") {
      // realpath once: touch resolution and repo matching must agree even
      // when the session recorded a symlinked cwd (/tmp on macOS)
      let cwd = str(e.cwd) ? resolve(str(e.cwd)) : "";
      try {
        cwd = realpathSync(cwd);
      } catch {}
      header = { id: str(e.id), cwd, timestamp: str(e.timestamp) };
      if (!title) title = str(e.title);
      continue;
    }
    if (!header || e.type !== "message") continue;
    const msg: unknown = e.message;
    if (!isObj(msg) || msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
    const ts = typeof msg.timestamp === "number" ? msg.timestamp : Date.parse(str(e.timestamp)) || 0;
    for (const block of msg.content as unknown[]) {
      if (!isObj(block)) continue;
      if (block.type !== "toolCall" && block.type !== "tool_call" && block.type !== "toolUse") continue;
      const rawArgs: unknown = block.arguments ?? block.input ?? block.args;
      touches.push(...extractTouches(str(block.name), isObj(rawArgs) ? rawArgs : {}, header.cwd || repoRoot, ts));
    }
  }
  if (!header) return null;
  if (header.cwd !== repoRoot) return null;
  return {
    id: header.id || path,
    title: title || "(untitled)",
    ts: Date.parse(header.timestamp) || 0,
    touches,
  };
}

function collectSessions(): SessionData[] {
  const out: SessionData[] = [];
  if (!existsSync(sessionsRoot)) return out;
  for (const bucket of readdirSync(sessionsRoot)) {
    const dir = join(sessionsRoot, bucket);
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const f of entries) {
      if (!f.endsWith(".jsonl")) continue;
      const s = parseSessionFile(join(dir, f));
      if (s && s.touches.length > 0) out.push(s);
    }
  }
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

const MAX_EMBED = 400_000; // per-file content cap for the full view

// diff base: git HEAD when the repo is git; else first-seen content (live).
// Cache is process-lifetime on purpose: the review base stays stable even if
// the user commits mid-session or the agent keeps editing.
const IS_GIT = (() => {
  try {
    return Bun.spawnSync(["git", "-C", repoRoot, "rev-parse", "--is-inside-work-tree"]).exitCode === 0;
  } catch {
    return false;
  }
})();
const baseCache = new Map<string, string | null>();

function baseFor(rel: string, current: string | null): string | null {
  const hit = baseCache.get(rel);
  if (hit !== undefined) return hit;
  let base: string | null = null;
  if (IS_GIT) {
    // `HEAD:./rel` resolves relative to -C cwd, not the git root
    const r = Bun.spawnSync(["git", "-C", repoRoot, "show", `HEAD:./${rel}`]);
    base = r.exitCode === 0 ? r.stdout.toString() : ""; // untracked/new -> whole file added
    if (base.length > MAX_EMBED) base = null;
  } else if (liveMode) {
    base = current; // snapshot at first sight; later snapshots diff against it
  }
  baseCache.set(rel, base);
  return base;
}

// change size + new-code complexity
//
// Two cheap per-file gut-check signals for the reviewer:
//  - chg: added/deleted line counts vs the diff base (multiset line diff, so
//    moved lines count as unchanged — magnitude, not position).
//  - cx: 0..1 complexity of the NEW code (added lines; whole file when there
//    is no diff): deep nesting + branch density. "this is simple" vs
//    "I'm unsure this is right", as a number.

const BRANCH_RE = /\b(if|else|elif|for|while|switch|case|match|catch|except|and|or|not)\b|&&|\|\||\?\?|\?\./g;

function complexityOf(lines: string[]): number {
  let n = 0, deep = 0, branch = 0;
  for (const raw of lines) {
    const t = raw.trim();
    if (!t || t.startsWith("//") || t.startsWith("#") || t.startsWith("*")) continue;
    n++;
    let col = 0;
    for (let i = 0; i < raw.length; i++) {
      const ch = raw.charCodeAt(i);
      if (ch === 9) col += 4; else if (ch === 32) col++; else break;
    }
    if (col >= 12) deep++; // 3+ indent levels
    branch += t.match(BRANCH_RE)?.length ?? 0;
  }
  return n === 0 ? 0 : Math.min(1, (deep / n) * 1.5 + (branch / n) * 0.8);
}

function changeStats(base: string, cur: string): { add: number; del: number; cx: number } {
  const count = new Map<string, number>();
  for (const l of base.split("\n")) count.set(l, (count.get(l) ?? 0) + 1);
  const added: string[] = [];
  for (const l of cur.split("\n")) {
    const c = count.get(l) ?? 0;
    if (c > 0) count.set(l, c - 1);
    else added.push(l);
  }
  let del = 0;
  for (const c of count.values()) del += c;
  return { add: added.length, del, cx: complexityOf(added) };
}

interface FileMeta {
  p: string; // repo-relative path
  n: number; // line count (0 if unknown)
  c: string | null; // content for minimap/full view
  o: string | null; // base content for diff; non-null only when it differs from c
  fi: number; // fan-in: repo-wide importer count
  fm: number; // fan-in from other modules
  imp: string[]; // importer paths (capped)
  chg: [number, number] | null; // [added, deleted] lines vs diff base
  cx: number; // 0..1 complexity of the new code (whole file when no diff)
}

// static import edges
//
// File-level dependency extraction between touched files. Heuristic per
// language; an LSP-backed extractor can replace this without touching the
// renderer (it only consumes DATA.deps pairs).

/** First existing repo-relative path among candidates. */
function firstExisting(candidates: string[]): string | null {
  for (const c of candidates) {
    const norm = c.split(sep).join("/");
    const abs = join(repoRoot, norm);
    if (existsSync(abs) && statSync(abs).isFile()) return norm;
  }
  return null;
}

const JS_EXTS = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];

function resolveJsImport(fromDir: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null; // package imports are out of scope
  const base = join(fromDir, spec).split(sep).join("/");
  const candidates: string[] = [];
  for (const ext of JS_EXTS) candidates.push(base + ext);
  for (const ext of JS_EXTS.slice(1)) candidates.push(base + "/index" + ext);
  return firstExisting(candidates);
}

/** Locate the Cargo crate src root that owns a file (nearest `src/` under a Cargo.toml dir). */
function crateSrcRoot(fileRel: string): string | null {
  let dir = dirname(fileRel);
  while (dir && dir !== ".") {
    if (basename(dir) === "src" && existsSync(join(repoRoot, dirname(dir), "Cargo.toml"))) return dir;
    dir = dirname(dir);
  }
  return existsSync(join(repoRoot, "Cargo.toml")) && existsSync(join(repoRoot, "src")) ? "src" : null;
}

function resolveRustPath(srcRoot: string, segments: string[]): string | null {
  const candidates: string[] = [];
  let prefix = srcRoot;
  for (const seg of segments) {
    candidates.push(`${prefix}/${seg}.rs`, `${prefix}/${seg}/mod.rs`);
    prefix = `${prefix}/${seg}`;
  }
  return firstExisting(candidates.reverse()); // deepest match first
}

function extractDepsFor(fileRel: string, content: string): string[] {
  const out = new Set<string>();
  const dir = dirname(fileRel);
  const ext = fileRel.split(".").at(-1) ?? "";

  if (["ts", "tsx", "js", "jsx", "mjs", "cjs"].includes(ext)) {
    const re = /(?:import|export)[^'"\n]*?from\s+['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)|import\(\s*['"]([^'"]+)['"]\s*\)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content))) {
      const target = resolveJsImport(dir, m[1] ?? m[2] ?? m[3]);
      if (target && target !== fileRel) out.add(target);
    }
  } else if (ext === "rs") {
    const srcRoot = crateSrcRoot(fileRel);
    let m: RegExpExecArray | null;
    // mod foo; → sibling module files
    const modRe = /^\s*(?:pub\s+)?mod\s+(\w+)\s*;/gm;
    while ((m = modRe.exec(content))) {
      const stem = basename(fileRel, ".rs");
      const siblingDir = ["lib", "main", "mod"].includes(stem) ? dir : `${dir}/${stem}`;
      const target = firstExisting([`${dir}/${m[1]}.rs`, `${dir}/${m[1]}/mod.rs`, `${siblingDir}/${m[1]}.rs`, `${siblingDir}/${m[1]}/mod.rs`]);
      if (target && target !== fileRel) out.add(target);
    }
    // use crate::a::b / use other_crate::a
    const useRe = /^\s*(?:pub\s+)?use\s+([\w:]+)/gm;
    while ((m = useRe.exec(content))) {
      const segs = m[1].split("::").filter((s) => s.length > 0);
      if (segs.length < 2) continue;
      let target: string | null = null;
      if (segs[0] === "crate" && srcRoot) {
        target = resolveRustPath(srcRoot, segs.slice(1, -1).concat(segs.at(-1) ?? []).slice(0, 3));
      } else if (segs[0] !== "self" && segs[0] !== "super" && segs[0] !== "std") {
        // cross-crate: crate_name → crates/crate-name/src/lib.rs
        const dashed = segs[0].replaceAll("_", "-");
        target = firstExisting([
          `crates/${dashed}/src/lib.rs`, `crates/${segs[0]}/src/lib.rs`,
          `packages/${dashed}/src/lib.rs`, `${dashed}/src/lib.rs`,
        ]);
      }
      if (target && target !== fileRel) out.add(target);
    }
  } else if (ext === "py") {
    const re = /^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content))) {
      const spec = m[1] ?? m[2];
      let baseDir: string;
      let rest = spec;
      if (spec.startsWith(".")) {
        const ups = (/^\.+/.exec(spec) ?? ["."])[0].length;
        baseDir = dir;
        for (let i = 1; i < ups; i++) baseDir = dirname(baseDir);
        rest = spec.slice(ups);
      } else {
        baseDir = "";
      }
      const p = rest ? join(baseDir, ...rest.split(".")) : baseDir;
      const target = firstExisting([`${p}.py`, `${p}/__init__.py`]);
      if (target && target !== fileRel) out.add(target);
    }
  }
  return [...out];
}

// repo-wide reverse deps
//
// Blast radius needs importers across the WHOLE repo, not just touched
// files — a touched-only graph undercounts how widely a file is used.

const SKIP_DIRS = new Set(["node_modules", "target", "dist", "build", "vendor", "__pycache__", "out"]);
const SRC_EXTS = new Set(["ts", "tsx", "js", "jsx", "mjs", "cjs", "rs", "py"]);
const MAX_SCAN_FILES = 20_000;
const IMPORTER_CAP = 30;
const depCache = new Map<string, { mtime: number; targets: string[] }>();

/** Every parseable source file in the repo (repo-relative), bounded. */
function listSourceFiles(): string[] {
  const out: string[] = [];
  const stack = ["."];
  while (stack.length > 0 && out.length < MAX_SCAN_FILES) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(join(repoRoot, dir));
    } catch {
      continue;
    }
    for (const name of entries) {
      const rel = dir === "." ? name : `${dir}/${name}`;
      let st;
      try {
        st = statSync(join(repoRoot, rel));
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (!SKIP_DIRS.has(name) && !name.startsWith(".")) stack.push(rel);
      } else if (st.isFile() && st.size <= MAX_EMBED && SRC_EXTS.has(name.split(".").at(-1) ?? "")) {
        out.push(rel);
      }
    }
  }
  return out;
}

/** Resolved import targets for one file, cached by mtime (live mode re-scans per snapshot). */
function cachedDeps(rel: string): string[] {
  try {
    const abs = join(repoRoot, rel);
    const mtime = statSync(abs).mtimeMs;
    const hit = depCache.get(rel);
    if (hit && hit.mtime === mtime) return hit.targets;
    const targets = extractDepsFor(rel, readFileSync(abs, "utf8"));
    depCache.set(rel, { mtime, targets });
    return targets;
  } catch {
    return [];
  }
}

/** Module identity: containing dir capped at two segments (mirrors client moduleOf). */
function moduleOfPath(f: string): string {
  return f.split("/").slice(0, -1).slice(0, 2).join("/") || "(root)";
}

/** Build the renderer data payload from a set of sessions. */
function buildSnapshot(sessionsList: SessionData[]) {
  // untitled sessions are headless agent runs (investigation/fix) — drop them
  sessionsList = sessionsList.filter((s) => s.title !== "(untitled)");
  const fileIndex = new Map<string, number>();
  const files: FileMeta[] = [];
  const fidx = (f: string): number => {
    let i = fileIndex.get(f);
    if (i !== undefined) return i;
    i = files.length;
    let content: string | null = null;
    let lineCount = 0;
    try {
      const abs = join(repoRoot, f);
      const st = statSync(abs);
      if (st.isFile()) {
        const text = readFileSync(abs, "utf8");
        lineCount = text.split("\n").length;
        if (st.size <= MAX_EMBED) content = text;
      }
    } catch {}
    const base = baseFor(f, content);
    const o = content !== null && base !== null && base !== content ? base : null;
    let chg: [number, number] | null = null;
    let cx = 0;
    if (content !== null && o !== null) {
      const cs = changeStats(o, content);
      chg = [cs.add, cs.del];
      cx = cs.cx;
    } else if (content !== null) {
      cx = complexityOf(content.split("\n"));
    }
    files.push({ p: f, n: lineCount, c: content, o, fi: 0, fm: 0, imp: [], chg, cx: Math.round(cx * 100) / 100 });
    fileIndex.set(f, i);
    return i;
  };

  const sessionsOut = sessionsList.map((s) => ({
    id: s.id,
    title: s.title,
    ts: s.ts,
    // [fileIdx, kindIdx, dtSeconds, tool, flatRanges]
    touches: s.touches.map((t) => [
      fidx(t.file),
      KINDS.indexOf(t.kind),
      Math.max(0, Math.round((t.ts - s.ts) / 1000)),
      t.tool,
      t.ranges.flat(),
    ]),
  }));

  // backfill unknown line counts from max seen range so minimaps still scale
  for (const s of sessionsList) {
    for (const t of s.touches) {
      const meta = files[fileIndex.get(t.file) ?? -1];
      if (meta) for (const [a, b] of t.ranges) meta.n = Math.max(meta.n, a, b);
    }
  }

  // dep edges among touched files only (those get windows)
  const deps: Array<[number, number]> = [];
  for (let i = 0; i < files.length; i++) {
    const meta = files[i];
    if (!meta.c) continue;
    for (const target of extractDepsFor(meta.p, meta.c)) {
      const j = fileIndex.get(target);
      if (j !== undefined && j !== i) deps.push([i, j]);
    }
  }

  // repo-wide blast radius: who imports each touched file
  if (files.length > 0) {
    for (const src of listSourceFiles()) {
      for (const target of cachedDeps(src)) {
        const j = fileIndex.get(target);
        if (j === undefined || files[j].p === src) continue;
        const meta = files[j];
        meta.fi++;
        if (moduleOfPath(src) !== moduleOfPath(meta.p)) meta.fm++;
        if (meta.imp.length < IMPORTER_CAP) meta.imp.push(src);
      }
    }
  }

  return {
    repo: repoRoot,
    generatedAt: new Date().toISOString(),
    kinds: KINDS,
    files,
    deps,
    sessions: sessionsOut,
    base: IS_GIT ? "git" : liveMode ? "live" : "none", // diff baseline mode, for client messaging
  };
}

function buildHtml(bootstrap: string): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>intuition — ${repoRoot.split("/").pop()}</title>
<style>
  :root {
    --bg: #0d1117; --panel: #161b22; --border: #30363d; --fg: #e6edf3;
    --dim: #8b949e; --read: #388bfd; --edit: #f85149; --write: #db6d28;
    --exec: #6e7681; --accent: #d29922;
  }
  * { box-sizing: border-box; }
  ::selection { background: var(--fg); color: var(--bg); }
  ::-webkit-scrollbar { width: 10px; height: 10px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: var(--border); border: 2px solid var(--bg); }
  ::-webkit-scrollbar-thumb:hover { background: var(--dim); }
  body { margin: 0; background: var(--bg); color: var(--fg);
    font: 13px/1.45 ui-monospace, "SF Mono", Menlo, monospace; }
  header { display: flex; align-items: baseline; gap: 14px; padding: 8px 12px;
    border-bottom: 1px solid var(--border); flex-wrap: wrap; position: sticky;
    top: 0; background: var(--panel); z-index: 5; }
  header h1 { margin: 0; line-height: 0; align-self: center; }
  header .repo { color: var(--dim); }
  #crossing { color: var(--accent); }
  #live { width: 10px; height: 10px; border-radius: 50%; margin-left: auto;
    align-self: center; display: none; background: var(--exec); }
  #live.ok { display: inline-block; background: #3fb950; }
  #live.err { display: inline-block; background: var(--edit); }
  select { background: var(--bg); color: var(--fg); border: 1px solid var(--border);
    border-radius: 0; padding: 3px 8px; font: inherit; max-width: 380px; }
  select:focus { outline: 1px solid var(--accent); outline-offset: -1px; }
  input[type=checkbox] { accent-color: var(--accent); }
  label.toggle { color: var(--dim); cursor: pointer; user-select: none; }
  #legend { display: flex; gap: 12px; color: var(--dim); font-size: 11px;
    padding: 5px 12px; border-bottom: 1px solid var(--border); }
  .sw { display: inline-block; width: 8px; height: 8px;
    margin-right: 4px; vertical-align: -1px; }
  main { display: flex; }
  #canvas { flex: 1; min-width: 0; padding: 14px; overflow: auto;
    height: calc(100vh - 73px); position: relative; }
  #edges { position: absolute; top: 0; left: 0; pointer-events: none; z-index: 3; }
  #edges path { fill: none; opacity: 0.35; }
  #edges path.cross { opacity: 0.55; }
  #edges path.hi { opacity: 1; stroke-width: 2.2; }
  #edges.hasHi path:not(.hi) { opacity: 0.08; }
  #edges path.dim, #edges.hasHi path.dim { opacity: 0.03; }
  aside { width: 360px; border-left: 1px solid var(--border); overflow-y: auto;
    padding: 12px; height: calc(100vh - 73px); }
  aside h2 { font-size: 11px; text-transform: uppercase; letter-spacing: .08em;
    color: var(--dim); margin: 18px 0 6px; display: flex; align-items: center;
    gap: 8px; white-space: nowrap; font-weight: normal; }
  aside h2::before { content: "──"; color: var(--border); }
  aside h2::after { content: ""; flex: 1; border-top: 1px solid var(--border); }
  aside h2:first-child { margin-top: 4px; }
  .row { display: flex; gap: 8px; padding: 3px 6px;
    cursor: pointer; align-items: baseline; }
  .row:hover { background: var(--panel); box-shadow: inset 2px 0 var(--dim); }
  @keyframes pulse { 50% { opacity: 0.35; } }
  .inv { color: var(--read); animation: pulse 1.4s ease-in-out infinite; }
  .badge.inv { color: var(--read); }
  .row.active { background: var(--panel); box-shadow: inset 2px 0 var(--accent); }
  .cl.cmt .ln, .drow.cmt .ln { color: var(--accent); }
  .selrange { box-shadow: inset 0 0 0 999px rgba(210,153,34,0.14); }
  #code .ln { cursor: pointer; }
  .row.muted { opacity: 0.55; }
  .row .name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .badge { font-size: 11px; color: var(--dim); white-space: nowrap; }
  .badge::before { content: "["; }
  .badge::after { content: "]"; }
  .badge.hot { color: var(--edit); }

  /* nested dir boxes — label sits on the frame, fieldset-style */
  .dir { border: 1px solid var(--border); padding: 12px 6px 6px;
    margin: 12px 6px 6px; position: relative; min-width: 0; }
  .dir.edited { border-color: rgba(248,81,73,0.55); }
  .dir > .dirlabel { position: absolute; top: -9px; left: 8px;
    max-width: calc(100% - 16px); background: var(--bg); padding: 0 5px;
    color: var(--dim); font-size: 11px; display: flex; gap: 8px;
    align-items: baseline; white-space: nowrap; overflow: hidden; }
  .dir.edited > .dirlabel > .dname { color: var(--fg); }
  .dirbody { display: flex; flex-wrap: wrap; align-items: flex-start; }

  /* file windows */
  .fw { width: 118px; margin: 6px; cursor: pointer; position: relative; z-index: 2; }
  .fw .fname { font-size: 10px; overflow: hidden; text-overflow: ellipsis;
    white-space: nowrap; margin-bottom: 3px; color: var(--dim); }
  .fw.edited .fname { color: var(--fg); }
  .fw.depsoff .fname::after { content: " ⌀deps"; color: var(--dim); }
  .fw canvas { display: block; width: 118px; border: 1px solid var(--border);
    background: #10151d; }
  .fw.edited canvas { border-color: rgba(248,81,73,0.6); }
  .fw:hover canvas { border-color: var(--accent); }
  .fw .fstats { font-size: 10px; color: var(--dim); margin-top: 2px; }
  .fw.risky canvas { border-color: var(--edit);
    outline: 1px solid rgba(248,81,73,0.45); outline-offset: 2px; }
  .fw .rk { font-size: 10px; color: var(--edit); margin-top: 1px; }
  .fw .vd { font-size: 10px; margin-top: 1px; color: var(--dim); }
  .fw .vd.hot { color: var(--edit); }
  .fw .vd.mid { color: var(--accent); }

  /* full view modal — hard offset shadow, Turbo Vision dialog style */
  #modal { position: fixed; inset: 0; background: rgba(3,6,10,0.82); z-index: 20;
    display: none; align-items: stretch; justify-content: center; padding: 24px; }
  #modal.open { display: flex; }
  #modalBox { background: var(--panel); border: 1px solid var(--dim);
    box-shadow: 10px 10px 0 rgba(0,0,0,0.55); width: min(1500px, 100%);
    display: flex; flex-direction: column; overflow: hidden; }
  #modalHead { display: flex; gap: 12px; padding: 10px 14px; align-items: baseline;
    border-bottom: 1px solid var(--border); flex-wrap: wrap; }
  #modalHead b { font-weight: normal; color: var(--fg); }
  #modalHead .close { margin-left: auto; cursor: pointer; color: var(--dim); }
  #modalHead .close::before { content: "["; }
  #modalHead .close::after { content: "]"; }
  #modalHead .close:hover { color: var(--fg); }
  #modalDeps { width: 100%; color: var(--dim); font-size: 11px; }
  #modalDeps span { cursor: pointer; text-decoration: underline dotted; margin-right: 10px; }
  #code { overflow: auto; flex: 1; padding: 8px 0; font-size: 12px; }
  .cl { display: flex; white-space: pre; position: relative; }
  .cl .ln { width: 52px; flex: none; text-align: right; padding-right: 12px;
    color: #444c56; user-select: none; }
  .cl.k-edit { background: rgba(248,81,73,0.16); box-shadow: inset 3px 0 var(--edit); }
  .cl.k-write { background: rgba(219,109,40,0.10); box-shadow: inset 3px 0 var(--write); }
  .cl.k-read { background: rgba(56,139,253,0.10); box-shadow: inset 3px 0 var(--read); }
  .tab { cursor: pointer; color: var(--dim); font-size: 12px; }
  .tab::before { content: "["; }
  .tab::after { content: "]"; }
  .tab + .tab { margin-left: 8px; }
  .tab.on { color: var(--bg); background: var(--accent); }

  /* side-by-side diff */
  .drow { display: flex; position: relative; }
  .dside { flex: 1 1 50%; min-width: 0; display: flex; }
  .dside + .dside { border-left: 1px solid var(--border); }
  .dside .ln { width: 44px; flex: none; text-align: right; padding-right: 10px;
    color: #444c56; user-select: none; }
  .dside .tx { flex: 1; white-space: pre-wrap; overflow-wrap: anywhere; padding-right: 22px; }
  .dside.del { background: rgba(248,81,73,0.15); }
  .dside.del .chg { background: rgba(248,81,73,0.42); }
  .dside.add { background: rgba(63,185,80,0.13); }
  .dside.add .chg { background: rgba(63,185,80,0.32); }
  .dside.pad { background: rgba(110,118,129,0.05); }
  .dsep { text-align: center; color: var(--dim); cursor: pointer; padding: 3px 0;
    font-size: 11px; background: rgba(255,255,255,0.02);
    border-top: 1px dashed var(--border); border-bottom: 1px dashed var(--border); }
  .dsep:hover { color: var(--fg); }

  /* inline comments */
  .cbtn { position: absolute; left: 2px; top: 0; width: 18px; height: 17px;
    line-height: 17px; text-align: center;
    background: var(--read); color: #fff; font-weight: bold;
    cursor: pointer; z-index: 2; }
  .drow .cbtn { left: calc(50% + 2px); } /* new-side gutter in the diff */
  .cbtn:hover { background: var(--accent); }
  .cthread { margin: 4px 16px 8px 56px; border: 1px solid var(--border);
    border-left: 3px solid var(--accent); padding: 6px 10px;
    background: rgba(210,153,34,0.05); white-space: normal; max-width: 720px; }
  .cthread.resolved { border-left-color: #3fb950; opacity: 0.6; }
  .cthread .cwho { color: var(--accent); font-size: 11px; }
  .cthread.resolved .cwho { color: #3fb950; }
  .cthread .cbody { margin: 2px 0 2px; white-space: pre-wrap; }
  .cthread .crep { border-top: 1px solid var(--border); margin-top: 5px; padding-top: 5px; }
  .cthread .clink { color: var(--dim); cursor: pointer; font-size: 11px;
    text-decoration: underline dotted; }
  .cthread .clink:hover { color: var(--fg); }
  .cthread .crep.note { opacity: 0.75; font-size: 11px; }
  .cthread .crep.note .cwho { color: var(--read); }
  .cform { margin: 4px 16px 8px 56px; max-width: 720px; white-space: normal; }
  .cform textarea { width: 100%; min-height: 54px; background: var(--bg);
    color: var(--fg); border: 1px solid var(--border); border-radius: 0;
    font: inherit; padding: 6px; resize: vertical; }
  .cform textarea:focus { outline: 1px solid var(--accent); outline-offset: -1px; }
  .cform .cact { display: flex; gap: 8px; margin-top: 4px; align-items: baseline; }
  .cform button { background: var(--bg); color: var(--fg); border: 1px solid var(--border);
    padding: 2px 12px; font: inherit; cursor: pointer; }
  .cform button:hover { border-color: var(--dim); }
  .cform button.primary { background: var(--accent); color: var(--bg);
    border-color: var(--accent); }
  .cform .chint { color: var(--dim); font-size: 11px; }
  #tooltip { position: fixed; pointer-events: none; background: var(--panel);
    border: 1px solid var(--dim); box-shadow: 6px 6px 0 rgba(0,0,0,0.5);
    padding: 5px 9px; font-size: 12px; display: none; z-index: 30; max-width: 480px; }
  #tooltip .t-hot { color: var(--edit); }
  #tooltip .t-calm { color: #3fb950; }
  #bglow rect { transition: opacity .45s ease; opacity: 0; }

  /* review controls: submit lives in the header; agent status beside it */
  #submitBtn { background: var(--bg); color: var(--accent); border: 1px solid var(--accent);
    padding: 1px 10px; font: inherit; font-size: 12px; cursor: pointer; }
  #submitBtn:hover { background: var(--accent); color: var(--bg); }
  #submitBtn:disabled { opacity: 0.5; cursor: default; }
  #agentState { font-size: 12px; color: var(--dim); }
  #agentState.busy { color: var(--accent); }

  /* hover aura: soft glow around the hovered file, echoed at its deps and
     pulled toward them; screen blend mixes overlapping tones, black stays */
  #aura { position: absolute; inset: 0; z-index: 1; pointer-events: none;
    opacity: 0; transition: opacity .6s ease; }
  #aura.on { opacity: 1; }
  .ablob { position: absolute; border-radius: 50%; mix-blend-mode: screen;
    animation: apull 3.5s ease-in-out infinite alternate; }
  @keyframes apull { to { transform: translate(var(--dx, 0), var(--dy, 0)) scale(1.08); } }
</style>
</head>
<body>
<header>
  <h1 title="intuition"><svg width="18" height="15" viewBox="0 0 12 10" shape-rendering="crispEdges" role="img" aria-label="intuition"><path fill="#f2789f" d="M2 0h4v1H2zM7 0h3v1H7zM1 1h10v1H1zM0 2h12v3H0zM1 5h10v1H1zM1 6h9v1H1zM2 7h7v1H2zM3 8h2v1H3zM6 8h2v1H6z"/><path fill="#9d4b6e" d="M6 1h1v2H6zM2 2h1v1H2zM3 3h1v1H3zM8 2h1v1H8zM9 3h1v1H9zM4 4h1v1H4zM8 5h1v1H8z"/><g id="bglow"></g></svg></h1>
  <span class="repo" id="repo"></span>
  <select id="sessionSel"><option value="all">all sessions</option></select>
  <label class="toggle"><input type="checkbox" id="depsToggle" checked> deps</label>
  <span id="crossing"></span>
  <span id="live"></span>
  <button id="submitBtn" style="display:none"></button>
  <span id="agentState"></span>
</header>
  <div id="legend">
    <span><span class="sw" style="background:var(--edit)"></span>edit</span>
    <span><span class="sw" style="background:var(--write)"></span>write</span>
    <span><span class="sw" style="background:var(--read)"></span>read</span>
    <span><span class="sw" style="background:var(--exec)"></span>exec/search</span>
    <span><span class="sw" style="background:var(--accent)"></span>cross-module dep</span>
  </div>
<main>
  <div id="canvas"></div>
  <aside>
    <h2>impact <span class="badge">edited × used-by</span></h2>
    <div id="blast"></div>
    <h2>sessions <span class="badge">sprawl = dirs edited</span></h2>
    <div id="sessions"></div>
    <h2>co-edited pairs <span class="badge">change coupling</span></h2>
    <div id="coupling"></div>
    <h2>review <span class="badge" id="revBadge"></span></h2>
    <div id="reviewList"></div>
  </aside>
</main>
<div id="modal"><div id="modalBox">
  <div id="modalHead"><b id="modalName"></b><span id="modalStats" style="color:var(--dim)"></span>
    <span id="modalTabs"><span class="tab" id="tabDiff">diff</span><span class="tab" id="tabCode">code</span></span>
    <span class="badge" id="modalCmt" style="display:none"></span>
    <span class="close" id="modalClose">esc</span><div id="modalDeps"></div></div>
  <div id="code"></div>
</div></div>
<div id="tooltip"></div>
<script>
let DATA = null;
const KIND_COLOR = { read: "#388bfd", search: "#1f6feb", exec: "#6e7681", edit: "#f85149", write: "#db6d28" };
const KIND_ALPHA = { read: 0.45, search: 0.35, exec: 0.35, edit: 0.9, write: 0.55 };
const EDIT_KINDS = { edit: true, write: true };
// draw order: weak kinds first so edits paint on top
const KIND_ORDER = ["search", "exec", "read", "write", "edit"];
// module identity: containing dir, capped at two segments (crates/lab-core, src, "(root)")
const moduleOf = (f) => f.split("/").slice(0, -1).slice(0, 2).join("/") || "(root)";
const sel = document.getElementById("sessionSel");

// aggregation: per file, per kind, resolved line ranges
function aggregate(sessionId) {
  const active = sessionId === "all" ? DATA.sessions : DATA.sessions.filter(s => s.id === sessionId);
  const stats = new Map(); // fi -> { counts, ranges, whole, total, rework }
  let editSeq = 0; // global edit-event sequence, for revisit detection
  for (const s of active) {
    for (const e of s.events) {
      let st = stats.get(e.fi);
      if (!st) {
        st = { counts: {}, ranges: {}, whole: {}, total: 0, rework: 0, prevEdits: [] };
        stats.set(e.fi, st);
      }
      st.counts[e.kind] = (st.counts[e.kind] ?? 0) + 1;
      st.total++;
      const n = DATA.files[e.fi].n || 1;
      const norm = e.ranges.map(([a, b]) => {
        const s0 = Math.max(1, a === -1 ? n : a);
        return [s0, b === -1 ? n : Math.max(s0, b)];
      });
      if (norm.length === 0) st.whole[e.kind] = true;
      else (st.ranges[e.kind] ??= []).push(...norm);
      // rework: re-touching already-edited lines AFTER editing elsewhere in
      // between = the agent went back — uncertainty signal. Consecutive hunks
      // to the same file are normal editing and don't count.
      // (edit-time line numbers drift; heuristic)
      if (EDIT_KINDS[e.kind]) {
        editSeq++;
        const rs = norm.length ? norm : [[1, n]];
        const overlap = st.prevEdits.length &&
          rs.some(([a, b]) => st.prevEdits.some(([c, d]) => a <= d && c <= b));
        if (overlap && editSeq - st.lastEditSeq > 1) st.rework++;
        st.lastEditSeq = editSeq;
        st.prevEdits.push(...rs);
      }
    }
  }
  return { active, stats };
}

// directory tree with single-child chain collapse
function buildTree(stats) {
  const root = { name: "", dirs: new Map(), files: [] };
  for (const fi of stats.keys()) {
    const parts = DATA.files[fi].p.split("/");
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!node.dirs.has(parts[i])) node.dirs.set(parts[i], { name: parts[i], dirs: new Map(), files: [] });
      node = node.dirs.get(parts[i]);
    }
    node.files.push(fi);
  }
  const collapse = (node) => {
    while (node.dirs.size === 1 && node.files.length === 0 && node.name !== "") {
      const child = node.dirs.values().next().value;
      node.name = node.name + "/" + child.name;
      node.dirs = child.dirs;
      node.files = child.files;
    }
    for (const d of node.dirs.values()) collapse(d);
    return node;
  };
  return collapse(root);
}

function countEdits(node, stats) {
  let n = 0;
  for (const fi of node.files) {
    const st = stats.get(fi);
    n += (st.counts.edit ?? 0) + (st.counts.write ?? 0);
  }
  for (const d of node.dirs.values()) n += countEdits(d, stats);
  return n;
}

const tooltip = document.getElementById("tooltip");

function drawMinimap(canvas, fi, st, W) {
  const meta = DATA.files[fi];
  const lines = meta.c !== null ? meta.c.split("\\n") : null;
  const n = Math.max(meta.n, 1);
  const H = Math.max(36, Math.min(170, n));
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d");
  const lh = H / n;
  // code texture: line-length bars
  ctx.fillStyle = "#2a3140";
  for (let i = 0; i < n; i++) {
    const len = lines ? Math.min((lines[i] ?? "").length, 100) : 60;
    if (len === 0) continue;
    ctx.fillRect(4, i * lh, (len / 100) * (W - 8), Math.max(lh * 0.72, 0.5));
  }
  // touched regions
  for (const kind of KIND_ORDER) {
    ctx.fillStyle = KIND_COLOR[kind];
    if (st.whole[kind]) {
      ctx.globalAlpha = kind === "edit" || kind === "write" ? 0.2 : 0.1;
      ctx.fillRect(0, 0, W, H);
    }
    ctx.globalAlpha = KIND_ALPHA[kind];
    for (const [a, b] of st.ranges[kind] ?? []) {
      ctx.fillRect(0, (a - 1) * lh, W, Math.max((b - a + 1) * lh, 2));
    }
    ctx.globalAlpha = 1;
  }
}

const fwEls = new Map(); // fi -> element
const dimmedDeps = new Set(); // fi whose dep edges are muted via ⌘-click

function renderCanvas(stats) {
  const el = document.getElementById("canvas");
  el.innerHTML = "";
  fwEls.clear();
  const tree = buildTree(stats);
  const renderNode = (node, container) => {
    let body = container;
    if (node.name) {
      const box = document.createElement("div");
      box.className = "dir" + (countEdits(node, stats) > 0 ? " edited" : "");
      const editCount = countEdits(node, stats);
      const label = document.createElement("div");
      label.className = "dirlabel";
      label.innerHTML = '<span class="dname">' + node.name + "/</span>" +
        (editCount ? '<span class="badge hot">' + editCount + " edits</span>" : "");
      box.appendChild(label);
      body = document.createElement("div");
      body.className = "dirbody";
      box.appendChild(body);
      container.appendChild(box);
    }
    for (const d of [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name))) renderNode(d, body);
    const sorted = [...node.files].sort((a, b) => riskScore(b, stats.get(b)) - riskScore(a, stats.get(a)));
    for (const fi of sorted) body.appendChild(fileWindow(fi, stats.get(fi)));
  };
  const top = document.createElement("div");
  top.className = "dirbody";
  el.appendChild(top);
  renderNode(tree, top);
  renderDeps(stats);
}

// plain-language verdict: how big was the change × how gnarly is the new code
// sizeW from changed lines vs base; cxW from server-side cx (nesting + branchiness
// of added lines); rework from re-edited line ranges
function verdict(fi, st) {
  const meta = DATA.files[fi];
  const [add, del] = meta.chg ?? [0, 0];
  const size = add + del;
  const frac = meta.n ? Math.min(1, size / meta.n) : 0;
  const sizeW = size >= 80 || frac >= 0.4 ? "big" : size >= 20 ? "medium" : "small";
  const cxW = meta.cx >= 0.45 ? "tangled" : meta.cx >= 0.2 ? "moderate" : "simple";
  const rework = st.rework ?? 0;
  const tone = sizeW === "big" || cxW === "tangled" || rework >= 2 ? "hot"
    : sizeW === "medium" || cxW === "moderate" || rework === 1 ? "mid" : "calm";
  return { add, del, size, frac, sizeW, cxW, rework, tone,
           icon: tone === "hot" ? "▲" : tone === "mid" ? "◆" : "·" };
}

// risk = editedness × how widely the file is used × how big/gnarly the change
function riskScore(fi, st) {
  const edits = (st.counts.edit ?? 0) + (st.counts.write ?? 0);
  const meta = DATA.files[fi];
  const size = meta.chg ? meta.chg[0] + meta.chg[1] : 0;
  return edits * (1 + (meta.fi ?? 0) + 2 * (meta.fm ?? 0)) *
    (1 + Math.min(2, size / 120) + meta.cx + (st.rework ?? 0) * 0.5);
}

function fileWindow(fi, st) {
  const meta = DATA.files[fi];
  const edited = (st.counts.edit ?? 0) + (st.counts.write ?? 0) > 0;
  const fanIn = meta.fi ?? 0;
  // visual weight: edited windows grow with blast radius
  const W = edited ? Math.round(Math.min(240, 96 + 26 * Math.log2(1 + fanIn))) : 96;
  const risky = edited && fanIn >= 3;
  const div = document.createElement("div");
  div.className = "fw" + (edited ? " edited" : "") + (risky ? " risky" : "") +
    (dimmedDeps.has(fi) ? " depsoff" : "");
  div.dataset.fi = fi; // hotkeys resolve the hovered window via .fw:hover
  div.style.width = W + "px";
  const fname = document.createElement("div");
  fname.className = "fname";
  fname.title = meta.p;
  fname.textContent = meta.p.split("/").at(-1);
  div.appendChild(fname);
  const canvas = document.createElement("canvas");
  canvas.style.width = W + "px";
  drawMinimap(canvas, fi, st, W);
  div.appendChild(canvas);
  const statsEl = document.createElement("div");
  statsEl.className = "fstats";
  statsEl.textContent = DATA.kinds.filter(k => st.counts[k]).map(k => k[0] + st.counts[k]).join(" ") +
    " · " + meta.n + "L";
  div.appendChild(statsEl);
  const v = edited && meta.chg ? verdict(fi, st) : null;
  if (v) {
    const vd = document.createElement("div");
    vd.className = "vd " + v.tone;
    vd.textContent = v.icon + " " + v.sizeW + " · " + v.cxW + (v.rework ? " ↻" + v.rework : "");
    div.appendChild(vd);
  }
  if (edited && fanIn > 0) {
    const rk = document.createElement("div");
    rk.className = "rk";
    rk.textContent = (risky ? "⚠ " : "") + "used by " + fanIn +
      (meta.fm ? " (" + meta.fm + " x-mod)" : "");
    div.appendChild(rk);
  }
  div.onclick = (ev) => {
    if (ev.metaKey || ev.ctrlKey) { // ⌘-click: mute this file's dep edges
      dimmedDeps.has(fi) ? dimmedDeps.delete(fi) : dimmedDeps.add(fi);
      div.classList.toggle("depsoff", dimmedDeps.has(fi));
      renderDeps(currentAgg.stats);
      return;
    }
    openModal(fi, st);
  };
  // hover: the gut-check sentence — how big, how gnarly, how far it reaches
  let tip = "<b>" + meta.p + "</b><br>" +
    DATA.kinds.filter(k => st.counts[k]).map(k => k + ": " + st.counts[k]).join(" · ") +
    (fanIn ? "<br>used by " + fanIn + " files" + (meta.fm ? ", " + meta.fm + " outside module" : "") : "");
  if (v) {
    tip += "<br>+" + v.add + " −" + v.del + " lines" +
      (meta.n ? " (" + Math.round(v.frac * 100) + "% of file)" : "") +
      " · " + v.cxW + " new code" +
      (v.rework ? "<br>↻ reworked ×" + v.rework + " — agent came back to the same lines" : "");
    if (v.tone === "hot") {
      tip += "<br><b class='t-hot'>" + (fanIn >= 3
        ? "big change × wide use — review closely"
        : "big or tangled change — worth a close look") + "</b>";
    } else if (v.tone === "calm") {
      tip += "<br><span class='t-calm'>small, simple change — low risk</span>";
    }
  } else if (!edited && meta.cx >= 0.45) {
    tip += "<br>tangled file (deep nesting / branchy)";
  }
  if (DATA.deps.some(([a, b]) => a === fi || b === fi)) {
    tip += "<br><span style='color:var(--dim)'>⌘click toggles dep edges</span>";
  }
  div.onmousemove = (ev) => {
    tooltip.style.display = "block";
    tooltip.style.left = (ev.clientX + 14) + "px";
    tooltip.style.top = (ev.clientY + 14) + "px";
    tooltip.innerHTML = tip;
  };
  div.onmouseenter = () => { showAura(fi); highlightEdges(fi, true); };
  div.onmouseleave = () => { tooltip.style.display = "none"; hideAura(); highlightEdges(fi, false); };
  fwEls.set(fi, div);
  return div;
}

// dependency edges (SVG overlay inside the scrolling canvas)
function renderDeps(stats) {
  const el = document.getElementById("canvas");
  const old = document.getElementById("edges");
  if (old) old.remove();
  if (!document.getElementById("depsToggle").checked) return;
  const svgNS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNS, "svg");
  svg.id = "edges";
  el.appendChild(svg);
  svg.setAttribute("width", el.scrollWidth);
  svg.setAttribute("height", el.scrollHeight);
  const cRect = el.getBoundingClientRect();
  const center = (fi) => {
    const r = fwEls.get(fi).getBoundingClientRect();
    return [r.left - cRect.left + el.scrollLeft + r.width / 2,
            r.top - cRect.top + el.scrollTop + r.height / 2];
  };
  const defs = document.createElementNS(svgNS, "defs");
  defs.innerHTML = '<marker id="arr" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">' +
    '<path d="M0,0 L8,4 L0,8 z" fill="context-stroke"/></marker>';
  svg.appendChild(defs);
  for (const [a, b] of DATA.deps) {
    if (!stats.has(a) || !stats.has(b) || !fwEls.has(a) || !fwEls.has(b)) continue;
    const [x1, y1] = center(a), [x2, y2] = center(b);
    const cross = moduleOf(DATA.files[a].p) !== moduleOf(DATA.files[b].p);
    const dx = x2 - x1, dy = y2 - y1;
    const bow = Math.min(60, Math.hypot(dx, dy) * 0.2);
    const mx = (x1 + x2) / 2 - dy / Math.max(1, Math.hypot(dx, dy)) * bow;
    const my = (y1 + y2) / 2 + dx / Math.max(1, Math.hypot(dx, dy)) * bow;
    const path = document.createElementNS(svgNS, "path");
    path.setAttribute("d", "M" + x1 + "," + y1 + " Q" + mx + "," + my + " " + x2 + "," + y2);
    path.setAttribute("stroke", cross ? "#d29922" : "#58a6ff");
    path.setAttribute("stroke-width", cross ? "1.6" : "1");
    path.setAttribute("marker-end", "url(#arr)");
    if (cross) path.classList.add("cross");
    if (dimmedDeps.has(a) || dimmedDeps.has(b)) path.classList.add("dim");
    path.dataset.a = a;
    path.dataset.b = b;
    svg.appendChild(path);
  }
}

function highlightEdges(fi, on) {
  const svg = document.getElementById("edges");
  if (!svg) return;
  let any = false;
  for (const p of svg.querySelectorAll("path")) {
    const hit = on && !p.classList.contains("dim") &&
      (Number(p.dataset.a) === fi || Number(p.dataset.b) === fi);
    p.classList.toggle("hi", hit);
    any = any || hit;
  }
  svg.classList.toggle("hasHi", any);
}

// hover aura: glow at the hovered file + its dep neighbors, each blob
// pulled toward the hovered window so connected tones flow together
let auraEl = null;
const AURA_RGB = { hot: "248,81,73", mid: "210,153,34", calm: "56,139,253" };

function toneOf(fi) {
  const st = currentAgg.stats.get(fi);
  if (!st) return "calm";
  const edited = (st.counts.edit ?? 0) + (st.counts.write ?? 0) > 0;
  return edited && DATA.files[fi].chg ? verdict(fi, st).tone : "calm";
}

function showAura(fi) {
  hideAura();
  const el = document.getElementById("canvas");
  const me = fwEls.get(fi);
  if (!me) return;
  hoverFi = fi;
  brainGlow(fi, toneOf(fi));
  const cRect = el.getBoundingClientRect();
  const center = (node) => {
    const r = node.getBoundingClientRect();
    return [r.left - cRect.left + el.scrollLeft + r.width / 2,
            r.top - cRect.top + el.scrollTop + r.height / 2];
  };
  auraEl = document.createElement("div");
  auraEl.id = "aura";
  const blob = (x, y, rad, tone, alpha, dx, dy) => {
    const b = document.createElement("div");
    b.className = "ablob";
    b.style.cssText = "left:" + (x - rad) + "px;top:" + (y - rad) + "px;" +
      "width:" + rad * 2 + "px;height:" + rad * 2 + "px;" +
      "background:radial-gradient(circle closest-side, rgba(" + AURA_RGB[tone] + "," + alpha + "), transparent 72%);" +
      "--dx:" + dx.toFixed(1) + "px;--dy:" + dy.toFixed(1) + "px";
    auraEl.appendChild(b);
  };
  const [hx, hy] = center(me);
  const rad = Math.max(460, me.getBoundingClientRect().width * 3.5);
  blob(hx, hy, rad, toneOf(fi), 0.11, 0, 0); // hovered: stays put, just breathes
  for (const [a, b] of DATA.deps) {
    const other = a === fi ? b : b === fi ? a : -1;
    if (other < 0 || !fwEls.has(other)) continue;
    if (dimmedDeps.has(fi) || dimmedDeps.has(other)) continue; // muted connection
    const [x, y] = center(fwEls.get(other));
    blob(x, y, 300, toneOf(other), 0.08, (hx - x) * 0.18, (hy - y) * 0.18);
  }
  el.appendChild(auraEl);
  requestAnimationFrame(() => auraEl && auraEl.classList.add("on"));
}

function hideAura() {
  hoverFi = null;
  brainClear();
  if (!auraEl) return;
  const e = auraEl;
  auraEl = null;
  e.classList.remove("on");
  setTimeout(() => e.remove(), 650); // let the fade-out finish
}

// brain glow: the header brain mirrors the aura — sections run hot/cold.
// Hover lights a deterministic little region per file; idle sparkles sample
// the current selection's verdict mix.
const bglow = document.getElementById("bglow");
const TONE_HEX = { hot: "#f85149", mid: "#d29922", calm: "#388bfd" };
const BRAIN_PIXELS = [];
[[0, [[2, 5], [7, 9]]], [1, [[1, 10]]], [2, [[0, 11]]], [3, [[0, 11]]], [4, [[0, 11]]],
 [5, [[1, 10]]], [6, [[1, 9]]], [7, [[2, 8]]], [8, [[3, 4], [6, 7]]]]
  .forEach(([y, runs]) => runs.forEach(([a, b]) => { for (let x = a; x <= b; x++) BRAIN_PIXELS.push([x, y]); }));
const BRAIN_SET = new Set(BRAIN_PIXELS.map(p => p.join()));
let hoverFi = null;

function brainPixel(x, y, hex) {
  const r = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  r.setAttribute("x", x);
  r.setAttribute("y", y);
  r.setAttribute("width", 1);
  r.setAttribute("height", 1);
  r.setAttribute("fill", hex);
  bglow.appendChild(r);
  requestAnimationFrame(() => { r.style.opacity = "0.95"; });
  return r;
}

function brainGlow(fi, tone) {
  bglow.innerHTML = "";
  // deterministic per-file section: seeded random walk over adjacent pixels
  let seed = (fi + 1) * 2654435761 >>> 0;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const cluster = new Set();
  let frontier = [BRAIN_PIXELS[Math.floor(rand() * BRAIN_PIXELS.length)]];
  cluster.add(frontier[0].join());
  while (cluster.size < 7 && frontier.length) {
    const [x, y] = frontier[Math.floor(rand() * frontier.length)];
    const nbrs = [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]
      .filter(p => BRAIN_SET.has(p.join()) && !cluster.has(p.join()));
    if (!nbrs.length) { frontier = frontier.filter(p => p[0] !== x || p[1] !== y); continue; }
    const n = nbrs[Math.floor(rand() * nbrs.length)];
    cluster.add(n.join());
    frontier.push(n);
  }
  for (const key of cluster) {
    const [x, y] = key.split(",").map(Number);
    brainPixel(x, y, TONE_HEX[tone]);
  }
}

function brainClear() {
  for (const r of bglow.children) r.style.opacity = "0";
  setTimeout(() => { if (hoverFi === null) bglow.innerHTML = ""; }, 500);
}

// idle ambience: single pixels pulse in tones drawn from the edited files
setInterval(() => {
  if (hoverFi !== null || !currentAgg) return;
  const tones = [];
  for (const [fi, st] of currentAgg.stats) {
    if ((st.counts.edit ?? 0) + (st.counts.write ?? 0) > 0) tones.push(toneOf(fi));
  }
  if (!tones.length) return;
  const [x, y] = BRAIN_PIXELS[Math.floor(Math.random() * BRAIN_PIXELS.length)];
  const r = brainPixel(x, y, TONE_HEX[tones[Math.floor(Math.random() * tones.length)]]);
  setTimeout(() => { r.style.opacity = "0"; setTimeout(() => r.remove(), 500); }, 700);
}, 1400);

// full view modal: side-by-side diff + annotated code + review comments
let modalFi = null, modalSt = null, modalView = "code";
let COMMENTS = [];      // flat review comments: path, start/end_line, body, author, resolved, replies
let REVIEW = { investigating: false, fixing: false, submittedAt: null, investigatingIds: [] };
let canComment = false; // true when a live server accepts POST /comment
let openForm = null;

async function loadComments() {
  try {
    const r = await fetch("/comments");
    if (!r.ok) throw new Error("no server");
    const j = await r.json();
    COMMENTS = Array.isArray(j.comments) ? j.comments : [];
    REVIEW = { investigating: !!j.investigating, fixing: !!j.fixing, submittedAt: j.submittedAt ?? null,
               investigatingIds: Array.isArray(j.investigatingIds) ? j.investigatingIds : [] };
    canComment = true;
  } catch {
    COMMENTS = [];
    REVIEW = { investigating: false, fixing: false, submittedAt: null, investigatingIds: [] };
    canComment = false;
  }
  renderReview();
  if (modalFi !== null && document.getElementById("modal").classList.contains("open")) renderModalView();
}

// review round: comments accumulate; submit starts the fix agent.
// pre-submit investigation is read-only — nothing edits until submitted.

// comments are tagged with the session id under review at creation time —
// robust with many concurrent sessions, unlike timestamp windows
function reviewSession() {
  return sel.value === "all" ? "" : sel.value;
}
function visibleComments() {
  const s = reviewSession();
  if (!s) return COMMENTS;
  return COMMENTS.filter(c => !c.session || c.session === s); // untagged = legacy, show everywhere
}
const submitBtn = document.getElementById("submitBtn");
const agentState = document.getElementById("agentState");
function renderReview() {
  renderReviewList();
  const open = visibleComments().filter(c => !c.resolved).length;
  if (!canComment) { submitBtn.style.display = "none"; agentState.textContent = ""; return; }
  if (REVIEW.fixing) {
    submitBtn.style.display = "none";
    agentState.className = "busy";
    agentState.textContent = "\\u25cf agent addressing review\\u2026";
    return;
  }
  agentState.className = "";
  agentState.textContent = REVIEW.investigating ? "\\u25d0 investigating\\u2026" : "";
  submitBtn.style.display = open ? "" : "none";
  submitBtn.disabled = false;
  submitBtn.textContent = "submit review (" + open + ")";
}

// sidebar panel: every comment, open first; click jumps to the file
function renderReviewList() {
  const cs = visibleComments();
  document.getElementById("revBadge").textContent =
    cs.filter(c => !c.resolved).length + " open";
  const el = document.getElementById("reviewList");
  el.innerHTML = "";
  if (!cs.length) {
    const empty = document.createElement("div");
    empty.className = "row";
    empty.style.color = "var(--dim)";
    empty.textContent = canComment ? "no comments \\u2014 click + on a line" : "no live review";
    el.appendChild(empty);
    return;
  }
  const sorted = [...cs].sort((a, b) => (a.resolved ? 1 : 0) - (b.resolved ? 1 : 0));
  for (const c of sorted) {
    const row = document.createElement("div");
    row.className = "row" + (c.resolved ? " muted" : "");
    const range = c.start_line ? ":" + c.start_line + (c.end_line > c.start_line ? "-" + c.end_line : "") : "";
    const loc = c.path.split("/").at(-1) + range;
    row.title = c.path + range + " \\u2014 " + c.body;
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = c.body; // textContent: bodies are arbitrary reviewer input
    const at = document.createElement("span");
    at.className = "badge";
    at.textContent = loc;
    row.append(name, at);
    const replies = (c.replies ?? []).filter(r => !r.note).length;
    if (c.resolved) {
      const done = document.createElement("span");
      done.className = "badge";
      done.textContent = "\\u2713";
      row.appendChild(done);
    } else if (REVIEW.investigatingIds.includes(c.id)) {
      const inv = document.createElement("span");
      inv.className = "badge inv";
      inv.textContent = "\\u25d0 investigating";
      row.appendChild(inv);
    } else if (replies) {
      const rep = document.createElement("span");
      rep.className = "badge hot";
      rep.textContent = "\\u21a9" + replies;
      row.appendChild(rep);
    }
    row.onclick = () => {
      if (!DATA || !currentAgg) return;
      const fi = DATA.files.findIndex(f => f.p === c.path);
      if (fi < 0 || !currentAgg.stats.has(fi)) return;
      openModal(fi, currentAgg.stats.get(fi));
      // openModal renders synchronously; land on the thread itself
      const th = document.querySelector('.cthread[data-cid="' + c.id + '"]');
      if (th) th.scrollIntoView({ block: "center" });
    };
    el.appendChild(row);
  }
}
submitBtn.onclick = async () => {
  submitBtn.disabled = true;
  try {
    const r = await fetch("/submit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session: reviewSession() }),
    });
    if (!r.ok) throw new Error(await r.text());
  } catch (e) {
    agentState.textContent = "submit failed: " + e.message;
  }
  await loadComments();
};

function fileComments(path) {
  return visibleComments().filter(c => c.path === path);
}

async function postComment(payload) {
  const r = await fetch("/comment", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error("post failed");
  await loadComments();
}

function commentForm(anchorEl, meta, line, replyTo, endLine) {
  if (openForm) openForm.remove();
  const f = document.createElement("div");
  f.className = "cform";
  const ta = document.createElement("textarea");
  ta.placeholder = replyTo ? "reply\\u2026"
    : endLine ? "comment on lines " + line + "\\u2013" + endLine
    : line === 0 ? "comment on this whole file"
    : "feedback for the agent \\u2014 collected until you submit the review";
  const act = document.createElement("div");
  act.className = "cact";
  const save = document.createElement("button");
  save.className = "primary";
  save.textContent = replyTo ? "reply" : "comment";
  const cancel = document.createElement("button");
  cancel.textContent = "cancel";
  const hint = document.createElement("span");
  hint.className = "chint";
  hint.textContent = "\\u2318\\u21a9 to save";
  const submit = async () => {
    const body = ta.value.trim();
    if (!body) return;
    save.disabled = true;
    save.textContent = "\\u2026";
    try {
      await postComment(replyTo
        ? { reply_to: replyTo, file: meta.p, body }
        : { file: meta.p, line, ...(endLine ? { end_line: endLine } : {}),
            session: reviewSession(), body });
    } catch {
      save.disabled = false;
      save.textContent = "failed \\u2014 retry";
    }
  };
  save.onclick = submit;
  const close = () => { f.remove(); openForm = null; paintDragSel(); }; // paint clears: dragSel is null
  cancel.onclick = close;
  ta.onkeydown = (ev) => {
    ev.stopPropagation();
    if (ev.key === "Escape") close();
    if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) submit();
  };
  act.append(save, cancel, hint);
  f.append(ta, act);
  if (anchorEl) anchorEl.after(f);
  else document.getElementById("code").prepend(f); // file-level: float at top
  openForm = f;
  ta.focus();
}

function threadEl(c, meta) {
  const d = document.createElement("div");
  d.className = "cthread" + (c.resolved ? " resolved" : "");
  if (c.id) d.dataset.cid = c.id;
  const who = document.createElement("div");
  who.className = "cwho";
  who.textContent = (c.author || "anon") +
    (c.start_line ? " \\u00b7 L" + c.start_line + (c.end_line > c.start_line ? "\\u2013" + c.end_line : "") : "") +
    (c.resolved ? " \\u00b7 \\u2713 resolved" : "");
  if (!c.resolved && REVIEW.investigatingIds.includes(c.id)) {
    const inv = document.createElement("span");
    inv.className = "inv";
    inv.textContent = " \\u00b7 \\u25d0 investigating";
    who.appendChild(inv);
  }
  const body = document.createElement("div");
  body.className = "cbody";
  body.textContent = c.body;
  d.append(who, body);
  for (const r of c.replies ?? []) {
    const rep = document.createElement("div");
    rep.className = "crep" + (r.note ? " note" : "");
    const rw = document.createElement("div");
    rw.className = "cwho";
    rw.textContent = (r.author || "agent") + (r.note ? " \\u00b7 open question?" : "");
    const rb = document.createElement("div");
    rb.className = "cbody";
    rb.textContent = r.body;
    rep.append(rw, rb);
    d.appendChild(rep);
  }
  if (canComment && c.id) {
    const link = document.createElement("span");
    link.className = "clink";
    link.textContent = "reply";
    link.onclick = () => commentForm(d, meta, 0, c.id);
    d.appendChild(link);
    // resolution is the reviewer's call, never the agent's
    const res = document.createElement("span");
    res.className = "clink";
    res.style.marginLeft = "10px";
    res.textContent = c.resolved ? "reopen" : "resolve";
    res.onclick = async () => {
      await fetch("/resolve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: c.id, resolved: !c.resolved }),
      });
      await loadComments();
    };
    d.appendChild(res);
  }
  return d;
}

/** Insert comment threads after their rows (new-side / on-disk line numbers). */
function attachThreads(container, meta, rowByLine) {
  for (const c of [...fileComments(meta.p)].reverse()) {
    const row = rowByLine.get(c.end_line || c.start_line || 0);
    const th = threadEl(c, meta);
    if (row) row.after(th);
    else container.prepend(th); // file-level or drifted comments float to the top
    // paint the whole commented range, not just the anchor row
    if (!c.resolved && c.start_line) {
      for (let l = c.start_line; l <= (c.end_line || c.start_line); l++) {
        const r = rowByLine.get(l);
        if (r) r.classList.add("cmt");
      }
    }
  }
}

// single hover "+" button shared across rows; rows carry data-bl = on-disk line
const cbtn = document.createElement("div");
cbtn.className = "cbtn";
cbtn.textContent = "+";
cbtn.title = "comment on this line";
// mousedown on it feeds the shared gutter-drag path below: click = one line,
// drag = range (the button floats over the gutter, so it must be a handle)

// drag along the line-number gutter to comment on a range (GitHub-style)
const codeEl = document.getElementById("code");
let dragSel = null; // { a, b } = on-disk line endpoints while dragging
function paintDragSel() {
  for (const r of codeEl.querySelectorAll(".selrange")) r.classList.remove("selrange");
  if (!dragSel) return;
  const lo = Math.min(dragSel.a, dragSel.b), hi = Math.max(dragSel.a, dragSel.b);
  for (const r of codeEl.querySelectorAll("[data-bl]")) {
    const n = Number(r.dataset.bl);
    if (n >= lo && n <= hi) r.classList.add("selrange");
  }
}
codeEl.addEventListener("mousedown", (ev) => {
  if (!canComment || modalFi === null) return;
  const t = ev.target;
  if (!t.classList.contains("ln") && !t.classList.contains("cbtn")) return;
  const row = ev.target.closest("[data-bl]");
  if (!row) return;
  ev.preventDefault(); // keep text selection out of the gutter drag
  dragSel = { a: Number(row.dataset.bl), b: Number(row.dataset.bl) };
  paintDragSel();
});
codeEl.addEventListener("mouseover", (ev) => {
  if (!dragSel) return;
  const row = ev.target.closest("[data-bl]");
  if (row) { dragSel.b = Number(row.dataset.bl); paintDragSel(); }
});
window.addEventListener("mouseup", () => {
  if (!dragSel) return;
  const lo = Math.min(dragSel.a, dragSel.b), hi = Math.max(dragSel.a, dragSel.b);
  dragSel = null; // keep the .selrange paint until the form closes
  const rows = [...codeEl.querySelectorAll("[data-bl]")];
  const anchor = rows.find(r => Number(r.dataset.bl) === hi);
  if (anchor) commentForm(anchor, DATA.files[modalFi], lo, null, hi > lo ? hi : undefined);
});
document.getElementById("code").addEventListener("mouseover", (ev) => {
  if (!canComment || modalFi === null) return;
  const row = ev.target.closest(".cl,.drow");
  // never re-append while the pointer is on the button: moving the node
  // under the cursor fires synthetic re-entry and swallows the click
  if (row && row.dataset.bl && cbtn.parentElement !== row) row.appendChild(cbtn);
});

// line diff: Myers O(ND) over the trimmed middle; null = too divergent
function myersOps(a, b) {
  const N = a.length, M = b.length, MAX = N + M;
  if (MAX === 0) return [];
  if (MAX > 60000) return null;
  const off = MAX;
  const v = new Int32Array(2 * MAX + 2);
  const trace = []; // per-round window v[off-d-1 .. off+d+1], local center d+1
  let found = -1;
  for (let d = 0; d <= MAX && found < 0; d++) {
    if (d > 1000) return null;
    for (let k = -d; k <= d; k += 2) {
      let x = (k === -d || (k !== d && v[off + k - 1] < v[off + k + 1])) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < N && y < M && a[x] === b[y]) { x++; y++; }
      v[off + k] = x;
      if (x >= N && y >= M) { found = d; break; }
    }
    trace.push(v.slice(off - d - 1, off + d + 2));
  }
  const ops = [];
  let x = N, y = M;
  for (let d = found; d > 0; d--) {
    const pv = trace[d - 1], c0 = d; // trace[d-1] window is off\\u00b1d, center d
    const k = x - y;
    const pk = (k === -d || (k !== d && pv[c0 + k - 1] < pv[c0 + k + 1])) ? k + 1 : k - 1;
    const px = pv[c0 + pk], py = px - pk;
    while (x > px && y > py) { ops.push("="); x--; y--; }
    if (x === px) { ops.push("+"); y--; } else { ops.push("-"); x--; }
  }
  while (x > 0 && y > 0) { ops.push("="); x--; y--; }
  while (x > 0) { ops.push("-"); x--; }
  while (y > 0) { ops.push("+"); y--; }
  return ops.reverse();
}

function dside(cls, ln, text, ip, is) {
  const s = document.createElement("div");
  s.className = "dside" + (cls ? " " + cls : "");
  const l = document.createElement("span");
  l.className = "ln";
  l.textContent = ln === null ? "" : ln;
  const t = document.createElement("span");
  t.className = "tx";
  if (text === null || text === "") {
    t.textContent = " ";
  } else if (ip !== null && (ip || is) && ip + is < text.length) {
    // intraline: highlight the changed middle between common prefix/suffix
    t.append(text.slice(0, ip));
    const m = document.createElement("span");
    m.className = "chg";
    m.textContent = text.slice(ip, text.length - is);
    t.append(m, text.slice(text.length - is));
  } else {
    t.textContent = text;
  }
  s.append(l, t);
  return s;
}

function renderDiff(meta, st) {
  const code = document.getElementById("code");
  if (meta.o === null) {
    const msg = document.createElement("div");
    msg.style.cssText = "padding:16px;color:var(--dim)";
    msg.textContent = DATA.base === "git"
      ? "no changes vs git HEAD"
      : DATA.base === "live"
        ? "no changes since intuition first saw this file \\u2014 repo isn't git, so diffs only accrue while the live server watches; git init for durable diffs"
        : "no diff base \\u2014 static report on a non-git repo";
    code.appendChild(msg);
    return null;
  }
  const A = meta.o.split("\\n"), B = meta.c.split("\\n");
  let pre = 0;
  const lim = Math.min(A.length, B.length);
  while (pre < lim && A[pre] === B[pre]) pre++;
  let suf = 0;
  while (suf < lim - pre && A[A.length - 1 - suf] === B[B.length - 1 - suf]) suf++;
  const midA = A.length - pre - suf, midB = B.length - pre - suf;
  let mid = midA && midB ? myersOps(A.slice(pre, A.length - suf), B.slice(pre, B.length - suf)) : null;
  if (mid === null) { // empty side or too divergent: one replace block
    mid = [];
    for (let i = 0; i < midA; i++) mid.push("-");
    for (let i = 0; i < midB; i++) mid.push("+");
  }
  const ops = [];
  for (let i = 0; i < pre; i++) ops.push("=");
  for (const o of mid) ops.push(o);
  for (let i = 0; i < suf; i++) ops.push("=");

  const cLines = new Set(fileComments(meta.p).map(c => c.end_line || c.start_line || 0));
  const rowByLine = new Map();
  const frag = document.createDocumentFragment();
  let firstChg = null;
  const CTX = 4;
  const ctxRow = (aIdx, bIdx) => {
    const row = document.createElement("div");
    row.className = "drow";
    row.dataset.bl = bIdx + 1;
    row.append(dside("", aIdx + 1, A[aIdx], null, 0), dside("", bIdx + 1, B[bIdx], null, 0));
    rowByLine.set(bIdx + 1, row);
    return row;
  };
  let ai = 0, bi = 0, i = 0;
  while (i < ops.length) {
    if (ops[i] === "=") {
      const a0 = ai, b0 = bi;
      let n = 0;
      while (i < ops.length && ops[i] === "=") { n++; ai++; bi++; i++; }
      const head = a0 === 0 && b0 === 0 ? 0 : CTX; // no context needed at file edges
      const tail = i >= ops.length ? 0 : CTX;
      let hasCmt = false;
      for (let l = b0 + 1; l <= b0 + n; l++) if (cLines.has(l)) { hasCmt = true; break; }
      if (!hasCmt && n > head + tail + 3) {
        for (let r = 0; r < head; r++) frag.appendChild(ctxRow(a0 + r, b0 + r));
        const wrap = document.createElement("div");
        wrap.style.display = "none";
        for (let r = head; r < n - tail; r++) wrap.appendChild(ctxRow(a0 + r, b0 + r));
        const sep = document.createElement("div");
        sep.className = "dsep";
        sep.textContent = "\\u22ef " + (n - head - tail) + " unchanged lines \\u22ef";
        sep.onclick = () => { wrap.style.display = ""; sep.remove(); };
        frag.append(sep, wrap);
        for (let r = n - tail; r < n; r++) frag.appendChild(ctxRow(a0 + r, b0 + r));
      } else {
        for (let r = 0; r < n; r++) frag.appendChild(ctxRow(a0 + r, b0 + r));
      }
    } else {
      const a0 = ai, b0 = bi;
      let del = 0, add = 0;
      while (i < ops.length && ops[i] !== "=") {
        if (ops[i] === "-") { del++; ai++; } else { add++; bi++; }
        i++;
      }
      for (let r = 0; r < Math.max(del, add); r++) {
        const aTx = r < del ? A[a0 + r] : null, bTx = r < add ? B[b0 + r] : null;
        let ip = null, is = 0;
        if (aTx !== null && bTx !== null) {
          ip = 0;
          const mx = Math.min(aTx.length, bTx.length);
          while (ip < mx && aTx[ip] === bTx[ip]) ip++;
          while (is < mx - ip && aTx[aTx.length - 1 - is] === bTx[bTx.length - 1 - is]) is++;
        }
        const row = document.createElement("div");
        row.className = "drow chg";
        row.append(
          aTx !== null ? dside("del", a0 + r + 1, aTx, ip, is) : dside("pad", null, null, null, 0),
          bTx !== null ? dside("add", b0 + r + 1, bTx, ip, is) : dside("pad", null, null, null, 0),
        );
        if (bTx !== null) { row.dataset.bl = b0 + r + 1; rowByLine.set(b0 + r + 1, row); }
        if (!firstChg) firstChg = row;
        frag.appendChild(row);
      }
    }
  }
  code.appendChild(frag);
  attachThreads(code, meta, rowByLine);
  return firstChg;
}

function renderCode(meta, st) {
  const code = document.getElementById("code");
  const n = meta.n || 1;
  // precedence per line: edit > write > read
  const mark = new Array(n + 1).fill(null);
  for (const kind of ["read", "write", "edit"]) {
    if (st.whole[kind] && kind !== "read") for (let i = 1; i <= n; i++) mark[i] = kind;
    for (const [a, b] of st.ranges[kind] ?? []) {
      for (let i = Math.max(1, a); i <= Math.min(n, b); i++) mark[i] = kind;
    }
  }
  const lines = meta.c.split("\\n");
  const frag = document.createDocumentFragment();
  const rowByLine = new Map();
  let firstMarked = null, firstEdit = null;
  for (let i = 0; i < lines.length; i++) {
    const row = document.createElement("div");
    row.className = "cl" + (mark[i + 1] ? " k-" + mark[i + 1] : "");
    row.dataset.bl = i + 1;
    if (mark[i + 1] && firstMarked === null) firstMarked = row;
    if (mark[i + 1] === "edit" && firstEdit === null) firstEdit = row;
    const ln = document.createElement("span");
    ln.className = "ln";
    ln.textContent = i + 1;
    const tx = document.createElement("span");
    tx.textContent = lines[i] || " ";
    row.append(ln, tx);
    rowByLine.set(i + 1, row);
    frag.appendChild(row);
  }
  code.appendChild(frag);
  attachThreads(code, meta, rowByLine);
  return firstEdit ?? firstMarked;
}

/** Redraw the modal body for the current file/view; returns the row to scroll to. */
function renderModalView() {
  const meta = DATA.files[modalFi];
  document.getElementById("tabDiff").className = "tab" + (modalView === "diff" ? " on" : "");
  document.getElementById("tabCode").className = "tab" + (modalView === "code" ? " on" : "");
  const cmts = fileComments(meta.p);
  const open = cmts.filter(c => !c.resolved).length;
  const cb = document.getElementById("modalCmt");
  cb.style.display = cmts.length ? "" : "none";
  cb.textContent = cmts.length + " comment" + (cmts.length === 1 ? "" : "s") + (open ? " \\u00b7 " + open + " open" : "");
  openForm = null;
  const code = document.getElementById("code");
  code.innerHTML = "";
  if (meta.c === null) {
    const msg = document.createElement("div");
    msg.style.cssText = "padding:16px;color:var(--dim)";
    msg.textContent = "(content unavailable \\u2014 file deleted, binary, or too large)";
    code.appendChild(msg);
    return null;
  }
  return modalView === "diff" ? renderDiff(meta, modalSt) : renderCode(meta, modalSt);
}

function openModal(fi, st) {
  modalFi = fi;
  modalSt = st;
  const meta = DATA.files[fi];
  document.getElementById("modalName").textContent = meta.p;
  document.getElementById("modalStats").textContent =
    (meta.chg ? "+" + meta.chg[0] + " −" + meta.chg[1] + " · " : "") +
    DATA.kinds.filter(k => st.counts[k]).map(k => k + ": " + st.counts[k]).join(" \\u00b7 ");
  // dep links: outgoing imports (touched only) + repo-wide importers
  const depEl = document.getElementById("modalDeps");
  depEl.innerHTML = "";
  const outD = DATA.deps.filter(([a]) => a === fi).map(([, b]) => b);
  if (outD.length) {
    depEl.append("imports: ");
    for (const other of outD) {
      const sp = document.createElement("span");
      sp.textContent = DATA.files[other].p;
      sp.onclick = () => { if (currentAgg.stats.has(other)) openModal(other, currentAgg.stats.get(other)); };
      depEl.appendChild(sp);
    }
    depEl.appendChild(document.createElement("br"));
  }
  if ((meta.imp ?? []).length) {
    depEl.append("used by (" + meta.fi + "): ");
    for (const p of meta.imp) {
      const other = DATA.files.findIndex(f => f.p === p);
      const sp = document.createElement("span");
      sp.textContent = p;
      if (other >= 0 && currentAgg.stats.has(other)) {
        sp.onclick = () => openModal(other, currentAgg.stats.get(other));
      } else {
        sp.style.cssText = "text-decoration:none;cursor:default;opacity:0.6";
      }
      depEl.appendChild(sp);
    }
    if (meta.fi > meta.imp.length) depEl.append(" +" + (meta.fi - meta.imp.length) + " more");
    depEl.appendChild(document.createElement("br"));
  }

  modalView = meta.o !== null ? "diff" : "code";
  const target = renderModalView();
  document.getElementById("modal").classList.add("open");
  if (target) target.scrollIntoView({ block: "center" });
}
document.getElementById("tabDiff").onclick = () => { if (modalView !== "diff") { modalView = "diff"; renderModalView(); } };
document.getElementById("tabCode").onclick = () => { if (modalView !== "code") { modalView = "code"; renderModalView(); } };
document.getElementById("modalClose").onclick = () => document.getElementById("modal").classList.remove("open");
document.getElementById("modal").onclick = (ev) => {
  if (ev.target.id === "modal") document.getElementById("modal").classList.remove("open");
};
window.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape") {
    if (openForm) { openForm.remove(); openForm = null; paintDragSel(); }
    else document.getElementById("modal").classList.remove("open");
    return;
  }
  if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
  const t = ev.target;
  if (t && (t.tagName === "TEXTAREA" || t.tagName === "INPUT" || t.tagName === "SELECT")) return;
  if (!canComment) return;
  // r over a thread: toggle resolved
  if (ev.key === "r") {
    const th = document.querySelector(".cthread:hover");
    if (th && th.dataset.cid) {
      ev.preventDefault();
      fetch("/resolve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: th.dataset.cid, resolved: !th.classList.contains("resolved") }),
      }).then(loadComments);
    }
    return;
  }
  if (ev.key !== "c") return;
  // c over a code line: comment on that line
  const row = document.querySelector("#code .cl:hover, #code .drow:hover");
  if (row && row.dataset.bl && modalFi !== null) {
    ev.preventDefault();
    commentForm(row, DATA.files[modalFi], Number(row.dataset.bl), null);
    return;
  }
  // c over a file window: comment on the whole file
  const fw = document.querySelector(".fw:hover");
  if (fw && fw.dataset.fi !== undefined && currentAgg) {
    ev.preventDefault();
    const fi = Number(fw.dataset.fi);
    const st = currentAgg.stats.get(fi);
    if (!st) return;
    openModal(fi, st);
    commentForm(null, DATA.files[fi], 0, null);
  }
});

// sessions panel + module-crossing summary
function renderSessions() {
  const el = document.getElementById("sessions");
  el.innerHTML = "";
  for (const s of DATA.sessions) {
    const edited = new Set(s.events.filter(e => EDIT_KINDS[e.kind]).map(e => e.file));
    const dirs = new Set([...edited].map(f => f.split("/").slice(0, -1).join("/") || "."));
    const row = document.createElement("div");
    row.className = "row" + (sel.value === s.id ? " active" : "");
    row.innerHTML = '<span class="name">' + s.title + "</span>" +
      '<span class="badge">' + edited.size + " files</span>" +
      '<span class="badge' + (dirs.size >= 4 ? " hot" : "") + '">sprawl ' + dirs.size + "</span>";
    row.onclick = () => { userPicked = true; sel.value = sel.value === s.id ? "all" : s.id; update(); };
    el.appendChild(row);
  }
}

function renderCrossing(active, stats) {
  const edited = new Set();
  for (const s of active) for (const e of s.events) if (EDIT_KINDS[e.kind]) edited.add(e.file);
  const dirs = new Set([...edited].map(f => f.split("/").slice(0, -1).join("/") || "."));
  const modules = new Set([...edited].map(moduleOf));
  let crossDeps = 0;
  for (const [a, b] of DATA.deps) {
    if (stats.has(a) && stats.has(b) && moduleOf(DATA.files[a].p) !== moduleOf(DATA.files[b].p)) crossDeps++;
  }
  let topRisk = null;
  for (const [fi, st] of stats) {
    if ((st.counts.edit ?? 0) + (st.counts.write ?? 0) === 0) continue;
    if ((DATA.files[fi].fi ?? 0) >= 3 && (topRisk === null || DATA.files[fi].fi > DATA.files[topRisk].fi)) topRisk = fi;
  }
  document.getElementById("crossing").textContent =
    "edits: " + edited.size + " files · " + dirs.size + " dirs · " + modules.size + " modules" +
    (crossDeps ? " · " + crossDeps + " cross-module deps" : "") +
    (topRisk !== null ? " · ⚠ " + DATA.files[topRisk].p.split("/").at(-1) + " used by " + DATA.files[topRisk].fi : "");
}

// coupling panel
function renderCoupling(active) {
  const pairs = new Map();
  for (const s of active) {
    const edited = [...new Set(s.events.filter(e => EDIT_KINDS[e.kind]).map(e => e.file))].sort();
    for (let i = 0; i < edited.length; i++)
      for (let j = i + 1; j < edited.length; j++) {
        const key = edited[i] + "\\u0000" + edited[j];
        pairs.set(key, (pairs.get(key) ?? 0) + 1);
      }
  }
  const top = [...pairs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14);
  const el = document.getElementById("coupling");
  el.innerHTML = "";
  if (!top.length) {
    const empty = document.createElement("div");
    empty.className = "row";
    empty.style.color = "var(--dim)";
    empty.textContent = "no co-edits in selection";
    el.appendChild(empty);
  }
  for (const [key, n] of top) {
    const [a, b] = key.split("\\u0000");
    const cross = moduleOf(a) !== moduleOf(b);
    const sh = (f) => { const p = f.split("/"); return p.length > 3 ? p[0] + "/…/" + p.at(-1) : f; };
    const div = document.createElement("div");
    div.className = "row";
    div.style.cursor = "default";
    div.title = a + "  <->  " + b;
    div.innerHTML = '<span class="name">' + sh(a) +
      ' <span style="color:var(--accent)">' + (cross ? "⇢" : "·") + "</span> " + sh(b) +
      "</span><span class='badge'>" + n + "</span>";
    el.appendChild(div);
  }
}

let currentAgg = null;
function update() {
  currentAgg = aggregate(sel.value);
  renderCanvas(currentAgg.stats);
  renderSessions();
  renderCoupling(currentAgg.active);
  renderBlast(currentAgg.stats);
  renderCrossing(currentAgg.active, currentAgg.stats);
  renderReview(); // comment scope follows the selected session
}

// blast radius panel: edited files ranked by importer count
function renderBlast(stats) {
  const el = document.getElementById("blast");
  el.innerHTML = "";
  const rows = [...stats.entries()]
    .filter(([fi, st]) => (st.counts.edit ?? 0) + (st.counts.write ?? 0) > 0 && (DATA.files[fi].fi ?? 0) > 0)
    .sort((a, b) => riskScore(b[0], b[1]) - riskScore(a[0], a[1]))
    .slice(0, 10);
  if (!rows.length) {
    const empty = document.createElement("div");
    empty.className = "row";
    empty.style.color = "var(--dim)";
    empty.textContent = "no edited files with importers";
    el.appendChild(empty);
    return;
  }
  for (const [fi, st] of rows) {
    const meta = DATA.files[fi];
    const row = document.createElement("div");
    row.className = "row";
    row.title = meta.p;
    row.innerHTML = '<span class="name">' + meta.p.split("/").at(-1) + "</span>" +
      (meta.chg ? '<span class="badge">+' + meta.chg[0] + " −" + meta.chg[1] + "</span>" : "") +
      '<span class="badge' + (meta.fi >= 3 ? " hot" : "") + '">used by ' + meta.fi + "</span>" +
      (meta.fm ? '<span class="badge hot">' + meta.fm + " x-mod</span>" : "");
    row.onclick = () => openModal(fi, st);
    el.appendChild(row);
  }
}
let userPicked = false; // until the user chooses, follow the current (newest) session
sel.onchange = () => { userPicked = true; update(); };
document.getElementById("depsToggle").onchange = () => renderDeps(currentAgg.stats);
window.addEventListener("resize", () => renderDeps(currentAgg.stats));
function setData(data) {
  DATA = data;
  const repoName = DATA.repo.split("/").pop();
  document.getElementById("repo").textContent = repoName;
  document.getElementById("repo").title = DATA.repo;
  document.title = "intuition \u2014 " + repoName;
  for (const s of DATA.sessions) {
    s.events = s.touches.map(([f, k, dt, tool, flat]) => {
      const ranges = [];
      for (let i = 0; i + 1 < flat.length; i += 2) ranges.push([flat[i], flat[i + 1]]);
      return { fi: f, file: DATA.files[f].p, kind: DATA.kinds[k], dt, tool, ranges };
    });
  }
  const prev = sel.value;
  sel.length = 1; // keep "all sessions"
  for (const s of DATA.sessions) {
    const o = document.createElement("option");
    o.value = s.id;
    o.textContent = new Date(s.ts).toISOString().slice(0, 16).replace("T", " ") + "  " + s.title;
    sel.appendChild(o);
  }
  if (userPicked && [...sel.options].some(o => o.value === prev)) {
    sel.value = prev;
  } else if (DATA.sessions.length) {
    // default: only the current (newest) session
    sel.value = DATA.sessions.reduce((a, s) => (s.ts > a.ts ? s : a)).id;
  }
  update();
}
loadComments();
${bootstrap}
</script>
</body>
</html>
`;
}

const LIVE_BOOTSTRAP = `
const liveEl = document.getElementById("live");
async function load() {
  const r = await fetch("/data");
  setData(await r.json());
  liveEl.className = "ok";
  liveEl.title = "live \\u00b7 updated " + new Date().toLocaleTimeString();
}
const es = new EventSource("/events");
es.onmessage = () => load();
es.addEventListener("comments", () => loadComments());
// the server re-execs itself when intuition.ts changes; the stream drops and
// reconnects to the new process — reload to pick up new HTML/CSS/JS
let dropped = false;
es.onopen = () => { if (dropped) location.reload(); };
es.onerror = () => { dropped = true; liveEl.className = "err"; liveEl.title = "reconnecting\\u2026"; };
load();
`;

// interstitial for /intuition/new: poll until the replacement is up, then go
const RESTART_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>intuition — restarting</title></head>
<body style="background:#0d1117;color:#8b949e;font:13px/1.45 ui-monospace,Menlo,monospace;padding:40px">
starting a fresh intuition\u2026
<script>
const t = setInterval(async () => {
  try {
    const r = await fetch("/data", { cache: "no-store" });
    if (r.ok) { clearInterval(t); location.href = "/intuition"; }
  } catch {}
}, 400);
</script>
</body></html>
`;

if (!liveMode) {
  const sessions = collectSessions();
  if (sessions.length === 0) {
    console.error(`No omp sessions with file touches found for repo: ${repoRoot}`);
    console.error(`Searched: ${sessionsRoot}`);
    process.exit(1);
  }
  const snap = buildSnapshot(sessions);
  const dataJson = JSON.stringify(snap).replace(/</g, "\\u003c");
  await Bun.write(outPath, buildHtml(`setData(${dataJson});`));
  const total = sessions.reduce((n, s) => n + s.touches.length, 0);
  console.log(`intuition: ${sessions.length} session(s), ${total} touches, ${snap.files.length} files, ${snap.deps.length} dep edges`);
  console.log(`report: ${resolve(outPath)}`);
} else {
  // live server: tail session files, push updates over SSE
  interface WatchState {
    size: number;
    mtime: number;
    belongs: boolean | null; // null = header not seen yet, retry on change
  }
  const watch = new Map<string, WatchState>();
  const liveSessions = new Map<string, SessionData>(); // keyed by session file path
  let version = 0;
  const enc = new TextEncoder();
  const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();

  /** Sniff the session header from the file head; cwd never changes, so false is cacheable. */
  function sniffBelongs(path: string): boolean | null {
    try {
      const fd = openSync(path, "r");
      const buf = Buffer.alloc(8192);
      const n = readSync(fd, buf, 0, buf.length, 0);
      closeSync(fd);
      for (const line of buf.toString("utf8", 0, n).split("\n")) {
        const t = line.trim();
        if (!t.startsWith("{") || !t.includes('"type":"session"')) continue;
        try {
          const h: unknown = JSON.parse(t);
          if (isObj(h) && h.type === "session") {
            let cwd = str(h.cwd) ? resolve(str(h.cwd)) : "";
            try {
              cwd = realpathSync(cwd);
            } catch {}
            return cwd === repoRoot;
          }
        } catch {}
      }
    } catch {}
    return null;
  }

  function broadcast(payload: string) {
    const msg = enc.encode(payload);
    for (const c of [...clients]) {
      try {
        c.enqueue(msg);
      } catch {
        clients.delete(c);
      }
    }
  }

  // review: .intuition/notes.jsonl is the single source of truth.
  // Records: comment {ts,id,author,file,line,body} · reply {ts,id,reply_to,author,body}
  //          resolve {ts,resolve:<id>,resolved} · submit {ts,submit:true,comments}
  // Comments accumulate in the dashboard; while they do, a READ-ONLY omp agent
  // may investigate (brief at .intuition/investigation.md). Nothing edits the
  // repo until the reviewer submits — then an editing omp agent is spawned to
  // address every open comment. It replies by appending JSONL records here;
  // resolution stays with the reviewer in the dashboard.
  const author = (() => {
    try {
      return userInfo().username || "reviewer";
    } catch {
      return "reviewer";
    }
  })();
  const notesDir = join(repoRoot, ".intuition");
  const notesPath = join(notesDir, "notes.jsonl");
  const briefPath = join(notesDir, "investigation.md");
  const agentPidPath = join(notesDir, "agent.pid");

  function appendNote(rec: Json): void {
    mkdirSync(notesDir, { recursive: true });
    const keep = join(notesDir, ".gitignore");
    if (!existsSync(keep)) writeFileSync(keep, "*\n");
    appendFileSync(notesPath, JSON.stringify(rec) + "\n");
  }

  interface ReviewComment {
    id: string;
    path: string;
    scope: "line" | "file";
    start_line: number;
    end_line: number;
    body: string;
    author: string;
    resolved: boolean;
    replies: Array<{ id: string; author: string; body: string; note: boolean }>;
    session: string; // omp session id the comment was filed against ("" = untagged)
  }

  function foldComments(): { comments: ReviewComment[]; submittedAt: string | null; roundPending: boolean } {
    const comments: ReviewComment[] = [];
    const byId = new Map<string, ReviewComment>();
    let submittedAt: string | null = null;
    let lastRound: string[] = [];
    let lines: string[] = [];
    try {
      lines = readFileSync(notesPath, "utf8").split("\n");
    } catch {}
    for (const l of lines) {
      if (!l.trim()) continue;
      let rec: unknown;
      try {
        rec = JSON.parse(l);
      } catch {
        continue;
      }
      if (!isObj(rec)) continue;
      if (rec.submit === true) {
        submittedAt = str(rec.ts) || submittedAt;
        lastRound = Array.isArray(rec.comments) ? rec.comments.filter((x): x is string => typeof x === "string") : [];
        continue;
      }
      if (str(rec.resolve)) {
        const c = byId.get(str(rec.resolve));
        if (c) c.resolved = rec.resolved !== false;
        continue;
      }
      const body = str(rec.body);
      if (!body) continue;
      if (str(rec.reply_to)) {
        const c = byId.get(str(rec.reply_to));
        if (c) c.replies.push({ id: str(rec.id), author: str(rec.author) || "agent", body, note: rec.note === true });
        continue;
      }
      if (!str(rec.file)) continue;
      const line = typeof rec.line === "number" && rec.line > 0 ? Math.floor(rec.line) : 0;
      const endLine = typeof rec.end_line === "number" && rec.end_line > line ? Math.floor(rec.end_line) : line;
      const c: ReviewComment = {
        id: str(rec.id) || "c_" + (comments.length + 1),
        path: str(rec.file),
        scope: line > 0 ? "line" : "file",
        start_line: line,
        end_line: endLine,
        body,
        author: str(rec.author),
        resolved: false,
        replies: [],
        session: str(rec.session),
      };
      comments.push(c);
      byId.set(c.id, c);
    }
    // the round is live until every comment in it is resolved or has a real
    // agent reply — investigator notes don't count
    const roundPending = lastRound.some((id) => {
      const c = byId.get(id);
      return !!c && !c.resolved && !c.replies.some((r) => !r.note);
    });
    return { comments, submittedAt, roundPending };
  }

  // review agents (omp -p). Read-only before submit; edits only after.
  let investigating: Bun.Subprocess | null = null;
  let investigatedCount = -1;
  let investigatingIds: string[] = []; // open comment ids the current brief covers
  let fixing: Bun.Subprocess | null = null;

  /** Survives self-reload: the fix agent outlives this process, so track it by pid. */
  function agentRunning(): boolean {
    if (fixing) return true;
    let pid = 0;
    try {
      pid = Number(readFileSync(agentPidPath, "utf8").trim()) || 0;
    } catch {}
    if (!pid) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  function commentBlock(cs: ReviewComment[]): string {
    return cs.map((c) =>
      `- [${c.id}] ${c.path}${c.start_line ? ":" + c.start_line + (c.end_line > c.start_line ? "-" + c.end_line : "") : ""} — ${c.body}` +
      c.replies.map((r) => `\n  reply (${r.author}): ${r.body}`).join(""),
    ).join("\n");
  }

  /** Pre-submit background: read-only toolset, so it CANNOT edit the repo. */
  function maybeInvestigate() {
    const open = foldComments().comments.filter((c) => !c.resolved);
    if (open.length === 0 || investigating || agentRunning()) return;
    if (open.length === investigatedCount) return; // brief already covers these
    investigatedCount = open.length;
    investigatingIds = open.map((c) => c.id);
    const prompt =
      `You are preparing background for a code review of this repository. Review comments so far:\n\n` +
      `${commentBlock(open)}\n\n` +
      `Investigate the referenced files and write a concise markdown brief: what the commented code does, ` +
      `related code each comment implicates, risks, and a suggested approach per comment (keyed by comment id). ` +
      `This is read-only investigation — do not attempt any changes. Print only the brief.\n\n` +
      `End the brief with one fenced json block shaped {"notes":{"<comment id>":"<one short sentence>"}} — ` +
      `an entry ONLY for comments that are open questions or ambiguous judgement calls (skip clear nits and ` +
      `obvious edits); each note says what needs deciding or checking before the change is safe.`;
    investigating = Bun.spawn(["omp", "-p", "--no-session", "--tools=read,grep,glob", prompt], {
      cwd: repoRoot,
      stdout: Bun.file(briefPath),
      stderr: "ignore",
      onExit: () => {
        investigating = null;
        investigatingIds = [];
        surfaceInvestigationNotes();
        broadcast("event: comments\ndata: 1\n\n");
      },
    });
  }

  /** Attach the investigator's open-question notes to their threads. */
  function surfaceInvestigationNotes() {
    let brief = "";
    try {
      brief = readFileSync(briefPath, "utf8");
    } catch {
      return;
    }
    const fences = [...brief.matchAll(/```json\s*([\s\S]*?)```/g)];
    if (fences.length === 0) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(fences[fences.length - 1][1]);
    } catch {
      return;
    }
    if (!isObj(parsed) || !isObj(parsed.notes)) return;
    const { comments } = foldComments();
    for (const [cid, note] of Object.entries(parsed.notes)) {
      if (typeof note !== "string" || !note.trim()) continue;
      const c = comments.find((x) => x.id === cid);
      if (!c || c.resolved || c.replies.some((r) => r.note)) continue; // unknown, closed, or already noted
      appendNote({
        ts: new Date().toISOString(),
        id: "rp_" + Math.random().toString(16).slice(2, 8),
        reply_to: cid,
        note: true,
        author: "investigation",
        body: note.trim(),
      });
    }
  }

  /** Submit = the only trigger for edits. A live omp session (via the
   *  intuition extension) gets first claim on the round by acking it in the
   *  journal within the grace window; otherwise a headless fallback resumes
   *  the exact session under review (omp -p -r <id>). */
  const CLAIM_GRACE_MS = 25_000;
  async function submitReview(req: Request): Promise<Response> {
    // client scopes the round to the session under review; comments tagged
    // with other sessions belong to different work and stay out of the prompt
    let session = "";
    try {
      const b: unknown = await req.json();
      if (isObj(b)) session = str(b.session);
    } catch {}
    const fold = foldComments();
    const open = fold.comments.filter(
      (c) => !c.resolved && (!session || !c.session || c.session === session),
    );
    if (open.length === 0) return new Response("no open comments", { status: 400 });
    if (agentRunning() || fold.roundPending) {
      return new Response("a review round is already in progress", { status: 409 });
    }
    const submitTs = new Date().toISOString();
    appendNote({ ts: submitTs, submit: true, author, session, comments: open.map((c) => c.id) });
    const prompt =
      `A code review of your recent work in this repository was submitted via the intuition dashboard. ` +
      `Address every comment below: make the change, or reply explaining why not.\n\n` +
      `${commentBlock(open)}\n\n` +
      (existsSync(briefPath) ? `A read-only investigation brief is at .intuition/investigation.md — read it first.\n\n` : "") +
      `After addressing each comment, record a reply by appending ONE line to .intuition/notes.jsonl:\n` +
      `  {"ts":"<iso timestamp>","reply_to":"<comment id>","author":"agent","body":"<what you did>"}\n` +
      `Never mark comments resolved — the reviewer resolves them in the dashboard.`;
    // give a live session the grace window to claim the round before falling
    // back; resume the exact session under review, else newest, else fresh
    setTimeout(() => {
      if (agentRunning()) return;
      let claimed = false;
      try {
        for (const l of readFileSync(notesPath, "utf8").split("\n")) {
          if (!l.includes('"ack"')) continue;
          try {
            const rec: unknown = JSON.parse(l);
            if (isObj(rec) && rec.ack === submitTs) {
              claimed = true;
              break;
            }
          } catch {}
        }
      } catch {}
      if (claimed) return; // the live session took it
      // claim it ourselves so a slow live session doesn't deliver it twice —
      // a busy interactive session can ack long after the grace window
      appendNote({ ts: new Date().toISOString(), ack: submitTs, by: "server" });
      const cont = session ? ["-r", session] : liveSessions.size > 0 ? ["-c"] : [];
      const proc = Bun.spawn(["omp", "-p", ...cont, "--auto-approve", prompt], {
        cwd: repoRoot,
        stdout: Bun.file(join(notesDir, "agent.log")),
        stderr: "ignore",
        onExit: (_p, code) => {
          fixing = null;
          try {
            writeFileSync(agentPidPath, "");
          } catch {}
          appendNote({ ts: new Date().toISOString(), agent_done: true, code: code ?? -1 });
          broadcast("event: comments\ndata: 1\n\n");
        },
      });
      fixing = proc;
      try {
        writeFileSync(agentPidPath, String(proc.pid));
      } catch {}
      broadcast("event: comments\ndata: 1\n\n");
    }, CLAIM_GRACE_MS);
    broadcast("event: comments\ndata: 1\n\n");
    return Response.json({ ok: true });
  }

  function listComments(): Json {
    const { comments, submittedAt, roundPending } = foldComments();
    return {
      comments,
      submittedAt,
      investigating: investigating !== null,
      investigatingIds,
      fixing: agentRunning() || roundPending,
    };
  }

  async function addComment(req: Request): Promise<Response> {
    let b: unknown;
    try {
      b = await req.json();
    } catch {
      return new Response("bad json", { status: 400 });
    }
    if (!isObj(b)) return new Response("bad payload", { status: 400 });
    const body = str(b.body).trim();
    const replyTo = str(b.reply_to);
    const file = str(b.file);
    const line = typeof b.line === "number" && b.line > 0 ? Math.floor(b.line) : 0;
    const endLine = typeof b.end_line === "number" && b.end_line > line ? Math.floor(b.end_line) : 0;
    if (!body || (!replyTo && !file)) return new Response("missing body or file", { status: 400 });
    const id = (replyTo ? "rp_" : "c_") + Math.random().toString(16).slice(2, 8);
    const rec = replyTo
      ? { ts: new Date().toISOString(), id, author, reply_to: replyTo, body }
      : { ts: new Date().toISOString(), id, author, file, line,
          ...(endLine ? { end_line: endLine } : {}),
          ...(str(b.session) ? { session: str(b.session) } : {}), body };
    try {
      appendNote(rec);
    } catch {
      return new Response("journal write failed", { status: 500 });
    }
    maybeInvestigate(); // background context only — never edits before submit
    broadcast("event: comments\ndata: 1\n\n");
    return Response.json({ ok: true, id });
  }

  async function resolveComment(req: Request): Promise<Response> {
    let b: unknown;
    try {
      b = await req.json();
    } catch {
      return new Response("bad json", { status: 400 });
    }
    if (!isObj(b) || !str(b.id)) return new Response("missing id", { status: 400 });
    appendNote({ ts: new Date().toISOString(), author, resolve: str(b.id), resolved: b.resolved !== false });
    broadcast("event: comments\ndata: 1\n\n");
    return Response.json({ ok: true });
  }

  // watch the journal so agent replies (appended directly to notes.jsonl)
  // reach dashboards without any external tool in the loop
  let notesStamp = "";
  function pollNotes() {
    let s = "";
    try {
      const st = statSync(notesPath);
      s = st.size + ":" + st.mtimeMs;
    } catch {}
    if (s === notesStamp) return;
    const first = notesStamp === "";
    notesStamp = s;
    if (!first) broadcast("event: comments\ndata: 1\n\n");
  }

  function poll() {
    if (!existsSync(sessionsRoot)) return;
    let changed = false;
    for (const bucket of readdirSync(sessionsRoot)) {
      const dir = join(sessionsRoot, bucket);
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        continue;
      }
      for (const f of entries) {
        if (!f.endsWith(".jsonl")) continue;
        const p = join(dir, f);
        let size = -1, mtime = -1;
        try {
          const st = statSync(p);
          size = st.size;
          mtime = st.mtimeMs;
        } catch {
          continue;
        }
        const prev = watch.get(p);
        if (prev && prev.size === size && prev.mtime === mtime) continue;
        const belongs = prev?.belongs === false ? false : sniffBelongs(p);
        watch.set(p, { size, mtime, belongs });
        if (belongs !== true) continue;
        const s = parseSessionFile(p); // full reparse: idempotent, survives rewrites
        if (s) {
          liveSessions.set(p, s);
          changed = true;
        }
      }
    }
    if (changed) {
      version++;
      broadcast(`data: ${version}\n\n`);
    }
  }

  const server = Bun.serve({
    port,
    idleTimeout: 0, // SSE streams outlive Bun's 10s default
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/data") {
        const list = [...liveSessions.values()].filter((s) => s.touches.length > 0).sort((a, b) => a.ts - b.ts);
        return Response.json(buildSnapshot(list));
      }
      if (url.pathname === "/comments") return Response.json(listComments());
      if (url.pathname === "/comment" && req.method === "POST") return addComment(req);
      if (url.pathname === "/resolve" && req.method === "POST") return resolveComment(req);
      if (url.pathname === "/submit" && req.method === "POST") return submitReview(req);
      if (url.pathname === "/events") {
        let ctrl: ReadableStreamDefaultController<Uint8Array> | null = null;
        const stream = new ReadableStream<Uint8Array>({
          start(c) {
            ctrl = c;
            clients.add(c);
            c.enqueue(enc.encode("retry: 500\n\n")); // fast reconnect across self-reload
          },
          cancel() {
            if (ctrl) clients.delete(ctrl);
          },
        });
        return new Response(stream, {
          headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
        });
      }
      if (url.pathname === "/intuition/new") {
        // force a fresh instance: respond first, re-exec once the reply flushed
        setTimeout(() => restartSelf("fresh instance requested via /intuition/new"), 150);
        return new Response(RESTART_HTML, { headers: { "content-type": "text/html" } });
      }
      if (url.pathname === "/intuition") {
        return new Response(buildHtml(LIVE_BOOTSTRAP), { headers: { "content-type": "text/html" } });
      }
      if (url.pathname === "/") return Response.redirect("/intuition", 302);
      return new Response("not found \u2014 the report lives at /intuition", { status: 404 });
    },
  });

  /** Re-exec this script from disk; own session (setsid) so the replacement
   *  survives this process's controlling terminal/PTY. */
  function restartSelf(reason: string) {
    console.log(`intuition: ${reason} — restarting`);
    server.stop(true); // release the port before the replacement binds it
    const child = spawn(process.execPath, process.argv.slice(1), {
      detached: true,
      stdio: "inherit",
      env: { ...process.env, INTUITION_GUARD: String(guardPid) },
    });
    child.unref();
    process.exit(0);
  }

  // self-reload: re-exec when this script changes so a running live server
  // picks up edits to intuition itself (agent or human)
  const selfPath = import.meta.path;
  let selfMtime = statSync(selfPath).mtimeMs;
  function checkSelf() {
    let m;
    try {
      m = statSync(selfPath).mtimeMs;
    } catch {
      return; // mid-write/atomic rename; retry next tick
    }
    if (m === selfMtime) return;
    selfMtime = m;
    restartSelf("script changed");
  }

  // die with the launching session: watch the original parent pid (carried
  // across self-reloads via INTUITION_GUARD) and exit when it disappears
  let guardPid = Number(process.env.INTUITION_GUARD ?? "") || process.ppid;
  let guardSeen = false;
  function checkGuard() {
    if (guardPid <= 1) return;
    try {
      process.kill(guardPid, 0);
      guardSeen = true;
    } catch (err) {
      if (isObj(err) && err.code !== "ESRCH") return; // EPERM etc: pid alive
      if (!guardSeen) {
        guardPid = 0; // fire-and-forget launcher already gone at startup: no guard
        return;
      }
      console.log("intuition: launching session gone — shutting down");
      process.exit(0);
    }
  }
  poll();
  setInterval(() => { poll(); pollNotes(); checkSelf(); checkGuard(); }, 1500);
  setInterval(() => broadcast(": ping\n\n"), 15000);
  console.log(`intuition live: http://localhost:${port}/intuition`);
  console.log(`watching ${sessionsRoot} for cwd ${repoRoot}`);
}
