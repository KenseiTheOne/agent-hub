// The hub's Telegram bot: outgoing sendMessage only, metadata only, no buttons and no incoming commands.
//
// The token and chat_id live in the login keychain as two entries with the same service:
//   security add-generic-password -s agent-hub.telegram -a token   -T /usr/bin/security -w
//   security add-generic-password -s agent-hub.telegram -a chat_id -T /usr/bin/security -w <chat_id>
// The user creates the entries (the bot via BotFather). The daemon only reads them with
// `security find-generic-password -s agent-hub.telegram -a <account> -w`.
//
// Secret values never reach the journal, errors or results: only reason codes go out
// (`disabled`, `no-credentials`, `bad-credentials`, `http-<code>`, `rate-limited`, `network`, `timeout`).

export const SECURITY = "/usr/bin/security";
export const DEFAULT_SERVICE = "agent-hub.telegram";
export const API_BASE = "https://api.telegram.org";
export const MAX_TEXT = 3500; // Telegram's limit is 4096 characters

const TOKEN_RE = /^\d{5,16}:[\w-]{30,64}$/;
const CHAT_RE = /^(-?\d{1,20}|@[A-Za-z]\w{3,63})$/;

export function validToken(s) {
  return TOKEN_RE.test(s);
}
export function validChatId(s) {
  return CHAT_RE.test(s);
}

// exec: ctx.exec (or a test double); fetchImpl: fetch (or a test double). With enabled=false the module reads
// nothing and makes no requests.
export function createTelegram({
  exec,
  fetchImpl = globalThis.fetch,
  enabled = false,
  service = DEFAULT_SERVICE,
  timeoutMs = 10_000,
  cacheMs = 10 * 60_000,
  now = Date.now,
}) {
  let creds = null; // { token, chatId } | null
  let checkedAt = -Infinity;

  async function readItem(account) {
    try {
      const r = await exec(SECURITY, ["find-generic-password", "-s", service, "-a", account, "-w"], { timeoutMs: 5000 });
      if (r.code !== 0) return null;
      const v = String(r.stdout ?? "").trim();
      return v || null;
    } catch {
      return null;
    }
  }

  async function credentials() {
    if (!enabled) return null;
    const t = now();
    if (t - checkedAt < cacheMs) return creds;
    checkedAt = t;
    const token = await readItem("token");
    const chatId = await readItem("chat_id");
    creds = token && chatId && validToken(token) && validChatId(chatId) ? { token, chatId } : null;
    return creds;
  }

  function forget() {
    creds = null;
    checkedAt = -Infinity;
  }

  return {
    // Whether the settings are usable (enabled and the keychain entries exist).
    async available() {
      return Boolean(await credentials());
    },
    async send(text, { silent = false } = {}) {
      if (!enabled) return { ok: false, reason: "disabled" };
      const c = await credentials();
      if (!c) return { ok: false, reason: "no-credentials" };
      if (typeof fetchImpl !== "function") return { ok: false, reason: "network" };
      const payload = {
        chat_id: c.chatId,
        text: String(text ?? "").slice(0, MAX_TEXT),
        disable_web_page_preview: true,
        disable_notification: Boolean(silent),
      };
      let res;
      try {
        res = await fetchImpl(`${API_BASE}/bot${c.token}/sendMessage`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(timeoutMs),
          redirect: "error",
        });
      } catch (e) {
        // A fetch error message may contain the URL with the token, so only the code goes out.
        return { ok: false, reason: e?.name === "TimeoutError" || e?.name === "AbortError" ? "timeout" : "network" };
      }
      if (res.ok) return { ok: true, code: res.status };
      if (res.status === 401 || res.status === 404) {
        forget();
        return { ok: false, reason: "bad-credentials", code: res.status };
      }
      if (res.status === 429) {
        let retryAfter = null;
        try {
          const j = await res.json();
          retryAfter = Number(j?.parameters?.retry_after) || null;
        } catch {}
        return { ok: false, reason: "rate-limited", code: 429, retryAfter };
      }
      return { ok: false, reason: `http-${res.status}`, code: res.status };
    },
    forget,
  };
}
