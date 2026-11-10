#!/usr/bin/env node
// Read-only detector for stalled background-agent workspaces.
// usage: watchdog.mjs <dir>... [--stale-min N] [--done-glob <relative glob>]
import fs from 'node:fs';
import path from 'node:path';

const SKIP = new Set(['.git', 'node_modules', 'target', '__pycache__', '.pytest_cache', '.venv']);

const argv = process.argv.slice(2);
const dirs = [];
let staleMin = 10;
let doneGlob = '';
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--stale-min') staleMin = Number(argv[++i]);
  else if (argv[i] === '--done-glob') doneGlob = argv[++i];
  else dirs.push(argv[i]);
}
if (!dirs.length || !Number.isFinite(staleMin)) {
  console.error('usage: watchdog.mjs <dir>... [--stale-min N] [--done-glob <relative glob>]');
  process.exit(2);
}

const newestMtime = (root) => {
  let newest = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (SKIP.has(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else newest = Math.max(newest, fs.statSync(p).mtimeMs);
    }
  };
  walk(root);
  return newest;
};

const globToRegExp = (glob) =>
  new RegExp('^' + glob.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*') + '$');

const hasDoneMarker = (root, glob) => {
  const re = globToRegExp(glob);
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (SKIP.has(e.name)) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory() ? walk(path.join(d, e.name), r) : re.test(r)) return true;
    }
    return false;
  };
  return walk(root, '');
};

let code = 0;
const out = dirs.map((dir) => {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    code = 2;
    return { dir, error: 'directory not found' };
  }
  const newest = newestMtime(dir);
  const idleMinutes = newest ? Math.round(((Date.now() - newest) / 60000) * 10) / 10 : null;
  const done = doneGlob ? hasDoneMarker(dir, doneGlob) : false;
  const stale = !done && (idleMinutes === null || idleMinutes > staleMin);
  if (stale && code === 0) code = 1;
  return { dir, idleMinutes, done, stale };
});
console.log(JSON.stringify(out, null, 2));
process.exit(code);
