import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as core from './diagnostics.mjs';
import { diagnoseESLint } from './diagnostics-eslint.mjs';
import { nativeBudget } from './diagnostics-native.mjs';
import { diagnosePython } from './diagnostics-python.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../../..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'musubix6-profiles-test-'));
const { NODE_TEST_CONTEXT, ...baseEnv } = process.env;
after(() => fs.rmSync(scratch, { recursive: true, force: true }));
function write(root, name, value) {
  const file = path.join(root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value);
}
function project() { return fs.mkdtempSync(path.join(scratch, 'project-')); }
function snapshot(root) {
  const files = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) files.push([path.relative(root, file), fs.readlinkSync(file)]);
      else if (entry.isDirectory()) walk(file);
      else files.push([path.relative(root, file), createHash('sha256').update(fs.readFileSync(file)).digest('hex')]);
    }
  }
  walk(root);
  return files.sort((a, b) => a[0].localeCompare(b[0]));
}
function cli(root, profile, extra = [], env = {}, entry = path.join(here, 'sdd.mjs'), prefix = []) {
  const result = spawnSync(process.execPath, [entry, ...prefix, 'diagnostics', '--profile', profile, '--json', ...extra], {
    cwd: root, env: { ...baseEnv, ...env }, encoding: 'utf8', timeout: 30000, maxBuffer: 20 * 1024 * 1024,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null, result.stderr);
  const value = JSON.parse(result.stdout);
  assert.equal(value.exitCode, result.status, result.stderr);
  return value;
}
function complete(value) {
  assert.equal(value.status, 'complete', JSON.stringify(value));
  assert.equal(value.reason, null);
  return value;
}
function incomplete(value, reason) {
  assert.equal(value.status, 'incomplete', JSON.stringify(value));
  assert.ok(value.reason);
  if (reason) assert.match(value.reason, reason);
  assert.deepEqual(value.files, { included: null, checked: null, ignored: null });
  return value;
}
function javascript() {
  const root = project();
  write(root, 'package.json', '{"private":true}\n');
  write(root, 'eslint.config.cjs', 'module.exports=[{ignores:["ignored.js"]},{files:["**/*.{js,jsx,mjs,cjs}"],languageOptions:{parserOptions:{ecmaFeatures:{jsx:true}}},rules:{"no-debugger":"error","no-unused-vars":"warn"}}];\n');
  write(root, 'a.js', 'export const value = 1;\n');
  fs.mkdirSync(path.join(root, 'node_modules'));
  fs.symlinkSync(path.join(repo, 'node_modules/eslint'), path.join(root, 'node_modules/eslint'), 'dir');
  return root;
}
function toolVenv() {
  const venv = process.env.MUSUBIX_DIAGNOSTICS_TEST_VENV;
  assert.ok(venv && fs.existsSync(path.join(venv, 'bin/python')), 'Set MUSUBIX_DIAGNOSTICS_TEST_VENV to the pinned developer-tool venv; do not install tools inside diagnostics');
  return fs.realpathSync(venv);
}
function python() {
  const root = project();
  fs.symlinkSync(toolVenv(), path.join(root, '.venv'), 'dir');
  write(root, 'a.py', 'value: int = 1\n');
  return root;
}
function rust() {
  const root = project(), home = project();
  write(root, 'Cargo.toml', '[package]\nname="profile-fixture"\nversion="0.0.0"\nedition="2024"\n');
  write(root, 'Cargo.lock', 'version = 4\n\n[[package]]\nname = "profile-fixture"\nversion = "0.0.0"\n');
  write(root, 'src/lib.rs', 'pub fn value() -> i32 { 1 }\n');
  write(root, '.cargo/config.toml', '[build]\ntarget-dir="project-target"\nbuild-dir="project-build"\n[cache]\nauto-clean-frequency="always"\n');
  return { root, home, env: { CARGO_HOME: home, RUSTUP_AUTO_INSTALL: '0' } };
}
function provider(root, name, env) {
  const data = cli(root, 'python', [], env);
  assert.deepEqual(data.providers.map(p => p.source), ['ruff', 'mypy'], JSON.stringify(data));
  return data.providers.find(p => p.source === name);
}
function isolatedPython({ ruff = null, version = '0.17.1', mypy = null, mypyVersion = '2.4.0' } = {}) {
  const root = project(), venv = path.join(root, '.venv');
  const created = spawnSync(path.join(toolVenv(), 'bin/python'), ['-B', '-I', '-m', 'venv', '--without-pip', venv], { encoding: 'utf8' });
  assert.equal(created.status, 0, created.stderr);
  const source = path.join(toolVenv(), 'lib/python3.14/site-packages');
  const site = path.join(venv, 'lib/python3.14/site-packages');
  fs.symlinkSync(path.join(toolVenv(), 'bin/ruff'), path.join(venv, 'bin/ruff'), 'file');
  for (const entry of fs.readdirSync(source)) {
    if (ruff !== null && (entry === 'ruff' || /^ruff-.*\.dist-info$/.test(entry))) continue;
    if (mypy !== null && (entry === 'mypy' || /^mypy-.*\.dist-info$/.test(entry))) continue;
    fs.symlinkSync(path.join(source, entry), path.join(site, entry), fs.statSync(path.join(source, entry)).isDirectory() ? 'dir' : 'file');
  }
  for (const [name, body, selectedVersion] of [['ruff', ruff, version], ['mypy', mypy, mypyVersion]]) {
    if (body === null) continue;
    write(site, `${name}/__init__.py`, '');
    write(site, `${name}/__main__.py`, body);
    write(site, `${name}-${selectedVersion}.dist-info/METADATA`, `Name: ${name}\nVersion: ${selectedVersion}\n`);
  }
  write(root, 'a.py', 'missing\n');
  return { root, site };
}
function fakeRust() {
  const fixture = rust(), tools = project(), events = path.join(project(), 'events.jsonl');
  const metadata = { packages: [{ id: 'fixture-id', manifest_path: path.join(fixture.root, 'Cargo.toml'),
    targets: [{ src_path: path.join(fixture.root, 'src/lib.rs') }] }], workspace_members: ['fixture-id'], workspace_root: fixture.root };
  const cargo = `#!${process.execPath}\nconst fs=require("fs"); const a=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(events)},JSON.stringify({a, cwd:process.cwd(),rustc:process.env.RUSTC,autoInstall:process.env.RUSTUP_AUTO_INSTALL})+"\\n");if(a[0]==="-V"){console.log("cargo "+(process.env.FIXTURE_CARGO_VERSION||"1.99.0")+" (fixture)");}else if(a[0]==="metadata"){console.log(${JSON.stringify(JSON.stringify(metadata))});}else{const t=a[a.indexOf("--target-dir")+1]; if(!t||!a.includes('--offline')||!a.includes('--locked')||!a.includes('--all-targets')||!a.includes('cache.auto-clean-frequency="never"')||!a.includes("build.build-dir="+JSON.stringify(require("path").join(t,"intermediates"))))throw Error("missing required Cargo policy");process.stdout.write(process.env.FIXTURE_CARGO_MESSAGES||"");process.stderr.write(process.env.FIXTURE_CARGO_STDERR||"");process.exitCode=Number(process.env.FIXTURE_CARGO_EXIT||0);}\n`;
  write(tools, 'cargo', cargo);
  write(tools, 'rustc', `#!${process.execPath}\nconsole.log("rustc 1.99.0 (fixture)\\nrelease: 1.99.0");\n`);
  fs.chmodSync(path.join(tools, 'cargo'), 0o755);
  fs.chmodSync(path.join(tools, 'rustc'), 0o755);
  return { ...fixture, tools, events, env: { ...fixture.env, PATH: tools + path.delimiter + baseEnv.PATH } };
}

/** @id TEST-DIAGCLI-006 @verifies REQ-DIAGCLI-001 REQ-DIAGCLI-003 */
test('TEST-DIAGCLI-006 explicit profiles, invalid input and all144 policy rows', () => {
  const root = javascript();
  assert.equal(cli(root, 'javascript').exitCode, 0);
  for (const args of [['--profile', 'javascript'], ['--profile', 'python'], ['extra']]) {
    const value = cli(root, 'javascript', args);
    assert.equal(value.exitCode, 2);
    assert.equal(value.root, null);
    assert.deepEqual(value.providers, []);
  }
  for (const name of ['', 'unknown', 'JavaScript']) {
    const value = cli(root, name);
    assert.equal(value.exitCode, 2);
    assert.deepEqual(value.providers, []);
  }
  assert.equal(cli(root, 'python', ['--root', '/definitely/not/a/project']).profile, 'python');
  const states = ['C00', 'C0W', 'CE0', 'CEW', 'I00', 'I0W', 'IE0', 'IEW'];
  const rows = ['PPFFIIII', 'PPFFIIII', 'FFFFIIII', 'FFFFIIII', 'IIIIIIII', 'IIIIIIII', 'IIIIIIII', 'IIIIIIII'];
  const sets = { typescript: ['typescript', 'eslint'], javascript: ['eslint'], python: ['ruff', 'mypy'], rust: ['cargo-check'] };
  let checked = 0;
  const value = (source, state) => ({ source, status: state[0] === 'C' ? 'complete' : 'incomplete', reason: 'fixture',
    diagnostics: [...(state[1] === 'E' ? [{ severity: 'error' }] : []), ...(state[2] === 'W' ? [{ severity: 'warning' }] : [])] });
  for (const required of Object.values(sets)) {
    for (let i = 0; i < 8; i++) for (let j = 0; j < (required.length === 2 ? 8 : 1); j++) {
      const providers = required.map((source, index) => value(source, states[index ? j : i]));
      const expected = required.length === 2 ? rows[i][j] : 'PPFFIIII'[i];
      assert.equal(core.aggregate(providers, required).status, { P: 'PASS', F: 'FAIL', I: 'INCOMPLETE' }[expected]);
      checked++;
    }
    const valid = required.map(source => value(source, 'C00'));
    for (const providers of [[], valid.slice(1), [...valid, valid[0]], [...valid, value('unexpected', 'C00')]]) assert.equal(core.aggregate(providers, required).exitCode, 2);
    assert.equal(core.aggregate(valid, []).exitCode, 2);
  }
  assert.equal(checked, 144);
});

/** @id TEST-DIAGJS-001 @verifies REQ-DIAGJS-001 */
test('TEST-DIAGJS-001 root-only ESLint without TypeScript admission', async () => {
  const root = javascript();
  complete(await diagnoseESLint(root, { profile: 'javascript' }));
  assert.equal(fs.existsSync(path.join(root, 'tsconfig.json')), false);
  assert.equal(fs.existsSync(path.join(root, 'node_modules/typescript')), false);
  write(root, 'eslint.config.mjs', 'export default [];\n');
  incomplete(await diagnoseESLint(root, { profile: 'javascript' }), /config/i);
  fs.unlinkSync(path.join(root, 'eslint.config.mjs'));
  fs.unlinkSync(path.join(root, 'node_modules/eslint'));
  incomplete(await diagnoseESLint(root, { profile: 'javascript' }), /eslint|local|ENOENT/i);
});

/** @id TEST-DIAGJS-002 @verifies REQ-DIAGJS-002 */
test('TEST-DIAGJS-002 whole-project extensions, ignores and directory symlinks', async () => {
  const root = javascript();
  for (const name of ['b.jsx', 'nested/c.mjs', 'd.cjs', 'ignored.js']) write(root, name, 'debugger;\n');
  write(root, 'not-input.ts', 'debugger;\n');
  fs.symlinkSync(root, path.join(root, 'loop'), 'dir');
  const value = complete(await diagnoseESLint(root, { profile: 'javascript' }));
  assert.deepEqual(value.files, { included: 6, checked: 5, ignored: 1 });
  assert.deepEqual(value.diagnostics.filter(d => d.severity === 'error').map(d => d.file), ['b.jsx', 'd.cjs', 'nested/c.mjs']);
  for (const name of ['a.js', 'b.jsx', 'nested/c.mjs', 'd.cjs']) fs.unlinkSync(path.join(root, name));
  write(root, 'eslint.config.cjs', 'module.exports=[{ignores:["**"]}];\n');
  incomplete(await diagnoseESLint(root, { profile: 'javascript' }), /ignored|input/i);
});

/** @id TEST-DIAGJS-003 @verifies REQ-DIAGJS-003 */
test('TEST-DIAGJS-003 severities, UTF16, parser errors and no fix/cache', async () => {
  const root = javascript();
  write(root, 'a.js', 'const unused = "😀"; debugger;\n');
  const before = snapshot(root);
  const value = complete(await diagnoseESLint(root, { profile: 'javascript' }));
  assert.ok(value.diagnostics.some(d => d.severity === 'warning'));
  assert.equal(value.diagnostics.find(d => d.code === 'no-debugger').column, 'const unused = "😀"; '.length + 1);
  assert.deepEqual(snapshot(root), before);
  write(root, 'a.js', 'const = ;\n');
  assert.ok(complete(await diagnoseESLint(root, { profile: 'javascript' })).diagnostics.some(d => d.severity === 'error'));
  write(root, 'eslint.config.cjs', 'throw new Error("controlled config failure");\n');
  incomplete(await diagnoseESLint(root, { profile: 'javascript' }), /controlled config failure/);
});

/** @id TEST-DIAGPY-001 @verifies REQ-DIAGPY-001 */
test('TEST-DIAGPY-001 exact root venv tools and independent attempts', () => {
  const root = python();
  const data = cli(root, 'python');
  assert.equal(data.exitCode, 0, JSON.stringify(data));
  assert.deepEqual(data.providers.map(p => p.source), ['ruff', 'mypy']);
  data.providers.forEach(complete);
  fs.unlinkSync(path.join(root, '.venv'));
  const absent = cli(root, 'python');
  assert.equal(absent.exitCode, 2);
  assert.deepEqual(absent.providers.map(p => p.source), ['ruff', 'mypy']);
  absent.providers.forEach(p => incomplete(p, /venv|Python|ENOENT/i));
  const marker = path.join(project(), 'unsupported-entry');
  const isolated = isolatedPython({ ruff: `from pathlib import Path\nPath(${JSON.stringify(marker)}).write_text("must not execute")\n`, version: '0.17.0' });
  write(isolated.site, 'attack.pth', `import pathlib; pathlib.Path(${JSON.stringify(marker)}).write_text("pth executed")\n`);
  write(isolated.root, 'a.py', 'value: int = 1\n');
  const mixed = cli(isolated.root, 'python');
  incomplete(mixed.providers[0], /unsupported.*ruff|version/i);
  complete(mixed.providers[1]);
  assert.equal(fs.existsSync(marker), false);
  write(isolated.root, 'mypy.ini', '[mypy]\npython_executable=/not/the/selected/venv/python\n');
  complete(provider(isolated.root, 'mypy'));
  const oldMypy = isolatedPython({ mypy: '', mypyVersion: '2.3.0' });
  write(oldMypy.root, 'a.py', 'value: int = 1\n');
  write(oldMypy.site, 'mypy/__init__.py', `from pathlib import Path\nPath(${JSON.stringify(marker)}).write_text("unsupported mypy entry")\n`);
  const other = cli(oldMypy.root, 'python');
  complete(other.providers[0]);
  incomplete(other.providers[1], /unsupported.*mypy|version/i);
  assert.equal(fs.existsSync(marker), false);
  fs.symlinkSync(toolVenv(), path.join(root, '.venv'), 'dir');
  const bridge = path.join(here, 'diagnostics-python.py');
  for (const [version, exit] of [[[3, 13, 0, 'final', 0], 2], [[3, 14, 0, 'candidate', 1], 2], [[3, 15, 0, 'final', 0], 2], [[3, 14, 0, 'final', 0], 0]]) {
    const code = `import sys,json,os,runpy,pkgutil;from collections import namedtuple;sys.version_info=namedtuple("Version","major minor micro releaselevel serial")(*${JSON.stringify(version)});sys.argv=${JSON.stringify([bridge, root, 'ruff', 'probe'])};runpy.run_path(${JSON.stringify(bridge)},run_name="__main__")`;
    const result = spawnSync(path.join(root, '.venv/bin/python'), ['-B', '-I', '-S', '-c', code], { encoding: 'utf8', cwd: root, timeout: 10000 });
    assert.ifError(result.error);
    assert.equal(result.status, exit, result.stdout + result.stderr);
    const data = JSON.parse(result.stdout);
    if (exit) assert.match(data.error, /Unsupported Python version/);
    else assert.equal(data.version, '0.17.1');
  }
});

/** @id TEST-DIAGPY-002 @verifies REQ-DIAGPY-002 */
test('TEST-DIAGPY-002 direct counts, root configs, imports and no symlink traversal', () => {
  const root = python(), outside = project();
  write(root, 'ruff.toml', 'exclude=["skip.py"]\n');
  write(root, 'mypy.ini', '[mypy]\nfiles=api.pyi\nexclude=(^|/)skip\\.py$\n');
  write(root, 'api.pyi', 'value: int\n');
  write(root, 'a.py', 'from skip import value\n');
  write(root, 'skip.py', 'value: int = "bad"\n');
  write(outside, 'outside.py', 'outside_missing\n');
  fs.symlinkSync(outside, path.join(root, 'linked'), 'dir');
  write(root, 'notebook.ipynb', '{"cells":[],"metadata":{},"nbformat":4,"nbformat_minor":5}');
  const data = cli(root, 'python');
  assert.deepEqual(data.providers.map(p => p.source), ['ruff', 'mypy']);
  for (const p of data.providers) assert.deepEqual(complete(p).files, { included: 3, checked: 2, ignored: 1 });
  assert.ok(data.providers[1].diagnostics.some(d => d.file === 'skip.py' && d.code === 'assignment'));
  write(root, 'line\nbreak.py', 'missing\n');
  cli(root, 'python').providers.forEach(p => incomplete(p, /path|newline|CR|LF/i));
  const configs = python();
  write(configs, 'a.py', 'missing\n');
  write(configs, '.ruff.toml', '[lint]\nselect=["F821"]\n');
  write(configs, 'ruff.toml', '[lint]\nignore=["F821"]\n');
  write(configs, 'mypy.ini', '[mypy]\nmodules=does_not_exist\n');
  write(configs, '.mypy.ini', '[mypy]\npackages=does_not_exist\n');
  write(configs, 'pyproject.toml', '[tool.ruff.lint]\nignore=["F821"]\n[tool.mypy]\nfiles=["does_not_exist"]\n');
  write(configs, 'setup.cfg', '[mypy]\npackages=does_not_exist\n');
  for (const [ruffConfig, mypyConfig] of [['.ruff.toml', 'mypy.ini'], ['ruff.toml', '.mypy.ini'], ['pyproject.toml', 'pyproject.toml'], [null, 'setup.cfg'], [null, null]]) {
    const data = cli(configs, 'python');
    for (const [index, config] of [[0, ruffConfig], [1, mypyConfig]]) {
      assert.equal(complete(data.providers[index]).configPath, config ? path.join(configs, config) : null);
    }
    if (ruffConfig) fs.unlinkSync(path.join(configs, ruffConfig));
    if (mypyConfig && mypyConfig !== ruffConfig) fs.unlinkSync(path.join(configs, mypyConfig));
  }
  const nested = path.join(configs, 'nested');
  fs.mkdirSync(nested);
  fs.symlinkSync(toolVenv(), path.join(nested, '.venv'), 'dir');
  write(configs, 'pyproject.toml', '[tool.ruff.lint]\nignore=["F821"]\n[tool.mypy]\ndisable_error_code=["name-defined"]\n');
  write(nested, 'a.py', 'missing\n');
  const independent = cli(nested, 'python');
  assert.ok(complete(independent.providers[0]).diagnostics.some(d => d.code === 'F821'));
  assert.ok(complete(independent.providers[1]).diagnostics.some(d => d.code === 'name-defined'));
  write(nested, 'pyproject.toml', '[tool.\n');
  cli(nested, 'python').providers.forEach(p => incomplete(p));
  write(nested, 'pyproject.toml', '[project]\nname="unrelated-section"\n');
  write(nested, 'setup.cfg', '[other]\nvalue=1\n');
  cli(nested, 'python').providers.forEach(p => assert.equal(complete(p).configPath, null));
  fs.unlinkSync(path.join(nested, 'a.py'));
  cli(nested, 'python').providers.forEach(p => incomplete(p));
  write(nested, 'a.py', 'value: int = 1\n');
  write(nested, '.ruff.toml', 'exclude=["*.py"]\n');
  write(nested, 'mypy.ini', '[mypy]\nexclude=.*\n');
  cli(nested, 'python').providers.forEach(p => incomplete(p));
});

/** @id TEST-DIAGPY-003 @verifies REQ-DIAGPY-003 */
test('TEST-DIAGPY-003 Ruff JSON, Unicode codepoints and syntax errors', async () => {
  const root = python();
  write(root, 'a.py', 'emoji = "😀"; missing\n');
  const p = complete(provider(root, 'ruff'));
  const error = p.diagnostics.find(d => d.code === 'F821');
  assert.ok(error, JSON.stringify(p));
  assert.equal(error.severity, 'error');
  assert.equal(error.line, 1);
  assert.equal(error.column, 'emoji = "😀"; '.length + 1);
  write(root, 'a.py', 'value = ;\n');
  assert.ok(complete(provider(root, 'ruff')).diagnostics.some(d => d.code === 'invalid-syntax'));
  await checkPythonProtocol();
});

/** @id TEST-DIAGPY-004 @verifies REQ-DIAGPY-004 */
test('TEST-DIAGPY-004 mypy JSONL zero/unknown positions, notes and incomplete syntax', async () => {
  const root = python();
  write(root, 'a.py', 'missing\n');
  const zero = complete(provider(root, 'mypy')).diagnostics.find(d => d.code === 'name-defined');
  assert.equal(zero.column, 1);
  write(root, 'a.py', 'emoji = "😀"; missing; other_missing\n');
  const unicode = complete(provider(root, 'mypy'));
  assert.equal(unicode.diagnostics.filter(d => d.code === 'name-defined').length, 2);
  assert.equal(unicode.diagnostics.find(d => d.code === 'name-defined').column, null);
  assert.equal(unicode.diagnostics.filter(d => d.code === 'location-unavailable' && d.severity === 'info').length, 1);
  write(root, 'a.py', 'value = ;\n');
  const syntax = incomplete(provider(root, 'mypy'));
  assert.ok(syntax.diagnostics.some(d => d.code === 'syntax'));
  write(root, 'a.py', 'reveal_type(1)\n');
  assert.ok(complete(provider(root, 'mypy')).diagnostics.some(d => d.severity === 'info'));
  write(root, 'a.py', 'value: int = 1\n');
  write(root, 'duplicate/a.py', 'value: int = 1\n');
  const duplicate = incomplete(provider(root, 'mypy'));
  const blocker = duplicate.diagnostics.find(d => d.severity === 'error' && /Duplicate module/.test(d.message));
  assert.ok(blocker, JSON.stringify(duplicate));
  assert.equal(blocker.line, null);
  assert.equal(blocker.column, null);
  assert.equal(blocker.code, 'mypy');
  assert.match(blocker.message, /Common resolutions/);
  fs.unlinkSync(path.join(root, 'duplicate/a.py'));
  write(root, 'a.py', 'value: int = 1\n');
  const records = [
    { file: null, line: -1, column: -1, code: null, severity: 'note', message: 'fileless' },
    { file: 'a.py', line: -1, column: -1, code: 'position', severity: 'error', message: 'unknown-line' },
    { file: 'a.py', line: 1, column: -1, code: 'position', severity: 'error', message: 'unknown-column' },
    { file: 'a.py', line: 1, column: 0, code: 'position', severity: 'error', message: 'zero-column' },
  ];
  async function scripted(stdout, code = 1) {
    const actual = nativeBudget();
    return diagnosePython(root, 'mypy', { run(command, args, options) {
      return args.at(-1) === 'tool' ? Promise.resolve({ code, signal: null, failure: null, stdout, stderr: Buffer.alloc(0) }) : actual.run(command, args, options);
    } });
  }
  const mapped = complete(await scripted(Buffer.from(records.map(record => JSON.stringify(record)).join('\n') + '\n')));
  for (const message of ['fileless', 'unknown-line']) {
    const record = mapped.diagnostics.find(d => d.message === message);
    assert.equal(record.line, null);
    assert.equal(record.column, null);
  }
  assert.equal(mapped.diagnostics.find(d => d.message === 'unknown-column').column, null);
  assert.equal(mapped.diagnostics.find(d => d.message === 'zero-column').column, 1);
  const partial = incomplete(await scripted(Buffer.concat([Buffer.from(JSON.stringify(records[3]) + '\n{"broken":"'), Buffer.from([0xc3])])));
  assert.ok(partial.diagnostics.some(d => d.message === 'zero-column'), 'Retain complete records before malformed UTF-8');
  assert.equal(partial.diagnostics.find(d => d.message === 'zero-column').column, 1);
  complete(await scripted(Buffer.alloc(0), 0));
  incomplete(await scripted(Buffer.alloc(0)), /empty|diagnostic|exit 1/i);
});

/** @id TEST-DIAGPY-005 @verifies REQ-DIAGPY-005 */
test('TEST-DIAGPY-005 no source, venv, bytecode or cache mutation', () => {
  const root = python();
  write(root, '.sdd/tdd.jsonl', 'historical evidence\n');
  const before = snapshot(root), venvBefore = snapshot(toolVenv());
  const value = cli(root, 'python');
  assert.equal(value.exitCode, 0, JSON.stringify(value));
  assert.deepEqual(snapshot(root), before);
  assert.deepEqual(snapshot(toolVenv()), venvBefore);
});

/** @id TEST-DIAGRUST-001 @verifies REQ-DIAGRUST-001 */
test('TEST-DIAGRUST-001 installed root toolchain, lock and workspace boundaries', () => {
  const { root, env } = rust();
  assert.equal(cli(root, 'rust', [], env).exitCode, 0);
  fs.unlinkSync(path.join(root, 'Cargo.lock'));
  incomplete(cli(root, 'rust', [], env).providers[0], /lock/i);
  write(root, 'Cargo.lock', 'version = 4\n\n[[package]]\nname = "profile-fixture"\nversion = "0.0.0"\n');
  incomplete(cli(root, 'rust', [], { ...env, CARGO_HOME: path.join(root, '.cargo') }).providers[0], /Cargo home|external|outside/i);
  write(root, 'rust-toolchain.toml', '[toolchain]\nchannel="1.99.99"\n');
  incomplete(cli(root, 'rust', [], env).providers[0], /installed|toolchain|version/i);
  const fake = fakeRust();
  incomplete(cli(fake.root, 'rust', [], { ...fake.env, FIXTURE_CARGO_VERSION: '1.98.0' }).providers[0], /version/i);
  assert.equal(fs.readFileSync(fake.events, 'utf8').trim().split('\n').length, 1, 'Unsupported cargo must not execute metadata/check');
  fs.unlinkSync(path.join(root, 'rust-toolchain.toml'));
  write(root, 'Cargo.toml', fs.readFileSync(path.join(root, 'Cargo.toml'), 'utf8') + '[workspace]\nmembers=["member"]\n');
  write(root, 'member/Cargo.toml', '[package]\nname="workspace-member"\nversion="0.0.0"\nedition="2024"\n');
  write(root, 'member/src/lib.rs', 'pub fn value() {}\n');
  write(root, 'Cargo.lock', fs.readFileSync(path.join(root, 'Cargo.lock'), 'utf8') + '\n[[package]]\nname="workspace-member"\nversion="0.0.0"\n');
  incomplete(cli(root, 'rust', [], env).providers[0], /workspace|single-package/i);
});

/** @id TEST-DIAGRUST-002 @verifies REQ-DIAGRUST-002 */
test('TEST-DIAGRUST-002 all targets, offline locked and private output overrides', () => {
  const { root, env } = rust();
  write(root, 'examples/demo.rs', 'fn main() { let _: i32 = "bad"; }\n');
  const before = snapshot(root);
  const value = cli(root, 'rust', [], env);
  assert.equal(value.exitCode, 1, JSON.stringify(value));
  assert.ok(complete(value.providers[0]).diagnostics.some(d => d.file === 'examples/demo.rs' && d.code === 'E0308'));
  assert.deepEqual(snapshot(root), before);
  write(root, 'Cargo.toml', '[package]\nname="profile-fixture"\nversion="0.0.0"\nedition="2024"\n[dependencies]\nmissing-profile-fixture-package="0.0.0"\n');
  incomplete(cli(root, 'rust', [], env).providers[0], /offline|dependency|matching package/i);
});

/** @id TEST-DIAGRUST-003 @verifies REQ-DIAGRUST-003 */
test('TEST-DIAGRUST-003 compiler versus runtime abort, nullable codes and UTF16', () => {
  const { root, env } = rust();
  const source = 'pub fn value() -> i32 { let _emoji = "😀"; "bad" }\n';
  write(root, 'src/lib.rs', source);
  const typed = cli(root, 'rust', [], env);
  assert.equal(typed.exitCode, 1);
  const diagnostic = complete(typed.providers[0]).diagnostics.find(d => d.code === 'E0308');
  assert.equal(diagnostic.column, source.indexOf('"bad"') + 1);
  write(root, 'src/lib.rs', 'pub fn broken( {\n');
  assert.ok(complete(cli(root, 'rust', [], env).providers[0]).diagnostics.some(d => d.code === 'rustc'));
  write(root, 'src/lib.rs', 'pub fn value() -> i32 { 1 }\n');
  write(root, 'build.rs', 'fn main() { panic!("controlled runtime abort"); }\n');
  incomplete(cli(root, 'rust', [], env).providers[0], /build|abort|compiler/i);
  write(root, 'build.rs', 'fn main() { let _: i32 = "bad"; }\n');
  assert.equal(cli(root, 'rust', [], env).exitCode, 1);
  const fake = fakeRust();
  const file = path.join(fake.root, 'src/lib.rs');
  const span = { file_name: file, byte_start: 0, is_primary: false };
  const primary = { ...span, byte_start: 7, is_primary: true };
  const record = message => ({ reason: 'compiler-message', package_id: 'fixture-id', target: { src_path: file }, message });
  const error = { level: 'error', message: 'controlled compiler error', code: null, spans: [span, primary],
    children: [{ level: 'note', message: 'controlled child note', code: null, spans: [], children: [] }, { level: 'help', message: 'controlled child help', code: null, spans: [], children: [] }] };
  const artifact = { reason: 'compiler-artifact', package_id: 'fixture-id', target: { src_path: file } };
  function check(records, exit, stderr = '') {
    return cli(fake.root, 'rust', [], { ...fake.env, FIXTURE_CARGO_MESSAGES: records.map(value => typeof value === 'string' ? value : JSON.stringify(value)).join('\n') + '\n', FIXTURE_CARGO_EXIT: String(exit), FIXTURE_CARGO_STDERR: stderr });
  }
  const preserved = check([record(error), { reason: 'build-finished', success: false }], 101, 'error: could not compile `profile-fixture` (lib) due to 1 previous error\n');
  const diagnostics = complete(preserved.providers[0]).diagnostics;
  assert.equal(diagnostics.find(d => d.severity === 'error').column, 8);
  assert.ok(diagnostics.some(d => d.severity === 'info' && d.message === 'controlled child note'));
  assert.ok(diagnostics.some(d => d.severity === 'hint' && d.message === 'controlled child help'));
  assert.equal(complete(check([record({ ...error, spans: [] }), { reason: 'build-finished', success: false }], 101).providers[0]).diagnostics.find(d => d.severity === 'error').file, null);
  const warning = record({ ...error, level: 'warning', children: [] });
  assert.equal(check([artifact, warning, { reason: 'build-finished', success: true }], 0).exitCode, 0);
  assert.equal(check([artifact, { reason: 'build-finished', success: true }], 0).exitCode, 0);
  for (const [records, exit, stderr] of [
    [[artifact], 0],
    [[artifact, { reason: 'build-finished', success: false }], 101],
    [[record(error), { reason: 'build-finished', success: true }], 101],
    [[{ ...record(error), package_id: 'foreign-id' }, { reason: 'build-finished', success: false }], 101],
    [[record(error), { ...record(error), package_id: 'foreign-id' }, { reason: 'build-finished', success: false }], 101],
    [[artifact, { reason: 'build-finished', success: true }, warning], 0],
    [[artifact, '{"reason":'], 0],
    [[artifact, { reason: 'build-finished', success: true }, '{"reason":'], 0],
    [[record(error), { reason: 'build-finished', success: false }], 101, 'error: failed to run custom build command for `dependency`\n'],
  ]) incomplete(check(records, exit, stderr).providers[0]);
  const prefix = incomplete(check([record(error), record({ ...error, message: 'second complete error', children: [] }), '{"reason":'], 101).providers[0]);
  assert.equal(prefix.diagnostics.filter(d => d.severity === 'error').length, 2);
  const trace = fs.readFileSync(fake.events, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.ok(trace.every(e => e.cwd === fake.root && e.autoInstall === '0' && e.rustc === path.join(fake.tools, 'rustc')));
});

async function checkPythonProtocol() {
  const output = { filename: '', location: { row: 1, column: 1 }, code: 'F821', message: 'controlled error', severity: 'error' };
  const fake = isolatedPython({ ruff: 'import sys,json,os,time\nif "--show-files" in sys.argv:\n print(os.path.join(os.getcwd(),"a.py"))\nelse:\n item=' + JSON.stringify(output) + '\n item["filename"]=os.path.join(os.getcwd(),"a.py")\n print(json.dumps([item]),flush=True)\n time.sleep(0.1)\n sys.stderr.write("x"*4096)\n' });
  const p = await diagnosePython(fake.root, 'ruff', nativeBudget({ timeoutMs: 5000, outputBytes: 2048 }));
  incomplete(p, /output.*2048.*bytes/i);
  assert.ok(p.diagnostics.some(d => d.code === 'F821' && d.severity === 'error'));
  assert.equal(p.diagnostics.find(d => d.code === 'F821').column, null);
  const body = expression => 'import sys,json,os\nif "--show-files" in sys.argv:\n print(os.path.join(os.getcwd(),"a.py"))\nelse:\n item=' + JSON.stringify(output) + '\n item["filename"]=os.path.join(os.getcwd(),"a.py")\n ' + expression + '\n';
  const file = path.join(fake.site, 'ruff/__main__.py');
  write(fake.site, 'ruff/__main__.py', body('print(json.dumps([{**item,"severity":"warning"},{**item,"severity":"info"},{**item,"severity":"hint"}]))'));
  const neutral = complete(await diagnosePython(fake.root, 'ruff', nativeBudget()));
  assert.deepEqual(neutral.diagnostics.map(d => d.severity).sort(), ['hint', 'info', 'warning']);
  assert.equal(core.aggregate([neutral], ['ruff']).exitCode, 0);
  fs.writeFileSync(file, body('print(json.dumps([item,{**item,"severity":"fatal"}]))'));
  const invalid = incomplete(await diagnosePython(fake.root, 'ruff', nativeBudget()), /schema/i);
  assert.equal(invalid.diagnostics.filter(d => d.code === 'F821').length, 1);
  fs.writeFileSync(file, body('print("not-json")'));
  incomplete(await diagnosePython(fake.root, 'ruff', nativeBudget()), /JSON/i);
  fs.writeFileSync(file, body('print("[]")'));
  complete(await diagnosePython(fake.root, 'ruff', nativeBudget()));
  fs.writeFileSync(file, body('print("[]");sys.exit(1)'));
  incomplete(await diagnosePython(fake.root, 'ruff', nativeBudget()), /empty|diagnostic|exit 1/i);
}

/** @id TEST-DIAGRUST-004 @verifies REQ-DIAGRUST-004 */
test('TEST-DIAGRUST-004 distinct metadata source roots rather than artifacts/modules', () => {
  const { root, env } = rust();
  write(root, 'src/main.rs', 'fn main() {}\n');
  write(root, 'tests/integration.rs', '#[test] fn accepted() {}\n');
  write(root, 'examples/demo.rs', 'fn main() {}\n');
  write(root, 'src/extra.rs', 'pub const UNUSED_MODULE: i32 = 1;\n');
  const value = cli(root, 'rust', [], env);
  assert.equal(value.exitCode, 0, JSON.stringify(value));
  assert.deepEqual(complete(value.providers[0]).files, { included: 4, checked: 4, ignored: 0 });
});

/** @id TEST-DIAGCLI-007 @verifies REQ-DIAGCLI-004 */
test('TEST-DIAGCLI-007 cumulative native stdout/stderr bytes and elapsed time', async () => {
  const run = (budget, code) => budget.run(process.execPath, ['-e', code], { cwd: scratch });
  const control = await run(nativeBudget({ timeoutMs: 2000, outputBytes: 16 }), 'process.stdout.write("ok")');
  assert.equal(control.stdout.toString(), 'ok');
  assert.equal(control.failure, null);
  const exact = nativeBudget({ timeoutMs: 2000, outputBytes: 16 });
  assert.equal((await run(exact, 'process.stdout.write("a".repeat(8));process.stderr.write("b".repeat(8))')).failure, null);
  assert.match((await run(exact, 'process.stdout.write("c")')).failure, /output.*16.*bytes/i);
  const byteMarker = path.join(project(), 'must-not-run');
  assert.match((await run(exact, `require("fs").writeFileSync(${JSON.stringify(byteMarker)},"unexpected")`)).failure, /output.*16.*bytes/i);
  assert.equal(fs.existsSync(byteMarker), false);
  const bytes = nativeBudget({ timeoutMs: 2000, outputBytes: 8388608 });
  assert.equal((await run(bytes, 'process.stderr.write("b".repeat(8388608))')).failure, null);
  assert.match((await run(bytes, 'process.stdout.write("c")')).failure, /output.*8388608.*bytes/i);
  let now = 0;
  const elapsed = nativeBudget({ timeoutMs: 2000, outputBytes: 1024, clock: () => now });
  assert.equal((await run(elapsed, 'process.stdout.write("ok")')).failure, null);
  now = 2001;
  const marker = path.join(project(), 'expired-budget');
  assert.match((await run(elapsed, `require("fs").writeFileSync(${JSON.stringify(marker)},"unexpected")`)).failure, /timed out/i);
  assert.equal(fs.existsSync(marker), false);
  assert.match((await elapsed.run(path.join(scratch, 'missing-tool'), [], { cwd: scratch })).failure, /timed out/i);
  const closedMarker = path.join(project(), 'completed');
  const late = await run(nativeBudget({ timeoutMs: 2000, outputBytes: 1024, clock: () => fs.existsSync(closedMarker) ? 2001 : 0 }),
    `require("fs").writeFileSync(${JSON.stringify(closedMarker)},"completed");process.stdout.write("late")`);
  assert.notEqual(late.failure, null, 'A delayed close/timer must not accept an over-budget child');
  assert.match(late.failure, /timed out/i);
  assert.match((await run(nativeBudget({ timeoutMs: 300, outputBytes: 1024 }), 'setTimeout(()=>process.stdout.write("late"),1500)')).failure, /timed out/i);
});

async function checkScratchCleanup() {
  const { root, env } = rust();
  const marker = path.join(project(), 'out-dir');
  write(root, 'build.rs', `fn main() { std::fs::write(${JSON.stringify(marker)}, std::env::var("OUT_DIR").unwrap()).unwrap(); }\n`);
  const options = { profile: 'rust', env: { ...baseEnv, ...env } };
  complete(await core.runProvider('cargo-check', root, options));
  function ownedScratch() {
    const out = fs.readFileSync(marker, 'utf8');
    let dir = out;
    while (dir !== path.dirname(dir) && !path.basename(dir).startsWith('musubix6-diagnostics-rust-')) dir = path.dirname(dir);
    assert.ok(path.basename(dir).startsWith('musubix6-diagnostics-rust-'), out);
    return dir;
  }
  assert.equal(fs.existsSync(ownedScratch()), false);
  write(root, 'build.rs', `fn main() { std::fs::write(${JSON.stringify(marker)}, std::env::var("OUT_DIR").unwrap()).unwrap(); std::thread::sleep(std::time::Duration::from_secs(120)); }\n`);
  incomplete(await core.runProvider('cargo-check', root, { ...options, timeoutMs: 5000 }), /timed out/);
  assert.equal(fs.existsSync(ownedScratch()), false);
  write(root, 'build.rs', `fn main() { std::fs::write(${JSON.stringify(marker)}, std::env::var("OUT_DIR").unwrap()).unwrap(); }\n`);
  write(root, 'src/lib.rs', 'pub fn value() -> i32 { "bad" }\n');
  const failed = await core.runProvider('cargo-check', root, { ...options, removeScratch: async () => { throw new Error('controlled cleanup denied'); } });
  incomplete(failed, /controlled cleanup denied/);
  assert.ok(failed.diagnostics.some(d => d.code === 'E0308'));
  const retained = ownedScratch();
  assert.equal(fs.existsSync(retained), true);
  fs.rmSync(retained, { recursive: true, force: true });
}
/** @id TEST-DIAGCLI-008 @verifies REQ-DIAGCLI-004 REQ-DIAGCLI-005 */
test('TEST-DIAGCLI-008 parent-owned scratch cleanup on success, timeout and failure', checkScratchCleanup);
/** @id TEST-DIAGRUST-005 @verifies REQ-DIAGRUST-005 */
test('TEST-DIAGRUST-005 cleanup failure preserves compiler errors and forbids success', checkScratchCleanup);

/** @id TEST-DIAGFLOW-005 @verifies REQ-DIAGFLOW-001 REQ-DIAGFLOW-002 REQ-DIAGFLOW-004 */
test('TEST-DIAGFLOW-005 profile docs and source/wrapper/packed/copied 0/1/2 parity', () => {
  const skill = fs.readFileSync(path.join(here, '../SKILL.md'), 'utf8');
  for (const profile of ['javascript', 'python', 'rust']) assert.ok(skill.includes(`--profile ${profile}`), `Missing explicit ${profile} skill command`);
  for (const name of ['README.md', 'README-ja.md']) {
    const text = fs.readFileSync(path.join(repo, name), 'utf8');
    for (const fragment of ['--profile javascript', '--profile python', '--profile rust', '0.17.1', '2.4.0', '3.14', '1.99', '180', 'Cargo', 'mypy']) assert.ok(text.includes(fragment), `${name}: missing ${fragment}`);
  }
  const packed = project();
  const result = spawnSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', packed], { cwd: repo, env: baseEnv, encoding: 'utf8', timeout: 60000 });
  assert.equal(result.status, 0, result.stderr);
  const packResult = JSON.parse(result.stdout);
  const info = Array.isArray(packResult) ? packResult[0] : Object.values(packResult)[0];
  for (const name of ['diagnostics-python.py', 'diagnostics-python.mjs', 'diagnostics-rust.mjs', 'diagnostics-native.mjs']) assert.ok(info.files.some(f => f.path.endsWith('/' + name)), `Missing packed ${name}`);
  const untar = spawnSync('tar', ['-xzf', path.join(packed, info.filename), '-C', packed], { encoding: 'utf8' });
  assert.equal(untar.status, 0, untar.stderr);
  const wrapper = path.join(packed, 'package/bin/musubix6.mjs'), copied = project();
  const init = spawnSync(process.execPath, [wrapper, 'init', copied, '--only', 'lean-sdd-tdd'], { env: baseEnv, encoding: 'utf8' });
  assert.equal(init.status, 0, init.stdout + init.stderr);
  const entries = [[path.join(here, 'sdd.mjs'), []], [path.join(repo, 'bin/musubix6.mjs'), ['sdd']], [wrapper, ['sdd']], [path.join(copied, '.github/skills/lean-sdd-tdd/scripts/sdd.mjs'), []]];
  const rustFixture = rust();
  const cases = [
    { profile: 'javascript', root: javascript(), change: ['a.js', 'debugger;\n'], missing: 'eslint.config.cjs', env: {} },
    { profile: 'python', root: python(), change: ['a.py', 'value: int = "bad"\n'], missing: '.venv', env: {} },
    { profile: 'rust', ...rustFixture, change: ['src/lib.rs', 'pub fn value() -> i32 { "bad" }\n'], missing: 'Cargo.lock' },
  ];
  const semantic = value => ({ profile: value.profile, status: value.status, exitCode: value.exitCode,
    providers: value.providers.map(({ source, status, files, diagnostics }) => ({ source, status, files,
      diagnostics: diagnostics.filter(d => d.code !== 'native-stderr') })) });
  for (const item of cases) {
    for (const exit of [0, 1, 2]) {
      if (exit === 1) write(item.root, ...item.change);
      if (exit === 2) fs.unlinkSync(path.join(item.root, item.missing));
      const before = snapshot(item.root);
      let reference;
      for (const [entry, prefix] of entries) {
        const actual = cli(item.root, item.profile, [], item.env, entry, prefix);
        assert.equal(actual.exitCode, exit, JSON.stringify(actual));
        const observed = semantic(actual);
        if (reference) assert.deepEqual(observed, reference);
        else reference = observed;
      }
      assert.deepEqual(snapshot(item.root), before);
    }
  }
});
