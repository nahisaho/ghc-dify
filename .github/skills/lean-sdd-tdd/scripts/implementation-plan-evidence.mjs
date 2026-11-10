import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { PlanningError, containedPlanningPath, loadImplementationPlan,
  planningSha256, planningFileSha256 } from './implementation-plan.mjs';

/** @id CODE-PLAN-STATE-001 @implements REQ-PLAN-STATE-001 REQ-PLAN-STATE-002 REQ-PLAN-STATE-004 */
export function deriveImplementationTaskState(facts) {
  if (facts.bindingStale || facts.prerequisiteStale) return 'replan-required';
  if (facts.verificationRequired) return 'revalidation-required';
  if (facts.prerequisitePending || facts.blocked) return 'blocked';
  if (facts.verified) return 'complete';
  if (facts.started) return 'in-progress';
  return 'not-started';
}

/** @id CODE-PLAN-STATE-IO @implements REQ-PLAN-STATE-003 REQ-PLAN-STATE-004 */
class EvidenceStore {
  static maxReceipts = 4096;
  static maxReceipt = 1048576;
  static maxOutput = 8388608;
  static maxRead = 67108864;
  constructor(root, owner = null) { this.root = root; this.owner = owner; this.readBytes = 0; }
  static require(condition, exit, id, reason) {
    if (!condition) throw new PlanningError(exit, id, `${id}: ${reason}`);
  }
  static error(error, id) {
    if (error instanceof PlanningError) return error;
    if (error instanceof Error && typeof error.code === 'string') {
      return new PlanningError(2, id, `${id}: evidence I/O unavailable (${error.code})`);
    }
    throw error;
  }
  static verdict(errors) {
    const exit = errors.some(error => error.exit === 1) ? 1 : errors.length ? 2 : 0;
    return { exit, status: exit === 0 ? 'PASS' : exit === 1 ? 'FAIL' : 'INCOMPLETE' };
  }
  static refusal(error, id) {
    const problem = EvidenceStore.error(error, id);
    return { ...EvidenceStore.verdict([problem]),
      errors: [{ id: problem.id, reason: problem.message, exit: problem.exit }] };
  }
  directory(task) { return `.sdd/plan-evidence/${planningSha256(task.id)}`; }
  exists(relative) {
    try { fs.statSync(containedPlanningPath(this.root, relative)); return true; }
    catch (error) {
      if (error instanceof PlanningError && error.exit === 2 && /\(ENOENT\)/.test(error.message)) return false;
      throw EvidenceStore.error(error, relative);
    }
  }
  read(relative, limit) {
    let fd;
    try {
      fd = fs.openSync(containedPlanningPath(this.root, relative), 'r');
      const size = fs.fstatSync(fd).size;
      EvidenceStore.require(size <= limit && this.readBytes + size <= EvidenceStore.maxRead,
        2, relative, 'evidence read budget exceeded');
      this.readBytes += size;
      const bytes = Buffer.alloc(size + 1);
      let length = 0, count;
      while (length < bytes.length && (count = fs.readSync(fd, bytes, length, bytes.length - length, null)) > 0) length += count;
      EvidenceStore.require(length === size, 2, relative, 'evidence changed during bounded read');
      return bytes.subarray(0, length);
    } catch (error) { throw EvidenceStore.error(error, relative); }
    finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  json(relative) {
    const bytes = this.read(relative, EvidenceStore.maxReceipt);
    try { return { bytes, value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) }; }
    catch (error) {
      if (!(error instanceof SyntaxError) && !(error instanceof TypeError)) throw error;
      throw new PlanningError(2, relative, `${relative}: unparseable evidence JSON/UTF-8`);
    }
  }
  files(task) {
    const directory = containedPlanningPath(this.root, this.directory(task), { allowMissing: true, regular: false });
    try {
      return fs.readdirSync(directory).filter(name => {
        EvidenceStore.require(!name.endsWith('.json') || /^[a-f0-9]{64}\.json$/.test(name),
          1, task.id, 'unexpected receipt filename');
        return /^[a-f0-9]{64}\.json$/.test(name);
      }).sort();
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw EvidenceStore.error(error, task.id);
    }
  }
  history(task) {
    const directory = this.directory(task);
    const lock = containedPlanningPath(this.root, `${directory}/verify.lock`, { allowMissing: true, regular: false });
    EvidenceStore.require(this.owner === task.id || !fs.existsSync(lock), 2, task.id, 'verification lock occupied; explicit owner-confirmed recovery required');
    const files = this.files(task);
    EvidenceStore.require(files.length <= EvidenceStore.maxReceipts, 2, task.id, 'receipt-count budget exceeded');
    const records = files.map(name => {
      const relative = `${directory}/${name}`, { bytes, value } = this.json(relative);
      EvidenceStore.require(planningSha256(bytes) === name.slice(0, -5), 1, task.id, 'receipt bytes differ from their digest');
      EvidenceStore.require(value && typeof value === 'object' && !Array.isArray(value), 2, task.id, 'receipt must be an object');
      const fields = ['schemaVersion', 'task', 'sequence', 'previous', 'definitionSha256', 'inputSha256',
        'status', 'exit', 'checks', 'ledgerEvents', 'errors'];
      EvidenceStore.require(Object.keys(value).length === fields.length && fields.every(key => Object.hasOwn(value, key)),
        2, task.id, 'receipt schema fields are unavailable');
      EvidenceStore.require(value.schemaVersion === 1 && value.task === task.id
        && Number.isSafeInteger(value.sequence) && value.sequence > 0
        && (value.previous === '' || /^[a-f0-9]{64}$/.test(value.previous))
        && /^[a-f0-9]{64}$/.test(value.definitionSha256) && /^[a-f0-9]{64}$/.test(value.inputSha256),
      1, task.id, 'invalid receipt identity or bindings');
      EvidenceStore.require(Array.isArray(value.errors) && value.errors.every(error =>
        error && [1, 2].includes(error.exit) && typeof error.id === 'string' && typeof error.reason === 'string'),
      2, task.id, 'unparseable receipt errors');
      const verdict = EvidenceStore.verdict(value.errors);
      EvidenceStore.require(value.exit === verdict.exit && value.status === verdict.status,
        1, task.id, 'receipt verdict disagrees with its errors');
      EvidenceStore.require(Array.isArray(value.checks) && Array.isArray(value.ledgerEvents),
        2, task.id, 'receipt checks or ledger events unavailable');
      EvidenceStore.require(value.ledgerEvents.every(event => event && typeof event.test === 'string'
        && Array.isArray(event.hashes) && event.hashes.length > 0
        && event.hashes.every(hash => /^[a-f0-9]{64}$/.test(hash))), 2, task.id, 'invalid selected ledger hashes');
      for (const check of value.checks) {
        EvidenceStore.require(check && typeof check.name === 'string' && Array.isArray(check.argv)
          && check.argv.length > 0 && check.argv.every(arg => typeof arg === 'string')
          && Number.isSafeInteger(check.timeoutMs) && check.timeoutMs >= 1 && check.timeoutMs <= 600000
          && (check.exit === null || Number.isSafeInteger(check.exit))
          && (check.signal === null || typeof check.signal === 'string') && typeof check.timedOut === 'boolean'
          && (check.error === null || typeof check.error === 'string')
          && check.log && typeof check.log.path === 'string' && /^[a-f0-9]{64}$/.test(check.log.sha256)
          && Number.isSafeInteger(check.log.bytes) && check.log.bytes >= 0,
        2, task.id, 'unparseable native command receipt');
        EvidenceStore.require(check.log.path.startsWith(directory + '/'), 1, task.id, 'log belongs to another task');
        const log = this.read(check.log.path, EvidenceStore.maxOutput);
        EvidenceStore.require(log.length === check.log.bytes && planningSha256(log) === check.log.sha256,
          1, task.id, 'retained log bytes changed');
        EvidenceStore.require(value.exit !== 0 || check.exit === 0 && !check.signal && !check.timedOut && !check.error,
          1, task.id, 'successful receipt includes an unsuccessful command');
      }
      EvidenceStore.require(value.exit !== 0 || value.checks.length > 0, 1, task.id, 'empty verification is not success');
      return { ...value, path: relative, hash: name.slice(0, -5) };
    }).sort((a, b) => a.sequence - b.sequence);
    for (let i = 0; i < records.length; i++) {
      EvidenceStore.require(records[i].sequence === i + 1 && records[i].previous === (records[i - 1]?.hash ?? ''),
        1, task.id, 'broken, branching or incomplete receipt chain');
    }
    return records;
  }
  lock(task) {
    const directory = containedPlanningPath(this.root, this.directory(task), { allowMissing: true, regular: false });
    fs.mkdirSync(directory, { recursive: true });
    const lock = path.join(directory, 'verify.lock');
    try { fs.mkdirSync(lock); }
    catch (error) {
      if (error.code === 'EEXIST') throw new PlanningError(2, task.id, `${task.id}: verification lock occupied; never steal an abandoned lock`);
      throw EvidenceStore.error(error, task.id);
    }
    const owner = { task: task.id, ownerPid: process.pid, nonce: randomUUID() }, file = path.join(lock, 'owner.json');
    try { fs.writeFileSync(file, JSON.stringify(owner) + '\n', { flag: 'wx' }); }
    catch (error) { fs.rmdirSync(lock); throw EvidenceStore.error(error, task.id); }
    return () => {
      const current = this.json(`${this.directory(task)}/verify.lock/owner.json`).value;
      EvidenceStore.require(current?.task === owner.task && current.ownerPid === owner.ownerPid && current.nonce === owner.nonce,
        2, task.id, 'lock ownership changed; cannot remove another owner lock');
      fs.unlinkSync(file);
      fs.rmdirSync(lock);
    };
  }
  write(task, receipt) {
    const text = JSON.stringify(receipt, null, 2) + '\n';
    EvidenceStore.require(Buffer.byteLength(text) <= EvidenceStore.maxReceipt, 2, task.id, 'failure receipt exceeds persistence budget');
    const relative = `${this.directory(task)}/${planningSha256(text)}.json`;
    fs.writeFileSync(containedPlanningPath(this.root, relative, { allowMissing: true }), text, { flag: 'wx' });
    return relative;
  }
}

/** @id CODE-PLAN-STATE-INPUTS @implements REQ-PLAN-STATE-002 REQ-PLAN-STATE-003 REQ-PLAN-STATE-004 */
function taskInputs(model, task, adapter, rows) {
  let inspection = { bindings: {}, events: [], errors: [] }, native = [];
  if (task.kind === 'implementation') {
    EvidenceStore.require(adapter && typeof adapter.inspect === 'function' && typeof adapter.nativeChecks === 'function',
      2, task.id, 'native TDD evidence adapter is required');
    inspection = adapter.inspect(task);
    native = adapter.nativeChecks(task);
    EvidenceStore.require(inspection && inspection.bindings && Array.isArray(inspection.events)
      && !Array.isArray(inspection.bindings) && Array.isArray(inspection.errors) && Array.isArray(native),
    2, task.id, 'unparseable native TDD evidence');
    EvidenceStore.require(inspection.errors.every(error => error && [1, 2].includes(error.exit)
      && typeof error.id === 'string' && typeof error.reason === 'string'),
    2, task.id, 'native TDD verdict is unparseable');
    EvidenceStore.require(Object.keys(inspection.bindings).length === task.tests.length
      && task.tests.every(test => Object.hasOwn(inspection.bindings, test)),
    2, task.id, 'native TEST bindings are unavailable');
    EvidenceStore.require(native.length === task.tests.length, 2, task.id, 'every required TEST needs actual native verification');
    const coverage = inspection.events.length === task.tests.length && task.tests.every(test =>
      inspection.events.some(event => event && event.test === test && Array.isArray(event.hashes)
        && event.hashes.length > 0 && event.hashes.every(hash => typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash))));
    if (!inspection.errors.length && !coverage) inspection = { ...inspection,
      errors: [{ id: task.id, exit: 2, reason: 'required current native ledger-event coverage is missing' }] };
  }
  const inputsKnown = Object.values(inspection.bindings).every(value => value !== null && value !== undefined);
  if (!inputsKnown && !inspection.errors.length) inspection = { ...inspection,
    errors: [{ id: task.id, exit: 2, reason: 'required current native TEST binding is unavailable' }] };
  const commands = [...task.checks, ...native];
  for (const check of commands) EvidenceStore.require(check && typeof check.name === 'string'
    && Array.isArray(check.argv) && check.argv.length > 0 && check.argv.every(arg => typeof arg === 'string' && !arg.includes('\0'))
    && Number.isSafeInteger(check.timeoutMs) && check.timeoutMs >= 1 && check.timeoutMs <= 600000,
  2, task.id, 'native verification command unavailable');
  const fileBinding = relative => {
    const file = containedPlanningPath(model.root, relative, { allowMissing: true });
    try { fs.statSync(file); }
    catch (error) {
      if (error.code === 'ENOENT') return null;
      throw EvidenceStore.error(error, relative);
    }
    return planningFileSha256(model.root, relative);
  };
  const artifacts = task.artifacts.map(relative => [relative, fileBinding(relative)]);
  const dependencies = Object.fromEntries(task.effectiveDeps.map(id => {
    const dependency = rows.get(id);
    EvidenceStore.require(dependency?.fingerprint && dependency.inputsKnown !== false,
      2, task.id, `current prerequisite input ${id} is unavailable`);
    return [id, dependency.fingerprint];
  }));
  const specs = Object.keys(task.specs).sort().map(relative => [relative, planningFileSha256(model.root, relative)]);
  const fingerprint = planningSha256(JSON.stringify({ definition: task.definitionSha256, specs, artifacts,
    configuration: { declared: model.config, sha256: fileBinding('.sdd/config.json') },
    dependencies, verification: inspection.bindings, commands }));
  return { fingerprint, dependencies, inspection, commands, artifacts, inputsKnown,
    bindingsCurrent: specs.every(([relative, current]) => task.specs[relative] === current)
      && Object.entries(dependencies).every(([id, current]) => task.dependencies[id] === current) };
}

/** @id CODE-PLAN-STATE-EVALUATE @implements REQ-PLAN-STATE-001 REQ-PLAN-STATE-002 REQ-PLAN-STATE-003 REQ-PLAN-STATE-004 */
function evaluate(model, adapter, stage, taskIds, owner = null) {
  EvidenceStore.require(model && Array.isArray(model.tasks), 2, 'planning', 'validated planning model required');
  const byId = new Map(model.tasks.map(task => [task.id, task])), selected = new Set(taskIds ?? model.tasks.map(task => task.id));
  for (const id of selected) {
    EvidenceStore.require(byId.has(id), 2, id, 'unknown task scope');
    for (const dependency of byId.get(id).effectiveDeps) selected.add(dependency);
  }
  const store = new EvidenceStore(model.root, owner), rows = new Map();
  for (const id of model.taskOrder.filter(id => selected.has(id))) {
    const task = byId.get(id);
    let inputs;
    try {
      inputs = taskInputs(model, task, adapter, rows);
      const history = store.history(task), head = history.at(-1), reasons = [];
      const structural = !inputs.bindingsCurrent || Boolean(head && head.definitionSha256 !== task.definitionSha256);
      const prerequisiteStale = task.effectiveDeps.some(id => rows.get(id).state === 'replan-required');
      const pending = task.effectiveDeps.some(id => rows.get(id).state !== 'complete');
      const attempted = Boolean(head) || task.status === 'complete' || task.receipt !== null;
      const missing = inputs.artifacts.some(([, hash]) => hash === null);
      let verified = false, verificationExit = 0;
      if (attempted) {
        if (task.receipt !== null && !store.exists(task.receipt)) {
          verificationExit = 2; reasons.push('referenced receipt is missing');
        } else if (missing) {
          verificationExit = 2; reasons.push('required current artifact is missing');
        } else if (!head) {
          verificationExit = 2; reasons.push('current verification history is missing');
        } else if (task.receipt !== head.path) {
          verificationExit = 1; reasons.push('authored receipt must name the current history head');
        } else if (head.inputSha256 !== inputs.fingerprint) {
          verificationExit = inputs.inputsKnown ? 1 : EvidenceStore.verdict(inputs.inspection.errors).exit || 2;
          reasons.push(inputs.inputsKnown ? 'verification inputs changed' : 'current native TEST binding is unavailable');
        } else if (head.exit !== 0) {
          verificationExit = head.exit; reasons.push('latest verification did not pass');
        } else if (inputs.inspection.errors.length) {
          verificationExit = EvidenceStore.verdict(inputs.inspection.errors).exit; reasons.push('current native TDD evidence is unavailable');
        } else {
          const commands = head.checks.map(({ name, argv, timeoutMs }) => ({ name, argv, timeoutMs }));
          const current = inputs.inspection.events, events = head.ledgerEvents;
          const validEvents = task.kind === 'documentation' ? events.length === 0 :
            events.length === task.tests.length && task.tests.every(test =>
              events.some(event => event.test === test && event.hashes.every(hash =>
                current.some(now => now.test === test && now.hashes.includes(hash)))));
          verified = JSON.stringify(commands) === JSON.stringify(inputs.commands) && validEvents;
          if (!verified) { verificationExit = 1; reasons.push('native command or selected ledger binding differs'); }
        }
      }
      const state = deriveImplementationTaskState({ bindingStale: structural, prerequisiteStale,
        verificationRequired: attempted && !verified, prerequisitePending: pending,
        blocked: task.status === 'blocked', verified, started: task.status === 'in-progress' });
      if (structural || prerequisiteStale) reasons.unshift('specification, definition or prerequisite binding needs replanning');
      if (pending) reasons.push('prerequisite verification is not complete');
      if (task.status === 'blocked') reasons.push('task is explicitly blocked');
      const exit = state === 'replan-required' ? 1 : state === 'revalidation-required' ? verificationExit || 2
        : state === 'complete' ? 0 : 2;
      rows.set(id, { id, feature: task.feature, reqs: task.reqs, state, exit, reasons, ...inputs,
        history, historyError: false, ready: inputs.bindingsCurrent && !missing && !pending && !inputs.inspection.errors.length });
    } catch (error) {
      const refusal = EvidenceStore.refusal(error, id);
      rows.set(id, { id, feature: task.feature, reqs: task.reqs, state: 'revalidation-required',
        exit: refusal.exit, reasons: refusal.errors.map(error => error.reason), fingerprint: inputs?.fingerprint ?? null,
        historyError: true, ready: false });
    }
  }
  const tasks = [...rows.values()];
  const errors = tasks.filter(task => stage === 'gate' ? task.state !== 'complete'
    : ['replan-required', 'revalidation-required'].includes(task.state))
    .map(task => ({ id: task.id, reason: task.reasons.join('; ') || `task is ${task.state}`, exit: task.exit }));
  return { enabled: true, stage, ...EvidenceStore.verdict(errors), tasks, errors };
}

/** @id CODE-PLAN-STATE-002 @implements REQ-PLAN-STATE-001 REQ-PLAN-STATE-002 REQ-PLAN-STATE-004 */
export function evaluateImplementationPlan({ model, adapter, stage = 'consistency', taskIds } = {}) {
  try {
    EvidenceStore.require(['consistency', 'gate'].includes(stage), 1, 'planning', 'unsupported evaluation stage');
    return evaluate(model, adapter, stage, taskIds);
  } catch (error) { return { enabled: true, stage, tasks: [], ...EvidenceStore.refusal(error, 'planning') }; }
}

/** @id CODE-PLAN-STATE-003 @implements REQ-PLAN-STATE-003 REQ-PLAN-STATE-004 */
export function verifyImplementationTask({ model, taskId, adapter } = {}) {
  try {
    EvidenceStore.require(model && Array.isArray(model.tasks), 2, 'planning', 'validated planning model required');
    const task = model.tasks.find(task => task.id === taskId);
    EvidenceStore.require(task, 2, String(taskId), 'unknown task');
    const store = new EvidenceStore(model.root, task.id), release = store.lock(task);
    try {
      EvidenceStore.require(store.files(task).length < EvidenceStore.maxReceipts, 2, task.id,
        'receipt capacity reached; no checks executed and no history changed');
      const before = evaluate(model, adapter, 'consistency', [task.id], task.id).tasks.find(row => row.id === task.id);
      EvidenceStore.require(!before.historyError, before.exit, task.id, before.reasons.join('; '));
      const head = before.history.at(-1);
      const receipt = { schemaVersion: 1, task: task.id, sequence: before.history.length + 1,
        previous: head?.hash ?? '', definitionSha256: task.definitionSha256, inputSha256: before.fingerprint,
        status: 'PASS', exit: 0, checks: [], ledgerEvents: [], errors: [] };
      const addError = (exit, reason) => receipt.errors.push({ id: task.id, exit,
        reason: reason.length > 2048 ? reason.slice(0, 2000) + ' [truncated diagnostic]' : reason });
      const attempt = `${store.directory(task)}/attempt-${randomUUID()}`;
      const maximum = { ...receipt, ledgerEvents: before.inspection.events,
        checks: before.commands.map((command, i) => ({ ...command, exit: 0, signal: null,
          timedOut: false, error: null, log: { path: `${attempt}/${i}.log`,
            sha256: '0'.repeat(64), bytes: EvidenceStore.maxOutput } })) };
      if (Buffer.byteLength(JSON.stringify(maximum, null, 2)) + 8192 > EvidenceStore.maxReceipt) {
        addError(2, 'verification metadata exceeds receipt budget; no checks executed');
      } else if (!before.ready) {
        addError(before.state === 'replan-required' ? 1 : EvidenceStore.verdict(before.inspection.errors).exit || 2,
          before.reasons.join('; ') || before.inspection.errors.map(error => error.reason).join('; ') || 'current artifacts and complete prerequisites are required');
      } else {
        EvidenceStore.require(adapter && typeof adapter.run === 'function', 2, task.id, 'native command runner required');
        fs.mkdirSync(containedPlanningPath(model.root, attempt, { allowMissing: true, regular: false }));
        for (const [i, command] of before.commands.entries()) {
          let result;
          try { result = adapter.run(command.argv, command.timeoutMs); }
          catch (error) {
            if (!(error instanceof Error) || typeof error.code !== 'string' || !/^E[A-Z0-9]+$/.test(error.code)) throw error;
            result = { exit: null, signal: null, timedOut: false,
              error: `native runner setup failed (${error.code})`, text: `Native runner setup failed: ${error.message}\n` };
          }
          const parseable = result && typeof result.text === 'string'
            && (result.exit === null || Number.isSafeInteger(result.exit))
            && (result.signal === null || typeof result.signal === 'string')
            && typeof result.timedOut === 'boolean' && (result.error === null || typeof result.error === 'string');
          if (!parseable) result = { exit: null, signal: null, timedOut: false,
            error: 'native runner returned unparseable evidence', text: 'Native runner returned unparseable evidence.\n' };
          const output = Buffer.from(result.text), truncated = output.length > EvidenceStore.maxOutput;
          const log = output.subarray(0, EvidenceStore.maxOutput), relative = `${attempt}/${i}.log`;
          fs.writeFileSync(containedPlanningPath(model.root, relative, { allowMissing: true }), log, { flag: 'wx' });
          receipt.checks.push({ ...command, exit: result.exit, signal: result.signal, timedOut: result.timedOut,
            error: truncated ? 'output truncated at evidence budget' : result.error,
            log: { path: relative, sha256: planningSha256(log), bytes: log.length } });
          if (truncated || result.timedOut || result.signal || result.error || result.exit === null) {
            addError(2, truncated ? 'native output exceeded budget and was explicitly truncated'
              : result.error || 'native verification timed out, signalled or has no exit');
          } else if (result.exit !== 0) addError(1, `${command.name}: native verification exited ${result.exit}`);
          if (receipt.errors.length) break;
        }
        const loaded = loadImplementationPlan({ root: model.root, config: model.config, specs: model.specs });
        if (loaded.exit !== 0 || !loaded.model) {
          addError(loaded.exit || 2, 'current plan could not be revalidated after execution: '
            + loaded.errors.map(error => error.reason).join('; '));
        } else {
          const current = evaluate(loaded.model, adapter, 'consistency', [task.id], task.id);
          const after = current.tasks.find(row => row.id === task.id);
          if (!after) addError(2, 'current task scope is unavailable after execution');
          else {
            if (after.fingerprint !== before.fingerprint) addError(1, 'task inputs changed during verification');
            if (after.historyError) addError(after.exit, 'retained history changed during verification: ' + after.reasons.join('; '));
            if (!after.ready) addError(current.exit || 2, 'current prerequisites or verification inputs are no longer available');
            if (after.inspection) {
              for (const error of after.inspection.errors) addError(error.exit, error.reason);
              receipt.ledgerEvents = after.inspection.errors.length ? [] : after.inspection.events;
            }
          }
        }
      }
      Object.assign(receipt, EvidenceStore.verdict(receipt.errors));
      const relative = store.write(task, receipt);
      return { enabled: true, stage: 'verify', task: task.id, status: receipt.status, exit: receipt.exit,
        receipt: relative, fingerprint: before.fingerprint, errors: receipt.errors };
    } finally { release(); }
  } catch (error) { return { enabled: true, stage: 'verify', ...EvidenceStore.refusal(error, String(taskId)) }; }
}
