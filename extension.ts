// intuition — keep the codebase touch dashboard alive and route submitted
// dashboard reviews into the working agent.
//
// turn_end: silently ensure `intuition.ts --live` is serving this repo
// (per-repo port). No status line, no auto-open — `/intuition` opens it.
// While a session runs, watch <repo>/.intuition/notes.jsonl for SUBMITTED
// review rounds and wake the agent to address them. Comments alone never
// wake the agent — nothing edits until the reviewer submits. The extension
// acks the round in the journal so the intuition server skips its headless
// fallback agent (omp -p -r <session>).
//
// Remove this file to uninstall. Override the script location with
// INTUITION_SCRIPT.

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SCRIPT = process.env.INTUITION_SCRIPT ?? join(homedir(), "code/intuition/intuition.ts");

/** Stable per-repo port (FNV-1a over cwd), so parallel repos get their own dashboards. */
function portFor(cwd: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < cwd.length; i++) {
    h ^= cwd.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return 4700 + (h % 300);
}

/** Which repo (if any) an intuition server on this port is serving. */
async function repoServedAt(port: number): Promise<string | null> {
  try {
    const r = await fetch(`http://localhost:${port}/data`, { signal: AbortSignal.timeout(600) });
    const j: unknown = await r.json();
    if (j && typeof j === "object" && "repo" in j && typeof j.repo === "string") return j.repo;
  } catch {}
  return null;
}

/** Ensure a live server for repo; returns the port serving it, or null. */
async function ensureServer(repo: string): Promise<number | null> {
  if (!existsSync(SCRIPT)) return null;
  let port = portFor(repo);
  for (let attempt = 0; attempt < 5; attempt++, port++) {
    const served = await repoServedAt(port);
    if (served === repo) return port;
    if (served !== null) continue; // another repo's dashboard owns this port
    const child = spawn("bun", [SCRIPT, repo, "--live", "--port", String(port)], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    for (let tick = 0; tick < 20; tick++) {
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, 150);
      await promise;
      if ((await repoServedAt(port)) === repo) return port;
    }
    return null; // spawned but never ready (port race?) — don't cascade
  }
  return null;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

interface Round {
  submitTs: string;
  session: string;
  comments: Array<{ id: string; where: string; body: string }>;
}

/** Submitted-but-unacked review rounds from the repo journal. */
function pendingRounds(repo: string): Round[] {
  const notesPath = join(repo, ".intuition", "notes.jsonl");
  let text = "";
  try {
    text = readFileSync(notesPath, "utf8");
  } catch {
    return [];
  }
  const byId = new Map<string, { where: string; body: string; resolved: boolean; replied: boolean }>();
  const submits: Array<{ ts: string; session: string; ids: string[] }> = [];
  const acked = new Set<string>();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let rec: unknown;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObj(rec)) continue;
    if (typeof rec.ack === "string") {
      acked.add(rec.ack);
    } else if (rec.submit === true && typeof rec.ts === "string") {
      submits.push({
        ts: rec.ts,
        session: typeof rec.session === "string" ? rec.session : "",
        ids: Array.isArray(rec.comments) ? rec.comments.filter((x): x is string => typeof x === "string") : [],
      });
    } else if (typeof rec.resolve === "string") {
      const c = byId.get(rec.resolve);
      if (c) c.resolved = rec.resolved !== false;
    } else if (typeof rec.reply_to === "string") {
      if (rec.note !== true) { // investigator notes don't answer a comment
        const c = byId.get(rec.reply_to);
        if (c) c.replied = true;
      }
    } else if (typeof rec.id === "string" && typeof rec.file === "string" && typeof rec.body === "string") {
      const line0 = typeof rec.line === "number" && rec.line > 0 ? rec.line : 0;
      const end = typeof rec.end_line === "number" && rec.end_line > line0 ? rec.end_line : 0;
      const where = rec.file + (line0 ? ":" + line0 + (end ? "-" + end : "") : "");
      byId.set(rec.id, { where, body: rec.body, resolved: false, replied: false });
    }
  }
  const out: Round[] = [];
  for (const s of submits) {
    if (acked.has(s.ts)) continue;
    const open = s.ids
      .map((id) => ({ id, c: byId.get(id) }))
      .filter((x): x is { id: string; c: NonNullable<typeof x.c> } => !!x.c && !x.c.resolved && !x.c.replied)
      .map(({ id, c }) => ({ id, where: c.where, body: c.body }));
    if (open.length) out.push({ submitTs: s.ts, session: s.session, comments: open });
  }
  return out;
}

export default function intuition(pi: ExtensionAPI): void {
  const ensure = async (cwd: string): Promise<number | null> => {
    let repo = cwd;
    try {
      repo = realpathSync(cwd);
    } catch {}
    return ensureServer(repo);
  };

  // keep the dashboard warm after every turn; never open or announce it
  pi.on("turn_end", async (_event, ctx) => {
    await ensure(ctx.cwd);
  });

  pi.registerCommand("intuition", {
    description: "Open the intuition live dashboard for this repo",
    handler: async (_args, ctx) => {
      const port = await ensure(process.cwd());
      if (port === null || !(ctx.hasUI ?? true)) return;
      const opener = process.platform === "darwin" ? "open" : "xdg-open";
      spawn(opener, [`http://localhost:${port}/intuition`], { detached: true, stdio: "ignore" }).unref();
    },
  });

  // feedback loop: a SUBMITTED review round wakes the agent (idle → new
  // prompt; mid-run → queued steer). Individual comments never do — the
  // reviewer submits when the round is ready. Ack in the journal so the
  // intuition server skips its headless fallback agent.
  pi.on("session_start", async (_event, ctx) => {
    ctx.setInterval(async () => {
      let repo = ctx.cwd;
      try {
        repo = realpathSync(ctx.cwd);
      } catch {}
      for (const round of pendingRounds(repo)) {
        try {
          appendFileSync(
            join(repo, ".intuition", "notes.jsonl"),
            JSON.stringify({ ts: new Date().toISOString(), ack: round.submitTs, by: "session" }) + "\n",
          );
        } catch {
          continue; // can't claim the round; leave it for the server's fallback agent
        }
        const lines = round.comments.map((c) => `- [${c.id}] ${c.where} — ${c.body}`);
        pi.sendUserMessage(
          "A review was submitted via the intuition dashboard:\n" + lines.join("\n") +
            "\n\nAddress each comment: make the change, or explain why not. After each one, record" +
            " a reply by appending ONE line to .intuition/notes.jsonl:\n" +
            '  {"ts":"<iso timestamp>","reply_to":"<comment id>","author":"agent","body":"<what you did>"}\n' +
            "Never mark comments resolved — the reviewer resolves them in the dashboard.",
        );
      }
    }, 5_000);
  });
}
