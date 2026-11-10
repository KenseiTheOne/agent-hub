// The open.file primitive — open a file in the default app or show it in Finder (reveal).
// Only document types are opened (OPEN_EXT): `open` (LaunchServices) launches or mounts by extension —
// .command/.app/.tool, .pyw, .jnlp, .afploc/.smbloc, .term, .wflow, .sparsebundle and any types that
// third-party apps have registered — hence an allowlist, not a denylist. Likewise for directories: only a directory
// without an extension and without the "package" flag is opened in Finder. The extension is not trusted blindly: a Finder alias (`open` would open
// its target) and a file with its own app (OpenWith) are refused (platform.mjs launchRedirect). Files with the x bit, other
// types and package directories are allowed only with reveal=true — show in Finder without launching.
// In run() the type is checked once more — against the same realpath that goes to `open`: this narrows the window for swapping a link between
// the check and the launch, but does not close it — `open` takes a path, not a descriptor, and a swap a split second before its
// launch will get through. The primitive is meant for files that a foreign process does not swap (docs/api.md).

import { t } from "../i18n.mjs";
import { lstatSync, realpathSync, statSync } from "node:fs";
import { extname, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { launchRedirect, openCommand } from "../platform.mjs";

export const name = "open.file";
export const level = "immediate";
export const remoteAllowed = false;
export const safeUnderEstop = true;

export const argsSchema = {
  path: { type: "string", required: true, positional: true, maxLength: 4096 },
  reveal: { type: "boolean" },
};

// Document types open.file hands to the default app.
export const OPEN_EXT = new Set([
  ".txt", ".text", ".md", ".markdown", ".log", ".csv", ".tsv", ".json", ".jsonl", ".ndjson", ".yaml", ".yml", ".toml",
  ".diff", ".patch", ".rtf", ".html", ".htm", ".xml", ".svg",
  ".pdf", ".docx", ".xlsx", ".pptx", ".pages", ".numbers", ".key",
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tif", ".tiff", ".heic",
  ".mp3", ".wav", ".m4a", ".flac", ".ogg", ".aac", ".mp4", ".mov", ".mkv", ".webm", ".avi",
]);

// → null | the refusal reason (not reveal) for an already resolved realpath.
function typeProblem(real) {
  const st = statSync(real);
  const ext = extname(real).toLowerCase();
  if (st.isDirectory()) {
    // only an ordinary folder is opened in Finder: a directory with an extension (.app, .xpc, .sparsebundle, .playground and
    // any third-party app's package) would be launched, mounted or handed to an app by `open` — reveal only
    if (ext) return "bundle";
    return launchRedirect(real, { isDir: true });
  }
  if (!st.isFile()) return "not-a-file";
  if (st.mode & 0o111) return "executable";
  if (!OPEN_EXT.has(ext)) return "risky-type";
  return launchRedirect(real);
}

function resolvePath(p) {
  if (p.startsWith("~/")) p = homedir() + p.slice(1);
  return p;
}

export function verifyFacts(args) {
  const p = resolvePath(args.path);
  if (!isAbsolute(p)) return { ok: false, reason: "relative-path" };
  let real;
  try {
    lstatSync(p);
    real = realpathSync(p);
  } catch {
    return { ok: false, reason: "not-found" };
  }
  if (args.reveal) return { ok: true };
  const problem = typeProblem(real);
  return problem ? { ok: false, reason: problem } : { ok: true };
}

export function describe(args, facts, lang = "ru") {
  return { text: t(lang, args.reveal ? "prim.open.reveal" : "prim.open.file", { path: args.path }), cost: null };
}

export async function run(args, ctx) {
  const p = realpathSync(resolvePath(args.path));
  const reveal = Boolean(args.reveal);
  if (!reveal) {
    const problem = typeProblem(p);
    if (problem) return { ok: false, reason: problem };
  }
  const [file, ...argv] = openCommand(p, { reveal });
  const r = await ctx.exec(file, argv);
  return { ok: r.code === 0, code: r.code };
}
