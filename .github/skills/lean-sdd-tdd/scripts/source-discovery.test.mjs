import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = process.env.SDD_SCRIPT_UNDER_TEST ?? fileURLToPath(new URL('./sdd.mjs', import.meta.url));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-discovery-'));
after(() => fs.rmSync(scratch, { recursive: true, force: true }));
const { NODE_TEST_CONTEXT, ...env } = process.env;
env.GIT_CEILING_DIRECTORIES = scratch;
function write(root, file, text) {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), text);
}
function fixture() {
  const root = fs.mkdtempSync(path.join(scratch, 'fixture-'));
  write(root, '.sdd/specs/a.md', '---\nfeature: a\ntier: T1\n---\n| REQ-A-001 | When called, return 1. | TEST-A-001 |\n');
  write(root, 'a.mjs', '/** @id CODE-A-001 @implements REQ-A-001 */\nexport const a = 1;\n');
  write(root, 'a.test.mjs', "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { a } from './a.mjs';\n/** @id TEST-A-001 @verifies REQ-A-001 */\ntest('TEST-A-001', () => assert.equal(a, 1));\n");
  return root;
}
function run(root, ...args) {
  const r = spawnSync(process.execPath, [script, '--root', root, ...args], { encoding: 'utf8', env });
  return { code: r.status, out: r.stdout + r.stderr };
}
const config = (root, value) => write(root, '.sdd/config.json', JSON.stringify(value));
function refusal(root, ...args) {
  const ledger = path.join(root, '.sdd/tdd.jsonl');
  const before = fs.existsSync(ledger) ? fs.readFileSync(ledger) : null;
  const r = run(root, ...args);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /REFUSED: source scan/);
  assert.doesNotMatch(r.out, /TRACE OK|SDD GATE PASS|RED ok/);
  if (before) assert.deepEqual(fs.readFileSync(ledger), before);
  else assert.equal(fs.existsSync(ledger), false);
}

/** @id TEST-SCAN-001 @verifies REQ-SCAN-001 */
test('TEST-SCAN-001 discovers large complete sources and rejects orphan annotations after the old cutoff', () => {
  const root = fixture();
  const padding = '// padding\n'.repeat(60000);
  for (const file of ['a.mjs', 'a.test.mjs']) {
    const text = padding + fs.readFileSync(path.join(root, file), 'utf8');
    assert.ok(Buffer.byteLength(text) > 524288);
    fs.writeFileSync(path.join(root, file), text);
  }
  const valid = run(root, 'trace');
  assert.equal(valid.code, 0, valid.out);
  assert.match(valid.out, /1 REQ, 2 annotated entities/);
  const impact = run(root, 'impact', 'a.mjs', '--json');
  assert.equal(impact.code, 0, impact.out);
  assert.deepEqual(JSON.parse(impact.out).reqs, ['REQ-A-001']);
  fs.appendFileSync(path.join(root, 'a.mjs'), '/** @id CODE-MISSING-001 @implements REQ-MISSING-001 */\nexport const missing = 0;\n');
  const invalid = run(root, 'trace');
  assert.equal(invalid.code, 1, invalid.out);
  assert.match(invalid.out, /unknown REQ-MISSING-001/);
});

/** @id TEST-SCAN-002 @verifies REQ-SCAN-002 */
test('TEST-SCAN-002 accepts exact byte boundary and refuses oversized sources before evidence writes', () => {
  const root = fixture();
  const limit = 1024;
  config(root, { scan: { maxFileBytes: limit } });
  write(root, 'boundary.mjs', ' '.repeat(limit));
  assert.equal(run(root, 'trace').code, 0);
  fs.appendFileSync(path.join(root, 'boundary.mjs'), ' ');
  for (const args of [['trace'], ['gate'], ['gate', '--changed'], ['impact', 'a.mjs'], ['tdd', 'red', 'TEST-A-001']]) refusal(root, ...args);
  const existing = fixture();
  assert.equal(run(existing, 'tdd', 'red', 'TEST-A-001', '--characterization', 'existing ledger valid-input control').code, 0);
  config(existing, { scan: { maxFileBytes: limit } });
  write(existing, 'oversized.mjs', ' '.repeat(limit + 1));
  for (const args of [['trace'], ['gate'], ['tdd', 'red', 'TEST-A-001']]) refusal(existing, ...args);
  fs.unlinkSync(path.join(root, 'boundary.mjs'));
  write(root, 'default-limit.mjs', ' '.repeat(16777217));
  fs.unlinkSync(path.join(root, '.sdd/config.json'));
  for (const args of [['trace'], ['gate'], ['tdd', 'red', 'TEST-A-001']]) refusal(root, ...args);
});

/** @id TEST-SCAN-003 @verifies REQ-SCAN-003 */
test('TEST-SCAN-003 validates explicit limits and retains deliberate filtering', () => {
  const root = fixture();
  for (const value of [0, -1, 1.5, '1024', null, true, 9007199254740992]) {
    config(root, { scan: { maxFileBytes: value } });
    refusal(root, 'trace');
  }
  config(root, { scan: { maxFileBytes: 1024, exclude: ['fixtures/**'] } });
  write(root, 'fixtures/large.mjs', ' '.repeat(2048));
  write(root, 'node_modules/large.mjs', ' '.repeat(2048));
  write(root, 'large.md', ' '.repeat(2048));
  assert.equal(run(root, 'trace').code, 0);
  config(root, { scan: { maxFileBytes: 1024, include: ['a.mjs', 'a.test.mjs'] } });
  assert.equal(run(root, 'trace').code, 0);
});
