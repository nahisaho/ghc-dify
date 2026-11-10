import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { aggregate, runProvider } from './diagnostics.mjs';
import { diagnoseTypeScript, normalizeTypeScriptDiagnostic } from './diagnostics-typescript.mjs';
import { diagnoseESLint } from './diagnostics-eslint.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../../..');
const script = path.join(here, 'sdd.mjs');
const wrapper = path.join(repo, 'bin/musubix6.mjs');
const require = createRequire(import.meta.url);
const ts = require('typescript');
const parser = require.resolve('@typescript-eslint/parser');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'musubix6-diagnostics-test-'));
after(() => fs.rmSync(scratch, { recursive: true, force: true }));
const { NODE_TEST_CONTEXT, ...env } = process.env;
function killOwnedDescendant(pid, kill = process.kill) {
  try { kill(pid, 'SIGKILL'); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
}
/** @id CODE-DIAGCLI-PROCSTATE-001 @implements REQ-DIAGCLI-004 REQ-DIAGCLI-005 */
function ownedDescendantRunning(pid, {
  platform = process.platform,
  kill = process.kill,
  readStat = target => fs.readFileSync(`/proc/${target}/stat`, 'utf8'),
} = {}) {
  try {
    kill(pid, 0);
    if (platform === 'linux') {
      const stat = readStat(pid);
      const prefix = `${pid} (`;
      const closing = stat.lastIndexOf(')');
      if (stat.startsWith(prefix) && closing >= prefix.length
        && /^ [ZXx] /.test(stat.slice(closing + 1))) return false;
    }
    return true;
  } catch (error) {
    if (['ESRCH', 'ENOENT'].includes(error.code)) return false;
    throw error;
  }
}
function write(root, name, contents) {
  fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
  fs.writeFileSync(path.join(root, name), contents);
}
function fixture({ config = {}, files = { 'a.js': 'export const value = 1;\n' }, tools = true } = {}) {
  const root = fs.mkdtempSync(path.join(scratch, 'project-'));
  write(root, 'package.json', '{"private":true}\n');
  write(root, 'tsconfig.json', JSON.stringify({ compilerOptions: { allowJs: true, checkJs: false, target: 'ES2020', skipLibCheck: true, ...config }, include: ['*.js', '*.jsx', '*.mjs', '*.cjs', '*.ts', '*.tsx', '*.mts', '*.cts'], exclude: ['eslint.config.cjs'] }));
  write(root, 'eslint.config.cjs', `module.exports = [{ files: ['**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}'], languageOptions: { parser: require(${JSON.stringify(parser)}), parserOptions: { ecmaVersion: 2022, sourceType: 'module' } }, rules: {'no-debugger':'error','no-unused-vars':'warn'} }];\n`);
  for (const [name, text] of Object.entries(files)) write(root, name, text);
  if (tools) {
    fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true });
    for (const name of ['typescript', 'eslint']) fs.symlinkSync(path.join(repo, 'node_modules', name), path.join(root, 'node_modules', name), process.platform === 'win32' ? 'junction' : 'dir');
  }
  return root;
}
function run(root, args = [], entry = script, prefix = []) {
  const r = spawnSync(process.execPath, [entry, ...prefix, 'diagnostics', ...args], { cwd: root, env, encoding: 'utf8', timeout: 90000, maxBuffer: 20 * 1024 * 1024 });
  assert.ifError(r.error);
  assert.equal(r.signal, null, r.stderr);
  return { code: r.status, out: r.stdout, err: r.stderr };
}
function decode(result) {
  assert.match(result.out, /^\{/, result.out + result.err);
  const data = JSON.parse(result.out);
  assert.equal(data.exitCode, result.code);
  return data;
}
function complete(result) {
  assert.equal(result?.status, 'complete', JSON.stringify(result));
  assert.equal(result.reason, null);
  return result;
}
function incomplete(result, reason) {
  assert.equal(result?.status, 'incomplete', JSON.stringify(result));
  assert.equal(typeof result.reason, 'string');
  assert.ok(result.reason.length > 0);
  if (reason) assert.match(result.reason, reason);
  assert.deepEqual(result.files, { included: null, checked: null, ignored: null });
  return result;
}
function snapshot(root) {
  const values = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) values.push([path.relative(root, file), fs.readlinkSync(file)]);
      else if (entry.isDirectory()) walk(file);
      else values.push([path.relative(root, file), fs.readFileSync(file, 'base64')]);
    }
  }
  walk(root);
  return values.sort((a, b) => a[0].localeCompare(b[0]));
}
function fakePackage(root, name, version) {
  const dest = path.join(root, 'node_modules', name);
  if (fs.lstatSync(dest, { throwIfNoEntry: false })?.isSymbolicLink()) fs.unlinkSync(dest);
  write(root, `node_modules/${name}/package.json`, JSON.stringify({ name, version, main: 'index.cjs' }));
  write(root, `node_modules/${name}/index.cjs`, "throw new Error('unsupported package must not load');\n");
}
function result(source = 'typescript') {
  return { source, status: 'complete', version: 'test', configPath: null, reason: null, files: { included: 1, checked: 1, ignored: 0 }, diagnostics: [] };
}
function worker(contents) {
  const dir = fs.mkdtempSync(path.join(scratch, 'worker-'));
  write(dir, 'worker.mjs', contents);
  return path.join(dir, 'worker.mjs');
}

/** @id TEST-DIAGCLI-001 @verifies REQ-DIAGCLI-001 */
test('TEST-DIAGCLI-001 exact arguments, roots and help fail closed', () => {
  const root = fixture();
  const clean = run(root, ['--json']);
  assert.equal(clean.code, 0, clean.out + clean.err);
  assert.equal(decode(clean).root, fs.realpathSync(root));
  assert.equal(decode(run(scratch, ['--root', root, '--json'])).root, fs.realpathSync(root));
  const linked = path.join(scratch, `root-link-${path.basename(root)}`);
  fs.symlinkSync(root, linked, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(decode(run(scratch, ['--root', linked, '--json'])).root, fs.realpathSync(root));
  for (const args of [
    ['--root', ''], ['--root'], ['--root', path.join(root, 'absent')],
    ['--root', path.join(root, 'a.js')], ['extra'], ['--changed'],
    ['--root', root, '--root', root], ['--json', '--json'], ['--help', '--json'],
  ]) {
    const invalid = run(root, [...args, ...(args.includes('--json') ? [] : ['--json'])]);
    assert.equal(invalid.code, 2);
    const data = decode(invalid);
    assert.equal(data.root, null);
    assert.deepEqual(data.providers, []);
    assert.ok(data.reason);
  }
  const help = run(root, ['--help']);
  assert.equal(help.code, 0);
  assert.match(help.out, /diagnostics.*--root.*--json/s);
});

/** @id TEST-DIAGCLI-002 @verifies REQ-DIAGCLI-002 */
test('TEST-DIAGCLI-002 JSON schema, ordering, snapshots and incomplete reasons', () => {
  const root = fixture({ files: { 'z.ts': 'export const n: number = "x";\n', 'a.js': 'debugger;\n' } });
  const data = decode(run(root, ['--json']));
  assert.equal(data.schemaVersion, 1);
  assert.equal(data.profile, 'typescript');
  assert.equal(data.snapshot, true);
  assert.equal(data.reason, null);
  assert.ok(Number.isFinite(Date.parse(data.startedAt)));
  assert.ok(Date.parse(data.completedAt) >= Date.parse(data.startedAt));
  assert.deepEqual(data.providers.map(p => p.source), ['typescript', 'eslint']);
  for (const p of data.providers) {
    complete(p);
    assert.ok(path.isAbsolute(p.configPath));
    assert.equal(typeof p.version, 'string');
    assert.ok(Number.isInteger(p.files.included));
    for (const d of p.diagnostics) {
      assert.deepEqual(Object.keys(d).sort(), ['code', 'column', 'file', 'line', 'message', 'severity', 'source']);
      assert.equal(d.source, p.source);
      assert.equal(typeof d.code, 'string');
      assert.doesNotMatch(d.message, /\x1b/);
      assert.ok(d.line === null || d.line > 0);
      assert.ok(d.column === null || d.column > 0);
    }
  }
  const missing = fixture({ tools: false });
  const failed = decode(run(missing, ['--json']));
  assert.equal(failed.status, 'INCOMPLETE');
  assert.ok(failed.reason);
  failed.providers.forEach(p => incomplete(p));
  assert.match(run(missing).out, /INCOMPLETE.*snapshot|snapshot.*INCOMPLETE/s);
  const large = fixture({ files: { 'a.js': 'debugger;\n'.repeat(3000) } });
  let largeData;
  assert.doesNotThrow(() => { largeData = decode(run(large, ['--json'])); }, 'large piped JSON must be fully flushed before CLI exit');
  assert.equal(largeData.exitCode, 1);
  assert.equal(largeData.providers[1].diagnostics.filter(d => d.code === 'no-debugger').length, 3000);
});

/** @id TEST-DIAGCLI-003 @verifies REQ-DIAGCLI-003 */
test('TEST-DIAGCLI-003 all 64 verdict rows, missing and empty providers', () => {
  const states = ['C00', 'C0W', 'CE0', 'CEW', 'I00', 'I0W', 'IE0', 'IEW'];
  const table = [
    'PPFFIIII', 'PPFFIIII', 'FFFFIIII', 'FFFFIIII',
    'IIIIIIII', 'IIIIIIII', 'IIIIIIII', 'IIIIIIII',
  ];
  for (let i = 0; i < states.length; i++) for (let j = 0; j < states.length; j++) {
    const providers = [states[i], states[j]].map((state, n) => ({
      ...result(n ? 'eslint' : 'typescript'),
      status: state[0] === 'I' ? 'incomplete' : 'complete',
      reason: state[0] === 'I' ? 'fixture incomplete' : null,
      diagnostics: [...(state[1] === 'E' ? [{ severity: 'error' }] : []), ...(state[2] === 'W' ? [{ severity: 'warning' }] : [])],
    }));
    const expected = { P: ['PASS', 0], F: ['FAIL', 1], I: ['INCOMPLETE', 2] }[table[i][j]];
    const actual = aggregate(providers);
    assert.deepEqual([actual?.status, actual?.exitCode], expected, `${states[i]} x ${states[j]}`);
  }
  for (const providers of [[], [result()], [result('eslint')], [result(), result()], [result(), result('unexpected')]]) assert.equal(aggregate(providers)?.exitCode, 2);
  assert.equal(aggregate([], [])?.exitCode, 2);
  const neutral = [result(), result('eslint')];
  neutral[0].diagnostics.push({ severity: 'info' }, { severity: 'hint' });
  assert.equal(aggregate(neutral)?.exitCode, 0);
});

/** @id TEST-DIAGCLI-004 @verifies REQ-DIAGCLI-004 */
test('TEST-DIAGCLI-004 worker success, cwd, timeout, signals, output boundaries and protocol', async () => {
  const root = fixture();
  const value = result();
  const good = worker(`process.stdout.write(JSON.stringify(${JSON.stringify(value)}));`);
  complete(await runProvider('typescript', root, { worker: good }));
  const cwd = worker(`if(process.cwd()!==${JSON.stringify(root)}) process.exit(3); process.stdout.write(JSON.stringify(${JSON.stringify(value)}));`);
  complete(await runProvider('typescript', root, { worker: cwd }));
  incomplete(await runProvider('typescript', root, { worker: path.join(root, 'missing.mjs') }));
  incomplete(await runProvider('typescript', root, { worker: worker('setInterval(()=>{},10000);'), timeoutMs: 500 }), /time/i);
  const pidFile = path.join(root, 'descendant.pid');
  const descendantWorker = worker(`import {spawn} from 'node:child_process';import fs from 'node:fs';const child=spawn(process.execPath,['-e','setInterval(()=>{},10000)'],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(pidFile)},String(child.pid));setInterval(()=>{},10000);`);
  let descendant;
  try {
    incomplete(await runProvider('typescript', root, { worker: descendantWorker, timeoutMs: 500 }), /time/i);
    descendant = Number(fs.readFileSync(pidFile, 'utf8'));
    const running = () => ownedDescendantRunning(descendant);
    const deadline = Date.now() + 3000;
    while (running() && Date.now() < deadline) await new Promise(resolve => setImmediate(resolve));
    assert.equal(running(), false, 'owned descendant must not survive provider timeout');
    const orphan = worker(`import {spawn} from 'node:child_process';import fs from 'node:fs';const child=spawn(process.execPath,['-e','setInterval(()=>{},10000)'],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(pidFile)},String(child.pid));process.stdout.write(${JSON.stringify(JSON.stringify(value))},()=>process.exit(0));`);
    const orphanResult = await runProvider('typescript', root, { worker: orphan });
    descendant = Number(fs.readFileSync(pidFile, 'utf8'));
    incomplete(orphanResult, /descendant|process group/i);
    const orphanDeadline = Date.now() + 3000;
    while (running() && Date.now() < orphanDeadline) await new Promise(resolve => setImmediate(resolve));
    assert.equal(running(), false, 'owned descendant must not survive a successful worker exit');
  } finally {
    if (descendant) killOwnedDescendant(descendant);
  }
  incomplete(await runProvider('typescript', root, { worker: worker("process.kill(process.pid,'SIGTERM');") }), /signal|SIGTERM|exit/i);
  incomplete(await runProvider('typescript', root, { worker: worker("process.stdout.write('{');") }), /output|JSON|protocol/i);
  incomplete(await runProvider('typescript', root, { worker: worker("process.stdout.write('{}');") }), /output|schema|protocol/i);
  const json = JSON.stringify(value);
  const limit = 8388608;
  const atLimit = worker(`process.stdout.write(${JSON.stringify(json)});process.stderr.write('x'.repeat(${limit - Buffer.byteLength(json)}));`);
  complete(await runProvider('typescript', root, { worker: atLimit }));
  const above = worker(`process.stdout.write(${JSON.stringify(json)});process.stderr.write('x'.repeat(${limit - Buffer.byteLength(json) + 1}));`);
  incomplete(await runProvider('typescript', root, { worker: above }), /output|bytes|limit/i);
  const endless = worker("setInterval(()=>process.stderr.write('x'.repeat(65536)),0);");
  incomplete(await runProvider('typescript', root, { worker: endless, outputBytes: 32768, timeoutMs: 5000 }), /output|bytes|limit/i);
  const failureAfterResult = worker(`process.stdout.write(${JSON.stringify(json)});process.exitCode=3;`);
  incomplete(await runProvider('typescript', root, { worker: failureAfterResult }), /exit/i);
  const partial = { ...value, diagnostics: ['z.ts', 'a.ts'].map(file => ({ source: 'typescript', file, line: 1, column: 1, code: '123', severity: 'error', message: 'retained' })) };
  const unsortedComplete = worker(`process.stdout.write(${JSON.stringify(JSON.stringify(partial))});`);
  assert.deepEqual(complete(await runProvider('typescript', root, { worker: unsortedComplete })).diagnostics.map(d => d.file), ['a.ts', 'z.ts']);
  const unsortedFailure = worker(`process.stdout.write(${JSON.stringify(JSON.stringify(partial))});process.exitCode=3;`);
  const retained = incomplete(await runProvider('typescript', root, { worker: unsortedFailure }), /exit/i);
  assert.deepEqual(retained.diagnostics.map(d => d.file), ['a.ts', 'z.ts'], 'retained valid diagnostics must still be sorted');
  const missingTs = fixture();
  fs.unlinkSync(path.join(missingTs, 'node_modules/typescript'));
  const both = decode(run(missingTs, ['--json']));
  assert.deepEqual(both.providers.map(p => p.source), ['typescript', 'eslint']);
  assert.equal(both.providers[1].status, 'incomplete');
});

/** @id TEST-DIAGCLI-PROCSTATE-001 @verifies REQ-DIAGCLI-004 REQ-DIAGCLI-005 */
test('TEST-DIAGCLI-PROCSTATE-001 distinguishes terminal transitions from live unknown and failed probes', () => {
  const pid = 123;
  const states = [
    ['R', true], ['S', true], ['D', true], ['Z', false], ['T', true], ['t', true],
    ['W', true], ['X', false], ['x', false], ['K', true], ['P', true], ['I', true],
  ];
  const stat = (state, name = 'node') => `${pid} (${name}) ${state} 1 123 123 0`;
  for (const name of ['node', 'MainThread', 'worker (nested)', 'a) Z b', 'a) X b', 'a) x b']) {
    for (const [state, expected] of states) {
      const calls = [];
      const actual = ownedDescendantRunning(pid, {
        platform: 'linux',
        kill: (...args) => calls.push(args),
        readStat: target => {
          assert.equal(target, pid);
          return stat(state, name);
        },
      });
      assert.equal(actual, expected, `Linux ${state} in ${name}: terminal must not mean running`);
      assert.deepEqual(calls, [[pid, 0]], 'probe only the owned PID without delivering a signal');
    }
  }
  for (const text of [stat('?'), '', 'garbled stat', `${pid} (node) X`]) {
    assert.equal(ownedDescendantRunning(pid, {
      platform: 'linux', kill() {}, readStat: () => text,
    }), true, 'unknown or malformed observations cannot prove termination');
  }
  for (const platform of ['win32', 'darwin']) {
    assert.equal(ownedDescendantRunning(pid, {
      platform, kill() {}, readStat: () => assert.fail('non-Linux must not read /proc'),
    }), true);
  }
  const vanished = Object.assign(new Error('owned PID absent'), { code: 'ESRCH' });
  assert.doesNotThrow(() => assert.equal(ownedDescendantRunning(pid, {
    kill: () => { throw vanished; },
    readStat: () => assert.fail('absent PID must not require stat'),
  }), false), 'owned PID absent');
  const missingStat = Object.assign(new Error('owned PID disappeared during stat'), { code: 'ENOENT' });
  assert.doesNotThrow(() => assert.equal(ownedDescendantRunning(pid, {
    platform: 'linux', kill() {}, readStat: () => { throw missingStat; },
  }), false), 'owned PID disappeared during stat');
  for (const code of ['EPERM', 'EIO', undefined]) {
    for (const operation of ['kill', 'stat']) {
      const error = Object.assign(new Error('owned PID probe failed'), { code });
      assert.throws(() => ownedDescendantRunning(pid, {
        platform: 'linux',
        kill: () => { if (operation === 'kill') throw error; },
        readStat: () => { if (operation === 'stat') throw error; return stat('R'); },
      }), actual => actual === error, `${operation}/${code}: preserve unexpected errors`);
    }
  }
  let step = 0;
  const transition = {
    platform: 'linux',
    kill: () => { if (step === 2) throw vanished; },
    readStat: () => stat(['Z', 'X'][step++]),
  };
  assert.equal(ownedDescendantRunning(pid, transition), false, 'zombie ends the wait');
  assert.equal(ownedDescendantRunning(pid, transition), false, 'dead state remains terminal');
  assert.equal(ownedDescendantRunning(pid, transition), false, 'reaped PID remains absent');
});

/** @id TEST-DIAGCLI-CLOSE-001 @verifies REQ-DIAGCLI-004 REQ-DIAGCLI-005 */
test('TEST-DIAGCLI-CLOSE-001 checks close-time deadlines and retains native failures during descendant cleanup', async () => {
  const calls = [];
  killOwnedDescendant(123, (pid, signal) => calls.push([pid, signal]));
  assert.deepEqual(calls, [[123, 'SIGKILL']], 'cleanup targets only the owned PID with the existing signal');
  const absent = Object.assign(new Error('owned process already absent'), { code: 'ESRCH' });
  assert.doesNotThrow(() => killOwnedDescendant(123, () => { throw absent; }),
    'an owned descendant may exit between the running probe and final kill');
  for (const code of ['EPERM', 'EIO', undefined]) {
    const error = Object.assign(new Error('cleanup failed'), { code });
    assert.throws(() => killOwnedDescendant(123, () => { throw error; }), actual => actual === error,
      'permission and unknown cleanup errors must propagate unchanged');
  }
  const root = fixture();
  const timeoutMs = 60000;
  for (const elapsed of [timeoutMs - 1, timeoutMs, timeoutMs + 1]) {
    for (const status of ['complete', 'incomplete']) {
      for (const descendants of [false, true]) {
        const label = `${elapsed}/${status}/${descendants}`;
        const marker = path.join(root, `close-${elapsed}-${status}-${descendants}`);
        const pidFile = marker + '.pid';
        const value = { ...result(), status,
          reason: status === 'incomplete' ? 'Native provider timed out before worker close' : null,
          files: status === 'incomplete' ? { included: null, checked: null, ignored: null } : result().files,
          diagnostics: [{ source: 'typescript', file: 'a.js', line: 1, column: 1,
            code: 'retained', severity: 'warning', message: 'valid native diagnostic' }] };
        const code = worker(`import fs from 'node:fs';import {spawn} from 'node:child_process';
          ${descendants ? `const child=spawn(process.execPath,['-e','setInterval(()=>{},10000)'],{stdio:'ignore'});
          fs.writeFileSync(${JSON.stringify(pidFile)},String(child.pid));` : ''}
          fs.writeFileSync(${JSON.stringify(marker)},'closed');
          process.stdout.write(${JSON.stringify(JSON.stringify(value))},()=>process.exit(0));`);
        const started = Date.now();
        const clock = () => fs.existsSync(marker) ? started + elapsed : started;
        const running = ownedDescendantRunning;
        let descendant;
        try {
          const actual = await runProvider('typescript', root, { worker: code, timeoutMs, clock });
          if (elapsed < timeoutMs && status === 'complete' && !descendants) complete(actual);
          else incomplete(actual);
          if (elapsed >= timeoutMs) assert.match(actual.reason, /Provider timed out after 60000 ms/, label);
          if (status === 'incomplete') assert.ok(actual.reason.includes(value.reason), label);
          if (descendants) {
            assert.match(actual.reason, /descendant|process group/i, label);
            descendant = Number(fs.readFileSync(pidFile, 'utf8'));
            assert.ok(Number.isSafeInteger(descendant) && descendant > 0, label);
            const deadline = Date.now() + 5000;
            while (running(descendant) && Date.now() < deadline) await new Promise(resolve => setImmediate(resolve));
            assert.equal(running(descendant), false, `${label}: owned descendant must stop`);
          }
          assert.deepEqual(actual.diagnostics, value.diagnostics, `${label}: preserve valid diagnostics`);
        } finally {
          if (descendants && fs.existsSync(pidFile)) {
            descendant = Number(fs.readFileSync(pidFile, 'utf8'));
            if (Number.isSafeInteger(descendant) && descendant > 0 && running(descendant)) killOwnedDescendant(descendant);
          }
        }
      }
    }
  }
  for (const invalid of ['{"reason":"untrusted native timeout"',
    JSON.stringify({ ...result(), reason: 'untrusted native timeout', diagnostics: ['invalid'] })]) {
    const actual = incomplete(await runProvider('typescript', root,
      { worker: worker(`process.stdout.write(${JSON.stringify(invalid)});`) }), /JSON|schema|output/i);
    assert.doesNotMatch(actual.reason, /untrusted native timeout/);
    assert.deepEqual(actual.diagnostics, []);
  }
  const marker = path.join(root, 'output-before-close');
  const started = Date.now();
  const overflow = worker(`import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(marker)},'closed');
    process.stderr.write('x'.repeat(2049));`);
  incomplete(await runProvider('typescript', root, { worker: overflow, outputBytes: 2048, timeoutMs,
    clock: () => fs.existsSync(marker) ? started + timeoutMs : started }), /output exceeds 2048 bytes/);
});

/** @id TEST-DIAGCLI-005 @verifies REQ-DIAGCLI-005 */
test('TEST-DIAGCLI-005 no writes, installs, emit, caches or evidence and no snapshot promotion', () => {
  const root = fixture({ config: { incremental: true, declaration: true, sourceMap: true } });
  write(root, '.sdd/tdd.jsonl', 'prior evidence\n');
  const before = snapshot(root);
  const actual = run(root, ['--json']);
  assert.equal(actual.code, 0, actual.out + actual.err);
  assert.equal(decode(actual).snapshot, true);
  assert.deepEqual(snapshot(root), before);
  const human = run(root);
  assert.equal(human.code, 0, human.out + human.err);
  assert.match(human.out, /not.*(?:TDD|gate)|(?:TDD|gate).*not/i);
});

/** @id TEST-DIAGTS-001 @verifies REQ-DIAGTS-001 */
test('TEST-DIAGTS-001 local version, root config and references admission', async () => {
  complete(await diagnoseTypeScript(fixture()));
  const missing = fixture({ tools: false });
  incomplete(await diagnoseTypeScript(missing), /typescript|local/i);
  const noConfig = fixture();
  fs.unlinkSync(path.join(noConfig, 'tsconfig.json'));
  incomplete(await diagnoseTypeScript(noConfig), /config/i);
  for (const version of ['5.8.3', '6.0.0', '5.9.0-beta']) {
    const wrong = fixture();
    fakePackage(wrong, 'typescript', version);
    const rejected = incomplete(await diagnoseTypeScript(wrong), /version|5\.9|unsupported/i);
    assert.doesNotMatch(rejected.reason, /must not load/);
  }
  const broken = fixture();
  write(broken, 'tsconfig.json', '{"compilerOptions": ');
  incomplete(await diagnoseTypeScript(broken), /config/i);
  const refs = fixture();
  write(refs, 'tsconfig.json', '{"files":["a.js"],"references":[{"path":"child"}]}');
  incomplete(await diagnoseTypeScript(refs), /reference/i);
  const parent = fixture();
  const child = path.join(parent, 'child');
  fs.mkdirSync(child);
  write(child, 'tsconfig.json', '{"files":["a.ts"]}');
  write(child, 'a.ts', 'export const x = 1;');
  incomplete(await diagnoseTypeScript(child), /local|typescript/i);
});

/** @id TEST-DIAGTS-002 @verifies REQ-DIAGTS-002 */
test('TEST-DIAGTS-002 complete program, consumers, extends, JS policy and no emit', async () => {
  const root = fixture({ files: { 'a.ts': 'export const x = 1;\n', 'consumer.ts': 'import {x} from "./a"; const n: string = x;\n', 'ignored.ts': 'const x: number = "ignored";\n' } });
  write(root, 'base.json', '{"compilerOptions":{"target":"ES2020","skipLibCheck":true,"incremental":true,"declaration":true}}');
  write(root, 'tsconfig.json', '{"extends":"./base.json","include":["a.ts","consumer.ts"]}');
  const before = snapshot(root);
  const p = complete(await diagnoseTypeScript(root));
  assert.equal(p.files.included, 2);
  assert.ok(p.diagnostics.some(d => d.file === 'consumer.ts' && d.code === '2322'));
  assert.ok(!p.diagnostics.some(d => d.file === 'ignored.ts'));
  assert.deepEqual(snapshot(root), before);
  write(root, 'consumer.ts', 'import {x} from "./a"; const n: number = x;\n');
  assert.equal(complete(await diagnoseTypeScript(root)).diagnostics.length, 0);
  const js = fixture({ files: { 'a.js': '/** @type {number} */\nconst x = "wrong";\n' } });
  assert.equal(complete(await diagnoseTypeScript(js)).diagnostics.length, 0);
  write(js, 'tsconfig.json', '{"compilerOptions":{"allowJs":true,"checkJs":true,"noEmit":true},"files":["a.js"]}');
  assert.ok(complete(await diagnoseTypeScript(js)).diagnostics.some(d => d.code === '2322'));
});

/** @id TEST-DIAGTS-003 @verifies REQ-DIAGTS-003 */
test('TEST-DIAGTS-003 category, fileless, multiline and UTF-16 positions', () => {
  const root = fixture({ files: { 'a.ts': '// header\nconst emoji = "😀"; const x: number = "bad";\n' } });
  const file = path.join(root, 'a.ts');
  const text = fs.readFileSync(file, 'utf8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest);
  const start = text.indexOf('"bad"');
  const expectedColumn = text.slice(text.lastIndexOf('\n', start) + 1, start).length + 1;
  const severities = ['warning', 'error', 'hint', 'info'];
  for (let category = 0; category < 4; category++) {
    const d = normalizeTypeScriptDiagnostic(ts, { file: source, start, category, code: 123, messageText: { messageText: 'outer', category, code: 123, next: [{ messageText: 'inner', category, code: 124 }] } }, root);
    assert.equal(d?.severity, severities[category]);
    assert.equal(d.file, 'a.ts');
    assert.equal(d.line, 2);
    assert.equal(d.column, expectedColumn);
    assert.equal(d.code, '123');
    assert.match(d.message, /outer\n.*inner/);
  }
  const noFile = normalizeTypeScriptDiagnostic(ts, { category: 1, code: 500, messageText: 'options' }, root);
  assert.deepEqual([noFile?.file, noFile?.line, noFile?.column], [null, null, null]);
});

/** @id TEST-DIAGTS-004 @verifies REQ-DIAGTS-004 */
test('TEST-DIAGTS-004 empty and invalid options differ from completed type errors', async () => {
  const valid = complete(await diagnoseTypeScript(fixture()));
  assert.ok(valid.files.included > 0);
  assert.ok(valid.files.checked >= valid.files.included);
  assert.equal(valid.files.ignored, 0);
  const error = complete(await diagnoseTypeScript(fixture({ files: { 'a.ts': 'const x: number = "bad";\n' } })));
  assert.ok(error.diagnostics.some(d => d.severity === 'error'));
  const empty = fixture({ files: {} });
  incomplete(await diagnoseTypeScript(empty), /input|file|config/i);
  const options = fixture();
  write(options, 'tsconfig.json', '{"compilerOptions":{"target":"not-a-target"},"files":["a.js"]}');
  const invalid = incomplete(await diagnoseTypeScript(options), /config/i);
  assert.ok(invalid.diagnostics.some(d => d.file === null || d.code));
});

/** @id TEST-DIAGESL-001 @verifies REQ-DIAGESL-001 */
test('TEST-DIAGESL-001 exact local ESLint version and one root flat config', async () => {
  complete(await diagnoseESLint(fixture()));
  const missing = fixture();
  fs.unlinkSync(path.join(missing, 'node_modules/eslint'));
  incomplete(await diagnoseESLint(missing), /eslint|local/i);
  const wrong = fixture();
  fakePackage(wrong, 'eslint', '8.57.0');
  const rejected = incomplete(await diagnoseESLint(wrong), /9|version|unsupported/i);
  assert.doesNotMatch(rejected.reason, /must not load/);
  const absent = fixture();
  fs.unlinkSync(path.join(absent, 'eslint.config.cjs'));
  write(absent, '.eslintrc.json', '{}');
  incomplete(await diagnoseESLint(absent), /config/i);
  const multiple = fixture();
  write(multiple, 'eslint.config.mjs', 'export default [];\n');
  incomplete(await diagnoseESLint(multiple), /one|multiple|config/i);
  const thrown = fixture();
  write(thrown, 'eslint.config.cjs', 'throw new Error("plugin loading broken");');
  incomplete(await diagnoseESLint(thrown), /plugin loading broken/);
});

/** @id TEST-DIAGESL-002 @verifies REQ-DIAGESL-002 */
test('TEST-DIAGESL-002 tsconfig targets, ignore accounting, all extensions and no fix', async () => {
  const files = Object.fromEntries(['js','jsx','mjs','cjs','ts','tsx','mts','cts'].map(ext => [`input-${ext}.${ext}`, 'debugger;\n']));
  files['declaration.d.ts'] = 'declare const value: number;\n';
  files['input-js.js'] = 'debugger;;\n';
  const root = fixture({ files });
  write(root, 'eslint.config.cjs', fs.readFileSync(path.join(root, 'eslint.config.cjs'), 'utf8').replace("'no-debugger':'error'", "'no-debugger':'error','no-extra-semi':'error'"));
  const before = snapshot(root);
  const p = complete(await diagnoseESLint(root));
  assert.equal(p.files.included, 8);
  assert.equal(p.files.checked, 8);
  assert.equal(p.files.ignored, 0);
  assert.equal(p.diagnostics.filter(d => d.code === 'no-debugger').length, 8);
  assert.ok(p.diagnostics.some(d => d.code === 'no-extra-semi'), 'fixable diagnostics must not be silently fixed');
  assert.deepEqual(snapshot(root), before);
  const ignore = fixture({ files: { 'a.js': 'debugger;', 'skip.js': 'debugger;' } });
  const original = fs.readFileSync(path.join(ignore, 'eslint.config.cjs'), 'utf8');
  write(ignore, 'eslint.config.cjs', original.replace('module.exports = [', 'module.exports = [{ignores:["skip.js"]},'));
  const mixed = complete(await diagnoseESLint(ignore));
  assert.deepEqual(mixed.files, { included: 2, checked: 1, ignored: 1 });
  write(ignore, 'eslint.config.cjs', 'module.exports=[{ignores:["**/*"]}];');
  incomplete(await diagnoseESLint(ignore), /ignored|input|file/i);
  const missingTS = fixture();
  fs.unlinkSync(path.join(missingTS, 'node_modules/typescript'));
  incomplete(await diagnoseESLint(missingTS), /typescript|local/i);
  const noJS = fixture();
  write(noJS, 'tsconfig.json', '{"compilerOptions":{"allowJs":false},"include":["*.js"]}');
  incomplete(await diagnoseESLint(noJS), /input|file|config/i);
});

/** @id TEST-DIAGESL-003 @verifies REQ-DIAGESL-003 */
test('TEST-DIAGESL-003 lint errors, warnings, parse errors and UTF-16 positions', async () => {
  const root = fixture({ files: { 'a.js': 'const emoji = "😀"; debugger;\n' } });
  const p = complete(await diagnoseESLint(root));
  const error = p.diagnostics.find(d => d.code === 'no-debugger');
  const warning = p.diagnostics.find(d => d.code === 'no-unused-vars');
  assert.equal(error?.severity, 'error');
  assert.equal(warning?.severity, 'warning');
  assert.equal(error.line, 1);
  assert.equal(error.column, 'const emoji = "😀"; '.length + 1);
  const broken = fixture({ files: { 'a.js': 'const = ;\n' } });
  const parse = complete(await diagnoseESLint(broken));
  assert.ok(parse.diagnostics.some(d => d.code === 'ESLINT_PARSE' && d.severity === 'error'));
  const unconfigured = fixture({ files: { 'a.js': 'debugger;', 'b.ts': 'debugger;' } });
  write(unconfigured, 'eslint.config.cjs', 'module.exports=[{files:["**/*.js"],rules:{"no-debugger":"error"}}];');
  assert.deepEqual(complete(await diagnoseESLint(unconfigured)).files, { included: 2, checked: 1, ignored: 1 });
});

/** @id TEST-DIAGESL-004 @verifies REQ-DIAGESL-004 */
test('TEST-DIAGESL-004 configuration/plugin abort is incomplete, not clean', async () => {
  complete(await diagnoseESLint(fixture()));
  const bad = fixture();
  write(bad, 'eslint.config.cjs', 'module.exports=[{rules:{"nonexistent-plugin/rule":"error"}}];');
  incomplete(await diagnoseESLint(bad), /plugin|rule/i);
  const thrown = fixture();
  write(thrown, 'eslint.config.cjs', 'throw new Error("deliberate config abort");');
  incomplete(await diagnoseESLint(thrown), /deliberate config abort/);
});

/** @id TEST-DIAGFLOW-001 @verifies REQ-DIAGFLOW-001 */
test('TEST-DIAGFLOW-001 source, wrapper, packed and initialized diagnostics agree', () => {
  const root = fixture();
  const source = run(root, ['--json']);
  assert.equal(source.code, 0, source.out + source.err);
  const pack = fs.mkdtempSync(path.join(scratch, 'pack-'));
  const packed = spawnSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', pack], { cwd: repo, env, encoding: 'utf8', timeout: 60000 });
  assert.equal(packed.status, 0, packed.stderr);
  const json = JSON.parse(packed.stdout);
  const info = Array.isArray(json) ? json[0] : Object.values(json)[0];
  assert.ok(info.files.some(f => f.path.endsWith('/diagnostics.mjs')));
  assert.ok(info.files.some(f => f.path.endsWith('/diagnostics-worker.mjs')));
  const unpack = spawnSync('tar', ['-xzf', path.join(pack, info.filename), '-C', pack], { env, encoding: 'utf8' });
  assert.equal(unpack.status, 0, unpack.stderr);
  const packedWrapper = path.join(pack, 'package/bin/musubix6.mjs');
  const install = path.join(scratch, `installed-${path.basename(root)}`);
  const init = spawnSync(process.execPath, [packedWrapper, 'init', install, '--only', 'lean-sdd-tdd'], { env, encoding: 'utf8' });
  assert.equal(init.status, 0, init.stdout + init.stderr);
  const copied = path.join(install, '.github/skills/lean-sdd-tdd/scripts/sdd.mjs');
  const entries = [[script, []], [wrapper, ['sdd']], [packedWrapper, ['sdd']], [copied, []]];
  function semantic(data) {
    return { profile: data.profile, status: data.status, exitCode: data.exitCode, providers: data.providers.map(p => ({ source: p.source, status: p.status, version: p.version, files: p.files, reason: !!p.reason, diagnostics: p.diagnostics })) };
  }
  for (const [file, expected] of [['export const x = 1;', 0], ['debugger;', 1]]) {
    write(root, 'a.js', file);
    const reference = semantic(decode(run(root, ['--json'])));
    for (const [entry, prefix] of entries) {
      const actual = run(root, ['--json'], entry, prefix);
      assert.equal(actual.code, expected, actual.out + actual.err);
      assert.deepEqual(semantic(decode(actual)), reference);
    }
  }
  fs.unlinkSync(path.join(root, 'node_modules/typescript'));
  for (const [entry, prefix] of entries) assert.equal(run(root, ['--json'], entry, prefix).code, 2);
});

/** @id TEST-DIAGFLOW-002 @verifies REQ-DIAGFLOW-002 */
test('TEST-DIAGFLOW-002 skill instructions apply diagnosis only to supported edit batches', () => {
  const text = fs.readFileSync(path.join(here, '../SKILL.md'), 'utf8');
  assert.match(text, /diagnostics/);
  assert.match(text, /edit batch/i);
  assert.match(text, /INCOMPLETE/);
  assert.match(text, /requested.*scope|scope.*requested/i);
  assert.match(text, /Python.*Rust|Rust.*Python/);
});

/** @id TEST-DIAGFLOW-003 @verifies REQ-DIAGFLOW-003 */
test('TEST-DIAGFLOW-003 diagnostics does not initialize evidence or replace gate/Red', () => {
  const root = fixture();
  const before = snapshot(root);
  assert.equal(run(root, ['--json']).code, 0);
  assert.deepEqual(snapshot(root), before);
  const trace = spawnSync(process.execPath, [script, '--root', root, 'gate', '--no-run'], { env, encoding: 'utf8', timeout: 30000 });
  assert.notEqual(trace.status, 0, 'diagnostics cannot initialize or approve an SDD project');
  const text = fs.readFileSync(path.join(here, '../SKILL.md'), 'utf8');
  assert.match(text, /diagnostics.*(?:not|never).*Red|(?:not|never).*Red.*diagnostics/is);
  assert.match(text, /full.*gate/i);
});

/** @id TEST-DIAGFLOW-004 @verifies REQ-DIAGFLOW-004 */
test('TEST-DIAGFLOW-004 bilingual diagnostics contract and limits are documented', () => {
  for (const file of ['README.md', 'README-ja.md']) {
    const text = fs.readFileSync(path.join(repo, file), 'utf8');
    assert.match(text, /musubix6 sdd diagnostics --root .* --json/);
    assert.match(text, /PASS.*0/);
    assert.match(text, /FAIL.*1/);
    assert.match(text, /INCOMPLETE.*2/);
    assert.match(text, /5\.9/);
    assert.match(text, /ESLint 9/);
    assert.match(text, /Python/);
    assert.match(text, /Rust/);
    assert.match(text, /snapshot|スナップショット/);
    assert.match(text, /8 MiB/);
    assert.match(text, /60/);
  }
});
