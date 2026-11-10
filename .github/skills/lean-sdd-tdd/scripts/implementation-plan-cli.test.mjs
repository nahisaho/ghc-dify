import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = process.env.SDD_SCRIPT_UNDER_TEST ?? fileURLToPath(new URL('./sdd.mjs', import.meta.url));
const wrapper = fileURLToPath(new URL('../../../../bin/musubix6.mjs', import.meta.url));
const digest = value => createHash('sha256').update(value).digest('hex');
const env = { ...process.env, PATH: path.dirname(process.execPath) + path.delimiter + process.env.PATH };
delete env.NODE_TEST_CONTEXT;
function write(root, file, value) {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n');
}
function call(root, args, entry = script) {
  const result = spawnSync(process.execPath, entry === wrapper ? [entry, 'sdd', ...args, '--root', root]
    : [entry, ...args, '--root', root], { cwd: root, env, encoding: 'utf8', timeout: 60000, maxBuffer: 8 * 1024 * 1024 });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.signal, null);
  return { exit: result.status, text: result.stdout, error: result.stderr };
}
function json(result, expected = 0) {
  assert.equal(result.exit, expected, result.text + result.error);
  assert.equal(result.error, '', result.error);
  return JSON.parse(result.text);
}
function fixture(t, { implementation = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'musubix-plan-cli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = { testCmd: [process.execPath, '--test', '--test-name-pattern', '{id}(?![0-9A-Za-z])', '{file}'],
    checks: [{ name: 'test', cmd: [process.execPath, '--test', 'a.test.mjs', 'b.test.mjs'], timeoutMs: 20000 }],
    timeoutMs: 20000 };
  const document = { schemaVersion: 1, features: [], tasks: [] };
  for (const id of ['A', 'B']) {
    const name = id.toLowerCase(), spec = `.sdd/specs/${name}.md`;
    write(root, spec, `---\nfeature: ${name}\ntier: T1\n---\n| REQ-FIX-${id} | When read, the document shall contain ready. (test-only) | TEST-FIX-${id} |\n`);
    write(root, `${name}.md`, `${name} ready 日本語\n`);
    write(root, `${name}.test.mjs`, `import {test} from 'node:test';\nimport assert from 'node:assert/strict';\nimport fs from 'node:fs';\n/** @id TEST-FIX-${id} @verifies REQ-FIX-${id} */\ntest('TEST-FIX-${id}',()=>assert.match(fs.readFileSync('${name}.md','utf8'),/ready/));\n`);
    document.features.push({ id: name, dependsOn: [] });
    document.tasks.push({ id, feature: name, kind: implementation && id === 'A' ? 'implementation' : 'documentation',
      reqs: [`REQ-FIX-${id}`], dependsOn: [], artifacts: [`${name}.md`], condition: 'Document contains ready.',
      tests: implementation && id === 'A' ? [`TEST-FIX-${id}`] : [],
      checks: [{ name: 'document', argv: [process.execPath, '-e',
        `require('node:assert/strict').match(require('node:fs').readFileSync('${name}.md','utf8'),/ready/);`], timeoutMs: 20000 }],
      specs: { [spec]: digest(fs.readFileSync(path.join(root, spec))) }, dependencies: {},
      status: 'not-started', receipt: null });
  }
  const save = () => write(root, '.sdd/implementation-plan.json', document);
  const configure = () => write(root, '.sdd/config.json', config);
  const enable = () => { config.planning = { required: true }; configure(); save(); };
  const native = () => {
    for (const id of ['A', 'B']) for (const stage of ['red', 'green']) {
      const result = call(root, ['tdd', stage, `TEST-FIX-${id}`]);
      assert.equal(result.exit, 0, result.text + result.error);
    }
  };
  const adopt = id => {
    const result = json(call(root, ['plan', 'verify', id, '--json']));
    const task = document.tasks.find(task => task.id === id);
    task.status = 'complete'; task.receipt = result.receipt; save();
    return result;
  };
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: root, env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  };
  const commit = (...files) => {
    git('add', '--', ...files.length ? files : ['.']);
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Fixture state');
  };
  configure(); save();
  return { root, config, document, save, configure, enable, native, adopt, git, commit };
}
const plan = f => json(call(f.root, ['plan', 'check', '--json']));
const taskState = (result, id) => result.tasks.find(task => task.id === id).state;

/** @id TEST-PLAN-CLI-006 @verifies REQ-PLAN-CLI-004 */
test('TEST-PLAN-CLI-006 normal dispatch retains decisions without forcing runtime exit', t => {
  const f = fixture(t);
  const observer = fs.mkdtempSync(path.join(os.tmpdir(), 'musubix-exit-observer-'));
  t.after(() => fs.rmSync(observer, { recursive: true, force: true }));
  const preload = path.join(observer, 'observe-exit.cjs');
  fs.writeFileSync(preload, `
const fs = require('node:fs');
const prefix = process.env.MUSUBIX_EXIT_OBSERVER_PREFIX;
fs.writeFileSync(prefix + '.loaded', String(process.pid));
for (const method of ['exit', 'reallyExit']) {
  const original = process[method].bind(process);
  process[method] = (...args) => {
    fs.appendFileSync(prefix + '.calls', JSON.stringify({ method, args }) + '\\n');
    return original(...args);
  };
}
`);
  for (const method of ['exit', 'reallyExit']) {
    const prefix = path.join(observer, `positive-${method}`);
    const result = spawnSync(process.execPath, ['--require', preload, '-e', `process.${method}(7)`],
      { env: { ...env, MUSUBIX_EXIT_OBSERVER_PREFIX: prefix }, encoding: 'utf8',
        timeout: 20000, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024 });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.signal, null);
    assert.equal(result.status, 7, result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
    assert.match(fs.readFileSync(prefix + '.loaded', 'utf8'), /^[1-9][0-9]*$/);
    const calls = fs.readFileSync(prefix + '.calls', 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(calls[0], { method, args: [7] });
  }
  const forced = [];
  const states = [
    { name: 'disabled', exit: 0, status: 'DISABLED', prepare: () => {} },
    { name: 'pending', exit: 0, status: 'PASS', prepare: () => f.enable() },
    { name: 'malformed', exit: 1, status: 'FAIL',
      prepare: () => write(f.root, '.sdd/implementation-plan.json', '{') },
    { name: 'missing', exit: 2, status: 'INCOMPLETE',
      prepare: () => fs.rmSync(path.join(f.root, '.sdd/implementation-plan.json')) },
  ];
  for (const state of states) {
    state.prepare();
    for (const entry of [script, wrapper]) {
      const label = `${state.name}/${entry === wrapper ? 'wrapper' : 'native'}`;
      const control = json(call(f.root, ['plan', 'check', '--json'], entry), state.exit);
      assert.equal(control.exit, state.exit, label);
      assert.equal(control.status, state.status, label);
      const prefix = path.join(observer, label.replace('/', '-'));
      assert.equal(fs.existsSync(prefix + '.loaded'), false);
      assert.equal(fs.existsSync(prefix + '.calls'), false);
      const result = spawnSync(process.execPath, ['--require', preload,
        entry, ...(entry === wrapper ? ['sdd'] : []), 'plan', 'check', '--json', '--root', f.root],
      { cwd: f.root, env: { ...env, MUSUBIX_EXIT_OBSERVER_PREFIX: prefix }, encoding: 'utf8',
        timeout: 20000, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024 });
      assert.equal(result.stderr, '', result.stderr);
      const decision = JSON.parse(result.stdout);
      assert.equal(decision.exit, state.exit, label);
      assert.equal(decision.status, state.status, label);
      assert.match(fs.readFileSync(prefix + '.loaded', 'utf8'), /^[1-9][0-9]*$/);
      if (fs.existsSync(prefix + '.calls')) {
        const calls = fs.readFileSync(prefix + '.calls', 'utf8').trim().split('\n').map(line => JSON.parse(line));
        forced.push({ label, calls });
      }
      assert.equal(result.error, undefined, result.error?.message);
      assert.equal(result.signal, null, `${label}: dispatched process must finish normally`);
      assert.equal(result.status, state.exit, label);
    }
  }
  assert.deepEqual(forced, [], 'normal dispatch must not call process.exit');
});

/** @id TEST-PLAN-CLI-001 @verifies REQ-PLAN-CLI-001 */
test('TEST-PLAN-CLI-001 opt-in authority, strict config and unchanged disabled commands', t => {
  const f = fixture(t);
  f.native();
  f.enable();
  const result = plan(f);
  assert.equal(result.enabled, true, 'An explicitly enabled JSON plan must not fall back to absent Markdown.');
  assert.equal(result.stage, 'consistency');
  assert.equal(taskState(result, 'A'), 'not-started');
  for (const text of ['not a Markdown plan', '| bad | missing | missing | |']) {
    write(f.root, '.sdd/plan.md', text);
    assert.equal(plan(f).exit, 0);
    assert.equal(json(call(f.root, ['context', 'a', '--json'])).planning.enabled, true);
  }
  json(call(f.root, ['gate', '--no-run', '--json']), 2);
  fs.unlinkSync(path.join(f.root, '.sdd/plan.md'));
  fs.unlinkSync(path.join(f.root, '.sdd/implementation-plan.json'));
  for (const args of [['plan'], ['context', 'a'], ['gate', '--no-run']]) {
    const refusal = json(call(f.root, [...args, '--json']), 2);
    assert.match(JSON.stringify(refusal), /implementation-plan\.json/);
  }
  f.save();
  for (const config of ['{', 'null', '[]', '{"planning":{"required":"true"}}']) {
    write(f.root, '.sdd/config.json', config);
    for (const args of [['plan'], ['context', 'a'], ['gate', '--no-run']]) {
      assert.equal(json(call(f.root, [...args, '--json']), 1).status, 'FAIL');
    }
  }
  f.configure();
  const legacy = fixture(t);
  legacy.native();
  write(legacy.root, '.sdd/plan.md', '| order | feature | depends | note |\n| 1 | a | - | |\n| 2 | b | - | |\n');
  const commands = [['plan'], ['context', 'a', '--json'], ['gate', '--no-run', '--json']];
  const before = commands.map(args => call(legacy.root, args));
  assert.equal(before[0].exit, 0);
  assert.equal(before[0].text, '✓ 1. a [T1]\n✓ 2. b [T1]\nnext: (all features done)\n');
  const legacyContext = json(before[1]);
  assert.deepEqual(legacyContext.features, [{ feature: 'a', paths: ['.sdd/specs/a.md'] }]);
  assert.deepEqual(legacyContext.files, [{ path: '.sdd/specs/a.md',
    sha256: digest(fs.readFileSync(path.join(legacy.root, '.sdd/specs/a.md'))),
    bytes: fs.statSync(path.join(legacy.root, '.sdd/specs/a.md')).size,
    text: fs.readFileSync(path.join(legacy.root, '.sdd/specs/a.md'), 'utf8') }]);
  assert.equal(json(before[2], 2).verdict, 'INCOMPLETE');
  assert.equal(Object.hasOwn(legacyContext, 'planning'), false);
  legacy.config.planning = { required: false }; legacy.configure();
  write(legacy.root, '.sdd/implementation-plan.json', '{broken JSON is not read in disabled mode');
  assert.deepEqual(commands.map(args => call(legacy.root, args)), before, 'Valid disabled legacy calls retain exact outputs and exits.');
  json(call(legacy.root, ['plan', 'verify', 'A', '--json']), 2);
});

/** @id TEST-PLAN-CLI-002 @verifies REQ-PLAN-CLI-002 */
test('TEST-PLAN-CLI-002 consistency versus scoped/full gate and after-check invalidation', t => {
  const f = fixture(t);
  f.native(); f.enable();
  assert.equal(plan(f).stage, 'consistency', 'Consistency is distinct from full completion.');
  for (const status of ['not-started', 'in-progress', 'blocked', 'complete']) {
    f.document.tasks[0].status = status; f.save();
    const expected = status === 'complete' ? 2 : 0;
    const checked = json(call(f.root, ['plan', '--json']), expected);
    assert.equal(taskState(checked, 'A'), status === 'complete' ? 'revalidation-required' : status);
    json(call(f.root, ['gate', '--json']), 2);
  }
  f.document.tasks[0].status = 'in-progress'; f.save();
  const verified = json(call(f.root, ['plan', 'verify', 'A', '--json']));
  assert.equal(taskState(json(call(f.root, ['plan', '--json']), 1), 'A'), 'revalidation-required');
  f.document.tasks[0].receipt = verified.receipt; f.save();
  assert.equal(taskState(plan(f), 'A'), 'complete');
  json(call(f.root, ['gate', '--json']), 2);
  f.adopt('B');
  assert.equal(json(call(f.root, ['gate', '--json'])).planning.status, 'PASS', 'A valid full gate must be accepted, not rejected indiscriminately.');
  json(call(f.root, ['gate', '--no-run', '--json']), 2);
  f.git('init', '-q'); f.commit();
  fs.appendFileSync(path.join(f.root, '.sdd/specs/b.md'), '\nChanged B contract commentary.\n');
  f.commit();
  fs.appendFileSync(path.join(f.root, 'a.md'), '\nA independent edit.\n');
  f.adopt('A');
  f.commit('.sdd/implementation-plan.json', '.sdd/plan-evidence', '.sdd/tdd.jsonl');
  const scoped = json(call(f.root, ['gate', '--changed', '--json']));
  assert.deepEqual(scoped.planning.tasks.map(task => task.id), ['A'], 'Committed unrelated stale B must not block A-only gate.');
  json(call(f.root, ['plan', 'check', '--json']), 1);
  json(call(f.root, ['gate', '--json']), 1);
  f.document.tasks[0].dependsOn = ['B'];
  f.document.tasks[0].dependencies = { B: '0'.repeat(64) }; f.save();
  const blocked = json(call(f.root, ['gate', '--changed', '--json']), 1);
  assert.deepEqual(new Set(blocked.planning.tasks.map(task => task.id)), new Set(['A', 'B']));
  const dependency = fixture(t);
  dependency.native(); dependency.enable();
  const currentB = plan(dependency).tasks.find(task => task.id === 'B').fingerprint;
  dependency.document.tasks[0].dependsOn = ['B'];
  dependency.document.tasks[0].dependencies = { B: currentB }; dependency.save();
  assert.equal(plan(dependency).exit, 0, 'Current bindings with a pending prerequisite pass consistency.');
  dependency.git('init', '-q'); dependency.commit();
  fs.appendFileSync(path.join(dependency.root, 'a.md'), 'A-only change.\n');
  const pending = json(call(dependency.root, ['gate', '--changed', '--json']), 2);
  assert.deepEqual(new Set(pending.planning.tasks.map(task => task.id)), new Set(['A', 'B']),
    'A-only changed scope reaches an honestly bound pending B without a plan/config change.');
  const race = fixture(t);
  race.native(); race.enable(); race.adopt('A'); race.adopt('B');
  race.config.checks.push({ name: 'mutator', cmd: [process.execPath, '-e',
    "require('node:fs').appendFileSync('a.md','changed during gate\\n')"], timeoutMs: 20000 });
  race.configure();
  race.adopt('A'); race.adopt('B');
  const changed = json(call(race.root, ['gate', '--json']), 1);
  assert.match(JSON.stringify(changed), /verification inputs changed|planning inputs changed/);
});

/** @id TEST-PLAN-CLI-003 @verifies REQ-PLAN-CLI-003 */
test('TEST-PLAN-CLI-003 context fixed point, shared owners, impact and exact UTF8 budgets', t => {
  const f = fixture(t);
  f.enable();
  assert.equal(plan(f).enabled, true, 'Enabled context requires the shared JSON model.');
  write(f.root, 'shared.md', 'shared ready 日本語\n');
  f.document.tasks.forEach(task => task.artifacts.push('shared.md'));
  f.save();
  const selected = json(call(f.root, ['context', 'a', '--json']));
  assert.deepEqual(selected.features.map(feature => feature.feature), ['a', 'b']);
  assert.deepEqual(selected.files.map(file => file.path), ['.sdd/specs/a.md', '.sdd/specs/b.md', 'a.md', 'b.md', 'shared.md']);
  assert.deepEqual(selected.planning.taskIds, ['A', 'B']);
  const rendered = call(f.root, ['context', 'a', '--json']).text, bytes = Buffer.byteLength(rendered);
  json(call(f.root, ['context', 'a', '--json', '--max-bytes', String(bytes)]));
  const overflow = call(f.root, ['context', 'a', '--json', '--max-bytes', String(bytes - 1)]);
  assert.equal(overflow.exit, 2);
  assert.doesNotMatch(overflow.text, /"text":|document shall contain/);
  assert.deepEqual(json(call(f.root, ['context', 'shared.md', '--json'])).planning.taskIds, ['A', 'B']);
  assert.deepEqual(json(call(f.root, ['context', 'a.test.mjs', '--json'])).features.map(feature => feature.feature), ['a', 'b']);
  write(f.root, 'unknown.txt', 'no owner\n');
  const unknown = call(f.root, ['context', 'unknown.txt', '--json']);
  assert.equal(unknown.exit, 2); assert.doesNotMatch(unknown.text, /"text":/);
  f.git('init', '-q'); f.commit();
  fs.appendFileSync(path.join(f.root, 'unknown.txt'), 'changed\n');
  const unowned = json(call(f.root, ['gate', '--changed', '--json']), 2);
  assert.match(JSON.stringify(unowned), /unknown\.txt.*owner|ownership.*unknown\.txt/);
  const graph = fixture(t);
  graph.enable();
  const a2 = structuredClone(graph.document.tasks[0]), b2 = structuredClone(graph.document.tasks[1]);
  a2.id = 'A2'; b2.id = 'B2';
  graph.document.tasks[0].dependsOn = ['B'];
  graph.document.tasks[0].dependencies = { B: '0'.repeat(64) };
  b2.dependsOn = ['A2']; b2.dependencies = { A2: '0'.repeat(64) };
  graph.document.tasks.push(a2, b2); graph.save();
  assert.deepEqual(json(call(graph.root, ['context', 'a', '--json'])).planning.taskIds, ['A', 'A2', 'B', 'B2'],
    'An acyclic task graph must not be rejected for its induced coarse feature cycle.');
});

/** @id TEST-PLAN-CLI-004 @verifies REQ-PLAN-CLI-004 */
test('TEST-PLAN-CLI-004 real native evidence, durable refusals and direct/wrapper verdict parity', t => {
  const f = fixture(t, { implementation: true });
  f.enable();
  assert.equal(plan(f).enabled, true, 'New command renderers must report the JSON planning decision.');
  const missing = json(call(f.root, ['plan', 'verify', 'A', '--json']), 2);
  assert.ok(missing.receipt, 'Missing native evidence preserves an explicit failed attempt.');
  const initialFailure = fs.readFileSync(path.join(f.root, missing.receipt), 'utf8');
  assert.equal(JSON.parse(initialFailure).exit, 2);
  f.native();
  const success = f.adopt('A');
  const receipt = JSON.parse(fs.readFileSync(path.join(f.root, success.receipt)));
  assert.equal(receipt.checks.length, 2, 'Explicit check plus actual guarded native TDD rerun.');
  assert.deepEqual(receipt.checks[1].argv.slice(2), ['tdd', 'refactor', 'TEST-FIX-A', '--root', f.root]);
  assert.ok(receipt.ledgerEvents[0].hashes.length >= 2);
  assert.equal(taskState(plan(f), 'A'), 'complete');
  const ledger = fs.readFileSync(path.join(f.root, '.sdd/tdd.jsonl'), 'utf8');
  f.config.testCmd[f.config.testCmd.indexOf('{id}(?![0-9A-Za-z])')] = '^unselected$'; f.configure();
  const zero = json(call(f.root, ['plan', 'verify', 'A', '--json']), 1);
  assert.ok(zero.receipt); assert.notEqual(zero.receipt, success.receipt);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, zero.receipt))).exit, 1);
  assert.equal(fs.readFileSync(path.join(f.root, '.sdd/tdd.jsonl'), 'utf8'), ledger, 'Zero-selection refusal cannot append fake native success.');
  f.config.testCmd[3] = '{id}(?![0-9A-Za-z])'; f.configure();
  f.adopt('A');
  const beforeCorruption = fs.readFileSync(path.join(f.root, '.sdd/tdd.jsonl'), 'utf8');
  const knownFingerprint = plan(f).tasks.find(task => task.id === 'A').fingerprint;
  write(f.root, '.sdd/tdd.jsonl', beforeCorruption + '{not parseable\n');
  const corrupt = json(call(f.root, ['plan', '--json']), 2);
  assert.equal(corrupt.status, 'INCOMPLETE');
  assert.equal(corrupt.tasks.find(task => task.id === 'A').fingerprint, knownFingerprint,
    'Unreadable ledger events cannot erase independently measurable current TEST bindings.');
  write(f.root, '.sdd/tdd.jsonl', beforeCorruption);
  f.adopt('A');
  assert.equal(fs.readFileSync(path.join(f.root, missing.receipt), 'utf8'), initialFailure, 'Recovery preserves the original failed receipt byte-for-byte.');
  assert.ok(fs.existsSync(path.join(f.root, zero.receipt)), 'Recovery never prunes the native refusal.');
  const intactLedger = fs.readFileSync(path.join(f.root, '.sdd/tdd.jsonl'), 'utf8');
  const broken = intactLedger.trimEnd().split('\n').map(line => JSON.parse(line));
  broken[0].hash = '0'.repeat(64);
  write(f.root, '.sdd/tdd.jsonl', broken.map(entry => JSON.stringify(entry)).join('\n') + '\n');
  assert.equal(json(call(f.root, ['plan', '--json']), 1).status, 'FAIL', 'A proven broken ledger hash chain is conclusive invalidity.');
  write(f.root, '.sdd/tdd.jsonl', intactLedger);
  const nativeTest = fs.readFileSync(path.join(f.root, 'a.test.mjs'), 'utf8');
  fs.unlinkSync(path.join(f.root, 'a.test.mjs'));
  assert.equal(json(call(f.root, ['plan', '--json']), 2).status, 'INCOMPLETE', 'Missing required native TEST bytes are unknown inputs.');
  write(f.root, 'a.test.mjs', nativeTest);
  assert.equal(taskState(plan(f), 'A'), 'complete', 'Restoring the exact TEST recovers existing evidence without rewriting history.');
  const t2 = fixture(t, { implementation: true });
  const t2Spec = fs.readFileSync(path.join(t2.root, '.sdd/specs/a.md'), 'utf8').replace('tier: T1', 'tier: T2')
    + '\n## Design\nThe ready marker is verified by an explicit selected test.\nFixture review data exercises the existing native approval protocol.\n';
  write(t2.root, '.sdd/specs/a.md', t2Spec);
  t2.document.tasks[0].specs['.sdd/specs/a.md'] = digest(t2Spec); t2.save();
  write(t2.root, '.sdd/review-a.md', `spec: sha256:${digest(t2Spec)}\nverdict: pass\nopen: 0\n`);
  assert.equal(call(t2.root, ['approve', 'record', 'a', '--by', 'ai:test-fixture', '--review', '.sdd/review-a.md']).exit, 0);
  t2.native(); t2.enable(); t2.adopt('A');
  const beforeWeakening = fs.readFileSync(path.join(t2.root, '.sdd/tdd.jsonl'), 'utf8');
  write(t2.root, 'a.test.mjs', fs.readFileSync(path.join(t2.root, 'a.test.mjs'), 'utf8').replace(',/ready/', ',/.*/'));
  const weakened = json(call(t2.root, ['plan', 'verify', 'A', '--json']), 1);
  assert.ok(weakened.receipt);
  assert.equal(fs.readFileSync(path.join(t2.root, '.sdd/tdd.jsonl'), 'utf8'), beforeWeakening,
    'Plan verification cannot use T2 refactor to bless an already stale TEST.');
  for (const args of [['plan', 'verify'], ['plan', 'verify', 'A', 'extra'], ['plan', 'check', 'extra'], ['plan', '--changed']]) {
    json(call(f.root, [...args, '--json']), 2);
  }
  const self = fixture(t);
  self.enable();
  write(self.root, 'sdd.mjs', "import fs from 'node:fs';fs.writeFileSync('executed.txt','ran');\n");
  self.document.tasks[0].checks = [{ name: 'aggregate', argv: [process.execPath, path.join(self.root, 'sdd.mjs'), 'gate'], timeoutMs: 20000 }];
  self.save();
  const refused = json(call(self.root, ['plan', 'verify', 'A', '--json']), 1);
  assert.ok(refused.errors.some(error => error.reason.includes('aggregate gate cannot establish task completion')));
  assert.equal(fs.existsSync(path.join(self.root, 'executed.txt')), false, 'A refused aggregate command must never execute.');
  const parity = fixture(t); parity.enable();
  for (const expected of [0, 1, 2]) {
    if (expected === 1) { parity.document.schemaVersion = 99; parity.save(); }
    if (expected === 2) fs.unlinkSync(path.join(parity.root, '.sdd/implementation-plan.json'));
    for (const args of [['plan', '--json'], ['plan', 'check', '--json']]) {
      const direct = json(call(parity.root, args), expected);
      assert.equal(direct.exit, expected, 'The JSON verdict must agree with the independently expected process exit.');
      assert.equal(direct.status, ['PASS', 'FAIL', 'INCOMPLETE'][expected]);
      assert.deepEqual(json(call(parity.root, args, wrapper), expected), direct);
      const humanArgs = args.filter(arg => arg !== '--json'), human = call(parity.root, humanArgs);
      assert.equal(human.exit, expected);
      assert.ok(human.text.includes(`SDD PLAN ${direct.status}`));
      if (expected === 0) for (const task of direct.tasks) {
        assert.ok(human.text.includes(task.id));
        for (const req of task.reqs) assert.ok(human.text.includes(req));
      }
      else {
        assert.ok(human.text.includes(direct.errors[0].id));
        assert.ok(human.text.includes(direct.errors[0].reason));
      }
      assert.deepEqual(call(parity.root, humanArgs, wrapper), human);
    }
  }
});

/** @id TEST-PLAN-CLI-005 @verifies REQ-PLAN-CLI-001 REQ-PLAN-CLI-004 */
test('TEST-PLAN-CLI-005 standalone legacy commands survive absent optional planning modules', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'musubix-plan-standalone-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const standalone = path.join(directory, 'sdd.mjs');
  fs.copyFileSync(script, standalone);
  const f = fixture(t);
  f.native();
  write(f.root, '.sdd/plan.md', '| order | feature | depends | note |\n| 1 | a | - | |\n| 2 | b | - | |\n');
  for (const args of [['plan'], ['gate', '--no-run', '--json']]) {
    assert.deepEqual(call(f.root, args, standalone), call(f.root, args),
      'A lone legacy script must retain its disabled-mode output and exit without optional siblings.');
  }
  for (const args of [['plan', 'check'], ['context', 'a']]) {
    const refused = json(call(f.root, [...args, '--json'], standalone), 2);
    assert.match(JSON.stringify(refused.errors), /planning modules unavailable/i);
  }
  fs.unlinkSync(path.join(f.root, '.sdd/config.json'));
  const missingConfig = call(f.root, ['plan']);
  assert.equal(missingConfig.exit, 0, 'An absent configuration retains disabled legacy planning.');
  assert.deepEqual(call(f.root, ['plan'], standalone), missingConfig);
  f.enable();
  for (const args of [['plan'], ['gate', '--no-run'], ['context', 'a']]) {
    const refused = json(call(f.root, [...args, '--json'], standalone), 2);
    assert.match(JSON.stringify(refused.errors), /planning modules unavailable/i);
  }
  const disabled = JSON.stringify({ ...f.config, planning: { required: false } });
  const shapes = [
    [JSON.stringify({ ...f.config, planning: undefined }), 0],
    [disabled, 0],
    [JSON.stringify({ ...f.config, planning: { required: false, features: null, extra: true } }), 0],
    ...[null, [], false, { required: 'false' }, { required: 0 }, { features: null }]
      .map(planning => [JSON.stringify({ ...f.config, planning }), 1]),
    ['null', 1], ['[]', 1], ['{', 1], ['\uFEFF' + disabled, 1],
    [Buffer.from([0xff]), 1],
    [disabled + ' '.repeat(1048576 - Buffer.byteLength(disabled)), 0],
    [disabled + ' '.repeat(1048577 - Buffer.byteLength(disabled)), 1],
  ];
  for (const partial of [false, true]) {
    if (partial) fs.copyFileSync(path.join(path.dirname(script), 'implementation-plan.mjs'),
      path.join(directory, 'implementation-plan.mjs'));
    for (const [configuration, expected] of shapes) {
      fs.writeFileSync(path.join(f.root, '.sdd/config.json'), configuration);
      const full = call(f.root, ['plan', '--json']);
      const lone = call(f.root, ['plan', '--json'], standalone);
      assert.equal(full.exit, expected);
      assert.equal(lone.exit, expected, `partial=${partial}: standalone policy agrees with contract table`);
      if (expected === 0) assert.deepEqual(lone, full, 'A proven disabled policy retains exact legacy behavior.');
      else {
        assert.equal(json(full, 1).enabled, true);
        assert.equal(json(lone, 1).enabled, true);
      }
      for (const args of [['gate', '--no-run'], ['context', 'a']]) {
        const bundled = call(f.root, [...args, '--json']);
        const copied = call(f.root, [...args, '--json'], standalone);
        if (expected === 1) {
          assert.equal(json(bundled, 1).enabled, true);
          assert.equal(json(copied, 1).enabled, true);
        } else if (args[0] === 'gate') {
          assert.equal(json(bundled, 2).verdict, 'INCOMPLETE');
          assert.deepEqual(copied, bundled);
        } else {
          assert.equal(json(bundled).kind, 'reading-context');
          assert.match(JSON.stringify(json(copied, 2).errors), /planning modules unavailable/i);
        }
      }
    }
    f.configure();
    assert.equal(json(call(f.root, ['plan', '--json'])).enabled, true);
    const enabled = json(call(f.root, ['plan', '--json'], standalone), 2);
    assert.match(JSON.stringify(enabled.errors), /planning modules unavailable/i);
  }
  write(f.root, 'config-target.json', disabled);
  fs.unlinkSync(path.join(f.root, '.sdd/config.json'));
  fs.symlinkSync(path.join(f.root, 'config-target.json'), path.join(f.root, '.sdd/config.json'));
  const inRootConfig = call(f.root, ['plan']);
  assert.equal(inRootConfig.exit, 0, 'A valid in-root configuration symlink must be accepted.');
  const copiedInRootConfig = call(f.root, ['plan'], standalone);
  assert.equal(copiedInRootConfig.exit, 0);
  assert.deepEqual(copiedInRootConfig, inRootConfig);
  fs.unlinkSync(path.join(f.root, '.sdd/config.json'));
  write(directory, 'outside-config.json', disabled);
  fs.symlinkSync(path.join(directory, 'outside-config.json'), path.join(f.root, '.sdd/config.json'));
  for (const entry of [script, standalone]) json(call(f.root, ['plan', '--json'], entry), 1);
  fs.unlinkSync(path.join(directory, 'outside-config.json'));
  for (const entry of [script, standalone]) json(call(f.root, ['plan', '--json'], entry), 1);
});
