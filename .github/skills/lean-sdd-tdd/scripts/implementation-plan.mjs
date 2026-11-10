import fs from 'node:fs';
import path from 'node:path';
import { isUtf8 } from 'node:buffer';
import { createHash } from 'node:crypto';

const PLAN = '.sdd/implementation-plan.json';
const MAX_BYTES = 1048576;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const HASH = /^[a-f0-9]{64}$/;
const REQ = /^REQ-[A-Z0-9]+(?:-[A-Z0-9]+)*$/;
const TEST = /^TEST-[A-Z0-9]+(?:-[A-Z0-9]+)*$/;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const inRoot = (base, target) => {
  const tail = path.relative(base, target);
  return tail !== '..' && !tail.startsWith('..' + path.sep) && !path.isAbsolute(tail);
};

export class PlanningError extends Error {
  constructor(exit, id, reason) {
    super(reason);
    this.name = 'PlanningError';
    this.exit = exit;
    this.id = id;
  }
}
function requirePlan(condition, id, reason, exit = 1) {
  if (!condition) throw new PlanningError(exit, id, reason);
}
function ioError(error, id) {
  if (error instanceof PlanningError) throw error;
  if (error instanceof Error && typeof error.code === 'string') {
    throw new PlanningError(2, id, `${id}: required input unavailable (${error.code})`);
  }
  throw error;
}
function fields(value, names, id) {
  requirePlan(record(value), id, `${id}: expected an object`);
  requirePlan(Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name)),
    id, `${id}: required fields are exactly ${names.join(', ')}`);
}
function strings(value, id, label, { empty = true, pattern } = {}) {
  requirePlan(Array.isArray(value) && (empty || value.length > 0), id, `${id}: ${label} must be ${empty ? 'an' : 'a nonempty'} array`);
  requirePlan(value.every(item => nonempty(item) && (!pattern || pattern.test(item))), id, `${id}: invalid ${label}`);
  requirePlan(new Set(value).size === value.length, id, `${id}: duplicate ${label}`);
  return value;
}
function hashBindings(value, expected, id, label) {
  requirePlan(record(value), id, `${id}: ${label} must be an object`);
  requirePlan(Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key)),
    id, `${id}: ${label} must bind exactly ${expected.join(', ') || '(none)'}`);
  requirePlan(Object.values(value).every(item => typeof item === 'string' && HASH.test(item)),
    id, `${id}: ${label} requires lowercase SHA256 hashes`);
}

/** @id CODE-PLAN-MODEL-004 @implements REQ-PLAN-MODEL-004 */
export function containedPlanningPath(root, relative, { allowMissing = false, regular = true } = {}) {
  requirePlan(nonempty(relative) && !relative.includes('\\') && !relative.includes('\0')
    && !path.posix.isAbsolute(relative) && !path.win32.parse(relative).root
    && relative.split('/').every(part => part && part !== '.' && part !== '..'),
  String(relative), `${relative}: expected a portable in-root relative path`);
  let base;
  try { base = fs.realpathSync(root); } catch (error) { ioError(error, String(root)); }
  let current = base;
  const parts = relative.split('/');
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    let entry;
    try {
      entry = fs.lstatSync(current);
    } catch (error) {
      if (error.code === 'ENOENT' && allowMissing) return path.join(current, ...parts.slice(i + 1));
      if (error.code === 'ENOTDIR') throw new PlanningError(1, relative, `${relative}: a path ancestor is not a directory`);
      ioError(error, relative);
    }
    try { current = fs.realpathSync(current); }
    catch (error) {
      if (error.code === 'ENOENT' && entry.isSymbolicLink()) {
        let target;
        try { target = path.resolve(path.dirname(current), fs.readlinkSync(current)); }
        catch (readError) { ioError(readError, relative); }
        requirePlan(inRoot(base, target), relative, `${relative}: dangling symlink points outside the project root`);
      }
      ioError(error, relative);
    }
    requirePlan(inRoot(base, current), relative, `${relative}: symlink resolves outside the project root`);
  }
  try {
    requirePlan(!regular || fs.statSync(current).isFile(), relative, `${relative}: expected a regular file`);
  } catch (error) { ioError(error, relative); }
  return current;
}

export const planningSha256 = value => createHash('sha256').update(value).digest('hex');
export function planningFileSha256(root, relative) {
  const file = containedPlanningPath(root, relative);
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const digest = createHash('sha256'), buffer = Buffer.alloc(65536);
    let length;
    while ((length = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) digest.update(buffer.subarray(0, length));
    return digest.digest('hex');
  } catch (error) { ioError(error, relative); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

/** @id CODE-PLAN-MODEL-001 @implements REQ-PLAN-MODEL-001 */
export function readPlanningJson(root, relative, { maxBytes = MAX_BYTES, invalidExit = 1 } = {}) {
  requirePlan(Number.isSafeInteger(maxBytes) && maxBytes > 0, relative, `${relative}: invalid read budget`);
  const file = containedPlanningPath(root, relative);
  let fd, text;
  try {
    fd = fs.openSync(file, 'r');
    requirePlan(fs.fstatSync(fd).size <= maxBytes, relative, `${relative}: exceeds ${maxBytes} bytes`, invalidExit);
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0, count;
    while (length < buffer.length && (count = fs.readSync(fd, buffer, length, buffer.length - length, null)) > 0) length += count;
    requirePlan(length <= maxBytes, relative, `${relative}: exceeds ${maxBytes} bytes`, invalidExit);
    const bytes = buffer.subarray(0, length);
    requirePlan(isUtf8(bytes), relative, `${relative}: malformed UTF-8 JSON`, invalidExit);
    text = bytes.toString('utf8');
  } catch (error) { ioError(error, relative); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
  try { return JSON.parse(text); }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new PlanningError(invalidExit, relative, `${relative}: malformed JSON (${error.message})`);
  }
}

export function taskDefinitionSha256(task) {
  return planningSha256(JSON.stringify({
    id: task.id, feature: task.feature, kind: task.kind, reqs: [...task.reqs].sort(),
    dependsOn: [...task.dependsOn].sort(), artifacts: [...task.artifacts].sort(),
    condition: task.condition, tests: [...task.tests].sort(),
    checks: task.checks.map(check => ({ name: check.name, argv: check.argv, timeoutMs: check.timeoutMs })),
    specs: Object.entries(task.specs).sort(([a], [b]) => compare(a, b)),
  }));
}

function policyScope(config) {
  requirePlan(record(config), 'planning', 'Project configuration must be an object');
  if (!Object.hasOwn(config, 'planning')) return null;
  const policy = config.planning;
  requirePlan(record(policy) && typeof policy.required === 'boolean', 'planning', 'planning.required must be a boolean');
  if (!policy.required) return null;
  requirePlan(Object.keys(policy).every(key => ['required', 'features'].includes(key)), 'planning', 'Unknown planning policy field');
  if (Object.hasOwn(policy, 'features')) strings(policy.features, 'planning', 'features', { empty: false, pattern: ID });
  return policy.features ?? undefined;
}

/** @id CODE-PLAN-MODEL-003 @implements REQ-PLAN-MODEL-003 */
function graphOrder(graph, label) {
  const degree = new Map(), dependents = new Map([...graph.keys()].map(id => [id, []]));
  for (const [id, deps] of graph) {
    for (const dependency of deps) {
      requirePlan(graph.has(dependency), id, `${id}: unknown ${label} dependency ${dependency}`);
      requirePlan(dependency !== id, id, `${id}: self ${label} dependency`);
      dependents.get(dependency).push(id);
    }
    degree.set(id, deps.length);
  }
  const queue = [...degree].filter(([, n]) => n === 0).map(([id]) => id).sort();
  for (let i = 0; i < queue.length; i++) for (const id of dependents.get(queue[i])) {
    const remaining = degree.get(id) - 1;
    degree.set(id, remaining);
    if (remaining === 0) queue.push(id);
  }
  const blocking = [...degree].find(([, n]) => n > 0)?.[0];
  requirePlan(blocking === undefined, blocking ?? label, `${blocking}: ${label} dependency cycle`);
  return queue;
}

function validateModel(root, config, specs, document, selected) {
  fields(document, ['schemaVersion', 'features', 'tasks'], PLAN);
  requirePlan(document.schemaVersion === 1, PLAN, `${PLAN}: unsupported schemaVersion`);
  requirePlan(Array.isArray(document.features) && document.features.length > 0 && document.features.length <= 256,
    PLAN, 'Plan requires 1..256 features');
  requirePlan(Array.isArray(document.tasks) && document.tasks.length <= 2048, PLAN, 'Plan allows at most 2048 tasks');
  requirePlan(Array.isArray(specs), 'specs', 'Required specification metadata is unavailable', 2);
  const metadata = new Map(), requirements = new Map();
  for (const spec of specs) {
    requirePlan(record(spec) && typeof spec.feature === 'string' && ID.test(spec.feature) && nonempty(spec.path) && Array.isArray(spec.reqs),
      'specs', 'Invalid specification metadata');
    containedPlanningPath(root, spec.path);
    if (!metadata.has(spec.feature)) metadata.set(spec.feature, { reqs: [], dependsOn: new Set() });
    const feature = metadata.get(spec.feature);
    for (const dependency of strings(spec.dependsOn ?? [], spec.feature, 'specification prerequisites', { pattern: ID })) feature.dependsOn.add(dependency);
    for (const req of spec.reqs) {
      requirePlan(record(req) && typeof req.id === 'string' && REQ.test(req.id), spec.feature, `${spec.feature}: invalid REQ`);
      requirePlan(!requirements.has(req.id), req.id, `${req.id}: duplicate specification REQ`);
      const current = { ...req, feature: spec.feature, path: spec.path };
      requirements.set(req.id, current);
      feature.reqs.push(current);
    }
  }
  const features = new Map();
  for (const feature of document.features) {
    fields(feature, ['id', 'dependsOn'], 'feature');
    requirePlan(typeof feature.id === 'string' && ID.test(feature.id), 'feature', 'Invalid feature ID');
    requirePlan(!features.has(feature.id), feature.id, `${feature.id}: duplicate feature`);
    requirePlan(metadata.has(feature.id), feature.id, `${feature.id}: unknown specification feature`);
    strings(feature.dependsOn, feature.id, 'feature prerequisites', { pattern: ID });
    const missing = [...metadata.get(feature.id).dependsOn].filter(id => !feature.dependsOn.includes(id));
    requirePlan(!missing.length, feature.id, `${feature.id}: missing specification prerequisites ${missing.join(', ')}`);
    features.set(feature.id, feature.dependsOn);
  }
  const featureOrder = graphOrder(features, 'feature');
  const featureAncestors = new Map();
  for (const feature of featureOrder) featureAncestors.set(feature,
    new Set(features.get(feature).flatMap(dependency => [dependency, ...featureAncestors.get(dependency)])));
  const scope = new Set(selected ?? metadata.keys());
  requirePlan(scope.size > 0, 'planning', 'Effective planning scope is empty');
  for (const id of scope) {
    requirePlan(metadata.has(id), id, `${id}: unknown configured planning scope`, 2);
    requirePlan(features.has(id), id, `${id}: missing required scope feature`);
    for (const dependency of features.get(id)) scope.add(dependency);
  }
  const tasks = [], byId = new Map(), owners = new Map(), currentSpecs = new Map();
  for (const raw of document.tasks) {
    fields(raw, ['id', 'feature', 'kind', 'reqs', 'dependsOn', 'artifacts', 'condition', 'tests', 'checks', 'specs', 'dependencies', 'status', 'receipt'], 'task');
    requirePlan(typeof raw.id === 'string' && ID.test(raw.id), 'task', 'Invalid task ID');
    const id = raw.id;
    requirePlan(!byId.has(id), id, `${id}: duplicate task`);
    requirePlan(typeof raw.feature === 'string' && features.has(raw.feature), id, `${id}: unknown owning feature ${raw.feature}`);
    requirePlan(['implementation', 'documentation'].includes(raw.kind), id, `${id}: invalid task kind`);
    requirePlan(['not-started', 'in-progress', 'blocked', 'complete'].includes(raw.status), id, `${id}: invalid authored status`);
    requirePlan(nonempty(raw.condition), id, `${id}: completion condition required`);
    strings(raw.reqs, id, 'REQ references', { empty: false, pattern: REQ });
    strings(raw.dependsOn, id, 'task prerequisites', { pattern: ID });
    strings(raw.artifacts, id, 'artifacts', { empty: false });
    strings(raw.tests, id, 'TEST references', { empty: raw.kind === 'documentation', pattern: TEST });
    const neededSpecs = new Set(), declaredTests = new Set();
    for (const req of raw.reqs) {
      requirePlan(requirements.has(req), id, `${id}: unknown REQ ${req}`);
      const source = requirements.get(req);
      requirePlan(source.feature === raw.feature, id, `${id}: REQ ${req} belongs to feature ${source.feature}`);
      neededSpecs.add(source.path);
      const tests = source.tests ?? [];
      requirePlan(Array.isArray(tests) && tests.every(test => typeof test === 'string' && TEST.test(test))
        && (raw.kind === 'documentation' || tests.length > 0),
      id, `${id}: REQ ${req} required TEST metadata is unavailable`, 2);
      for (const test of tests) declaredTests.add(test);
    }
    requirePlan(raw.tests.every(test => declaredTests.has(test))
      && (raw.kind === 'documentation' || raw.tests.length === declaredTests.size),
    id, `${id}: TEST references must match required TEST mappings`);
    hashBindings(raw.specs, [...neededSpecs], id, 'specs');
    for (const spec of neededSpecs) if (!currentSpecs.has(spec)) currentSpecs.set(spec, planningFileSha256(root, spec));
    requirePlan(Array.isArray(raw.checks) && raw.checks.length > 0, id, `${id}: explicit checks required`);
    const checkNames = new Set();
    for (const check of raw.checks) {
      fields(check, ['name', 'argv', 'timeoutMs'], id);
      requirePlan(typeof check.name === 'string' && ID.test(check.name) && !checkNames.has(check.name), id, `${id}: invalid/duplicate check name`);
      checkNames.add(check.name);
      requirePlan(Array.isArray(check.argv) && check.argv.length > 0 && nonempty(check.argv[0])
        && check.argv.every(arg => typeof arg === 'string' && !arg.includes('\0')), id, `${id}: checks require literal argv`);
      requirePlan(Number.isSafeInteger(check.timeoutMs) && check.timeoutMs >= 1 && check.timeoutMs <= 600000,
        id, `${id}: check timeout must be 1..600000 ms`);
    }
    requirePlan(raw.receipt === null || typeof raw.receipt === 'string', id, `${id}: invalid receipt reference`);
    if (raw.receipt !== null) containedPlanningPath(root, raw.receipt, { allowMissing: true });
    for (const artifact of raw.artifacts) {
      requirePlan(raw.kind !== 'documentation' || /\.(md|rst|txt|adoc)$/i.test(artifact), id, `${id}: documentation task may own only document files`);
      const canonical = path.relative(root, containedPlanningPath(root, artifact, { allowMissing: true })).split(path.sep).join('/');
      if (!owners.has(canonical)) owners.set(canonical, new Set());
      owners.get(canonical).add(id);
    }
    const task = { ...raw, requiredTests: [...raw.tests].sort(), definitionSha256: taskDefinitionSha256(raw) };
    tasks.push(task);
    byId.set(id, task);
  }
  let expandedEdges = 0;
  const graph = new Map();
  for (const task of tasks) {
    const prerequisites = featureAncestors.get(task.feature);
    task.effectiveDeps = [...new Set([...task.dependsOn, ...tasks.filter(t => prerequisites.has(t.feature)).map(t => t.id)])].sort();
    expandedEdges += task.effectiveDeps.length;
    requirePlan(expandedEdges <= 16384, task.id, `${task.id}: exceeds 16384 expanded dependency edges`);
    graph.set(task.id, task.effectiveDeps);
  }
  const taskOrder = graphOrder(graph, 'task');
  for (const task of tasks) hashBindings(task.dependencies, task.effectiveDeps, task.id, 'dependencies');
  const covered = new Set(tasks.flatMap(task => task.reqs));
  const exclusions = [];
  for (const feature of scope) for (const req of metadata.get(feature).reqs) {
    if (req.deferred) exclusions.push(req.id);
    else requirePlan(covered.has(req.id), req.id, `${req.id}: required REQ has no implementation task`);
  }
  return { root, features: document.features, tasks, scope: [...scope].sort(), exclusions: exclusions.sort(),
    featureOrder, taskOrder, currentSpecs: Object.fromEntries(currentSpecs),
    owners: Object.fromEntries([...owners].sort(([a], [b]) => compare(a, b)).map(([file, ids]) => [file, [...ids].sort()])),
    specs, config };
}

/** @id CODE-PLAN-MODEL-002 @implements REQ-PLAN-MODEL-001 REQ-PLAN-MODEL-002 REQ-PLAN-MODEL-003 REQ-PLAN-MODEL-004 */
export function loadImplementationPlan({ root, config = {}, specs }) {
  try {
    const selected = policyScope(config);
    if (selected === null) return { enabled: false, stage: 'structure', status: 'DISABLED', exit: 0, errors: [], model: null };
    requirePlan(nonempty(root), 'root', 'Project root is required', 2);
    let realRoot;
    try { realRoot = fs.realpathSync(root); } catch (error) { ioError(error, root); }
    const document = readPlanningJson(realRoot, PLAN);
    const model = validateModel(realRoot, config, specs, document, selected);
    return { enabled: true, stage: 'structure', status: 'PASS', exit: 0, errors: [], model };
  } catch (error) {
    if (!(error instanceof PlanningError)) throw error;
    return { enabled: true, stage: 'structure', status: error.exit === 2 ? 'INCOMPLETE' : 'FAIL',
      exit: error.exit, errors: [{ id: error.id, reason: error.message }], model: null };
  }
}
