// What differs between the live version of a page and the one before it. The answer was worked out when the version was published
// (see versions.js), so this is one read.
import { json } from "./util.js";
import { loadVersion } from "./versions.js";

// GET /api/<link>/changes
//   { version, from, available, items: [{t, k: "changed" | "new", w?}], removed: [{t}] }
// from is the version it was compared with; available is false when there is nothing to compare (the first version, or a page published
// before changes were recorded), in which case items and removed are empty.
export async function changesApi(env, doc) {
  const live = await loadVersion(env, doc);
  const c = live && live.changes;
  if (!c) return json({ version: doc.version, from: doc.version > 1 ? doc.version - 1 : null, available: false, items: [], removed: [] });
  return json({
    version: doc.version, from: c.from, available: true,
    items: c.items.map(({ t, k, w }) => (w ? { t, k, w } : { t, k })), removed: c.removed,
  });
}
