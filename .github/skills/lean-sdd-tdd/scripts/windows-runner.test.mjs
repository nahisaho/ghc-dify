import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = process.env.SDD_SCRIPT_UNDER_TEST ?? fileURLToPath(new URL('./sdd.mjs', import.meta.url));
const source = fs.readFileSync(script, 'utf8');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-windows-'));
after(() => fs.rmSync(work, { recursive: true, force: true }));
const baseEnv = { ...process.env };
delete baseEnv.NODE_TEST_CONTEXT;
const hash = value => createHash('sha256').update(value).digest('hex');

function fixture() {
  const root = fs.mkdtempSync(path.join(work, 'fixture-'));
  const bin = path.join(root, 'node tools');
  fs.mkdirSync(path.join(bin, 'node_modules/npm/bin'), { recursive: true });
  for (const name of ['npm', 'npx']) {
    fs.writeFileSync(path.join(bin, name), '#!/bin/sh\nexit 91\n', { mode: 0o755 });
    fs.writeFileSync(path.join(bin, `${name}.cmd`), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    fs.writeFileSync(path.join(bin, `node_modules/npm/bin/${name}-cli.js`),
      'console.log(JSON.stringify(process.argv.slice(2))); process.exit(Number(process.env.WIN_EXIT ?? 0));\n');
  }
  return { root, bin };
}

function helpers(root, env, platform = 'win32') {
  const block = source.slice(source.indexOf('const RUNNER_ENV_ALLOWLIST ='), source.indexOf('function dotnetStamp('));
  const run = source.slice(source.indexOf('function run1('), source.indexOf('function pytestArgs('));
  const calls = [];
  const api = new Function('fs', 'path', 'process', 'ROOT', 'listFiles', 'fileSha', 'sha', 'spawnSync', 'pytestArgs',
    `${block}\n${run}\nreturn { resolveExecutable, runnerEnv, runnerEnvRecord, run1,
      runnerSdkDefinitions: typeof runnerSdkDefinitions === 'function' ? runnerSdkDefinitions : undefined };`)(
    fs, path, { env, platform, execPath: process.execPath },
    root, () => ['node tools/node_modules/npm/bin/npm-cli.js', 'node tools/node_modules/npm/bin/npx-cli.js'],
    file => hash(fs.readFileSync(path.resolve(root, file))), hash,
    (...args) => { calls.push(args); return spawnSync(...args); }, () => null,
  );
  return { ...api, calls };
}

/** @id TEST-WINRUN-001 @verifies REQ-WINRUN-001 */
test('TEST-WINRUN-001 Windows resolution skips POSIX shims and preserves explicit extension order', () => {
  const { root, bin } = fixture();
  for (const key of ['PATH', 'Path', 'path']) {
    const api = helpers(root, { [key]: bin, PathExt: '.EXE;.CMD' });
    assert.equal(api.resolveExecutable('npm', root), path.join(bin, 'npm.cmd'), key);
    assert.equal(api.resolveExecutable(path.join(bin, 'npm.cmd'), root), path.join(bin, 'npm.cmd'));
  }
  fs.writeFileSync(path.join(bin, 'npm.exe'), '');
  for (const [extensions, expected] of [
    ['.CMD;.EXE', 'npm.cmd'], [' .exe ;.EXE;.cmd ', 'npm.exe'], ['.JS;.CMD', 'npm.cmd'],
    ['', null], ['.JS', null],
  ]) {
    const api = helpers(root, { PATH: bin, PATHEXT: extensions });
    assert.equal(api.resolveExecutable('npm', root), expected && path.join(bin, expected), extensions);
  }
  assert.equal(helpers(root, { PATH: bin }).resolveExecutable('npm', root), path.join(bin, 'npm.exe'));
  for (const suffix of ['com', 'bat']) fs.writeFileSync(path.join(bin, `npm.${suffix}`), '');
  const permutations = values => values.length ? values.flatMap((value, i) =>
    permutations(values.filter((_, j) => i !== j)).map(rest => [value, ...rest])) : [[]];
  for (const order of permutations(['com', 'exe', 'bat', 'cmd'])) {
    const api = helpers(root, { PATH: bin, PATHEXT: order.map(suffix => `.${suffix}`).join(';') });
    assert.equal(api.resolveExecutable('npm', root), path.join(bin, `npm.${order[0]}`), order.join(';'));
  }
  assert.equal(helpers(root, { PATHEXT: '' }).resolveExecutable(path.join(bin, 'npm.exe'), root),
    path.join(bin, 'npm.exe'));
  const first = path.join(root, 'first');
  fs.mkdirSync(first);
  fs.writeFileSync(path.join(first, 'npm.cmd'), '');
  assert.equal(helpers(root, { PATH: [first, bin].join(path.delimiter) }).resolveExecutable('npm', root),
    path.join(first, 'npm.cmd'), 'PATH directory order precedes PATHEXT order');
  if (process.platform !== 'win32') {
    const posix = helpers(root, { PATH: bin }, 'linux');
    assert.equal(posix.resolveExecutable('npm', root), path.join(bin, 'npm'));
    fs.chmodSync(path.join(bin, 'npm'), 0o644);
    assert.equal(posix.resolveExecutable('npm', root), null);
  }
});

/** @id TEST-WINRUN-002 @verifies REQ-WINRUN-002 */
test('TEST-WINRUN-002 npm adapters preserve literal argv exits and explicit setup failures without a shell', () => {
  const { root, bin } = fixture();
  const args = ['space value', '& echo forbidden', '%PATH%', '!x!', 'quote"value', '', 'trailing\\'];
  for (const name of ['npm', 'npx']) for (const exit of [0, 7]) {
    const api = helpers(root, { ...baseEnv, PATH: bin, WIN_EXIT: String(exit) });
    const result = api.run1([path.join(bin, `${name}.cmd`), ...args], 10000, '.');
    assert.equal(result.exit, exit, result.text);
    assert.match(result.text, /^\[/, 'npm CLI did not receive the argument vector');
    assert.deepEqual(JSON.parse(result.text), args);
    const [executable, actualArgs, options] = api.calls.at(-1);
    assert.equal(executable, process.execPath);
    assert.equal(actualArgs[0], path.join(bin, `node_modules/npm/bin/${name}-cli.js`));
    assert.notEqual(options.shell, true);
    assert.notEqual(options.windowsVerbatimArguments, true);
  }
  const linked = path.join(root, 'linked tools');
  fs.symlinkSync(bin, linked, process.platform === 'win32' ? 'junction' : 'dir');
  const throughLink = helpers(root, { ...baseEnv, PATH: linked }).run1([path.join(linked, 'npm.cmd'), ...args], 10000);
  assert.equal(throughLink.exit, 0, throughLink.text);
  assert.deepEqual(JSON.parse(throughLink.text), args);
  for (const name of ['missing.cmd', 'other.bat']) {
    fs.writeFileSync(path.join(bin, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const api = helpers(root, { PATH: bin });
    const result = api.run1([path.join(bin, name)], 10000);
    assert.notEqual(result.exit, 0);
    assert.match(result.text, /unsupported.*batch|batch.*unsupported/i);
    assert.equal(api.calls.length, 0);
  }
  fs.unlinkSync(path.join(bin, 'node_modules/npm/bin/npm-cli.js'));
  const missing = helpers(root, { PATH: bin }).run1([path.join(bin, 'npm.cmd')], 10000);
  assert.notEqual(missing.exit, 0);
  assert.match(missing.text, /npm-cli\.js/);
  const noExtensions = helpers(root, { PATH: bin, PATHEXT: '' });
  const unresolved = noExtensions.run1(['npm'], 10000);
  assert.notEqual(unresolved.exit, 0);
  assert.match(unresolved.text, /not found/i);
  assert.equal(noExtensions.calls.length, 0, 'unresolved names must not fall through to native implicit lookup');
  fs.writeFileSync(path.join(bin, 'npm.bat'), '');
  const firstBatch = helpers(root, { PATH: bin, PATHEXT: '.BAT;.CMD' });
  const refused = firstBatch.run1(['npm'], 10000);
  assert.notEqual(refused.exit, 0);
  assert.match(refused.text, /unsupported.*batch/i);
  assert.equal(firstBatch.calls.length, 0, 'unsupported first match must not be bypassed');
});

/** @id TEST-WINRUN-003 @verifies REQ-WINRUN-003 */
test('TEST-WINRUN-003 adapter and SDK drift invalidate real Red Green command provenance', () => {
  const { root, bin } = fixture();
  for (const include of [undefined, '', 'sdk headers']) for (const lib of [undefined, '', 'sdk libraries'])
    for (const libpath of [undefined, '', 'sdk metadata']) {
      const inputs = { INCLUDE: include, LIB: lib, LIBPATH: libpath };
      const api = helpers(root, inputs);
      assert.equal(typeof api.runnerSdkDefinitions, 'function', 'SDK definitions must be explicit');
      const definitions = new Map(api.runnerSdkDefinitions());
      assert.equal(definitions.size, 3);
      for (const [name, value] of Object.entries(inputs)) {
        assert.equal(definitions.get(`environment:msvc|${name}`).sha,
          hash(JSON.stringify(['sdd-msvc-env-v1', name, value ?? null])), `${name}: ${String(value)}`);
      }
    }
  const probeCli = path.join(bin, 'node_modules/npm/bin/npm-cli.js');
  fs.writeFileSync(probeCli, "require('node:fs').writeFileSync('INCLUDE', 'compiler scratch output');\n"
    + fs.readFileSync(probeCli, 'utf8'));
  fs.writeFileSync(path.join(bin, 'npm.cmd'), 'node.exe\n');
  const nativeBinary = path.join(bin, 'node.exe');
  const binaryFd = fs.openSync(nativeBinary, 'w');
  try { fs.ftruncateSync(binaryFd, 16 * 1024 * 1024 + 1); }
  finally { fs.closeSync(binaryFd); }
  const testNode = path.join(root, 'test-node.exe');
  fs.copyFileSync(process.execPath, testNode);
  const linked = path.join(root, 'linked tools');
  fs.symlinkSync(bin, linked, process.platform === 'win32' ? 'junction' : 'dir');
  const measured = path.join(work, `measured-${path.basename(root)}.mjs`);
  const start = source.indexOf('const RUNNER_ENV_ALLOWLIST =');
  const end = source.indexOf('function dotnetStamp(');
  fs.writeFileSync(measured, source.slice(0, start)
    + source.slice(start, end).replaceAll('process.platform', "'win32'")
    + source.slice(end).replace("if (process.platform !== 'win32') return false;", 'if (false) return false;'));
  const sdk = { INCLUDE: 'sdk headers', LIB: 'sdk libraries', LIBPATH: '' };
  const run = (...args) => spawnSync(process.execPath, [measured, '--root', root, ...args],
    { encoding: 'utf8', env: { ...baseEnv, ...sdk } });
  fs.mkdirSync(path.join(root, '.sdd/specs'), { recursive: true });
  fs.writeFileSync(path.join(root, '.sdd/specs/a.md'),
    '---\nfeature: a\ntier: T1\n---\n| REQ-A-001 | The system shall return one. | TEST-A-001 |\n');
  fs.writeFileSync(path.join(root, '.sdd/config.json'), JSON.stringify({
    schemaVersion: 1,
    scopePolicy: 'strict',
    testCmd: [testNode, '--test', '--test-name-pattern', '{id}', '{file}'],
    checks: [{ name: 'probe', cmd: [path.join(linked, 'npm.cmd'), 'run', 'probe'] }],
  }));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    scripts: { preprobe: 'node before.cjs', probe: 'node body.cjs', postprobe: 'node after.cjs' },
  }));
  for (const name of ['before', 'body', 'after']) fs.writeFileSync(path.join(root, `${name}.cjs`), '');
  fs.writeFileSync(path.join(root, 'a.test.mjs'),
    "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { value } from './a.mjs';\n"
    + '/** @id TEST-A-001 @verifies REQ-A-001 */\n'
    + "test('TEST-A-001', () => assert.equal(value, 1));\n");
  const implementation = value => fs.writeFileSync(path.join(root, 'a.mjs'),
    `/** @id CODE-A-001 @implements REQ-A-001 */\nexport const value = ${value};\n`);
  fs.writeFileSync(path.join(root, 'INCLUDE'), 'tracked compiler scratch output');
  implementation(0);
  for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture']]) {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
  let result = run('tdd', 'red', 'TEST-A-001');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  implementation(1);
  const redLedger = fs.readFileSync(path.join(root, '.sdd/tdd.jsonl'), 'utf8');
  const cliFile = path.join(bin, 'node_modules/npm/bin/npm-cli.js');
  const cliBytes = fs.readFileSync(cliFile);
  fs.appendFileSync(cliFile, '\n// new launcher input\n');
  result = run('tdd', 'green', 'TEST-A-001');
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /changed|admission|re-record/i);
  assert.equal(fs.readFileSync(path.join(root, '.sdd/tdd.jsonl'), 'utf8'), redLedger);
  fs.writeFileSync(cliFile, cliBytes);
  sdk.INCLUDE += ' changed';
  result = run('tdd', 'green', 'TEST-A-001');
  assert.notEqual(result.status, 0);
  assert.equal(fs.readFileSync(path.join(root, '.sdd/tdd.jsonl'), 'utf8'), redLedger);
  sdk.INCLUDE = 'sdk headers';
  result = run('tdd', 'green', 'TEST-A-001');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const ledger = fs.readFileSync(path.join(root, '.sdd/tdd.jsonl'), 'utf8');
  const entries = ledger.trim().split('\n').map(JSON.parse);
  const entry = entries.at(-1);
  const keys = Object.keys(entry.checkDefShas);
  assert.ok(keys.some(key => key.includes('npm-cli.js')), 'actual npm CLI is missing from provenance');
  assert.ok(keys.some(key => key.endsWith('linked tools/npm.cmd')), 'lexical shim location is not bound');
  assert.ok(keys.some(key => key.endsWith('node tools/npm.cmd')), 'real shim location is not bound');
  assert.ok(keys.some(key => key.includes('before.cjs')), 'npm.cmd pre-lifecycle helper is missing');
  assert.ok(keys.some(key => key.includes('after.cjs')), 'npm.cmd post-lifecycle helper is missing');
  assert.ok(keys.some(key => key.startsWith('executable:') && key.endsWith(path.relative(root, process.execPath).split(path.sep).join('/'))),
    'actual hosting Node is not fingerprinted');
  assert.ok(Object.keys(entries[0].admissionShas).some(key => key.startsWith('environment:msvc|')), 'SDK inputs are not admission-bound');
  assert.ok(Object.keys(entries[0].admissionShas).some(key => key.startsWith('launcher:windows|') && key.includes('npm-cli.js')),
    'actual launch inputs are not admission-bound');
  const checkGate = () => {
    for (const args of [[], ['--changed']]) {
      const r = run('gate', ...args);
      assert.equal(r.status, 0, r.stdout + r.stderr);
    }
  };
  checkGate();
  for (const file of [
    path.join(bin, 'npm.cmd'), path.join(bin, 'node_modules/npm/bin/npm-cli.js'),
    nativeBinary, testNode,
    path.join(root, 'before.cjs'), path.join(root, 'after.cjs'), path.join(root, 'package.json'),
  ]) {
    const original = fs.readFileSync(file);
    if (path.basename(file) === 'package.json') {
      const pkg = JSON.parse(original);
      pkg.scripts.postprobe = 'node body.cjs';
      fs.writeFileSync(file, JSON.stringify(pkg));
    } else fs.appendFileSync(file, '\n// drift\n');
    for (const args of [[], ['--changed']]) {
      result = run('gate', ...args);
      assert.notEqual(result.status, 0, file);
      assert.match(result.stdout + result.stderr, /definition|changed|stale|drift/i);
    }
    assert.equal(fs.readFileSync(path.join(root, '.sdd/tdd.jsonl'), 'utf8'), ledger);
    fs.writeFileSync(file, original);
    checkGate();
  }
  for (const name of ['INCLUDE', 'LIB', 'LIBPATH']) {
    const original = sdk[name];
    sdk[name] += ' changed';
    for (const args of [[], ['--changed']]) {
      result = run('gate', ...args);
      assert.notEqual(result.status, 0, name);
      assert.match(result.stdout + result.stderr, /environment|changed|stale|drift/i);
    }
    assert.equal(fs.readFileSync(path.join(root, '.sdd/tdd.jsonl'), 'utf8'), ledger);
    sdk[name] = original;
    checkGate();
  }
});

/** @id TEST-WINRUN-004 @verifies REQ-WINRUN-004 */
test('TEST-WINRUN-004 Windows SDK values reach children without admitting runner overrides', () => {
  const { root, bin } = fixture();
  const env = {
    PATH: bin, INCLUDE: 'C:\\SDK Headers;D:\\Other', LIB: 'C:\\SDK Libs', LIBPATH: '',
    NODE_OPTIONS: '--no-warnings', RUSTFLAGS: '--cfg hidden', PYTEST_ADDOPTS: '-k passing',
  };
  const win = helpers(root, env);
  const filtered = win.runnerEnv([], '.');
  for (const name of ['INCLUDE', 'LIB', 'LIBPATH']) assert.equal(filtered[name], env[name], name);
  for (const name of ['NODE_OPTIONS', 'RUSTFLAGS', 'PYTEST_ADDOPTS']) assert.equal(filtered[name], undefined, name);
  const mixed = helpers(root, { Path: bin, Include: 'headers', lib: 'libs', LibPath: '' }).runnerEnv();
  assert.equal(mixed.INCLUDE, 'headers');
  assert.equal(mixed.LIB, 'libs');
  assert.equal(mixed.LIBPATH, '');
  const duplicate = helpers(root, { INCLUDE: 'first', Include: 'second' }).runnerEnv();
  assert.equal(duplicate.INCLUDE, 'first');
  assert.equal(duplicate.Include, undefined);
  const report = win.runnerEnvRecord();
  assert.ok(report.inherited.includes('INCLUDE'));
  assert.ok(!JSON.stringify(report).includes(env.INCLUDE), 'raw SDK path leaked');
  const linux = helpers(root, env, 'linux').runnerEnv();
  for (const name of ['INCLUDE', 'LIB', 'LIBPATH']) assert.equal(linux[name], undefined, name);
  const child = win.run1([process.execPath, '-e',
    'console.log(JSON.stringify({INCLUDE:process.env.INCLUDE,LIB:process.env.LIB,LIBPATH:process.env.LIBPATH,NODE_OPTIONS:process.env.NODE_OPTIONS}))'], 10000);
  assert.equal(child.exit, 0, child.text);
  assert.deepEqual(JSON.parse(child.text), { INCLUDE: env.INCLUDE, LIB: env.LIB, LIBPATH: env.LIBPATH });
});
