// The Netlify entry (Functions v2). Every address that is not a static file in public/ comes here.
// Needs a Postgres address in DATABASE_URL (or NETLIFY_DB_URL from Netlify Database), REDLINE_PUBLISH_KEY and REDLINE_DASHBOARD_TOKEN.
import { createFunctionHandler } from "../../src/runtime.js";

const handle = createFunctionHandler(process.env, process.env.DEPLOY_ID || process.env.COMMIT_REF);

export default (request) => handle(request);

export const config = {
  path: "/*",
  preferStatic: true,
};
