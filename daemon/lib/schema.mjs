// Validating primitive arguments against argsSchema.
//
// argsSchema: { <name>: { type: "string"|"integer"|"number"|"boolean", required?, positional?,
//                        pattern?: RegExp|string, maxLength?, min?, max?, enum?: [...] } }
// Extra arguments are an error. Positional tokens (from effect=) are assigned to fields with positional:true
// in declaration order.

export function argsFromTokens(schema, tokens) {
  const args = {};
  const positional = Object.entries(schema || {})
    .filter(([, s]) => s.positional)
    .map(([k]) => k);
  let pi = 0;
  for (const t of tokens) {
    const m = /^([A-Za-z_]\w*)=([\s\S]*)$/.exec(t);
    if (m && schema && Object.hasOwn(schema, m[1])) {
      args[m[1]] = m[2];
      continue;
    }
    if (pi >= positional.length) return { error: "args:too-many" };
    args[positional[pi++]] = t;
  }
  return { args };
}

// Strings from effect= are coerced to the schema type. → { args } | { error }
export function validateArgs(schema, input, { coerce = false } = {}) {
  const out = {};
  const src = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  for (const k of Object.keys(src)) if (!schema || !Object.hasOwn(schema, k)) return { error: `args:${k}:unknown` };
  for (const [k, s] of Object.entries(schema || {})) {
    let v = src[k];
    if (v === undefined || v === null || v === "") {
      if (s.required) return { error: `args:${k}:required` };
      if (s.default !== undefined) out[k] = s.default;
      continue;
    }
    if (coerce && typeof v === "string") {
      if (s.type === "integer" || s.type === "number") v = Number(v);
      else if (s.type === "boolean") v = v === "true" || v === "1" ? true : v === "false" || v === "0" ? false : v;
    }
    switch (s.type) {
      case "string":
        if (typeof v !== "string") return { error: `args:${k}:type` };
        if (s.maxLength && v.length > s.maxLength) return { error: `args:${k}:too-long` };
        if (s.pattern && !new RegExp(s.pattern).test(v)) return { error: `args:${k}:pattern` };
        break;
      case "integer":
        if (!Number.isInteger(v)) return { error: `args:${k}:type` };
      // fallthrough
      case "number":
        if (typeof v !== "number" || !Number.isFinite(v)) return { error: `args:${k}:type` };
        if (s.min !== undefined && v < s.min) return { error: `args:${k}:range` };
        if (s.max !== undefined && v > s.max) return { error: `args:${k}:range` };
        break;
      case "boolean":
        if (typeof v !== "boolean") return { error: `args:${k}:type` };
        break;
      default:
        return { error: `args:${k}:schema` };
    }
    if (s.enum && !s.enum.includes(v)) return { error: `args:${k}:enum` };
    out[k] = v;
  }
  return { args: out };
}
