// When the daemon last received a hook event — the only thing the hub knows about whether the Claude Code hook is
// installed. The hub reads nothing of Claude Code's own settings or plugin list (docs/hook.md: the user installs the
// hook, the hub does not touch ~/.claude), so /state.hook is built from the events themselves:
//
//   { installed: true,  lastEventAt: "<ISO>", installCommand }                    a verified hook event reached this hub
//                                                                                 (at lastEventAt)
//   { installed: false, lastEventAt: null, reason: "no-events", installCommand }  none ever did: not installed, not
//                                                                                 recognised by the daemon
//                                                                                 (peer.hookPaths), or no Claude Code
//                                                                                 session has run since the hub was set
//                                                                                 up — the hub cannot tell which
//
// reason is a code; "no-events" is the only one so far (docs/api.md lists them). installCommand — what the user runs to
// install the hook for good (HOOK_INSTALL_COMMAND): the shell shows it instead of keeping its own copy.
//
// The time survives a daemon restart in <home>/hook-seen.json ({version: 1, lastEventAt}; 0600, atomic). Hook events
// come with every tool call, so the file is written at most once per minWriteMs (a trailing write picks up the last
// event) and on a regular stop. A file that cannot be read counts as "no events yet" and is replaced by the next write.

import { readJsonFile, writeJsonAtomic } from "../statefile.mjs";

export const HOOK_SEEN_FILE = "hook-seen.json";
// The permanent install of claude-plugin/README.md: the hub's repository is a Claude Code marketplace, the hook is its
// plugin (the test state-hook-limits compares this line with the README).
export const HOOK_INSTALL_COMMAND = "claude plugin marketplace add KenseiTheOne/agent-hub && claude plugin install agent-hub@agent-hub";
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

export class HookSeen {
  constructor(path, { minWriteMs = 60_000, now = () => Date.now() } = {}) {
    this.path = path;
    this.minWriteMs = minWriteMs;
    this.now = now;
    this.lastEventAt = null; // ISO string
    this.writtenAt = 0;
    this.dirty = false;
    this.timer = null;
  }

  // Read the saved time once at start. Never throws.
  load() {
    try {
      const v = readJsonFile(this.path);
      if (typeof v?.lastEventAt === "string" && ISO_RE.test(v.lastEventAt) && Number.isFinite(Date.parse(v.lastEventAt))) this.lastEventAt = v.lastEventAt;
    } catch {}
    return this;
  }

  // A verified hook event arrived.
  note() {
    const now = this.now();
    this.lastEventAt = new Date(now).toISOString();
    this.dirty = true;
    if (this.timer) return;
    const wait = this.writtenAt + this.minWriteMs - now;
    if (wait <= 0) return this.flush();
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, wait);
    this.timer.unref?.();
  }

  // Write what is not on disk yet (the trailing timer, a regular stop). Never throws.
  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    if (!this.dirty) return;
    this.dirty = false;
    this.writtenAt = this.now();
    try {
      writeJsonAtomic(this.path, { version: 1, lastEventAt: this.lastEventAt }, { mode: 0o600 });
    } catch {}
  }

  // The /state.hook section.
  info() {
    return this.lastEventAt
      ? { installed: true, lastEventAt: this.lastEventAt, installCommand: HOOK_INSTALL_COMMAND }
      : { installed: false, lastEventAt: null, reason: "no-events", installCommand: HOOK_INSTALL_COMMAND };
  }
}
