import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'watchdog.mjs');
const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wd-'));
const age = (file, minutes) => {
  const t = new Date(Date.now() - minutes * 60000);
  fs.utimesSync(file, t, t);
};
const run = (...args) => {
  const r = spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8' });
  return { code: r.status, json: r.stdout ? JSON.parse(r.stdout) : null, err: r.stderr };
};

test('TEST-WD-001: recently modified workspace is active', () => {
  const d = mk();
  fs.writeFileSync(path.join(d, 'a.txt'), 'x');
  const r = run(d, '--stale-min', '10');
  assert.equal(r.code, 0);
  assert.equal(r.json[0].stale, false);
  assert.ok(r.json[0].idleMinutes < 1);
});

test('TEST-WD-002: workspace idle longer than the threshold is stale and exits 1', () => {
  const d = mk();
  const f = path.join(d, 'a.txt');
  fs.writeFileSync(f, 'x');
  age(f, 30);
  age(d, 30);
  const r = run(d, '--stale-min', '10');
  assert.equal(r.code, 1);
  assert.equal(r.json[0].stale, true);
  assert.ok(r.json[0].idleMinutes >= 29);
});

test('TEST-WD-003: node_modules, target and .git file changes are ignored', () => {
  const d = mk();
  const f = path.join(d, 'a.txt');
  fs.writeFileSync(f, 'x');
  age(f, 30);
  for (const sub of ['node_modules', 'target', '.git']) {
    fs.mkdirSync(path.join(d, sub));
    fs.writeFileSync(path.join(d, sub, 'fresh.txt'), 'y');
  }
  age(d, 30);
  const r = run(d, '--stale-min', '10');
  assert.equal(r.json[0].stale, true);
});

test('TEST-WD-004: a done marker (findings file) makes a workspace done, never stale', () => {
  const d = mk();
  fs.mkdirSync(path.join(d, 'findings'));
  const f = path.join(d, 'findings', 'app1.md');
  fs.writeFileSync(f, 'done');
  age(f, 60);
  age(path.join(d, 'findings'), 60);
  age(d, 60);
  const r = run(d, '--stale-min', '10', '--done-glob', 'findings/*.md');
  assert.equal(r.code, 0);
  assert.equal(r.json[0].done, true);
  assert.equal(r.json[0].stale, false);
});

test('TEST-WD-005: nested files count toward activity', () => {
  const d = mk();
  fs.mkdirSync(path.join(d, 'src'));
  const old = path.join(d, 'src', 'old.txt');
  fs.writeFileSync(old, 'x');
  age(old, 60);
  fs.writeFileSync(path.join(d, 'src', 'new.txt'), 'y');
  age(path.join(d, 'src'), 60);
  age(d, 60);
  const r = run(d, '--stale-min', '10');
  assert.equal(r.json[0].stale, false);
});

test('TEST-WD-006: a missing directory is reported as an error entry and exits 2', () => {
  const r = run(path.join(os.tmpdir(), 'wd-does-not-exist-xyz'));
  assert.equal(r.code, 2);
  assert.match(r.json[0].error, /not found/);
});

test('TEST-WD-007: no arguments prints usage and exits 2', () => {
  const r = spawnSync('node', [SCRIPT], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage/i);
});
