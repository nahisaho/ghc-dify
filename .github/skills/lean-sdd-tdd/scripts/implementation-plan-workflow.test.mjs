import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const source = process.env.MUSUBIX6_HOST_ROOT
  ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const roles = ['lean-sdd-tdd', 'lean-agentic-coding', 'sdd-spec-interview', 'sdd-reverse-spec'];
const heading = '## Specification-linked implementation planning (v0.2.7)';
const marker = '<!-- implementation-planning:v0.2.7 -->';
const env = { ...process.env, PATH: path.dirname(process.execPath) + path.delimiter + process.env.PATH };
delete env.NODE_TEST_CONTEXT;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'musubix-plan-workflow-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function run(root, command, argv, expected = 0, environment = env) {
  const result = spawnSync(command, argv, { cwd: root, env: environment, encoding: 'utf8',
    timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
  assert.ifError(result.error);
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.status, expected, result.stdout + result.stderr);
  return result.stdout;
}
const cli = (root, entry, args, expected = 0, environment = env) =>
  run(root, process.execPath, [...entry, ...args, '--root', root], expected, environment);
const json = (root, entry, args, expected = 0, environment = env) =>
  JSON.parse(cli(root, entry, [...args, '--json'], expected, environment));
function isolatedEnvironment(work) {
  const home = path.join(work, 'home');
  fs.mkdirSync(home);
  const configuration = path.join(home, '.npmrc');
  const globalConfiguration = path.join(home, '.npm-globalrc');
  fs.writeFileSync(configuration, '');
  fs.writeFileSync(globalConfiguration, '');
  const environment = { ...env, HOME: home, USERPROFILE: home,
    NPM_CONFIG_USERCONFIG: configuration, NPM_CONFIG_GLOBALCONFIG: globalConfiguration,
    NPM_CONFIG_CACHE: path.join(work, 'npm-cache') };
  delete environment.NODE_PATH;
  delete environment.NODE_OPTIONS;
  delete environment.SDD_SCRIPT_UNDER_TEST;
  return environment;
}
function inventory(directory, prefix = '') {
  return fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    .flatMap(entry => {
      assert.equal(entry.isSymbolicLink(), false, `${prefix}${entry.name}: payload must be self-contained`);
      const file = path.join(directory, entry.name), relative = prefix + entry.name;
      return entry.isDirectory() ? inventory(file, relative + '/')
        : [[relative, fs.statSync(file).mode & 0o777, sha(fs.readFileSync(file))]];
    });
}
function roleFiles(root, environment) {
  const prefixes = roles.map(role => `.github/skills/${role}/`);
  if (fs.lstatSync(path.join(root, '.git'), { throwIfNoEntry: false })) {
    return run(root, 'git', ['ls-files', '-z', '--', ...prefixes], 0, environment)
      .split('\0').filter(Boolean).sort();
  }
  return prefixes.flatMap(prefix => inventory(path.join(root, prefix))
    .map(([relative]) => prefix + relative)).sort();
}
const invalidGitFailure = error => error instanceof assert.AssertionError
  && error.actual === 128 && error.expected === 0;
function section(body, start) {
  const index = body.indexOf(start);
  assert.ok(index >= 0, `Required operational planning instructions are missing: ${start}`);
  const after = body.indexOf('\n## ', index + start.length);
  return body.slice(index, after < 0 ? undefined : after);
}
function planningReadme(root, name) {
  return section(fs.readFileSync(path.join(root, name), 'utf8'), marker);
}
function roleContract(body, name) {
  const instructions = section(body, heading);
  for (const token of ['planning.required:true', '.sdd/implementation-plan.json', 'plan check',
    'plan verify TASK', 'specification changes', 'after each']) {
    assert.ok(instructions.includes(token), `${name}: missing operational obligation ${token}`);
  }
  if (name === 'lean-sdd-tdd') {
    const steps = [...instructions.matchAll(/^\d+\. (.+)$/gm)].map(match => match[1]);
    assert.equal(steps.length, 7, 'The canonical workflow has seven ordered operational steps.');
    for (const [index, terms] of [
      [0, ['specifications', 'PASS', 'counterexamples']],
      [1, ['JSON', 'scope']],
      [2, ['plan check']],
      [3, ['dependency', 'Red', 'Green']],
      [4, ['plan verify TASK']],
      [5, ['receipt', 'status']],
      [6, ['specification changes', 'fingerprints', 'verification']],
    ]) for (const term of terms) assert.ok(steps[index].includes(term), `step${index + 1}: ${term}`);
    assert.match(steps[5], /adopt the returned current successful `receipt`/,
      'Progress must adopt the successful current receipt, not merely mention failed receipts.');
    assert.match(steps[5], /set authored `status`/);
  } else assert.ok(instructions.includes('lean-sdd-tdd'), `${name}: delegate the shared contract`);
  if (name === 'sdd-spec-interview') assert.match(instructions, /after.*requirements.*before implementation/i);
  if (name === 'sdd-reverse-spec') assert.match(instructions, /characteriz.*without changing behavior/i);
  for (const line of body.split('\n').filter(line => /Large work|Scope it/.test(line) && line.includes('.sdd/plan.md'))) {
    assert.match(line, /disabled/, `${name}: Markdown large-work instructions must be conditional`);
  }
}

/** @id TEST-PLAN-FLOW-001 @verifies REQ-PLAN-FLOW-001 */
test('TEST-PLAN-FLOW-001 four workflow roles retain spec-plan-verification obligations on both hosts', t => {
  for (const name of roles) roleContract(fs.readFileSync(path.join(source, '.github/skills', name, 'SKILL.md'), 'utf8'), name);
  const work = temporary(t);
  const environment = isolatedEnvironment(work);
  run(work, process.execPath, [path.join(source, 'bin/musubix6.mjs'), 'init', work,
    '--host', 'both', '--only', roles.join(',')], 0, environment);
  for (const host of ['.github', '.claude']) for (const name of roles) {
    const body = fs.readFileSync(path.join(work, host, 'skills', name, 'SKILL.md'), 'utf8');
    assert.equal(body, fs.readFileSync(path.join(source, '.github/skills', name, 'SKILL.md'), 'utf8'));
    roleContract(body, name);
  }
});

function implementationProject(root, entry, nativeScript, environment) {
  const invoke = (args, expected = 0) => cli(root, entry, args, expected, environment);
  const decision = (args, expected = 0) => json(root, entry, args, expected, environment);
  fs.mkdirSync(path.join(root, '.sdd/specs'), { recursive: true });
  const spec = '.sdd/specs/example.md';
  fs.writeFileSync(path.join(root, spec),
    '---\nfeature: example\ntier: T1\n---\nREQ-EXAMPLE-001: When called, value shall return one.\n');
  const implementation = value =>
    `/** @id CODE-EXAMPLE-001 @implements REQ-EXAMPLE-001 */\nexport const value = () => ${value};\n`;
  fs.writeFileSync(path.join(root, 'example.mjs'), implementation(0));
  fs.writeFileSync(path.join(root, 'example.test.mjs'), `import {test} from 'node:test';
import assert from 'node:assert/strict';import {value} from './example.mjs';
/** @id TEST-EXAMPLE-001 @verifies REQ-EXAMPLE-001 */
test('TEST-EXAMPLE-001',()=>assert.equal(value(),1));\n`);
  const write = (file, value) => fs.writeFileSync(path.join(root, file), JSON.stringify(value, null, 2) + '\n');
  const config = { testCmd: [process.execPath, '--test', '--test-name-pattern', '{id}', '{file}'],
    checks: [{ name: 'test', cmd: [process.execPath, '--test', 'example.test.mjs'], timeoutMs: 20000 }] };
  write('.sdd/config.json', config);
  assert.match(invoke(['tdd', 'red', 'TEST-EXAMPLE-001']), /RED ok/);
  fs.writeFileSync(path.join(root, 'example.mjs'), implementation(1));
  assert.match(invoke(['tdd', 'green', 'TEST-EXAMPLE-001']), /GREEN ok/);
  fs.writeFileSync(path.join(root, '.sdd/plan.md'),
    '| order | feature | depends | note |\n| 1 | example | - | |\n');
  const disabled = '\u2713 1. example [T1]\nnext: (all features done)\n';
  assert.equal(invoke(['plan']), disabled);
  fs.writeFileSync(path.join(root, '.sdd/implementation-plan.json'), '{ignored while disabled');
  assert.equal(invoke(['plan']), disabled);
  config.planning = { required: true };
  write('.sdd/config.json', config);
  const task = { id: 'EXAMPLE', feature: 'example', kind: 'implementation', reqs: ['REQ-EXAMPLE-001'],
    dependsOn: [], artifacts: ['example.mjs', 'example.test.mjs'], condition: 'The selected test returns one.',
    tests: ['TEST-EXAMPLE-001'], checks: [{ name: 'selected',
      argv: [process.execPath, '--test', '--test-name-pattern', 'TEST-EXAMPLE-001', 'example.test.mjs'], timeoutMs: 20000 }],
    specs: { [spec]: sha(fs.readFileSync(path.join(root, spec))) }, dependencies: {}, status: 'not-started', receipt: null };
  const document = { schemaVersion: 1, features: [{ id: 'example', dependsOn: [] }], tasks: [task] };
  const save = () => write('.sdd/implementation-plan.json', document);
  save();
  const initial = decision(['plan', 'check']);
  assert.equal(initial.stage, 'consistency'); assert.equal(initial.tasks[0].state, 'not-started');
  assert.equal(decision(['gate'], 2).verdict, 'INCOMPLETE');
  const verify = () => {
    const before = fs.readFileSync(path.join(root, '.sdd/implementation-plan.json'));
    const result = decision(['plan', 'verify', 'EXAMPLE']);
    assert.deepEqual(fs.readFileSync(path.join(root, '.sdd/implementation-plan.json')), before,
      'Explicit verification does not silently edit authored progress.');
    const receipt = JSON.parse(fs.readFileSync(path.join(root, result.receipt)));
    assert.equal(receipt.checks.length, 2, 'The package must execute both declared and actual guarded native checks.');
    assert.deepEqual(receipt.checks[1].argv.slice(2), ['tdd', 'refactor', 'TEST-EXAMPLE-001', '--root', root]);
    assert.equal(fs.realpathSync(receipt.checks[1].argv[1]), fs.realpathSync(nativeScript),
      'An extracted or installed entry cannot silently run the source checkout.');
    assert.ok(receipt.ledgerEvents[0].hashes.length >= 2);
    task.status = 'complete'; task.receipt = result.receipt; save();
    assert.equal(decision(['plan', 'check']).tasks[0].state, 'complete');
    return result;
  };
  const first = verify();
  assert.equal(decision(['gate']).verdict, 'PASS');
  assert.equal(decision(['gate', '--no-run'], 2).verdict, 'INCOMPLETE');
  fs.appendFileSync(path.join(root, spec), '\nA whole-spec commentary revision.\n');
  assert.equal(decision(['plan', 'check'], 1).tasks[0].state, 'replan-required');
  const context = decision(['context', 'example']);
  assert.equal(context.planning.enabled, true);
  assert.ok(context.files.some(file => file.text.includes('A whole-spec commentary revision.')));
  task.specs[spec] = sha(fs.readFileSync(path.join(root, spec))); save();
  assert.notEqual(decision(['plan', 'check'], 1).tasks[0].state, 'complete');
  invoke(['tdd', 'refactor', 'TEST-EXAMPLE-001']);
  const revised = verify();
  assert.notEqual(revised.receipt, first.receipt);
  const oldReceipt = fs.readFileSync(path.join(root, first.receipt));
  fs.writeFileSync(path.join(root, 'example.mjs'), implementation(0));
  const failure = decision(['plan', 'verify', 'EXAMPLE'], 1);
  const failedBytes = fs.readFileSync(path.join(root, failure.receipt));
  assert.equal(JSON.parse(failedBytes).exit, 1);
  fs.writeFileSync(path.join(root, 'example.mjs'), implementation(1));
  verify();
  assert.deepEqual(fs.readFileSync(path.join(root, first.receipt)), oldReceipt);
  assert.deepEqual(fs.readFileSync(path.join(root, failure.receipt)), failedBytes,
    'Recovery must retain the real failed attempt byte-for-byte.');
  assert.equal(decision(['gate']).verdict, 'PASS');
}

/** @id TEST-PLAN-FLOW-002 @verifies REQ-PLAN-FLOW-002 */
test('TEST-PLAN-FLOW-002 real tarball and both hosts execute the same complete planning lifecycle', t => {
  planningReadme(source, 'README.md');
  planningReadme(source, 'README-ja.md');
  const work = temporary(t);
  const environment = isolatedEnvironment(work);
  const packed = JSON.parse(run(source, 'npm', ['pack', '--ignore-scripts', '--offline',
    '--userconfig', environment.NPM_CONFIG_USERCONFIG, '--globalconfig', environment.NPM_CONFIG_GLOBALCONFIG,
    '--cache', environment.NPM_CONFIG_CACHE, '--pack-destination', work, '--json'], 0, environment));
  assert.equal(packed.length, 1);
  const tarball = path.join(work, packed[0].filename);
  t.diagnostic(JSON.stringify({ kind: 'planning-package-runtime', node: process.version, tarballSha256: sha(fs.readFileSync(tarball)) }));
  run(work, 'tar', ['-xpzf', tarball, '-C', work], 0, environment);
  const archive = path.join(work, 'package'), installed = path.join(work, 'installed hosts');
  run(work, process.execPath, [path.join(archive, 'bin/musubix6.mjs'), 'init', installed,
    '--host', 'both', '--only', roles.join(',')], 0, environment);
  const relative = '.github/skills/lean-sdd-tdd/scripts';
  const prefixes = roles.map(name => `.github/skills/${name}/`);
  const expectedFiles = roleFiles(source, environment);
  const shipped = packed[0].files.filter(file => prefixes.some(prefix => file.path.startsWith(prefix)));
  assert.deepEqual(shipped.map(file => file.path).sort(), expectedFiles,
    'The actual npm payload includes every source role/script file.');
  assert.deepEqual(roleFiles(archive, environment), expectedFiles,
    'The Git-free extracted role inventory matches the independent source inventory.');
  const invalidGit = path.join(archive, '.git');
  fs.writeFileSync(invalidGit, 'gitdir: missing-planning-fixture\n');
  try {
    for (const diagnostic of [
      'fatal: not a git repository: missing-planning-fixture',
      'fatal: gitfile does not point to a valid repository: package/.git',
    ]) {
      assert.throws(() => run(work, process.execPath, ['-e',
        `process.stderr.write(${JSON.stringify(diagnostic)});process.exit(128)`], 0, environment),
      invalidGitFailure, 'Both observed fatal Git diagnostics must satisfy the refusal control.');
    }
    assert.throws(() => assert.throws(() => run(work, process.execPath, ['-e',
      'process.stderr.write("not a git repository");process.exit(2)'], 0, environment), invalidGitFailure),
    assert.AssertionError, 'An unrelated exit2 must not borrow a fatal Git diagnostic.');
    assert.throws(() => roleFiles(archive, environment), invalidGitFailure,
      'Invalid present Git metadata must not silently switch to archive inventory.');
  } finally {
    fs.unlinkSync(invalidGit);
  }
  for (const file of shipped) {
    assert.deepEqual(fs.readFileSync(path.join(archive, file.path)), fs.readFileSync(path.join(source, file.path)));
    assert.equal(fs.statSync(path.join(archive, file.path)).mode & 0o777, file.mode);
  }
  const helpers = shipped.filter(file => file.path.startsWith(relative + '/')
    && /\/(?:implementation-plan(?:-cli|-evidence)?|spec-context|diagnostics(?:-[a-z]+)?)\.mjs$/.test(file.path));
  assert.ok(helpers.length >= 5);
  const resolved = JSON.parse(run(work, process.execPath, ['--experimental-import-meta-resolve', '--input-type=module', '-e',
    'console.log(JSON.stringify(JSON.parse(process.argv[2]).map(file=>import.meta.resolve(file,process.argv[1]))))',
    pathToFileURL(path.join(archive, relative, 'sdd.mjs')).href,
    JSON.stringify(helpers.map(file => './' + path.basename(file.path)))], 0, environment));
  for (const url of resolved) {
    const file = fs.realpathSync(fileURLToPath(url)), tail = path.relative(fs.realpathSync(archive), file);
    assert.ok(tail !== '..' && !tail.startsWith('..' + path.sep) && !path.isAbsolute(tail), url);
  }
  for (const name of roles) for (const host of ['.github', '.claude']) {
    assert.deepEqual(inventory(path.join(installed, host, 'skills', name)),
      inventory(path.join(archive, '.github/skills', name)));
    roleContract(fs.readFileSync(path.join(installed, host, 'skills', name, 'SKILL.md'), 'utf8'), name);
  }
  for (const name of ['README.md', 'README-ja.md']) {
    assert.equal(planningReadme(archive, name), planningReadme(source, name));
  }
  const entries = [
    { entry: [path.join(source, relative, 'sdd.mjs')], native: path.join(source, relative, 'sdd.mjs') },
    { entry: [path.join(source, 'bin/musubix6.mjs'), 'sdd'], native: path.join(source, relative, 'sdd.mjs') },
    { entry: [path.join(archive, relative, 'sdd.mjs')], native: path.join(archive, relative, 'sdd.mjs') },
    { entry: [path.join(archive, 'bin/musubix6.mjs'), 'sdd'], native: path.join(archive, relative, 'sdd.mjs') },
    ...['.github', '.claude'].map(host => {
      const native = path.join(installed, host, 'skills/lean-sdd-tdd/scripts/sdd.mjs');
      return { entry: [native], native };
    }),
  ];
  for (const [index, { entry, native }] of entries.entries()) {
    implementationProject(path.join(work, `project-${index}`), entry, native, environment);
  }
});

/** @id TEST-PLAN-FLOW-003 @verifies REQ-PLAN-FLOW-003 */
test('TEST-PLAN-FLOW-003 normative evidence stages and bilingual examples cannot claim premature readiness', () => {
  const canonical = section(fs.readFileSync(path.join(source, '.github/skills/lean-sdd-tdd/SKILL.md'), 'utf8'), heading);
  for (const token of ['plan consistency', 'task verification', 'full-project gate',
    'frozen release qualification', 'human publication approval', 'Red', 'Green', 'counterexamples',
    'mutation', 'unknown', 'skipped']) assert.ok(canonical.includes(token), `Missing distinct evidence obligation: ${token}`);
  const readmes = ['README.md', 'README-ja.md'].map(name => planningReadme(source, name));
  const commands = text => [...text.matchAll(/^musubix6 sdd (.+)$/gm)].map(match => match[1]);
  const expected = ['plan check --json', 'context FEATURE --json', 'plan verify TASK --json',
    'gate --changed --json', 'gate --json'];
  for (const text of readmes) {
    assert.deepEqual(commands(text), expected, 'Both READMEs expose the independently specified command sequence.');
    for (const field of ['schemaVersion', 'features', 'tasks', 'id', 'feature', 'kind', 'reqs', 'dependsOn',
      'artifacts', 'condition', 'tests', 'checks', 'specs', 'dependencies', 'status', 'receipt']) {
      assert.ok(text.includes('`' + field + '`'), `Missing authored planning field: ${field}`);
    }
    for (const code of ['planning.required:true', 'replan-required', 'revalidation-required',
      'not-started', 'in-progress', 'blocked', 'complete', 'INCOMPLETE', '--no-run']) {
      assert.ok(text.includes(code), `Missing policy/state/unknown distinction: ${code}`);
    }
    const noRun = text.split('\n').find(line => line.includes('`--no-run`'));
    assert.match(noRun, /2/);
  }
});
