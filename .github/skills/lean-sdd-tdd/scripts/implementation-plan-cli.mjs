import fs from 'node:fs';
import path from 'node:path';
import { PlanningError, containedPlanningPath, planningSha256, readPlanningJson } from './implementation-plan.mjs';
import { evaluateImplementationPlan, verifyImplementationTask } from './implementation-plan-evidence.mjs';

export function planningRefusal(error, stage) {
  if (!(error instanceof PlanningError)) throw error;
  return { enabled: true, stage, status: error.exit === 1 ? 'FAIL' : 'INCOMPLETE', exit: error.exit,
    errors: [{ id: error.id, reason: error.message, exit: error.exit }], tasks: [] };
}

/** @id CODE-PLAN-CLI-001 @implements REQ-PLAN-CLI-001 REQ-PLAN-CLI-004 */
export function readPlanningConfiguration(root, fallback) {
  try { fs.lstatSync(path.join(root, '.sdd/config.json')); }
  catch (error) {
    if (error.code === 'ENOENT') return fallback();
    throw new PlanningError(2, '.sdd/config.json', `Configuration unavailable (${error.code})`);
  }
  const config = readPlanningJson(root, '.sdd/config.json');
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new PlanningError(1, '.sdd/config.json', 'Project configuration must be a JSON object');
  }
  return config;
}

const bookkeeping = new Set(['.sdd/tdd.jsonl', '.sdd/approvals.json', '.sdd/prepare-shown.json', '.sdd/prepare-cache.json']);
function isPlanningBookkeeping(model, file) {
  if (bookkeeping.has(file) || file === '.sdd/plan.md') return true;
  return model.tasks.some(task => {
    const prefix = `.sdd/plan-evidence/${planningSha256(task.id)}/`;
    return file.startsWith(prefix)
      && /^(?:[a-f0-9]{64}\.json|attempt-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\/(?:0|[1-9]\d*)\.log)$/.test(file.slice(prefix.length));
  });
}

/** @id CODE-PLAN-CLI-003 @implements REQ-PLAN-CLI-002 REQ-PLAN-CLI-003 */
export function planningTaskScope(model, { changed = null, relevant = [], impactOne } = {}) {
  const selected = new Set(), requirements = new Set(relevant);
  if (changed === null) return model.tasks.filter(task => model.scope.includes(task.feature)).map(task => task.id);
  const all = () => model.tasks.filter(task => model.scope.includes(task.feature)).forEach(task => selected.add(task.id));
  for (const file of changed) {
    const canonical = path.relative(model.root, containedPlanningPath(model.root, file,
      { allowMissing: true, regular: false })).split(path.sep).join('/');
    const owners = model.owners[canonical] ?? [];
    owners.forEach(id => selected.add(id));
    if (file === '.sdd/config.json' || file === '.sdd/implementation-plan.json') { all(); continue; }
    if (isPlanningBookkeeping(model, file) && !owners.length) continue;
    const specs = model.specs.filter(spec => spec.path === file);
    specs.flatMap(spec => spec.reqs).forEach(req => requirements.add(req.id));
    const impact = fs.existsSync(path.join(model.root, canonical)) ? impactOne(canonical, true) : null;
    const reached = impact && typeof impact === 'object'
      ? [...impact.reqs, ...impact.sameFeatureReqs, ...impact.otherReqs.map(row => row.req)] : [];
    reached.forEach(req => requirements.add(req));
    const fileReqs = new Set([...specs.flatMap(spec => spec.reqs.map(req => req.id)), ...reached]);
    const mapped = model.tasks.filter(task => task.reqs.some(req => fileReqs.has(req)));
    mapped.forEach(task => selected.add(task.id));
    if (!owners.length && !mapped.length) {
      throw new PlanningError(2, file, `${file}: planning ownership is unresolved`);
    }
  }
  for (const task of model.tasks) if (task.reqs.some(req => requirements.has(req))) selected.add(task.id);
  return [...selected].sort();
}

/** @id CODE-PLAN-CLI-CONTEXT @implements REQ-PLAN-CLI-003 */
export function planningFeatureClosure(model, initial) {
  const selected = new Set(initial), byTask = new Map(model.tasks.map(task => [task.id, task]));
  for (const feature of selected) {
    for (const dependency of model.features.find(row => row.id === feature)?.dependsOn ?? []) selected.add(dependency);
    for (const task of model.tasks.filter(task => task.feature === feature)) {
      for (const id of task.effectiveDeps) selected.add(byTask.get(id).feature);
      for (const artifact of task.artifacts) {
        const canonical = path.relative(model.root, containedPlanningPath(model.root, artifact,
          { allowMissing: true })).split(path.sep).join('/');
        for (const id of model.owners[canonical] ?? []) selected.add(byTask.get(id).feature);
      }
    }
  }
  return selected;
}

/** @id CODE-PLAN-CLI-004 @implements REQ-PLAN-CLI-001 REQ-PLAN-CLI-004 */
export function publicPlanningResult(result) {
  return { enabled: result.enabled, stage: result.stage, status: result.status, exit: result.exit,
    ...(result.task ? { task: result.task } : {}),
    ...(result.receipt ? { receipt: result.receipt } : {}),
    ...(result.fingerprint ? { fingerprint: result.fingerprint } : {}),
    errors: (result.errors ?? []).map(error => ({ id: error.id, reason: error.reason, exit: error.exit ?? result.exit })),
    tasks: (result.tasks ?? []).map(task => ({ id: task.id, feature: task.feature, reqs: task.reqs,
      state: task.state, fingerprint: task.fingerprint, exit: task.exit, reasons: task.reasons })) };
}

export function emitPlanningResult(result, json) {
  const value = publicPlanningResult(result);
  if (json) console.log(JSON.stringify(value));
  else {
    console.log(`SDD PLAN ${value.status} stage=${value.stage} enabled=${value.enabled}`);
    for (const task of value.tasks.slice(0, 7)) console.log(`${task.id} [${task.reqs.join(', ')}] ${task.state}${task.reasons.length ? ': ' + task.reasons.join('; ') : ''}`);
    for (const error of value.errors.slice(0, 5)) console.log(`${error.id}: ${error.reason}`);
    if (value.receipt) console.log(`receipt: ${value.receipt}`);
    if (value.tasks.length > 7 || value.errors.length > 5) console.log('Additional task/reason rows omitted; use --json for the complete decision.');
  }
  return result.exit;
}

/** @id CODE-PLAN-CLI-VERIFY @implements REQ-PLAN-CLI-002 REQ-PLAN-CLI-004 */
export function runPlanningCommand(session, pos, flags) {
  try {
    if (Object.keys(flags).some(flag => !['root', 'json', 'help'].includes(flag))
      || !(pos.length === 1 || pos.length === 2 && pos[1] === 'check'
        || pos.length === 3 && pos[1] === 'verify')) {
      throw new PlanningError(2, 'planning', 'usage: plan [check] | plan verify TASK [--json] [--root DIR]');
    }
    if (session.exit) return { ...session, stage: pos[1] === 'verify' ? 'verify' : 'consistency' };
    if (!session.enabled) {
      if (pos[1] === 'verify') throw new PlanningError(2, 'planning', 'plan verify requires planning.required:true');
      return { enabled: false, stage: 'consistency', status: 'DISABLED', exit: 0, errors: [], tasks: [] };
    }
    if (pos[1] === 'verify') {
      const task = session.model.tasks.find(task => task.id === pos[2]);
      if (task) for (const check of task.checks) {
        const gate = check.argv.indexOf('gate');
        if (gate > 0 && check.argv.slice(0, gate).some(arg =>
          /^(?:sdd(?:\.mjs)?|musubix6(?:\.mjs)?)(?:\.cmd)?$/.test(path.win32.basename(arg.replaceAll('/', '\\'))))) {
          throw new PlanningError(1, task.id, 'aggregate gate cannot establish task completion');
        }
      }
      return verifyImplementationTask({ model: session.model, taskId: pos[2], adapter: session.adapter });
    }
    return evaluateImplementationPlan({ model: session.model, adapter: session.adapter,
      taskIds: planningTaskScope(session.model), stage: 'consistency' });
  } catch (error) { return planningRefusal(error, pos[1] === 'verify' ? 'verify' : 'consistency'); }
}
