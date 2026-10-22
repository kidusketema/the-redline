// Rebuilds site/src/schema.js from site/schema.sql and site/schema.postgres.sql. Run: node test/gen-schema.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SITE = join(dirname(fileURLToPath(import.meta.url)), "..", "site");
const sqlite = readFileSync(join(SITE, "schema.sql"), "utf8");
const postgres = readFileSync(join(SITE, "schema.postgres.sql"), "utf8");
const out =
  "// The two database schemas as text, so every runtime can apply them at startup without reading files.\n" +
  "// Generated from schema.sql and schema.postgres.sql by test/gen-schema.mjs; test/adapters.mjs checks that they match.\n" +
  "export const SQLITE_SCHEMA = " + JSON.stringify(sqlite) + ";\n" +
  "export const POSTGRES_SCHEMA = " + JSON.stringify(postgres) + ";\n";
writeFileSync(join(SITE, "src", "schema.js"), out);
console.log("wrote site/src/schema.js");
