// A KV-style file store on a folder: get(key, "arrayBuffer" | "stream"), put(key, bytes | stream), delete(key).
// Keys look like f/<slug>/<version>/<path>. On disk that is <dir>/<slug>/<version>/f_<path with every unusual character as %XX>,
// so the same folder works on case-insensitive disks and no path can leave it. Names longer than a disk allows use a hash instead.
import { createReadStream, createWriteStream, existsSync, readdirSync, rmdirSync, statSync } from "node:fs";
import { readFile, rename, rm, mkdir } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const SAFE = /[a-z0-9._-]/;
const MAX_NAME = 200;

function encodeName(path) {
  let out = "";
  for (const byte of new TextEncoder().encode(path)) {
    const ch = String.fromCharCode(byte);
    out += byte < 128 && SAFE.test(ch) && !(out === "" && ch === ".") ? ch : "%" + byte.toString(16).toUpperCase().padStart(2, "0");
  }
  if (out.length > MAX_NAME) return "h_" + createHash("sha256").update(path).digest("hex");
  return "f_" + out;
}

function decodeName(name) {
  if (!name.startsWith("f_")) return null; // a hashed name cannot be turned back into a path
  try { return decodeURIComponent(name.slice(2)); } catch { return null; }
}

// "f/<slug>/<version>/<path>" -> { slug, version, path }, or null when the key has another shape.
function parseKey(key) {
  const m = /^f\/([a-z0-9]{24})\/([0-9]{1,6})\/(.+)$/.exec(key);
  return m ? { slug: m[1], version: m[2], path: m[3] } : null;
}

export function createDiskFiles(root) {
  const where = (key) => {
    const k = parseKey(key);
    if (!k) throw new Error("bad file key");
    const dir = join(root, k.slug, k.version);
    return { dir, file: join(dir, encodeName(k.path)) };
  };

  return {
    root,
    async get(key, type = "arrayBuffer") {
      const { file } = where(key);
      if (!existsSync(file)) return null;
      if (type === "stream") return Readable.toWeb(createReadStream(file));
      const buf = await readFile(file);
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    },
    async put(key, value) {
      const { dir, file } = where(key);
      // Delete removes folders that became empty, so a folder can vanish between mkdir and the write: try twice.
      for (let attempt = 0; ; attempt++) {
        await mkdir(dir, { recursive: true });
        const temp = join(dir, `.tmp-${randomBytes(6).toString("hex")}`);
        try {
          if (value && typeof value.getReader === "function") await pipeline(Readable.fromWeb(value), createWriteStream(temp));
          else {
            const out = createWriteStream(temp);
            await new Promise((resolve, reject) => { out.on("error", reject); out.on("finish", resolve); out.end(value instanceof ArrayBuffer ? new Uint8Array(value) : value); });
          }
          await rename(temp, file);
          return;
        } catch (err) {
          await rm(temp, { force: true });
          if (err && err.code === "ENOENT" && attempt < 2 && !(value && typeof value.getReader === "function")) continue;
          throw err;
        }
      }
    },
    async delete(key) {
      const { dir, file } = where(key);
      await rm(file, { force: true });
      // Tidy up folders that became empty; a folder that still has files is left alone.
      for (const d of [dir, join(root, parseKey(key).slug)]) {
        try { if (readdirSync(d).length === 0) rmdirSync(d); } catch { /* not empty, or already gone */ }
      }
    },
    // Keys that start with a prefix. Used by tests and tools; a hashed (very long) name is listed as h_<hash>.
    listSync(prefix = "f/") {
      const keys = [];
      if (!existsSync(root)) return keys;
      for (const slug of readdirSync(root)) {
        const sdir = join(root, slug);
        if (!statSync(sdir).isDirectory()) continue;
        for (const version of readdirSync(sdir)) {
          const vdir = join(sdir, version);
          if (!statSync(vdir).isDirectory()) continue;
          for (const name of readdirSync(vdir)) {
            if (name.startsWith(".tmp-")) continue;
            const path = decodeName(name);
            const key = `f/${slug}/${version}/${path === null ? name : path}`;
            if (key.startsWith(prefix)) keys.push(key);
          }
        }
      }
      return keys;
    },
  };
}
