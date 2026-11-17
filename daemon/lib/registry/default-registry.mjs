// The registry the hub knows out of the box: the official plugin catalog and the key it is signed with. A hub whose
// config.json names no registry of its own uses this one, so a fresh install has a catalog without editing files
// (lib/plugins/sources.mjs: withDefaultRegistry). The key is pinned on first use like any other (lib/plugins/keys.mjs):
// a hub release that carries a different key here does not switch by itself — the human is asked to accept it.
export const DEFAULT_REGISTRY = Object.freeze({
  indexUrl: "https://github.com/KenseiTheOne/agent-hub-plugins/releases/download/index/index.json",
  publicKey: "untrusted comment: minisign public key D092435A6EE94FFB\nRWT7T+luWkOS0DbdL4deiUo4mdxsUHJDoSKj+dh/qnFYdI7U66dJUVub",
});
