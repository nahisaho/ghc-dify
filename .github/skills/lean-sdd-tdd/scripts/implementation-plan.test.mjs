import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { loadImplementationPlan } from './implementation-plan.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const clone = value => structuredClone(value);
const modelPath = '.sdd/implementation-plan.json';
const ids = ['A', 'B', 'C'];
function referenceDefinition(task) {
  return hash(JSON.stringify({
    id: task.id, feature: task.feature, kind: task.kind, reqs: [...task.reqs].sort(),
    dependsOn: [...task.dependsOn].sort(), artifacts: [...task.artifacts].sort(),
    condition: task.condition, tests: [...task.tests].sort(),
    checks: task.checks.map(check => ({ name: check.name, argv: check.argv, timeoutMs: check.timeoutMs })),
    specs: Object.entries(task.specs).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0),
  }));
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'musubix-plan-model-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.sdd/specs'), { recursive: true });
  const specs = ids.map(id => {
    const file = `.sdd/specs/${id.toLowerCase()}.md`;
    const reqs = [1, ...(id === 'A' ? [2] : [])].map(n => ({
      id: `REQ-FIX-${id}-${n}`, tests: [`TEST-FIX-${id}-${n}`], deferred: false,
    }));
    fs.writeFileSync(path.join(root, file), `feature ${id}\n` + reqs.map(r => `${r.id}: ${r.tests[0]}`).join('\n') + '\n');
    return { feature: id.toLowerCase(), path: file, reqs, dependsOn: [] };
  });
  fs.writeFileSync(path.join(root, 'shared.mjs'), 'export const value = 1;\n');
  const tasks = specs.map((spec, i) => ({
    id: ids[i], feature: spec.feature, kind: 'implementation',
    reqs: spec.reqs.map(r => r.id), dependsOn: [], artifacts: ['shared.mjs'],
    condition: 'Current declared verification succeeds.',
    tests: spec.reqs.flatMap(r => r.tests),
    checks: [{ name: 'check', argv: [process.execPath, '--version'], timeoutMs: 1000 }],
    specs: { [spec.path]: hash(fs.readFileSync(path.join(root, spec.path))) },
    dependencies: {}, status: 'not-started', receipt: null,
  }));
  tasks.push({ ...clone(tasks[0]), id: 'D', reqs: ['REQ-FIX-A-2'], tests: ['TEST-FIX-A-2'] });
  const document = { schemaVersion: 1, features: specs.map(s => ({ id: s.feature, dependsOn: [] })), tasks };
  const config = { planning: { required: true } };
  const save = value => fs.writeFileSync(path.join(root, modelPath), JSON.stringify(value));
  const run = (value = document, policy = config, metadata = specs) => {
    save(value);
    return loadImplementationPlan({ root, config: policy, specs: metadata });
  };
  return { root, specs, document, config, run, save };
}
function expectResult(result, status, exit, reason) {
  assert.equal(result.status, status, reason ?? JSON.stringify(result.errors));
  assert.equal(result.exit, exit, reason ?? JSON.stringify(result.errors));
  if (exit) assert.ok(result.errors.length, 'Refusal must report its reason.');
  return result;
}
function invalid(f, mutate, reason) {
  const document = clone(f.document);
  mutate(document);
  return expectResult(f.run(document), 'FAIL', 1, reason);
}
function bind(document) {
  for (const task of document.tasks) {
    const direct = new Set(document.features.find(f => f.id === task.feature).dependsOn);
    for (const feature of direct) for (const dependency of document.features.find(f => f.id === feature).dependsOn) direct.add(dependency);
    const deps = [...new Set([...task.dependsOn,
      ...document.tasks.filter(t => direct.has(t.feature)).map(t => t.id)])].sort();
    task.dependencies = Object.fromEntries(deps.map(id => [id, referenceDefinition(document.tasks.find(t => t.id === id))]));
  }
  return document;
}
function graphHasCycle(edges) {
  // Independent three-node oracle: a closed walk of length <=3 is exactly a cycle.
  return ids.some(start => {
    let frontier = [start];
    for (let n = 0; n < 3; n++) {
      frontier = frontier.flatMap(id => edges.filter(([from]) => from === id).map(([, to]) => to));
      if (frontier.includes(start)) return true;
    }
    return false;
  });
}

/** @id TEST-PLAN-MODEL-001 @verifies REQ-PLAN-MODEL-001 */
test('TEST-PLAN-MODEL-001 authoritative JSON, opt-in and explicit bounded input refusals', t => {
  const f = fixture(t);
  expectResult(f.run(), 'PASS', 0);
  fs.unlinkSync(path.join(f.root, modelPath));
  expectResult(loadImplementationPlan({ root: f.root, config: f.config, specs: f.specs }),
    'INCOMPLETE', 2, 'Enabled mode must refuse a missing JSON plan.');
  for (const config of [{}, { planning: { required: false } }]) {
    expectResult(loadImplementationPlan({ root: f.root, config, specs: f.specs }), 'DISABLED', 0);
    assert.equal(fs.existsSync(path.join(f.root, modelPath)), false);
  }
  for (const raw of ['{', 'null', '[]', '{}', '{"schemaVersion":2,"features":[],"tasks":[]}']) {
    fs.writeFileSync(path.join(f.root, modelPath), raw);
    expectResult(loadImplementationPlan({ root: f.root, config: f.config, specs: f.specs }), 'FAIL', 1);
    assert.equal(fs.readFileSync(path.join(f.root, modelPath), 'utf8'), raw);
  }
  invalid(f, d => { d.schemaVersion = 2; }, 'An otherwise valid unsupported schema must refuse.');
  const invalidUtf8 = Buffer.from(JSON.stringify(f.document));
  const conditionOffset = invalidUtf8.indexOf(Buffer.from('Current declared verification succeeds.'));
  assert.ok(conditionOffset >= 0);
  invalidUtf8[conditionOffset] = 255;
  fs.writeFileSync(path.join(f.root, modelPath), invalidUtf8);
  expectResult(loadImplementationPlan({ root: f.root, config: f.config, specs: f.specs }),
    'FAIL', 1, 'Malformed UTF-8 must not silently become replacement-character JSON.');
  const unicodeControl = clone(f.document);
  unicodeControl.tasks[0].condition = '\ufffd is a valid explicitly encoded character.';
  expectResult(f.run(unicodeControl), 'PASS', 0);
  invalid(f, d => { d.optional = true; });
  for (const policy of [
    { planning: null }, { planning: { required: 'true' } },
    { planning: { required: true, unknown: true } }, { planning: { required: true, features: [] } },
  ]) expectResult(f.run(f.document, policy), 'FAIL', 1);
  expectResult(f.run(f.document, { planning: { required: true, features: ['missing'] } }), 'INCOMPLETE', 2);
  const manyFeatures = clone(f.document), metadata = clone(f.specs);
  for (let n = 3; n < 256; n++) {
    const feature = 'f' + n, file = `.sdd/specs/${feature}.md`;
    fs.writeFileSync(path.join(f.root, file), 'No active requirements.\n');
    manyFeatures.features.push({ id: feature, dependsOn: [] });
    metadata.push({ feature, path: file, reqs: [], dependsOn: [] });
  }
  expectResult(f.run(manyFeatures, f.config, metadata), 'PASS', 0);
  fs.writeFileSync(path.join(f.root, '.sdd/specs/excess.md'), 'No active requirements.\n');
  metadata.push({ feature: 'excess', path: '.sdd/specs/excess.md', reqs: [], dependsOn: [] });
  manyFeatures.features.push({ id: 'excess', dependsOn: [] });
  expectResult(f.run(manyFeatures, f.config, metadata), 'FAIL', 1);
  const oneSpec = [{ ...clone(f.specs[0]), reqs: [clone(f.specs[0].reqs[0])] }];
  const compact = { schemaVersion: 1, features: [{ id: 'a', dependsOn: [] }],
    tasks: Array.from({ length: 2048 }, (_, n) => ({
      ...clone(f.document.tasks[0]), id: String(n), reqs: ['REQ-FIX-A-1'], tests: ['TEST-FIX-A-1'],
      artifacts: ['x'], condition: 'x', checks: [{ name: 'x', argv: ['node'], timeoutMs: 1 }],
    })) };
  assert.ok(Buffer.byteLength(JSON.stringify(compact)) <= 1048576, 'Task-count boundary must fit the separate byte limit.');
  expectResult(f.run(compact, f.config, oneSpec), 'PASS', 0);
  compact.tasks.push({ ...clone(compact.tasks[0]), id: '2048' });
  expectResult(f.run(compact, f.config, oneSpec), 'FAIL', 1);
  const serialized = JSON.stringify(f.document);
  fs.writeFileSync(path.join(f.root, modelPath), serialized + ' '.repeat(1048576 - Buffer.byteLength(serialized)));
  expectResult(loadImplementationPlan({ root: f.root, config: f.config, specs: f.specs }), 'PASS', 0);
  fs.appendFileSync(path.join(f.root, modelPath), ' ');
  expectResult(loadImplementationPlan({ root: f.root, config: f.config, specs: f.specs }), 'FAIL', 1);
  fs.unlinkSync(path.join(f.root, modelPath));
  fs.mkdirSync(path.join(f.root, modelPath));
  expectResult(loadImplementationPlan({ root: f.root, config: f.config, specs: f.specs }), 'FAIL', 1);
});

/** @id TEST-PLAN-MODEL-002 @verifies REQ-PLAN-MODEL-002 */
test('TEST-PLAN-MODEL-002 exact ownership and externally determined active-REQ coverage', t => {
  const f = fixture(t);
  expectResult(f.run(), 'PASS', 0, 'Many-to-many REQ/task relationships must be accepted.');
  invalid(f, d => { d.tasks.push(clone(d.tasks[0])); }, 'Duplicate task A must refuse.');
  invalid(f, d => { d.features.push(clone(d.features[0])); });
  invalid(f, d => { d.tasks[0].feature = ['a', 'b']; });
  invalid(f, d => { d.tasks[0].feature = 'unknown'; });
  const unknown = invalid(f, d => { d.tasks.push({ ...clone(d.tasks[0]), id: 'E', reqs: ['REQ-UNKNOWN-1'] }); });
  assert.match(unknown.errors.map(e => e.reason).join(' '), /REQ-UNKNOWN-1/);
  invalid(f, d => { d.tasks.push({ ...clone(d.tasks[1]), id: 'E', feature: 'a' }); },
    'Foreign-REQ ownership must fail even while the original owners retain full coverage.');
  invalid(f, d => { d.tasks[0].optional = true; });
  invalid(f, d => { d.tasks[0].deferred = true; });
  invalid(f, d => { d.tasks = d.tasks.filter(task => task.id !== 'B'); });
  invalid(f, d => { d.features = d.features.filter(feature => feature.id !== 'b'); d.tasks = d.tasks.filter(task => task.id !== 'B'); });
  invalid(f, d => { d.tasks[0].reqs = ['REQ-FIX-A-1', 'REQ-FIX-A-1']; });
  invalid(f, d => { d.tasks[0].id = 'x'.repeat(129); });
  invalid(f, d => { d.tasks[0].id = '../task'; });
  const lengthBoundary = clone(f.document);
  lengthBoundary.tasks[0].id = 'x'.repeat(128);
  expectResult(f.run(lengthBoundary), 'PASS', 0);
  const scoped = clone(f.document);
  scoped.features = scoped.features.filter(feature => feature.id !== 'c');
  scoped.tasks = scoped.tasks.filter(task => task.id !== 'C');
  expectResult(f.run(scoped, { planning: { required: true, features: ['a', 'b'] } }), 'PASS', 0);
  expectResult(f.run(scoped), 'FAIL', 1, 'Default scope cannot be narrowed by omitting JSON feature c.');
  const metadata = clone(f.specs);
  metadata[2].reqs[0].deferred = true;
  const deferred = clone(f.document);
  deferred.tasks = deferred.tasks.filter(task => task.id !== 'C');
  const result = expectResult(f.run(deferred, f.config, metadata), 'PASS', 0);
  assert.deepEqual(result.model.exclusions, ['REQ-FIX-C-1']);
  const duplicateReqs = clone(f.specs);
  duplicateReqs[1].reqs[0].id = duplicateReqs[0].reqs[0].id;
  expectResult(f.run(f.document, f.config, duplicateReqs), 'FAIL', 1);
});

/** @id TEST-PLAN-MODEL-003 @verifies REQ-PLAN-MODEL-003 */
test('TEST-PLAN-MODEL-003 independent graph oracle, implicit prerequisites and blocking IDs', t => {
  const f = fixture(t);
  expectResult(f.run(), 'PASS', 0);
  invalid(f, d => { d.tasks[0].dependsOn = ['A']; d.tasks[0].dependencies = { A: '0'.repeat(64) }; },
    'A self-dependency must refuse, not become runnable.');
  invalid(f, d => { d.tasks[0].dependsOn = ['MISSING']; d.tasks[0].dependencies = { MISSING: '0'.repeat(64) }; });
  invalid(f, d => { d.features[0].dependsOn = ['a']; });
  invalid(f, d => { d.features[0].dependsOn = ['unknown']; });
  invalid(f, d => { d.features[0].dependsOn = ['b']; d.features[1].dependsOn = ['a']; });
  const bridgeMetadata = clone(f.specs), bridge = clone(f.document);
  bridgeMetadata[0].dependsOn = ['b'];
  bridgeMetadata[1].dependsOn = ['c'];
  bridgeMetadata[1].reqs.forEach(req => { req.deferred = true; });
  bridge.features[0].dependsOn = ['b'];
  bridge.features[1].dependsOn = ['c'];
  bridge.tasks = bridge.tasks.filter(task => task.feature !== 'b');
  const throughEmpty = expectResult(f.run(bind(bridge), { planning: { required: true, features: ['a'] } }, bridgeMetadata),
    'PASS', 0, 'A task-less prerequisite feature must not drop transitive task obligations.');
  assert.deepEqual(throughEmpty.model.tasks.find(task => task.id === 'A').effectiveDeps, ['C']);
  assert.deepEqual(throughEmpty.model.tasks.find(task => task.id === 'D').effectiveDeps, ['C']);
  const candidates = ids.flatMap(from => ids.filter(to => to !== from).map(to => [from, to]));
  for (let mask = 0; mask < 64; mask++) {
    const edges = candidates.filter((_, n) => mask & (1 << n));
    const document = clone(f.document);
    for (const task of document.tasks) task.dependsOn = edges.filter(([from]) => from === task.id).map(([, to]) => to);
    const result = f.run(bind(document));
    const cycle = graphHasCycle(edges);
    expectResult(result, cycle ? 'FAIL' : 'PASS', cycle ? 1 : 0, `Graph mask=${mask}`);
    if (cycle) assert.ok(result.errors.some(error => ids.includes(error.id)), 'Cycle refusal must identify an actual blocking task ID.');
  }
  for (let mask = 0; mask < 64; mask++) {
    const edges = candidates.filter((_, n) => mask & (1 << n));
    const document = clone(f.document);
    for (const feature of document.features) {
      feature.dependsOn = edges.filter(([from]) => from.toLowerCase() === feature.id).map(([, to]) => to.toLowerCase());
    }
    const cycle = graphHasCycle(edges);
    expectResult(f.run(bind(document)), cycle ? 'FAIL' : 'PASS', cycle ? 1 : 0, `Feature graph mask=${mask}`);
  }
  const metadata = clone(f.specs);
  metadata[1].dependsOn = ['a'];
  expectResult(f.run(f.document, { planning: { required: true, features: ['b'] } }, metadata), 'FAIL', 1,
    'JSON cannot drop specification-owned feature prerequisites.');
  const document = clone(f.document);
  document.features[1].dependsOn = ['a'];
  const result = expectResult(f.run(bind(document), { planning: { required: true, features: ['b'] } }, metadata), 'PASS', 0);
  assert.deepEqual(result.model.scope, ['a', 'b']);
  const b = result.model.tasks.find(task => task.id === 'B');
  assert.deepEqual(b.effectiveDeps, ['A', 'D']);
  assert.deepEqual(result.model.tasks.find(task => task.id === 'C').effectiveDeps, []);
  metadata[2].dependsOn = ['b'];
  document.features[2].dependsOn = ['b'];
  const transitive = expectResult(f.run(bind(document), { planning: { required: true, features: ['c'] } }, metadata), 'PASS', 0);
  assert.deepEqual(transitive.model.scope, ['a', 'b', 'c'], 'Configured scope must include transitive spec prerequisites.');
  assert.deepEqual(transitive.model.tasks.find(task => task.id === 'C').effectiveDeps, ['A', 'B', 'D']);
  const downstream = clone(f.document);
  downstream.tasks[0].dependsOn = ['B'];
  downstream.tasks[1].dependsOn = ['C'];
  downstream.tasks[2].dependsOn = ['B'];
  const blockedCycle = expectResult(f.run(bind(downstream)), 'FAIL', 1);
  assert.equal(blockedCycle.errors[0].id, 'A', 'Cycle refusal identifies a blocking ID, not necessarily an SCC member.');
  const layered = (parents, children, bindings) => {
    const compact = (template, id) => ({ ...clone(template), id, condition: 'x',
      checks: [{ name: 'x', argv: ['node', '--version'], timeoutMs: 1 }] });
    const value = { schemaVersion: 1, features: [{ id: 'a', dependsOn: [] }, { id: 'b', dependsOn: ['a'] }],
      tasks: [...Array.from({ length: parents }, (_, n) => compact(f.document.tasks[0], 'P' + n)),
        ...Array.from({ length: children }, (_, n) => compact(f.document.tasks[1], 'L' + n))] };
    return bindings ? bind(value) : value;
  };
  const policy = { planning: { required: true, features: ['b'] } };
  const validEdges = layered(64, 128, true);
  assert.ok(Buffer.byteLength(JSON.stringify(validEdges)) <= 1048576);
  expectResult(f.run(validEdges, policy), 'PASS', 0, 'A fully bound valid8192-edge plan must be accepted.');
  assert.ok(16384 * 70 > 1048576, 'A fully bound16384-edge JSON input cannot fit the stronger byte budget.');
  const edgeBoundary = layered(128, 128, false);
  const equalBudget = expectResult(f.run(edgeBoundary, policy), 'FAIL', 1);
  assert.match(equalBudget.errors[0].reason, /dependencies must bind exactly/,
    'Exact16384 edge budget accepts its predicate; independent missing bindings must then refuse whole-plan acceptance.');
  edgeBoundary.tasks.at(-1).dependsOn = ['L126'];
  const excessBudget = expectResult(f.run(edgeBoundary, policy), 'FAIL', 1);
  assert.match(excessBudget.errors[0].reason, /exceeds 16384 expanded dependency edges/);
});

/** @id TEST-PLAN-MODEL-004 @verifies REQ-PLAN-MODEL-004 */
test('TEST-PLAN-MODEL-004 exact bindings, canonical path containment and all shared owners', t => {
  const f = fixture(t);
  expectResult(f.run(), 'PASS', 0);
  invalid(f, d => { d.tasks[0].artifacts = ['../outside']; }, 'Parent traversal must refuse.');
  fs.symlinkSync(path.join(os.tmpdir(), 'outside-' + path.basename(f.root)), path.join(f.root, 'dangling-escape'),
    process.platform === 'win32' ? 'junction' : 'dir');
  invalid(f, d => { d.tasks[0].artifacts = ['dangling-escape/future.mjs']; },
    'An existing dangling symlink must not be accepted as a missing future in-root path.');
  for (const artifact of ['/tmp/outside', 'C:\\outside', '\\\\server\\share', 'a/../outside', './shared.mjs', 'shared.mjs/child']) {
    invalid(f, d => { d.tasks[0].artifacts = [artifact]; });
  }
  for (const field of ['condition', 'checks', 'specs', 'dependencies', 'artifacts', 'tests']) {
    invalid(f, d => { delete d.tasks[0][field]; }, `Missing ${field} must refuse.`);
  }
  invalid(f, d => { d.tasks[0].condition = ' '; });
  invalid(f, d => { d.tasks[0].checks = []; });
  invalid(f, d => { d.tasks[0].tests = ['TEST-UNKNOWN-1']; });
  invalid(f, d => { d.tasks[0].tests = ['TEST-FIX-A-1']; },
    'Omitting one required TEST must not be accepted as a valid subset.');
  const unresolvedTests = clone(f.specs);
  unresolvedTests[0].reqs[0].tests = [];
  expectResult(f.run(f.document, f.config, unresolvedTests), 'INCOMPLETE', 2,
    'An implementation REQ without resolvable required TEST metadata is unavailable, not a bypass.');
  for (const marker of ['testOnly', 'deferred']) {
    const marked = clone(unresolvedTests);
    marked[0].reqs[0][marker] = true;
    expectResult(f.run(f.document, f.config, marked), 'INCOMPLETE', 2,
      'A marker does not make a still-authored implementation task optional.');
  }
  const docs = clone(f.document);
  docs.tasks[0].kind = 'documentation';
  docs.tasks[0].artifacts = ['guide.md'];
  docs.tasks[0].tests = ['TEST-FIX-A-1'];
  expectResult(f.run(docs), 'PASS', 0, 'A documentation task may explicitly select a resolvable TEST subset.');
  const docMetadata = clone(f.specs);
  docMetadata[0].reqs.forEach(req => { req.tests = []; });
  docs.tasks.filter(task => task.feature === 'a').forEach(task => {
    task.kind = 'documentation';
    task.artifacts = ['guide.md'];
    task.tests = [];
  });
  expectResult(f.run(docs, f.config, docMetadata), 'PASS', 0,
    'Documentation-only tasks may omit TEST metadata but never their explicit checks.');
  invalid(f, d => { d.tasks[0].specs = {}; });
  invalid(f, d => { d.tasks[0].specs[f.specs[0].path] = 'not-a-hash'; });
  invalid(f, d => { d.tasks[0].specs[f.specs[1].path] = '0'.repeat(64); });
  invalid(f, d => { d.tasks[0].checks[0].argv = 'node --version'; });
  invalid(f, d => { d.tasks[0].checks[0].timeoutMs = 0; });
  invalid(f, d => { d.tasks[0].checks[0].timeoutMs = 600001; });
  invalid(f, d => { d.tasks[0].checks[0].extra = true; });
  invalid(f, d => { d.tasks[0].receipt = '../outside.json'; });
  invalid(f, d => { d.tasks[0].status = 'optional'; });
  const bound = clone(f.document);
  bound.tasks[1].dependsOn = ['A'];
  bind(bound);
  expectResult(f.run(bound), 'PASS', 0);
  const missingDependency = clone(bound);
  missingDependency.tasks[1].dependencies = {};
  expectResult(f.run(missingDependency), 'FAIL', 1);
  const malformedDependency = clone(bound);
  malformedDependency.tasks[1].dependencies.A = 'bad';
  expectResult(f.run(malformedDependency), 'FAIL', 1);
  const stale = clone(bound);
  stale.tasks[0].specs[f.specs[0].path] = '0'.repeat(64);
  expectResult(f.run(stale), 'PASS', 0, 'Well-formed stale bindings are evaluator input, not a structural parse error.');
  fs.symlinkSync(os.tmpdir(), path.join(f.root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  invalid(f, d => { d.tasks[0].artifacts = ['escape/not-created/file.mjs']; });
  fs.symlinkSync(f.root, path.join(f.root, 'alias-root'), process.platform === 'win32' ? 'junction' : 'dir');
  const aliased = clone(f.document);
  aliased.tasks[0].artifacts = ['alias-root/shared.mjs', 'future/file.mjs'];
  const result = expectResult(f.run(aliased), 'PASS', 0);
  assert.deepEqual(result.model.owners['shared.mjs'], ['A', 'B', 'C', 'D']);
  assert.deepEqual(result.model.owners['future/file.mjs'], ['A']);
  for (const task of result.model.tasks) assert.equal(task.definitionSha256, referenceDefinition(aliased.tasks.find(t => t.id === task.id)));
  assert.deepEqual(result.model.tasks.find(task => task.id === 'A').requiredTests, ['TEST-FIX-A-1', 'TEST-FIX-A-2']);
  const golden = clone(f.document);
  const vector = { ...clone(golden.tasks[0]), id: 'GOLDEN',
    artifacts: ['shared.mjs', 'future/file.mjs'],
    checks: [{ timeoutMs: 1000, argv: ['node', '--version'], name: 'check' }] };
  golden.tasks.push(vector);
  const goldenResult = expectResult(f.run(golden), 'PASS', 0);
  assert.equal(goldenResult.model.tasks.find(task => task.id === 'GOLDEN').definitionSha256,
    '45927d3262e7b087c9dae621467f143f8b6dae344329b4f97b5b9125c9fc4d91',
    'Literal independently computed Python protocol vector must match despite authored check-key order.');
  f.save(aliased);
  const before = fs.readFileSync(path.join(f.root, modelPath));
  expectResult(loadImplementationPlan({ root: f.root, config: f.config, specs: f.specs }), 'PASS', 0);
  assert.deepEqual(fs.readFileSync(path.join(f.root, modelPath)), before, 'Structural evaluation must not update authored content.');
});
