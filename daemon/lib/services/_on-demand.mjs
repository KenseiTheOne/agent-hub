// Polling on demand, for services that fetch a file for plugins from the network (usage, models): the service keeps
// giving the file's path (ctx.providePluginEnv), but polls only while some running trusted plugin declares reading or
// watching it (ctx.pluginEnvWanted — $NAME in <agenthub.fsRead>, <agenthub.watch> or <agenthub.fsWrite>). Nobody reads it —
// no requests: the plugins that read it are not installed, turned off, or held back by a missing requirement.
//
// The service gives start(): first poll after firstDelay() (honors a fresh cache and a backoff in progress), and stop().
// Always on: config → services.<name>.onDemand = false, or a context without ctx.pluginEnvWanted (an older core, unit checks).

export class OnDemand {
  // svc — { ctx, cfg, schedule(ms), firstDelay(), timer }; envName — the variable; journalType — "<name>-demand".
  constructor(svc, envName, journalType) {
    this.svc = svc;
    this.envName = envName;
    this.journalType = journalType;
    this.enabled = svc.cfg.onDemand !== false && typeof svc.ctx.pluginEnvWanted === "function";
    // null — not decided yet (always on when not enabled)
    this.wanted = this.enabled ? null : true;
    this.listener = () => this.check();
  }
  // Whether the service may poll now.
  get active() {
    return this.wanted === true;
  }
  start() {
    if (!this.enabled) return this.svc.schedule(this.svc.firstDelay());
    this.svc.ctx.on("plugins.running", this.listener);
    this.check();
  }
  check() {
    if (this.svc.stopped) return;
    const want = Boolean(this.svc.ctx.pluginEnvWanted(this.envName));
    if (want === this.wanted) return;
    const first = this.wanted === null;
    this.wanted = want;
    if (want) this.svc.schedule(this.svc.firstDelay());
    else {
      clearTimeout(this.svc.timer);
      this.svc.timer = null;
    }
    // the journal says when polling starts and stops; the first "nobody reads it" at start is said too
    if (!first || !want) this.svc.ctx.journal.write({ type: this.journalType, polling: want });
  }
  stop() {
    if (this.enabled) this.svc.ctx.off?.("plugins.running", this.listener);
  }
}
