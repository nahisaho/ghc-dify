import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = process.env.SDD_SCRIPT_UNDER_TEST ?? fileURLToPath(new URL('./sdd.mjs', import.meta.url));
const native = process.platform === 'win32';
const env = { ...process.env };
delete env.NODE_TEST_CONTEXT;
function run(command, args, cwd, extra = {}) {
  const result = spawnSync(command, args, { cwd, env: { ...env, ...extra }, encoding: 'utf8', timeout: 60000 });
  assert.ifError(result.error);
  assert.equal(result.signal, null, result.stderr);
  return result;
}
function fixture(t, checks) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd native windows '));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.equal(run('git', ['init', '-q'], root).status, 0);
  fs.mkdirSync(path.join(root, '.sdd'));
  fs.writeFileSync(path.join(root, '.sdd/config.json'), JSON.stringify({
    schemaVersion: 1, checks, testCmd: [process.execPath, '--test', '{file}'], timeoutMs: 30000,
  }));
  return root;
}
function gate(root, extra) {
  const result = run(process.execPath, [script, '--root', root, 'gate', '--json'], root, extra);
  assert.ok(result.stdout.trim(), `gate returned no JSON (exit ${result.status}): ${result.stderr}`);
  return { ...result, report: JSON.parse(result.stdout) };
}

test('native Windows npm and npm.cmd execute real npm with success and nonzero outcomes', { skip: !native }, t => {
  const root = fixture(t, [
    { name: 'npm-probe', cmd: ['npm', 'run', 'probe'] },
    { name: 'npm-cmd-probe', cmd: ['npm.cmd', 'run', 'probe'] },
    { name: 'npm-cmd-fail', cmd: ['npm.cmd', 'run', 'nonzero'] },
  ]);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    scripts: { probe: 'node probe.cjs', nonzero: 'node nonzero.cjs' },
  }));
  fs.writeFileSync(path.join(root, 'probe.cjs'), [
    "const assert = require('node:assert/strict');",
    "const fs = require('node:fs');",
    "for(const name of ['NODE_OPTIONS','RUSTFLAGS','PYTEST_ADDOPTS']) assert.equal(process.env[name], undefined, name);",
    "fs.appendFileSync('executed.txt', 'npm control\\n');",
  ].join('\n'));
  fs.writeFileSync(path.join(root, 'nonzero.cjs'),
    "require('node:fs').appendFileSync('executed.txt', 'nonzero control\\n'); process.exit(7);\n");
  const cli = path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
  assert.ok(fs.existsSync(cli), `native reference npm CLI missing: ${cli}`);
  const direct = run(process.execPath, [cli, 'run', 'probe'], root);
  assert.equal(direct.status, 0, direct.stdout + direct.stderr);
  const nonzero = run(process.execPath, [cli, 'run', 'nonzero'], root);
  assert.equal(nonzero.status, 7, nonzero.stdout + nonzero.stderr);
  const result = gate(root, { NODE_OPTIONS: '--no-warnings', RUSTFLAGS: '--cfg hidden', PYTEST_ADDOPTS: '-k hidden' });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  for (const name of ['npm-probe', 'npm-cmd-probe']) {
    assert.ok(result.report.lines.some(line => line.startsWith(`✓ cmd ${name} (`)), result.stdout);
  }
  assert.ok(result.report.lines.some(line => line.startsWith('✗ cmd npm-cmd-fail')), result.stdout);
  assert.equal(fs.readFileSync(path.join(root, 'executed.txt'), 'utf8'),
    'npm control\nnonzero control\nnpm control\nnpm control\nnonzero control\n');
});

test('native Windows MSVC keeps standard header and Windows SDK linking inputs', { skip: !native }, t => {
  for (const name of ['INCLUDE', 'LIB', 'LIBPATH']) assert.ok(process.env[name], `initialize the MSVC developer environment: ${name}`);
  const root = fixture(t, [{
    name: 'msvc-probe',
    cmd: ['cl.exe', '/nologo', 'native-probe.c', '/Fegate.exe', '/Fogate.obj', '/link', 'kernel32.lib'],
  }]);
  fs.writeFileSync(path.join(root, 'native-probe.c'), [
    '#include <stdio.h>',
    '#include <windows.h>',
    'int main(void) { if (!GetModuleHandleA(NULL)) return 2; puts("MSVC_SDK_CONTROL"); return 0; }',
  ].join('\n'));
  const direct = run('cl.exe', ['/nologo', 'native-probe.c', '/Fedirect.exe', '/Fodirect.obj', '/link', 'kernel32.lib'], root);
  assert.equal(direct.status, 0, direct.stdout + direct.stderr);
  const result = gate(root);
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.ok(result.report.lines.some(line => line.startsWith('✓ cmd msvc-probe (')), result.stdout);
  const output = run(path.join(root, 'gate.exe'), [], root);
  assert.equal(output.status, 0, output.stderr);
  assert.match(output.stdout, /MSVC_SDK_CONTROL/);
});
