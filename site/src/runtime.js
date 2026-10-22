// What every non-Cloudflare entry shares: reading the REDLINE_* variables, choosing the database, and turning them into the env the site expects.
//
//   REDLINE_PUBLISH_KEY      the owner key (the Worker calls it PUBLISH_KEY)
//   REDLINE_DASHBOARD_TOKEN  the secret in the dashboard address (the Worker calls it DASHBOARD_TOKEN)
//   REDLINE_PUBLIC_URL       optional: the address people use, when a tunnel or proxy sits in front
//   DATABASE_URL             Postgres. POSTGRES_URL (Vercel, Neon), NETLIFY_DB_URL and NETLIFY_DATABASE_URL (Netlify) are read too.
import app from "./app.js";
import { connectPostgres, createPgDb, createPgFiles, ensurePostgresSchema } from "./stores/postgres.js";

export const DATABASE_VARS = ["DATABASE_URL", "POSTGRES_URL", "NETLIFY_DB_URL", "NETLIFY_DATABASE_URL"];

export function databaseUrl(vars) {
  for (const name of DATABASE_VARS) if (vars[name] && /^postgres(ql)?:\/\//i.test(vars[name])) return vars[name];
  return "";
}

// The part of env that comes from plain variables.
export function settingsFrom(vars, build) {
  return {
    PUBLISH_KEY: vars.REDLINE_PUBLISH_KEY || vars.PUBLISH_KEY || "",
    DASHBOARD_TOKEN: vars.REDLINE_DASHBOARD_TOKEN || vars.DASHBOARD_TOKEN || "",
    PUBLIC_URL: vars.REDLINE_PUBLIC_URL || "",
    BUILD: vars.REDLINE_BUILD || build || "",
  };
}

export async function postgresEnv(url, settings, { max = 1 } = {}) {
  const driver = await connectPostgres(url, { max });
  await ensurePostgresSchema(driver);
  const DB = createPgDb(driver);
  return { ...settings, DB, FILES: createPgFiles(DB), close: () => driver.close() };
}

function setupPage(message, hint) {
  return new Response(JSON.stringify({ error: message, hint }), { status: 503, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
}

// A fetch handler for hosts that run the site as functions (Vercel, Netlify). The database connection is made once per warm function.
export function createFunctionHandler(vars, build) {
  let ready = null;
  const getEnv = () => {
    if (!ready) {
      ready = (async () => {
        const url = databaseUrl(vars);
        if (!url) return null;
        return postgresEnv(url, settingsFrom(vars, build), { max: Number(vars.REDLINE_PG_POOL) || 1 });
      })().catch((err) => { ready = null; throw err; });
    }
    return ready;
  };
  return async (request) => {
    let env;
    try { env = await getEnv(); } catch (err) {
      console.error("database", err && err.message);
      return setupPage("The site could not reach its database.", "Check that DATABASE_URL is a working Postgres address.");
    }
    if (!env) return setupPage("No database is connected yet.", "Set DATABASE_URL to a Postgres address, then redeploy.");
    return app.fetch(request, env);
  };
}
