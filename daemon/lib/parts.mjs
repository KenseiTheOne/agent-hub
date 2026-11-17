// A class whose methods are spread over several files (Core — lib/core.mjs and lib/core/, PluginManager — lib/plugins.mjs
// and lib/plugins/): each part is a class that is never instantiated, its methods and accessors are copied onto the main
// class's prototype as they are (non-enumerable, like methods written in the class body). Inside them `this` is the
// instance of the main class.
//
// A name defined twice — in two parts, or in a part and in the main class — is a mistake of the split, not an override:
// it stops the module from loading.

export function installParts(Main, parts) {
  for (const Part of parts) {
    for (const key of Reflect.ownKeys(Part.prototype)) {
      if (key === "constructor") continue;
      if (Object.hasOwn(Main.prototype, key)) throw new Error(`${Main.name}: ${String(key)} is defined twice (${Part.name})`);
      Object.defineProperty(Main.prototype, key, Object.getOwnPropertyDescriptor(Part.prototype, key));
    }
  }
  return Main;
}
