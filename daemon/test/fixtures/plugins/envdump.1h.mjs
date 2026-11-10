// <agenthub.title>Env</agenthub.title>
// Prints only the NAMES of environment variables (not values) — to check sanitization.
console.log("Env | status=ok");
console.log("---");
console.log(Object.keys(process.env).sort().join(","));
