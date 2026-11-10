// Daemon shutdown: one sequence for SIGTERM/SIGINT and POST /shutdown (bin/agenthubd, tests).
//
// 1. core.stopping = true: app supervision (the app service) no longer intervenes, since the app's connections
//    are about to close and that is not a crash.
// 2. Server: stops accepting connections, closes open ones and removes the socket. A pending PermissionRequest hook
//    loses its connection: agenthub-hook prints {} and exits with code 0, and Claude Code shows the regular dialog
//    in the terminal. New hooks no longer see the socket, with the same result right away ("daemon not running").
// 3. Core: plugins, services (the hook service removes cards via service-stop), watchers; a stop journal entry.

export async function stopHub({ srv, core, reason = null }) {
  core.stopping = true;
  // hub-update service: this is a shutdown, not its own restart into a new version, so do not switch
  if (reason !== "update") core.shuttingDown = true;
  try {
    await srv?.close();
  } catch {}
  await core.stop({ reason });
}
