// Sample background service (files starting with `_` are not loaded). Contract: docs/extension-points.md.
// Copy it to lib/services/<name>.mjs without the underscore.

export const name = "example";
let timer = null;
let off = null;

export async function start(ctx) {
  const onPlugin = (ev) => {
    if (ev.plugin?.status === "block") ctx.emit({ type: "example.noticed", plugin: ev.plugin.id });
  };
  ctx.on("plugin", onPlugin);
  off = () => ctx.off("plugin", onPlugin);
  timer = setInterval(() => {}, 60_000);
  timer.unref();
}

export async function stop() {
  clearInterval(timer);
  off?.();
}
