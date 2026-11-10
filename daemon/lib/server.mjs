// HTTP/1.1 on a Unix socket only: <home>/hub.sock (0600) in the <home> directory (0700). No TCP at all.
//
// Built-in routes: GET /state, GET /events (SSE), POST /actions/:id, POST /hook, POST /estop,
// GET /journal, GET /health, GET /peer, POST /plugins/:id/refresh, GET /settings, PUT /settings/lang,
// PUT /settings/plugin-updates, PUT /settings/hub-updates, PUT /settings/launch-at-login, PUT /settings/notifications,
// POST /shutdown. Additional ones — from lib/routes/*.mjs.
// The Host header must be a plain name (`hub`): Node answers 400 to a socket path in Host.
// The peer class is determined once per connection (lib/peer.mjs) and checked on every route.
// Exception — processes from AgentHub.app: when requirements.app changes (build re-pin, lib/app-pin.mjs) —
// their connections are closed (SSE too), and a request on a connection with a stale generation is classified again.

import { createServer } from "node:http";
import { connect } from "node:net";
import { chmodSync, existsSync, lstatSync, mkdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { DAEMON_DIR } from "./config.mjs";
import { loadModules } from "./loader.mjs";
import { makeCtx } from "./ctx.mjs";
import { CONTRACT_VERSION } from "./meta.mjs";
import { PEER_CLASSES } from "./peer.mjs";
import { myUid, transportProblem, usesFileModes } from "./platform.mjs";
import { msg } from "./i18n.mjs";

const DEFAULT_MAX_BODY = 64 * 1024;
const HOOK_MAX_BODY = 1024 * 1024;

function compilePath(path) {
  const names = [];
  const re = new RegExp(
    "^" +
      path.replace(/[.+*?^${}()|[\]\\]/g, "\\$&").replace(/\/:([A-Za-z_]\w*)/g, (_m, n) => {
        names.push(n);
        return "/([^/]+)";
      }) +
      "$",
  );
  return { re, names };
}

export function json(res, status, body) {
  const s = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(s), "cache-control": "no-store" });
  res.end(s);
}

function readBody(req, max) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (b) => {
      size += b.length;
      if (size > max) {
        reject(Object.assign(new Error("too-large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(b);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// Built-in routes (in the same format as extensions).
function builtinRoutes(core) {
  return [
    {
      method: "GET",
      path: "/health",
      peers: ["app", "cli", "hook", "bridge"],
      handler: () => ({ status: 200, body: { ok: true, pid: process.pid, uptimeMs: Date.now() - core.startedAt, contract: CONTRACT_VERSION } }),
    },
    {
      method: "GET",
      path: "/peer",
      peers: ["app", "cli", "hook", "bridge"],
      handler: ({ peer }) => ({ status: 200, body: { class: peer.class, reason: peer.reason || null, pid: peer.pid ?? null } }),
    },
    {
      method: "GET",
      path: "/state",
      peers: ["app", "cli"],
      handler: ({ peer }) => ({ status: 200, body: core.snapshot(peer) }),
    },
    {
      method: "GET",
      path: "/events",
      peers: ["app", "cli"],
      raw: true,
      handler: ({ req, res, peer }) => {
        if (peer.class === "app") core.appPeerStream?.(req.socket);
        return sse(core, req, res, peer, core.config.sse || {});
      },
    },
    {
      method: "GET",
      path: "/journal",
      peers: ["app", "cli"],
      handler: ({ query }) => {
        const n = Math.min(Math.max(parseInt(query.get("limit") || "100", 10) || 100, 1), 1000);
        return { status: 200, body: { entries: core.journal.tail(n) } };
      },
    },
    {
      method: "POST",
      path: "/actions/:id",
      peers: ["app", "cli"],
      handler: async ({ params, body, peer }) => {
        const b = body && typeof body === "object" ? body : {};
        return core.invoke({ id: params.id, args: b.args, confirmToken: typeof b.confirmToken === "string" ? b.confirmToken : null, peer });
      },
    },
    {
      method: "POST",
      path: "/estop",
      peers: ["app", "cli"],
      handler: ({ body, peer }) => {
        const on = body?.on;
        if (typeof on !== "boolean") return { status: 400, body: { error: "args:on:type" } };
        if (!on && peer.class !== "app") return { status: 403, body: { error: peer.reason && peer.reason !== "peer:no-claude-ancestor" ? peer.reason : `peer:${peer.class}` } };
        return { status: 200, body: { estop: core.setEstop(on, peer) } };
      },
    },
    {
      // Hub language: "system" | "ru" | "en". Read by app and cli (/state.lang), written only by app.
      method: "GET",
      path: "/settings",
      peers: ["app", "cli"],
      handler: () => ({ status: 200, body: { lang: core.langInfo(), checkPluginUpdates: core.pluginUpdatesSetting(), checkHubUpdates: core.hubUpdatesSetting(), launchAtLogin: core.launchAtLoginSetting(), notifications: core.notificationsSetting() } }),
    },
    {
      // "Notifications": {enabled?, kinds?: {<kind>: bool}, quiet?: {enabled?, start?, end?}} — a partial edit
      // (lib/push/prefs.mjs applyPatch). Written only by app — the pinned build: neither an agent from cli nor an unpinned copy
      // can turn notifications off (including those about itself). Security exceptions cannot be turned off here.
      method: "PUT",
      path: "/settings/notifications",
      peers: ["app"],
      handler: ({ body, peer }) => {
        const r = core.setNotifications(body, peer);
        if (r.error) return { status: 400, body: { error: r.error } };
        return { status: 200, body: r };
      },
    },
    {
      // "Launch at login": {enabled: bool} — the daemon + app pair (decision 2026-11-07). Written only by app.
      // Off — a daemon started at login (RunAtLoad) waits for the app for services.app.loginGraceMs
      // and exits normally with code 0; an app opened by hand starts the daemon itself (launchctl kickstart).
      method: "PUT",
      path: "/settings/launch-at-login",
      peers: ["app"],
      handler: ({ body, peer }) => {
        const v = body?.enabled;
        if (typeof v !== "boolean") return { status: 400, body: { error: "args:enabled:type" } };
        return { status: 200, body: { launchAtLogin: core.setLaunchAtLogin(v, peer) } };
      },
    },
    {
      // "Check for hub updates": {enabled: bool}. Written only by app; services.hubUpdate.checkUpdates = false
      // in config.json overrides this setting (docs/hub-updates.md).
      method: "PUT",
      path: "/settings/hub-updates",
      peers: ["app"],
      handler: ({ body, peer }) => {
        const v = body?.enabled;
        if (typeof v !== "boolean") return { status: 400, body: { error: "args:enabled:type" } };
        core.setCheckHubUpdates(v, peer);
        return { status: 200, body: { checkHubUpdates: core.hubUpdatesSetting(), hubUpdate: core.facts.get("hub.update") ?? null } };
      },
    },
    {
      // "Check for plugin updates": {enabled: bool}. Written only by app; services.plugins.checkUpdates = false
      // in config.json disables the check regardless of this setting.
      method: "PUT",
      path: "/settings/plugin-updates",
      peers: ["app"],
      handler: ({ body, peer }) => {
        const v = body?.enabled;
        if (typeof v !== "boolean") return { status: 400, body: { error: "args:enabled:type" } };
        core.setCheckPluginUpdates(v, peer);
        return { status: 200, body: { checkPluginUpdates: core.pluginUpdatesSetting(), pluginUpdates: core.facts.get("plugins.updates") ?? null } };
      },
    },
    {
      method: "PUT",
      path: "/settings/lang",
      peers: ["app"],
      handler: ({ body, peer }) => {
        const v = body?.lang;
        if (!["system", "ru", "en"].includes(v)) return { status: 400, body: { error: "args:lang:enum" } };
        return { status: 200, body: { lang: core.setLang(v, peer) } };
      },
    },
    {
      // The app is quitting ("Quit Agent Hub", ⌘Q, logout) and asks the daemon to exit normally:
      // the 202 response goes out before the stop, then the same stop as on SIGTERM, with exit code 0 (launchd with
      // KeepAlive.SuccessfulExit=false does not restart after such an exit). Only app: cli and others get 403.
      method: "POST",
      path: "/shutdown",
      peers: ["app"],
      handler: ({ res, peer }) => {
        core.markShutdown(peer);
        res.once("finish", () => setImmediate(() => core.runShutdown("shutdown")));
        json(res, 202, { ok: true, stopping: true });
      },
    },
    {
      method: "POST",
      path: "/plugins/:id/refresh",
      peers: ["app", "cli"],
      handler: ({ params }) => (core.host.refresh(params.id, "Manual") ? { status: 202, body: { ok: true } } : { status: 404, body: { error: "not-found" } }),
    },
    {
      method: "POST",
      path: "/hook",
      peers: ["hook"],
      maxBody: HOOK_MAX_BODY,
      handler: async ({ req, res, body, peer }) => {
        if (!body || typeof body !== "object") return { status: 400, body: { error: "body" } };
        const v = core.peer.verifyHookSession(peer, body.session_id);
        if (!v.ok) {
          core.journal.write({ type: "hook-denied", claudePid: peer.claudePid, error: v.reason });
          return { status: 403, body: { error: v.reason } };
        }
        // The hook closed the connection before the response (Claude killed agenthub-hook) → signal for the handlers.
        const ac = new AbortController();
        const gone = () => {
          if (!res.writableEnded) ac.abort();
        };
        req.socket.once("close", gone);
        res.once("close", gone);
        try {
          return { status: 200, body: await core.handleHook(body, peer, { signal: ac.signal }) };
        } finally {
          req.socket.off("close", gone);
          res.off("close", gone);
        }
      },
    },
  ];
}

// hook.* events carry requestId — the key for answering a card. Only the app sees them.
export function sseVisible(ev, peer) {
  return peer?.class === "app" || !String(ev?.type || "").startsWith("hook.");
}

// Per-subscriber buffer limit: the client stopped reading (SIGSTOP, a stuck pipe) — we drop the connection,
// it reconnects with Last-Event-ID and gets a snapshot. Without a limit Node would pile frames up in daemon memory.
export const SSE_MAX_BUFFER = 1024 * 1024;
export const SSE_MAX_STALL_MS = 60_000;

function sse(core, req, res, peer, { maxBuffer = SSE_MAX_BUFFER, maxStallMs = SSE_MAX_STALL_MS, graceMs = 2000 } = {}) {
  // The client may have closed the connection while the server was classifying the peer (codesign — hundreds of ms): the close events
  // on req and res have already fired by then, and the subscription below would never be removed.
  if (req.destroyed || res.destroyed || req.socket?.destroyed) return;
  res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive" });
  // Disconnect only if the client really is not reading: the buffer does not drain for graceMs while larger than
  // maxBuffer, or does not drain at all for maxStallMs. A large snapshot does not hurt a client that reads.
  let stalledSince = 0;
  let checkTimer = null;
  const check = () => {
    checkTimer = null;
    if (!stalledSince || res.destroyed) return;
    const stalled = Date.now() - stalledSince;
    if ((res.writableLength > maxBuffer && stalled >= graceMs) || stalled >= maxStallMs) {
      core.journal.write({ type: "sse-drop", peer: peer?.class, pid: peer?.pid, buffered: res.writableLength });
      res.destroy();
      return;
    }
    checkTimer = setTimeout(check, Math.min(graceMs, maxStallMs));
    checkTimer.unref?.();
  };
  const push = (chunk) => {
    if (res.destroyed || res.writableEnded) return;
    const ok = res.write(chunk);
    if (!ok && !stalledSince) {
      stalledSince = Date.now();
      if (!checkTimer) {
        checkTimer = setTimeout(check, Math.min(graceMs, maxStallMs));
        checkTimer.unref?.();
      }
    }
  };
  res.on("drain", () => {
    stalledSince = 0;
  });
  const write = (ev) => {
    if (!sseVisible(ev, peer)) return;
    push(`id: ${ev.id}\nevent: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
  };
  const last = parseInt(req.headers["last-event-id"] || "", 10);
  const replay = Number.isInteger(last) ? core.eventsSince(last) : null;
  if (replay) for (const ev of replay) write(ev);
  else write({ id: core.seq, type: "snapshot", ts: new Date().toISOString(), state: core.snapshot(peer) });
  const onEvent = (ev) => write(ev);
  core.on("event", onEvent);
  const ping = setInterval(() => push(": ping\n\n"), 15_000);
  ping.unref();
  // open streams — for the app service ("Launch at login" off: the daemon does not exit while the hub is in use)
  core.sseStreams = (core.sseStreams || 0) + 1;
  let counted = true;
  const close = () => {
    if (counted) {
      counted = false;
      core.sseStreams = Math.max(0, (core.sseStreams || 0) - 1);
    }
    clearInterval(ping);
    clearTimeout(checkTimer);
    core.off("event", onEvent);
  };
  req.on("close", close);
  res.on("close", close);
}

export function denyCode(peer) {
  if (peer.class === "foreign") return "peer:uid";
  if (peer.reason === "peer:no-claude-ancestor") return peer.reason;
  return `peer:${peer.class}`;
}

export async function loadRoutes(core, dir = join(DAEMON_DIR, "lib", "routes")) {
  const routes = builtinRoutes(core);
  const taken = new Set(routes.map((r) => `${r.method} ${r.path}`));
  const mods = await loadModules(dir, { onError: (f, e) => core.journal.write({ type: "load-error", kind: "route", file: f, detail: e.message }) });
  for (const { name, mod } of mods) {
    for (const r of mod.routes || []) {
      const key = `${r.method} ${r.path}`;
      const bad =
        !["GET", "POST", "PUT", "DELETE"].includes(r.method) ||
        typeof r.path !== "string" ||
        !r.path.startsWith("/") ||
        typeof r.handler !== "function" ||
        !Array.isArray(r.peers) ||
        !r.peers.length ||
        r.peers.some((p) => !PEER_CLASSES.includes(p));
      if (bad || taken.has(key)) {
        core.journal.write({ type: "load-error", kind: "route", file: name, detail: bad ? `bad route ${key}` : `duplicate ${key}` });
        continue;
      }
      taken.add(key);
      routes.push({ ...r, ext: name, ctx: makeCtx(core, `route:${name}`) });
    }
  }
  return routes.map((r) => ({ ...r, ...compilePath(r.path) }));
}

// Prepares the 0700 directory and removes a stale socket. A live foreign socket is an error.
// On Windows (named pipe) there are no file modes: the directory is created, access to the pipe is decided by its ACL.
async function prepareSocket(path, home) {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  if (!usesFileModes()) return;
  const st = statSync(home);
  if (st.uid !== myUid()) throw new Error(msg("err.otherOwner", { path: home }));
  chmodSync(home, 0o700);
  if (existsSync(path)) {
    const l = lstatSync(path);
    if (!l.isSocket()) throw new Error(msg("err.socket.notSocket", { path }));
    const alive = await new Promise((res) => {
      const c = connect(path);
      c.once("connect", () => {
        c.destroy();
        res(true);
      });
      c.once("error", () => res(false));
    });
    if (alive) throw new Error(msg("err.socket.busy", { path }));
    unlinkSync(path);
  }
}

export async function startServer(core) {
  const { socket: sockPath, home } = core.config.paths;
  const problem = transportProblem(sockPath);
  if (problem) throw new Error(problem);
  await prepareSocket(sockPath, home);
  const routes = await loadRoutes(core);
  const peers = new WeakMap();
  const appSockets = new Set(); // connections of processes from AgentHub.app (app and those rejected by signature)
  const isAppCandidate = (p) => p && p.appGen !== undefined;
  const track = (socket, p) => {
    p.then((r) => {
      if (isAppCandidate(r) && !socket.destroyed) appSockets.add(socket);
      // a connection of the pinned app — for supervision (the app service): the last one is gone and no process — it crashed.
      // A diagnostic launch (--probe-peer, snapshots, self-checks) exits on its own — its exit is not a crash
      if (r?.class === "app" && !r.diagnostic && !socket.destroyed) core.appPeerUp?.(socket, r);
    }, () => {});
  };
  const onPinChanged = () => {
    for (const s of appSockets) s.destroy();
    appSockets.clear();
  };
  core.on("app-pin.changed", onPinChanged);

  const server = createServer({ requestTimeout: 30_000, headersTimeout: 10_000 }, async (req, res) => {
    let peer;
    try {
      peer = await peers.get(req.socket);
    } catch {}
    peer = peer || { class: "cli", reason: "peer:unknown" };
    if (isAppCandidate(peer)) {
      // This very request may be the first to notice the change: onPinChanged will close all connections from AgentHub.app —
      // except this one, which we reclassify below and answer (otherwise the client would get ECONNRESET instead of 428/403).
      const tracked = appSockets.delete(req.socket);
      try {
        core.appPin?.check("request");
      } catch {}
      if (tracked && peer.appGen === core.peer.appGeneration?.() && !req.socket.destroyed) appSockets.add(req.socket);
      if (peer.appGen !== core.peer.appGeneration?.()) {
        const p = core.peer.classify(req.socket).catch(() => ({ class: "cli", reason: "peer:error" }));
        peers.set(req.socket, p);
        track(req.socket, p);
        peer = (await p) || { class: "cli", reason: "peer:unknown" };
      }
    }
    try {
      const url = new URL(req.url, "http://hub");
      const candidates = routes.filter((r) => r.re.test(url.pathname));
      if (!candidates.length) return json(res, 404, { error: "not-found" });
      const route = candidates.find((r) => r.method === req.method);
      if (!route) return json(res, 405, { error: "method" });
      if (!route.peers.includes(peer.class)) {
        core.journal.write({ type: "denied", route: `${route.method} ${route.path}`, peer: peer.class, pid: peer.pid, error: denyCode(peer) });
        return json(res, 403, { error: denyCode(peer), peer: peer.class });
      }
      // A diagnostic shell launch (snapshots, self-checks — peer.diagnostic) only reads: any process with the pinned
      // binary's keys can start it. It must not change anything; a route with diagnostic: "preview" itself
      // answers it with a window without installing (a consent window snapshot).
      if (peer.diagnostic && req.method !== "GET" && route.diagnostic !== "preview") {
        core.journal.write({ type: "denied", route: `${route.method} ${route.path}`, peer: peer.class, pid: peer.pid, error: "peer:diagnostic" });
        return json(res, 403, { error: "peer:diagnostic", peer: peer.class });
      }
      const m = route.re.exec(url.pathname);
      const params = {};
      route.names.forEach((n, i) => (params[n] = decodeURIComponent(m[i + 1])));
      let body;
      if (req.method !== "GET" && !route.raw) {
        const text = await readBody(req, route.maxBody || DEFAULT_MAX_BODY);
        if (text) {
          try {
            body = JSON.parse(text);
          } catch {
            return json(res, 400, { error: "json" });
          }
        }
      }
      const out = await route.handler({ req, res, params, query: url.searchParams, body, peer: { ...peer }, ctx: route.ctx || null });
      if (route.raw || res.headersSent) return;
      if (!out) return json(res, 204, {});
      json(res, out.status || 200, out.body ?? {});
    } catch (e) {
      if (res.headersSent) return res.end();
      json(res, e.status || 500, { error: e.status === 413 ? "too-large" : "internal" });
    }
  });
  server.timeout = 0;
  server.keepAliveTimeout = 5000;
  server.on("connection", (socket) => {
    // fd is read synchronously on accept, while the connection is surely alive
    const p = core.peer.classify(socket).catch(() => ({ class: "cli", reason: "peer:error" }));
    peers.set(socket, p);
    track(socket, p);
    socket.once("close", () => {
      appSockets.delete(socket);
      core.appPeerDown?.(socket);
    });
  });

  const oldMask = process.umask(0o177);
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(sockPath, () => {
        server.off("error", reject);
        resolve();
      });
    });
  } finally {
    process.umask(oldMask);
  }
  if (usesFileModes()) chmodSync(sockPath, 0o600);
  return {
    server,
    close: () =>
      new Promise((res) => {
        core.off("app-pin.changed", onPinChanged);
        server.close(() => res());
        server.closeAllConnections?.();
        if (usesFileModes()) {
          try {
            unlinkSync(sockPath);
          } catch {}
        }
      }),
  };
}
