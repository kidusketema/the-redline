// The Vercel entry. vercel.json sends every address that is not a static file here.
// Needs DATABASE_URL (or POSTGRES_URL, which Vercel's Neon and Supabase integrations set), REDLINE_PUBLISH_KEY and REDLINE_DASHBOARD_TOKEN.
import { createFunctionHandler } from "../src/runtime.js";

const handle = createFunctionHandler(process.env, process.env.VERCEL_DEPLOYMENT_ID || process.env.VERCEL_GIT_COMMIT_SHA);

export default { fetch: (request) => handle(request) };
