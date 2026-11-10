import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = process.env.SDD_SCRIPT_UNDER_TEST ?? fileURLToPath(new URL('./sdd.mjs', import.meta.url));
const wrapper = fileURLToPath(new URL('../../../../bin/musubix6.mjs', import.meta.url));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-context-'));
after(() => fs.rmSync(scratch, { recursive: true, force: true }));
const { NODE_TEST_CONTEXT, ...env } = process.env;
env.GIT_CEILING_DIRECTORIES = scratch;
function write(root, file, text) {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), text);
}
function spec(root, feature, prefix = feature.toUpperCase(), extra = '') {
  const text = `---\nfeature: ${feature}\ntier: T1\n${extra}---\n# ${feature}\n| REQ-${prefix}-001 | When called, return ${feature}. | TEST-${prefix}-001 |\n`;
  write(root, `.sdd/specs/${feature}.md`, text);
  return text;
}
function fixture() {
  const root = fs.mkdtempSync(path.join(scratch, 'project-'));
  spec(root, 'calc');
  spec(root, 'consumer');
  spec(root, 'unrelated');
  write(root, 'calc.mjs', '/** @id CODE-CALC-001 @implements REQ-CALC-001 */\nexport const calc = () => 1;\n');
  write(root, 'consumer.mjs', "import { calc } from './calc.mjs';\n/** @id CODE-CONSUMER-001 @implements REQ-CONSUMER-001 */\nexport const consumer = () => calc();\n");
  return root;
}
function run(root, ...args) {
  const result = spawnSync(process.execPath, [script, '--root', root, 'context', ...args], { encoding: 'utf8', env });
  return { code: result.status, out: result.stdout, err: result.stderr };
}
const decode = (r) => { assert.equal(r.code, 0, r.out + r.err); return JSON.parse(r.out); };
const names = (r) => decode(r).features.map((f) => f.feature);
function rejected(r) {
  assert.equal(r.code, 2, r.out + r.err);
  assert.doesNotMatch(r.out, /\| REQ-|When called, return|"text":/);
  assert.match(r.out, /CONTEXT/);
}

/** @id TEST-SPECCTX-001 @verifies REQ-SPECCTX-001 */
test('TEST-SPECCTX-001 selects complete features, impact, unions and fails closed', () => {
  const root = fixture();
  for (const selector of ['calc', 'REQ-CALC-001', '.sdd/specs/calc.md', './.sdd/specs/calc.md']) {
    const result = decode(run(root, selector, '--json'));
    assert.deepEqual(result.features.map((f) => f.feature), ['calc']);
    assert.equal(result.files[0].text, fs.readFileSync(path.join(root, '.sdd/specs/calc.md'), 'utf8'));
  }
  assert.deepEqual(names(run(root, 'calc.mjs', '--json')), ['calc', 'consumer']);
  assert.deepEqual(names(run(root, 'consumer', 'calc', 'REQ-CALC-001', '--json')), ['calc', 'consumer']);
  for (const args of [[], ['missing'], ['calc', 'missing'], ['CALC'], ['--changed']]) rejected(run(root, ...args));
  write(root, 'calc', 'ambiguous feature and file');
  rejected(run(root, 'calc'));
  fs.unlinkSync(path.join(root, 'calc'));
  assert.equal(spawnSync('git', ['init', '-q'], { cwd: root, env }).status, 0);
  spawnSync('git', ['add', '.'], { cwd: root, env });
  spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture'], { cwd: root, env });
  rejected(run(root, '--changed'));
  fs.appendFileSync(path.join(root, 'calc.mjs'), '\n');
  assert.deepEqual(names(run(root, '--changed', '--json')), ['calc', 'consumer']);
  write(root, 'unowned.txt', 'unknown');
  rejected(run(root, '--changed'));
  fs.unlinkSync(path.join(root, 'unowned.txt'));
  fs.unlinkSync(path.join(root, 'calc.mjs'));
  rejected(run(root, '--changed'));
  const ambiguous = fixture();
  write(ambiguous, '.sdd/specs/ambiguous.md', '---\nfeature: REQ-CALC-001\ntier: T1\n---\n| REQ-OTHER-001 | When called, return other. | TEST-OTHER-001 |\n');
  rejected(run(ambiguous, 'REQ-CALC-001'));
});

/** @id TEST-SPECCTX-002 @verifies REQ-SPECCTX-002 */
test('TEST-SPECCTX-002 closes dependencies and artifacts, rejects ambiguous or escaped inputs', () => {
  const root = fixture();
  write(root, '.sdd/plan.md', '| order | feature | depends | note |\n| 1 | unrelated | - | |\n| 2 | consumer | unrelated | |\n| 3 | calc | consumer,unrelated | |\n');
  spec(root, 'calc', 'CALC', 'artifacts: contracts/data.json\n');
  write(root, 'contracts/data.json', '{"contract":true}\n');
  const good = decode(run(root, 'calc', '--json'));
  assert.deepEqual(good.features.map((f) => f.feature), ['calc', 'consumer', 'unrelated']);
  assert.equal(good.files.length, 4);
  assert.equal(good.files.find((f) => f.path === 'contracts/data.json').text, '{"contract":true}\n');
  for (const plan of [
    '| 1 | calc | missing | |',
    '| 1 | calc | consumer | |\n| 2 | consumer | calc | |',
    '| 1 | calc | - | |\n| 2 | calc | - | |',
    '| nope | calc | consumer | |',
    '| 1 | calc | - | |\n| 2 | | - | |',
    'not a plan table',
  ]) {
    write(root, '.sdd/plan.md', plan);
    rejected(run(root, 'calc'));
  }
  fs.unlinkSync(path.join(root, '.sdd/plan.md'));
  spec(root, 'duplicate', 'CALC');
  rejected(run(root, 'calc'));
  fs.unlinkSync(path.join(root, '.sdd/specs/duplicate.md'));
  write(root, '.sdd/specs/duplicate.md', fs.readFileSync(path.join(root, '.sdd/specs/calc.md')));
  rejected(run(root, 'calc'));
  fs.unlinkSync(path.join(root, '.sdd/specs/duplicate.md'));
  const outside = path.join(scratch, 'outside.md');
  fs.writeFileSync(outside, 'SECRET OUTSIDE');
  fs.symlinkSync(outside, path.join(root, 'escape'));
  for (const selector of [outside, '../outside.md', 'escape']) {
    const result = run(root, selector);
    rejected(result);
    assert.doesNotMatch(result.out, /SECRET OUTSIDE/);
  }
  for (const artifact of ['absent.json', '../outside.md', 'escape']) {
    spec(root, 'calc', 'CALC', `artifacts: ${artifact}\n`);
    rejected(run(root, 'calc'));
  }
  fs.unlinkSync(path.join(root, '.sdd/specs/calc.md'));
  fs.symlinkSync(outside, path.join(root, '.sdd/specs/calc.md'));
  rejected(run(root, 'consumer'));
});

/** @id TEST-SPECCTX-003 @verifies REQ-SPECCTX-003 */
test('TEST-SPECCTX-003 enforces exact UTF-8 budgets without partial bodies', () => {
  const root = fixture();
  fs.appendFileSync(path.join(root, '.sdd/specs/calc.md'), '日本語の要件\n');
  for (const format of [[], ['--json']]) {
    const good = run(root, 'calc', ...format);
    assert.equal(good.code, 0, good.out);
    const size = Buffer.byteLength(good.out);
    assert.ok(size > good.out.length);
    assert.equal(run(root, 'calc', ...format, '--max-bytes', String(size)).out, good.out);
    const bad = run(root, 'calc', ...format, '--max-bytes', String(size - 1));
    rejected(bad);
    assert.match(bad.out, new RegExp(`required=${size}\\b`));
  }
  for (const value of ['0', '-1', '1.5', 'NaN', '9007199254740992', '']) rejected(run(root, 'calc', '--max-bytes', value));
  rejected(run(root, 'calc', '--max-bytes'));
  fs.appendFileSync(path.join(root, '.sdd/specs/calc.md'), 'x'.repeat(16384));
  rejected(run(root, 'calc'));
  assert.equal(run(root, 'calc', '--max-bytes', '32768').code, 0);
  for (let i = 0; i < 20; i++) spec(root, `f${i}`);
  const overflow = run(root, ...Array.from({ length: 20 }, (_, i) => `f${i}`), '--max-bytes', '1');
  rejected(overflow);
  assert.ok(overflow.out.trimEnd().split('\n').length <= 15, overflow.out);
  assert.match(overflow.out, /10 more/);
});

/** @id TEST-SPECCTX-004 @verifies REQ-SPECCTX-004 */
test('TEST-SPECCTX-004 reports current hashes and counts deterministically without writes', () => {
  const root = fixture();
  const before = fs.readdirSync(path.join(root, '.sdd'));
  const first = run(root, 'calc', '--json');
  const data = decode(first);
  assert.equal(data.kind, 'reading-context');
  assert.equal(data.totalSpecs, 3);
  assert.equal(data.features.length, 1);
  assert.match(data.notice, /not validation|not.*evidence/i);
  for (const file of data.files) assert.equal(file.sha256, createHash('sha256').update(fs.readFileSync(path.join(root, file.path))).digest('hex'));
  assert.equal(run(root, 'calc', '--json').out, first.out);
  fs.appendFileSync(path.join(root, '.sdd/specs/calc.md'), '\nNew constraint.\n');
  const second = decode(run(root, 'calc', '--json'));
  assert.notEqual(second.files[0].sha256, data.files[0].sha256);
  assert.match(second.files[0].text, /New constraint/);
  assert.deepEqual(fs.readdirSync(path.join(root, '.sdd')), before);
  const fileResult = decode(run(root, 'calc.mjs', '--json'));
  assert.match(fileResult.notice, /static|file-granular/i);
});

/** @id TEST-SPECCTX-005 @verifies REQ-SPECCTX-005 */
test('TEST-SPECCTX-005 integrates wrapper, installed skills and unchanged verification', () => {
  const root = fixture();
  const direct = run(root, 'calc', '--json');
  assert.equal(direct.code, 0, direct.out);
  const wrapped = spawnSync(process.execPath, [wrapper, 'sdd', '--root', root, 'context', 'calc', '--json'], { encoding: 'utf8', env });
  assert.equal(wrapped.status, 0, wrapped.stdout + wrapped.stderr);
  assert.equal(wrapped.stdout, direct.out);
  const install = fs.mkdtempSync(path.join(scratch, 'install-'));
  const installed = spawnSync(process.execPath, [wrapper, 'init', install, '--only', 'lean-sdd-tdd,lean-agentic-coding,sdd-spec-interview,sdd-reverse-spec'], { encoding: 'utf8', env });
  assert.equal(installed.status, 0, installed.stdout + installed.stderr);
  for (const name of ['lean-sdd-tdd', 'lean-agentic-coding', 'sdd-spec-interview', 'sdd-reverse-spec']) {
    const text = fs.readFileSync(path.join(install, '.github/skills', name, 'SKILL.md'), 'utf8');
    assert.match(text, /context/);
    assert.match(text, /full.*(?:gate|validation)|(?:gate|validation).*full/i);
  }
  const check = spawnSync(process.execPath, [path.join(install, '.github/skills/lean-sdd-tdd/scripts/sdd.mjs'), '--root', root, 'context', 'calc', '--json'], { encoding: 'utf8', env });
  assert.equal(check.status, 0, check.stdout + check.stderr);
  assert.equal(check.stdout, direct.out);
  const trace = spawnSync(process.execPath, [script, '--root', root, 'trace'], { encoding: 'utf8', env });
  assert.notEqual(trace.status, 0, 'reading context must not excuse missing verification');
  assert.match(trace.stdout, /TEST|test|verif/);
});
