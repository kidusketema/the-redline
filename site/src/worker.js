// The Cloudflare Worker entry. The site itself is in app.js and runs on any runtime that has fetch.
// Secrets here are PUBLISH_KEY and DASHBOARD_TOKEN; bindings are DB (D1) and FILES (KV).
export { default } from "./app.js";
