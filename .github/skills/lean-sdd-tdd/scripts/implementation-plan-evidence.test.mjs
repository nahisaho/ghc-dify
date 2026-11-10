import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadImplementationPlan, planningSha256 as hash } from './implementation-plan.mjs';
import { deriveImplementationTaskState, evaluateImplementationPlan, verifyImplementationTask } from './implementation-plan-evidence.mjs';

function fixture(t, edges = [['B', 'A'], ['C', 'B']]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'musubix-plan-evidence-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.sdd/specs'), { recursive: true });
  const ids = ['A', 'B', 'C', 'D'];
  const specs = ids.map(id => {
    const file = `.sdd/specs/${id}.md`;
    fs.writeFileSync(path.join(root, file), `${id} independent specification\n`);
    fs.writeFileSync(path.join(root, `${id}.md`), `${id} ready\n`);
    return { feature: id, path: file, reqs: [{ id: `REQ-FIX-${id}`, tests: [] }], dependsOn: [] };
  });
  const document = { schemaVersion: 1, features: ids.map(id => ({ id, dependsOn: [] })),
    tasks: specs.map((spec, i) => ({
      id: ids[i], feature: spec.feature, kind: 'documentation', reqs: spec.reqs.map(r => r.id),
      dependsOn: edges.filter(([from]) => from === ids[i]).map(([, to]) => to),
      artifacts: [`${ids[i]}.md`], condition: 'The current document contains its required ready marker.',
      tests: [], checks: [{ name: 'document', argv: [process.execPath, '--input-type=module', '-e',
        `import fs from 'node:fs';if(!fs.readFileSync('${ids[i]}.md','utf8').includes('ready'))process.exit(1);`],
      timeoutMs: 10000 }],
      specs: { [spec.path]: hash(fs.readFileSync(path.join(root, spec.path))) },
      dependencies: Object.fromEntries(edges.filter(([from]) => from === ids[i]).map(([, to]) => [to, '0'.repeat(64)])),
      status: 'not-started', receipt: null,
    })) };
  let inspectionError = null, nativePass = true;
  const adapter = {
    inspect(task) {
      if (task.kind === 'documentation') return { bindings: {}, events: [], errors: [] };
      return {
        bindings: Object.fromEntries(task.tests.map(id => [id, { file: 'native.test.mjs',
          sha256: hash(fs.readFileSync(path.join(root, 'native.test.mjs'))) }])),
        events: task.tests.map(test => ({ test, hashes: [hash('native-red'), hash('native-green')] })),
        errors: inspectionError ? [{ id: task.id, reason: inspectionError, exit: 2 }] : [],
      };
    },
    nativeChecks(task) {
      return task.kind === 'documentation' ? [] : task.tests.map(id => ({
        name: `native-${id}`, argv: [process.execPath, '--test', '--test-name-pattern', id, 'native.test.mjs'],
        timeoutMs: 10000,
      }));
    },
    run(argv, timeoutMs) {
      const r = spawnSync(argv[0], argv.slice(1), { cwd: root, encoding: 'utf8', timeout: timeoutMs,
        maxBuffer: 8 * 1024 * 1024 });
      return { exit: nativePass || !argv.includes('--test') ? r.status : 1, signal: r.signal, timedOut: r.error?.code === 'ETIMEDOUT',
        text: (r.stdout ?? '') + (r.stderr ?? ''), error: r.error?.message ?? null };
    },
  };
  const save = () => fs.writeFileSync(path.join(root, '.sdd/implementation-plan.json'), JSON.stringify(document));
  const model = () => {
    save();
    const result = loadImplementationPlan({ root, config: { planning: { required: true } }, specs });
    assert.equal(result.exit, 0, JSON.stringify(result.errors));
    return result.model;
  };
  const evaluate = options => evaluateImplementationPlan({ model: model(), adapter, ...options });
  const row = (id, options) => evaluate(options).tasks.find(task => task.id === id);
  const bind = () => {
    const current = evaluate();
    assert.equal(current.tasks.length, document.tasks.length, 'Evaluation must report every selected task, even before implementation.');
    for (const task of document.tasks) task.dependencies = Object.fromEntries(task.dependsOn
      .map(id => [id, current.tasks.find(row => row.id === id).fingerprint]));
  };
  const verify = id => verifyImplementationTask({ model: model(), taskId: id, adapter });
  const complete = id => {
    const result = verify(id);
    assert.equal(result.exit, 0, JSON.stringify(result.errors));
    const task = document.tasks.find(task => task.id === id);
    task.status = 'complete';
    task.receipt = result.receipt;
    assert.equal(row(id).state, 'complete', JSON.stringify(row(id)));
    return result;
  };
  return { root, specs, document, adapter, model, evaluate, row, bind, verify, complete,
    inspectionError: value => { inspectionError = value; }, nativePass: value => { nativePass = value; } };
}
function tree(root) {
  const rows = [];
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else rows.push([path.relative(root, file), hash(fs.readFileSync(file))]);
    }
  }
  visit(root);
  return rows.sort(([a], [b]) => a.localeCompare(b));
}
function rewriteReceipt(root, relative, mutate) {
  const original = JSON.parse(fs.readFileSync(path.join(root, relative)));
  mutate(original);
  const bytes = JSON.stringify(original, null, 2) + '\n';
  const replacement = path.posix.join(path.posix.dirname(relative), hash(bytes) + '.json');
  fs.writeFileSync(path.join(root, replacement), bytes);
  return replacement;
}

/** @id TEST-PLAN-STATE-001 @verifies REQ-PLAN-STATE-001 */
test('TEST-PLAN-STATE-001 independently specified state precedence and honest completion', t => {
  const keys = ['bindingStale', 'prerequisiteStale', 'verificationRequired',
    'prerequisitePending', 'blocked', 'verified', 'started'];
  for (let mask = 0; mask < 128; mask++) {
    const facts = Object.fromEntries(keys.map((key, n) => [key, Boolean(mask & (1 << n))]));
    const expected = mask & 3 ? 'replan-required' : mask & 4 ? 'revalidation-required'
      : mask & 24 ? 'blocked' : mask & 32 ? 'complete' : mask & 64 ? 'in-progress' : 'not-started';
    assert.equal(deriveImplementationTaskState(facts), expected, `Independent precedence row ${mask}`);
  }
  const f = fixture(t);
  f.bind();
  for (const status of ['not-started', 'in-progress', 'blocked', 'complete']) {
    f.document.tasks[0].status = status;
    const expected = { 'not-started': 'not-started', 'in-progress': 'in-progress',
      blocked: 'blocked', complete: 'revalidation-required' }[status];
    assert.equal(f.row('A').state, expected, `Unattempted authored ${status}`);
    if (status === 'complete') assert.equal(f.row('A').exit, 2, 'No history cannot establish completion.');
    assert.equal(f.row('B').state, 'blocked');
  }
  f.document.tasks[0].status = 'in-progress';
  const result = f.verify('A');
  assert.equal(result.exit, 0, 'Actual explicit document verification is the positive control.');
  assert.equal(f.row('A').state, 'revalidation-required', 'A receipt must be explicitly adopted, not silently authored.');
  f.document.tasks[0].receipt = result.receipt;
  assert.equal(f.row('A').state, 'complete');
  f.complete('B');
  f.complete('C');
  for (const status of ['not-started', 'in-progress', 'blocked', 'complete']) {
    f.document.tasks[0].status = status;
    assert.equal(f.row('A').state, status === 'blocked' ? 'blocked' : 'complete');
  }
  f.document.tasks[0].status = 'not-started';
  f.document.tasks[0].receipt = null;
  assert.equal(f.row('A').state, 'revalidation-required', 'Clearing authored fields cannot hide observed history.');
  assert.equal(f.row('A').exit, 1);
  f.document.tasks[0].receipt = '.sdd/missing-receipt.json';
  assert.equal(f.row('A').exit, 2, 'Non-null missing reference takes precedence over other retained history.');
});

/** @id TEST-PLAN-STATE-002 @verifies REQ-PLAN-STATE-002 */
test('TEST-PLAN-STATE-002 exact stale closure across every bounded forward graph', t => {
  const possible = [['B', 'A'], ['C', 'A'], ['C', 'B']];
  for (let mask = 0; mask < 8; mask++) {
    const edges = possible.filter((_, n) => mask & (1 << n)), f = fixture(t, edges);
    f.bind();
    for (const id of ['A', 'B', 'C', 'D']) f.complete(id);
    fs.appendFileSync(path.join(f.root, f.specs[0].path), 'Changed contract.\n');
    const reached = new Set(['A']);
    for (let n = 0; n < 3; n++) for (const [from, to] of edges) if (reached.has(to)) reached.add(from);
    for (const id of ['A', 'B', 'C', 'D']) assert.equal(f.row(id).state,
      reached.has(id) ? 'replan-required' : 'complete', `graph=${mask},task=${id}`);
    f.document.tasks[0].specs[f.specs[0].path] = hash(fs.readFileSync(path.join(f.root, f.specs[0].path)));
    f.bind();
    for (const id of reached) assert.equal(f.row(id).state, 'replan-required',
      'Current own bindings cannot hide a structurally stale prerequisite.');
    for (const id of ['A', 'B', 'C']) if (reached.has(id)) {
      assert.notEqual(f.row(id).state, 'complete', 'Revalidating a prerequisite does not silently revalidate its dependents.');
      f.complete(id);
    }
    assert.equal(f.row('D').state, 'complete');
  }
});

/** @id TEST-PLAN-STATE-003 @verifies REQ-PLAN-STATE-003 */
test('TEST-PLAN-STATE-003 current native evidence, selected checks and retained failure heads', t => {
  const f = fixture(t, []), task = f.document.tasks[0];
  task.kind = 'implementation';
  task.tests = ['TEST-NATIVE-001'];
  f.specs[0].reqs[0].tests = [...task.tests];
  fs.writeFileSync(path.join(f.root, 'native.test.mjs'),
    "import {test} from 'node:test';import assert from 'node:assert/strict';test('TEST-NATIVE-001 selected',()=>assert.equal(1,1));\n");
  task.artifacts.push('native.test.mjs');
  f.inspectionError('No current Red/Green exists.');
  assert.equal(f.verify('A').exit, 2, 'Arbitrary successful document checks cannot replace native TDD evidence.');
  f.inspectionError(null);
  const nativeInspection = f.adapter.inspect, nativeRunner = f.adapter.run;
  let preflightRuns = 0;
  f.adapter.inspect = task => ({ ...nativeInspection(task),
    errors: [{ id: task.id, reason: 'Current native TEST is conclusively stale.', exit: 1 }] });
  f.adapter.run = (...args) => { preflightRuns++; return nativeRunner(...args); };
  const stalePreflight = f.verify('A');
  assert.equal(stalePreflight.exit, 1, 'A conclusive native preflight failure must retain fail1, not become unknown2.');
  assert.equal(preflightRuns, 0, 'Stale native evidence cannot be repaired by automatically executing Refactor.');
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, stalePreflight.receipt))).exit, 1);
  f.adapter.inspect = nativeInspection; f.adapter.run = nativeRunner;
  const original = f.complete('A');
  const knownAInput = f.row('A').fingerprint;
  f.document.tasks[1].dependsOn = ['A'];
  f.document.tasks[1].dependencies = { A: knownAInput };
  f.adapter.inspect = task => ({ ...nativeInspection(task),
    bindings: Object.fromEntries(task.tests.map(id => [id, null])),
    errors: [{ id: task.id, reason: 'Required native TEST bytes are unavailable.', exit: 2 }] });
  assert.equal(f.row('A').exit, 2, 'Unmeasurable TEST bindings are unknown, not a proven fingerprint change.');
  assert.equal(f.row('B').exit, 2, 'An unknown prerequisite input cannot manufacture conclusive dependency staleness.');
  assert.equal(f.row('B').state, 'revalidation-required');
  f.adapter.inspect = nativeInspection;
  f.document.tasks[1].dependsOn = []; f.document.tasks[1].dependencies = {};
  assert.equal(fs.existsSync(path.join(f.root, path.posix.dirname(original.receipt), 'verify.lock')), false);
  f.nativePass(false);
  const failedNative = f.verify('A');
  assert.equal(failedNative.exit, 1);
  assert.match(JSON.parse(fs.readFileSync(path.join(f.root, failedNative.receipt))).checks.at(-1).name, /^native-/);
  assert.equal(fs.existsSync(path.join(f.root, path.posix.dirname(original.receipt), 'verify.lock')), false);
  assert.equal(f.row('A').state, 'revalidation-required');
  assert.equal(f.row('A').exit, 1, 'An older successful authored reference cannot beat the latest failed attempt.');
  assert.ok(fs.existsSync(path.join(f.root, original.receipt)), 'Never overwrite the old success.');
  f.nativePass(true);
  f.complete('A');
  fs.appendFileSync(path.join(f.root, 'A.md'), 'new implementation bytes\n');
  assert.equal(f.row('A').state, 'revalidation-required');
  assert.equal(f.row('A').exit, 1);
  fs.unlinkSync(path.join(f.root, 'A.md'));
  assert.equal(f.row('A').exit, 2, 'A missing current artifact is incomplete, not a successful stale comparison.');
  fs.appendFileSync(path.join(f.root, f.specs[0].path), 'Structural change.\n');
  assert.equal(f.row('A').state, 'replan-required');
  assert.equal(f.row('A').exit, 1, 'Structural staleness has precedence even when an output is missing.');

  const metadata = fixture(t, []), implementation = metadata.document.tasks[0];
  implementation.kind = 'implementation';
  implementation.tests = ['TEST-NATIVE-001'];
  metadata.specs[0].reqs[0].tests = [...implementation.tests];
  fs.writeFileSync(path.join(metadata.root, 'native.test.mjs'), 'A native binding.\n');
  let executions = 0;
  metadata.adapter.run = () => { executions++; return { exit: 0, signal: null, timedOut: false, error: null, text: '' }; };
  metadata.adapter.nativeChecks = () => [{ name: 'large', argv: [process.execPath, 'x'.repeat(1048576)],
    timeoutMs: 1000 }];
  const refused = metadata.verify('A');
  assert.equal(refused.exit, 2);
  assert.equal(executions, 0);
  assert.ok(fs.existsSync(path.join(metadata.root, refused.receipt)));
  assert.ok(fs.statSync(path.join(metadata.root, refused.receipt)).size < 1048576);
  assert.equal(metadata.row('A').state, 'revalidation-required', 'A written compact refusal counts as an attempt.');
  assert.equal(metadata.row('A').exit, 1, 'A cleared authored reference cannot hide the compact refusal.');
  const protocol = [];
  for (const mode of ['missing-events', 'unparseable-runner', 'setup-error']) {
    const invalid = fixture(t, []), task = invalid.document.tasks[0];
    task.kind = 'implementation';
    task.tests = ['TEST-NATIVE-001'];
    invalid.specs[0].reqs[0].tests = [...task.tests];
    fs.writeFileSync(path.join(invalid.root, 'native.test.mjs'),
      "import {test} from 'node:test';test('TEST-NATIVE-001 selected',()=>{});\n");
    if (mode === 'missing-events') {
      const inspect = invalid.adapter.inspect;
      invalid.adapter.inspect = task => ({ ...inspect(task), events: [] });
    } else if (mode === 'unparseable-runner') invalid.adapter.run = () => ({});
    else invalid.adapter.run = () => { const error = new Error('native launcher missing'); error.code = 'ENOENT'; throw error; };
    const result = invalid.verify('A');
    protocol.push({ mode, exit: result.exit, retained: typeof result.receipt === 'string'
      && fs.existsSync(path.join(invalid.root, result.receipt)) });
  }
  assert.deepEqual(protocol, ['missing-events', 'unparseable-runner', 'setup-error']
    .map(mode => ({ mode, exit: 2, retained: true })),
  'Missing native evidence and execution protocol failures must preserve incomplete attempts, never return success.');
  const changedDuring = [];
  for (const mode of ['definition', 'history', 'dependency']) {
    const changing = fixture(t);
    changing.bind();
    const prior = changing.complete('A'), execute = changing.adapter.run;
    changing.adapter.run = (...args) => {
      const result = execute(...args);
      if (mode === 'history') {
        const receipt = JSON.parse(fs.readFileSync(path.join(changing.root, prior.receipt)));
        fs.appendFileSync(path.join(changing.root, receipt.checks[0].log.path), 'changed evidence\n');
      } else {
        if (mode === 'definition') changing.document.tasks[0].condition = 'Changed while verification executes.';
        else changing.document.tasks[0].receipt = null;
        fs.writeFileSync(path.join(changing.root, '.sdd/implementation-plan.json'), JSON.stringify(changing.document));
      }
      return result;
    };
    const result = changing.verify(mode === 'dependency' ? 'B' : 'A');
    changedDuring.push({ mode, exit: result.exit, retained: typeof result.receipt === 'string'
      && fs.existsSync(path.join(changing.root, result.receipt)) });
  }
  assert.deepEqual(changedDuring, ['definition', 'history', 'dependency'].map(mode => ({ mode, exit: 1, retained: true })),
    'After-execution validation must reread actual definitions, prerequisite state and evidence, not reuse the model snapshot.');
  for (const hashes of [[], ['not-a-ledger-hash']]) {
    const changing = fixture(t, []), task = changing.document.tasks[0];
    task.kind = 'implementation';
    task.tests = ['TEST-NATIVE-001'];
    changing.specs[0].reqs[0].tests = [...task.tests];
    fs.writeFileSync(path.join(changing.root, 'native.test.mjs'),
      "import {test} from 'node:test';test('TEST-NATIVE-001 selected',()=>{});\n");
    const inspect = changing.adapter.inspect, execute = changing.adapter.run;
    let executed = false;
    changing.adapter.run = (...args) => { executed = true; return execute(...args); };
    changing.adapter.inspect = task => {
      const current = inspect(task);
      return executed ? { ...current, events: [...current.events, { test: 'TEST-EXTRA-001', hashes }] } : current;
    };
    const refused = changing.verify('A');
    assert.equal(refused.exit, 2, 'Corrupted post-run native events cannot establish completion.');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(changing.root, refused.receipt))).ledgerEvents, [],
      'An incomplete receipt must not poison immutable history with malformed native events.');
    changing.adapter.inspect = inspect;
    changing.adapter.run = execute;
    changing.complete('A');
    assert.ok(fs.existsSync(path.join(changing.root, refused.receipt)),
      'Restoring valid native evidence must recover without pruning the failed attempt.');
  }
});

/** @id TEST-PLAN-STATE-004 @verifies REQ-PLAN-STATE-004 */
test('TEST-PLAN-STATE-004 immutable history, bounded parsing, read-only views and explicit doc checks', t => {
  const f = fixture(t, []);
  const originalRun = f.adapter.run;
  f.adapter.run = (argv, timeoutMs) => {
    const owner = JSON.parse(fs.readFileSync(path.join(f.root, '.sdd/plan-evidence', hash('A'), 'verify.lock/owner.json')));
    assert.equal(owner.task, 'A');
    assert.equal(owner.ownerPid, process.pid);
    return originalRun(argv, timeoutMs);
  };
  const first = f.complete('A');
  f.adapter.run = originalRun;
  f.model();
  const before = tree(f.root);
  for (let n = 0; n < 3; n++) evaluateImplementationPlan({ model: loadImplementationPlan({
    root: f.root, config: { planning: { required: true } }, specs: f.specs }).model, adapter: f.adapter });
  assert.deepEqual(tree(f.root), before, 'Evaluation cannot edit plans, evidence or ledger.');
  f.document.tasks[0].condition = 'Updated completion criterion.';
  assert.equal(f.row('A').state, 'replan-required');
  f.complete('A');
  const taskDirectory = path.posix.dirname(first.receipt);
  fs.mkdirSync(path.join(f.root, taskDirectory, 'verify.lock'));
  const locked = tree(f.root);
  assert.equal(f.verify('A').exit, 2, 'Busy or abandoned locks must not be stolen.');
  f.model();
  assert.deepEqual(tree(f.root), locked);
  assert.equal(f.verify('D').exit, 0, 'Another task remains independently usable while A is locked.');
  assert.ok(fs.existsSync(path.join(f.root, taskDirectory, 'verify.lock')), 'Never recover another task lock.');
  fs.rmdirSync(path.join(f.root, taskDirectory, 'verify.lock'));
  for (const owner of ['{', 'null', JSON.stringify({ task: 'A', ownerPid: process.pid, nonce: 'changed-owner' })]) {
    const changing = fixture(t, []), execute = changing.adapter.run;
    const lock = path.join(changing.root, '.sdd/plan-evidence', hash('A'), 'verify.lock');
    changing.adapter.run = (...args) => {
      const result = execute(...args);
      fs.writeFileSync(path.join(lock, 'owner.json'), owner);
      return result;
    };
    let result;
    assert.doesNotThrow(() => { result = changing.verify('A'); },
      'Malformed or changed lock ownership must return an explicit incomplete verdict, not throw.');
    assert.equal(result.exit, 2);
    assert.equal(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8'), owner,
      'Failed ownership validation must preserve the lock for explicit owner-confirmed recovery.');
  }
  const good = f.document.tasks[0].receipt;
  const corrupted = rewriteReceipt(f.root, good, receipt => { receipt.sequence += 1; });
  f.document.tasks[0].receipt = corrupted;
  assert.equal(f.row('A').exit, 1, 'A well-hashed fork/gap is invalid, not successful history.');
  fs.unlinkSync(path.join(f.root, corrupted));
  f.document.tasks[0].receipt = good;
  const bytes = fs.readFileSync(path.join(f.root, good));
  fs.writeFileSync(path.join(f.root, good), '{');
  assert.equal(f.row('A').exit, 2, 'Unparseable evidence is incomplete.');
  fs.writeFileSync(path.join(f.root, good), bytes);
  assert.equal(f.row('A').state, 'complete', 'Exact restoration recovers the valid control.');
  const oversized = Buffer.concat([bytes, Buffer.alloc(1048577 - bytes.length, 32)]);
  const oversizedPath = path.posix.join(path.posix.dirname(good), hash(oversized) + '.json');
  fs.renameSync(path.join(f.root, good), path.join(f.root, good + '.held'));
  fs.writeFileSync(path.join(f.root, oversizedPath), oversized);
  f.document.tasks[0].receipt = oversizedPath;
  assert.equal(f.row('A').exit, 2, 'Oversized receipt cannot be silently parsed or truncated.');
  fs.unlinkSync(path.join(f.root, oversizedPath));
  fs.renameSync(path.join(f.root, good + '.held'), path.join(f.root, good));
  f.document.tasks[0].receipt = good;
  const last = JSON.parse(bytes);
  const log = path.join(f.root, last.checks[0].log.path);
  const logBytes = fs.readFileSync(log);
  fs.appendFileSync(log, 'tampered');
  assert.equal(f.row('A').exit, 1);
  fs.writeFileSync(log, logBytes);
  assert.equal(f.row('A').state, 'complete');
  fs.writeFileSync(path.join(f.root, 'A.md'), 'no required marker\n');
  assert.equal(f.verify('A').exit, 1, 'Documentation requires an actual successful explicit check.');
  for (const target of ['A.md', '.sdd/specs/A.md']) {
    const changing = fixture(t, []), execute = changing.adapter.run;
    changing.adapter.run = (...args) => {
      const result = execute(...args);
      fs.appendFileSync(path.join(changing.root, target), 'Changed during verification.\n');
      return result;
    };
    const refused = changing.verify('A');
    assert.equal(refused.exit, 1, `Verification must compare actual before/after bytes: ${target}`);
    assert.match(JSON.stringify(refused.errors), /inputs.*changed/i);
  }

  const output = fixture(t, []);
  output.adapter.run = () => ({ exit: 0, signal: null, timedOut: false, error: null, text: 'x'.repeat(8388609) });
  const overflow = output.verify('A');
  assert.equal(overflow.exit, 2, 'Output overflow is incomplete even when the child claims exit0.');
  const overflowReceipt = JSON.parse(fs.readFileSync(path.join(output.root, overflow.receipt)));
  assert.equal(overflowReceipt.checks[0].log.bytes, 8388608);
  assert.match(JSON.stringify(overflowReceipt.errors), /output|truncat|budget/i);

  const cumulative = fixture(t, []);
  let previous = cumulative.complete('A').receipt;
  const buffer = Buffer.alloc(8388608), logHash = hash(buffer);
  for (let n = 0; n < 9; n++) {
    const log = path.posix.join(path.posix.dirname(previous), `budget-${n}.log`);
    fs.writeFileSync(path.join(cumulative.root, log), buffer);
    const parent = previous;
    previous = rewriteReceipt(cumulative.root, previous, receipt => {
      receipt.sequence++;
      receipt.previous = path.posix.basename(parent, '.json');
      receipt.checks[0].log = { path: log, sha256: logHash, bytes: buffer.length };
    });
    cumulative.document.tasks[0].receipt = previous;
    if (n === 5) assert.equal(cumulative.row('A').state, 'complete', '48MiB history is a valid bounded control.');
  }
  assert.equal(cumulative.row('A').exit, 2, 'Cumulative history over64MiB is incomplete, not a partial pass.');

  const capacity = fixture(t, []);
  let latest = capacity.complete('A').receipt;
  const capacityDirectory = path.join(capacity.root, path.posix.dirname(latest));
  for (let n = 1; n < 4095; n++) {
    const parent = latest;
    latest = rewriteReceipt(capacity.root, latest, receipt => {
      receipt.sequence++;
      receipt.previous = path.posix.basename(parent, '.json');
    });
  }
  capacity.document.tasks[0].receipt = latest;
  assert.equal(capacity.row('A').state, 'complete', '4095 genuine chained receipts are a valid control.');
  let calls = 0;
  const capacityRun = capacity.adapter.run;
  capacity.adapter.run = (...args) => { calls++; return capacityRun(...args); };
  const lastAllowed = capacity.verify('A');
  assert.equal(lastAllowed.exit, 0, '4095 receipts still allow the actual final verification.');
  assert.equal(calls, 1);
  capacity.document.tasks[0].receipt = lastAllowed.receipt;
  assert.equal(capacity.row('A').state, 'complete', 'Exactly4096 remains a valid complete history.');
  calls = 0;
  const retained = fs.readdirSync(capacityDirectory).sort();
  assert.equal(capacity.verify('A').exit, 2);
  assert.equal(calls, 0);
  assert.deepEqual(fs.readdirSync(capacityDirectory).sort(), retained, 'Capacity refusal cannot append or prune evidence.');
  capacity.document.tasks[0].receipt = rewriteReceipt(capacity.root, lastAllowed.receipt, receipt => {
    receipt.sequence++;
    receipt.previous = path.posix.basename(lastAllowed.receipt, '.json');
  });
  assert.equal(capacity.row('A').exit, 2, 'History-count overflow is incomplete before consuming partial history.');
});
