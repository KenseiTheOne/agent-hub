// Plugin author — from metadata (<agenthub.author.name>, <agenthub.author.github>) or from the registry index.
// Strings only: a name (how the author signs) and a GitHub login following GitHub's rules — otherwise the shell
// can't turn it into a profile link. An empty object means no author is given.
export function cleanAuthor(a) {
  const out = {};
  if (!a || typeof a !== "object") return out;
  const name = typeof a.name === "string" ? a.name.trim() : "";
  if (name && name.length <= 100 && !/[\p{Cc}\p{Cf}]/u.test(name)) out.name = name;
  if (typeof a.github === "string" && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(a.github)) out.github = a.github;
  return out;
}
