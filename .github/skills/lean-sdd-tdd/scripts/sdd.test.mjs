import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SDD = process.env.SDD_SCRIPT_UNDER_TEST ?? path.join(path.dirname(fileURLToPath(import.meta.url)), 'sdd.mjs');
const work = fs.mkdtempSync(path.join(process.cwd(), '.sdd-test-work-'));
process.env.TMPDIR = work;
process.env.GIT_CEILING_DIRECTORIES = work;
after(() => fs.rmSync(work, { recursive: true, force: true }));

function project() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-'));
  spawnSync('git', ['init', '-q'], { cwd: d });
  fs.mkdirSync(path.join(d, '.sdd/specs'), { recursive: true });
  fs.writeFileSync(path.join(d, '.sdd/specs/calc.md'), '---\nfeature: calc\ntier: T2\n---\n## Design\nadd is a pure function.\nno state.\n\n| REQ-CALC-001 | When add is called, the system shall sum. | TEST-CALC-001 |\n');
  fs.writeFileSync(path.join(d, 'add.test.mjs'), [
    "import { test } from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { add } from './add.mjs';",
    '/** @id TEST-CALC-001 @verifies REQ-CALC-001 */',
    "test('TEST-CALC-001 adds', () => assert.equal(add(1, 2), 3));",
    '',
  ].join('\n'));
  return d;
}
const { NODE_TEST_CONTEXT, ...ENV } = process.env;
const sddRaw = (d, ...a) => { const r = spawnSync('node', [SDD, '--root', d, ...a], { encoding: 'utf8', env: ENV }); return { code: r.status, out: r.stdout + r.stderr }; };
// human `approve record` needs a matching prepare (#99); tests that are not about that run prepare first
const sdd = (d, ...a) => { if (a[0] === 'approve' && a[1] === 'record' && !/^ai\s*:/i.test(String(a[a.indexOf('--by') + 1] ?? ''))) sddRaw(d, 'approve', 'prepare', a[2]); return sddRaw(d, ...a); };
const impl = (d, body) => fs.writeFileSync(path.join(d, 'add.mjs'), `/** @id CODE-CALC-001 @implements REQ-CALC-001 */\nexport const add = ${body};\n`);

test('#157 pytest descriptive and suffixed names cannot borrow sibling failures', { skip: spawnSync('python3', ['-m', 'pytest', '--version']).status !== 0 }, () => {
  for (const name of ['test_calc_001_target', 'test_descriptive_target']) {
    const d = project();
    fs.rmSync(path.join(d, 'add.test.mjs'));
    fs.writeFileSync(path.join(d, 'pytest.ini'), '[pytest]\n');
    fs.writeFileSync(path.join(d, 'test_calc.py'), `# @id TEST-CALC-001 @verifies REQ-CALC-001\ndef ${name}():\n    assert True\n\n# @id TEST-CALC-0011 @verifies REQ-CALC-001\ndef ${name}1_sibling():\n    assert False, "sibling only"\n`);
    sdd(d, 'approve', 'record', 'calc', '--by', 'tester');
    const r = sdd(d, 'tdd', 'red', 'TEST-CALC-001');
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /test passed/);
    assert.equal(testEvidence(d).length, 0);
    fs.writeFileSync(path.join(d, 'test_calc.py'), fs.readFileSync(path.join(d, 'test_calc.py'), 'utf8').replace('assert True', 'assert False, "target only"'));
    const red = sdd(d, 'tdd', 'red', 'TEST-CALC-001');
    assert.equal(red.code, 0, red.out);
    assert.match(red.out, /target only/);
    assert.doesNotMatch(red.out, /sibling only/);
  }
});

test('#158 Python submodule stubs use selected calls and local aliases', () => {
  for (const clause of ['api', 'api as renamed']) {
    const d = project();
    const local = clause.includes(' as ') ? 'renamed' : 'api';
    fs.rmSync(path.join(d, 'add.test.mjs'));
    fs.mkdirSync(path.join(d, 'scope_demo'));
    fs.writeFileSync(path.join(d, 'scope_demo/__init__.py'), '');
    fs.writeFileSync(path.join(d, 'test_calc.py'), `from scope_demo import ${clause}\n# @id TEST-CALC-001 @verifies REQ-CALC-001\ndef test_calc_001():\n    assert ${local}.first() == 1\n# @id TEST-CALC-002 @verifies REQ-CALC-001\ndef test_calc_002():\n    assert ${local}.unrelated() == 1\n`);
    const r = sdd(d, 'tdd', 'stub', 'TEST-CALC-001');
    assert.equal(r.code, 0, r.out);
    const api = fs.readFileSync(path.join(d, 'scope_demo/api.py'), 'utf8');
    assert.match(api, /def first/);
    assert.doesNotMatch(api, /unrelated/);
    assert.equal(fs.readFileSync(path.join(d, 'scope_demo/__init__.py'), 'utf8'), '');
  }
});

test('#158 Python missing-module accepts only a directly declared absent project import', { skip: spawnSync('python3', ['-m', 'pytest', '--version']).status !== 0 }, () => {
  const d = project();
  fs.rmSync(path.join(d, 'add.test.mjs'));
  fs.writeFileSync(path.join(d, 'pytest.ini'), '[pytest]\n');
  fs.writeFileSync(path.join(d, 'test_calc.py'), 'from missing_calc_project import calculate\n# @id TEST-CALC-001 @verifies REQ-CALC-001\ndef test_calc_001():\n    assert calculate() == 1\n');
  sdd(d, 'approve', 'record', 'calc', '--by', 'tester');
  const red = sdd(d, 'tdd', 'red', 'TEST-CALC-001', '--missing-module');
  assert.equal(red.code, 0, red.out);
  assert.doesNotMatch(red.out, /\[weak\]/);
  fs.writeFileSync(path.join(d, 'missing_calc_project.py'), 'import unrelated_missing_dependency\n');
  const bad = sdd(d, 'tdd', 'red', 'TEST-CALC-001', '--missing-module');
  assert.equal(bad.code, 1, bad.out);
  assert.match(bad.out, /load\/compile error/);
});

for (const [kind, before, after] of [
  ['import binding', 'from oracle import wrong as value', 'from oracle import right as value'],
  ['decorator above comment', '@pytest.mark.parametrize(\n    "value", [0]\n)\n# @id TEST-CALC-002 @verifies REQ-CALC-001\ndef test_calc_002(value):\n    assert value == 1', '@pytest.mark.parametrize(\n    "value", [1]\n)\n# @id TEST-CALC-002 @verifies REQ-CALC-001\ndef test_calc_002(value):\n    assert value == 1'],
  ['trailing transitive oracle helper', 'def expected():\n    return oracle()\n\ndef oracle():\n    return 2', 'def expected():\n    return oracle()\n\ndef oracle():\n    return 1'],
  ['multiline docstring signature', 'def test_calc_002(\n    value=False,\n):\n    """@id TEST-CALC-002 @verifies REQ-CALC-001"""\n    assert value is True', 'def test_calc_002(\n    value=True,\n):\n    """@id TEST-CALC-002 @verifies REQ-CALC-001"""\n    assert value is True'],
]) {
  test(`#159 Python hash locks ${kind}`, () => {
    const d = project();
    fs.rmSync(path.join(d, 'add.test.mjs'));
    const base = '# @id TEST-CALC-001 @verifies REQ-CALC-001\ndef test_calc_001():\n    assert True\n\n';
    const target = '# @id TEST-CALC-002 @verifies REQ-CALC-001\ndef test_calc_002():\n    assert value() == expected()\n\n';
    const body = kind === 'import binding' ? before + '\n' + base + target : base + (kind.includes('oracle') ? target + before : before) + '\n';
    fs.writeFileSync(path.join(d, 'test_calc.py'), body);
    sdd(d, 'approve', 'record', 'calc', '--by', 'tester');
    fs.writeFileSync(path.join(d, '.sdd/config.json'), JSON.stringify({ testCmd: ['node', '-e', 'console.log("AssertionError: target");process.exit(1)'], checks: [] }));
    const red = sdd(d, 'tdd', 'red', 'TEST-CALC-002');
    assert.equal(red.code, 0, red.out);
    fs.writeFileSync(path.join(d, 'test_calc.py'), body.replace(before, after));
    fs.writeFileSync(path.join(d, '.sdd/config.json'), JSON.stringify({ testCmd: ['node', '-e', '0'], checks: [] }));
    const green = sdd(d, 'tdd', 'green', 'TEST-CALC-002');
    assert.equal(green.code, 1, green.out);
    assert.match(green.out, /changed since Red/);
  });
}

test('#159 Python sibling additions preserve evidence, but shared oracle data changes stale it', () => {
  const d = project();
  fs.rmSync(path.join(d, 'add.test.mjs'));
  const body = '# @id TEST-CALC-001 @verifies REQ-CALC-001\ndef test_calc_001():\n    assert actual() == EXPECTED\n\nEXPECTED = 2\n';
  fs.writeFileSync(path.join(d, 'test_calc.py'), body);
  sdd(d, 'approve', 'record', 'calc', '--by', 'tester');
  fs.writeFileSync(path.join(d, '.sdd/config.json'), JSON.stringify({ testCmd: ['node', '-e', 'process.exit(1)'], checks: [] }));
  assert.equal(sdd(d, 'tdd', 'red', 'TEST-CALC-001').code, 0);
  fs.appendFileSync(path.join(d, 'test_calc.py'), '\n@pytest.mark.parametrize("x", [1])\n# @id TEST-CALC-002 @verifies REQ-CALC-001\ndef test_calc_002(x):\n    assert x == 1\n');
  fs.writeFileSync(path.join(d, '.sdd/config.json'), JSON.stringify({ testCmd: ['node', '-e', '0'], checks: [] }));
  const green = sdd(d, 'tdd', 'green', 'TEST-CALC-001');
  assert.equal(green.code, 0, green.out);
  fs.writeFileSync(path.join(d, 'test_calc.py'), fs.readFileSync(path.join(d, 'test_calc.py'), 'utf8').replace('EXPECTED = 2', 'EXPECTED = 1'));
  assert.match(sdd(d, 'gate', '--no-run').out, /test changed/);
});

test('#160 Go impact follows same-package production symbols and module-root imports', () => {
  const d = project();
  writeAll(d, {
    'go.mod': 'module example.org/core\n',
    'helper.go': 'package core\nfunc hash() int { return 1 }\n',
    'api.go': 'package core\nfunc Run() int { return hash() }\n',
    'unused.go': 'package core\nfunc Unused() int { return 0 }\n',
    'client/client.go': 'package client\nimport core "example.org/core"\nfunc Value() int { return core.Run() }\n',
    'client/client_test.go': 'package client\nimport "testing"\nfunc TestValue(t *testing.T) { if Value() != 1 { t.Fatal("wrong") } }\n',
  });
  const r = sdd(d, 'impact', 'helper.go', '--json');
  assert.equal(r.code, 0, r.out);
  const reached = JSON.parse(r.out).reachedFiles;
  for (const f of ['api.go', 'client/client.go', 'client/client_test.go']) assert.ok(reached.includes(f), `${f}: ${r.out}`);
  assert.ok(!reached.includes('unused.go'), r.out);
});

test('#160 Go impact follows promoted methods and unnamed local alias receivers (issue comment)', () => {
  const d = project();
  writeAll(d, {
    'go.mod': 'module example.org/model\n',
    'model/base.go': 'package model\ntype Base struct{}\n',
    'model/method.go': 'package model\nfunc (b *Base) Value() int { return 7 }\n',
    'model/shell.go': 'package model\ntype Shell struct { Base }\nfunc NewShell() *Shell { return &Shell{} }\n',
    'model/alias.go': 'package model\ntype Alias = Base\n',
    'model/alias_method.go': 'package model\nfunc (Alias) Count() int { return 7 }\n',
    'client/client.go': 'package client\nimport "example.org/model/model"\nfunc Value() int { return model.NewShell().Value() }\nfunc Count() int { return (model.Base{}).Count() }\n',
    'client/client_test.go': 'package client\nfunc TestValue() { Value(); Count() }\n',
  });
  for (const seed of ['model/method.go', 'model/alias_method.go']) {
    const r = sdd(d, 'impact', seed, '--json');
    const reached = JSON.parse(r.out).reachedFiles;
    for (const f of ['client/client.go', 'client/client_test.go']) assert.ok(reached.includes(f), `${seed} -> ${f}: ${r.out}`);
  }
});

test('#160 Go local replace paths resolve per importer and preserve subpackage suffixes', () => {
  const d = project();
  writeAll(d, {
    'go.mod': 'module example.org/app\nrequire imported.local/sdk v0.0.0\nreplace (\n imported.local/sdk => ./libs/shared\n)\n',
    'libs/shared/go.mod': 'module original.local/sdk\n',
    'libs/shared/counter/counter.go': 'package counter\nfunc Count() int { return 1 }\n',
    'consumer/consumer.go': 'package consumer\nimport "imported.local/sdk/counter"\nfunc Value() int { return counter.Count() }\n',
    'consumer/consumer_test.go': 'package consumer\nfunc TestValue() { Value() }\n',
    'other/go.mod': 'module example.org/other\n',
    'other/other.go': 'package other\nimport "imported.local/sdk/counter"\nfunc Value() int { return counter.Count() }\n',
  });
  const r = sdd(d, 'impact', 'libs/shared/counter/counter.go', '--json');
  const reached = JSON.parse(r.out).reachedFiles;
  for (const f of ['consumer/consumer.go', 'consumer/consumer_test.go']) assert.ok(reached.includes(f), r.out);
  assert.ok(!reached.includes('other/other.go'), r.out);
});

test('#161 Go external stubs preserve real colliding files and use the declared package', { skip: spawnSync('which', ['go']).status !== 0 }, () => {
  const d = project();
  fs.rmSync(path.join(d, 'add.test.mjs'));
  const real = 'package runtime\n// real production code\nfunc Keep() int { return 73 }\n';
  writeAll(d, {
    'go.mod': 'module example.org/stub\n',
    'internal/runtimev1/runtimev1_stub.go': real,
    'internal/runtimev1/runtimev1_stub2.go': 'package runtime\nfunc KeepToo() int { return 42 }\n',
    'tests/probe_test.go': 'package runtime_test\nimport (\n "testing"\n rt "example.org/stub/internal/runtimev1"\n)\n// @id TEST-CALC-001 @verifies REQ-CALC-001\nfunc TestTEST_CALC_001(t *testing.T) { if rt.NewGauge().Value() != 1 { t.Fatal("wrong") } }\n',
  });
  const r = sdd(d, 'tdd', 'stub', 'TEST-CALC-001');
  assert.equal(r.code, 0, r.out);
  assert.equal(fs.readFileSync(path.join(d, 'internal/runtimev1/runtimev1_stub.go'), 'utf8'), real);
  assert.match(r.out, /compile-checked/);
  assert.doesNotMatch(r.out, /still does not compile/);
  const files = fs.readdirSync(path.join(d, 'internal/runtimev1'));
  const generated = files.filter((f) => !['runtimev1_stub.go', 'runtimev1_stub2.go'].includes(f));
  assert.equal(generated.length, 1, r.out);
  assert.match(fs.readFileSync(path.join(d, 'internal/runtimev1', generated[0]), 'utf8'), /^package runtime\b/);
  const build = spawnSync('go', ['test', './...','-run', '^$'], { cwd: d, encoding: 'utf8' });
  assert.equal(build.status, 0, build.stdout + build.stderr);
});

test('#161 init checks independent nested Go modules even below another module', { skip: spawnSync('which', ['go']).status !== 0 }, () => {
  const d = project();
  writeAll(d, {
    'go.mod': 'module example.org/root\n',
    'root.go': 'package root\n',
    'child/go.mod': 'module example.org/child\n',
    'child/child_test.go': 'package child\nimport "testing"\nfunc TestFailure(t *testing.T) { t.Fatal("nested Go module must be checked") }\n',
    'child/grandchild/go.mod': 'module example.org/grandchild\n',
    'child/grandchild/grandchild.go': 'package grandchild\n',
  });
  const init = sdd(d, 'init');
  assert.equal(init.code, 0, init.out);
  const cfg = JSON.parse(fs.readFileSync(path.join(d, '.sdd/config.json'), 'utf8'));
  assert.deepEqual((cfg.projects ?? []).map((p) => p.root), ['child', 'child/grandchild']);
  assert.ok(cfg.checks.some((c) => c.cmd[0] === 'go'));
  const gate = sdd(d, 'gate');
  assert.equal(gate.code, 1, gate.out);
  assert.match(gate.out, /✗ cmd child:test/);
});

test('#161 Go TestMain early exits cannot provide Red, characterization, Green or Refactor', { skip: spawnSync('which', ['go']).status !== 0 }, () => {
  const d = project();
  fs.rmSync(path.join(d, 'add.test.mjs'));
  writeAll(d, {
    'go.mod': 'module example.org/setup\n',
    'probe_test.go': 'package setup\nimport ("testing"; "os")\nfunc TestMain(m *testing.M) { if os.Getenv("SDD_SETUP_EXIT") != "" { if os.Getenv("SDD_SETUP_EXIT") == "fail" { os.Exit(1) }; os.Exit(0) }; os.Exit(m.Run()) }\n// @id TEST-CALC-001 @verifies REQ-CALC-001\nfunc TestTEST_CALC_001(t *testing.T) { if os.Getenv("SDD_TARGET_PASS") == "" { t.Fatal("target assertion") } }\n',
  });
  sdd(d, 'approve', 'record', 'calc', '--by', 'tester');
  const run = (exit, ...args) => {
    const r = spawnSync('node', [SDD, '--root', d, 'tdd', ...args], { encoding: 'utf8', env: { ...ENV, SDD_SETUP_EXIT: exit } });
    return { code: r.status, out: r.stdout + r.stderr };
  };
  for (const args of [['red', 'TEST-CALC-001'], ['red', 'TEST-CALC-001', '--weak'], ['red', 'TEST-CALC-001', '--characterization', 'setup must still run test']]) {
    const r = run(args.includes('--characterization') ? 'pass' : 'fail', ...args);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /no test matched|never ran/);
  }
  assert.equal(sdd(d, 'tdd', 'red', 'TEST-CALC-001').code, 0);
  const green = run('pass', 'green', 'TEST-CALC-001');
  assert.equal(green.code, 1, green.out);
  const passed = spawnSync('node', [SDD, '--root', d, 'tdd', 'green', 'TEST-CALC-001'], { encoding: 'utf8', env: { ...ENV, SDD_TARGET_PASS: '1' } });
  assert.equal(passed.status, 0, passed.stdout + passed.stderr);
  assert.equal(run('pass', 'refactor', 'TEST-CALC-001').code, 1);
});

test('#162 Go annotated subtests cannot borrow failures from siblings or the parent', { skip: spawnSync('which', ['go']).status !== 0 }, () => {
  for (const json of [false, true]) {
    const d = project();
    fs.rmSync(path.join(d, 'add.test.mjs'));
    writeAll(d, {
      'go.mod': 'module example.org/subtest\n',
      'probe_test.go': 'package subtest\nimport "testing"\nfunc TestTEST_CALC_001(t *testing.T) {\n t.Run("TEST_CALC_001", func(t *testing.T) {\n // @id TEST-CALC-001 @verifies REQ-CALC-001\n if 1 != 1 { t.Fatal("target assertion") }\n })\n t.Run("unrelated", func(t *testing.T) { t.Fatal("sibling only") })\n t.Fatal("parent only")\n}\n',
    });
    fs.writeFileSync(path.join(d, '.sdd/config.json'), JSON.stringify({ testCmd: ['go', 'test', './...', ...(json ? ['-json'] : []), '-run', '{IDU}(_|$)'], checks: [] }));
    sdd(d, 'approve', 'record', 'calc', '--by', 'tester');
    const r = sdd(d, 'tdd', 'red', 'TEST-CALC-001');
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /itself passes|test passed/);
    assert.equal(testEvidence(d).length, 0);
  }
});

test('#162 Go nested subtest selection is hierarchical and supports comments before t.Run', { skip: spawnSync('which', ['go']).status !== 0 }, () => {
  const d = project();
  fs.rmSync(path.join(d, 'add.test.mjs'));
  writeAll(d, {
    'go.mod': 'module example.org/subtest\n',
    'probe_test.go': 'package subtest\nimport ("testing"; "os")\nfunc TestTable(t *testing.T) {\n t.Run("group one", func(t *testing.T) {\n // @id TEST-CALC-001 @verifies REQ-CALC-001\n t.Run("case.+", func(t *testing.T) { if os.Getenv("SDD_TARGET_PASS") == "" { t.Fatal("selected target") } })\n t.Run("caseXX", func(t *testing.T) { t.Fatal("wrong regex sibling") })\n })\n t.Run("other", func(t *testing.T) { t.Fatal("wrong top sibling") })\n}\n',
  });
  sdd(d, 'approve', 'record', 'calc', '--by', 'tester');
  const r = sdd(d, 'tdd', 'red', 'TEST-CALC-001');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /selected target/);
  assert.doesNotMatch(r.out, /wrong.*sibling/);
  const green = spawnSync('node', [SDD, '--root', d, 'tdd', 'green', 'TEST-CALC-001'], { encoding: 'utf8', env: { ...ENV, SDD_TARGET_PASS: '1' } });
  assert.equal(green.status, 0, green.stdout + green.stderr);
});

test('#162 Go unresolved dynamic and skipped annotated subtests cannot use parent evidence', { skip: spawnSync('which', ['go']).status !== 0 }, () => {
  for (const dynamic of [false, true]) {
    const d = project();
    fs.rmSync(path.join(d, 'add.test.mjs'));
    writeAll(d, {
      'go.mod': 'module example.org/subtest\n',
      'probe_test.go': `package subtest\nimport "testing"\nfunc TestTEST_CALC_001(t *testing.T) {\n name := "target"\n _ = name\n t.Run(${dynamic ? 'name' : '"target"'}, func(t *testing.T) {\n // @id TEST-CALC-001 @verifies REQ-CALC-001\n ${dynamic ? 't.Fatal("dynamic failure")' : 't.Skip("skip target")'}\n })\n t.Fatal("parent failure")\n}\n`,
    });
    sdd(d, 'approve', 'record', 'calc', '--by', 'tester');
    const r = sdd(d, 'tdd', 'red', 'TEST-CALC-001', '--weak');
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /no test matched|never ran/);
  }
});

test('#152 nested --root scopes Git changes to the root and runs project checks', () => {
  const repo = project();
  const d = path.join(repo, 'nested app');
  fs.mkdirSync(d);
  for (const f of ['.sdd', 'add.test.mjs']) fs.renameSync(path.join(repo, f), path.join(d, f));
  fs.writeFileSync(path.join(d, '.sdd/specs/calc.md'), '---\nfeature: calc\ntier: T1\n---\n| REQ-CALC-001 | sum | TEST-CALC-001 |\n');
  impl(d, '(a, b) => a + b');
  fs.mkdirSync(path.join(d, 'src'));
  fs.writeFileSync(path.join(d, 'src/quoted "name".mjs'), 'export const value = 1;\n');
  fs.writeFileSync(path.join(repo, 'outside.mjs'), 'export const unrelated = 1;\n');
  fs.writeFileSync(path.join(d, '.sdd/config.json'), JSON.stringify({
    testCmd: ['node', '--test', '--test-name-pattern', '{id}', '{file}'],
    checks: [{ name: 'nested', cwd: 'src', cmd: ['node', '-e', 'process.exit(1)'] }],
  }));
  const gate = sdd(d, 'gate', '--changed');
  assert.equal(gate.code, 1, gate.out);
  assert.match(gate.out, /0\/1 tests Red→Green/);
  assert.match(gate.out, /no Green recorded/);
  assert.match(gate.out, /✗ cmd nested/);
  fs.writeFileSync(path.join(d, '.sdd/config.json'), JSON.stringify({
    checks: [{ name: 'paths', cmd: ['node', '-e', 'process.exit(1)'], changedCmd: ['node', '-e', 'console.log(process.argv.slice(1).join("|"));process.exit(1)', '{changedFiles}'] }],
  }));
  const paths = sdd(d, 'gate', '--changed');
  assert.match(paths.out, /src\/quoted "name"\.mjs/);
  assert.doesNotMatch(paths.out, /outside\.mjs|nested app\//);
});

test('T2 flow: refuses Red before approval, then Red -> Green -> gate', () => {
  const d = project();
  sdd(d, 'init');
  assert.equal(sdd(d, 'tdd', 'red', 'TEST-CALC-001').code, 1, 'unapproved T2 must refuse');
  assert.match(sdd(d, 'approve', 'prepare', 'calc').out, /calc\.md\s+sha256:[0-9a-f]{64}/);
  assert.equal(sdd(d, 'approve', 'record', 'calc', '--by', 'tester').code, 0);

  impl(d, '(a, b) => a - b');
  const red = sdd(d, 'tdd', 'red', 'TEST-CALC-001');
  assert.equal(red.code, 0, red.out);
  assert.equal(sdd(d, 'tdd', 'green', 'TEST-CALC-001').code, 1, 'Green must fail while test still fails');

  impl(d, '(a, b) => a + b');
  assert.equal(sdd(d, 'tdd', 'green', 'TEST-CALC-001').code, 0);
  const g = sdd(d, 'gate', '--no-run');
  assert.match(g.out, /INCOMPLETE/, 'skipped commands never count as PASS');
  assert.match(g.out, /1\/1 tests Red→Green/);
  assert.equal(sdd(d, 'tdd', 'check').code, 0);
});

test('Red rejects a test that already passes and a missing module', () => {
  const d = project();
  sdd(d, 'approve', 'record', 'calc', '--by', 'tester');
  impl(d, '(a, b) => a + b');
  assert.match(sdd(d, 'tdd', 'red', 'TEST-CALC-001').out, /REJECTED.*passed/);
  fs.rmSync(path.join(d, 'add.mjs'));
  assert.match(sdd(d, 'tdd', 'red', 'TEST-CALC-001').out, /REJECTED.*load\/compile/);
  assert.equal(sdd(d, 'tdd', 'red', 'TEST-CALC-001', '--weak').code, 0);
});

test('editing the test after Red blocks Green; editing the spec stales approval', () => {
  const d = project();
  sdd(d, 'approve', 'record', 'calc', '--by', 'tester');
  impl(d, '(a, b) => a - b');
  sdd(d, 'tdd', 'red', 'TEST-CALC-001');
  const tf = path.join(d, 'add.test.mjs');
  fs.writeFileSync(tf, fs.readFileSync(tf, 'utf8') + '// tweak\n');
  impl(d, '(a, b) => a + b');
  assert.match(sdd(d, 'tdd', 'green', 'TEST-CALC-001').out, /changed since Red/);
  fs.appendFileSync(path.join(d, '.sdd/specs/calc.md'), '\nnote\n');
  assert.match(sdd(d, 'guard').out, /approval stale/);
});

test('tampering with the ledger is detected; trace flags orphans', () => {
  const d = project();
  sdd(d, 'approve', 'record', 'calc', '--by', 'tester');
  impl(d, '(a, b) => a - b');
  sdd(d, 'tdd', 'red', 'TEST-CALC-001');
  const lp = path.join(d, '.sdd/tdd.jsonl');
  fs.writeFileSync(lp, fs.readFileSync(lp, 'utf8').replace('"exit":1', '"exit":0'));
  assert.equal(sdd(d, 'tdd', 'check').code, 1);
  fs.appendFileSync(path.join(d, 'add.mjs'), '/** @id CODE-CALC-002 @implements REQ-CALC-999 */\n');
  assert.match(sdd(d, 'trace').out, /unknown REQ-CALC-999/);
});

test('auto specs lock without a human; approval: human specs refuse ai approvers', () => {
  const d = project();
  assert.equal(sdd(d, 'approve', 'record', 'calc', '--by', 'ai:rubber-duck', '--review', 'no findings').code, 0);
  assert.equal(sdd(d, 'guard').code, 0);
  const sp = path.join(d, '.sdd/specs/calc.md');
  fs.writeFileSync(sp, fs.readFileSync(sp, 'utf8').replace('tier: T2', 'tier: T2\napproval: human'));
  assert.match(sdd(d, 'approve', 'record', 'calc', '--by', 'ai:rubber-duck').out, /requires a human/);
  assert.equal(sdd(d, 'approve', 'record', 'calc', '--by', 'nahisaho').code, 0);
});

test('#1 fixture strings are ignored and scan.exclude works', () => {
  const d = project();
  fs.writeFileSync(path.join(d, 'fx.mjs'), 'export const s = "/** @id TEST-CALC-001 @verifies REQ-CALC-001 */";\n');
  fs.mkdirSync(path.join(d, 'fixtures'));
  fs.writeFileSync(path.join(d, 'fixtures/a.mjs'), '/** @id CODE-X-001 @implements REQ-CALC-001 */\n');
  fs.writeFileSync(path.join(d, 'fixtures/b.mjs'), '/** @id CODE-X-001 @implements REQ-CALC-001 */\n');
  assert.match(sdd(d, 'trace').out, /duplicate @id CODE-X-001/);
  fs.writeFileSync(path.join(d, '.sdd/config.json'), JSON.stringify({ scan: { exclude: ['fixtures/**'] }, checks: [] }));
  assert.doesNotMatch(sdd(d, 'trace').out, /duplicate/);
});

test('#2 trace --baseline hides legacy errors but reports new ones', () => {
  const d = project();
  fs.writeFileSync(path.join(d, 'old.mjs'), '/** @id CODE-OLD-001 @implements REQ-NOPE-1 */\n');
  assert.equal(sdd(d, 'trace').code, 1);
  sdd(d, 'trace', '--baseline');
  assert.equal(sdd(d, 'trace').code, 0, 'legacy errors are baselined');
  fs.writeFileSync(path.join(d, 'new.mjs'), '/** @id CODE-NEW-001 @implements REQ-BAD-9 */\n');
  assert.match(sdd(d, 'trace', '--changed').out, /REQ-BAD-9/);
});

test('#4 ai approval needs review evidence', () => {
  const d = project();
  assert.equal(sdd(d, 'approve', 'record', 'calc', '--by', 'ai:self', '--review', 'x').code, 1);
  assert.equal(sdd(d, 'approve', 'record', 'calc', '--by', 'ai:duck').code, 1);
  assert.equal(sdd(d, 'approve', 'record', 'calc', '--by', 'ai:duck', '--review', 'ok').code, 0);
});

test('#5 --missing-module accepts a declared missing import as non-weak Red', () => {
  const d = project();
  sdd(d, 'approve', 'record', 'calc', '--by', 'tester');
  const r = sdd(d, 'tdd', 'red', 'TEST-CALC-001', '--missing-module');
  assert.equal(r.code, 0, r.out);
  assert.doesNotMatch(r.out, /weak/);
});

test('#3 --changed uses changedCmd with placeholders and reports TIMEOUT', () => {
  const d = project();
  fs.writeFileSync(path.join(d, '.sdd/config.json'), JSON.stringify({ checks: [
    { name: 'slow', cmd: ['node', '-e', '0'], changedCmd: ['node', '-e', 'setTimeout(()=>{},5000)', '{changedFiles}'], changedTimeoutMs: 300 },
    { name: 'ok', cmd: ['node', '-e', 'process.exit(1)'], changedCmd: ['node', '-e', 'process.exit(0)', '{changedTests}', '{changedScopes}'] },
  ] }));
  const g = sdd(d, 'gate', '--changed');
  assert.match(g.out, /cmd slow TIMEOUT/);
  assert.match(g.out, /✓ cmd ok/);
});

test('#4 review file: Open findings and missing spec hash are refused', () => {
  const d = project();
  const rv = path.join(d, '.sdd/review.md');
  const hash = sdd(d, 'approve', 'prepare', 'calc').out.match(/sha256:([0-9a-f]{64})/)[1];
  fs.writeFileSync(rv, `spec ${hash}\nverdict: pass\nopen: 1\nF1|high|add.mjs:1|Open\n`);
  assert.match(sdd(d, 'approve', 'record', 'calc', '--by', 'ai:duck', '--review', '.sdd/review.md').out, /1 Open/);
  fs.writeFileSync(rv, `spec ${hash}\nF1|high|add.mjs:1|Closed\n`);
  assert.match(sdd(d, 'approve', 'record', 'calc', '--by', 'ai:duck', '--review', '.sdd/review.md').out, /missing `verdict/);
  fs.writeFileSync(rv, 'verdict: pass\nopen: 0\nF1|high|add.mjs:1|Closed\n');
  assert.match(sdd(d, 'approve', 'record', 'calc', '--by', 'ai:duck', '--review', '.sdd/review.md').out, /spec hash/);
  fs.writeFileSync(rv, `spec ${hash}\nverdict: pass\nopen: 0\nF1|high|add.mjs:1|Closed\n`);
  assert.equal(sdd(d, 'approve', 'record', 'calc', '--by', 'ai:duck', '--review', '.sdd/review.md').code, 0);
  assert.match(sdd(d, 'gate', '--no-run').out, /\[ai, review file\]/);
  fs.writeFileSync(path.join(d, '.sdd/config.json'), JSON.stringify({ requireReviewFile: true, checks: [] }));
  assert.equal(sdd(d, 'approve', 'record', 'calc', '--by', 'ai:duck', '--review', 'looks fine').code, 1);
});

test('#5 tdd stub creates a throwing stub so Red is real (not weak)', () => {
  const d = project();
  sdd(d, 'approve', 'record', 'calc', '--by', 'tester');
  assert.match(sdd(d, 'tdd', 'stub', 'TEST-CALC-001').out, /add\.mjs/);
  assert.match(fs.readFileSync(path.join(d, 'add.mjs'), 'utf8'), /export function add/);
  const r = sdd(d, 'tdd', 'red', 'TEST-CALC-001');
  assert.equal(r.code, 0, r.out);
  assert.doesNotMatch(r.out, /weak/);
  assert.match(sdd(d, 'tdd', 'stub', 'TEST-CALC-001').out, /no missing/);
});

test('#155 unresolved review statuses with explanatory suffixes block check and approval', () => {
  const d = project();
  const hash = sdd(d, 'approve', 'prepare', 'calc').out.match(/sha256:([0-9a-f]{64})/)[1];
  for (const status of ['Open (awaiting fix)', 'OPEN: follow up', '**Open** — fix required', 'Pending (review)', 'In progress - incomplete', 'Blocked: dependency']) {
    fs.writeFileSync(path.join(d, '.sdd/review.md'), `spec: sha256:${hash}\nverdict: pass\nopen: 0\n| R1 | high | add.mjs:1 | ${status} |\n`);
    for (const args of [
      ['review', 'check', '.sdd/review.md', '--feature', 'calc'],
      ['approve', 'record', 'calc', '--by', 'ai:duck', '--review', '.sdd/review.md'],
    ]) {
      const r = sdd(d, ...args);
      assert.equal(r.code, 1, `${status}: ${r.out}`);
      assert.match(r.out, /1 Open/);
    }
  }
  assert.equal(fs.existsSync(path.join(d, '.sdd/approvals.json')), false);
});

test('#155 review spec hash must be a matching header, not a substring anywhere in prose', () => {
  const d = project();
  const hash = sdd(d, 'approve', 'prepare', 'calc').out.match(/sha256:([0-9a-f]{64})/)[1];
  const wrong = '0'.repeat(64);
  for (const header of [
    `spec: sha256:${wrong}\nArtifact hash: ${hash}`,
    `Artifact hash: ${hash}`,
    `spec: sha256:${hash.slice(0, 12)}${wrong.slice(12)}`,
    `spec: sha256:${hash.slice(0, 11)}`,
    `spec: sha256:${hash}\nspec: sha256:${wrong}`,
  ]) {
    fs.writeFileSync(path.join(d, '.sdd/review.md'), `${header}\nverdict: pass\nopen: 0\n`);
    const check = sdd(d, 'review', 'check', '.sdd/review.md', '--feature', 'calc');
    assert.equal(check.code, 1, check.out);
    assert.match(check.out, /spec hash/);
    assert.equal(sdd(d, 'approve', 'record', 'calc', '--by', 'ai:duck', '--review', '.sdd/review.md').code, 1);
  }
  for (const header of [`spec: sha256:${hash}`, `spec: sha256:${hash.slice(0, 12)}`, `spec ${hash}`]) {
    fs.writeFileSync(path.join(d, '.sdd/review.md'), `${header}\nverdict: pass\nopen: 0\n`);
    assert.equal(sdd(d, 'review', 'check', '.sdd/review.md', '--feature', 'calc').code, 0, header);
  }
});

test('#155 passing characterization Red reports passing evidence, not a failure footer', () => {
  const d = project();
  assert.equal(sdd(d, 'approve', 'record', 'calc', '--by', 'tester').code, 0);
  impl(d, '(a, b) => a + b');
  const r = sdd(d, 'tdd', 'red', 'TEST-CALC-001', '--characterization', 'existing golden fixture');
  assert.equal(r.code, 0, r.out);
  assert.doesNotMatch(r.out, /fails with|duration_ms/);
  assert.match(r.out, /characterization: existing golden fixture.*test passed/);
  assert.doesNotMatch(r.out, /\[weak\]/);
});

test('#4 Open detection covers table, checkbox and state: formats', () => {
  const d = project();
  const hash = sdd(d, 'approve', 'prepare', 'calc').out.match(/sha256:([0-9a-f]{64})/)[1];
  for (const line of ['| F1 | high | a.mjs:1 | Open |', '- [ ] F1 fix it', 'F1 state: Open', 'F1|high|a.mjs:1|OPEN', '**Open** F1 fix', '- Open: F1 fix']) {
    fs.writeFileSync(path.join(d, '.sdd/review.md'), `spec ${hash}\nverdict: pass\nopen: 1\n${line}\n`);
    assert.match(sdd(d, 'approve', 'record', 'calc', '--by', 'ai:duck', '--review', '.sdd/review.md').out, /1 Open/, line);
  }
  fs.writeFileSync(path.join(d, '.sdd/review.md'), `spec ${hash}\nverdict: pass\nopen: 0\n| F1 | high | a.mjs:1 | Closed |\n- [x] F2 done\nopen source note\n`);
  assert.equal(sdd(d, 'approve', 'record', 'calc', '--by', 'ai:duck', '--review', '.sdd/review.md').code, 0);
});

test('#1 @id inside multi-line template literals is ignored', () => {
  const d = project();
  fs.writeFileSync(path.join(d, 'fx.test.mjs'), 'const a = `x\n/** @id TEST-EX-001\n * @verifies REQ-CALC-001 */`;\n');
  fs.writeFileSync(path.join(d, 'fy.test.mjs'), 'const b = `x\n/** @id TEST-EX-001\n * @verifies REQ-CALC-001 */`;\n');
  assert.doesNotMatch(sdd(d, 'trace').out, /TEST-EX-001/);
});

test('#8 baseline counts multiplicity: an added same-kind error is new', () => {
  const d = project();
  fs.writeFileSync(path.join(d, 'o1.mjs'), '/** @id CODE-O-001 @implements REQ-NOPE-1 */\n');
  sdd(d, 'trace', '--baseline');
  assert.equal(sdd(d, 'trace').code, 0);
  fs.writeFileSync(path.join(d, 'o2.mjs'), '/** @id CODE-O-001 @implements REQ-NOPE-1 */\n');
  assert.equal(sdd(d, 'trace').code, 1);
});

test('#7 hub change uses hubFallbackCmd; leaf change uses changedCmd', () => {
  const d = project();
  fs.writeFileSync(path.join(d, 'hub.mjs'), 'export const h = 1;\n');
  for (let i = 0; i < 4; i++) fs.writeFileSync(path.join(d, `t${i}.test.mjs`), "import { h } from './hub.mjs';\nexport { h };\n");
  fs.writeFileSync(path.join(d, 'leaf.mjs'), 'export const l = 1;\n');
  fs.writeFileSync(path.join(d, '.sdd/config.json'), JSON.stringify({ checks: [
    { name: 'k', cmd: ['node', '-e', '0'], changedCmd: ['node', '-e', 'console.log("RELATED")'], hubFallbackCmd: ['node', '-e', 'console.log("NARROW")'], hubThreshold: 0.5, minHubTests: 1 },
  ] }));
  spawnSync('git', ['add', '-A'], { cwd: d });
  spawnSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=n', 'commit', '-qm', 'x'], { cwd: d });
  fs.writeFileSync(path.join(d, 'hub.mjs'), 'export const h = 2;\n');
  assert.match(sdd(d, 'gate', '--changed').out, /hub change/);
  spawnSync('git', ['checkout', 'hub.mjs'], { cwd: d });
  fs.appendFileSync(path.join(d, 'leaf.mjs'), '// c\n');
  assert.doesNotMatch(sdd(d, 'gate', '--changed').out, /hub change/);
});

test('#7 oversized hub is skipped as INCOMPLETE, not timed out', () => {
  const d = project();
  fs.writeFileSync(path.join(d, 'hub.mjs'), 'export const h = 1;\n');
  for (let i = 0; i < 4; i++) fs.writeFileSync(path.join(d, `t${i}.test.mjs`), "import { h } from './hub.mjs';\nexport { h };\n");
  fs.writeFileSync(path.join(d, '.sdd/config.json'), JSON.stringify({ checks: [
    { name: 'k', cmd: ['node', '-e', '0'], changedCmd: ['node', '-e', '0'], hubFallbackCmd: ['node', '-e', '0'], hubThreshold: 0.5, minHubTests: 1, hubMaxTests: 2 },
  ] }));
  spawnSync('git', ['add', '-A'], { cwd: d });
  spawnSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=n', 'commit', '-qm', 'x'], { cwd: d });
  fs.writeFileSync(path.join(d, 'hub.mjs'), 'export const h = 2;\n');
  assert.match(sdd(d, 'gate', '--changed').out, /hub too large[\s\S]*INCOMPLETE|INCOMPLETE[\s\S]*hub too large/);
});

test('#11 hub detection follows workspace package names and tsconfig paths', () => {
  const d = project();
  fs.mkdirSync(path.join(d, 'packages/lib/src'), { recursive: true });
  fs.writeFileSync(path.join(d, 'packages/lib/package.json'), JSON.stringify({ name: '@x/lib', main: 'dist/index.js' }));
  fs.writeFileSync(path.join(d, 'packages/lib/src/index.ts'), 'export const h = 1;\n');
  fs.mkdirSync(path.join(d, 'app'));
  fs.writeFileSync(path.join(d, 'tsconfig.json'), '{ // c\n "compilerOptions": { "baseUrl": ".", "paths": { "@app/*": ["app/*"] } } }');
  fs.writeFileSync(path.join(d, 'app/util.ts'), 'export const u = 1;\n');
  for (let i = 0; i < 3; i++) fs.writeFileSync(path.join(d, `t${i}.test.ts`), "import { h } from '@x/lib';\nimport { u } from '@app/util';\n");
  fs.writeFileSync(path.join(d, '.sdd/config.json'), JSON.stringify({ checks: [
    { name: 'k', cmd: ['node', '-e', '0'], changedCmd: ['node', '-e', '0'], hubFallbackCmd: ['node', '-e', 'console.log("NARROW")'], hubThreshold: 0.5, minHubTests: 1 },
  ] }));
  spawnSync('git', ['add', '-A'], { cwd: d });
  spawnSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=n', 'commit', '-qm', 'x'], { cwd: d });
  fs.writeFileSync(path.join(d, 'packages/lib/src/index.ts'), 'export const h = 2;\n');
  assert.match(sdd(d, 'gate', '--changed').out, /hub change \(3\/4/);
  spawnSync('git', ['checkout', '.'], { cwd: d });
  fs.writeFileSync(path.join(d, 'app/util.ts'), 'export const u = 2;\n');
  assert.match(sdd(d, 'gate', '--changed').out, /hub change \(3\/4/);
});

test('#12 hub change is scoped by changed symbols; comment-only is skipped', () => {
  const d = project();
  fs.writeFileSync(path.join(d, 'hub.mjs'), 'export const h = 1;\nexport const k = 1;\n');
  fs.writeFileSync(path.join(d, 'a.test.mjs'), "import { h } from './hub.mjs';\n");
  fs.writeFileSync(path.join(d, 'b.test.mjs'), "import { k } from './hub.mjs';\n");
  fs.writeFileSync(path.join(d, 'c.test.mjs'), "import { k } from './hub.mjs';\n");
  fs.writeFileSync(path.join(d, '.sdd/config.json'), JSON.stringify({ checks: [
    { name: 'k', cmd: ['node', '-e', '0'], changedCmd: ['node', '-e', '0'], hubFallbackCmd: ['node', '-e', '0', '{directTests}'], hubThreshold: 0.1, minHubTests: 1 },
  ] }));
  spawnSync('git', ['add', '-A'], { cwd: d });
  spawnSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=n', 'commit', '-qm', 'x'], { cwd: d });
  fs.writeFileSync(path.join(d, 'hub.mjs'), 'export const h = 2;\nexport const k = 1;\n');
  assert.match(sdd(d, 'gate', '--changed').out, /scoped by changed symbols \(h\) → 1 test files/);
  fs.writeFileSync(path.join(d, 'hub.mjs'), 'export const h = 1;\nexport const k = 1;\n// note\n');
  assert.match(sdd(d, 'gate', '--changed').out, /symbol-neutral/);
  fs.writeFileSync(path.join(d, 'hub.mjs'), 'const z = 1;\nexport const h = 1;\nexport const k = 1;\n');
  assert.match(sdd(d, 'gate', '--changed').out, /hub change \(3\/4/);
  assert.doesNotMatch(sdd(d, 'gate', '--changed').out, /scoped by/);
});

test('#13 prepare runs once, is cached until inputs change, and failure fails the gate', () => {
  const d = project();
  const marker = path.join(d, 'built.txt');
  const cfg = (cmd) => fs.writeFileSync(path.join(d, '.sdd/config.json'), JSON.stringify({ prepare: { cmd, outputs: ['built.txt'] }, checks: [{ name: 'ok', cmd: ['node', '-e', '0'] }] }));
  cfg(['node', '-e', "require('fs').appendFileSync('built.txt','x')"]);
  assert.match(sdd(d, 'gate').out, /✓ prepare \(/);
  assert.match(sdd(d, 'gate').out, /prepare: up to date/);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'x');
  fs.appendFileSync(path.join(d, 'add.test.mjs'), '// edit\n');
  assert.match(sdd(d, 'gate').out, /✓ prepare \(/);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'xx');
  fs.rmSync(marker);
  assert.match(sdd(d, 'gate').out, /✓ prepare \(/);
  cfg(['node', '-e', 'process.exit(3)']);
  const g = sdd(d, 'gate');
  assert.match(g.out, /✗ prepare failed/);
});

test('#9 tokenizer: backticks in strings/comments/nested templates do not desync', () => {
  const d = project();
  fs.writeFileSync(path.join(d, 'real.mjs'), [
    "const a = 'it`s'; // `",
    '/* ` */',
    'const b = `x ${ `y ${1}` } z`;',
    '/** @id CODE-REAL-001 @implements REQ-CALC-001 */',
    'export const r = 1;',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(d, 'fx.mjs'), 'const t = `\n${1}\n/** @id CODE-FX-001 @implements REQ-CALC-001 */\n`;\n');
  const g = sdd(d, 'status').out;
  assert.match(g, /entities 2/);
});

test('#10 gate without specs is INCOMPLETE with a hint, not FAIL', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-'));
  spawnSync('git', ['init', '-q'], { cwd: d });
  const g = sdd(d, 'gate', '--no-run');
  assert.match(g.out, /INCOMPLETE/);
  assert.equal(g.code, 2);
  assert.match(g.out, /T0 changes need no gate/);
});

test('python projects: init uses python3 -m pytest (cwd on sys.path) and a default test check', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-'));
  spawnSync('git', ['init', '-q'], { cwd: d });
  fs.writeFileSync(path.join(d, 'requirements.txt'), '');
  sdd(d, 'init');
  const c = JSON.parse(fs.readFileSync(path.join(d, '.sdd/config.json'), 'utf8'));
  assert.deepEqual(c.testCmd.slice(0, 3), ['python3', '-m', 'pytest']);
  assert.equal(c.checks[0].name, 'test');
});

test('#14 stub Red from a setup call is weak; --expect / --allow-setup-red override', () => {
  const d = project();
  sdd(d, 'approve', 'record', 'calc', '--by', 'tester');
  fs.writeFileSync(path.join(d, 'add.test.mjs'), [
    "import { test } from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { add, reset } from './add.mjs';",
    '/** @id TEST-CALC-001 @verifies REQ-CALC-001 */',
    "test('TEST-CALC-001 adds', () => {",
    '  reset();',
    '  assert.equal(add(1, 2), 3);',
    '});',
    '',
  ].join('\n'));
  const stub = (a, r) => fs.writeFileSync(path.join(d, 'add.mjs'), `export const add = ${a};\nexport const reset = ${r};\n`);
  stub('() => 3', "() => { throw new Error('not implemented: reset'); }");
  const w = sdd(d, 'tdd', 'red', 'TEST-CALC-001');
  assert.equal(w.code, 0, w.out);
  assert.match(w.out, /\[weak\].*setup call "reset"/);
  assert.match(sdd(d, 'tdd', 'red', 'TEST-CALC-001', '--expect', 'not implemented: add').out, /REJECTED.*--expect/);
  assert.doesNotMatch(sdd(d, 'tdd', 'red', 'TEST-CALC-001', '--allow-setup-red').out, /\[weak\]/);
  stub("() => { throw new Error('not implemented: add'); }", '() => {}');
  assert.doesNotMatch(sdd(d, 'tdd', 'red', 'TEST-CALC-001').out, /\[weak\]/);
});

test('#15 go/rust: init picks defaults and {IDU}/{idu} map IDs to test-name patterns', () => {
  const g = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-'));
  spawnSync('git', ['init', '-q'], { cwd: g });
  fs.writeFileSync(path.join(g, 'go.mod'), 'module x\n');
  sdd(g, 'init');
  const gc = JSON.parse(fs.readFileSync(path.join(g, '.sdd/config.json'), 'utf8'));
  assert.deepEqual(gc.testCmd, ['go', 'test', './...', '-run', '{IDU}(_|$)']);
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-'));
  spawnSync('git', ['init', '-q'], { cwd: r });
  fs.writeFileSync(path.join(r, 'Cargo.toml'), '[package]\nname="x"\n');
  sdd(r, 'init');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(r, '.sdd/config.json'), 'utf8')).testCmd, ['cargo', 'test', '{idu}']);
  fs.mkdirSync(path.join(r, 'src'));
  fs.writeFileSync(path.join(r, 'src/lib.rs'), '// @id CODE-X-001 @implements REQ-CALC-001\npub fn f() {}\n');
  assert.match(sdd(r, 'status').out, /entities 1/);
});

test('#15 impl and test in one file (Rust-style): Green is allowed after implementing; editing the test still blocks', () => {
  const d = project();
  sdd(d, 'approve', 'record', 'calc', '--by', 'tester');
  const w = (body, assertion) => fs.writeFileSync(path.join(d, 'add.test.mjs'), [
    "import { test } from 'node:test';",
    "import assert from 'node:assert/strict';",
    '/** @id CODE-CALC-001 @implements REQ-CALC-001 */',
    `const add = (a, b) => ${body};`,
    '/** @id TEST-CALC-001 @verifies REQ-CALC-001 */',
    `test('TEST-CALC-001 adds', () => assert.equal(${assertion}, 3));`,
    '',
  ].join('\n'));
  w('a - b', 'add(1, 2)');
  assert.equal(sdd(d, 'tdd', 'red', 'TEST-CALC-001').code, 0);
  w('a + b', 'add(1, 2)');
  assert.equal(sdd(d, 'tdd', 'green', 'TEST-CALC-001').code, 0);
  w('a + b', 'add(1, 2) + 0');
  assert.match(sdd(d, 'gate', '--no-run').out, /test changed since last Green/);
});

test('#15 go build failure is a load error, not a Red', () => {
  const d = project();
  sdd(d, 'approve', 'record', 'calc', '--by', 'tester');
  const bin = path.join(d, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'go'), '#!/bin/sh\necho "# calc [calc.test]"\necho "./calc_test.go:7:5: undefined: Plus"\necho "FAIL\tcalc [build failed]"\nexit 1\n', { mode: 0o755 });
  fs.writeFileSync(path.join(d, '.sdd/config.json'), JSON.stringify({ schemaVersion: 1, testCmd: [path.join(bin, 'go'), 'test', '-run', '{IDU}'] }));
  assert.match(sdd(d, 'tdd', 'red', 'TEST-CALC-001').out, /REJECTED.*load\/compile/);
});

test('#16 regex literals and JSX text do not desync the tokenizer; unterminated state fails open', () => {
  const d = project();
  fs.writeFileSync(path.join(d, 'rx.mjs'), [
    "const a = /['`]/.test(x);",
    "const b = s.replace(/[`/]/g, '') / 2;",
    "const c = x / 2 / 3; // `",
    'const j = <p>don\'t `quote</p>;',
    '/** @id CODE-RX-001 @implements REQ-CALC-001 */',
    'export const r = 1;',
    '',
  ].join('\n'));
  assert.match(sdd(d, 'status').out, /entities 2/);
  fs.writeFileSync(path.join(d, 'bad.mjs'), 'const t = `unterminated\n/** @id CODE-BAD-001 @implements REQ-CALC-001 */\n');
  assert.match(sdd(d, 'status').out, /entities 3/);
});

test('#17 review template/check: schema is validated, counts must match', () => {
  const d = project();
  const t = sdd(d, 'review', 'template', 'calc').out.replace('verdict: pending', 'verdict: pass');
  fs.writeFileSync(path.join(d, '.sdd/review.md'), t);
  assert.match(sdd(d, 'review', 'check', '.sdd/review.md', '--feature', 'calc').out, /REVIEW OK/);
  fs.writeFileSync(path.join(d, '.sdd/review.md'), t.replace('verdict: pass', 'verdict: fail'));
  assert.equal(sdd(d, 'review', 'check', '.sdd/review.md', '--feature', 'calc').code, 1);
  fs.writeFileSync(path.join(d, '.sdd/review.md'), t + '\n| F1 | high | a.ts:1 | Open |\n');
  assert.match(sdd(d, 'review', 'check', '.sdd/review.md', '--feature', 'calc').out, /does not match 1/);
});

test('#36 an unedited review template is rejected (verdict pending, no sample finding)', () => {
  const d = project();
  const t = sdd(d, 'review', 'template', 'calc').out;
  assert.match(t, /verdict: pending/);
  assert.doesNotMatch(t, /\bF1\b/);
  fs.writeFileSync(path.join(d, '.sdd/review.md'), t);
  const r = sdd(d, 'review', 'check', '.sdd/review.md', '--feature', 'calc');
  assert.equal(r.code, 1);
  assert.match(r.out, /verdict is "pending"/);
});

test('C/C++ sources are scanned; unknown stack warns at init; "FAIL <name>" is shown as the Red reason', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-'));
  spawnSync('git', ['init', '-q'], { cwd: d });
  fs.mkdirSync(path.join(d, '.sdd/specs'), { recursive: true });
  fs.writeFileSync(path.join(d, '.sdd/specs/calc.md'), '---\nfeature: calc\ntier: T2\n---\n## Design\nadd is a pure function.\nno state.\n\n| REQ-CALC-001 | When add is called, the system shall sum. | TEST-CALC-001 |\n');
  fs.writeFileSync(path.join(d, 'calc.c'), '/* @id CODE-CALC-001 @implements REQ-CALC-001 */\nint add(int a, int b) { return a - b; }\n');
  fs.writeFileSync(path.join(d, 't.cpp'), '// @id TEST-CALC-001 @verifies REQ-CALC-001\nint main() { return 1; }\n');
  assert.match(sdd(d, 'init').out, /WARNING: stack not recognised/);
  assert.match(sdd(d, 'status').out, /entities 2/);
  fs.writeFileSync(path.join(d, '.sdd/config.json'), JSON.stringify({ schemaVersion: 1, testCmd: ['sh', '-c', 'echo "FAIL test_calc_001"; exit 1', 'x', '{idu}'] }));
  sdd(d, 'approve', 'record', 'calc', '--by', 'tester');
  assert.match(sdd(d, 'tdd', 'red', 'TEST-CALC-001').out, /fails with: FAIL test_calc_001/);
});

test('gcc/clang/javac compile diagnostics are load errors, not Red', () => {
  for (const diag of ['test.c:7:5: error: implicit declaration of function plus', 'Foo.java:3: error: cannot find symbol', '/usr/bin/ld: x.o: undefined reference to `f`\ncollect2: error: ld returned 1 exit status']) {
    const d = project();
    sdd(d, 'approve', 'record', 'calc', '--by', 'tester');
    fs.writeFileSync(path.join(d, '.sdd/config.json'), JSON.stringify({ schemaVersion: 1, testCmd: ['sh', '-c', `printf '%s\\n' "$0"; exit 1`, diag] }));
    assert.match(sdd(d, 'tdd', 'red', 'TEST-CALC-001').out, /REJECTED.*load\/compile/, diag);
  }
});

test('#24 init detects Maven / Gradle / CMake and zero-match is reported before "passed"', () => {
  const cases = [
    [{ 'pom.xml': '<project/>' }, 'mvn', /-Dtest=\*#\*\{idu\}(?!\*)/],
    [{ 'build.gradle': '' }, 'sh', / gradle -I .*--tests "\*\$0"/],
    [{ 'build.gradle.kts': '', gradlew: '' }, 'sh', / \.\/gradlew -I .*--tests "\*\$0"/],
    [{ 'CMakeLists.txt': '' }, 'sh', /ctest .* -R "\$0"/],
  ];
  for (const [files, head, re] of cases) {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-'));
    spawnSync('git', ['init', '-q'], { cwd: d });
    for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(d, f), c);
    const out = sdd(d, 'init').out;
    assert.doesNotMatch(out, /not recognised/);
    const c = JSON.parse(fs.readFileSync(path.join(d, '.sdd/config.json'), 'utf8'));
    assert.equal(c.testCmd[0], head);
    assert.match(c.testCmd.join(' '), re);
    assert.equal(c.checks[0].name, 'test');
  }
  const d = project();
  sdd(d, 'approve', 'record', 'calc', '--by', 'tester');
  fs.writeFileSync(path.join(d, '.sdd/config.json'), JSON.stringify({ schemaVersion: 1, testCmd: ['sh', '-c', 'echo "Tests run: 0, Failures: 0"; exit 0'] }));
  assert.match(sdd(d, 'tdd', 'red', 'TEST-CALC-001').out, /no test matched/);
});

test('#30 polyglot monorepo: nested manifests become projects run in their own cwd', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-'));
  spawnSync('git', ['init', '-q'], { cwd: d });
  fs.mkdirSync(path.join(d, 'services/py'), { recursive: true });
  fs.mkdirSync(path.join(d, 'services/go'), { recursive: true });
  fs.mkdirSync(path.join(d, '.sdd/specs'), { recursive: true });
  fs.writeFileSync(path.join(d, 'services/py/pyproject.toml'), '');
  fs.writeFileSync(path.join(d, 'services/go/go.mod'), 'module x\n');
  fs.writeFileSync(path.join(d, '.sdd/specs/g.md'), '---\nfeature: g\ntier: T1\n---\n| REQ-GO-001 | When x, the system shall y. | TEST-GO-001 |\n');
  fs.writeFileSync(path.join(d, 'services/go/x_test.go'), '// @id TEST-GO-001 @verifies REQ-GO-001\nfunc TestX() {}\n');
  assert.match(sdd(d, 'init').out, /projects: services\/go.*services\/py/);
  const c = JSON.parse(fs.readFileSync(path.join(d, '.sdd/config.json'), 'utf8'));
  assert.deepEqual(c.projects.map((p) => p.root), ['services/go', 'services/py']);
  assert.deepEqual(c.projects[0].testCmd.slice(0, 2), ['go', 'test']);
  c.projects[0].testCmd = ['sh', '-c', 'echo "cwd=$(pwd) file=$0"; echo "FAIL x"; exit 1', '{file}'];
  fs.writeFileSync(path.join(d, '.sdd/config.json'), JSON.stringify(c));
  const r = sdd(d, 'tdd', 'red', 'TEST-GO-001');
  assert.equal(r.code, 0, r.out);
  const ledger = fs.readFileSync(path.join(d, '.sdd/tdd.jsonl'), 'utf8');
  assert.match(ledger, /services\/go\/x_test\.go/);
  c.projects[0].checks = [{ name: 'test', cmd: ['sh', '-c', 'exit 0'] }];
  fs.writeFileSync(path.join(d, '.sdd/config.json'), JSON.stringify(c));
  assert.match(sdd(d, 'gate').out, /cmd services\/go:test/);
});

test('#25 init detects PHP / R / Julia and tdd stub writes throwing php + julia stubs', () => {
  const mk = (files) => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-'));
    spawnSync('git', ['init', '-q'], { cwd: d });
    for (const [f, body] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), body); }
    return d;
  };
  assert.match(sdd(mk({ 'composer.json': '{}' }), 'init').out, /testCmd: phpunit .*--filter \{idu\}/);
  assert.match(sdd(mk({ DESCRIPTION: 'Package: x\n' }), 'init').out, /testCmd: Rscript .*testthat/);
  assert.match(sdd(mk({ 'Project.toml': 'name = "X"\n' }), 'init').out, /testCmd: julia --project=\. \{file\}/);
  const spec = '---\nfeature: c\ntier: T1\n---\n| REQ-C-001 | When add, the system shall sum. | TEST-C-001 |\n';
  const php = mk({ 'composer.json': '{}', '.sdd/specs/c.md': spec, 'tests/CTest.php': "<?php\nrequire_once __DIR__ . '/../src/C.php';\n// @id TEST-C-001 @verifies REQ-C-001\nfinal class CTest { function test_c_001() { assert(c_add(1, 2) === 3); } }\n" });
  assert.match(sdd(php, 'tdd', 'stub', 'TEST-C-001').out, /src\/C\.php/);
  assert.match(fs.readFileSync(path.join(php, 'src/C.php'), 'utf8'), /function c_add\(.*\n.*LogicException\('not implemented: c_add'\)/);
  const jl = mk({ 'Project.toml': 'name = "X"\n', '.sdd/specs/c.md': spec, 'test/runtests.jl': 'include("../src/C.jl")\n# @id TEST-C-001 @verifies REQ-C-001\n@test c_add(1, 2) == 3\n' });
  assert.match(sdd(jl, 'tdd', 'stub', 'TEST-C-001').out, /src\/C\.jl/);
  assert.match(fs.readFileSync(path.join(jl, 'src/C.jl'), 'utf8'), /c_add\(args\.\.\.; kwargs\.\.\.\) = error\("not implemented: c_add"\)/);
});

test('#25 tdd stub for Java / C / Go / Rust infers arity and return type from the test', { skip: ['cc', 'go', 'cargo'].some((c) => spawnSync('which', [c]).status !== 0) }, () => {
  const mk = (files) => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-'));
    spawnSync('git', ['init', '-q'], { cwd: d });
    for (const [f, body] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), body); }
    return d;
  };
  const read = (d, f) => fs.readFileSync(path.join(d, f), 'utf8');
  const java = mk({ 'test/CTest.java': 'public class CTest {\n  // @id TEST-C-001 @verifies REQ-C-001\n  static boolean t() { return C.add(1, 2) == 3; }\n}\n' });
  assert.match(sdd(java, 'tdd', 'stub', 'TEST-C-001').out, /src\/C\.java/);
  assert.match(read(java, 'src/C.java'), /public static int add\(Object a0, Object a1\)[\s\S]*not implemented: add/);
  const c = mk({ 'test_c.c': '#include "c.h"\n/* @id TEST-C-001 @verifies REQ-C-001 */\nint main(void) { return add(1, 2) == 3 ? 0 : 1; }\n' });
  assert.match(sdd(c, 'tdd', 'stub', 'TEST-C-001').out, /c\.h/);
  assert.match(read(c, 'c.h'), /static inline int add\(int a0, int a1\)[\s\S]*abort\(\)/);
  const go = mk({ 'go.mod': 'module c\n\ngo 1.21\n', 'c_test.go': 'package c\nimport "testing"\n// @id TEST-C-001 @verifies REQ-C-001\nfunc TestTEST_C_001(t *testing.T) { if Add(1, 2) != 3 { t.Fatal("x") } }\n' });
  assert.match(sdd(go, 'tdd', 'stub', 'TEST-C-001').out, /c\.go/);
  assert.match(read(go, 'c.go'), /func Add\(a0, a1 any\) int \{\n\tpanic\("not implemented: Add"\)/);
  const rs = mk({ 'Cargo.toml': '[package]\nname = "c"\nversion = "0.1.0"\nedition = "2021"\n', 'tests/c.rs': 'use c::*;\n// @id TEST-C-001 @verifies REQ-C-001\n#[test]\nfn test_c_001() { assert_eq!(add(1, 2), 3); }\n' });
  assert.match(sdd(rs, 'tdd', 'stub', 'TEST-C-001').out, /src\/lib\.rs/);
  assert.match(read(rs, 'src/lib.rs'), /pub fn add<A0, A1>\(_a0: A0, _a1: A1\) -> i64/);
});

function jsStubProject(files) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-jsstub-'));
  spawnSync('git', ['init', '-q'], { cwd: d });
  fs.mkdirSync(path.join(d, '.sdd/specs'), { recursive: true });
  fs.writeFileSync(path.join(d, 'package.json'), '{"name":"x","type":"module","scripts":{"test":"true"}}');
  for (const [f, body] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), body); }
  sdd(d, 'init');
  return d;
}

test('#153 JS/TS stubs infer only selected-test methods and imports', () => {
  for (const ext of ['js', 'ts']) {
    const real = 'export class Worker { run() { return 1; } }\n';
    const d = jsStubProject({
      [`src/worker.${ext}`]: real,
      [`test/a.test.${ext}`]: [
        `import { Worker } from '../src/worker.${ext}';`,
        "import * as boxes from '../src/box';",
        '/** @id TEST-A-001 @verifies REQ-A-001 */',
        "test('TEST-A-001', () => { new Worker().run(); new boxes.Box().first(); });",
        '/** @id TEST-A-002 @verifies REQ-A-001 */',
        "test('TEST-A-002', async () => { new Worker().stop(); new boxes.Box().second(); const { extra } = await import('../src/sibling'); extra(); });",
      ].join('\n'),
    });
    const r = sdd(d, 'tdd', 'stub', 'TEST-A-001');
    assert.equal(r.code, 0, r.out);
    assert.equal(fs.readFileSync(path.join(d, `src/worker.${ext}`), 'utf8'), real);
    const box = fs.readFileSync(path.join(d, `src/box.${ext}`), 'utf8');
    assert.match(box, /first\(/);
    assert.doesNotMatch(box, /second\(/);
    assert.equal(fs.existsSync(path.join(d, `src/sibling.${ext}`)), false);
  }
});

test('#153 factory return values are not instances of the factory class', () => {
  const real = 'export class Registry { create() { return new Child(); } }\nexport class Child { get() { return 1; } }\n';
  const d = jsStubProject({
    'src/registry.js': real,
    'test/a.test.js': [
      "import { Registry } from '../src/registry.js';",
      'const make = () => new Registry().create();',
      '/** @id TEST-A-001 @verifies REQ-A-001 */',
      "test('TEST-A-001', () => { const child = new Registry().create(); child.get(); const other = make(); other.get(); });",
    ].join('\n'),
  });
  assert.equal(sdd(d, 'tdd', 'stub', 'TEST-A-001').code, 0);
  assert.equal(fs.readFileSync(path.join(d, 'src/registry.js'), 'utf8'), real);
});

test('#153 a missing workspace export entry is created, including conditional subpath exports', () => {
  for (const [exports, spec, file] of [
    ['./src/index.ts', '@repro/lib', 'src/index.ts'],
    [{ import: './src/main.ts' }, '@repro/lib', 'src/main.ts'],
    [{ '.': { import: './src/index.mjs' }, './math': { default: './src/math.mjs' } }, '@repro/lib/math', 'src/math.mjs'],
  ]) {
    const d = jsStubProject({
      'packages/lib/package.json': JSON.stringify({ name: '@repro/lib', exports }),
      'test/a.test.ts': `import { add } from '${spec}';\n/** @id TEST-A-001 @verifies REQ-A-001 */\ntest('TEST-A-001', () => { add(1, 2); });\n`,
    });
    const r = sdd(d, 'tdd', 'stub', 'TEST-A-001');
    assert.equal(r.code, 0, r.out);
    assert.match(fs.readFileSync(path.join(d, 'packages/lib', file), 'utf8'), /export function add/);
    assert.doesNotMatch(r.out, /no missing|not stubbed/);
  }
});

test('#153 assert.rejects/throws subjects are ordinary classes; matcher constructors extend Error', () => {
  const d = jsStubProject({
    'test/a.test.js': [
      "import { Worker, Boom, Fault } from '../src/worker.js';",
      '/** @id TEST-A-001 @verifies REQ-A-001 */',
      "test('TEST-A-001', async () => { await assert.rejects(new Worker().run(), /failure/);",
      "assert.throws(() => new Worker().run(), Boom); await assert.rejects(async () => new Worker().run(), Fault); });",
    ].join('\n'),
  });
  const r = sdd(d, 'tdd', 'stub', 'TEST-A-001');
  assert.equal(r.code, 0, r.out);
  const text = fs.readFileSync(path.join(d, 'src/worker.js'), 'utf8');
  assert.match(text, /class Worker \{/);
  assert.match(text, /class Boom extends Error/);
  assert.match(text, /class Fault extends Error/);
});

test('#128 tdd stub never adds methods to an existing class unless the receiver is provably that class', () => {
  const real = 'export class Store { read() { return []; } }\nexport class Other { go() { return 1; } }\n';
  const d = jsStubProject({
    'src/real.js': real,
    'test/a.test.js': [
      "import { Store, Other } from '../src/real.js';", "import { Handler } from '../src/handler.js';",
      'const make = () => new Store();',
      '/** @id TEST-A-001 @verifies REQ-A-001 */ test(\'TEST-A-001 x\', () => { const store = make(); const h = new Handler({ store });',
      "  assert.equal(h.run(), 1); assert.equal(store.read('x').length, 0); assert.equal(new Other().go(), 1); });", '',
    ].join('\n'),
  });
  sdd(d, 'tdd', 'stub', 'TEST-A-001');
  assert.equal(fs.readFileSync(path.join(d, 'src/real.js'), 'utf8'), real);
  assert.match(fs.readFileSync(path.join(d, 'src/handler.js'), 'utf8'), /class Handler[\s\S]*run\(/);
  // a provable receiver (`new Other().stop()`) is still stubbed in the real class, append-only
  fs.writeFileSync(path.join(d, 'test/a.test.js'), fs.readFileSync(path.join(d, 'test/a.test.js'), 'utf8').replace('new Other().go()', 'new Other().stop()'));
  sdd(d, 'tdd', 'stub', 'TEST-A-001');
  const after = fs.readFileSync(path.join(d, 'src/real.js'), 'utf8');
  assert.match(after, /stop\(\.\.\._args\)[\s\S]*not implemented: Other\.stop/);
  assert.doesNotMatch(after, /Other\.read|Store\.stop/);
});

test('#128 tdd stub: namespace imports, static methods, value imports and multi-line imports', () => {
  const d = jsStubProject({
    'test/n.test.ts': [
      "import * as util from '../src/util';", "import { Foo, CONFIG } from '../src/foo';",
      'import {', '  alpha,', '  type Shape,', '  beta,', "} from '../src/multi';",
      '/** @id TEST-N-001 @verifies REQ-N-001 */ test(\'TEST-N-001 x\', () => {',
      "  expect(util.slug('A b')).toBe('a-b'); expect(Foo.create(1)).toBeTruthy(); expect(CONFIG.max).toBe(3); expect(alpha(beta(1))).toBe(1); });", '',
    ].join('\n'),
  });
  const r = sdd(d, 'tdd', 'stub', 'TEST-N-001');
  assert.doesNotMatch(r.out, /no missing/);
  const rd = (f) => fs.readFileSync(path.join(d, f), 'utf8');
  assert.match(rd('src/util.ts'), /export function slug\(/);
  assert.doesNotMatch(rd('src/util.ts'), /^export \{\};/m);
  assert.match(rd('src/foo.ts'), /export class Foo[\s\S]*static create\(/);
  assert.match(rd('src/foo.ts'), /export const CONFIG: any = new Proxy[\s\S]*not implemented: CONFIG\./);
  assert.doesNotMatch(rd('src/foo.ts'), /function CONFIG/);
  assert.match(rd('src/multi.ts'), /export function alpha\([\s\S]*export function beta\(/);
  assert.match(rd('src/multi.ts'), /export type Shape = any;/);
});

test('#128 tdd stub: workspace package imports are stubbed in the package entry; unresolvable packages are reported', () => {
  const d = jsStubProject({
    'package.json': '{"name":"root","private":true,"workspaces":["packages/*"],"scripts":{"test":"true"}}',
    'packages/domain/package.json': '{"name":"@bk/domain","main":"src/index.ts"}',
    'packages/domain/src/index.ts': 'export const keep = 1;\n',
    'packages/app/test/d.test.ts': [
      "import { isTerminal } from '@bk/domain';", "import { ghost } from '@bk/ghost';",
      '/** @id TEST-D-001 @verifies REQ-D-001 */ test(\'TEST-D-001 x\', () => { expect(isTerminal(1)).toBe(true); ghost(); });', '',
    ].join('\n'),
  });
  const r = sdd(d, 'tdd', 'stub', 'TEST-D-001');
  const idx = fs.readFileSync(path.join(d, 'packages/domain/src/index.ts'), 'utf8');
  assert.match(idx, /^export const keep = 1;\n/);
  assert.match(idx, /export function isTerminal\(/);
  assert.match(r.out, /not stubbed: @bk\/ghost/);
});

const GO_OK = spawnSync('which', ['go']).status === 0;
function goStubProject(files) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-gostub-'));
  spawnSync('git', ['init', '-q'], { cwd: d });
  fs.writeFileSync(path.join(d, 'go.mod'), 'module example.com/r\n\ngo 1.21\n');
  for (const [f, body] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), body); }
  return d;
}

test('#129 Go external test package: Err* become errors.New vars, ctor returns a zero value, stub compiles, path printed once', { skip: !GO_OK }, () => {
  const d = goStubProject({
    'calc/calc_test.go': 'package calc_test\n\nimport (\n\t"errors"\n\t"testing"\n\n\t"example.com/r/calc"\n)\n\n// @id TEST-C-001 @verifies REQ-C-001\nfunc TestC(t *testing.T) {\n\tif _, err := calc.New(0, 1, nil); !errors.Is(err, calc.ErrBad) {\n\t\tt.Fatal(err)\n\t}\n\tc, err := calc.New(1, 3, nil)\n\tif err != nil {\n\t\tt.Fatal(err)\n\t}\n\tif c.Allow() != true {\n\t\tt.Fatal("no")\n\t}\n}\n',
  });
  const r = sdd(d, 'tdd', 'stub', 'TEST-C-001');
  const body = fs.readFileSync(path.join(d, 'calc/calc.go'), 'utf8');
  assert.match(body, /var ErrBad = errors\.New\("ErrBad"\)/);
  assert.doesNotMatch(body, /const ErrBad/);
  assert.match(body, /func New\(a0, a1, a2 any\) \(\*Calc, error\) \{\n\treturn &Calc\{\}, nil/);
  assert.match(body, /func \(\*Calc\) Allow\(\)[\s\S]*not implemented: Calc\.Allow/);
  assert.doesNotMatch(body, /NewResult|func New\(\) error/);
  assert.equal((r.out.match(/calc\/calc\.go/g) ?? []).length, 1, r.out);
  assert.doesNotMatch(r.out, /NOT verified|does not compile/);
  const vet = spawnSync('go', ['vet', './calc'], { cwd: d, encoding: 'utf8' });
  assert.equal(vet.status, 0, vet.stdout + vet.stderr);
});

test('#129 Go in-package constructors return a zero value so only behaviour methods panic', { skip: !GO_OK }, () => {
  const d = goStubProject({
    'pq/pq_test.go': 'package pq\n\nimport "testing"\n\n// @id TEST-PQ-001 @verifies REQ-PQ-001\nfunc TestPQ(t *testing.T) {\n\tq := New()\n\tq.Push("low", 1)\n\tgot := q.Pop()\n\tif got != "low" {\n\t\tt.Fatal(got)\n\t}\n}\n',
  });
  const r = sdd(d, 'tdd', 'stub', 'TEST-PQ-001');
  const body = fs.readFileSync(path.join(d, 'pq/pq.go'), 'utf8');
  assert.match(body, /func New\(\) \*Pq \{\n\treturn &Pq\{\}\n\}/);
  assert.doesNotMatch(body, /not implemented: New\b/);
  assert.match(body, /not implemented: Pq\.Push/);
  assert.doesNotMatch(r.out, /does not compile/);
  assert.equal(spawnSync('go', ['vet', './pq'], { cwd: d, encoding: 'utf8' }).status, 0);
});

test('#31 mixed monorepo: root JS + nested go becomes a project, nested js stays with the root', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-'));
  spawnSync('git', ['init', '-q'], { cwd: d });
  for (const [f, b] of Object.entries({ 'package.json': '{"scripts":{"test":"echo ok"}}', 'packages/a/package.json': '{}', 'services/go/go.mod': 'module x\n' })) { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), b); }
  assert.match(sdd(d, 'init').out, /root \+ projects: services\/go/);
  const c = JSON.parse(fs.readFileSync(path.join(d, '.sdd/config.json'), 'utf8'));
  assert.deepEqual(c.projects.map((p) => p.root), ['services/go']);
  assert.ok(c.checks.some((k) => k.name === 'test'), 'root checks kept');
  assert.equal(c.testCmd[0], 'node');
});

test('#32 projects: dependsOn triggers dependents, project changedCmd gets project-relative paths', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-'));
  const git = (...a) => spawnSync('git', a, { cwd: d });
  git('init', '-q');
  for (const f of ['libs/shared/x.txt', 'services/api/a.txt', 'services/web/w.txt', '.sdd/specs/g.md']) { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), 'x'); }
  git('add', '-A'); git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'i');
  fs.writeFileSync(path.join(d, '.sdd/config.json'), JSON.stringify({ schemaVersion: 1, testCmd: ['true'], checks: [], projects: [
    { root: 'services/api', testCmd: ['true'], dependsOn: ['libs/shared'], checks: [{ name: 'test', cmd: ['sh', '-c', 'echo full'], changedCmd: ['sh', '-c', 'echo scoped "$@"', 'x', '{changedFiles}'] }] },
    { root: 'services/web', testCmd: ['true'], checks: [{ name: 'test', cmd: ['true'] }] },
  ] }));
  fs.writeFileSync(path.join(d, 'libs/shared/x.txt'), 'changed');
  let r = sdd(d, 'gate', '--changed').out;
  assert.match(r, /cmd services\/api:test/);
  assert.match(r, /services\/web:test: no changed files/);
  fs.writeFileSync(path.join(d, 'services/api/a.txt'), 'changed');
  r = sdd(d, 'gate', '--changed', '--json').out;
  assert.match(r, /cmd services\/api:test/);
});

test('#27 {idu} falls back to the test method declared below @id (camelCase JUnit)', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-'));
  spawnSync('git', ['init', '-q'], { cwd: d });
  fs.mkdirSync(path.join(d, '.sdd/specs'), { recursive: true });
  fs.writeFileSync(path.join(d, '.sdd/specs/c.md'), '---\nfeature: c\ntier: T1\n---\n| REQ-C-001 | When x, the system shall y. | TEST-C-001 |\n');
  fs.writeFileSync(path.join(d, 'CTest.java'), 'class CTest {\n  // @id TEST-C-001 @verifies REQ-C-001\n  @Test\n  @DisplayName("adds")\n  void addsNumbers() {}\n}\n');
  fs.writeFileSync(path.join(d, '.sdd/config.json'), JSON.stringify({ schemaVersion: 1, testCmd: ['sh', '-c', 'echo "$0" > filter.txt; echo "FAIL x"; exit 1', '{idu}'] }));
  assert.match(sdd(d, 'tdd', 'red', 'TEST-C-001').out, /RED ok/);
  assert.equal(fs.readFileSync(path.join(d, 'filter.txt'), 'utf8').trim(), 'addsNumbers');
});

test('#26 multi-module output: a zero-test module does not hide a failing one; build/POM errors are not Red', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-'));
  spawnSync('git', ['init', '-q'], { cwd: d });
  fs.mkdirSync(path.join(d, '.sdd/specs'), { recursive: true });
  fs.writeFileSync(path.join(d, '.sdd/specs/c.md'), '---\nfeature: c\ntier: T1\n---\n| REQ-C-001 | When x, the system shall y. | TEST-C-001 |\n');
  fs.writeFileSync(path.join(d, 'a_test.py'), '# @id TEST-C-001 @verifies REQ-C-001\ndef test_c_001(): pass\n');
  const red = (script) => { fs.writeFileSync(path.join(d, '.sdd/config.json'), JSON.stringify({ schemaVersion: 1, testCmd: ['sh', '-c', script] })); return sdd(d, 'tdd', 'red', 'TEST-C-001').out; };
  assert.match(red('echo "Tests run: 0, Failures: 0"; echo "Tests run: 1, Failures: 1"; echo "FAIL x"; exit 1'), /RED ok/);
  assert.match(red('echo "Tests run: 0, Failures: 0"; echo "Tests run: 0, Failures: 0"; exit 1'), /no test matched/);
  assert.match(red('echo "Non-parseable POM /x/pom.xml: Duplicated tag"; exit 1'), /load\/compile error/);
  assert.match(red('printf "* What went wrong:\\nBUG! exception in phase semantic analysis\\n"; exit 1'), /load\/compile error/);
  assert.match(red('printf "* What went wrong:\\nExecution failed for task \':core:test\'.\\n> There were failing tests\\n"; echo "FAIL x"; exit 1'), /RED ok/);
});

test('#28 init detects Makefile and .NET projects; MSBuild/C# errors are load errors', () => {
  for (const [files, re] of [[{ Makefile: 'test:\n\ttrue\n' }, /testCmd: make test TEST=\{idu\}/], [{ 'App.csproj': '<Project/>' }, /testCmd: dotnet test --nologo --filter FullyQualifiedName~\{idu\}/]]) {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-'));
    spawnSync('git', ['init', '-q'], { cwd: d });
    for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(d, f), c);
    const out = sdd(d, 'init').out;
    assert.doesNotMatch(out, /not recognised/);
    assert.match(out, re);
  }
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-'));
  spawnSync('git', ['init', '-q'], { cwd: d });
  fs.mkdirSync(path.join(d, '.sdd/specs'), { recursive: true });
  fs.writeFileSync(path.join(d, '.sdd/specs/c.md'), '---\nfeature: c\ntier: T1\n---\n| REQ-C-001 | When x, the system shall y. | TEST-C-001 |\n');
  fs.writeFileSync(path.join(d, 'CTest.cs'), '// @id TEST-C-001 @verifies REQ-C-001\npublic void Adds() {}\n');
  fs.writeFileSync(path.join(d, '.sdd/config.json'), JSON.stringify({ schemaVersion: 1, testCmd: ['sh', '-c', 'echo "CTest.cs(3,5): error CS0103: The name Calc does not exist"; exit 1'] }));
  assert.match(sdd(d, 'tdd', 'red', 'TEST-C-001').out, /load\/compile error/);
});

test('#33 gate --changed scopes Go to changed packages plus dependents; go.mod falls back to full', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-go-'));
  const git = (...a) => spawnSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=t', ...a], { cwd: d });
  const w = (f, c) => { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), c); };
  git('init', '-q');
  w('go.mod', 'module m\n\ngo 1.21\n');
  w('a/a.go', 'package a\nfunc A() int { return 1 }\n');
  w('b/b.go', 'package b\nimport "m/a"\nfunc B() int { return a.A() }\n');
  w('c/c.go', 'package c\n');
  sdd(d, 'init');
  git('add', '-A'); git('commit', '-qm', 'base');
  w('a/a.go', 'package a\nfunc A() int { return 2 }\n');
  assert.match(sdd(d, 'gate', '--changed').out, /scoped → go test m\/a m\/b\b/);
  git('commit', '-qam', 'a');
  w('go.mod', 'module m\n\ngo 1.22\n');
  assert.match(sdd(d, 'gate', '--changed').out, /cannot scope changes for \{changedGoPkgs\} — running the full check/);
});

test('#34 tdd stub for a Python test inside a project dir writes the stub under that project, not the repo root', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-pystub-'));
  const w = (f, c) => { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), c); };
  spawnSync('git', ['init', '-q'], { cwd: d });
  w('package.json', '{"name":"r","scripts":{"test":"true"}}');
  w('worker/pyproject.toml', '[project]\nname="w"\nversion="0"\n');
  w('worker/tests/test_s.py', '# @id TEST-S-001\n# @verifies REQ-S-001\nfrom jobworker.stats import percentile\ndef test_s_001():\n    assert percentile([1], 50) == 1\n');
  w('.sdd/specs/s.md', '---\nfeature: s\ntier: T1\n---\n| ID | EARS | Test |\n| --- | --- | --- |\n| REQ-S-001 | When p, the system shall return. | TEST-S-001 |\n');
  sdd(d, 'init');
  sdd(d, 'tdd', 'stub', 'TEST-S-001');
  assert.ok(fs.existsSync(path.join(d, 'worker/jobworker/stats.py')));
  assert.ok(!fs.existsSync(path.join(d, 'jobworker')));
});

test('#37 a check whose runner reports "no tests ran" is INCOMPLETE, a real failure still FAILs', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-'));
  spawnSync('git', ['init', '-q'], { cwd: d });
  fs.mkdirSync(path.join(d, '.sdd/specs'), { recursive: true });
  const cfg = (cmd) => fs.writeFileSync(path.join(d, '.sdd/config.json'), JSON.stringify({ checks: [{ name: 'py', cmd }] }));
  cfg(['node', '-e', "console.log('no tests ran in 0.01s'); process.exit(5)"]);
  const r = sdd(d, 'gate');
  assert.match(r.out, /no tests exist yet/);
  assert.doesNotMatch(r.out, /✗ cmd/);
  cfg(['node', '-e', "console.log('1 failed, 3 passed'); process.exit(1)"]);
  assert.match(sdd(d, 'gate').out, /✗ cmd py/);
});

test('#41 tdd stub for Python does not shadow stdlib modules but still stubs project modules', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-pystd-'));
  spawnSync('git', ['init', '-q'], { cwd: d });
  fs.mkdirSync(path.join(d, '.sdd/specs'), { recursive: true });
  fs.mkdirSync(path.join(d, 'tests'));
  fs.writeFileSync(path.join(d, 'tests/test_s.py'), '# @id TEST-S-001\n# @verifies REQ-S-001\nfrom pathlib import Path\nfrom jobx.mod import f\ndef test_s_001():\n    assert f(Path(".")) == 1\n');
  sdd(d, 'init');
  sdd(d, 'tdd', 'stub', 'TEST-S-001');
  assert.ok(!fs.existsSync(path.join(d, 'pathlib.py')));
  assert.ok(fs.existsSync(path.join(d, 'jobx/mod.py')));
});

test('#42 tdd stub for JS/TS generates a class for symbols used with new / extends / toThrow(Class)', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-clsstub-'));
  spawnSync('git', ['init', '-q'], { cwd: d });
  fs.mkdirSync(path.join(d, '.sdd/specs'), { recursive: true });
  fs.writeFileSync(path.join(d, 'package.json'), '{"name":"x","scripts":{"test":"true"}}');
  fs.writeFileSync(path.join(d, 's.test.ts'), [
    "import { Sched, Boom, plain } from './s';",
    '// @id TEST-S-001 @verifies REQ-S-001',
    "test('TEST-S-001 x', () => { const s = new Sched(); expect(() => plain()).toThrow(Boom); });",
    '',
  ].join('\n'));
  sdd(d, 'init');
  sdd(d, 'tdd', 'stub', 'TEST-S-001');
  const body = fs.readFileSync(path.join(d, 's.ts'), 'utf8');
  assert.match(body, /export class Sched\b/);
  assert.match(body, /export class Boom\b/);
  assert.match(body, /export function plain\b/);
});

test('#35 weak-Red classification follows the throwing call site: same symbol in setup and assert, and helper-wrapped calls', () => {
  const d = project();
  sdd(d, 'approve', 'record', 'calc', '--by', 'tester');
  const stub = "export const add = () => { throw new Error('not implemented: add'); };\n";
  fs.writeFileSync(path.join(d, 'add.mjs'), stub);
  const test = (body) => fs.writeFileSync(path.join(d, 'add.test.mjs'), [
    "import { test } from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { add } from './add.mjs';",
    'const call = (a, b) => add(a, b);',
    '/** @id TEST-CALC-001 @verifies REQ-CALC-001 */',
    "test('TEST-CALC-001 adds', () => {",
    ...body,
    '});',
    '',
  ].join('\n'));
  test(['  const seed = add(0, 0);', '  assert.equal(add(1, 2), 3 + seed);']);
  assert.match(sdd(d, 'tdd', 'red', 'TEST-CALC-001').out, /\[weak\].*setup call "add"/);
  test(['  const r = call(1, 2);', '  assert.equal(r, 3);']);
  assert.doesNotMatch(sdd(d, 'tdd', 'red', 'TEST-CALC-001').out, /\[weak\]/);
});

test('#39/#40 gate --changed: root checks skip when only a nested project changed; shared paths are reachable through dependsOn', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-nest-'));
  const git = (...a) => spawnSync('git', a, { cwd: d });
  const w = (f, c) => { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), c); };
  git('init', '-q'); git('config', 'user.email', 'a@b'); git('config', 'user.name', 't');
  w('package.json', '{"name":"r","scripts":{"test":"true"}}');
  w('worker/pyproject.toml', '[project]\nname="w"\nversion="0"\n');
  w('worker/a.py', 'x = 1\n');
  w('contract/s.json', '[]\n');
  sdd(d, 'init');
  const cfgPath = path.join(d, '.sdd/config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  cfg.checks = [{ name: 'test', cmd: ['node', '-e', '0'], changedCmd: ['node', '-e', '0'] }];
  cfg.projects = [{ root: 'worker', checks: [{ name: 't', cmd: ['node', '-e', '0'], changedCmd: ['node', '-e', '0'] }] }];
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));
  git('add', '-A'); git('commit', '-qm', 'base');
  w('worker/a.py', 'x = 2\n');
  const a = sdd(d, 'gate', '--changed').out;
  assert.match(a, /cmd test: all changed files are inside nested projects/);
  assert.match(a, /✓ cmd worker:t/);
  git('commit', '-qam', 'a');
  w('contract/s.json', '["x"]\n');
  const b = sdd(d, 'gate', '--changed').out;
  assert.match(b, /✓ cmd test/);
  assert.match(b, /worker:t: no changed files/);
  assert.match(b, /add the path to its `dependsOn`/);
  cfg.projects[0].dependsOn = ['contract'];
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));
  const c = sdd(d, 'gate', '--changed').out;
  assert.match(c, /✓ cmd worker:t/);
  assert.doesNotMatch(c, /add the path to its `dependsOn`/);
});

test('#38 editing one test does not invalidate the Red/Green evidence of its siblings in the same file', () => {
  const d = project();
  fs.writeFileSync(path.join(d, '.sdd/specs/calc.md'), '---\nfeature: calc\ntier: T1\n---\n| REQ-CALC-001 | When add is called, the system shall sum. | TEST-CALC-001 |\n| REQ-CALC-002 | When add gets zero, the system shall return the other. | TEST-CALC-002 |\n');
  const tf = (second) => fs.writeFileSync(path.join(d, 'add.test.mjs'), [
    "import { test } from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { add } from './add.mjs';",
    '/** @id TEST-CALC-001 @verifies REQ-CALC-001 */',
    "test('TEST-CALC-001 adds', () => assert.equal(add(1, 2), 3));",
    '/** @id TEST-CALC-002 @verifies REQ-CALC-002 */',
    `test('TEST-CALC-002 zero', () => assert.equal(add(${second}), 5));`,
    '',
  ].join('\n'));
  sdd(d, 'init');
  tf('0, 5');
  fs.writeFileSync(path.join(d, 'add.mjs'), "export const add = () => { throw new Error('not implemented: add'); };\n");
  for (const id of ['TEST-CALC-001', 'TEST-CALC-002']) assert.equal(sdd(d, 'tdd', 'red', id).code, 0);
  impl(d, '(a, b) => a + b');
  for (const id of ['TEST-CALC-001', 'TEST-CALC-002']) assert.equal(sdd(d, 'tdd', 'green', id).code, 0);
  assert.match(sdd(d, 'gate', '--no-run').out, /2\/2 tests Red→Green/);
  tf('5, 0');
  const g = sdd(d, 'gate', '--no-run').out;
  assert.match(g, /1\/2 tests Red→Green/);
  assert.match(g, /TEST-CALC-002.*test changed/);
  assert.doesNotMatch(g, /TEST-CALC-001 \(/);
});

test('#43 a data-only test that passes without implementation needs --characterization to be recorded; it is counted as weak', () => {
  const d = project();
  sdd(d, 'init');
  sdd(d, 'approve', 'record', 'calc', '--by', 'tester');
  impl(d, '(a, b) => a + b');
  const r = sdd(d, 'tdd', 'red', 'TEST-CALC-001');
  assert.equal(r.code, 1);
  assert.match(r.out, /--characterization/);
  const c = sdd(d, 'tdd', 'red', 'TEST-CALC-001', '--characterization', 'checks a data file only');
  assert.equal(c.code, 0, c.out);
  assert.doesNotMatch(c.out, /\[weak\]/);
  assert.equal(sdd(d, 'tdd', 'green', 'TEST-CALC-001').code, 0);
  assert.match(sdd(d, 'gate', '--no-run').out, /, 1 characterization \(passed without a failing Red; not a weak Red\)/);
});

test('#44 weak-Red: result assigned from the stub and asserted is the act (not setup); pytest fixture error is weak with a real reason; Python class stubs construct', () => {
  const d = project();
  sdd(d, 'approve', 'record', 'calc', '--by', 'tester');
  fs.writeFileSync(path.join(d, 'add.mjs'), "export const add = () => { throw new Error('not implemented: add'); };\n");
  const test = (body) => fs.writeFileSync(path.join(d, 'add.test.mjs'), [
    "import { test } from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { add } from './add.mjs';",
    '/** @id TEST-CALC-001 @verifies REQ-CALC-001 */',
    "test('TEST-CALC-001 adds', () => {",
    ...body,
    '});',
    '',
  ].join('\n'));
  test(['  const r = add(1, 2);', '  assert.equal(r, 3);']);
  assert.doesNotMatch(sdd(d, 'tdd', 'red', 'TEST-CALC-001').out, /\[weak\]/);
  test(['  const r = add(1, 2);', '  assert.equal(String(r), "3");']);
  assert.doesNotMatch(sdd(d, 'tdd', 'red', 'TEST-CALC-001').out, /\[weak\]/);

  const p = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-pyfix-'));
  spawnSync('git', ['init', '-q'], { cwd: p });
  fs.mkdirSync(path.join(p, '.sdd/specs'), { recursive: true });
  fs.mkdirSync(path.join(p, 'tests'));
  fs.writeFileSync(path.join(p, '.sdd/specs/s.md'), '---\nfeature: s\ntier: T1\n---\n| REQ-S-001 | When f is called, the system shall return 1. | TEST-S-001 |\n');
  fs.writeFileSync(path.join(p, 'pyproject.toml'), '[project]\nname="x"\nversion="0"\n');
  fs.writeFileSync(path.join(p, 'tests/test_s.py'), [
    'import pytest',
    'from pkg.mod import Thing, f',
    '@pytest.fixture',
    'def thing():',
    '    return Thing()',
    '# @id TEST-S-001',
    '# @verifies REQ-S-001',
    'def test_s_001(thing):',
    '    assert f(thing) == 1',
    '',
  ].join('\n'));
  sdd(p, 'init');
  sdd(p, 'tdd', 'stub', 'TEST-S-001');
  assert.match(fs.readFileSync(path.join(p, 'pkg/mod.py'), 'utf8'), /class Thing:\n    def __init__\(self, \*a, \*\*k\):\n        pass/);
  const r = sdd(p, 'tdd', 'red', 'TEST-S-001');
  assert.doesNotMatch(r.out, /\[weak\]/, r.out);
  assert.match(r.out, /NotImplementedError: f/);
  fs.writeFileSync(path.join(p, 'pkg/mod.py'), 'class Thing:\n    def __init__(self):\n        raise NotImplementedError("Thing")\n\ndef f(t):\n    return 0\n');
  const w = sdd(p, 'tdd', 'red', 'TEST-S-001');
  assert.match(w.out, /\[weak\].*setup call "Thing"/, w.out);
  assert.doesNotMatch(w.out, /fails with: \[100%\]/);
});

test('#44b a stub call inside `with pytest.raises` is the asserted behaviour, not setup', () => {
  const p = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-pyraises-'));
  spawnSync('git', ['init', '-q'], { cwd: p });
  fs.mkdirSync(path.join(p, '.sdd/specs'), { recursive: true });
  fs.mkdirSync(path.join(p, 'tests'));
  fs.writeFileSync(path.join(p, '.sdd/specs/s.md'), '---\nfeature: s\ntier: T1\n---\n| REQ-S-001 | If x is negative, then f shall raise ValueError. | TEST-S-001 |\n');
  fs.writeFileSync(path.join(p, 'pyproject.toml'), '[project]\nname="x"\nversion="0"\n');
  fs.writeFileSync(path.join(p, 'tests/test_s.py'), 'import pytest\nfrom pkg.mod import f\n# @id TEST-S-001\n# @verifies REQ-S-001\ndef test_s_001():\n    with pytest.raises(ValueError):\n        f(-1)\n');
  sdd(p, 'init');
  sdd(p, 'tdd', 'stub', 'TEST-S-001');
  const r = sdd(p, 'tdd', 'red', 'TEST-S-001');
  assert.match(r.out, /RED ok/, r.out);
  assert.doesNotMatch(r.out, /\[weak\]/, r.out);
});

test('#45 Python docstring annotations (one-line and multi-line triple-quoted) are scanned', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-pydoc-'));
  spawnSync('git', ['init', '-q'], { cwd: d });
  fs.mkdirSync(path.join(d, '.sdd/specs'), { recursive: true });
  fs.writeFileSync(path.join(d, '.sdd/specs/s.md'), '---\nfeature: s\ntier: T1\n---\n| REQ-S-001 | When f is called, the system shall return 1. | TEST-S-001 |\n| REQ-S-002 | When g is called, the system shall return 2. | TEST-S-001 |\n');
  fs.writeFileSync(path.join(d, 'm.py'), '"""@id CODE-S-001 @implements REQ-S-001"""\n\ndef f():\n    return 1\n\n\ndef g():\n    """\n    @id CODE-S-002\n    @implements REQ-S-002\n    """\n    return 2\n');
  const r = sdd(d, 'trace');
  assert.match(r.out, /\b2 annotated entities/, r.out);
  assert.doesNotMatch(r.out, /REQ-S-00[12] has no @implements/, r.out);
});

test('#46 gate --changed: a scoped run that matched no tests falls back to the full check (no false PASS)', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-zero-'));
  const git = (...a) => spawnSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=t', ...a], { cwd: d });
  git('init', '-q');
  fs.mkdirSync(path.join(d, '.sdd/specs'), { recursive: true });
  fs.writeFileSync(path.join(d, 'data.json'), '[1]\n');
  fs.writeFileSync(path.join(d, '.sdd/config.json'), JSON.stringify({ checks: [{ name: 'test', cmd: ['node', '-e', 'console.log("1 failed"); process.exit(1)'], changedCmd: ['node', '-e', 'console.log("No test files found, exiting with code 0")', '{changedFiles}'] }] }));
  git('add', '-A'); git('commit', '-qm', 'base');
  fs.writeFileSync(path.join(d, 'data.json'), '[2]\n');
  const r = sdd(d, 'gate', '--changed').out;
  assert.match(r, /scoped run matched no tests — running the full check instead/);
  assert.match(r, /✗ cmd test/);
});

test('#47 a REQ marked "test-only" is not warned about missing @implements', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-testonly-'));
  spawnSync('git', ['init', '-q'], { cwd: d });
  fs.mkdirSync(path.join(d, '.sdd/specs'), { recursive: true });
  fs.writeFileSync(path.join(d, '.sdd/specs/s.md'), '---\nfeature: s\ntier: T1\n---\n| REQ-S-001 | Golden file matches. (test-only) | TEST-S-001 |\n| REQ-S-002 | f returns 1. | TEST-S-002 |\n');
  fs.writeFileSync(path.join(d, 't.test.js'), '// @id TEST-S-001 @verifies REQ-S-001\n// @id TEST-S-002 @verifies REQ-S-002\n');
  const r = sdd(d, 'trace').out;
  assert.doesNotMatch(r, /REQ-S-001 has no @implements/, r);
  assert.match(r, /REQ-S-002 has no @implements/, r);
});

test('#48 tdd stub for Python does not stub installed third-party packages (user site / PYTHONPATH) or their submodules', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-pysite-'));
  spawnSync('git', ['init', '-q'], { cwd: d });
  fs.mkdirSync(path.join(d, '.sdd/specs'), { recursive: true });
  fs.mkdirSync(path.join(d, 'tests'));
  const site = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-site-'));
  fs.mkdirSync(path.join(site, 'thirdpkg_zz'));
  fs.writeFileSync(path.join(site, 'thirdpkg_zz/__init__.py'), '');
  fs.writeFileSync(path.join(site, 'thirdpkg_zz/sub.py'), 'X = 1\n');
  fs.writeFileSync(path.join(d, 'tests/test_s.py'), '# @id TEST-S-001\n# @verifies REQ-S-001\nfrom thirdpkg_zz.sub import X\nfrom jobx.mod import f\ndef test_s_001():\n    assert f(X) == 1\n');
  sdd(d, 'init');
  spawnSync('node', [SDD, '--root', d, 'tdd', 'stub', 'TEST-S-001'], { encoding: 'utf8', env: { ...ENV, PYTHONPATH: site } });
  assert.ok(!fs.existsSync(path.join(d, 'thirdpkg_zz')));
  assert.ok(fs.existsSync(path.join(d, 'jobx/mod.py')));
});

test('#49 Python stub: exception classes derive from Exception; stub-only modules get newly imported names', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-pyexc-'));
  spawnSync('git', ['init', '-q'], { cwd: d });
  fs.mkdirSync(path.join(d, '.sdd/specs'), { recursive: true });
  fs.mkdirSync(path.join(d, 'tests'));
  fs.writeFileSync(path.join(d, 'tests/test_s.py'), '# @id TEST-S-001\n# @verifies REQ-S-001\nimport pytest\nfrom pk.errors import Boom\ndef test_s_001():\n    with pytest.raises(Boom):\n        pass\n\n# @id TEST-S-002\n# @verifies REQ-S-001\ndef test_s_002():\n    from pk.errors import Other\n    assert Other\n');
  sdd(d, 'init');
  sdd(d, 'tdd', 'stub', 'TEST-S-001');
  const f = path.join(d, 'pk/errors.py');
  assert.match(fs.readFileSync(f, 'utf8'), /class Boom\(Exception\)/);
  sdd(d, 'tdd', 'stub', 'TEST-S-002');
  assert.match(fs.readFileSync(f, 'utf8'), /class Boom\(Exception\)[\s\S]*class Other/);
  fs.appendFileSync(f, '\nREAL = 1\n');
  fs.writeFileSync(path.join(d, 'tests/test_s.py'), fs.readFileSync(path.join(d, 'tests/test_s.py'), 'utf8') + '\nfrom pk.errors import Third\n');
  sdd(d, 'tdd', 'stub', 'TEST-S-002');
  assert.doesNotMatch(fs.readFileSync(f, 'utf8'), /Third/);
});

test('#50 Rust: type stubs, panic message as Red reason, asserted result of a stub call is not weak', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-rust-'));
  spawnSync('git', ['init', '-q'], { cwd: d });
  fs.mkdirSync(path.join(d, '.sdd/specs'), { recursive: true });
  fs.mkdirSync(path.join(d, 'src')); fs.mkdirSync(path.join(d, 'tests'));
  fs.writeFileSync(path.join(d, '.sdd/specs/s.md'), '---\nfeature: s\ntier: T1\n---\n| REQ-S-001 | When count is called, it shall count. | TEST-S-001 |\n');
  fs.writeFileSync(path.join(d, 'Cargo.toml'), '[package]\nname = "lp"\nversion = "0.1.0"\nedition = "2021"\n');
  fs.writeFileSync(path.join(d, 'src/lib.rs'), '#[derive(Debug, PartialEq)]\npub struct S { pub n: usize }\npub fn count(_l: &[&str]) -> S { unimplemented!("count") }\n');
  fs.writeFileSync(path.join(d, 'tests/t.rs'), 'use lp::count;\n\n// @id TEST-S-001 @verifies REQ-S-001\n#[test]\nfn test_s_001() {\n    let s = count(&["a"]);\n    assert_eq!(s.n, 1);\n}\n');
  sdd(d, 'init');
  const r = sdd(d, 'tdd', 'red', 'TEST-S-001').out;
  assert.match(r, /fails with: not implemented: count/, r);
  assert.doesNotMatch(r, /\[weak\]/, r);
});

test('#50 Rust tdd stub: capitalised imports become types (enum for Name::Variant), not functions', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-rusttype-'));
  spawnSync('git', ['init', '-q'], { cwd: d });
  fs.mkdirSync(path.join(d, '.sdd/specs'), { recursive: true });
  fs.mkdirSync(path.join(d, 'tests'));
  fs.writeFileSync(path.join(d, 'Cargo.toml'), '[package]\nname = "lp"\nversion = "0.1.0"\nedition = "2021"\n');
  fs.writeFileSync(path.join(d, 'tests/t.rs'), 'use lp::{parse, Level};\n\n// @id TEST-S-001 @verifies REQ-S-001\n#[test]\nfn test_s_001() {\n    assert_eq!(parse("x"), Level::Warn);\n}\n');
  sdd(d, 'init');
  sdd(d, 'tdd', 'stub', 'TEST-S-001');
  const lib = fs.readFileSync(path.join(d, 'src/lib.rs'), 'utf8');
  assert.match(lib, /pub enum Level \{\s*Warn,/);
  assert.doesNotMatch(lib, /pub fn Level/);
});

test('#52 framework build output (.mastra, .next, …) is not scanned for @id (no duplicate-@id errors)', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-build-'));
  spawnSync('git', ['init', '-q'], { cwd: d });
  fs.mkdirSync(path.join(d, '.sdd/specs'), { recursive: true });
  fs.mkdirSync(path.join(d, '.mastra/output'), { recursive: true });
  fs.writeFileSync(path.join(d, '.sdd/specs/s.md'), '---\nfeature: s\ntier: T1\n---\n| REQ-S-001 | f shall return 1. | TEST-S-001 |\n');
  const code = '// @id CODE-S-001 @implements REQ-S-001\nexport const f = () => 1;\n';
  fs.writeFileSync(path.join(d, 'f.mjs'), code);
  fs.writeFileSync(path.join(d, '.mastra/output/f.mjs'), code);
  assert.doesNotMatch(sdd(d, 'trace').out, /duplicate @id/);
});

test('T2 spec without a ## Design section cannot be locked and fails guard/gate', () => {
  const d = project();
  const sp = path.join(d, '.sdd/specs/calc.md');
  fs.writeFileSync(sp, fs.readFileSync(sp, 'utf8').replace(/## Design[\s\S]*?\n\n/, ''));
  const a = sdd(d, 'approve', 'record', 'calc', '--by', 'nahisaho');
  assert.equal(a.code, 1);
  assert.match(a.out, /needs a "## Design"/);
  assert.match(sdd(d, 'guard').out, /GUARD FAIL/);
  assert.match(sdd(d, 'gate', '--no-run').out, /design calc: missing/);
});

test('plan: orders features, flags bad dependencies, and names the next feature', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-plan-'));
  spawnSync('git', ['init', '-q'], { cwd: d });
  fs.mkdirSync(path.join(d, '.sdd/specs'), { recursive: true });
  fs.writeFileSync(path.join(d, '.sdd/specs/a.md'), '---\nfeature: a\ntier: T1\n---\n| REQ-A-001 | f shall return 1. | TEST-A-001 |\n');
  const plan = (rows) => fs.writeFileSync(path.join(d, '.sdd/plan.md'), `| order | feature | depends | note |\n|---|---|---|---|\n${rows}\n`);
  plan('| 1 | a | - | core |\n| 2 | b | a | later |');
  let r = sdd(d, 'plan');
  assert.equal(r.code, 0);
  assert.match(r.out, /next: a/);
  plan('| 1 | a | b | x |\n| 2 | b | a | y |\n| 3 | c | zzz | z |');
  r = sdd(d, 'plan');
  assert.equal(r.code, 1);
  assert.match(r.out, /dependency b is ordered after/);
  assert.match(r.out, /unknown dependency zzz/);
});

test('changing a REQ line stales its tests until tdd refactor/red re-verifies; other REQ edits do not', () => {
  const d = project();
  const sp = path.join(d, '.sdd/specs/calc.md');
  sdd(d, 'init');
  sdd(d, 'approve', 'record', 'calc', '--by', 'nahisaho');
  impl(d, '(a, b) => a - b');
  assert.equal(sdd(d, 'tdd', 'red', 'TEST-CALC-001').code, 0);
  impl(d, '(a, b) => a + b');
  assert.equal(sdd(d, 'tdd', 'green', 'TEST-CALC-001').code, 0);
  assert.match(sdd(d, 'gate', '--no-run').out, /1\/1 tests Red→Green/);
  fs.appendFileSync(sp, '\nnotes outside any REQ line\n');
  sdd(d, 'approve', 'record', 'calc', '--by', 'nahisaho');
  assert.match(sdd(d, 'gate', '--no-run').out, /1\/1 tests Red→Green/);
  fs.writeFileSync(sp, fs.readFileSync(sp, 'utf8').replace('shall sum.', 'shall return the sum of both numbers.'));
  sdd(d, 'approve', 'record', 'calc', '--by', 'nahisaho');
  const g = sdd(d, 'gate', '--no-run');
  assert.match(g.out, /REQ-CALC-001 changed in the spec/);
  assert.equal(sdd(d, 'tdd', 'refactor', 'TEST-CALC-001').code, 0);
  assert.match(sdd(d, 'gate', '--no-run').out, /1\/1 tests Red→Green/);
});

test('plan: a feature is not done while a REQ has no test or its T2 lock is stale', () => {
  const d = project();
  sdd(d, 'init');
  fs.writeFileSync(path.join(d, '.sdd/plan.md'), '| order | feature | depends | note |\n|---|---|---|---|\n| 1 | calc | - | x |\n');
  sdd(d, 'approve', 'record', 'calc', '--by', 'nahisaho');
  impl(d, '(a, b) => a - b');
  sdd(d, 'tdd', 'red', 'TEST-CALC-001');
  impl(d, '(a, b) => a + b');
  sdd(d, 'tdd', 'green', 'TEST-CALC-001');
  assert.match(sdd(d, 'plan').out, /next: \(all features done\)/);
  const sp = path.join(d, '.sdd/specs/calc.md');
  fs.appendFileSync(sp, '| REQ-CALC-002 | When sub is called, the system shall subtract. | TEST-CALC-002 |\n');
  const r = sdd(d, 'plan').out;
  assert.match(r, /next: calc/);
  assert.match(r, /· 1\. calc \[T2:stale\]/);
});

test('appending a new test after the last one keeps the previous last test evidence (describe closer is not part of the test)', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-append-'));
  spawnSync('git', ['init', '-q'], { cwd: d });
  fs.mkdirSync(path.join(d, '.sdd/specs'), { recursive: true });
  fs.writeFileSync(path.join(d, '.sdd/specs/c.md'), '---\nfeature: c\ntier: T1\n---\n| REQ-C-001 | f shall return 1. | TEST-C-001 |\n| REQ-C-002 | g shall return 2. | TEST-C-002 |\n');
  fs.writeFileSync(path.join(d, 'f.mjs'), '// @id CODE-C-001 @implements REQ-C-001 REQ-C-002\nexport const f = () => 1;\nexport const g = () => 2;\n');
  const head = "import { describe, test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { f, g } from './f.mjs';\ndescribe('c', () => {\n";
  const t1 = "  // @id TEST-C-001 @verifies REQ-C-001\n  test('TEST-C-001 f', () => {\n    assert.equal(f(), 1);\n  });\n";
  const t2 = "\n  // @id TEST-C-002 @verifies REQ-C-002\n  test('TEST-C-002 g', () => {\n    assert.equal(g(), 2);\n  });\n";
  fs.writeFileSync(path.join(d, 'c.test.mjs'), head + t1 + '});\n');
  sdd(d, 'init');
  assert.equal(sdd(d, 'tdd', 'red', 'TEST-C-001', '--characterization', 'impl exists').code, 0);
  assert.equal(sdd(d, 'tdd', 'green', 'TEST-C-001').code, 0);
  fs.writeFileSync(path.join(d, 'c.test.mjs'), head + t1 + t2 + '});\n');
  const g = sdd(d, 'gate', '--no-run').out;
  assert.match(g, /TEST-C-002 \(REQ-C-002\): no Green recorded/);
  assert.doesNotMatch(g, /TEST-C-001 .*changed/);
});

test('#55 adding a name to an import list keeps sibling evidence; changing the import module does not', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-imp-'));
  spawnSync('git', ['init', '-q'], { cwd: d });
  fs.mkdirSync(path.join(d, '.sdd/specs'), { recursive: true });
  fs.writeFileSync(path.join(d, '.sdd/specs/c.md'), '---\nfeature: c\ntier: T1\n---\n| REQ-C-001 | f shall return 1. | TEST-C-001 |\n| REQ-C-002 | g shall return 2. | TEST-C-002 |\n');
  fs.writeFileSync(path.join(d, 'f.mjs'), '// @id CODE-C-001 @implements REQ-C-001 REQ-C-002\nexport const f = () => 1;\nexport const g = () => 2;\n');
  fs.writeFileSync(path.join(d, 'other.mjs'), 'export const f = () => 1;\n');
  const head = (names, mod = './f.mjs') => `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { ${names} } from '${mod}';\n`;
  const t1 = "// @id TEST-C-001 @verifies REQ-C-001\ntest('TEST-C-001 f', () => assert.equal(f(), 1));\n";
  const t2 = "// @id TEST-C-002 @verifies REQ-C-002\ntest('TEST-C-002 g', () => assert.equal(g(), 2));\n";
  const file = path.join(d, 'c.test.mjs');
  fs.writeFileSync(file, head('f') + t1);
  sdd(d, 'init');
  assert.equal(sdd(d, 'tdd', 'red', 'TEST-C-001', '--characterization', 'impl exists').code, 0);
  assert.equal(sdd(d, 'tdd', 'green', 'TEST-C-001').code, 0);
  fs.writeFileSync(file, head('f, g') + t1 + t2);
  assert.doesNotMatch(sdd(d, 'gate', '--no-run').out, /TEST-C-001 .*changed/);
  fs.writeFileSync(file, head('f, g', './other.mjs') + t1 + t2);
  assert.match(sdd(d, 'gate', '--no-run').out, /TEST-C-001 .*changed/);
});

// ---- 2nd dogfood round (#56-#68) ----
function mini(spec, files = {}, cmd = null) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-m-'));
  spawnSync('git', ['init', '-q'], { cwd: d });
  fs.mkdirSync(path.join(d, '.sdd/specs'), { recursive: true });
  for (const [f, body] of Object.entries({ '.sdd/specs/a.md': spec, 'package.json': '{}', ...files })) { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), body); }
  sdd(d, 'init');
  if (cmd) { const cp = path.join(d, '.sdd/config.json'); const c = JSON.parse(fs.readFileSync(cp, 'utf8')); c.testCmd = cmd; fs.writeFileSync(cp, JSON.stringify(c)); }
  return d;
}
const PASS = ['node', '-e', '0'];
const FAIL = ['node', '-e', 'console.log("AssertionError: boom");process.exit(1)'];
const setCmd = (d, cmd) => { const cp = path.join(d, '.sdd/config.json'); const c = JSON.parse(fs.readFileSync(cp, 'utf8')); c.testCmd = cmd; fs.writeFileSync(cp, JSON.stringify(c)); };

/** @id TEST-NODE-SUMMARY-001 @verifies REQ-NODE-SUMMARY-001 */
test('TEST-NODE-SUMMARY-001 executed Node failures are not no-test incompleteness', () => {
  for (const reporter of ['spec', 'tap']) {
    const d = mini('---\nfeature: a\ntier: T1\n---\n| REQ-A-001 | answer shall be one. | TEST-A-001 |\n', {
      'answer.mjs': '/** @id CODE-A-001 @implements REQ-A-001 */\nexport const answer = () => 0;\n',
      'a.test.mjs': [
        "import { test } from 'node:test';",
        "import assert from 'node:assert/strict';",
        "import { answer } from './answer.mjs';",
        "if (process.env.SDD_SUMMARY_CASE !== 'empty') {",
        '/** @id TEST-A-001 @verifies REQ-A-001 */',
        "test('TEST-A-001 target', { skip: process.env.SDD_SUMMARY_CASE === 'skip' }, () => { assert.equal(answer(), 1); assert.notEqual(process.env.SDD_SUMMARY_CASE, 'allfail', 'owned assertion failure'); });",
        "test('no tests found', { skip: process.env.SDD_SUMMARY_CASE === 'skip' }, () => assert.ok(!['mixed', 'allfail'].includes(process.env.SDD_SUMMARY_CASE), 'executed assertion failure'));",
        '}',
        '',
      ].join('\n'),
    });
    const cmd = ['node', '--test', `--test-reporter=${reporter}`];
    fs.writeFileSync(path.join(d, '.sdd/config.json'), JSON.stringify({
      testCmd: [...cmd, '--test-name-pattern', '{id}', '{file}'],
      checks: [{ name: 'test', cmd: [...cmd, 'a.test.mjs'] }],
    }));
    const red = sdd(d, 'tdd', 'red', 'TEST-A-001');
    assert.equal(red.code, 0, red.out);
    fs.writeFileSync(path.join(d, 'answer.mjs'), '/** @id CODE-A-001 @implements REQ-A-001 */\nexport const answer = () => 1;\n');
    const green = sdd(d, 'tdd', 'green', 'TEST-A-001');
    assert.equal(green.code, 0, green.out);
    for (const [mode, expected] of [['pass', 0], ['mixed', 1], ['allfail', 1], ['skip', 2], ['empty', 1]]) {
      const r = spawnSync('node', [SDD, '--root', d, 'gate'], {
        encoding: 'utf8', env: { ...ENV, SDD_SUMMARY_CASE: mode },
      });
      const text = r.stdout + r.stderr;
      assert.equal(r.status, expected, `${reporter}/${mode}: gate exit ${r.status}`);
      if (mode === 'empty') assert.match(text, /missing executed Node test ids/);
      else if (expected !== 2) {
        assert.match(text, expected === 0 ? /✓ cmd test \(/ : /✗ cmd test \(/);
        assert.doesNotMatch(text, /no tests exist yet/);
      } else assert.match(text, /INCOMPLETE/);
    }
  }
});

test('#56 every @verifies REQ is hash-tracked, not only the first', () => {
  const spec = (w) => `---\nfeature: a\ntier: T1\n---\n| REQ-A-001 | one shall hold. | TEST-A-001 |\n| REQ-A-002 | two ${w} hold. | TEST-A-001 |\n`;
  const d = mini(spec('shall'), { 'a.test.mjs': '// @id TEST-A-001 @verifies REQ-A-001 REQ-A-002\n// test body\n' }, FAIL);
  assert.equal(sdd(d, 'tdd', 'red', 'TEST-A-001').code, 0);
  setCmd(d, PASS);
  assert.equal(sdd(d, 'tdd', 'green', 'TEST-A-001').code, 0);
  assert.match(sdd(d, 'gate', '--no-run').out, /1\/1 tests Red→Green/);
  fs.writeFileSync(path.join(d, '.sdd/specs/a.md'), spec('must not'));
  assert.match(sdd(d, 'gate', '--no-run').out, /REQ-A-002 changed in the spec/);
});

test('#57 approver name is normalized: whitespace/empty/ai variants cannot satisfy approval: human', () => {
  const d = mini('---\nfeature: a\ntier: T1\napproval: human\n---\n| REQ-A-001 | x shall hold. | TEST-A-001 |\n');
  for (const by of [' ai:duck', 'ai :duck', 'ai:duck ', '', ' ', 'ai', 'ａｉ:duck']) assert.notEqual(sdd(d, 'approve', 'record', 'a', '--by', by, '--review', 'ok').code, 0, JSON.stringify(by));
  assert.equal(sdd(d, 'approve', 'record', 'a', '--by', 'Alice').code, 0);
  const d2 = mini('---\nfeature: a\ntier: T1\n---\n| REQ-A-001 | x shall hold. | TEST-A-001 |\n');
  assert.notEqual(sdd(d2, 'approve', 'record', 'a', '--by', 'ai:self ', '--review', 'ok').code, 0);
});

test('#58 deferred/test-only only count as delimited markers, not prose words', () => {
  const d = mini('---\nfeature: a\ntier: T1\n---\n| REQ-A-001 | The system shall retry deferred jobs. | TEST-A-001 |\n| REQ-A-002 (deferred) | Later. | — |\n');
  const t = sdd(d, 'trace').out;
  assert.match(t, /REQ-A-001 has no test/);
  assert.doesNotMatch(t, /REQ-A-002 has no test/);
});

test('#59 frontmatter: trailing comments, quotes and CRLF do not downgrade T2 / approval: human', () => {
  for (const fm of ['tier: T2   # security', 'tier: "T2"', 'tier: t2']) {
    const d = mini(`---\nfeature: a\n${fm}\n---\n| REQ-A-001 | x shall hold. | TEST-A-001 |\n`);
    assert.match(sdd(d, 'guard').out, /Design|T2/i, fm);
    assert.notEqual(sdd(d, 'guard').code, 0, fm);
  }
  const crlf = mini('---\r\nfeature: a\r\ntier: T1\r\napproval: human   # destructive\r\n---\r\n| REQ-A-001 | x shall hold. | TEST-A-001 |\r\n');
  assert.notEqual(sdd(crlf, 'approve', 'record', 'a', '--by', 'ai:duck', '--review', 'ok').code, 0);
});

test('#60 gate/trace --changed: untracked dirs and file-less trace errors are not hidden', () => {
  const d = mini('---\nfeature: a\ntier: T1\n---\n| REQ-A-001 | x shall hold. | TEST-A-001 |\n');
  spawnSync('git', ['add', '-A'], { cwd: d });
  spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'i'], { cwd: d });
  fs.appendFileSync(path.join(d, '.sdd/specs/a.md'), '| REQ-A-002 | y shall hold. | TEST-A-002 |\n');
  const tr = sdd(d, 'trace', '--changed');
  assert.notEqual(tr.code, 0);
  assert.match(tr.out, /REQ-A-00[12] has no test/);
  fs.mkdirSync(path.join(d, 'newdir'));
  fs.writeFileSync(path.join(d, 'newdir/a.test.mjs'), '// @id TEST-A-001 @verifies REQ-A-001\n');
  const g = sdd(d, 'gate', '--changed', '--no-run');
  assert.match(g.out, /TEST-A-001 .*no Green recorded/);
});

test('#61 plan warns about specs missing from plan.md instead of "all features done"', () => {
  const d = mini('---\nfeature: a\ntier: T1\n---\n| REQ-A-001 | x shall hold. | TEST-A-001 |\n', { '.sdd/specs/b.md': '---\nfeature: b\ntier: T1\n---\n| REQ-B-001 | y shall hold. | TEST-B-001 |\n', '.sdd/plan.md': '| order | feature | depends | note |\n|---|---|---|---|\n| 1 | a | | |\n' });
  const o = sdd(d, 'plan').out;
  assert.match(o, /b: spec is not in plan\.md/);
  assert.doesNotMatch(o, /all features done/);
});

test('#62 green/refactor refuse a run where everything was skipped (vitest/jest summary)', () => {
  const d = mini('---\nfeature: a\ntier: T1\n---\n| REQ-A-001 | x shall hold. | TEST-A-001 |\n', { 'a.test.mjs': '// @id TEST-A-001 @verifies REQ-A-001\n' }, FAIL);
  assert.equal(sdd(d, 'tdd', 'red', 'TEST-A-001').code, 0);
  setCmd(d, ['node', '-e', 'console.log(" Test Files  1 passed (1)\\n      Tests  1 skipped (1)")']);
  assert.match(sdd(d, 'tdd', 'green', 'TEST-A-001').out, /REJECTED/);
});

test('#63 approval: human on a T1 spec still needs a lock', () => {
  const d = mini('---\nfeature: a\ntier: T1\napproval: human\n---\n| REQ-A-001 | x shall hold. | TEST-A-001 |\n', { 'a.test.mjs': '// @id TEST-A-001 @verifies REQ-A-001\n' }, FAIL);
  assert.match(sdd(d, 'tdd', 'red', 'TEST-A-001').out, /REFUSED/);
  assert.match(sdd(d, 'gate', '--no-run').out, /✗ lock a: missing/);
  assert.equal(sdd(d, 'approve', 'record', 'a', '--by', 'Alice').code, 0);
  assert.equal(sdd(d, 'tdd', 'red', 'TEST-A-001').code, 0);
});

test('#64 ts-jest compile errors are a load error, not a Red', () => {
  const d = mini('---\nfeature: a\ntier: T1\n---\n| REQ-A-001 | x shall hold. | TEST-A-001 |\n', { 'a.test.mjs': '// @id TEST-A-001 @verifies REQ-A-001\n' },
    ['node', '-e', 'console.log("FAIL tests/m.test.ts\\n  Test suite failed to run\\n    error TS2305: Module has no exported member add");process.exit(1)']);
  assert.match(sdd(d, 'tdd', 'red', 'TEST-A-001').out, /REJECTED.*load\/compile/);
});

test('#65 prose lines are not REQs; continuation lines of a bullet REQ are hashed', () => {
  const spec = (tail) => `---\nfeature: a\ntier: T1\n---\n- REQ-A-001 When add is called,\n  the system shall return ${tail}.\n\n## Assumptions\nREQ-A-001 was spiked on 2026-01-01.\n`;
  const d = mini(spec('a+b'), { 'a.test.mjs': '// @id TEST-A-001 @verifies REQ-A-001\n' }, FAIL);
  assert.doesNotMatch(sdd(d, 'trace').out, /duplicate REQ/);
  assert.equal(sdd(d, 'tdd', 'red', 'TEST-A-001').code, 0);
  setCmd(d, PASS);
  assert.equal(sdd(d, 'tdd', 'green', 'TEST-A-001').code, 0);
  fs.writeFileSync(path.join(d, '.sdd/specs/a.md'), spec('a-b'));
  assert.match(sdd(d, 'gate', '--no-run').out, /REQ-A-001 changed in the spec/);
});

test('#66 preamble edits are detected even when a comment mentions @implements; python docstring @id scopes def lines', () => {
  const spec = '---\nfeature: a\ntier: T1\n---\n| REQ-A-001 | x shall hold. | TEST-A-001 |\n| REQ-A-002 | y shall hold. | TEST-A-002 |\n';
  const d = mini(spec, { 'a.test.mjs': 'const base = () => 1;\n// @id TEST-A-001 @verifies REQ-A-001\n// t1\n// @id TEST-A-002 @verifies REQ-A-002\n// t2\n// note: @implements lives in lib.mjs\n' }, FAIL);
  for (const id of ['TEST-A-001', 'TEST-A-002']) assert.equal(sdd(d, 'tdd', 'red', id).code, 0);
  setCmd(d, PASS);
  for (const id of ['TEST-A-001', 'TEST-A-002']) assert.equal(sdd(d, 'tdd', 'green', id).code, 0);
  fs.writeFileSync(path.join(d, 'a.test.mjs'), fs.readFileSync(path.join(d, 'a.test.mjs'), 'utf8').replace('=> 1', '=> 2'));
  assert.match(sdd(d, 'gate', '--no-run').out, /test changed/);

  const py = (extra) => `import pytest\n\ndef test_a_001():\n    """@id TEST-A-001 @verifies REQ-A-001"""\n    assert 1\n\ndef test_a_002():\n    """@id TEST-A-002 @verifies REQ-A-002"""\n    assert 2\n${extra}`;
  const d2 = mini(spec, { 't_test.py': py('') }, FAIL);
  fs.renameSync(path.join(d2, 't_test.py'), path.join(d2, 'test_t.py'));
  for (const id of ['TEST-A-001', 'TEST-A-002']) assert.equal(sdd(d2, 'tdd', 'red', id).code, 0);
  setCmd(d2, PASS);
  for (const id of ['TEST-A-001', 'TEST-A-002']) assert.equal(sdd(d2, 'tdd', 'green', id).code, 0);
  fs.appendFileSync(path.join(d2, 'test_t.py'), '\n@pytest.mark.skip\ndef test_a_003():\n    """@id TEST-A-003 @verifies REQ-A-002"""\n    assert 3\n');
  const g = sdd(d2, 'gate', '--no-run').out;
  assert.doesNotMatch(g, /TEST-A-002 .*changed/);
  fs.writeFileSync(path.join(d2, 'test_t.py'), fs.readFileSync(path.join(d2, 'test_t.py'), 'utf8').replace('assert 1', 'assert 11'));
  const g2 = sdd(d2, 'gate', '--no-run').out;
  assert.match(g2, /TEST-A-001 .*changed/);
  assert.doesNotMatch(g2, /TEST-A-002 .*changed/);
});

test('#67 polyglot: dependsOn may be a file; root-owned change hint shows without root checks', () => {
  const d = mini('---\nfeature: a\ntier: T1\n---\n| REQ-A-001 | x shall hold. | TEST-A-001 |\n', { 'svc/x.txt': 'x', 'contract/schema.json': '{}', 'README.md': 'r' });
  const cp = path.join(d, '.sdd/config.json');
  fs.writeFileSync(cp, JSON.stringify({ testCmd: PASS, checks: [], projects: [{ root: 'svc', testCmd: PASS, dependsOn: ['contract/schema.json'], checks: [{ name: 'ok', cmd: ['node', '-e', '0'] }] }] }));
  spawnSync('git', ['add', '-A'], { cwd: d });
  spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'i'], { cwd: d });
  fs.writeFileSync(path.join(d, 'contract/schema.json'), '{"a":1}');
  assert.match(sdd(d, 'gate', '--changed').out, /✓ cmd svc:ok/);
  spawnSync('git', ['checkout', 'contract/schema.json'], { cwd: d });
  fs.writeFileSync(path.join(d, 'README.md'), 'changed');
  assert.match(sdd(d, 'gate', '--changed').out, /root-owned data\/config changes: README\.md/);
});

test('#68 python tdd stub: src layout and multi-line imports', () => {
  const d = mini('---\nfeature: a\ntier: T1\n---\n| REQ-A-001 | x shall hold. | TEST-A-001 |\n', {
    'pyproject.toml': '[project]\nname="m"\nversion="0"\n',
    'src/pkg/__init__.py': '',
    'src/pkg/real.py': 'def ok():\n    return 1\n',
    'tests/test_a.py': 'from pkg.mod import (\n    alpha,\n    beta,\n)\nfrom pkg import real\n\ndef test_a_001():\n    """@id TEST-A-001 @verifies REQ-A-001"""\n    assert alpha() == 1\n',
  });
  sdd(d, 'tdd', 'stub', 'TEST-A-001');
  assert.ok(fs.existsSync(path.join(d, 'src/pkg/mod.py')), 'stub under src/');
  assert.ok(!fs.existsSync(path.join(d, 'pkg')), 'no stub at project root');
  const body = fs.readFileSync(path.join(d, 'src/pkg/mod.py'), 'utf8');
  assert.match(body, /def alpha/);
  assert.match(body, /def beta/);
});

test('#69 tdd stub: Rust module paths and Go types/methods/fields', { skip: ['go', 'cargo'].some((c) => spawnSync('which', [c]).status !== 0) }, () => {
  const mk = (files) => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-'));
    spawnSync('git', ['init', '-q'], { cwd: d });
    for (const [f, body] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), body); }
    return d;
  };
  const read = (d, f) => fs.readFileSync(path.join(d, f), 'utf8');
  const rs = mk({ 'Cargo.toml': '[package]\nname = "app04"\nversion = "0.1.0"\nedition = "2021"\n', 'tests/t.rs': 'use app04::lex::{tokenize, Tok};\nuse app04::types::check::{check, Ty};\n// @id TEST-R-001 @verifies REQ-R-001\n#[test]\nfn test_r_001() { assert_eq!(tokenize("x"), 3); let _t: Tok; assert_eq!(check(1), Ty::Int); }\n' });
  sdd(rs, 'tdd', 'stub', 'TEST-R-001');
  assert.match(read(rs, 'src/lib.rs'), /pub mod lex;\npub mod types;/);
  assert.doesNotMatch(read(rs, 'src/lib.rs'), /pub fn lex/);
  assert.match(read(rs, 'src/lex.rs'), /pub fn tokenize<A0>[\s\S]*pub struct Tok;/);
  assert.match(read(rs, 'src/types.rs'), /pub mod check;/);
  assert.match(read(rs, 'src/types/check.rs'), /pub fn check<A0>[\s\S]*pub enum Ty \{\n    Int,/);
  const go = mk({ 'go.mod': 'module m\n\ngo 1.21\n', 'm_test.go': 'package m\nimport "testing"\n// @id TEST-M-001 @verifies REQ-M-001\nfunc TestTEST_M_001(t *testing.T) {\n\to := NewOrder("x")\n\to.Add(Item{Name: "a", Qty: 2})\n\tif o.Total() != 3 { t.Fatal("x") }\n\tvar c Config\n\t_ = c\n\tif o.Count != 1 { t.Fatal("y") }\n}\n' });
  sdd(go, 'tdd', 'stub', 'TEST-M-001');
  const g = read(go, 'm.go');
  assert.match(g, /type Item struct/);
  assert.match(g, /func NewOrder\(a0 any\) \*Order/);
  assert.match(g, /func \(\*Order\) Add\(/);
  assert.match(g, /func \(\*Order\) Total\(\) int/);
  assert.equal(spawnSync('go', ['vet', './...'], { cwd: go }).status, 0);
});

// ---- dogfood round 3 (#70-#81) ----
const T1SPEC = '---\nfeature: a\ntier: T1\n---\n| REQ-A-001 | one shall hold. | TEST-A-001 |\n';
const T2SPEC = '---\nfeature: a\ntier: T2\napproval: human\n---\n## Design\nx\n\n| REQ-A-001 | one shall hold. | TEST-A-001 |\n';
const jsTest = (extra = '') => `// @id TEST-A-001 @verifies REQ-A-001\ntest('TEST-A-001 x', () => {\n  assert.ok(1);\n});\n${extra}`;
const specPath = (d) => path.join(d, '.sdd/specs/a.md');

test('#71 T2 downgrade / dropping approval: human is not silently accepted', () => {
  const d = mini(T2SPEC, { 'a.test.mjs': jsTest() }, PASS);
  assert.equal(sdd(d, 'approve', 'record', 'a', '--by', 'alice').code, 0);
  fs.writeFileSync(specPath(d), T2SPEC.replace('approval: human\n', ''));
  const g = sdd(d, 'gate', '--no-run');
  assert.match(g.out, /policy loosened|stale|human/i);
  assert.notEqual(sdd(d, 'approve', 'record', 'a', '--by', 'ai:reviewer', '--review', 'ok').code, 0, 'AI must not re-lock a loosened spec');
  fs.rmSync(specPath(d));
  assert.match(sdd(d, 'gate', '--no-run').out, /spec removed/);
  assert.equal(sdd(d, 'approve', 'retire', 'a', '--by', 'alice').code, 0);
  assert.doesNotMatch(sdd(d, 'gate', '--no-run').out, /spec removed/);
});

test('#72 BOM keeps T2; CRLF conversion does not stale the lock', () => {
  const d = mini(T2SPEC, { 'a.test.mjs': jsTest() }, PASS);
  assert.equal(sdd(d, 'approve', 'record', 'a', '--by', 'alice').code, 0);
  fs.writeFileSync(specPath(d), '\ufeff' + T2SPEC.replace(/\n/g, '\r\n'));
  const out = sdd(d, 'gate', '--no-run').out;
  assert.match(out, /lock a: ok/);
});

test('#73 appending after the last test keeps its evidence', () => {
  const d = mini(T1SPEC, { 'a.test.mjs': jsTest() }, FAIL);
  assert.equal(sdd(d, 'tdd', 'red', 'TEST-A-001').code, 0);
  setCmd(d, PASS);
  assert.equal(sdd(d, 'tdd', 'green', 'TEST-A-001').code, 0);
  fs.appendFileSync(path.join(d, 'a.test.mjs'), '\n// trailing note\nfunction main() { return 1; }\n');
  assert.match(sdd(d, 'gate', '--no-run').out, /1\/1 tests Red→Green/);
});

test('#75 vitest load failure is a load error; missing method is weak; npm noise dropped', () => {
  const d = mini(T1SPEC, { 'a.test.mjs': jsTest() }, ['node', '-e', 'console.log("Error: Failed to load url ./x (resolved id: ./x)");process.exit(1)']);
  assert.match(sdd(d, 'tdd', 'red', 'TEST-A-001').out, /REJECTED.*load\/compile/);
  setCmd(d, ['node', '-e', 'console.log("TypeError: x.run is not a function");process.exit(1)']);
  assert.match(sdd(d, 'tdd', 'red', 'TEST-A-001').out, /REJECTED|weak/i);
});

test('#77 plan: removed REQ means the feature is not done', () => {
  const d = mini(T1SPEC, { 'a.test.mjs': jsTest() }, FAIL);
  sdd(d, 'tdd', 'red', 'TEST-A-001'); setCmd(d, PASS); sdd(d, 'tdd', 'green', 'TEST-A-001');
  fs.writeFileSync(specPath(d), '---\nfeature: a\ntier: T1\n---\n| REQ-A-009 | other shall hold. | TEST-A-009 |\n');
  fs.writeFileSync(path.join(d, '.sdd/plan.md'), '| order | feature | depends | note |\n|---|---|---|---|\n| 1 | a | - | x |\n');
  assert.doesNotMatch(sdd(d, 'plan').out, /\bdone\b/i);
});

test('#78 full-width （deferred） and full-width digits in REQ IDs', () => {
  const d = mini('---\nfeature: a\ntier: T1\n---\n| REQ-A-001 | one shall hold. | TEST-A-001 |\n| REQ-A-００２ | two shall hold. （deferred） | - |\n', { 'a.test.mjs': jsTest() }, PASS);
  const out = sdd(d, 'trace').out;
  assert.match(out, /REQ-A-002|\+1 deferred|deferred/);
});

test('#79 ledger conflict markers give a clean message; merge-ledger repairs', () => {
  const d = mini(T1SPEC, { 'a.test.mjs': jsTest() }, FAIL);
  sdd(d, 'tdd', 'red', 'TEST-A-001');
  const f = path.join(d, '.sdd/tdd.jsonl');
  const body = fs.readFileSync(f, 'utf8');
  fs.writeFileSync(f, `<<<<<<< HEAD\n${body}=======\n${body}>>>>>>> other\n`);
  const r = sdd(d, 'tdd', 'check');
  assert.match(r.out, /LEDGER CONFLICT/);
  assert.doesNotMatch(r.out, /SyntaxError/);
  assert.equal(sdd(d, 'tdd', 'merge-ledger').code, 0);
  assert.doesNotMatch(sdd(d, 'tdd', 'check').out, /LEDGER (CONFLICT|CORRUPT)/);
});

test('#213 merge-ledger keeps the shared ledger prefix byte-identical', () => {
  const d = mini(T1SPEC, { 'a.test.mjs': jsTest() }, FAIL);
  sdd(d, 'tdd', 'red', 'TEST-A-001');
  const f = path.join(d, '.sdd/tdd.jsonl');
  const prefix = fs.readFileSync(f, 'utf8');
  sdd(d, 'tdd', 'red', 'TEST-A-001', '--weak');
  const next = fs.readFileSync(f, 'utf8').slice(prefix.length);
  assert.ok(next.trim(), 'second entry recorded');
  const other = next.replace(/"at":"[^"]*"/, '"at":"2999-01-01T00:00:00.000Z"');
  fs.writeFileSync(f, `${prefix}<<<<<<< HEAD\n${next}=======\n${other}>>>>>>> other\n`);
  assert.equal(sdd(d, 'tdd', 'merge-ledger').code, 0);
  assert.ok(fs.readFileSync(f, 'utf8').startsWith(prefix), 'shared prefix rewritten');
  assert.doesNotMatch(sdd(d, 'tdd', 'check').out, /LEDGER (CONFLICT|CORRUPT)|broken/);
});

test('#81 approve record refuses generic approver names for human approval', () => {
  const d = mini(T2SPEC, { 'a.test.mjs': jsTest() }, PASS);
  assert.notEqual(sdd(d, 'approve', 'record', 'a', '--by', 'bot').code, 0);
  assert.equal(sdd(d, 'approve', 'record', 'a', '--by', 'alice').code, 0);
});

test('#76 tdd stub: Java ctor/enum, C header under include/, Rust workspace member crate', () => {
  const mk = (files) => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-'));
    spawnSync('git', ['init', '-q'], { cwd: d });
    for (const [f, body] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), body); }
    return d;
  };
  const read = (d, f) => fs.readFileSync(path.join(d, f), 'utf8');
  const j = mk({ 'FooTest.java': 'import org.junit.jupiter.api.Test;\nclass FooTest {\n  // @id TEST-J-001 @verifies REQ-J-001\n  @Test void t() { Account a = new Account("x", 5); Kind k = Kind.DEBIT; Kind m = Kind.CREDIT; }\n}\n' });
  sdd(j, 'tdd', 'stub', 'TEST-J-001');
  assert.match(read(j, 'Account.java'), /public Account\(String a0, int a1\)/);
  assert.match(read(j, 'Kind.java'), /public enum Kind \{\n    DEBIT, CREDIT/);
  const c = mk({ 'include/.keep': '', 'tests/t.c': '#include "list.h"\n// @id TEST-C-001 @verifies REQ-C-001\nint main(void) { Node *n = list_new(3); return 0; }\n' });
  sdd(c, 'tdd', 'stub', 'TEST-C-001');
  assert.ok(fs.existsSync(path.join(c, 'include/list.h')), 'header goes to include/');
  assert.ok(!fs.existsSync(path.join(c, 'tests/list.h')), 'not shadowing in tests/');
  assert.match(read(c, 'include/list.h'), /void \* list_new/);
  const r = mk({ 'Cargo.toml': '[workspace]\nmembers = ["crates/core", "crates/app"]\n', 'crates/core/Cargo.toml': '[package]\nname = "core-lib"\nversion = "0.1.0"\nedition = "2021"\n', 'crates/core/src/lib.rs': '', 'crates/app/Cargo.toml': '[package]\nname = "app"\nversion = "0.1.0"\nedition = "2021"\n', 'crates/app/src/lib.rs': '', 'crates/app/tests/t.rs': 'use core_lib::shapes::{area, Shape};\n// @id TEST-R-001 @verifies REQ-R-001\n#[test]\nfn t() { assert_eq!(area(Shape), 3); }\n' });
  sdd(r, 'tdd', 'stub', 'TEST-R-001');
  assert.match(read(r, 'crates/core/src/lib.rs'), /pub mod shapes;/);
  assert.match(read(r, 'crates/core/src/shapes.rs'), /pub fn area/);
  assert.equal(read(r, 'crates/app/src/lib.rs'), '');
});

// ---- dogfood round 4 (#82-#89) ----
test('#82 guard/plan/status report orphan annotations; stub refuses unknown REQ; spec conflict markers flagged', () => {
  const d = mini(T1SPEC, { 'a.test.mjs': jsTest(), 'b.test.mjs': "// @id TEST-B-001 @verifies REQ-B-001\ntest('TEST-B-001 x', () => {\n});\n" }, PASS);
  fs.writeFileSync(path.join(d, '.sdd/plan.md'), '| order | feature | depends | note |\n|---|---|---|---|\n| 1 | a | - | x |\n');
  const g = sdd(d, 'guard');
  assert.notEqual(g.code, 0);
  assert.match(g.out, /unknown REQ-B-001/);
  assert.match(sdd(d, 'plan').out, /REQ-B-001 is referenced/);
  assert.match(sdd(d, 'status').out, /ORPHAN refs 1/);
  const st = sdd(d, 'tdd', 'stub', 'TEST-B-001');
  assert.equal(st.code, 1);
  assert.match(st.out, /no spec defines/);
  fs.writeFileSync(specPath(d), `${T1SPEC}<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> other\n`);
  assert.match(sdd(d, 'trace').out, /SPEC CONFLICT/);
});

test('#83 full-width REQ id does not stale evidence', () => {
  const d = mini(T1SPEC, { 'a.test.mjs': jsTest() }, FAIL);
  sdd(d, 'tdd', 'red', 'TEST-A-001'); setCmd(d, PASS); assert.equal(sdd(d, 'tdd', 'green', 'TEST-A-001').code, 0);
  fs.writeFileSync(specPath(d), T1SPEC.replace('REQ-A-001', 'ＲＥＱ－Ａ－００１'));
  assert.match(sdd(d, 'gate', '--no-run').out, /1\/1 tests Red→Green/);
});

test('#85 Maven compiler-plugin failure is a load error, not a Red', () => {
  const d = mini(T1SPEC, { 'a.test.mjs': jsTest() }, ['node', '-e', 'console.log("[ERROR] Fatal error compiling: error: release version 21 not supported\\n[INFO] BUILD FAILURE");process.exit(1)']);
  assert.match(sdd(d, 'tdd', 'red', 'TEST-A-001').out, /REJECTED.*load\/compile/);
});

test('#84 skipped Go/JUnit test is not a Red; #86 gate shows the failing line', () => {
  const d = mini(T1SPEC, { 'a.test.mjs': jsTest() }, ['node', '-e', 'console.log("--- SKIP: TestX (0.00s)\\nok  \\tm\\t0.00s");process.exit(0)']);
  assert.match(sdd(d, 'tdd', 'red', 'TEST-A-001').out, /REJECTED.*skipped/);
  const lines = Array.from({ length: 20 }, (_, i) => `ok line ${i}`).join('\\n');
  fs.writeFileSync(path.join(d, '.sdd/config.json'), JSON.stringify({ checks: [{ name: 'c', cmd: ['node', '-e', `console.log("FAIL arena_reset expected 0");console.log("${lines}");process.exit(1)`] }] }));
  assert.match(sdd(d, 'gate').out, /FAIL arena_reset expected 0/);
});

test('#87 tdd stub: PHP class (no fn keyword), C opaque typedef + typed pointer param, Rust Option return', () => {
  const mk = (files) => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-'));
    spawnSync('git', ['init', '-q'], { cwd: d });
    for (const [f, body] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), body); }
    return d;
  };
  const read = (d, f) => fs.readFileSync(path.join(d, f), 'utf8');
  const php = mk({ 'MoneyTest.php': "<?php\nrequire __DIR__ . '/src/Money.php';\n// @id TEST-M-001 @verifies REQ-M-001\ntest('TEST-M-001', fn() => assertEq(Money::yen(5)->amount(), 5));\n" });
  sdd(php, 'tdd', 'stub', 'TEST-M-001');
  const m = read(php, 'src/Money.php');
  assert.match(m, /class Money/);
  assert.match(m, /public static function yen/);
  assert.doesNotMatch(m, /function fn\b|function assertEq/);
  const c = mk({ 'include/.keep': '', 'tests/t.c': '#include "arena.h"\n// @id TEST-C-001 @verifies REQ-C-001\nint main(void) { arena_t *a = arena_create(1024); arena_reset(a); return 0; }\n' });
  sdd(c, 'tdd', 'stub', 'TEST-C-001');
  assert.match(read(c, 'include/arena.h'), /typedef struct arena arena_t;/);
  assert.match(read(c, 'include/arena.h'), /arena_reset\(arena_t \* a0\)/);
});

test('#88 human-approved feature: implementation change after approval is flagged by gate', () => {
  const d = mini(T2SPEC, { 'a.test.mjs': jsTest(), 'a.mjs': '// @id CODE-A-001 @implements REQ-A-001\nexport const a = 1;\n' }, PASS);
  assert.equal(sdd(d, 'approve', 'record', 'a', '--by', 'alice').code, 0);
  assert.doesNotMatch(sdd(d, 'gate', '--no-run').out, /implementation changed since approval/);
  fs.appendFileSync(path.join(d, 'a.mjs'), 'export const b = 2;\n');
  assert.match(sdd(d, 'gate', '--no-run').out, /implementation changed since approval/);
});

test('#89 init re-run reports the kept config; call inside a multi-line assertion is not a weak Red', () => {
  const d = mini(T1SPEC, { 'a.test.mjs': "// @id TEST-A-001 @verifies REQ-A-001\ntest('TEST-A-001 x', () => {\n  expect(\n    foo(1),\n  ).toBe(2);\n});\n" }, ['node', '-e', 'console.log("Error: not implemented: foo");process.exit(1)']);
  assert.match(sdd(d, 'init').out, /existing config kept/);
  const r = sdd(d, 'tdd', 'red', 'TEST-A-001');
  assert.equal(r.code, 0, r.out);
  assert.doesNotMatch(r.out, /weak|setup call/i);
});

test('#91 impact: REQ change lists dependent tests/REQs of other features (JS, Python, Go, C)', () => {
  const mk = (files) => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-'));
    spawnSync('git', ['init', '-q'], { cwd: d });
    fs.mkdirSync(path.join(d, '.sdd/specs'), { recursive: true });
    for (const [f, body] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), body); }
    return d;
  };
  const spec = (f, id) => `---\nfeature: ${f}\ntier: T1\n---\n- ${id} x\n`;
  const js = mk({
    '.sdd/specs/a.md': spec('a', 'REQ-A-001'), '.sdd/specs/b.md': spec('b', 'REQ-B-001'),
    'a.mjs': '// @id CODE-A-001 @implements REQ-A-001\nexport const a=1;\n',
    'b.mjs': '// @id CODE-B-001 @implements REQ-B-001\nimport {a} from "./a.mjs";\nexport const b=a;\n',
    'b.test.mjs': '// @id TEST-B-001 @verifies REQ-B-001\nimport {b} from "./b.mjs";\n',
  });
  const r = sdd(js, 'impact', 'REQ-A-001');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /impl: a\.mjs/);
  assert.match(r.out, /other feature REQ-B-001 \[b\]/);
  assert.match(r.out, /b\.test\.mjs/);
  assert.equal(JSON.parse(sdd(js, 'impact', 'a.mjs', '--json').out).otherReqs[0].req, 'REQ-B-001');
  assert.equal(sdd(js, 'impact', 'REQ-NOPE-1').code, 1);

  const py = mk({
    '.sdd/specs/a.md': spec('a', 'REQ-A-001'), '.sdd/specs/b.md': spec('b', 'REQ-B-001'),
    'pkg/core.py': '# @id CODE-A-001 @implements REQ-A-001\ndef f(): return 1\n',
    'tests/test_b.py': '# @id TEST-B-001 @verifies REQ-B-001\nfrom pkg.core import f\n',
  });
  assert.match(sdd(py, 'impact', 'REQ-A-001').out, /other feature REQ-B-001/);

  const go = mk({
    '.sdd/specs/a.md': spec('a', 'REQ-A-001'), '.sdd/specs/b.md': spec('b', 'REQ-B-001'),
    'go.mod': 'module ex.com/m\n',
    'core/core.go': 'package core\n// @id CODE-A-001 @implements REQ-A-001\nfunc F() int { return 1 }\n',
    'cli/cli_test.go': 'package cli\nimport "ex.com/m/core"\n// @id TEST-B-001 @verifies REQ-B-001\nfunc TestX() { core.F() }\n',
  });
  assert.match(sdd(go, 'impact', 'REQ-A-001').out, /other feature REQ-B-001/);

  const c = mk({
    '.sdd/specs/a.md': spec('a', 'REQ-A-001'), '.sdd/specs/b.md': spec('b', 'REQ-B-001'),
    'include/arena.h': '// @id CODE-A-001 @implements REQ-A-001\nint x;\n',
    'tests/t.c': '#include "arena.h"\n// @id TEST-B-001 @verifies REQ-B-001\nint main(void){return 0;}\n',
  });
  assert.match(sdd(c, 'impact', 'REQ-A-001').out, /other feature REQ-B-001/);
});

// ---- dogfood round 5 (#92-#102) ----
test('#92 human-approved: first implementation after approval does not warn; later change does', () => {
  const d = mini(T2SPEC, { 'a.test.mjs': jsTest(), 'a.mjs': '// @id CODE-A-001 @implements REQ-A-001\nexport const a = () => { throw new Error("not implemented"); };\n' }, FAIL);
  assert.equal(sdd(d, 'approve', 'record', 'a', '--by', 'alice').code, 0);
  assert.equal(sdd(d, 'tdd', 'red', 'TEST-A-001', '--allow-setup-red').code, 0);
  fs.writeFileSync(path.join(d, 'a.mjs'), '// @id CODE-A-001 @implements REQ-A-001\nexport const a = () => 1;\n');
  setCmd(d, PASS);
  assert.equal(sdd(d, 'tdd', 'green', 'TEST-A-001').code, 0);
  assert.doesNotMatch(sdd(d, 'gate', '--no-run').out, /implementation changed since approval/);
  fs.appendFileSync(path.join(d, 'a.mjs'), 'export const b = 2;\n');
  assert.match(sdd(d, 'gate', '--no-run').out, /implementation changed since approval/);
});

test('#93 impact: same-feature REQs separated, TEST target shows impl files, Rust lib.rs/Java same-package/C .c impl', () => {
  const mk = (files) => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-'));
    spawnSync('git', ['init', '-q'], { cwd: d });
    fs.mkdirSync(path.join(d, '.sdd/specs'), { recursive: true });
    for (const [f, body] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), body); }
    return d;
  };
  const sp = (f, ...ids) => `---\nfeature: ${f}\ntier: T1\n---\n${ids.map((i) => `- ${i} x`).join('\n')}\n`;
  const js = mk({
    '.sdd/specs/a.md': sp('a', 'REQ-A-001', 'REQ-A-002'),
    'a.mjs': '// @id CODE-A-001 @implements REQ-A-001\nexport const a=1;\n// @id CODE-A-002 @implements REQ-A-002\nexport const b=2;\n',
    'a.test.mjs': '// @id TEST-A-001 @verifies REQ-A-001\nimport {a} from "./a.mjs";\n',
  });
  const r = sdd(js, 'impact', 'REQ-A-001').out;
  assert.match(r, /same feature: 1 other REQ/);
  assert.doesNotMatch(r, /other feature/);
  const t = sdd(js, 'impact', 'TEST-A-001').out;
  assert.match(t, /impl: a\.mjs/);
  assert.doesNotMatch(t, /impl: .*test/);

  const rs = mk({
    '.sdd/specs/a.md': sp('a', 'REQ-A-001'), '.sdd/specs/b.md': sp('b', 'REQ-B-001'),
    'Cargo.toml': '[package]\nname = "m"\nversion = "0.1.0"\nedition = "2021"\n',
    'src/lib.rs': 'pub mod a;\npub mod b;\n',
    'src/a.rs': '// @id CODE-A-001 @implements REQ-A-001\npub fn fa() {}\n',
    'src/b.rs': '// @id CODE-B-001 @implements REQ-B-001\npub fn fb() {}\n',
    'tests/b.rs': '// @id TEST-B-001 @verifies REQ-B-001\nuse m::b::fb;\n',
  });
  assert.doesNotMatch(sdd(rs, 'impact', 'REQ-A-001').out, /REQ-B-001/);

  const jv = mk({
    '.sdd/specs/a.md': sp('a', 'REQ-A-001'), '.sdd/specs/b.md': sp('b', 'REQ-B-001'),
    'src/main/java/p/Money.java': 'package p;\n// @id CODE-A-001 @implements REQ-A-001\npublic class Money {}\n',
    'src/test/java/p/RateTest.java': 'package p;\n// @id TEST-B-001 @verifies REQ-B-001\nclass RateTest { Money m; }\n',
  });
  assert.match(sdd(jv, 'impact', 'REQ-A-001').out, /other feature REQ-B-001/);

  const c = mk({
    '.sdd/specs/a.md': sp('a', 'REQ-A-001'), '.sdd/specs/b.md': sp('b', 'REQ-B-001'),
    'include/arena.h': 'int arena_x(void);\n',
    'src/arena.c': '#include "arena.h"\n// @id CODE-A-001 @implements REQ-A-001\nint arena_x(void){return 1;}\n',
    'tests/t.c': '#include "arena.h"\n// @id TEST-B-001 @verifies REQ-B-001\nint main(void){return 0;}\n',
  });
  assert.match(sdd(c, 'impact', 'REQ-A-001').out, /other feature REQ-B-001/);
});

test('#94 Go: no methods on any receivers; Red is classified by the test package, not ./...', { skip: spawnSync('which', ['go']).status !== 0 }, () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-'));
  const w = (f, b) => { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), b); };
  spawnSync('git', ['init', '-q'], { cwd: d });
  w('go.mod', 'module ex.com/m\n\ngo 1.21\n');
  w('.sdd/specs/a.md', '---\nfeature: a\ntier: T1\n---\n- REQ-A-001 x\n- REQ-B-001 y\n');
  w('bad/bad.go', 'package bad\nfunc Broken() int { return "x" }\n');
  w('ok/ok.go', 'package ok\n// @id CODE-A-001 @implements REQ-A-001\nfunc Two() int { panic("not implemented: Two") }\n');
  w('ok/ok_test.go', 'package ok\nimport "testing"\n// @id TEST-A-001 @verifies REQ-A-001\nfunc TestTEST_A_001_two(t *testing.T) { if Two() != 2 { t.Fatalf("want 2, got %d", Two()) } }\n');
  sdd(d, 'init');
  const r = sdd(d, 'tdd', 'red', 'TEST-A-001', '--allow-setup-red');
  assert.equal(r.code, 0, r.out);

  const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-'));
  spawnSync('git', ['init', '-q'], { cwd: d2 });
  fs.mkdirSync(path.join(d2, '.sdd/specs'), { recursive: true });
  fs.writeFileSync(path.join(d2, 'go.mod'), 'module ex.com/m\n\ngo 1.21\n');
  fs.writeFileSync(path.join(d2, '.sdd/specs/a.md'), '---\nfeature: a\ntier: T1\n---\n- REQ-A-001 x\n');
  fs.mkdirSync(path.join(d2, 'tx'));
  fs.writeFileSync(path.join(d2, 'tx/tx_test.go'), 'package tx\nimport "testing"\n// @id TEST-A-001 @verifies REQ-A-001\nfunc TestTEST_A_001_put(t *testing.T) {\n\ttx := Begin(1)\n\ttx.Put("k", 1)\n}\n');
  sdd(d2, 'init');
  sdd(d2, 'tdd', 'stub', 'TEST-A-001');
  const stub = fs.readdirSync(path.join(d2, 'tx')).filter((f) => f.endsWith('.go') && !f.endsWith('_test.go')).map((f) => fs.readFileSync(path.join(d2, 'tx', f), 'utf8')).join('\n');
  assert.doesNotMatch(stub, /\(\*any\)/);
  assert.equal(spawnSync('go', ['vet', './...'], { cwd: d2 }).status, 0, stub);
});

test('#95 PHP stub: existing/builtin classes are not redeclared, exception classes extend Exception; redeclare is a load error', { skip: spawnSync('which', ['php']).status !== 0 }, () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-'));
  const w = (f, b) => { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), b); };
  spawnSync('git', ['init', '-q'], { cwd: d });
  w('.sdd/specs/c.md', '---\nfeature: c\ntier: T1\n---\n- REQ-C-001 x\n');
  w('src/Money.php', '<?php\nclass Money { public static function yen($n) { return new Money(); } }\n');
  w('CartTest.php', "<?php\nrequire __DIR__ . '/src/Money.php';\nrequire __DIR__ . '/src/Cart.php';\n// @id TEST-C-001 @verifies REQ-C-001\nfunction test_c_001() { $c = new Cart(); Money::yen(1); $d = new DateTimeImmutable('now'); expectException(CartException::class); }\n");
  sdd(d, 'init');
  const r = sdd(d, 'tdd', 'stub', 'TEST-C-001');
  assert.equal(r.code, 0, r.out);
  const cart = fs.readFileSync(path.join(d, 'src/Cart.php'), 'utf8');
  assert.match(cart, /class Cart\b/);
  assert.doesNotMatch(cart, /class Money|function DateTimeImmutable|class DateTimeImmutable/);
  assert.doesNotMatch(cart, /function DateTimeImmutable/);
  assert.equal(spawnSync('php', ['-l', path.join(d, 'src/Cart.php')]).status, 0);
});

test('#96 C stub: functions/types declared by existing headers are not redeclared', { skip: spawnSync('which', ['cc']).status !== 0 }, () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-'));
  const w = (f, b) => { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), b); };
  spawnSync('git', ['init', '-q'], { cwd: d });
  w('.sdd/specs/c.md', '---\nfeature: c\ntier: T1\n---\n- REQ-C-001 x\n');
  w('include/base.h', '#pragma once\ntypedef struct base_t { int x; } base_t;\nint base_make(int a);\n');
  w('tests/t.c', '#include <assert.h>\n#include "base.h"\n#include "cart.h"\n/* @id TEST-C-001 @verifies REQ-C-001 */\nint main(void) { base_t b; (void)b; assert(base_make(1) == 1); assert(cart_total(2) == 2); return 0; }\n');
  fs.writeFileSync(path.join(d, 'include/base.c'), '');
  sdd(d, 'init');
  const r = sdd(d, 'tdd', 'stub', 'TEST-C-001');
  assert.equal(r.code, 0, r.out);
  const files = spawnSync('git', ['ls-files', '-co', '--exclude-standard', '*cart.h'], { cwd: d, encoding: 'utf8' }).stdout.trim();
  const h = fs.readFileSync(path.join(d, files), 'utf8');
  assert.match(h, /cart_total/);
  assert.doesNotMatch(h, /base_make|base_t/);
});

test('#97 JS/Python class stubs get throwing methods for the methods the test calls', { skip: spawnSync('which', ['python3']).status !== 0 }, () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-'));
  const w = (f, b) => { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), b); };
  spawnSync('git', ['init', '-q'], { cwd: d });
  w('.sdd/specs/b.md', '---\nfeature: b\ntier: T1\n---\n- REQ-B-001 x\n- REQ-B-002 y\n');
  w('b.test.mjs', "import test from 'node:test';\nimport { Book } from './book.mjs';\n// @id TEST-B-001 @verifies REQ-B-001\ntest('a', () => { const b = new Book(); b.add(1); });\n");
  w('test_p.py', "from idx import Index\n# @id TEST-B-002 @verifies REQ-B-002\ndef test_b_002():\n    i = Index()\n    i.add(1)\n    assert i.size() == 1\n");
  sdd(d, 'init');
  assert.equal(sdd(d, 'tdd', 'stub', 'TEST-B-001').code, 0);
  assert.match(fs.readFileSync(path.join(d, 'book.mjs'), 'utf8'), /add\(\.\.\._args\) \{[\s\S]*not implemented: Book\.add/);
  assert.equal(sdd(d, 'tdd', 'stub', 'TEST-B-002').code, 0);
  const py = fs.readFileSync(path.join(d, 'idx.py'), 'utf8');
  assert.match(py, /def add\(self/);
  assert.match(py, /def size\(self/);
  assert.equal(spawnSync('python3', ['-c', 'import ast,sys;ast.parse(open(sys.argv[1]).read())', path.join(d, 'idx.py')]).status, 0);
});

test('#98 pytest -k: a longer test name extending this id is excluded from the selection', { skip: spawnSync('python3', ['-m', 'pytest', '--version']).status !== 0 }, () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-'));
  const w = (f, b) => { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), b); };
  spawnSync('git', ['init', '-q'], { cwd: d });
  w('.sdd/specs/t.md', '---\nfeature: t\ntier: T1\n---\n- REQ-T-007 a\n- REQ-T-0071 b\n');
  w('requirements.txt', '');
  w('mod.py', 'def f():\n    return 1\n');
  w('test_m.py', "from mod import f\n# @id TEST-T-007 @verifies REQ-T-007\ndef test_t_007():\n    assert f() == 1\n# @id TEST-T-0071 @verifies REQ-T-0071\ndef test_t_0071():\n    assert f() == 2\n");
  sdd(d, 'init');
  const r = sdd(d, 'tdd', 'red', 'TEST-T-007');
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /test passed/);
});

test('#99 approve record for a human spec is refused without a matching prepare; allowed after it', () => {
  const d = mini(T2SPEC, { 'a.test.mjs': jsTest() }, PASS);
  const r = sddRaw(d, 'approve', 'record', 'a', '--by', 'Alice');
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /approve prepare a/);
  assert.equal(sddRaw(d, 'approve', 'prepare', 'a').code, 0);
  assert.equal(sddRaw(d, 'approve', 'record', 'a', '--by', 'Alice').code, 0);
});

test('#100 Green is accepted after reverting a wrong test edit back to an earlier Red content', () => {
  const d = mini(T1SPEC, { 'a.test.mjs': jsTest() }, FAIL);
  const tp = path.join(d, 'a.test.mjs');
  assert.equal(sdd(d, 'tdd', 'red', 'TEST-A-001').code, 0);
  fs.writeFileSync(tp, jsTest().replace('assert.ok(1)', 'assert.ok(2)'));
  assert.equal(sdd(d, 'tdd', 'red', 'TEST-A-001').code, 0);
  fs.writeFileSync(tp, jsTest());
  setCmd(d, PASS);
  const r = sdd(d, 'tdd', 'green', 'TEST-A-001');
  assert.equal(r.code, 0, r.out);
});

test('#102 trace +N more, invalid lowercase id suffix, test CRLF does not stale evidence, ＜test-only＞ marker', () => {
  // test CRLF conversion keeps Green
  const d = mini(T1SPEC, { 'a.test.mjs': jsTest() }, FAIL);
  assert.equal(sdd(d, 'tdd', 'red', 'TEST-A-001').code, 0);
  setCmd(d, PASS);
  assert.equal(sdd(d, 'tdd', 'green', 'TEST-A-001').code, 0);
  const tp = path.join(d, 'a.test.mjs');
  fs.writeFileSync(tp, fs.readFileSync(tp, 'utf8').replace(/\n/g, '\r\n'));
  assert.match(sdd(d, 'gate', '--no-run').out, /tdd evidence[^\n]*1\/1 tests Red→Green/);
  // lowercase suffix
  fs.writeFileSync(path.join(d, 'x.mjs'), '/** @id CODE-A-001b @implements REQ-A-001 */\nexport const x = 1;\n');
  assert.match(sdd(d, 'trace').out, /invalid @id CODE-A-001b/);
  // fullwidth angle brackets
  const e = mini('---\nfeature: a\ntier: T1\n---\n| REQ-A-001 | one shall hold. ＜test-only＞ | TEST-A-001 |\n', { 'a.test.mjs': jsTest() }, PASS);
  assert.doesNotMatch(sdd(e, 'trace').out, /REQ-A-001 has no @implements/);
});

test('#103 Java/Rust stubs generate instance methods called on constructed objects', { skip: ['cargo', 'mvn'].some((c) => spawnSync('which', [c]).status !== 0) }, () => {
  // Rust
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-rsi-'));
  spawnSync('git', ['init', '-q'], { cwd: d });
  fs.mkdirSync(path.join(d, '.sdd/specs'), { recursive: true });
  fs.mkdirSync(path.join(d, 'tests'));
  fs.writeFileSync(path.join(d, '.sdd/specs/s.md'), '---\nfeature: s\ntier: T1\n---\n| REQ-S-001 | x | TEST-S-001 |\n');
  fs.writeFileSync(path.join(d, 'Cargo.toml'), '[package]\nname = "lp"\nversion = "0.1.0"\nedition = "2021"\n');
  fs.writeFileSync(path.join(d, 'tests/t.rs'), 'use lp::Account;\n\n// @id TEST-S-001 @verifies REQ-S-001\n#[test]\nfn test_s_001() {\n    let mut a = Account::new(5);\n    a.deposit(3);\n    assert_eq!(a.balance(), 8);\n}\n');
  sdd(d, 'init');
  assert.equal(sdd(d, 'tdd', 'stub', 'TEST-S-001').code, 0);
  const lib = fs.readFileSync(path.join(d, 'src/lib.rs'), 'utf8');
  assert.match(lib, /pub fn new/);
  assert.match(lib, /pub fn balance\(&self/);
  assert.match(lib, /pub fn deposit<A0>\(&mut self/);
  const r = sdd(d, 'tdd', 'red', 'TEST-S-001');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /not implemented: Account::balance|not implemented: Account::deposit/);
  // Java
  const j = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-jvi-'));
  spawnSync('git', ['init', '-q'], { cwd: j });
  fs.mkdirSync(path.join(j, '.sdd/specs'), { recursive: true });
  fs.mkdirSync(path.join(j, 'src/test/java'), { recursive: true });
  fs.writeFileSync(path.join(j, '.sdd/specs/s.md'), '---\nfeature: s\ntier: T1\n---\n| REQ-S-001 | x | TEST-S-001 |\n');
  fs.writeFileSync(path.join(j, 'pom.xml'), '<project/>');
  fs.writeFileSync(path.join(j, 'src/test/java/AccTest.java'), 'import org.junit.jupiter.api.Test;\nimport static org.junit.jupiter.api.Assertions.*;\nclass AccTest {\n  // @id TEST-S-001 @verifies REQ-S-001\n  @Test void test_s_001() {\n    Account a = new Account(5);\n    a.deposit(3);\n    assertEquals(8, a.balance());\n  }\n}\n');
  sdd(j, 'init');
  assert.equal(sdd(j, 'tdd', 'stub', 'TEST-S-001').code, 0);
  const jv = fs.readFileSync(path.join(j, 'src/main/java/Account.java'), 'utf8');
  assert.match(jv, /public int balance\(\)/);
  assert.match(jv, /public \w+ deposit\(Object a0\)/);
});

test('#104 gate --changed warns when changed files are imported by another feature', () => {
  const d = mini(T1SPEC, { 'a.test.mjs': jsTest(), 'a.mjs': '/** @id CODE-A-001 @implements REQ-A-001 */\nexport const a = 1;\n' }, PASS);
  fs.writeFileSync(path.join(d, '.sdd/specs/b.md'), '---\nfeature: b\ntier: T1\n---\n| REQ-B-001 | x | TEST-B-001 |\n');
  fs.writeFileSync(path.join(d, 'b.mjs'), "import { a } from './a.mjs';\n/** @id CODE-B-001 @implements REQ-B-001 */\nexport const b = a + 1;\n");
  spawnSync('git', ['add', '-A'], { cwd: d });
  spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'x'], { cwd: d });
  fs.appendFileSync(path.join(d, 'a.mjs'), '// edit\n');
  const r = sdd(d, 'gate', '--changed', '--no-run');
  assert.match(r.out, /imported by other feature\(s\): b \(REQ-B-001\)/);
});

test('#105 Go impact: an import reaches only the files declaring the used symbols', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-goi-'));
  const w = (f, b) => { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), b); };
  spawnSync('git', ['init', '-q'], { cwd: d });
  w('go.mod', 'module m\n\ngo 1.21\n');
  w('.sdd/specs/a.md', '---\nfeature: a\ntier: T1\n---\n- REQ-A-001 x\n');
  w('.sdd/specs/b.md', '---\nfeature: b\ntier: T1\n---\n- REQ-B-001 x\n');
  w('util/a.go', 'package util\n\n// @id CODE-A-001 @implements REQ-A-001\nfunc Alpha() int { return 1 }\n');
  w('util/b.go', 'package util\n\n// @id CODE-A-002 @implements REQ-A-001\nfunc Beta() int { return 2 }\n');
  w('app/main.go', 'package main\n\nimport "m/util"\n\n// @id CODE-B-001 @implements REQ-B-001\nfunc Run() int { return util.Beta() }\n');
  sdd(d, 'init');
  const viaA = JSON.parse(sdd(d, 'impact', 'util/a.go', '--json').out);
  const viaB = JSON.parse(sdd(d, 'impact', 'util/b.go', '--json').out);
  assert.ok(!viaA.reachedFiles.includes('app/main.go'), 'Alpha is not used by main.go');
  assert.ok(viaB.reachedFiles.includes('app/main.go'));
});

test('#106 weak Red: a setup call inside a helper is weak; `.unwrap()` act before the assertions is not', () => {
  const mk = (src) => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-js-'));
    fs.mkdirSync(path.join(d, '.sdd/specs'), { recursive: true });
    fs.writeFileSync(path.join(d, 'package.json'), '{}');
    spawnSync('git', ['init', '-q'], { cwd: d });
    fs.writeFileSync(path.join(d, '.sdd/specs/a.md'), T1SPEC);
    fs.writeFileSync(path.join(d, 'a.test.mjs'), src);
    fs.writeFileSync(path.join(d, 'lib.mjs'), "export function make() { throw new Error('not implemented: make'); }\nexport function step() { throw new Error('not implemented: step'); }\n");
    sdd(d, 'init');
    setCmd(d, ['node', '-e', "const e=new Error('not implemented: '+process.env.W);e.stack='Error: '+e.message+'\\n    at x (a.test.mjs:'+process.env.L+':1)';console.log(e.stack);process.exit(1)"]);
    return d;
  };
  // helper case: stub thrown in make() (defined outside the test), the test only calls make() then asserts on other state
  const helperSrc = "import assert from 'node:assert';\nimport { make, step } from './lib.mjs';\nfunction setup() {\n  return make();\n}\n// @id TEST-A-001 @verifies REQ-A-001\ntest('TEST-A-001', () => {\n  const s = setup();\n  assert.equal(1, 2);\n});\n";
  const d1 = mk(helperSrc);
  const r1 = spawnSync('node', [SDD, '--root', d1, 'tdd', 'red', 'TEST-A-001'], { encoding: 'utf8', env: { ...ENV, W: 'make', L: '4' } });
  assert.match(r1.stdout, /setup call|weak/i, r1.stdout);
  // act case: `step()` followed by unwrap-like last statement then the assertions
  const actSrc = "import assert from 'node:assert';\nimport { step } from './lib.mjs';\n// @id TEST-A-001 @verifies REQ-A-001\ntest('TEST-A-001', () => {\n  const t = {};\n  step(t).unwrap();\n  assert.equal(t.n, 1);\n});\n";
  const d2 = mk(actSrc);
  const r2 = spawnSync('node', [SDD, '--root', d2, 'tdd', 'red', 'TEST-A-001'], { encoding: 'utf8', env: { ...ENV, W: 'step', L: '6' } });
  assert.doesNotMatch(r2.stdout, /Red comes from setup/, r2.stdout);
});

test('#107 gate --changed lists every importing feature and also fires on a spec-only change', () => {
  const d = mini(T1SPEC, { 'a.test.mjs': jsTest(), 'a.mjs': '/** @id CODE-A-001 @implements REQ-A-001 */\nexport const a = 1;\n' }, PASS);
  for (const f of ['b', 'c', 'd', 'e', 'f']) {
    const F = f.toUpperCase();
    fs.writeFileSync(path.join(d, `.sdd/specs/${f}.md`), `---\nfeature: ${f}\ntier: T1\n---\n| REQ-${F}-001 | x | TEST-${F}-001 |\n`);
    fs.writeFileSync(path.join(d, `${f}.mjs`), `import { a } from './a.mjs';\n/** @id CODE-${F}-001 @implements REQ-${F}-001 */\nexport const ${f} = a + 1;\n`);
  }
  spawnSync('git', ['add', '-A'], { cwd: d });
  spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'x'], { cwd: d });
  fs.appendFileSync(path.join(d, 'a.mjs'), '// edit\n');
  assert.match(sdd(d, 'gate', '--changed', '--no-run').out, /other feature\(s\): b, c, d, e, f \(/);
  spawnSync('git', ['checkout', 'a.mjs'], { cwd: d });
  fs.appendFileSync(path.join(d, '.sdd/specs/a.md'), '\n');
  assert.match(sdd(d, 'gate', '--changed', '--no-run').out, /other feature\(s\): b, c, d, e, f \(/);
});

test('#108 a lone CR in the frontmatter does not downgrade approval: human', () => {
  const d = mini(T1SPEC.replace('tier: T1', 'tier: T1\napproval: human'), {}, PASS);
  const p = path.join(d, '.sdd/specs/a.md');
  fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace('approval: human', 'approval: human # c\r').replace(/\n/g, '\r\n'));
  assert.match(sddRaw(d, 'approve', 'prepare', 'a').out, /approval: human/);
});

test('#109 concurrent ledger appends keep the hash chain intact', async () => {
  const d = mini(T1SPEC, { 'a.test.mjs': jsTest() }, FAIL);
  const S = fileURLToPath(new URL('./sdd.mjs', import.meta.url));
  const one = () => new Promise((res) => { const p = spawn(process.execPath, [S, '--root', d, 'tdd', 'red', 'TEST-A-001', '--weak'], { stdio: 'ignore' }); p.on('close', res); });
  await Promise.all(Array.from({ length: 8 }, one));
  const r = sddRaw(d, 'tdd', 'check');
  assert.equal(r.code, 0, r.out);
  assert.ok(fs.readFileSync(path.join(d, '.sdd/tdd.jsonl'), 'utf8').trim().split('\n').length >= 2);
});

test('#110 weak Red: an assigned (tuple / :=) result that is asserted, or a match scrutinee, is the act', () => {
  const run = (body, line) => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-w110-'));
    fs.mkdirSync(path.join(d, '.sdd/specs'), { recursive: true });
    fs.writeFileSync(path.join(d, 'package.json'), '{}');
    spawnSync('git', ['init', '-q'], { cwd: d });
    fs.writeFileSync(path.join(d, '.sdd/specs/a.md'), T1SPEC);
    fs.writeFileSync(path.join(d, 'a.test.mjs'), `// @id TEST-A-001 @verifies REQ-A-001\n${body}\n`);
    sdd(d, 'init');
    setCmd(d, ['node', '-e', "const e=new Error('not implemented: '+process.env.W);e.stack='Error: '+e.message+'\\n    at x (a.test.mjs:'+process.env.L+':1)';console.log(e.stack);process.exit(1)"]);
    return spawnSync('node', [SDD, '--root', d, 'tdd', 'red', 'TEST-A-001'], { encoding: 'utf8', env: { ...ENV, W: 'step', L: String(line) } }).stdout;
  };
  assert.doesNotMatch(run('recs, rej = step(t)\nassert recs == 1', 2), /Red comes from setup/);
  assert.doesNotMatch(run('e := step(t)\nif len(e) != 1 {', 2), /Red comes from setup/);
  assert.doesNotMatch(run('match step(1).unwrap() {\n  Ok(x) => {}\n}\nassert_eq!(1, 2);', 2), /Red comes from setup/);
  assert.match(run('s = step(t)\nassert 1 == 2', 2), /Red comes from setup/);
});

test('#111 impact: python relative imports, PHP use, TS type-only edges, header owner, capped header', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-i111-'));
  const w = (f, b) => { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), b); };
  spawnSync('git', ['init', '-q'], { cwd: d });
  for (const f of ['a', 'b', 'c', 'e', 'k']) w(`.sdd/specs/${f}.md`, `---\nfeature: ${f}\ntier: T1\n---\n- REQ-${f.toUpperCase()}-001 x\n`);
  w('pkg/__init__.py', '');
  w('pkg/a.py', '# @id CODE-A-001 @implements REQ-A-001\nX = 1\n');
  w('pkg/b.py', 'from . import a\n# @id CODE-B-001 @implements REQ-B-001\nY = a.X\n');
  w('src/Core/A.php', '<?php\nnamespace P\\Core;\n// @id CODE-C-001 @implements REQ-C-001\nclass Money {}\n');
  w('src/Pay/B.php', '<?php\nnamespace P\\Pay;\nuse P\\Core\\Money;\n// @id CODE-E-001 @implements REQ-E-001\nclass Pay { function f() { return new Money(); } }\n');
  w('t/x.ts', '// @id CODE-K-001 @implements REQ-K-001\nexport type T = number;\nexport const v = 1;\n');
  w('t/y.ts', "import type { T } from './x';\nimport { type T as U } from './x';\nexport const z = 1;\n");
  sdd(d, 'init');
  assert.ok(JSON.parse(sdd(d, 'impact', 'pkg/a.py', '--json').out).reachedFiles.includes('pkg/b.py'));
  assert.ok(JSON.parse(sdd(d, 'impact', 'src/Core/A.php', '--json').out).reachedFiles.includes('src/Pay/B.php'));
  assert.ok(!JSON.parse(sdd(d, 'impact', 't/x.ts', '--json').out).reachedFiles.includes('t/y.ts'));
  const txt = sdd(d, 'impact', 'pkg/a.py').out;
  assert.match(txt, /other features: b \(1\)/);
  assert.match(txt, /pkg\/b\.py ← pkg\/a\.py/);
});

test('#112 stub: existing JS module gets missing exports/methods; helper-built objects; py constants and submodules', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-s112-'));
  const w = (f, b) => { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), b); };
  spawnSync('git', ['init', '-q'], { cwd: d });
  w('package.json', '{}');
  w('.sdd/specs/a.md', T1SPEC);
  w('lib.mjs', 'export function old() { return 1; }\nexport class Box {\n  put() { return 1; }\n}\n');
  w('a.test.mjs', "import { old, fresh, GENESIS, Box } from './lib.mjs';\nfunction setup() { return { b: new Box() }; }\n// @id TEST-A-001 @verifies REQ-A-001\ntest('x', () => {\n  const { b } = setup();\n  b.reset();\n  assert(fresh() && GENESIS && old());\n});\n");
  sdd(d, 'init');
  sdd(d, 'tdd', 'stub', 'TEST-A-001');
  const lib = fs.readFileSync(path.join(d, 'lib.mjs'), 'utf8');
  assert.match(lib, /export function old\(\) \{ return 1; \}/);
  assert.match(lib, /export function fresh\(\)/);
  assert.match(lib, /export const GENESIS = undefined/);
  assert.match(lib, /reset\(\.\.\._args\)[^]*not implemented: Box\.reset/);
  assert.equal((lib.match(/put\(\)/g) ?? []).length, 1);

  const p = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-p112-'));
  const wp = (f, b) => { fs.mkdirSync(path.dirname(path.join(p, f)), { recursive: true }); fs.writeFileSync(path.join(p, f), b); };
  spawnSync('git', ['init', '-q'], { cwd: p });
  wp('.sdd/specs/a.md', T1SPEC);
  wp('pipe/__init__.py', '');
  wp('test_a.py', "from pipe import load, Journal, GENESIS\n\ndef setup():\n    return Journal(), 1\n\n# @id TEST-A-001 @verifies REQ-A-001\ndef test_x():\n    j, n = setup()\n    j.post(n)\n    load.write(1)\n    assert GENESIS\n");
  sdd(p, 'init');
  sdd(p, 'tdd', 'stub', 'TEST-A-001');
  assert.equal(fs.readFileSync(path.join(p, 'pipe/load.py'), 'utf8').includes('def write'), true);
  const init = fs.readFileSync(path.join(p, 'pipe/__init__.py'), 'utf8');
  assert.doesNotMatch(init, /def load/);
  assert.match(init, /GENESIS = None/);
  assert.match(init, /def post\(self/);
});

test('#114/#115/#116 Rust Result + message, Java JDK wildcard/chained args/long, C unused params, Maven -am, plan equal order', { skip: ['cargo', 'mvn', 'gcc'].some((c) => spawnSync('which', [c]).status !== 0) }, () => {
  const proj = (name, spec) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), name)); spawnSync('git', ['init', '-q'], { cwd: d }); fs.mkdirSync(path.join(d, '.sdd/specs'), { recursive: true }); fs.writeFileSync(path.join(d, '.sdd/specs/s.md'), spec ?? '---\nfeature: s\ntier: T1\n---\n| REQ-S-001 | x | TEST-S-001 |\n'); return d; };
  const w = (d, f, b) => { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), b); };
  const r = proj('sdd-rs114-');
  w(r, 'Cargo.toml', '[package]\nname = "lp"\nversion = "0.1.0"\nedition = "2021"\n');
  w(r, 'tests/t.rs', 'use lp::{parse, Acc};\n\n// @id TEST-S-001 @verifies REQ-S-001\n#[test]\nfn test_s_001() {\n    let mut a = Acc::new(1);\n    a.add(2);\n    let v = parse("x").unwrap();\n    assert_eq!(v, 3);\n}\n');
  sdd(r, 'init');
  sdd(r, 'tdd', 'stub', 'TEST-S-001');
  const lib = fs.readFileSync(path.join(r, 'src/lib.rs'), 'utf8');
  assert.match(lib, /pub fn parse<A0>\(_a0: A0\) -> Result<i64, String>/);
  assert.match(lib, /pub fn add<A0>\(&mut self/);
  assert.match(lib, /unimplemented!\("Acc::add"\)/);
  const red = sdd(r, 'tdd', 'red', 'TEST-S-001');
  assert.doesNotMatch(red.out, /setup call "not"/);

  const c = proj('sdd-c116-');
  w(c, 'Makefile', 'test:\n\ttrue\n');
  w(c, 'test_t.c', '#include <assert.h>\n#include "c.h"\n// @id TEST-S-001 @verifies REQ-S-001\nint main(void) { assert(foo(1, 2) == 3); return 0; }\n');
  sdd(c, 'init');
  setCmd(c, ['gcc', '-Wall', '-Wextra', '-Werror', '-o', '/dev/null', 'test_t.c']);
  sdd(c, 'tdd', 'stub', 'TEST-S-001');
  const ch = fs.readdirSync(c).filter((f) => /\.h$/.test(f)).map((f) => fs.readFileSync(path.join(c, f), 'utf8')).join('');
  assert.match(ch, /\(void\)a0;\s*\(void\)a1;/);

  const j = proj('sdd-j115-');
  w(j, 'pom.xml', '<project/>');
  w(j, 'src/test/java/AccTest.java', 'import java.util.concurrent.*;\nimport org.junit.jupiter.api.Test;\nclass AccTest {\n  // @id TEST-S-001 @verifies REQ-S-001\n  @Test void test_s_001() {\n    ExecutorService e = Executors.newFixedThreadPool(8);\n    Money m = new Money(250L, "USD").times(3);\n  }\n}\n');
  sdd(j, 'init');
  sdd(j, 'tdd', 'stub', 'TEST-S-001');
  assert.ok(!fs.existsSync(path.join(j, 'src/main/java/Executors.java')));
  const mj = fs.readFileSync(path.join(j, 'src/main/java/Money.java'), 'utf8');
  assert.match(mj, /public Money\(long a0, String a1\)/);
  assert.match(mj, /times\(Object a0\)/);
  assert.match(fs.readFileSync(path.join(j, '.sdd/config.json'), 'utf8'), /"-am"/);

  const p = proj('sdd-p115-');
  w(p, '.sdd/plan.md', '| order | feature | depends |\n|---|---|---|\n| 5 | shipping | |\n| 5 | tracking | shipping |\n');
  assert.match(sdd(p, 'plan').out, /same order number/);
});

test('#113 Go stubs: external test package, chained New().M, slice results, field vs method', { skip: spawnSync('which', ['go']).status !== 0 }, () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-go113-'));
  const w = (f, b) => { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), b); };
  spawnSync('git', ['init', '-q'], { cwd: d });
  w('go.mod', 'module m\n\ngo 1.21\n');
  w('.sdd/specs/s.md', '---\nfeature: s\ntier: T1\n---\n| REQ-S-001 | x | TEST-S-001 |\n| REQ-S-002 | y | TEST-S-002 |\n');
  w('core/log_test.go', 'package core_test\n\nimport (\n\t"testing"\n\n\t"m/core"\n)\n\n// @id TEST-S-001 @verifies REQ-S-001\nfunc TestS001(t *testing.T) {\n\tl := core.NewLog()\n\tl.Append(1)\n\tvar e core.Entry\n\t_ = e\n\tif core.Max != 0 {\n\t\tt.Fatal("x")\n\t}\n}\n');
  w('aud/aud_test.go', 'package aud\n\nimport "testing"\n\n// @id TEST-S-002 @verifies REQ-S-002\nfunc TestS002(t *testing.T) {\n\tif _, err := New().Record(1, ""); err != nil {\n\t\tt.Fatal(err)\n\t}\n}\n');
  sdd(d, 'init');
  sdd(d, 'tdd', 'stub', 'TEST-S-001');
  const core = fs.readdirSync(path.join(d, 'core')).filter((f) => !/_test/.test(f)).map((f) => fs.readFileSync(path.join(d, 'core', f), 'utf8')).join('');
  assert.match(core, /package core/);
  assert.match(core, /func NewLog\(\) \*Log/);
  assert.match(core, /type Entry /);
  assert.match(core, /func \(\*Log\) Append\(/);
  assert.match(core, /const Max = 0/);
  assert.equal(spawnSync('go', ['vet', './core/'], { cwd: d }).status, 0);
  sdd(d, 'tdd', 'stub', 'TEST-S-002');
  const aud = fs.readdirSync(path.join(d, 'aud')).filter((f) => !/_test/.test(f)).map((f) => fs.readFileSync(path.join(d, 'aud', f), 'utf8')).join('');
  assert.match(aud, /func New\(\) \*Aud\b/);
  assert.match(aud, /\) Record\(.*\) \(?\w*,? ?error\)?/);
});

test('#117 PHP: `use Ns\\Cls` stubs a namespaced PSR-4 file; --missing-module accepts Class not found', { skip: spawnSync('which', ['php']).status !== 0 }, () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-php117-'));
  const w = (f, b) => { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), b); };
  spawnSync('git', ['init', '-q'], { cwd: d });
  w('composer.json', '{"autoload":{"psr-4":{"Payroll\\\\":"src/"}}}');
  w('.sdd/specs/s.md', T1SPEC.replace('REQ-A-001', 'REQ-S-001').replace('TEST-A-001', 'TEST-S-001').replace('feature: a', 'feature: s'));
  w('tests/CoreTest.php', "<?php\nuse Payroll\\Core\\Money;\n// @id TEST-S-001 @verifies REQ-S-001\nfinal class CoreTest { function test_s_001() { assert(Money::of(1) === 1); } }\n");
  sdd(d, 'init');
  const out = sdd(d, 'tdd', 'stub', 'TEST-S-001').out;
  assert.match(out, /src\/Core\/Money\.php/);
  const f = fs.readFileSync(path.join(d, 'src/Core/Money.php'), 'utf8');
  assert.match(f, /namespace Payroll\\Core;/);
  assert.match(f, /class Money/);
  assert.match(f, /static function of/);
  fs.rmSync(path.join(d, 'src'), { recursive: true });
  setCmd(d, ['node', '-e', "console.log('Error: Class \"Payroll\\\\Core\\\\Money\" not found');process.exit(1)"]);
  const r = sdd(d, 'tdd', 'red', 'TEST-S-001', '--missing-module');
  assert.doesNotMatch(r.out, /REJECTED/, r.out);
});

test('#118 tdd refactor --wording refuses when the test body changed since Green', () => {
  const d = mini(T1SPEC, { 'a.test.mjs': jsTest() }, PASS);
  sdd(d, 'tdd', 'red', 'TEST-A-001', '--characterization', 'x');
  sdd(d, 'tdd', 'green', 'TEST-A-001');
  const f = path.join(d, 'a.test.mjs');
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(/\)\s*;?\s*\}\);?\s*$/, ') ; void 0; });\n'));
  const r = sdd(d, 'tdd', 'refactor', 'TEST-A-001', '--wording', 'x');
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /--wording only covers spec rows/, r.out);
});

test('#119 Node file-level pass with no ID match is rejected for red --characterization and green', () => {
  const d = mini(T1SPEC, { 'a.test.mjs': "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\n// @id TEST-A-001 @verifies REQ-A-001\ntest('no id in title', () => { assert.equal(1, 2); });\n" });
  setCmd(d, ['node', '--test', '--test-name-pattern', '{id}', '{file}']);
  const r = sdd(d, 'tdd', 'red', 'TEST-A-001', '--characterization', 'x');
  assert.match(r.out, /REJECTED/, r.out);
  assert.match(r.out, /no test matched/, r.out);
});

test('#154 an ID-bearing filename is not proof of an executed Node test (spec and TAP)', () => {
  for (const reporter of ['spec', 'tap']) {
    const d = mini(T1SPEC, { 'TEST-A-001.test.mjs': "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\n// @id TEST-A-001 @verifies REQ-A-001\ntest('TEST-A-001 x', () => assert.equal(1, 2));\n" });
    const cmd = ['node', '--test', `--test-reporter=${reporter}`, '--test-name-pattern', '{id}', '{file}'];
    setCmd(d, cmd);
    assert.equal(sdd(d, 'tdd', 'red', 'TEST-A-001').code, 0);
    setCmd(d, cmd.map((x) => x === '{id}' ? 'MATCHES-NOTHING' : x));
    for (const sub of ['green', 'red']) {
      const r = sdd(d, 'tdd', sub, 'TEST-A-001', '--characterization', 'no implementation needed');
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, /no test matched/, r.out);
    }
    const ledger = fs.readFileSync(path.join(d, '.sdd/tdd.jsonl'), 'utf8').trim().split('\n');
    assert.equal(ledger.length, 1, 'rejected no-match runs write no evidence');
  }
});

test('#154 TODO-only Node assertions cannot establish Red, Green or Refactor evidence', () => {
  for (const reporter of ['spec', 'tap']) {
    const d = mini(T1SPEC, {
      'a.test.mjs': [
        "import { test } from 'node:test';",
        "import assert from 'node:assert/strict';",
        "import fs from 'node:fs';",
        '/** @id TEST-A-001 @verifies REQ-A-001 */',
        "test('TEST-A-001 assertion', { todo: fs.existsSync('.sdd/todo') }, () => assert.equal(fs.existsSync('.sdd/pass'), true));",
      ].join('\n'),
    });
    const cfg = JSON.parse(fs.readFileSync(path.join(d, '.sdd/config.json'), 'utf8'));
    cfg.testCmd = ['node', '--test', `--test-reporter=${reporter}`, '--test-name-pattern', '{id}', '{file}'];
    cfg.checks = [{ name: 'test', cmd: ['node', '--test', `--test-reporter=${reporter}`, 'a.test.mjs'] }];
    fs.writeFileSync(path.join(d, '.sdd/config.json'), JSON.stringify(cfg));
    assert.equal(sdd(d, 'tdd', 'red', 'TEST-A-001').code, 0);
    fs.writeFileSync(path.join(d, '.sdd/pass'), '');
    assert.equal(sdd(d, 'tdd', 'green', 'TEST-A-001').code, 0);
    fs.writeFileSync(path.join(d, '.sdd/todo'), '');
    for (const failing of [false, true]) {
      if (failing) fs.rmSync(path.join(d, '.sdd/pass'));
      for (const sub of ['red', 'green', 'refactor']) {
        const r = sdd(d, 'tdd', sub, 'TEST-A-001', '--characterization', 'TODO cannot count');
        assert.equal(r.code, 1, r.out);
      }
      const gate = sdd(d, 'gate');
      assert.equal(gate.code, 2, gate.out);
      assert.match(gate.out, /INCOMPLETE/);
    }
    assert.equal(fs.readFileSync(path.join(d, '.sdd/tdd.jsonl'), 'utf8').trim().split('\n').length, 2);
  }
});

test('#120 approve record strips zero-width chars before generic-name check', () => {
  const d = mini('---\nfeature: a\ntier: T2\napproval: human\n---\n## Design\nx\ny\n\n| REQ-A-001 | one shall hold. | TEST-A-001 |\n', { 'a.test.mjs': jsTest() });
  sddRaw(d, 'approve', 'prepare', 'a');
  const r = sddRaw(d, 'approve', 'record', 'a', '--by', 'ai\u200b');
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /REFUSED/);
});

test('#121 stale/missing lock hint is approval-specific', () => {
  const d = mini('---\nfeature: a\ntier: T2\n---\n## Design\nx\ny\n\n| REQ-A-001 | one shall hold. | TEST-A-001 |\n', { 'a.test.mjs': jsTest() }, PASS);
  const r = sdd(d, 'tdd', 'red', 'TEST-A-001');
  assert.match(r.out, /approve record a --by ai:<reviewer>/, r.out);
  assert.doesNotMatch(r.out, /run: approve prepare/);
});

test('#122 T1 record is not claimed as locked; deleted review file makes AI lock stale', () => {
  const t1 = mini(T1SPEC, { 'a.test.mjs': jsTest() });
  assert.match(sdd(t1, 'approve', 'record', 'a', '--by', 'ai:rev', '--review', 'ok').out, /NOT lock-enforced/);
  const d = mini('---\nfeature: a\ntier: T2\n---\n## Design\nx\ny\n\n| REQ-A-001 | one shall hold. | TEST-A-001 |\n', { 'a.test.mjs': jsTest() }, PASS);
  const tpl = sddRaw(d, 'review', 'template', 'a').out;
  fs.writeFileSync(path.join(d, '.sdd/review.md'), tpl.replace(/^[^\n]*\n(?=---)/, ''));
  const rec = sddRaw(d, 'approve', 'record', 'a', '--by', 'ai:rev', '--review', '.sdd/review.md');
  if (/^locked/m.test(rec.out)) {
    fs.rmSync(path.join(d, '.sdd/review.md'));
    assert.match(sddRaw(d, 'status').out + sddRaw(d, 'gate', '--no-run').out, /stale/);
  }
});

test('#123 pytest collection error is a load error (Red rejected)', () => {
  const d = mini(T1SPEC, { 'a.test.mjs': jsTest() });
  setCmd(d, ['node', '-e', "console.log('ERROR collecting t.py\\nAttributeError: x\\nInterrupted: 1 error during collection');process.exit(2)"]);
  assert.match(sdd(d, 'tdd', 'red', 'TEST-A-001').out, /REJECTED.*load\/compile/);
});

test('#156 pytest skipped/xfail-only runs cannot establish evidence or full gate PASS', { skip: spawnSync('python3', ['-m', 'pytest', '--version']).status !== 0 }, () => {
  for (const [verdict, verbosity] of [['skip', '-q'], ['xfail', '-q'], ['skip', '-qq'], ['xfail', '-qq']]) {
    const d = mini(T1SPEC.replace('one shall hold.', 'one shall hold. (test-only)'), {
      'test_a.py': [
        'from pathlib import Path',
        'import pytest',
        '# @id TEST-A-001 @verifies REQ-A-001',
        'def test_a_001():',
        '    if Path(".sdd/nonexecuted").exists():',
        `        pytest.${verdict}("not a passing assertion")`,
        '    assert Path(".sdd/pass").exists()',
      ].join('\n'),
    });
    const cp = path.join(d, '.sdd/config.json');
    const cfg = JSON.parse(fs.readFileSync(cp, 'utf8'));
    cfg.testCmd = ['python3', '-m', 'pytest', verbosity, '{file}', '-k', '{idu}'];
    cfg.checks = [{ name: 'test', cmd: ['python3', '-m', 'pytest', verbosity, 'test_a.py'] }];
    fs.writeFileSync(cp, JSON.stringify(cfg));
    assert.equal(sdd(d, 'tdd', 'red', 'TEST-A-001').code, 0);
    fs.writeFileSync(path.join(d, '.sdd/pass'), '');
    assert.equal(sdd(d, 'tdd', 'green', 'TEST-A-001').code, 0);
    fs.writeFileSync(path.join(d, '.sdd/nonexecuted'), '');
    for (const sub of ['red', 'green', 'refactor']) {
      const r = sdd(d, 'tdd', sub, 'TEST-A-001', '--characterization', 'cannot implement a skipped test');
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, /no test matched|skipped/);
    }
    const gate = sdd(d, 'gate');
    assert.equal(gate.code, 2, gate.out);
    assert.match(gate.out, /INCOMPLETE/);
    assert.equal(fs.readFileSync(path.join(d, '.sdd/tdd.jsonl'), 'utf8').trim().split('\n').length, 2);
  }
});

test('#156 pytest nonexecution summaries are recognized without rejecting mixed passing runs', () => {
  for (const summary of [
    '1 skipped in 0.01s',
    '1 xfailed in 0.01s',
    '================== 1 skipped, 2 xfailed, 1 warning in 0.02s ==================',
    'ssx                                                                      [100%]',
  ]) {
    const d = mini(T1SPEC, { 'a.test.mjs': jsTest() }, ['node', '-e', `console.log(${JSON.stringify(summary)})`]);
    const r = sdd(d, 'tdd', 'red', 'TEST-A-001', '--characterization', 'skipped suite');
    assert.equal(r.code, 1, r.out);
    assert.equal(fs.existsSync(path.join(d, '.sdd/tdd.jsonl')), false);
  }
  for (const summary of [
    '1 passed, 2 skipped, 1 xfailed in 0.01s',
    '1 xpassed, 1 skipped in 0.01s',
    '1 skipped in 0.01s\n1 passed in 0.02s',
    '.sx                                                                      [100%]',
  ]) {
    const d = mini(T1SPEC, { 'a.test.mjs': jsTest() }, FAIL);
    assert.equal(sdd(d, 'tdd', 'red', 'TEST-A-001').code, 0);
    setCmd(d, ['node', '-e', `console.log(${JSON.stringify(summary)})`]);
    const r = sdd(d, 'tdd', 'green', 'TEST-A-001');
    assert.equal(r.code, 0, r.out);
  }
});

test('#156 a scoped pytest skipped-only check falls back to the full check', () => {
  const d = mini(T1SPEC.replace('one shall hold.', 'one shall hold. (test-only)'), { 'a.test.mjs': jsTest() }, FAIL);
  assert.equal(sdd(d, 'tdd', 'red', 'TEST-A-001').code, 0);
  setCmd(d, PASS);
  assert.equal(sdd(d, 'tdd', 'green', 'TEST-A-001').code, 0);
  const cp = path.join(d, '.sdd/config.json');
  const cfg = JSON.parse(fs.readFileSync(cp, 'utf8'));
  cfg.checks = [{
    name: 'test',
    cmd: ['node', '-e', 'console.log("1 passed in 0.01s")'],
    changedCmd: ['node', '-e', 'console.log("1 skipped in 0.01s")'],
  }];
  fs.writeFileSync(cp, JSON.stringify(cfg));
  const r = sdd(d, 'gate', '--changed');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /scoped run.*running the full check/);
});

test('#156 fatal Python errors and signal-terminated runners are rejected even with --weak', () => {
  for (const cmd of [
    ['node', '-e', 'console.log("Fatal Python error: Aborted\\nAssertionError: not evidence");process.exit(1)'],
    ['node', '-e', 'process.kill(process.pid, "SIGTERM")'],
  ]) {
    const d = mini(T1SPEC, { 'a.test.mjs': jsTest() }, FAIL);
    assert.equal(sdd(d, 'tdd', 'red', 'TEST-A-001').code, 0);
    setCmd(d, PASS);
    assert.equal(sdd(d, 'tdd', 'green', 'TEST-A-001').code, 0);
    setCmd(d, cmd);
    for (const sub of ['red', 'green', 'refactor']) {
      const r = sdd(d, 'tdd', sub, 'TEST-A-001', '--weak');
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, /runner process crashed/);
    }
    assert.equal(fs.readFileSync(path.join(d, '.sdd/tdd.jsonl'), 'utf8').trim().split('\n').length, 2);
  }
});

test('#123 Julia top-level LoadError is a load error; sibling-only failure rejected', () => {
  const d = mini(T1SPEC, { 'a.test.mjs': jsTest() });
  setCmd(d, ['node', '-e', "console.log('ERROR: LoadError: not implemented: f');process.exit(1)"]);
  assert.match(sdd(d, 'tdd', 'red', 'TEST-A-001').out, /REJECTED.*load\/compile/);
  setCmd(d, ['node', '-e', "console.log('Test Summary: | Pass  Fail  Total\\n  TEST-A-001  |    1     0      1\\n  TEST-A-002  |    0     1      1\\nERROR: LoadError: Some tests did not pass');process.exit(1)"]);
  assert.match(sdd(d, 'tdd', 'red', 'TEST-A-001').out, /REJECTED.*itself passes/);
});

test('#126 tdd arg validation: no ID is a usage error; multiple IDs all processed', () => {
  const d = mini(T1SPEC, { 'a.test.mjs': jsTest() }, PASS);
  const r = sdd(d, 'tdd', 'green');
  assert.equal(r.code, 2);
  assert.match(r.out, /usage/);
  assert.doesNotMatch(r.out, /undefined/);
  assert.equal(sdd(d, 'tdd', 'red', 'TEST-A-001', '--characterization').code, 2);
  const b = sdd(d, 'tdd', 'red', 'TEST-A-001', 'TEST-A-001', '--characterization', 'x');
  assert.equal((b.out.match(/RED ok/g) ?? []).length, 2, b.out);
});

test('#134 tdd red --retest records a weak Red after the test changed', () => {
  const d = mini(T1SPEC, { 'a.test.mjs': jsTest() }, PASS);
  assert.match(sdd(d, 'tdd', 'red', 'TEST-A-001', '--retest', 'x').out, /REFUSED.*previous/);
  sdd(d, 'tdd', 'red', 'TEST-A-001', '--characterization', 'x');
  assert.match(sdd(d, 'tdd', 'red', 'TEST-A-001', '--retest', 'x').out, /REFUSED.*unchanged/);
  const f = path.join(d, 'a.test.mjs');
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('assert.ok(1)', 'assert.ok(2)'));
  assert.equal(sdd(d, 'tdd', 'red', 'TEST-A-001', '--retest').code, 2);
  const r = sdd(d, 'tdd', 'red', 'TEST-A-001', '--retest', 'expectation was wrong');
  assert.match(r.out, /RED ok.*\[weak\]/, r.out);
  assert.equal(sdd(d, 'tdd', 'green', 'TEST-A-001').code, 0);
});

const fakeRun = (d, shellScript) => fs.writeFileSync(path.join(d, '.sdd/config.json'), JSON.stringify({ schemaVersion: 1, testCmd: ['sh', '-c', shellScript, 'x'] }));
const testFile = (d, body) => fs.writeFileSync(path.join(d, 'add.test.mjs'), [
  "import { test } from 'node:test';",
  "import assert from 'node:assert/strict';",
  "import { add } from './add.mjs';",
  '/** @id TEST-CALC-001 @verifies REQ-CALC-001 */',
  "test('TEST-CALC-001 adds', () => {",
  ...body,
  '});',
  '',
].join('\n'));

test('#124 a bare act statement whose side effect is asserted is not a weak Red', () => {
  const d = project();
  sdd(d, 'approve', 'record', 'calc', '--by', 'tester');
  fs.writeFileSync(path.join(d, 'add.mjs'), "export const add = () => { throw new Error('not implemented: add'); };\n");
  testFile(d, ['  globalThis.n = 0;', '  add(1, 2);', '  assert.equal(globalThis.n, 3);']);
  const r = sdd(d, 'tdd', 'red', 'TEST-CALC-001');
  assert.equal(r.code, 0, r.out);
  assert.doesNotMatch(r.out, /\[weak\]/, r.out);
});

test('#124 .NET NotImplementedException without a member name is attributed via the stack frame (weak Red from setup)', () => {
  const d = project();
  sdd(d, 'approve', 'record', 'calc', '--by', 'tester');
  testFile(d, ['  const o = TransitionTo(1);', '  assert.equal(other(), 3);']);
  fakeRun(d, `printf '%s\\n' "System.NotImplementedException : The method or operation is not implemented." "   at Pricing.Order.TransitionTo(Int32 s) in /x/Order.cs:line 3" "   at Pricing.Tests.OrderTests.It() in /x/add.test.mjs:line 6"; exit 1`);
  const r = sdd(d, 'tdd', 'red', 'TEST-CALC-001');
  assert.match(r.out, /\[weak\].*setup call "TransitionTo"/, r.out);
});

test('#124 gate lists weak Red IDs with an actionable hint', () => {
  const d = project();
  sdd(d, 'init');
  sdd(d, 'approve', 'record', 'calc', '--by', 'tester');
  fs.writeFileSync(path.join(d, 'add.mjs'), "export const add = () => { throw new Error('not implemented: add'); };\n");
  testFile(d, ['  const seed = add(0, 0);', '  assert.equal(add(1, 2), 3 + seed);']);
  assert.match(sdd(d, 'tdd', 'red', 'TEST-CALC-001').out, /\[weak\]/);
  impl(d, '(a, b) => a + b');
  testFile(d, ['  const seed = add(0, 0);', '  assert.equal(add(1, 2), 3 + seed);']);
  assert.equal(sdd(d, 'tdd', 'green', 'TEST-CALC-001').code, 0);
  const g = sdd(d, 'gate', '--no-run').out;
  assert.match(g, /1 weak Red.*after Green.*TEST-CALC-001/s, g);
});

test('#125 failure reason shows the assertion (ctest, xUnit, Julia), not summary/stack noise', () => {
  const cases = [
    ['1 - test_s_001 (Failed)\\nk.c:9 CHECK failed: s_add(1, 2) == 3', /fails with: .*CHECK failed: s_add/],
    ['  Assert.Equal() Failure\\n  Expected: 1\\n  Actual:   2', /fails with: Assert\.Equal\(\) Failure/],
    ['System.ArgumentException : weights must sum to 1', /fails with: System\.ArgumentException : weights/],
    ['Test Failed at /x/t.jl:3\\n  Expression: f(1) == 2\\nStacktrace:\\n [1] top-level scope', /fails with: Expression: f\(1\) == 2/],
  ];
  for (const [txt, re] of cases) {
    const d = project();
    sdd(d, 'approve', 'record', 'calc', '--by', 'tester');
    fakeRun(d, `printf '${txt}\\n'; exit 1`);
    const r = sdd(d, 'tdd', 'red', 'TEST-CALC-001');
    assert.match(r.out, re, r.out);
  }
});

test('#125 rejected Green shows the assertion before Maven boilerplate', () => {
  const d = project();
  sdd(d, 'approve', 'record', 'calc', '--by', 'tester');
  const noise = Array.from({ length: 14 }, (_, i) => `[INFO] reactor line ${i}`).join('\\n');
  fakeRun(d, `printf '[ERROR]   MoneyTest.sum:12 expected: <3> but was: <2>\\n${noise}\\n[ERROR] Please refer to surefire\\n'; exit 1`);
  assert.equal(sdd(d, 'tdd', 'red', 'TEST-CALC-001', '--weak').code, 0);
  const r = sdd(d, 'tdd', 'green', 'TEST-CALC-001');
  assert.match(r.out, /GREEN REJECTED/);
  assert.match(r.out, /expected: <3> but was: <2>/, r.out);
});

test('#132 .slnx is detected as .NET; test-less csproj libraries do not become projects', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-'));
  spawnSync('git', ['init', '-q'], { cwd: d });
  fs.writeFileSync(path.join(d, 'R.slnx'), '<Solution />');
  const r = sddRaw(d, 'init');
  assert.doesNotMatch(r.out, /WARNING: stack not recognised/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(d, '.sdd/config.json'), 'utf8')).testCmd.slice(0, 2), ['dotnet', 'test']);

  const m = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-'));
  spawnSync('git', ['init', '-q'], { cwd: m });
  fs.mkdirSync(path.join(m, 'src/Lib'), { recursive: true });
  fs.mkdirSync(path.join(m, 'tests/T'), { recursive: true });
  fs.writeFileSync(path.join(m, 'src/Lib/Lib.csproj'), '<Project Sdk="Microsoft.NET.Sdk"></Project>');
  fs.writeFileSync(path.join(m, 'tests/T/T.csproj'), '<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.0.0" /></ItemGroup></Project>');
  const o = sddRaw(m, 'init');
  const cfg = JSON.parse(fs.readFileSync(path.join(m, '.sdd/config.json'), 'utf8'));
  assert.deepEqual((cfg.projects ?? []).map((p) => p.root), ['tests/T']);
  assert.doesNotMatch(o.out, /testCmd: node/);
});

test('#132 Julia default check falls back to test/runtests.jl with an INFRA message when Pkg.test cannot resolve offline', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-'));
  spawnSync('git', ['init', '-q'], { cwd: d });
  fs.writeFileSync(path.join(d, 'Project.toml'), 'name = "X"\n');
  fs.mkdirSync(path.join(d, 'test'));
  fs.writeFileSync(path.join(d, 'test/runtests.jl'), '');
  sddRaw(d, 'init');
  const check = JSON.parse(fs.readFileSync(path.join(d, '.sdd/config.json'), 'utf8')).checks[0].cmd;
  const bin = path.join(d, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'julia'), '#!/bin/sh\nif [ "$2" = "-e" ]; then echo "ERROR: expected package `Test` to be registered"; exit 1; fi\necho ran-runtests "$@"\n', { mode: 0o755 });
  const r = spawnSync(check[0], check.slice(1), { cwd: d, encoding: 'utf8', env: { ...ENV, PATH: `${bin}:${ENV.PATH}` } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /INFRA.*falling back/);
  assert.match(r.stdout, /ran-runtests --project=\. test\/runtests\.jl/);
});

function tree(files) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-'));
  spawnSync('git', ['init', '-q'], { cwd: d });
  for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), c); }
  return d;
}
const reached = (d, target) => JSON.parse(sddRaw(d, 'impact', target, '--json').out).reachedFiles;

test('#127 impact: unannotated file owned by its directory feature is not "other feature"; test file is labelled test', () => {
  const d = project();
  impl(d, '(a, b) => a + b');
  fs.writeFileSync(path.join(d, 'util.mjs'), 'export const u = 1;\n');
  fs.writeFileSync(path.join(d, 'add.mjs'), fs.readFileSync(path.join(d, 'add.mjs'), 'utf8') + "import { u } from './util.mjs';\nexport const w = u;\n");
  const r = sddRaw(d, 'impact', 'util.mjs');
  assert.doesNotMatch(r.out, /other feature/, r.out);
  const t = sddRaw(d, 'impact', 'add.test.mjs');
  assert.match(t.out, /^\s*test: add\.test\.mjs/m, t.out);
  assert.doesNotMatch(t.out, /impl: add\.test/);
});

test('#127 Rust `use alpha::x` resolves by Cargo package name, not against every crate', () => {
  const d = tree({
    'alpha/Cargo.toml': '[package]\nname = "alpha"\n', 'alpha/src/lib.rs': 'pub mod util;\n', 'alpha/src/util.rs': 'pub fn f() {}\n',
    'beta/Cargo.toml': '[package]\nname = "beta"\n', 'beta/src/lib.rs': 'use alpha::util;\npub fn g() { util::f() }\n',
    'delta/Cargo.toml': '[package]\nname = "delta"\n', 'delta/src/lib.rs': 'pub fn h() {}\n',
  });
  const r = reached(d, 'alpha/src/util.rs');
  assert.ok(r.includes('beta/src/lib.rs'), r.join());
  assert.ok(!r.includes('delta/src/lib.rs'), r.join());
});

test('#127 C includes: quoted relative to includer first, angle includes of project paths, tight .h/.c pairing', () => {
  const d = tree({
    'a/x.h': 'int a(void);\n', 'b/x.h': 'int b(void);\n', 'a/main.c': '#include "x.h"\n#include <stdio.h>\n',
    'include/kv/k.h': 'int k(void);\n', 'src/use.c': '#include <kv/k.h>\n',
    'p/dup.h': '', 'q/dup.c': '#include "dup.h"\n', 'r/dup.h': '', 's/dup.c': '',
  });
  assert.ok(reached(d, 'a/x.h').includes('a/main.c'));
  assert.ok(!reached(d, 'b/x.h').includes('a/main.c'));
  assert.ok(reached(d, 'include/kv/k.h').includes('src/use.c'));
  assert.ok(!reached(d, 'r/dup.h').includes('s/dup.c'), 'ambiguous basenames in different dirs are not paired');
});

test('#127 C# using/namespace and Julia include/using build an import graph', () => {
  const d = tree({
    'src/Lib/Calc.cs': 'namespace Lib;\npublic class Calc { }\n',
    'tests/T/CalcTests.cs': 'using Lib;\npublic class CalcTests { Calc c = new Calc(); }\n',
    'src/a.jl': 'module Ops\nf(x) = x\nend\n', 'test/t.jl': 'include("../src/a.jl")\nusing .Ops\n', 'src/b.jl': 'g(x) = x\n', 'test/u.jl': 'include("../src/b.jl")\n',
  });
  assert.ok(reached(d, 'src/Lib/Calc.cs').includes('tests/T/CalcTests.cs'));
  assert.ok(reached(d, 'src/a.jl').includes('test/t.jl'));
  assert.ok(reached(d, 'src/b.jl').includes('test/u.jl'));
});

test('#133 gate --changed scopes Go packages in a repo without commits', () => {
  const d = tree({ 'go.mod': 'module example.com/b\n\ngo 1.20\n', 'q/q.go': 'package q\n\nfunc Q() int { return 1 }\n', 'q/q_test.go': 'package q\n\nimport "testing"\n\nfunc TestQ(t *testing.T) { _ = Q() }\n' });
  sddRaw(d, 'init');
  const g = sddRaw(d, 'gate', '--changed').out;
  assert.match(g, /scoped → go test example\.com\/b\/q/, g);
  assert.doesNotMatch(g, /cannot scope changes/);
});

test('#133 Maven scope includes dependents and their upstream modules (diamond), not just -am -amd', () => {
  const pom = (id, deps = [], mods = []) => `<project><modelVersion>4.0.0</modelVersion><groupId>g</groupId><artifactId>${id}</artifactId><version>1</version>${mods.length ? `<packaging>pom</packaging><modules>${mods.map((m) => `<module>${m}</module>`).join('')}</modules>` : ''}<dependencies>${deps.map((x) => `<dependency><groupId>g</groupId><artifactId>${x}</artifactId><version>1</version></dependency>`).join('')}</dependencies></project>`;
  const d = tree({
    'pom.xml': pom('root', [], ['money', 'accounts', 'audit', 'journal']),
    'money/pom.xml': pom('money'), 'accounts/pom.xml': pom('accounts', ['money']), 'audit/pom.xml': pom('audit'),
    'journal/pom.xml': pom('journal', ['money', 'accounts', 'audit']),
    'accounts/src/main/java/A.java': 'class A {}\n',
  });
  sddRaw(d, 'init');
  const cfg = JSON.parse(fs.readFileSync(path.join(d, '.sdd/config.json'), 'utf8'));
  assert.ok(!cfg.checks[0].changedCmd.includes('-amd'));
  fs.writeFileSync(path.join(d, '.sdd/config.json'), JSON.stringify({ ...cfg, checks: [{ name: 'test', cmd: ['sh', '-c', 'echo full'], changedCmd: ['echo', 'SCOPE', '{changedModulesCsv}'] }] }));
  const g = sddRaw(d, 'gate', '--changed').out;
  assert.match(g, /SCOPE accounts,audit,journal,money/, g);
});

// ---- dogfood round 6 (#130 Rust/Java/C stubs, #131 PHP/C#/Julia/Python stubs) ----
const mk130 = (files) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-s130-'));
  spawnSync('git', ['init', '-q'], { cwd: d });
  for (const [f, body] of Object.entries({ '.sdd/specs/a.md': T1SPEC, ...files })) { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), body); }
  return d;
};
const rd130 = (d, f) => fs.readFileSync(path.join(d, f), 'utf8');
const has130 = (c) => spawnSync('which', [c]).status === 0;

test('#130 Rust: inline paths + struct literals are stubbed, only for the requested test, with an honest compile verdict', { skip: !has130('cargo') }, () => {
  const toml = '[package]\nname = "s130"\nversion = "0.1.0"\nedition = "2021"\n';
  const one = mk130({ 'Cargo.toml': toml, 'tests/t.rs': '// @id TEST-A-001 @verifies REQ-A-001\n#[test]\nfn t10() {\n    let p = s130::geo::Point { x: 1, y: 2 };\n    assert_eq!(p.x, 1);\n}\n' });
  const out = sdd(one, 'tdd', 'stub', 'TEST-A-001').out;
  assert.match(out, /compile-checked/, out);
  assert.doesNotMatch(out, /Red-safe/);
  assert.match(rd130(one, 'src/geo.rs'), /pub struct Point \{\n    pub x: i64,\n    pub y: i64,/);
  assert.match(rd130(one, 'src/lib.rs'), /pub mod geo;/);
  const two = mk130({ 'Cargo.toml': toml, 'tests/t.rs': 'use s130::util::double;\n// @id TEST-A-001 @verifies REQ-A-001\n#[test]\nfn t9() { assert_eq!(double(2), 4); }\n// @id TEST-A-002 @verifies REQ-A-001\n#[test]\nfn t10() {\n    let p = s130::geo::Point { x: 1, y: 2 };\n    assert_eq!(p.x, 1);\n}\n' });
  const o2 = sdd(two, 'tdd', 'stub', 'TEST-A-002').out;
  assert.ok(fs.existsSync(path.join(two, 'src/geo.rs')));
  assert.ok(!fs.existsSync(path.join(two, 'src/util.rs')), 'other tests symbols are not stubbed');
  assert.match(o2, /does not compile|could not fully stub/, 'an unverified/failed stub is never "Red-safe"');
});

test('#130 Java: typed factories, enum returns, overloads, exceptions and chained results compile', { skip: !has130('javac') }, () => {
  const d = mk130({ 'src/test/java/MoneyTest.java': [
    'public class MoneyTest {',
    '  static void assertEquals(Object a, Object b) {}',
    '  // @id TEST-A-001 @verifies REQ-A-001',
    '  static void t() {',
    '    Currency usd = Currency.of("USD");',
    '    int d = Currency.of("USD").digits();',
    '    Money a = Money.of(1, usd);',
    '    Money b = a.add(a);',
    '    Money z = Money.zero(usd);',
    '    Account acc = new Account("1000", "Cash", AccountType.ASSET, usd);',
    '    assertEquals(AccountType.ASSET, acc.type());',
    '    Chart c = new Chart();',
    '    String n = c.find("1000").name();',
    '    try { z.add(a, 1); } catch (CurrencyMismatchException e) { }',
    '  }',
    '}',
    '',
  ].join('\n') });
  const out = sdd(d, 'tdd', 'stub', 'TEST-A-001').out;
  assert.doesNotMatch(out, /Red-safe/);
  assert.match(out, /compile NOT verified/);
  assert.match(rd130(d, 'src/main/java/Currency.java'), /public static Currency of\(Object a0\)/);
  assert.match(rd130(d, 'src/main/java/Money.java'), /public Money add\(Object a0\)[\s\S]*public Money add\(Object a0, Object a1\)/);
  assert.match(rd130(d, 'src/main/java/CurrencyMismatchException.java'), /extends RuntimeException/);
  const files = ['src/test/java/MoneyTest.java', ...fs.readdirSync(path.join(d, 'src/main/java')).map((f) => `src/main/java/${f}`)];
  const r = spawnSync('javac', ['-d', path.join(d, 'out'), ...files.map((f) => path.join(d, f))], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});

test('#130 C: pointer args from casts/&x/arrays, complete structs for -> access, compile-checked', { skip: !has130('cc') }, () => {
  const d = mk130({ 'include/.keep': '', 'tests/test_d.c': [
    '#include <stdint.h>', '#include <stdio.h>', '#include "d.h"',
    '// @id TEST-A-001 @verifies REQ-A-001',
    'int main(void) {',
    '  uint8_t b[4] = {1, 2, 3, 4};',
    '  size_t n = 0;',
    '  ht_t *t = ht_new();',
    '  ht_entry_t *e = ht_get(t, &n, 1);',
    '  ht_put(t, (uint8_t *)"k", 1, (const uint8_t *)"val", 3);',
    '  return d_sum(b, 4) == 10 && e->vlen == 3 ? 0 : 1;',
    '}', '',
  ].join('\n') });
  const out = sdd(d, 'tdd', 'stub', 'TEST-A-001').out;
  assert.match(out, /compile-checked/, out);
  const h = rd130(d, 'include/d.h');
  assert.match(h, /d_sum\(uint8_t \* a0, int a1\)/);
  assert.match(h, /ht_put\(ht_t \* a0, uint8_t \* a1, int a2, const uint8_t \* a3, int a4\)/);
  assert.match(h, /typedef struct ht_entry \{\n    long vlen;/);
  assert.equal(spawnSync('cc', ['-fsyntax-only', '-I', path.join(d, 'include'), path.join(d, 'tests/test_d.c')]).status, 0);
});

test('#131 PHP: no PHPUnit TestCase stub, catch-only exceptions extend \\Exception, instance methods stubbed', { skip: !has130('php') }, () => {
  const d = mk130({ 'composer.json': '{"autoload":{"psr-4":{"App\\\\":"src/"}}}', 'tests/RoleTest.php': [
    '<?php', 'use PHPUnit\\Framework\\TestCase;', 'use App\\Roles\\RoleHierarchy;', 'use App\\ParseException;',
    'final class RoleTest extends TestCase {',
    '  // @id TEST-A-001 @verifies REQ-A-001',
    '  public function test_a_001() {',
    '    $h = new RoleHierarchy();',
    '    $h->addRole("x");',
    '    try { $h->check(); } catch (ParseException $e) { $this->assertTrue(true); }',
    '  }', '}', '',
  ].join('\n') });
  sdd(d, 'tdd', 'stub', 'TEST-A-001');
  assert.ok(!fs.existsSync(path.join(d, 'src/Framework')), 'PHPUnit classes are never stubbed');
  assert.match(rd130(d, 'src/Roles/RoleHierarchy.php'), /public function addRole\(/);
  assert.match(rd130(d, 'src/Roles/RoleHierarchy.php'), /public function check\(/);
  assert.match(rd130(d, 'src/ParseException.php'), /class ParseException extends \\Exception/);
  for (const f of ['src/Roles/RoleHierarchy.php', 'src/ParseException.php']) assert.equal(spawnSync('php', ['-l', path.join(d, f)]).status, 0);
});

test('#131 Julia: module-wrapped stub, exception structs, no test-local or already-included names', () => {
  const d = mk130({ 'Project.toml': 'name = "X"\n', 'src/b.jl': 'helper(x) = x\n', 'test/a_tests.jl': [
    'include("../src/b.jl")', 'include("../src/a.jl")', 'using .Ops',
    'const F2(x) = x + 1',
    'f, g = pair()',
    '# @id TEST-A-001 @verifies REQ-A-001',
    '@testset "TEST-A-001" begin',
    '  @test_throws SingularError solve(F2, helper(1))',
    '  @test f(1) == 2',
    'end', '',
  ].join('\n') });
  sdd(d, 'tdd', 'stub', 'TEST-A-001');
  const s = rd130(d, 'src/a.jl');
  assert.match(s, /^module Ops\n/);
  assert.match(s, /export solve, pair, SingularError|export [\w, ]*SingularError/);
  assert.match(s, /struct SingularError <: Exception end/);
  assert.match(s, /solve\(args\.\.\.; kwargs\.\.\.\) = error/);
  assert.doesNotMatch(s, /F2|helper|\bg\(|\bf\(/);
  assert.match(s, /end # module Ops/);
});

test('#131 Python: only the SUT variable gets methods; pytest pythonpath = src is honored', () => {
  const d = mk130({ 'pytest.ini': '[pytest]\npythonpath = src\n', 'tests/test_m.py': [
    'from wf.eng import Eng', '', 'def make():', '    log = []', '    return Eng(log), log', '',
    '# @id TEST-A-001', '# @verifies REQ-A-001', 'def test_m():', '    eng, log = make()', '    eng.run()', '    assert log.count("x") == 1', '',
  ].join('\n') });
  sdd(d, 'tdd', 'stub', 'TEST-A-001');
  const s = rd130(d, 'src/wf/eng.py');
  assert.match(s, /def run\(self/);
  assert.doesNotMatch(s, /def count/);
  assert.ok(!fs.existsSync(path.join(d, 'wf/eng.py')), 'stub honors pythonpath');
});

test('#130/#131 stub messages: no "no missing relative imports" for non-JS languages, no stub/red advice loop', () => {
  const d = mk130({ 'tests/FooTest.cs': '// @id TEST-A-001 @verifies REQ-A-001\npublic class FooTest { }\n' });
  const out = sdd(d, 'tdd', 'stub', 'TEST-A-001').out;
  assert.doesNotMatch(out, /no missing relative imports/);
  assert.match(out, /nothing to stub/);
  const m = mini(T1SPEC, { 'a.test.mjs': jsTest() }, PASS);
  fs.writeFileSync(path.join(m, 'a.test.mjs'), jsTest().replace('assert.ok(1)', 'assert.ok(1)').replace(/^/, "import { x } from './nomod.mjs';\n"));
  setCmd(m, ['node', '-e', "console.log(\"Cannot find module './nomod.mjs'\");process.exit(1)"]);
  const r = sdd(m, 'tdd', 'red', 'TEST-A-001');
  assert.match(r.out, /stub already ran or found nothing/);
});

// ---- #150/#151 stub regressions (PHP/C#, Julia/TS/JS) ----
test('#150 PHP stub: namespace-aware project class check, class constants / enum cases via `use`', { skip: !has130('php') }, () => {
  const d = mk130({
    'composer.json': '{"autoload":{"psr-4":{"App\\\\":"src/"}}}',
    'src/Sdl/Parser.php': '<?php\nnamespace App\\Sdl;\nclass Parser { }\n',
    'tests/QTest.php': [
      '<?php', 'use App\\Query\\Parser;', 'use App\\Query\\Color;', 'use App\\Query\\Cfg;', '',
      '// @id TEST-A-001 @verifies REQ-A-001', 'final class QTest { function test_a_001() { Parser::parse("x"); $a = Color::RED->value; $b = Cfg::LIMIT; } }', '',
    ].join('\n'),
  });
  const out = sdd(d, 'tdd', 'stub', 'TEST-A-001').out;
  assert.match(rd130(d, 'src/Query/Parser.php'), /namespace App\\Query;[\s\S]*class Parser[\s\S]*static function parse/, out);
  assert.match(rd130(d, 'src/Query/Color.php'), /enum Color: string[\s\S]*case RED = 'RED'/);
  assert.match(rd130(d, 'src/Query/Cfg.php'), /class Cfg[\s\S]*const LIMIT/);
  fs.rmSync(path.join(d, 'src/Query'), { recursive: true });
  sdd(d, 'init');
  setCmd(d, ['node', '-e', "console.log('Error: Class \"App\\\\Query\\\\Parser\" not found');process.exit(1)"]);
  const r = sdd(d, 'tdd', 'red', 'TEST-A-001', '--missing-module');
  assert.doesNotMatch(r.out, /REJECTED/, r.out);
});

test('#150 C# stub: production namespace (not the test namespace), helper return types are not static, `is X` types, CS1501 members, deduped notes', { skip: spawnSync('dotnet', ['--version'], { stdio: 'ignore' }).status !== 0 }, (t) => {
  const MARK = '// sdd-stub: throwing stub generated by `tdd stub` — replace with the real implementation';
  const d = tree({
    'src/Lib/Lib.csproj': libProj(),
    'src/Lib/AuditTrail.cs': `${MARK}\nnamespace Lib;\n\npublic class AuditTrail : System.Collections.Generic.IEnumerable<string>\n{\n    public System.Collections.Generic.IEnumerator<string> GetEnumerator() => throw new System.NotImplementedException();\n    System.Collections.IEnumerator System.Collections.IEnumerable.GetEnumerator() => throw new System.NotImplementedException();\n}\n`,
    'tests/T/Lib.Tests.csproj': testProj(XUNIT, ['..\\..\\src\\Lib\\Lib.csproj']),
    'tests/T/SrcTests.cs': [
      'using Xunit;', 'using Lib;', '', 'namespace Lib.Tests;', '', 'public class SrcTests', '{',
      '    static ErrorInfo Err(string s) { var r = new Runner().Run(s); return r.Error!; }', '',
      '    /** @id TEST-A-001 @verifies REQ-A-001 */', '    [Fact]', '    public void a()', '    {',
      '        var tr = new AuditTrail();', '        tr.Append("a", "b", "c", "d");', '        object o = Err("x");', '        Assert.True(o is ErrorStmt);', '        Assert.Equal(0, new Source("abc").PosAt(0));', '    }', '}', '',
    ].join('\n'),
  });
  if (!restores(d, 'tests/T/Lib.Tests.csproj')) return t.skip('NuGet packages cannot be restored');
  const r = sddRaw(d, 'tdd', 'stub', 'TEST-A-001');
  const rd = (f) => fs.readFileSync(path.join(d, 'src/Lib', f), 'utf8');
  assert.match(rd('Source.cs'), /^namespace Lib;$/m, r.out);
  assert.doesNotMatch(rd('Source.cs'), /Tests/);
  assert.match(rd('ErrorInfo.cs'), /public class ErrorInfo/, r.out);
  assert.match(rd('ErrorStmt.cs'), /public class ErrorStmt/, r.out);
  assert.match(rd('AuditTrail.cs'), /Append\(/, r.out);
  assert.ok(!/CS1501/.test(r.out.replace(/NOT compile-checked[^\n]*/, '')) || /Append/.test(rd('AuditTrail.cs')));
});

test('#150 gate --changed without any commit says so', () => {
  const d = mini(T1SPEC, { 'a.test.mjs': jsTest() }, PASS);
  const out = sddRaw(d, 'gate', '--changed').out;
  assert.ok(!/cannot scope changes/.test(out) || /no commit yet/.test(out), out);
});

test('#151 TS stub: barrel re-exports are not shadowed, new C<T>() methods are stubbed, no Array methods invented on Box, error classes extend Error', () => {
  const d = mk130({
    'package.json': '{"name":"root","private":true,"workspaces":["packages/*"]}',
    'packages/core/package.json': '{"name":"@ot/core","main":"src/index.ts"}',
    'packages/core/src/index.ts': "export * from './ops';\n",
    'packages/core/src/ops.ts': 'export function apply(a: number) { return a; }\nexport type Op = number;\n',
    'packages/server/package.json': '{"name":"@ot/server"}',
    'packages/server/test/a.test.ts': [
      "import { it, expect } from 'vitest';", "import { apply, type Op } from '@ot/core';",
      "import { Box, Foo, ParseError } from '../src/box';",
      'function mk() { const out: number[] = []; return { b: new Box((n: number) => out.push(n)), out }; }',
      '/** @id TEST-A-001 @verifies REQ-A-001 */', "it('TEST-A-001 x', () => {", '  const { b, out } = mk();', '  b.go();',
      '  const f = new Foo<string>(1); f.run(2);', '  expect(out.map((x) => x + 1)).toEqual([2]);', '  expect(() => apply(1)).toThrow(ParseError);', '});', '',
    ].join('\n'),
  });
  sdd(d, 'tdd', 'stub', 'TEST-A-001');
  assert.equal(rd130(d, 'packages/core/src/index.ts'), "export * from './ops';\n");
  const b = rd130(d, 'packages/server/src/box.ts');
  assert.match(b, /go\(/);
  assert.doesNotMatch(b, /\bpush\(|\bmap\(/);
  assert.match(b, /class Foo[\s\S]*run\(/);
  assert.match(b, /class ParseError extends Error/);
});

test('#151 JS stub: `import * as ns from "../src/ns.js"` does not invent an export from the path text', () => {
  const d = mk130({ 'test/a.test.mjs': ["import * as ns from '../src/ns.js';", '// @id TEST-A-001 @verifies REQ-A-001', "test('x', () => { ns.add(1, 2); });", ''].join('\n') });
  sdd(d, 'tdd', 'stub', 'TEST-A-001');
  const s = rd130(d, 'src/ns.js');
  assert.match(s, /export function add/);
  assert.doesNotMatch(s, /export const js\b/);
});

test('#151 Julia stub: appends missing functions to an existing included file, `!` names, module name follows the missing include', { skip: !has130('julia') }, () => {
  const d = mk130({ 'Project.toml': 'name = "X"\n', 'src/A.jl': 'module A\nexport f\nf() = 1\nend\n', 'test/t.jl': [
    'include("../src/A.jl")', 'include("../src/B.jl")', 'using .A', 'using .B',
    '# @id TEST-A-001 @verifies REQ-A-001', '@testset "TEST-A-001" begin', '  r = g()', '  @test next_u64!(r) == 5', 'end', '',
  ].join('\n') });
  sdd(d, 'tdd', 'stub', 'TEST-A-001');
  const b = rd130(d, 'src/B.jl');
  assert.match(b, /^module B\n/);
  assert.match(b, /next_u64!\(args\.\.\.; kwargs\.\.\.\) = error/);
  assert.match(b, /export [^\n]*next_u64!/);
  // existing included file: only the missing name is appended inside its module
  fs.writeFileSync(path.join(d, 'test/t.jl'), rd130(d, 'test/t.jl').replace('r = g()', 'r = g()\n  h2()'));
  fs.rmSync(path.join(d, 'src/B.jl'));
  sdd(d, 'tdd', 'stub', 'TEST-A-001');
  fs.writeFileSync(path.join(d, 'test/t.jl'), rd130(d, 'test/t.jl').replace('h2()', 'h2()\n  h3!()'));
  const out = sdd(d, 'tdd', 'stub', 'TEST-A-001').out;
  const b2 = rd130(d, 'src/B.jl');
  assert.match(b2, /h3!\(args/, out);
  assert.match(b2, /export [^\n]*h3!/);
  assert.equal((b2.match(/^module B/gm) ?? []).length, 1);
  assert.equal((b2.match(/^end # module B/gm) ?? []).length, 1);
});

// ---- .NET: ProjectReference graph, scoped gate, C# stubs, NUnit/MSTest (#135 #136 #137) ----
const HAS_DOTNET = spawnSync('dotnet', ['--version'], { stdio: 'ignore' }).status === 0;
const DN = { skip: HAS_DOTNET ? false : 'dotnet SDK not installed' };
const TFM = '<TargetFramework>net10.0</TargetFramework><Nullable>enable</Nullable><ImplicitUsings>enable</ImplicitUsings>';
const libProj = (refs = []) => `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup>${TFM}</PropertyGroup>${refs.length ? `<ItemGroup>${refs.map((r) => `<ProjectReference Include="${r}" />`).join('')}</ItemGroup>` : ''}</Project>`;
const testProj = (pkgs, refs = []) => `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup>${TFM}<IsPackable>false</IsPackable></PropertyGroup><ItemGroup>${pkgs.map(([n, v]) => `<PackageReference Include="${n}" Version="${v}" />`).join('')}${refs.map((r) => `<ProjectReference Include="${r}" />`).join('')}</ItemGroup></Project>`;
const XUNIT = [['Microsoft.NET.Test.Sdk', '17.14.1'], ['xunit', '2.9.3'], ['xunit.runner.visualstudio', '3.1.4']];
const restores = (d, proj) => spawnSync('dotnet', ['restore', proj, '--nologo', '-v', 'q'], { cwd: d, encoding: 'utf8', timeout: 240000 }).status === 0;
const gitCommit = (d) => { spawnSync('git', ['add', '-A'], { cwd: d }); spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base'], { cwd: d }); };

test('#135 impact follows csproj ProjectReference: usings only link to referenced projects; csproj/props/solution are graph nodes', () => {
  const d = tree({
    'Directory.Build.props': '<Project />',
    'src/Lib/Lib.csproj': libProj(), 'src/Lib/Calc.cs': 'namespace Shared;\npublic class Calc { }\n',
    'src/Other/Other.csproj': libProj(), 'src/Other/Calc.cs': 'namespace Shared;\npublic class Calc { }\n',
    'tests/T/T.csproj': testProj(XUNIT, ['..\\..\\src\\Lib\\Lib.csproj']),
    'tests/T/CalcTests.cs': 'using Shared;\npublic class CalcTests { Calc c = new Calc(); }\n',
    'App.slnx': '<Solution><Project Path="src/Lib/Lib.csproj" /><Project Path="tests/T/T.csproj" /></Solution>',
  });
  const lib = reached(d, 'src/Lib/Calc.cs');
  assert.ok(lib.includes('tests/T/CalcTests.cs'), lib.join());
  assert.ok(!reached(d, 'src/Other/Calc.cs').includes('tests/T/CalcTests.cs'), 'an unreferenced project does not feed the test project');
  assert.ok(reached(d, 'src/Lib/Lib.csproj').includes('tests/T/CalcTests.cs'), 'a changed csproj reaches dependents');
  assert.ok(reached(d, 'Directory.Build.props').includes('tests/T/CalcTests.cs'), 'shared props reach every project below');
  assert.ok(reached(d, 'App.slnx').includes('src/Lib/Lib.csproj'), 'solution membership');
});

test('#135 default .NET changedCmd runs only changed test projects and test projects depending on changed projects; shared files fall back to the full run', () => {
  const d = tree({
    'App.slnx': '<Solution />',
    'src/Lib/Lib.csproj': libProj(), 'src/Lib/Calc.cs': 'namespace Lib;\npublic class Calc { }\n',
    'src/Core/Core.csproj': libProj(['..\\Lib\\Lib.csproj']), 'src/Core/C.cs': 'namespace Core;\npublic class C { }\n',
    'src/Solo/Solo.csproj': libProj(), 'src/Solo/S.cs': 'namespace Solo;\npublic class S { }\n',
    'tests/A/A.csproj': testProj(XUNIT, ['../../src/Core/Core.csproj']), 'tests/A/A.cs': 'public class A { }\n',
    'tests/B/B.csproj': testProj(XUNIT, ['../../src/Solo/Solo.csproj']), 'tests/B/B.cs': 'public class B { }\n',
    'README.md': 'x\n',
  });
  sddRaw(d, 'init');
  const cp = path.join(d, '.sdd/config.json');
  const cfg = JSON.parse(fs.readFileSync(cp, 'utf8'));
  const chk = cfg.checks.find((c) => c.name === 'test');
  assert.ok(chk.changedCmd.includes('{changedTestProjects}'), JSON.stringify(chk));
  assert.match(chk.changedCmd.join(' '), /dotnet test/);
  fs.writeFileSync(cp, JSON.stringify({ ...cfg, projects: undefined, checks: [{ name: 'test', cmd: ['echo', 'FULL'], changedCmd: ['echo', 'SCOPE', '{changedTestProjects}'] }] }));
  gitCommit(d);
  fs.appendFileSync(path.join(d, 'src/Lib/Calc.cs'), '// edit\n');
  let g = sddRaw(d, 'gate', '--changed').out;
  assert.match(g, /SCOPE tests\/A\/A\.csproj\b(?! tests\/B)/, g);
  assert.doesNotMatch(g, /tests\/B\/B\.csproj/, g);
  fs.appendFileSync(path.join(d, 'tests/B/B.cs'), '// edit\n');
  g = sddRaw(d, 'gate', '--changed').out;
  assert.match(g, /SCOPE tests\/A\/A\.csproj tests\/B\/B\.csproj/, g);
  gitCommit(d);
  fs.appendFileSync(path.join(d, 'README.md'), 'more\n');
  g = sddRaw(d, 'gate', '--changed').out;
  assert.match(g, /cannot scope changes for \{changedTestProjects\} — running the full check/, g);
  gitCommit(d);
  fs.writeFileSync(path.join(d, 'Directory.Build.props'), '<Project />');
  g = sddRaw(d, 'gate', '--changed').out;
  assert.match(g, /cannot scope changes for \{changedTestProjects\}/, g);
});

test('#135 nested .NET test projects depend on the projects they reference (transitively)', () => {
  const d = tree({
    'src/Lib/Lib.csproj': libProj(), 'src/Core/Core.csproj': libProj(['../Lib/Lib.csproj']),
    'tests/A/A.csproj': testProj(XUNIT, ['../../src/Core/Core.csproj']),
  });
  sddRaw(d, 'init');
  const cfg = JSON.parse(fs.readFileSync(path.join(d, '.sdd/config.json'), 'utf8'));
  const p = cfg.projects.find((x) => x.root === 'tests/A');
  assert.deepEqual([...p.dependsOn].sort(), ['src/Core', 'src/Lib']);
});

test('#137 build output (bin/, obj/) next to a .NET project is never scanned for @id, even without .gitignore', () => {
  const d = tree({
    'T/T.csproj': testProj(XUNIT),
    'T/obj/Debug/net10.0/Gen.cs': '// @id TEST-OBJ-001 @verifies REQ-X-001\npublic class G { }\n',
    'T/bin/Debug/net10.0/Gen2.cs': '// @id TEST-BIN-001 @verifies REQ-X-001\npublic class G2 { }\n',
    'T/Real.cs': '// @id TEST-REAL-001 @verifies REQ-X-001\npublic class R { }\n',
    'tools/bin/run.js': '// @id TEST-JS-001 @verifies REQ-X-001\n',
  });
  assert.match(sddRaw(d, 'impact', 'TEST-OBJ-001').out, /unknown target/);
  assert.match(sddRaw(d, 'impact', 'TEST-BIN-001').out, /unknown target/);
  assert.match(sddRaw(d, 'impact', 'TEST-REAL-001').out, /IMPACT TEST-REAL-001/);
  assert.match(sddRaw(d, 'impact', 'TEST-JS-001').out, /IMPACT TEST-JS-001/, 'bin/ without a project file is untouched');
});

test('#137 NUnit/MSTest attributes are not the test name: the method below @id is used for --filter', () => {
  const body = (attr) => `namespace T;\npublic class Tests\n{\n    // @id TEST-A-001 @verifies REQ-A-001\n    ${attr}\n    ${attr === '[Test]' ? '' : '[Description("x(1)")]\n    '}public void Adds_Numbers(int x) { }\n}\n`;
  for (const attr of ['[TestCase(1, 2)]', '[TestMethod]', '[DataRow(1)]', '[Test]']) {
    const d = mini(T1SPEC, { 'T/Tests.cs': body(attr) }, ['node', '-e', 'console.log("AssertionError: name=" + process.argv[1]); process.exit(1)', '{idu}']);
    const r = sdd(d, 'tdd', 'red', 'TEST-A-001', '--expect', 'name=Adds_Numbers');
    assert.equal(r.code, 0, `${attr}: ${r.out}`);
  }
});

test('#137 dotnet test gets --no-build only for a repeat run with an unchanged tree and a clean previous build', () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-fake-'));
  const log = path.join(bin, 'calls.log');
  fs.writeFileSync(path.join(bin, 'dotnet'), `#!/bin/sh\necho "$@" >> "${log}"\nif [ "$1" = "--version" ]; then echo 10.0.0; exit 0; fi\nif [ -n "$FAKE_BUILD_ERROR" ]; then echo "T.cs(1,1): error CS0103: nope"; fi\necho "Failed!  - Failed: 1, Passed: 0, Total: 1"\necho "Assert.Equal() Failure"\nexit 1\n`, { mode: 0o755 });
  const spec = '---\nfeature: a\ntier: T1\n---\n| REQ-A-001 | one shall hold. | TEST-A-001 |\n| REQ-A-002 | two shall hold. | TEST-A-002 |\n';
  const mk = () => mini(spec, { 'T/T.csproj': testProj(XUNIT), 'T/Tests.cs': '// @id TEST-A-001 @verifies REQ-A-001\npublic class A { }\n// @id TEST-A-002 @verifies REQ-A-002\npublic class B { }\n' }, ['dotnet', 'test', 'T', '--nologo', '--filter', 'FullyQualifiedName~{idu}']);
  const go = (d, env) => { fs.rmSync(log, { force: true }); spawnSync('node', [SDD, '--root', d, 'tdd', 'red', 'TEST-A-001', 'TEST-A-002', '--weak'], { encoding: 'utf8', env: { ...ENV, PATH: `${bin}:${process.env.PATH}`, ...env } }); return fs.readFileSync(log, 'utf8').trim().split('\n').filter((l) => /^test/.test(l)); };
  const ok = go(mk(), {});
  assert.equal(ok.length, 2, ok.join('\n'));
  assert.doesNotMatch(ok[0], /--no-build/);
  assert.match(ok[1], /^test --no-build /);
  const broken = go(mk(), { FAKE_BUILD_ERROR: '1' });
  assert.doesNotMatch(broken.join('\n'), /--no-build/, 'a failed build is never reused');
});

test('#136 C# tdd stub: diagnostics-driven throwing stubs, scoped to the requested test, compile-checked only when the build passes', DN, (t) => {
  const d = tree({
    'src/Lib/Lib.csproj': libProj(),
    'tests/T/T.csproj': testProj(XUNIT, ['..\\..\\src\\Lib\\Lib.csproj']),
    'tests/T/CalcTests.cs': [
      'using Xunit;', 'using Lib.Calc;', '', 'namespace T;', '', 'public class CalcTests', '{',
      '    /** @id TEST-A-001 @verifies REQ-A-001 */', '    [Fact]', '    public void adds()', '    {',
      '        var m = Money.Of(1m, "USD") + Money.Of(2m, "USD");', '        Assert.Equal(3m, m.Amount);', '        Assert.Equal(Mode.Up, Rounder.Pick(m.Amount));',
      '        var c = new Counter(5);', '        c.Inc();', '        c.Label = "x";', '        Assert.Throws<BadThingException>(() => c.Inc());', '    }', '',
      '    /** @id TEST-A-002 @verifies REQ-A-002 */', '    [Fact]', '    public void other()', '    {', '        Assert.Equal(1, Other.Thing());', '    }', '}', '',
    ].join('\n'),
  });
  if (!restores(d, 'tests/T/T.csproj')) return t.skip('NuGet packages cannot be restored');
  const r = sddRaw(d, 'tdd', 'stub', 'TEST-A-001');
  for (const f of ['Money', 'Mode', 'Rounder', 'Counter', 'BadThingException']) assert.ok(fs.existsSync(path.join(d, 'src/Lib', f + '.cs')), `${f}.cs\n${r.out}`);
  assert.ok(!fs.existsSync(path.join(d, 'src/Lib/Other.cs')), 'symbols of other tests are not stubbed');
  assert.doesNotMatch(r.out, /compile-checked\)/, 'the sibling test still fails to compile, so the verdict must not claim compile-checked');
  assert.match(r.out, /NOT compile-checked/);
  assert.match(r.out, /CS0103 The name 'Other'/);
  assert.match(fs.readFileSync(path.join(d, 'src/Lib/BadThingException.cs'), 'utf8'), /: System\.Exception/);
  assert.match(fs.readFileSync(path.join(d, 'src/Lib/Mode.cs'), 'utf8'), /enum Mode/);
  // single-test file: the build passes, so the verdict is compile-checked and the stubs throw at run time
  fs.writeFileSync(path.join(d, 'tests/T/CalcTests.cs'), fs.readFileSync(path.join(d, 'tests/T/CalcTests.cs'), 'utf8').replace('Other.Thing()', '1'));
  fs.writeFileSync(path.join(d, 'tests/T/CalcTests.cs'), fs.readFileSync(path.join(d, 'tests/T/CalcTests.cs'), 'utf8').replace('c.Label = "x";', 'c.Label = "x"; Assert.Equal(1, c.Total);'));
  const r2 = sddRaw(d, 'tdd', 'stub', 'TEST-A-001');
  assert.match(r2.out, /stubbed \(throwing, compile-checked\): src\/Lib\/Counter\.cs/, r2.out);
  const run = spawnSync('dotnet', ['test', 'tests/T', '--nologo', '--filter', 'FullyQualifiedName~adds'], { cwd: d, encoding: 'utf8', timeout: 240000 });
  assert.match(run.stdout, /NotImplementedException/);
});

test('#136 C# tdd stub without a project file or without a restorable build says so instead of claiming a verdict', DN, () => {
  const d = tree({ 'tests/FooTest.cs': '// @id TEST-A-001 @verifies REQ-A-001\npublic class FooTest { void X() { var a = new Missing(); } }\n' });
  assert.match(sddRaw(d, 'tdd', 'stub', 'TEST-A-001').out, /nothing to stub/);
  const e = tree({
    'T/T.csproj': testProj([['Definitely.Not.A.Package.Sdd', '9.9.9']]),
    'T/FooTest.cs': '// @id TEST-A-001 @verifies REQ-A-001\npublic class FooTest { void X() { var a = new Missing(); } }\n',
  });
  const r = sddRaw(e, 'tdd', 'stub', 'TEST-A-001');
  assert.doesNotMatch(r.out, /compile-checked\)/);
  assert.ok(!fs.existsSync(path.join(e, 'T/Missing.cs')), r.out);
});

for (const [name, pkgs, usingNs, attr, assertFail] of [
  ['NUnit', [['Microsoft.NET.Test.Sdk', '17.14.0'], ['NUnit', '4.3.2'], ['NUnit3TestAdapter', '5.0.0']], 'NUnit.Framework', '[TestCase(1)]', 'Assert.That(x + 1, Is.EqualTo(99));'],
  ['MSTest', [['Microsoft.NET.Test.Sdk', '17.14.0'], ['MSTest.TestFramework', '3.9.3'], ['MSTest.TestAdapter', '3.9.3']], 'Microsoft.VisualStudio.TestTools.UnitTesting', '[TestMethod]', 'Assert.AreEqual(99, 1);'],
]) {
  test(`#137 ${name}: red filters by @id through the test method name, and the second batch run reuses the build`, DN, (t) => {
    const cls = name === 'MSTest' ? '[TestClass]\npublic class Tests' : 'public class Tests';
    const spec = '---\nfeature: a\ntier: T1\n---\n| REQ-A-001 | one shall hold. | TEST-A-001 |\n| REQ-A-002 | two shall hold. | TEST-A-002 |\n';
    const d = mini(spec, {
      'T/T.csproj': testProj(pkgs),
      'T/Tests.cs': `using ${usingNs};\nnamespace T;\n${cls}\n{\n    // @id TEST-A-001 @verifies REQ-A-001\n    ${attr}\n    public void Adds_Numbers(${name === 'NUnit' ? 'int x' : ''}) { ${name === 'NUnit' ? assertFail : assertFail} }\n\n    // @id TEST-A-002 @verifies REQ-A-002\n    ${name === 'NUnit' ? '[Test]' : '[TestMethod]'}\n    public void Subtracts() { ${assertFail.replace('x + 1', '1')} }\n}\n`,
    }, ['dotnet', 'test', 'T', '--nologo', '--filter', 'FullyQualifiedName~{idu}']);
    if (!restores(d, 'T/T.csproj')) return t.skip(`${name} packages cannot be restored (offline?)`);
    const r = sdd(d, 'tdd', 'red', 'TEST-A-001', 'TEST-A-002');
    assert.match(r.out, /RED ok TEST-A-001/, r.out);
    assert.match(r.out, /RED ok TEST-A-002/, r.out);
    assert.doesNotMatch(r.out, /no test matched/);
  });
}

test('#138 review check: Pending/Reopened/Unresolved are open; missing file/feature are errors; approve --review missing path refused', () => {
  const d = project();
  sdd(d, 'init');
  const h = /sha256:([0-9a-f]{64})/.exec(sdd(d, 'approve', 'prepare', 'calc').out)[1];
  for (const st of ['Pending', 'Reopened', 'Unresolved']) {
    fs.writeFileSync(path.join(d, '.sdd/review.md'), `spec: sha256:${h}\nverdict: pass\nopen: 0\n\n| ID | Sev | Where | Status |\n|---|---|---|---|\n| F1 | high | x | ${st} |\n`);
    const r = sdd(d, 'review', 'check', '.sdd/review.md', '--feature', 'calc');
    assert.equal(r.code, 1, `${st}: ${r.out}`);
    assert.match(r.out, /Open finding/);
  }
  assert.equal(sdd(d, 'review', 'check', '.sdd/nope.md', '--feature', 'calc').code, 2);
  assert.match(sdd(d, 'review', 'check', '.sdd/nope.md', '--feature', 'calc').out, /not found/);
  assert.match(sdd(d, 'review', 'check', '.sdd/review.md', '--feature', 'zzz').out, /unknown feature/);
  assert.equal(sdd(d, 'review', 'check', '.sdd/review.md').code, 2);
  assert.equal(sdd(d, 'review', 'template', 'zzz').code, 2);
  assert.equal(sdd(d, 'review', 'template').code, 2);
  const a = sdd(d, 'approve', 'record', 'calc', '--by', 'ai:r1', '--review', '.sdd/missing-review.md');
  assert.equal(a.code, 1, a.out);
  assert.match(a.out, /does not exist/);
});

test('#139 gate reports --retest Reds separately from characterization, listing IDs', () => {
  const d = mini(T1SPEC, { 'a.test.mjs': jsTest() }, PASS);
  sdd(d, 'tdd', 'red', 'TEST-A-001', '--characterization', 'x');
  const f = path.join(d, 'a.test.mjs');
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('assert.ok(1)', 'assert.ok(2)'));
  sdd(d, 'tdd', 'red', 'TEST-A-001', '--retest', 'expectation was wrong');
  sdd(d, 'tdd', 'green', 'TEST-A-001');
  const g = sdd(d, 'gate', '--no-run').out;
  assert.match(g, /1 retest/);
  assert.match(g, /TEST-A-001/);
  assert.doesNotMatch(g, /characterization: passed/);
});

test('#140 skipped runs (node:test ℹ skipped, PHPUnit skipped/no assertions) are not Red/Green/characterization', () => {
  for (const o of ['ℹ tests 1\nℹ pass 0\nℹ fail 0\nℹ cancelled 0\nℹ skipped 1\nTEST-CALC-001', 'OK, but some tests were skipped!\nTests: 1, Assertions: 0, Skipped: 1.\ntest_calc_001']) {
    const d = project();
    sdd(d, 'approve', 'record', 'calc', '--by', 'tester');
    fs.writeFileSync(path.join(d, '.sdd/config.json'), JSON.stringify({ schemaVersion: 1, testCmd: ['sh', '-c', 'printf "%s\\n" "$0"; exit 0', o] }));
    const r = sdd(d, 'tdd', 'red', 'TEST-CALC-001', '--characterization', 'x');
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /skipped/);
  }
});

test('#141 default node pattern is token-anchored; {idu} keeps the case used in the test file', () => {
  const d = project();
  sdd(d, 'init');
  const c = JSON.parse(fs.readFileSync(path.join(d, '.sdd/config.json'), 'utf8'));
  const re = new RegExp(c.testCmd[c.testCmd.indexOf('--test-name-pattern') + 1].replace('{id}', 'TEST-S-001'));
  assert.ok(re.test('TEST-S-001 x'));
  assert.ok(!re.test('TEST-S-0011 x'));
  const e = project();
  fs.rmSync(path.join(e, 'add.test.mjs'));
  fs.writeFileSync(path.join(e, 'T.cs'), '// @id TEST-CALC-001 @verifies REQ-CALC-001\n[Test] public void TEST_CALC_001_Adds() {}\n');
  fs.writeFileSync(path.join(e, 'x.csproj'), '<Project/>');
  sdd(e, 'approve', 'record', 'calc', '--by', 'tester');
  fs.writeFileSync(path.join(e, '.sdd/config.json'), JSON.stringify({ schemaVersion: 1, testCmd: ['sh', '-c', 'echo "FAIL $0"; exit 1', '{idu}'] }));
  fs.rmSync(path.join(e, 'T.cs'));
  fs.writeFileSync(path.join(e, 'add.test.mjs'), '// @id TEST-CALC-001 @verifies REQ-CALC-001\n// TEST_CALC_001 Adds\n');
  assert.match(sdd(e, 'tdd', 'red', 'TEST-CALC-001').out, /fails with: FAIL TEST_CALC_001/);
});

// ---- dogfood round 6 stub fixes (#147 Python, #148 Go, #149 Rust/Java/C++) ----
test('#147 Python stub: scoped to the requested test, variable rebinding and helper-built classes attribute methods to the right class', () => {
  const d = mk130({ 'pytest.ini': '[pytest]\npythonpath = src\n', 'tests/test_m.py': [
    'from pk.m import Counter, Sub, Catalog, Column', '',
    'def make():', '    cat = Catalog()', '    cat.create_table("P", [Column("id")])', '    return cat', '',
    '# @id TEST-A-001', '# @verifies REQ-A-001', 'def test_a():', '    s = Counter()', '    s.fresh()', '    cat = make()', '    cat.table("P")', '',
    '# @id TEST-A-002', '# @verifies REQ-A-001', 'def test_b():', '    s = Sub({1: 2})', '    s.run2(1)', '    Counter().other()', '',
  ].join('\n') });
  sdd(d, 'tdd', 'stub', 'TEST-A-001');
  const s = rd130(d, 'src/pk/m.py');
  const cls = (n) => new RegExp(`class ${n}[^]*?(?=\\nclass |$)`).exec(s)?.[0] ?? '';
  assert.match(cls('Counter'), /def fresh\(/);
  assert.doesNotMatch(cls('Counter'), /def (run2|other)\(/, 'methods of another test are not stubbed');
  assert.doesNotMatch(cls('Sub'), /def (fresh|run2)\(/);
  assert.match(cls('Catalog'), /def table\(/);
  assert.match(cls('Catalog'), /def create_table\(/);
  assert.doesNotMatch(cls('Column'), /def table\(/, 'helper returning Catalog does not leak onto Column');
  const e = mk130({ 'pytest.ini': '[pytest]\npythonpath = src\n', 'tests/test_m.py': [
    'from pk.m import Counter, Sub', '',
    '# @id TEST-A-003', '# @verifies REQ-A-001', 'def test_a():', '    s = Counter()', '    s.fresh()', '    s = Sub({1: 2})', '    s.run2(1)', '',
  ].join('\n') });
  sdd(e, 'tdd', 'stub', 'TEST-A-003');
  const t = rd130(e, 'src/pk/m.py');
  assert.match(/class Sub[^]*/.exec(t)[0], /def run2\(/);
  assert.doesNotMatch(/class Sub[^]*/.exec(t)[0], /def fresh\(/, 'a rebound variable belongs to its latest class');
});

test('#148 Go stub: field-selector receivers, honest message, New() returns the named type, scoped to the requested test, struct literal fields', { skip: !has130('go') }, () => {
  const d = mk130({
    'go.mod': 'module example.com/r\n\ngo 1.21\n',
    'calc/calc_test.go': [
      'package calc_test', '', 'import (', '\t"testing"', '', '\t"example.com/r/calc"', ')', '',
      'type rig struct{ c *calc.Calc }', '', 'func put(s *calc.Store, k string) { s.Put(k) }', '',
      '/** @id TEST-A-001 @verifies REQ-A-001 */', 'func TestTEST_A_001_add(t *testing.T) {',
      '\tr := &rig{c: calc.New()}', '\tm := calc.Msg{From: 1, To: 2}', '\tput(calc.New(), "a")', '\tif r.c.Add(2, 3) != 5 || m.From != 1 {', '\t\tt.Fatal("bad")', '\t}', '}', '',
      '/** @id TEST-A-002 @verifies REQ-A-001 */', 'func TestTEST_A_002_mode(t *testing.T) {', '\tif calc.Mode != calc.ModeFast {', '\t\tt.Fatal("bad")', '\t}', '}', '',
    ].join('\n'),
  });
  const out = sdd(d, 'tdd', 'stub', 'TEST-A-001').out;
  assert.doesNotMatch(out, /nothing to stub/, out);
  const files = fs.readdirSync(path.join(d, 'calc')).filter((f) => f.endsWith('.go') && !f.endsWith('_test.go'));
  const s = files.map((f) => rd130(d, `calc/${f}`)).join('\n');
  assert.match(s, /func \(\*Calc\) Add\(a0, a1 any\)|func \(\*Calc\) Add\(\w+ \w+, \w+ \w+\)/, 'field-selector call keeps its arguments');
  assert.match(s, /type Msg struct \{[^}]*From[^}]*To/, 'all struct literal fields');
  assert.match(s, /func New\(\) \*(Calc|Store)/);
  assert.doesNotMatch(s, /type Calc[A-Z]|Mode/, 'symbols of other tests are not stubbed');
  assert.match(out, /compile-checked|stubbed/, out);
});

test('#149 Rust stub: Type::new(..).unwrap() returns a Result, None-compared calls return Option', { skip: !has130('cargo') }, () => {
  const d = mk130({ 'Cargo.toml': '[package]\nname = "d"\nversion = "0.1.0"\nedition = "2021"\n', 'tests/t.rs': [
    'use d::Tree;', '// @id TEST-A-001 @verifies REQ-A-001', '#[test]', 'fn t() {', '    let mut t = Tree::new(4).unwrap();', '    assert_eq!(t.insert(1, 2), None);', '    assert_eq!(t.get(1), Some(2));', '}', '',
  ].join('\n') });
  const out = sdd(d, 'tdd', 'stub', 'TEST-A-001').out;
  const s = rd130(d, 'src/lib.rs');
  assert.match(s, /fn new<A0>\(_a0: A0\) -> Result<Self, String>/, s);
  assert.match(s, /fn insert[^\n]*-> Option<i64>/, s);
  assert.match(s, /fn get[^\n]*-> Option<i64>/, s);
  assert.match(out, /compile-checked/, out);
});

test('#149 Java stub: commas in string literals, String returns, chained static factories, own stubs are extended', { skip: !has130('javac') }, () => {
  const d = mk130({ 'src/test/java/RTest.java': [
    'public class RTest {', '  static void assertEquals(Object a, Object b) {}',
    '  // @id TEST-A-001 @verifies REQ-A-001', '  static void t1() {', '    assertEquals(3, Tok.count("a, b"));', '    assertEquals("y", Util.lower("Y"));', '    Object o = Analyzer.standard().analyze("x");', '  }',
    '  // @id TEST-A-002 @verifies REQ-A-001', '  static void t2() {', '    assertEquals(1, Tok.count("q"));', '    assertEquals(2, Tok.name());', '  }', '}', '',
  ].join('\n') });
  sdd(d, 'tdd', 'stub', 'TEST-A-001');
  const tok = rd130(d, 'src/main/java/Tok.java');
  assert.match(tok, /count\(Object a0\)/);
  assert.doesNotMatch(tok, /count\(Object a0, Object a1\)/);
  assert.match(rd130(d, 'src/main/java/Util.java'), /static String lower\(Object a0\)/);
  assert.match(rd130(d, 'src/main/java/Analyzer.java'), /static StandardResult standard\(\)/);
  assert.match(rd130(d, 'src/main/java/StandardResult.java'), /analyze\(/);
  const o2 = sdd(d, 'tdd', 'stub', 'TEST-A-002').out;
  assert.doesNotMatch(o2, /hold real code/, o2);
  assert.match(rd130(d, 'src/main/java/Tok.java'), /name\(\)/, 'a generated stub is extended');
});

test('#149 C++ stub: namespaced classes get class stubs (not functions per variable) and a failed stub exits non-zero', { skip: !has130('g++') }, () => {
  const d = mk130({ 'tests/b.cpp': [
    '#include "lsm/bloom.hpp"', '// @id TEST-A-001 @verifies REQ-A-001', 'int main() {', '  lsm::BloomFilter f(1000, 0.01);', '  f.add("a");', '  return f.contains("a") ? 0 : 1;', '}', '',
  ].join('\n') });
  const r = sdd(d, 'tdd', 'stub', 'TEST-A-001');
  const h = fs.readdirSync(d, { recursive: true }).find((f) => /bloom\.hpp$/.test(f));
  const s = rd130(d, h);
  assert.match(s, /namespace lsm \{/, s);
  assert.match(s, /class BloomFilter/);
  assert.match(s, /add\(A&&\.\.\.\)/);
  assert.doesNotMatch(s, /inline int f\(/, 'variables are not functions');
  assert.equal(r.code, 0, r.out);
});

const writeAll = (d, files) => { for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), c); } };

test('#144 a helper between tests does not stale the previous test; unchanged-since-Refactor warns once', () => {
  const d = project();
  sdd(d, 'approve', 'record', 'calc', '--by', 'tester');
  const T = (helper, extra = '') => [
    "import { test } from 'node:test';", "import assert from 'node:assert/strict';", "import { add } from './add.mjs';",
    '/** @id TEST-CALC-001 @verifies REQ-CALC-001 */',
    "test('TEST-CALC-001 adds', () => assert.equal(add(1, 2), 3));", '',
    `const helper = ${helper};`,
    '/** @id TEST-CALC-002 @verifies REQ-CALC-001 */',
    "test('TEST-CALC-002 adds', () => assert.equal(add(helper, 2), 3));", extra, '',
  ].join('\n');
  fs.writeFileSync(path.join(d, 'add.test.mjs'), T(1));
  impl(d, '(a, b) => a - b');
  assert.equal(sdd(d, 'tdd', 'red', 'TEST-CALC-001').code, 0);
  impl(d, '(a, b) => a + b');
  assert.equal(sdd(d, 'tdd', 'green', 'TEST-CALC-001').code, 0);
  fs.writeFileSync(path.join(d, 'add.test.mjs'), T(5, "describe_like();\n"));
  const g = sdd(d, 'gate', '--no-run');
  assert.doesNotMatch(g.out, /TEST-CALC-001: test changed since last/);
  // Refactor after a real change warns once; a second Refactor with the test unchanged is silent
  fs.writeFileSync(path.join(d, 'add.test.mjs'), T(5).replace("add(1, 2), 3)", "add(1, 2), 3, 'sum')"));
  assert.match(sdd(d, 'tdd', 'refactor', 'TEST-CALC-001').out, /test body changed since the last Green/);
  assert.doesNotMatch(sdd(d, 'tdd', 'refactor', 'TEST-CALC-001').out, /test body changed/);
});

test('#145 impact reaches Python submodule imports, Go methods-only files, subdir go.mod, JSON contracts and shared unannotated files', () => {
  const d = project();
  writeAll(d, {
    'crdt/__init__.py': '', 'crdt/lwwmap.py': 'class M: pass\n', 'tests/test_zz.py': 'from crdt import lwwmap\n',
    'g/go.mod': 'module example.com/m\n', 'g/a/t.go': 'package a\ntype T struct{}\nfunc New() *T { return nil }\n', 'g/a/m.go': 'package a\nfunc (t *T) M() int { return 1 }\n',
    'g/b/b.go': 'package b\nimport "example.com/m/a"\nfunc F() int { return a.New().M() }\n',
    'g/contract/c.go': 'package contract\nfunc C() {}\n', 'g/r/r.go': 'package r\nimport "example.com/m/contract"\nfunc R() { contract.C() }\n',
    'contract/states.json': '{}', 'api/s.ts': 'import t from "../contract/states.json";\nexport const x = t;\n',
  });
  const reach = (f) => JSON.parse(sdd(d, 'impact', f, '--json').out).reachedFiles;
  assert.ok(reach('crdt/lwwmap.py').includes('tests/test_zz.py'));
  assert.ok(reach('g/a/m.go').includes('g/b/b.go'));
  assert.ok(reach('g/contract/c.go').includes('g/r/r.go'));
  assert.ok(reach('contract/states.json').includes('api/s.ts'));
});

test('#146 spec Test column, pytest autodetect, unknown flags, batch tdd ID validation', () => {
  const d = project();
  const spec = path.join(d, '.sdd/specs/calc.md');
  fs.writeFileSync(spec, fs.readFileSync(spec, 'utf8').replace('REQ-CALC-001 |', 'REQ-CALC-001 | TEST-CALC-099 |'));
  const t = sdd(d, 'trace');
  assert.match(t.out, /spec lists TEST-CALC-099 but no such test/);
  const p = project();
  writeAll(p, { 'tests/test_x.py': 'def test_x(): pass\n' });
  sdd(p, 'init');
  assert.match(fs.readFileSync(path.join(p, '.sdd/config.json'), 'utf8'), /pytest/);
  const g = sdd(d, 'gate', '--changd');
  assert.equal(g.code, 2);
  assert.match(g.out, /unknown flag.*--changd/);
  fs.writeFileSync(path.join(d, '.sdd/config.json'), JSON.stringify({ schemaVersion: 1, testCmd: ['true'], projects: [{ root: 'api', testCmd: ['true'], dependsOn: ['./contrct'] }] }));
  assert.match(sdd(d, 'gate', '--no-run').out, /dependsOn "\.\/contrct" does not exist/);
  sdd(d, 'approve', 'record', 'calc', '--by', 'tester');
  const r = sdd(d, 'tdd', 'refactor', 'TEST-CALC-001', 'TEST-NOPE-9');
  assert.equal(r.code, 2);
  assert.match(r.out, /nothing was run/);
});

// ---- #142 / #143 (dogfood-6): runner verdicts and weak-Red heuristic ----
const fakeOut = (d, text, exit = 1, extra = {}) => {
  fs.writeFileSync(path.join(d, 'out.txt'), text);
  fs.writeFileSync(path.join(d, '.sdd/config.json'), JSON.stringify({ schemaVersion: 1, testCmd: ['sh', '-c', `cat out.txt; exit ${exit}`, 'x'], ...extra }));
};
const approved = () => { const d = project(); sdd(d, 'approve', 'record', 'calc', '--by', 'tester'); return d; };

const batch2Source = (file, body) => {
  const d = approved();
  fs.rmSync(path.join(d, 'add.test.mjs'));
  fs.mkdirSync(path.dirname(path.join(d, file)), { recursive: true });
  fs.writeFileSync(path.join(d, file), body);
  return d;
};
const batch2Run = (d, runner, body, cmd, ...args) => {
  const bin = path.join(d, 'tools');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, runner), '#!/bin/sh\n' + body, { mode: 0o755 });
  fs.writeFileSync(path.join(d, '.sdd/config.json'), JSON.stringify({ testCmd: cmd, checks: [] }));
  const r = spawnSync('node', [SDD, '--root', d, ...args], { encoding: 'utf8', env: { ...ENV, PATH: `${bin}:${ENV.PATH}` } });
  return { code: r.status, out: r.stdout + r.stderr };
};

for (const [issue, label, file, pre, deps, changed] of [
  [206, 'Cargo dev-dependency', 'client/tests/t.rs', 'use oracle::expected;', {
    'Cargo.toml': '[workspace]\nmembers=["client","oracle"]\nresolver="2"\n',
    'client/Cargo.toml': '[package]\nname="client"\nversion="0.1.0"\n[dev-dependencies]\noracle={path="../oracle"}\n',
    'client/src/lib.rs': '// @id CODE-CALC-001 @implements REQ-CALC-001\npub fn value() -> i32 { 0 }\n',
    'oracle/Cargo.toml': '[package]\nname="oracle"\nversion="0.1.0"\n',
    'oracle/src/lib.rs': 'mod deep;\npub use deep::expected;\n',
    'oracle/src/deep.rs': 'pub fn expected() -> i32 { 7 }\n',
  }, 'oracle/src/deep.rs'],
  [208, 'Maven module CSV', 'worker/src/test/java/probe/T.java', 'package probe;\nclass T {\n@CsvFileSource(files="oracle.csv")', { 'pom.xml': '<project/>', 'worker/pom.xml': '<project/>', 'worker/oracle.csv': '7,7\n' }, 'worker/oracle.csv'],
  [208, 'Gradle module CSV', 'engine/src/test/java/probe/T.java', 'package probe;\nclass T {\n@CsvFileSource(files={"oracle.csv"})', { 'build.gradle': '', 'engine/build.gradle.kts': '', 'engine/oracle.csv': '7,7\n' }, 'engine/oracle.csv'],
  [208, 'fully qualified MethodSource', 'tests/probe/T.java', 'package probe;\nclass T {\n@MethodSource({"oracle.Expected#cases"})', { 'tests/oracle/Expected.java': 'package oracle;\nclass Expected { static int cases() { return Deep.value(); } }\n', 'tests/oracle/Deep.java': 'package oracle;\nclass Deep { static int value() { return 7; } }\n' }, 'tests/oracle/Deep.java'],
  [210, 'joined GCC include', 'tests/t.cpp', '', { 'build/compile_commands.json': JSON.stringify([{ directory: '.', file: 'tests/t.cpp', arguments: ['c++', '-includetests/oracle.hpp', '-c', 'tests/t.cpp'] }]), 'tests/oracle.hpp': '#define EXPECTED 7\n' }, 'tests/oracle.hpp'],
  [210, 'joined GCC imacros', 'tests/t.cpp', '', { 'build/compile_commands.json': JSON.stringify([{ directory: '.', file: 'tests/t.cpp', arguments: ['c++', '-imacrostests/oracle.hpp', '-c', 'tests/t.cpp'] }]), 'tests/oracle.hpp': '#define EXPECTED 7\n' }, 'tests/oracle.hpp'],
  [210, 'transitive TU compiler context', 'tests/t.cpp', '#include "bridge.hpp"', { 'build/compile_commands.json': JSON.stringify([{ directory: '.', file: 'tests/t.cpp', arguments: ['c++', '-I', 'headers', '-DORACLE_HEADER="oracle.hpp"', '-c', 'tests/t.cpp'] }]), 'tests/bridge.hpp': '#include ORACLE_HEADER\n', 'headers/oracle.hpp': '#define EXPECTED 7\n' }, 'headers/oracle.hpp'],
  [211, 'fully qualified PHP static class', 'tests/T.php', '<?php\nnamespace Tests;\nclass T {\npublic function expected() { return \\Probe\\Oracle\\Expected::value(); }', { 'src/Expected.php': '<?php\nnamespace Probe\\Oracle;\nclass Expected { public static function value() { return 7; } }\n' }, 'src/Expected.php'],
  [211, 'fully qualified PHP constructor', 'tests/T.php', '<?php\nnamespace Tests;\nclass T {\npublic function expected() { return new \\Probe\\Oracle\\Expected(); }', { 'src/Expected.php': '<?php\nnamespace Probe\\Oracle;\nclass Expected { public int $value = 7; }\n' }, 'src/Expected.php'],
  [211, 'aliased PHP function', 'tests/T.php', '<?php\nnamespace Tests;\nuse function Probe\\Oracle\\height as expectedHeight;\nclass T {', { 'src/functions.php': '<?php\nnamespace Probe\\Oracle;\nfunction height() { return 7; }\n' }, 'src/functions.php'],
  [211, 'grouped PHP functions', 'tests/T.php', '<?php\nnamespace Tests;\nuse function Probe\\Oracle\\{height as expectedHeight, width};\nclass T {', { 'src/functions.php': '<?php\nnamespace Probe\\Oracle;\nfunction height() { return 7; }\nfunction width() { return 1; }\n' }, 'src/functions.php'],
  [211, 'mixed grouped PHP function', 'tests/T.php', '<?php\nnamespace Tests;\nuse Probe\\Oracle\\{function height as expectedHeight};\nclass T {', { 'src/functions.php': '<?php\nnamespace Probe\\Oracle;\nfunction height() { return 7; }\n' }, 'src/functions.php'],
  [212, 'MSTest assembly initialize', 'tests/T.cs', 'namespace Tests;\nclass T {', { 'tests/Hooks.cs': 'namespace Support;\nclass Hooks { [Microsoft.VisualStudio.TestTools.UnitTesting.AssemblyInitializeAttribute]\npublic static void Init() { int expected = 7; } }\n' }, 'tests/Hooks.cs'],
  [212, 'MSTest aliased assembly cleanup', 'tests/T.cs', 'namespace Tests;\nclass T {', { 'tests/Hooks.cs': 'using finish = Microsoft.VisualStudio.TestTools.UnitTesting.AssemblyCleanupAttribute;\nnamespace Support;\nclass Hooks { [finish]\npublic static void Cleanup() { int expected = 7; } }\n' }, 'tests/Hooks.cs'],
  [212, 'lowercase C# type alias', 'tests/T.cs', 'using check = Probe.Oracle;\nnamespace Tests;\nclass T {', { 'src/Oracle.cs': 'namespace Probe;\nclass Oracle { public static int Expected => 7; }\n' }, 'src/Oracle.cs'],
]) {
  test(`#${issue} ${label} changes and deletions invalidate oracle evidence`, () => {
    const target = '// @id TEST-CALC-001 @verifies REQ-CALC-001\n' + (file.endsWith('.rs') ? '#[test]\nfn test_calc_001() { assert_eq!(expected(), 2); }\n' : file.endsWith('.php') ? 'public function test_calc_001(): void { self::assertSame(2, expectedHeight()); }\n}\n' : file.endsWith('.java') ? '@Test\nvoid test_calc_001() { assertTrue(true); }\n}\n' : file.endsWith('.cs') ? '[TestMethod]\nvoid test_calc_001() { Assert.AreEqual(2, check.Expected); }\n}\n' : 'void test_calc_001() { CHECK(EXPECTED); }\n');
    const d = batch2Source(file, pre + '\n' + target);
    writeAll(d, deps);
    fakeOut(d, 'AssertionError: oracle');
    const red = sdd(d, 'tdd', 'red', 'TEST-CALC-001');
    assert.equal(red.code, 0, red.out);
    fakeOut(d, 'pass', 0);
    assert.equal(sdd(d, 'tdd', 'green', 'TEST-CALC-001').code, 0);
    fs.writeFileSync(path.join(d, changed), deps[changed].replace('7', '2'));
    const green = sdd(d, 'tdd', 'green', 'TEST-CALC-001');
    assert.equal(green.code, 1, green.out);
    assert.match(green.out, /changed since Red/);
    assert.match(sdd(d, 'gate', '--no-run').out, /test changed/);
    fs.rmSync(path.join(d, changed));
    assert.equal(sdd(d, 'tdd', 'green', 'TEST-CALC-001').code, 1);
  });
}

for (const marker of ['const DOC: &str = "#[cfg(test)]";', '// #[cfg(test)]', 'const DOC: &str = r#"#[cfg(test)]"#;']) {
  test(`#206 literal/comment cfg(test) does not hide a preceding oracle: ${marker}`, () => {
    const body = 'fn expected() -> i32 { 7 }\n' + marker + '\n// @id TEST-CALC-001 @verifies REQ-CALC-001\n#[test]\nfn test_calc_001() { assert_eq!(expected(), 2); }\n';
    const d = batch2Source('tests/t.rs', body);
    fakeOut(d, 'AssertionError: target');
    assert.equal(sdd(d, 'tdd', 'red', 'TEST-CALC-001').code, 0);
    fs.writeFileSync(path.join(d, 'tests/t.rs'), body.replace('{ 7 }', '{ 2 }'));
    fakeOut(d, 'pass', 0);
    const green = sdd(d, 'tdd', 'green', 'TEST-CALC-001');
    assert.equal(green.code, 1, green.out);
    assert.match(green.out, /changed since Red/);
  });
}

for (const binding of ['shared.workspace=true', 'shared={workspace=true}', '[dependencies.shared]\nworkspace=true']) {
  test(`#207 Cargo inherited alias impact resolves ${binding}`, () => {
    const d = approved();
    writeAll(d, {
      'Cargo.toml': '[workspace]\nmembers=["base","client"]\n[workspace.dependencies]\nshared={package="actual-base",path="base"}\n',
      'base/Cargo.toml': '[package]\nname="actual-base"\nversion="0.1.0"\n',
      'base/src/lib.rs': '// @id CODE-CALC-001 @implements REQ-CALC-001\npub fn value() -> i32 { 7 }\n',
      'client/Cargo.toml': '[package]\nname="client"\nversion="0.1.0"\n[dependencies]\n' + binding + '\n',
      'client/src/lib.rs': 'use shared::value;\n// @id CODE-CLIENT-001 @implements REQ-CLIENT-001\npub fn compute() -> i32 { value() }\n',
      'client/tests/t.rs': 'use client::compute;\n// @id TEST-CLIENT-001 @verifies REQ-CLIENT-001\n#[test]\nfn test_client_001() { assert_eq!(compute(), 7); }\n',
      '.sdd/specs/client.md': '---\nfeature: client\ntier: T1\n---\nREQ-CLIENT-001: When called, the system shall compute.\n',
    });
    const result = sdd(d, 'impact', 'REQ-CALC-001', '--json');
    assert.equal(result.code, 0, result.out);
    const impact = JSON.parse(result.out);
    assert.ok(impact.reachedFiles.includes('client/src/lib.rs'), result.out);
    assert.ok(impact.reachedFiles.includes('client/tests/t.rs'), result.out);
    assert.ok(impact.otherReqs.some((o) => o.req === 'REQ-CLIENT-001'), result.out);
  });
}

test('#213 impact follows package imports, exports wildcards and tsconfig paths to directory indexes', () => {
  const d = approved();
  const pkg = (n, o) => JSON.stringify({ name: n, type: 'module', ...o });
  writeAll(d, {
    'package.json': '{"name":"r","private":true,"workspaces":["packages/*"]}',
    'tsconfig.json': '{"compilerOptions":{"baseUrl":".","paths":{"@c/*":["packages/core/src/*"]}}}',
    'packages/core/package.json': pkg('@r/core', { exports: { '.': './src/index.ts', './*': './src/*.ts' }, imports: { '#util/*': './src/util/*.ts' } }),
    'packages/core/src/index.ts': 'export const x = 1;\n',
    'packages/core/src/util/str.ts': '// @id CODE-CALC-001 @implements REQ-CALC-001\nexport const s = 1;\n',
    'packages/core/src/title.ts': '// @id CODE-CALC-002 @implements REQ-CALC-001\nexport const t = 1;\n',
    'packages/core/src/hash.ts': 'import "#util/str";\n// @id CODE-A-001 @implements REQ-A-001\nexport const h = 1;\n',
    'packages/app/package.json': pkg('@r/app', { exports: './src/index.ts' }),
    'packages/app/src/index.ts': 'import "@r/core/title";\n// @id CODE-B-001 @implements REQ-B-001\nexport const a = 1;\n',
    'packages/app2/package.json': pkg('@r/app2', { exports: './src/index.ts' }),
    'packages/app2/src/index.ts': 'import "@c/title";\n// @id CODE-C-001 @implements REQ-C-001\nexport const b = 1;\n',
    '.sdd/specs/a.md': '---\nfeature: a\ntier: T1\n---\nREQ-A-001: When called, the system shall hash.\n',
    '.sdd/specs/b.md': '---\nfeature: b\ntier: T1\n---\nREQ-B-001: When called, the system shall app.\n',
    '.sdd/specs/c.md': '---\nfeature: c\ntier: T1\n---\nREQ-C-001: When called, the system shall app2.\n',
  });
  const reach = (f) => JSON.parse(sdd(d, 'impact', f, '--json').out).reachedFiles;
  assert.ok(reach('packages/core/src/util/str.ts').includes('packages/core/src/hash.ts'));
  assert.ok(reach('packages/core/src/title.ts').includes('packages/app/src/index.ts'));
  assert.ok(reach('packages/core/src/title.ts').includes('packages/app2/src/index.ts'));
});

test('#224 R impact follows literal source() edges', () => {
  const d = approved();
  writeAll(d, {
    'R/dataio.R': '# @id CODE-CALC-001 @implements REQ-CALC-001\nsurv_data <- function() 1\n',
    'R/km.R': '# source("R/ignored.R")\nsource("R/dataio.R")\n# @id CODE-KM-001 @implements REQ-KM-001\nkm <- function() surv_data()\n',
    'tests/testthat/test-cox.R': 'source(file.path("..", "..", "R", "dataio.R"))\n# @id TEST-KM-001 @verifies REQ-KM-001\ntest_that("x", { expect_equal(surv_data(), 1) })\n',
    '.sdd/specs/km.md': '---\nfeature: km\ntier: T1\n---\nREQ-KM-001: When called, the system shall fit.\n',
  });
  const result = sdd(d, 'impact', 'R/dataio.R', '--json');
  const impact = JSON.parse(result.out);
  assert.ok(impact.reachedFiles.includes('R/km.R'), result.out);
  assert.ok(impact.reachedFiles.includes('tests/testthat/test-cox.R'), result.out);
  assert.ok(impact.otherReqs.some((o) => o.req === 'REQ-KM-001'), result.out);
});

test('#217 Rust impact honors #[path] modules for crate:: importers', () => {
  const d = approved();
  writeAll(d, {
    'Cargo.toml': '[package]\nname="pathimp"\nversion="0.1.0"\n',
    'src/lib.rs': '#[path = "model/value.rs"]\nmod value;\nmod session;\n',
    'src/model/value.rs': '// @id CODE-CALC-001 @implements REQ-CALC-001\npub struct V(pub i64);\n',
    'src/session.rs': 'use crate::value::V;\n// @id CODE-CLIENT-001 @implements REQ-CLIENT-001\npub fn run() -> i64 { V(1).0 }\n',
    '.sdd/specs/client.md': '---\nfeature: client\ntier: T1\n---\nREQ-CLIENT-001: When called, the system shall run.\n',
  });
  const result = sdd(d, 'impact', 'src/model/value.rs', '--json');
  assert.equal(result.code, 0, result.out);
  const impact = JSON.parse(result.out);
  assert.ok(impact.reachedFiles.includes('src/session.rs'), result.out);
  assert.ok(impact.otherReqs.some((o) => o.req === 'REQ-CLIENT-001'), result.out);
});

test('#207 Rust raw identifier modules retain exact scopes and ordinary module filenames', { skip: !has130('cargo') }, () => {
  const d = batch2Source('src/type.rs', '// @id TEST-CALC-001 @verifies REQ-CALC-001\n#[test]\nfn test_calc_001() { assert_eq!(crate::answer(), 7); }\n');
  writeAll(d, { 'Cargo.toml': '[package]\nname="raw-probe"\nversion="0.1.0"\nedition="2021"\n', 'src/lib.rs': '// @id CODE-CALC-001 @implements REQ-CALC-001\npub fn answer() -> i32 { 0 }\n#[cfg(test)] mod r#type;\n' });
  fs.writeFileSync(path.join(d, '.sdd/config.json'), JSON.stringify({ testCmd: ['cargo', 'test', '{idu}'], checks: [] }));
  const red = sdd(d, 'tdd', 'red', 'TEST-CALC-001');
  assert.equal(red.code, 0, red.out);
  fs.writeFileSync(path.join(d, 'src/lib.rs'), rd130(d, 'src/lib.rs').replace('{ 0 }', '{ 7 }'));
  assert.equal(sdd(d, 'tdd', 'green', 'TEST-CALC-001').code, 0);
});

test('#207 cfg-exclusive identical Rust module owner tuples deduplicate', { skip: !has130('cargo') }, () => {
  const d = batch2Source('src/cases.rs', '// @id TEST-CALC-001 @verifies REQ-CALC-001\n#[test]\nfn test_calc_001() { assert_eq!(crate::answer(), 7); }\n');
  writeAll(d, { 'Cargo.toml': '[package]\nname="cfg-probe"\nversion="0.1.0"\nedition="2021"\n', 'src/lib.rs': '// @id CODE-CALC-001 @implements REQ-CALC-001\npub fn answer() -> i32 { 0 }\n#[cfg(all(test,unix))]\n#[path="cases.rs"] mod platform;\n#[cfg(all(test,windows))]\n#[path="cases.rs"] mod platform;\n' });
  fs.writeFileSync(path.join(d, '.sdd/config.json'), JSON.stringify({ testCmd: ['cargo', 'test', '--lib', '{idu}'], checks: [] }));
  const red = sdd(d, 'tdd', 'red', 'TEST-CALC-001');
  assert.equal(red.code, 0, red.out);
  fs.writeFileSync(path.join(d, 'src/lib.rs'), rd130(d, 'src/lib.rs').replace('{ 0 }', '{ 7 }'));
  assert.equal(sdd(d, 'tdd', 'green', 'TEST-CALC-001').code, 0);
});

test('#209 JUnit default interface tests resolve concrete runtime owners and reject ambiguity', () => {
  const d = batch2Source('tests/probe/Contract.java', 'package probe;\ninterface Contract {\n// @id TEST-CALC-001 @verifies REQ-CALC-001\n@Test\ndefault void test_calc_001() { assertEquals(1, 2); }\n}\n');
  writeAll(d, { 'tests/probe/ContractTest.java': 'package probe;\nclass ContractTest implements Contract {}\n' });
  const red = batch2Run(d, 'mvn', 'printf "%s\\n" "$@" > args.txt\necho "SDD-TEST probe.ContractTest test_calc_001 FAILURE"\necho "AssertionError: contract"\nexit 1\n', ['mvn', 'test', '-Dtest={idu}'], 'tdd', 'red', 'TEST-CALC-001');
  assert.equal(red.code, 0, red.out);
  assert.match(rd130(d, 'args.txt'), /-Dtest=probe.ContractTest#test_calc_001/);
  writeAll(d, { 'tests/probe/OtherTest.java': 'package probe;\nclass OtherTest implements Contract {}\n' });
  const ambiguous = sdd(d, 'tdd', 'red', 'TEST-CALC-001');
  assert.equal(ambiguous.code, 1, ambiguous.out);
  assert.match(ambiguous.out, /Java.*ownership.*ambiguous|ambiguous.*Java.*owner/i);
  assert.doesNotMatch(ambiguous.out, /no test matched/);
});

test('#210 compiler macro contexts do not leak across translation units', () => {
  const d = batch2Source('tests/one.cpp', '#include "bridge.hpp"\n// @id TEST-CALC-001 @verifies REQ-CALC-001\nvoid test_calc_001() { CHECK(EXPECTED); }\n');
  writeAll(d, {
    'tests/two.cpp': '#include "bridge.hpp"\n// @id TEST-CALC-002 @verifies REQ-CALC-001\nvoid test_calc_002() { CHECK(EXPECTED); }\n',
    'tests/bridge.hpp': '#include ORACLE_HEADER\n',
    'headers/one.hpp': '#define EXPECTED 7\n', 'headers/two.hpp': '#define EXPECTED 8\n',
    'build/compile_commands.json': JSON.stringify(['one', 'two'].map((n) => ({ directory: '.', file: `tests/${n}.cpp`, arguments: ['c++', '-Iheaders', `-DORACLE_HEADER="${n}.hpp"`] }))),
  });
  fakeOut(d, 'AssertionError: target');
  for (const id of ['TEST-CALC-001', 'TEST-CALC-002']) assert.equal(sdd(d, 'tdd', 'red', id).code, 0);
  fakeOut(d, 'pass', 0);
  for (const id of ['TEST-CALC-001', 'TEST-CALC-002']) assert.equal(sdd(d, 'tdd', 'green', id).code, 0);
  fs.writeFileSync(path.join(d, 'headers/two.hpp'), '#define EXPECTED 9\n');
  assert.equal(sdd(d, 'tdd', 'green', 'TEST-CALC-001').code, 0);
  assert.equal(sdd(d, 'tdd', 'green', 'TEST-CALC-002').code, 1);
});

test('#212 assembly lifecycle support is restricted to the owning MSTest project', () => {
  const d = batch2Source('tests/T.cs', 'namespace Tests;\nclass T {\n// @id TEST-CALC-001 @verifies REQ-CALC-001\n[TestMethod]\nvoid test_calc_001() { Assert.IsTrue(true); }\n}\n');
  writeAll(d, {
    'tests/Tests.csproj': '<Project Sdk="Microsoft.NET.Sdk"/>',
    'other/Other.csproj': '<Project Sdk="Microsoft.NET.Sdk"/>',
    'tests/Hooks.cs': 'namespace Hooks;\nclass Init { [AssemblyInitialize] public static void Seed() { int expected = 7; } }\n',
    'other/Hooks.cs': 'namespace Hooks;\nclass Init { [AssemblyInitialize] public static void Seed() { int expected = 8; } }\n',
  });
  fakeOut(d, 'AssertionError: target');
  assert.equal(sdd(d, 'tdd', 'red', 'TEST-CALC-001').code, 0);
  fakeOut(d, 'pass', 0);
  fs.writeFileSync(path.join(d, 'other/Hooks.cs'), rd130(d, 'other/Hooks.cs').replace('8', '9'));
  assert.equal(sdd(d, 'tdd', 'green', 'TEST-CALC-001').code, 0);
  fs.writeFileSync(path.join(d, 'tests/Hooks.cs'), rd130(d, 'tests/Hooks.cs').replace('7', '2'));
  assert.equal(sdd(d, 'tdd', 'green', 'TEST-CALC-001').code, 1);
});

for (const [label, file, pre, deps, changed] of [
  ['Rust Unicode path', 'tests/t.rs', '#[path = "expected\\u{2e}rs"] mod oracle;', { 'tests/expected.rs': 'pub fn expected() -> i32 { 7 }\n' }, 'tests/expected.rs'],
  ['Rust intervening attribute', 'tests/t.rs', '#[path = "expected.rs"]\n#[allow(dead_code)]\nmod oracle;', { 'tests/expected.rs': 'pub fn expected() -> i32 { 7 }\n' }, 'tests/expected.rs'],
  ['C++ macro', 'tests/t.cpp', '#define ORACLE_FILE "oracle.hpp"\n#include ORACLE_FILE', { 'tests/oracle.hpp': '#define EXPECTED 7\n' }, 'tests/oracle.hpp'],
  ['C++ fragment', 'tests/t.cpp', '#include "support.inc"', { 'tests/support.inc': '#include "oracle.hpp"\n', 'tests/oracle.hpp': '#define EXPECTED 7\n' }, 'tests/oracle.hpp'],
  ['C++ forced include', 'tests/t.cpp', '', { 'build/compile_commands.json': JSON.stringify([{ directory: '.', file: 'tests/t.cpp', arguments: ['c++', '-include', 'tests/oracle.hpp', '-c', 'tests/t.cpp'] }]), 'tests/oracle.hpp': '#define EXPECTED 7\n' }, 'tests/oracle.hpp'],
  ['C++ include-path forced fragment', 'tests/t.cpp', '', { 'build/compile_commands.json': JSON.stringify([{ directory: '.', file: 'tests/t.cpp', arguments: ['c++', '-I', 'headers', '-include', 'support.inc', '-c', 'tests/t.cpp'] }]), 'headers/support.inc': '#include "oracle.hpp"\n', 'headers/oracle.hpp': '#define EXPECTED 7\n' }, 'headers/oracle.hpp'],
  ['Java same package', 'src/test/java/probe/T.java', 'package probe;\nclass T {\nOracle expected;', { 'src/test/java/probe/Oracle.java': 'package probe;\nclass Oracle { int expected() { return 7; } }\n' }, 'src/test/java/probe/Oracle.java'],
  ['Java CSV resource', 'src/test/java/probe/T.java', 'package probe;\nclass T {\n@CsvFileSource(resources = "/oracle.csv")', { 'src/test/resources/oracle.csv': '7,7\n' }, 'src/test/resources/oracle.csv'],
  ['Java CSV file', 'src/test/java/probe/T.java', 'package probe;\nclass T {\n@CsvFileSource(files = "oracle.csv")', { 'oracle.csv': '7,7\n' }, 'oracle.csv'],
  ['PHP same namespace', 'tests/T.php', '<?php\nnamespace Probe;\nclass T {\npublic function helper() { return Oracle::expected(); }', { 'tests/Oracle.php': '<?php\nnamespace Probe;\nclass Oracle { public static function expected() { return 7; } }\n' }, 'tests/Oracle.php'],
  ['xUnit string collection', 'tests/T.cs', 'namespace Probe;\n[Collection("billing")]\nclass T {', { 'tests/Fixture.cs': 'namespace Probe;\n[CollectionDefinition("billing")]\nclass Billing : ICollectionFixture<Setup> {}\nclass Setup { int oracle = 7; }\n' }, 'tests/Fixture.cs'],
  ['NUnit namespace setup', 'tests/T.cs', 'namespace Probe.Inner;\nclass T {', { 'tests/Fixture.cs': 'namespace Probe;\n[SetUpFixture]\nclass Setup { [OneTimeSetUp] void Init() { int oracle = 7; } }\n' }, 'tests/Fixture.cs'],
  ['Julia joinpath', 'test/t.jl', 'include(joinpath(@__DIR__, "support", "oracle.jl"))', { 'test/support/oracle.jl': 'expected() = 7\n' }, 'test/support/oracle.jl'],
  ['Julia qualified include', 'test/t.jl', 'Base.include(@__MODULE__, "oracle.jl")', { 'test/oracle.jl': 'expected() = 7\n' }, 'test/oracle.jl'],
]) {
  test(`#199 ${label} protects changed and deleted oracle dependencies`, () => {
    const target = file.endsWith('.jl') ? '# @id TEST-CALC-001 @verifies REQ-CALC-001\n@testset "TEST-CALC-001" begin\n@test value() == expected()\nend\n'
      : '// @id TEST-CALC-001 @verifies REQ-CALC-001\n' + (file.endsWith('.rs') ? '#[test]\nfn test_calc_001() { assert!(true); }\n' : file.endsWith('.php') ? 'public function test_calc_001(): void { self::assertTrue(true); }\n}\n' : file.endsWith('.java') ? '@Test\nvoid test_calc_001() { assertTrue(true); }\n}\n' : file.endsWith('.cs') ? '[Test]\nvoid test_calc_001() { Assert.True(true); }\n}\n' : 'void test_calc_001() { CHECK(1); }\n');
    const d = batch2Source(file, pre + '\n' + target);
    writeAll(d, deps);
    fakeOut(d, 'AssertionError: oracle');
    const red = sdd(d, 'tdd', 'red', 'TEST-CALC-001');
    assert.equal(red.code, 0, red.out);
    fakeOut(d, 'pass', 0);
    assert.equal(sdd(d, 'tdd', 'green', 'TEST-CALC-001').code, 0);
    fs.writeFileSync(path.join(d, changed), deps[changed].replace('7', '2'));
    assert.match(sdd(d, 'tdd', 'green', 'TEST-CALC-001').out, /changed since Red/);
    assert.match(sdd(d, 'gate', '--no-run').out, /test changed/);
    fs.rmSync(path.join(d, changed));
    assert.equal(sdd(d, 'tdd', 'green', 'TEST-CALC-001').code, 1);
  });
}

for (const [file, pre] of [['t.cpp', '#include ORACLE_UNKNOWN'], ['t.jl', 'include(oracle_path())'], ['T.java', 'class T {\n@CsvFileSource(resources = RESOURCE)']]) {
  test(`#199 ${file} unresolved oracle input refuses evidence`, () => {
    const target = file.endsWith('.jl') ? '# @id TEST-CALC-001 @verifies REQ-CALC-001\n@testset "TEST-CALC-001" begin\n@test true\nend\n' : '// @id TEST-CALC-001 @verifies REQ-CALC-001\nvoid test_calc_001() {}\n';
    const d = batch2Source(file, pre + '\n' + target);
    fakeOut(d, 'AssertionError: oracle');
    const red = sdd(d, 'tdd', 'red', 'TEST-CALC-001');
    assert.equal(red.code, 1, red.out);
    assert.match(red.out, /unresolved.*oracle/i);
    assert.equal(testEvidence(d).length, 0);
  });
}

test('#204 Julia character literals preserve sibling isolation and selected-body protection', () => {
  const body = "# @id TEST-CALC-001 @verifies REQ-CALC-001\n@testset \"TEST-CALC-001\" begin\n@test '(' == '('\n@test '\\'' == '\\''\n@test value() == 2\nend\n# @id TEST-OTHER-001 @verifies REQ-CALC-001\n@testset \"TEST-OTHER-001\" begin\n@test 4 == 4\nend\n";
  const d = batch2Source('t.jl', body);
  fakeOut(d, 'AssertionError: target');
  assert.equal(sdd(d, 'tdd', 'red', 'TEST-CALC-001').code, 0);
  fs.writeFileSync(path.join(d, 't.jl'), body.replace('4 == 4', '5 == 5'));
  fakeOut(d, 'pass', 0);
  assert.equal(sdd(d, 'tdd', 'green', 'TEST-CALC-001').code, 0);
  fs.writeFileSync(path.join(d, 't.jl'), body.replace('value() == 2', 'value() == 3'));
  assert.match(sdd(d, 'tdd', 'green', 'TEST-CALC-001').out, /changed since Red/);
});

test('#203 PHP readonly classes retain cross-feature impact edges', () => {
  const d = approved();
  writeAll(d, {
    'src/Value.php': '<?php\nnamespace Probe;\n// @id CODE-VALUE-001 @implements REQ-CALC-001\nfinal readonly class Value {}\n',
    'src/Reader.php': '<?php\nnamespace Client;\nuse Probe\\Value;\nclass Reader {}\n',
  });
  const result = sdd(d, 'impact', 'src/Value.php', '--json');
  assert.equal(result.code, 0, result.out);
  assert.ok(JSON.parse(result.out).reachedFiles.includes('src/Reader.php'), result.out);
});

test('#205 generic NUnit parameterized TRX rows aggregate without accepting longer siblings', () => {
  const d = batch2Source('T.cs', 'namespace Probe;\n[TestFixture(typeof(int))]\nclass Generic<T> {\n// @id TEST-CALC-001 @verifies REQ-CALC-001\n[TestCase(1)]\n[TestCase(2)]\npublic void test_calc_001(int value) { Assert.AreEqual(value, Actual(value)); }\n}\n');
  writeAll(d, { 'T.csproj': '<Project/>' });
  const trx = (outcome) => `<TestRun><TestDefinitions><UnitTest id="one"><TestMethod className="Probe.Generic&lt;System.Int32&gt;" name="test_calc_001(1)"/></UnitTest><UnitTest id="two"><TestMethod className="Probe.Generic&lt;System.Int32&gt;" name="test_calc_001(2)"/></UnitTest><UnitTest id="sibling"><TestMethod className="Probe.Generic&lt;System.Int32&gt;" name="test_calc_001_extra(2)"/></UnitTest></TestDefinitions><Results><UnitTestResult testId="one" outcome="Passed"/><UnitTestResult testId="two" outcome="${outcome}"/><UnitTestResult testId="sibling" outcome="Failed"/></Results></TestRun>`;
  const run = (outcome, exit, ...args) => batch2Run(d, 'dotnet', `mkdir -p .sdd/results\nprintf '%s' '${trx(outcome)}' > .sdd/results/sdd-target.trx\necho "Expected is <2>"\nexit ${exit}\n`, ['dotnet', 'test', '--filter', 'FullyQualifiedName~{idu}'], ...args);
  const red = run('Failed', 1, 'tdd', 'red', 'TEST-CALC-001');
  assert.equal(red.code, 0, red.out);
  assert.equal(run('Failed', 1, 'tdd', 'green', 'TEST-CALC-001').code, 1);
  assert.equal(run('Passed', 0, 'tdd', 'green', 'TEST-CALC-001').code, 0);
  assert.equal(run('Failed', 1, 'tdd', 'refactor', 'TEST-CALC-001').code, 1);
});

test('#200 Rust include-owned tests retain lexical modules and reject ambiguous executables', { skip: !has130('cargo') }, () => {
  const body = '// @id TEST-CALC-001 @verifies REQ-CALC-001\n#[test]\nfn test_calc_001() { assert_eq!(crate::answer(), 7); }\n';
  const d = batch2Source('support/cases.rs', body);
  writeAll(d, {
    'Cargo.toml': '[package]\nname="include-probe"\nversion="0.1.0"\nedition="2021"\n',
    'src/lib.rs': '// @id CODE-CALC-001 @implements REQ-CALC-001\npub fn answer() -> i32 { 0 }\n#[cfg(test)] mod embedded { include!("../support/cases.rs"); }\n',
  });
  fs.writeFileSync(path.join(d, '.sdd/config.json'), JSON.stringify({ testCmd: ['cargo', 'test', '{idu}'], checks: [] }));
  const red = sdd(d, 'tdd', 'red', 'TEST-CALC-001');
  assert.equal(red.code, 0, red.out);
  const entry = testEvidence(d)[0];
  assert.equal(entry.weak, undefined);
  writeAll(d, { 'src/main.rs': 'fn main() {}\nfn answer() -> i32 { 8 }\n#[cfg(test)] mod embedded { include!("../support/cases.rs"); }\n' });
  const ambiguous = sdd(d, 'tdd', 'red', 'TEST-CALC-001');
  assert.equal(ambiguous.code, 1, ambiguous.out);
  assert.match(ambiguous.out, /ownership is ambiguous/);
  fs.writeFileSync(path.join(d, '.sdd/config.json'), JSON.stringify({ testCmd: ['cargo', 'test', '--lib', '{idu}'], checks: [] }));
  assert.equal(sdd(d, 'tdd', 'red', 'TEST-CALC-001').code, 0);
  fs.writeFileSync(path.join(d, 'src/lib.rs'), rd130(d, 'src/lib.rs').replace('{ 0 }', '{ 7 }'));
  const green = sdd(d, 'tdd', 'green', 'TEST-CALC-001');
  assert.equal(green.code, 0, green.out);
});

test('#202 Git-less Cargo members receive imported missing-module stubs without replacing libraries', { skip: !has130('cargo') }, () => {
  const d = batch2Source('consumer/tests/probe.rs', 'use subject::fresh::count;\n// @id TEST-CALC-001 @verifies REQ-CALC-001\n#[test]\nfn test_calc_001() { assert_eq!(count(), 3); }\n');
  writeAll(d, {
    'Cargo.toml': '[workspace]\nmembers=["subject","consumer"]\nresolver="2"\n',
    'subject/Cargo.toml': '[package]\nname="subject"\nversion="0.1.0"\nedition="2021"\n',
    'subject/src/lib.rs': 'pub fn existing() -> i32 { 1 }\n',
    'consumer/Cargo.toml': '[package]\nname="consumer"\nversion="0.1.0"\nedition="2021"\n[dependencies]\nsubject={path="../subject"}\n',
    'consumer/src/lib.rs': 'pub fn preserved() -> i32 { 2 }\n',
  });
  fs.rmSync(path.join(d, '.git'), { recursive: true });
  const stub = sdd(d, 'tdd', 'stub', 'TEST-CALC-001');
  assert.equal(stub.code, 0, stub.out);
  assert.match(rd130(d, 'subject/src/fresh.rs'), /pub fn count/);
  assert.match(rd130(d, 'subject/src/lib.rs'), /pub fn existing[\s\S]*pub mod fresh;/);
  assert.equal(rd130(d, 'consumer/src/lib.rs'), 'pub fn preserved() -> i32 { 2 }\n');
});

test('#200 workspace-root included annotations resolve through package and target selection', { skip: !has130('cargo') }, () => {
  const d = batch2Source('support/cases.rs', '// @id TEST-CALC-001 @verifies REQ-CALC-001\n#[test]\nfn test_calc_001() { assert_eq!(crate::answer(), 7); }\n');
  writeAll(d, {
    'Cargo.toml': '[workspace]\nmembers=["one","two"]\nresolver="2"\n',
    'one/Cargo.toml': '[package]\nname="one"\nversion="0.1.0"\nedition="2021"\n',
    'two/Cargo.toml': '[package]\nname="two"\nversion="0.1.0"\nedition="2021"\n',
    'one/src/lib.rs': '// @id CODE-CALC-001 @implements REQ-CALC-001\npub fn answer() -> i32 { 7 }\n#[cfg(test)] mod embedded { include!("../../support/cases.rs"); }\n',
    'two/src/lib.rs': 'pub fn answer() -> i32 { 0 }\n#[cfg(test)] mod embedded { include!("../../support/cases.rs"); }\n',
  });
  fs.writeFileSync(path.join(d, '.sdd/config.json'), JSON.stringify({ testCmd: ['cargo', 'test', '{idu}'], checks: [] }));
  const ambiguous = sdd(d, 'tdd', 'red', 'TEST-CALC-001');
  assert.equal(ambiguous.code, 1, ambiguous.out);
  assert.match(ambiguous.out, /ownership is ambiguous/);
  fs.writeFileSync(path.join(d, '.sdd/config.json'), JSON.stringify({ testCmd: ['cargo', 'test', '-p', 'one', '--lib', '{idu}'], checks: [] }));
  const passing = sdd(d, 'tdd', 'red', 'TEST-CALC-001');
  assert.equal(passing.code, 1, passing.out);
  assert.match(passing.out, /test passed/);
  fs.writeFileSync(path.join(d, '.sdd/config.json'), JSON.stringify({ testCmd: ['cargo', 'test', '-p', 'two', '--lib', '{idu}'], checks: [] }));
  const failing = sdd(d, 'tdd', 'red', 'TEST-CALC-001');
  assert.equal(failing.code, 0, failing.out);
});

for (const [version, option] of [['12.5.38', '--do-not-cache-result'], ['13.3.9', '--do-not-cache-result'], ['13.4.1', '--do-not-record-test-run-history'], ['14.0.0', '--do-not-record-test-run-history']]) {
  test(`#203 PHPUnit ${version} autodetect uses compatible result-history option`, () => {
    const d = approved();
    writeAll(d, { 'composer.json': '{}', 'vendor/bin/phpunit': `#!/bin/sh\necho 'PHPUnit ${version}'\n` });
    fs.chmodSync(path.join(d, 'vendor/bin/phpunit'), 0o755);
    const init = sdd(d, 'init');
    assert.equal(init.code, 0, init.out);
    const cfg = JSON.parse(rd130(d, '.sdd/config.json'));
    assert.ok(cfg.testCmd.includes(option));
    assert.ok(cfg.checks[0].cmd.includes(option));
  });
}

test('#204 aliased standard Julia nested testsets expose passing and failing targets', { skip: !has130('julia') }, () => {
  const body = 'import Test as JT\nJT.@testset "outer" begin\n# @id TEST-CALC-001 @verifies REQ-CALC-001\nJT.@testset "TEST-CALC-001" begin\nJT.@test 1 == 2\nend\nend\n';
  const d = batch2Source('t.jl', body);
  fs.writeFileSync(path.join(d, '.sdd/config.json'), JSON.stringify({ testCmd: ['julia', '--compile=min', '--project=.', '{file}'], checks: [] }));
  const red = sdd(d, 'tdd', 'red', 'TEST-CALC-001');
  assert.equal(red.code, 0, red.out);
  // Characterization proves passing nested visibility independently of assertion-body changes.
  fs.writeFileSync(path.join(d, 't.jl'), body.replace('1 == 2', '2 == 2'));
  const passing = sdd(d, 'tdd', 'red', 'TEST-CALC-001', '--characterization', 'alias visibility');
  assert.equal(passing.code, 0, passing.out);
  const green = sdd(d, 'tdd', 'green', 'TEST-CALC-001');
  assert.equal(green.code, 0, green.out);
});

for (const [file, pre, subject, stub, implementation] of [
  ['src/test/java/probe/T.java', 'package probe;\nimport static probe.Subject.value;\nclass T {', 'src/main/java/probe/Subject.java', 'package probe;\npublic class Subject { public static int value() { return 0; } }\n', 'package probe;\n// @id CODE-CALC-001 @implements REQ-CALC-001\npublic class Subject { public static int value() { return 7; } }\n'],
  ['test/t.jl', 'include("../src/answer.jl")', 'src/answer.jl', 'value() = 0\n', '# @id CODE-CALC-001 @implements REQ-CALC-001\nvalue() = 7\n'],
]) {
  test(`#201 ${file} handwritten subject promotion diagnoses ownership, never silently drops an oracle`, () => {
    const target = file.endsWith('.jl') ? '# @id TEST-CALC-001 @verifies REQ-CALC-001\n@testset "TEST-CALC-001" begin\n@test value() == 7\nend\n' : '// @id TEST-CALC-001 @verifies REQ-CALC-001\nvoid test_calc_001() { value(); }\n}\n';
    const d = batch2Source(file, pre + '\n' + target);
    writeAll(d, { [subject]: stub });
    fakeOut(d, 'AssertionError: subject');
    assert.equal(sdd(d, 'tdd', 'red', 'TEST-CALC-001').code, 0);
    fs.writeFileSync(path.join(d, subject), implementation);
    fakeOut(d, 'pass', 0);
    const rejected = sdd(d, 'tdd', 'green', 'TEST-CALC-001');
    assert.equal(rejected.code, 1, rejected.out);
    assert.match(rejected.out, /production ownership changed since Red/);
    assert.match(rejected.out, /Annotate handwritten production subjects before Red/);
    fs.writeFileSync(path.join(d, subject), implementation.replace('7', '0'));
    fakeOut(d, 'AssertionError: subject');
    assert.equal(sdd(d, 'tdd', 'red', 'TEST-CALC-001').code, 0);
    fs.writeFileSync(path.join(d, subject), implementation);
    fakeOut(d, 'pass', 0);
    assert.equal(sdd(d, 'tdd', 'green', 'TEST-CALC-001').code, 0);
  });
}

for (const [label, file, body, manifests, subject, implementation] of [
  ['Java', 'src/test/java/probe/T.java', 'package probe;\nimport probe.Subject;\nclass T {\n// @id TEST-CALC-001 @verifies REQ-CALC-001\nvoid test_calc_001() { Subject.value(); }\n}\n', {}, 'src/main/java/probe/Subject.java', 'package probe;\n// @id CODE-CALC-001 @implements REQ-CALC-001\npublic class Subject { public static int value() { return 7; } }\n'],
  ['PHP', 'tests/T.php', '<?php\nuse Probe\\Subject;\nclass T {\n// @id TEST-CALC-001 @verifies REQ-CALC-001\npublic function test_calc_001(): void { Subject::value(); }\n}\n', { 'composer.json': JSON.stringify({ autoload: { 'psr-4': { 'Probe\\': 'src/' } } }) }, 'src/Subject.php', '<?php\nnamespace Probe;\n// @id CODE-CALC-001 @implements REQ-CALC-001\nclass Subject { public static function value() { return 7; } }\n'],
  ['Julia', 'test/t.jl', 'include("../src/answer.jl")\n# @id TEST-CALC-001 @verifies REQ-CALC-001\n@testset "TEST-CALC-001" begin\n@test value() == 7\nend\n', {}, 'src/answer.jl', '# @id CODE-CALC-001 @implements REQ-CALC-001\nvalue() = 7\n'],
]) {
  test(`#201 generated ${label} subjects are production before Red and survive implementation`, () => {
    const d = batch2Source(file, body);
    writeAll(d, manifests);
    const stub = sdd(d, 'tdd', 'stub', 'TEST-CALC-001');
    assert.equal(stub.code, 0, stub.out);
    assert.match(rd130(d, subject), /@id CODE-CALC-001-STUB-\d+ @implements REQ-CALC-001/);
    fakeOut(d, 'AssertionError: not implemented');
    assert.equal(sdd(d, 'tdd', 'red', 'TEST-CALC-001').code, 0);
    fs.writeFileSync(path.join(d, subject), implementation);
    fakeOut(d, 'pass', 0);
    const green = sdd(d, 'tdd', 'green', 'TEST-CALC-001');
    assert.equal(green.code, 0, green.out);
    assert.equal(rd130(d, file), body);
  });
}

test('#201 generated C# subject replacement preserves evidence and actual test contents', () => {
  const body = 'using Good;\nnamespace Tests;\nclass T {\n// @id TEST-CALC-001 @verifies REQ-CALC-001\nvoid test_calc_001() { var t = new Token(); }\n}\n';
  const d = batch2Source('Tests/T.cs', body);
  writeAll(d, { 'Core/Core.csproj': '<Project/>', 'Tests/Tests.csproj': '<Project><ItemGroup><ProjectReference Include="../Core/Core.csproj"/></ItemGroup></Project>' });
  const diagnostic = 'Tests/T.cs(4,47): error CS0246: The type or namespace name \'Token\' could not be found';
  const stub = batch2Run(d, 'dotnet', `if [ "$1" = "--version" ]; then echo 10.0; exit 0; fi\nif [ -f Core/Token.cs ]; then exit 0; fi\necho "${diagnostic}"\nexit 1\n`, ['true'], 'tdd', 'stub', 'TEST-CALC-001');
  assert.equal(stub.code, 0, stub.out);
  assert.match(rd130(d, 'Core/Token.cs'), /@id CODE-CALC-001-STUB-\d+ @implements REQ-CALC-001/);
  fakeOut(d, 'AssertionError: not implemented');
  assert.equal(sdd(d, 'tdd', 'red', 'TEST-CALC-001').code, 0);
  fs.writeFileSync(path.join(d, 'Core/Token.cs'), 'namespace Good;\n// @id CODE-CALC-001 @implements REQ-CALC-001\npublic class Token {}\n');
  fakeOut(d, 'pass', 0);
  const green = sdd(d, 'tdd', 'green', 'TEST-CALC-001');
  assert.equal(green.code, 0, green.out);
  assert.equal(rd130(d, 'Tests/T.cs'), body);
});

for (const [label, file, body, deps, changed] of [
  ['Rust raw string', 'tests/t.rs', 'const ORACLE: &str = include_str!(r#"oracle.txt"#);', { 'tests/oracle.txt': '7' }, 'tests/oracle.txt'],
  ['Rust concat manifest env', 'tests/t.rs', 'const ORACLE: &str = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/oracle.txt"));', { 'Cargo.toml': '[package]\nname="probe"\nversion="0.1.0"\n', 'oracle.txt': '7' }, 'oracle.txt'],
  ['Rust nested path', 'tests/t.rs', 'mod nest {\n#[path = "support.rs"] mod helper;\n}', { 'tests/nest/support.rs': 'pub fn expected() -> i32 { 7 }\n' }, 'tests/nest/support.rs'],
  ['C++ angle header', 'tests/t.cpp', '#include <oracle.hpp>', { 'support/oracle.hpp': '#include <deep.hpp>\n', 'support/deep.hpp': '#define ORACLE 7\n' }, 'support/deep.hpp'],
  ['Java inherited support', 'tests/T.java', 'class T extends Base {\n', { 'tests/Base.java': 'class Base extends Root {}\n', 'tests/Root.java': 'class Root {\n@BeforeEach\nvoid seed() { oracle = 7; }\n}\n' }, 'tests/Root.java'],
  ['PHP inherited support', 'tests/T.php', '<?php\nrequire __DIR__ . "/Base.php";\nclass T extends Base {\n', { 'tests/Base.php': '<?php\nrequire __DIR__ . "/Root.php";\nclass Base extends Root {}\n', 'tests/Root.php': '<?php\nclass Root {\nprotected function setUp(): void { $this->oracle = 7; }\n}\n' }, 'tests/Root.php'],
  ['C# inherited support', 'tests/T.cs', 'class T : Base {\n', { 'tests/Base.cs': 'class Base : Root {}\n', 'tests/Root.cs': 'class Root {\n[SetUp]\nvoid Seed() { oracle = 7; }\n}\n' }, 'tests/Root.cs'],
  ['Julia include closure', 'test/t.jl', 'include("support/oracle.jl")', { 'test/support/oracle.jl': 'include("deep.jl")\n', 'test/support/deep.jl': 'expected() = 7\n' }, 'test/support/deep.jl'],
]) {
  test(`#189 ${label} changes/deletions stale transitive oracle evidence`, () => {
    const julia = file.endsWith('.jl');
    const target = julia ? '# @id TEST-CALC-001 @verifies REQ-CALC-001\n@testset "TEST-CALC-001" begin\n@test value() == expected()\nend\n' : '// @id TEST-CALC-001 @verifies REQ-CALC-001\n' + (file.endsWith('.rs') ? '#[test]\nfn test_calc_001() { assert!(true); }\n' : file.endsWith('.php') ? 'public function test_calc_001(): void { self::assertTrue(true); }\n}\n' : file.endsWith('.java') ? '@Test\nvoid test_calc_001() { assertTrue(true); }\n}\n' : file.endsWith('.cs') ? '[Test]\nvoid test_calc_001() { Assert.True(true); }\n}\n' : 'void test_calc_001() { CHECK(1); }\n');
    const d = batch2Source(file, body + '\n' + target);
    writeAll(d, deps);
    fakeOut(d, 'AssertionError: oracle');
    assert.equal(sdd(d, 'tdd', 'red', 'TEST-CALC-001').code, 0);
    fakeOut(d, 'pass', 0);
    assert.equal(sdd(d, 'tdd', 'green', 'TEST-CALC-001').code, 0);
    fs.writeFileSync(path.join(d, changed), deps[changed].replace('7', '2'));
    assert.match(sdd(d, 'tdd', 'green', 'TEST-CALC-001').out, /changed since Red/);
    assert.match(sdd(d, 'gate', '--no-run').out, /test changed/);
    fs.writeFileSync(path.join(d, changed), deps[changed]);
    fs.rmSync(path.join(d, changed));
    assert.equal(sdd(d, 'tdd', 'green', 'TEST-CALC-001').code, 1);
  });
}

for (const [ext, setup] of [
  ['java', '@Seed\nvoid initializeOracle() { oracle = 7; }\n'],
  ['php', '#[BeforeFixture(\npriority: 0\n)]\nprotected function initializeOracle(): void { $this->oracle = 7; }\n'],
  ['cs', '[NUnit.Framework.SetUp]\nvoid InitializeOracle() { oracle = 7; }\n'],
  ['cs', '[TestInitializeAttribute]\nvoid InitializeOracle() { oracle = 7; }\n'],
  ['cs', '[Init]\nvoid InitializeOracle() { oracle = 7; }\n'],
]) {
  test(`#190 ${ext} lifecycle spelling ${setup.split('\n')[0]} protects callbacks`, () => {
    const pre = ext === 'java' ? '@BeforeEach\n@interface Seed {}\nclass T {\n' : ext === 'php' ? '<?php\nuse PHPUnit\\Framework\\Attributes\\Before as BeforeFixture;\nclass T {\n' : 'using Init = Microsoft.VisualStudio.TestTools.UnitTesting.TestInitializeAttribute;\nclass T {\n';
    const target = ext === 'php' ? 'public function test_calc_001(): void { self::assertSame(1, $this->oracle); }' : ext === 'java' ? '@Test\nvoid test_calc_001() { assertEquals(1, oracle); }' : '[Test]\nvoid test_calc_001() { Assert.AreEqual(1, oracle); }';
    const body = pre + setup + '// @id TEST-CALC-001 @verifies REQ-CALC-001\n' + target + '\n}\n';
    const d = batch2Source(`T.${ext}`, body);
    fakeOut(d, 'AssertionError: oracle');
    assert.equal(sdd(d, 'tdd', 'red', 'TEST-CALC-001').code, 0);
    fs.writeFileSync(path.join(d, `T.${ext}`), body.replace('oracle = 7', 'oracle = 1'));
    fakeOut(d, 'pass', 0);
    assert.match(sdd(d, 'tdd', 'green', 'TEST-CALC-001').out, /changed since Red/);
  });
}

test('#190 sibling nested Java callbacks are isolated but enclosing callbacks stay protected', () => {
  const body = 'class T {\n@BeforeEach\nvoid outer() { int shared = 7; }\n@Nested\nclass Target {\n@BeforeEach\nvoid seed() { int target = 7; }\n// @id TEST-CALC-001 @verifies REQ-CALC-001\n@Test\nvoid test_calc_001() { assertTrue(true); }\n}\n@Nested\nclass Other {\n@BeforeEach\nvoid other() { int unrelated = 7; }\n}\n}\n';
  const d = batch2Source('T.java', body);
  fakeOut(d, 'AssertionError: target');
  assert.equal(sdd(d, 'tdd', 'red', 'TEST-CALC-001').code, 0);
  fakeOut(d, 'pass', 0);
  fs.writeFileSync(path.join(d, 'T.java'), body.replace('unrelated = 7', 'unrelated = 9'));
  assert.equal(sdd(d, 'tdd', 'green', 'TEST-CALC-001').code, 0);
  fs.writeFileSync(path.join(d, 'T.java'), body.replace('shared = 7', 'shared = 9'));
  assert.match(sdd(d, 'tdd', 'green', 'TEST-CALC-001').out, /changed since Red/);
});

test('#190 same-file nested inherited Java callbacks preserve full declaring identities', () => {
  const body = 'class Outer {\nstatic class Base {\n@BeforeEach\nvoid seed() { int oracle = 7; }\n}\n@Nested\nclass Target extends Base {\n// @id TEST-CALC-001 @verifies REQ-CALC-001\n@Test\nvoid test_calc_001() { assertTrue(true); }\n}\n}\n';
  const d = batch2Source('T.java', body);
  fakeOut(d, 'AssertionError: oracle');
  assert.equal(sdd(d, 'tdd', 'red', 'TEST-CALC-001').code, 0);
  fs.writeFileSync(path.join(d, 'T.java'), body.replace('oracle = 7', 'oracle = 1'));
  fakeOut(d, 'pass', 0);
  assert.match(sdd(d, 'tdd', 'green', 'TEST-CALC-001').out, /changed since Red/);
});

test('#189 Rust unresolved include expressions explicitly refuse evidence', () => {
  const d = batch2Source('tests/t.rs', 'const EXPECTED: &str = include_str!(env!("UNRESOLVED_ORACLE"));\n// @id TEST-CALC-001 @verifies REQ-CALC-001\n#[test]\nfn test_calc_001() { assert!(true); }\n');
  fakeOut(d, 'AssertionError: oracle');
  const r = sdd(d, 'tdd', 'red', 'TEST-CALC-001');
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /unresolved Rust include oracle/);
  assert.equal(testEvidence(d).length, 0);
});

test('#195 private PHP test-like helpers remain reachable oracles', () => {
  const body = '<?php\nclass T {\n// @id TEST-CALC-001 @verifies REQ-CALC-001\npublic function test_calc_001(): void { self::assertSame(1, $this->test_oracle()); }\nprivate function test_oracle(): int { return 7; }\n}\n';
  const d = batch2Source('T.php', body);
  fakeOut(d, 'AssertionError: oracle');
  assert.equal(sdd(d, 'tdd', 'red', 'TEST-CALC-001').code, 0);
  fs.writeFileSync(path.join(d, 'T.php'), body.replace('return 7', 'return 1'));
  fakeOut(d, 'pass', 0);
  assert.match(sdd(d, 'tdd', 'green', 'TEST-CALC-001').out, /changed since Red/);
});

test('#196 absolute review files with spaces receive the same validation and stale locks', () => {
  const d = project();
  const template = sdd(d, 'review', 'template', 'calc').out;
  fs.writeFileSync(path.join(d, 'review pending.md'), template);
  for (const review of ['review pending.md', path.join(d, 'review pending.md')]) {
    const r = sdd(d, 'approve', 'record', 'calc', '--by', 'ai:reviewer', '--review', review);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /acceptable review file/);
  }
  fs.writeFileSync(path.join(d, 'review pass.md'), template.replace('verdict: pending', 'verdict: pass'));
  const r = sdd(d, 'approve', 'record', 'calc', '--by', 'ai:reviewer', '--review', path.join(d, 'review pass.md'));
  assert.equal(r.code, 0, r.out);
  assert.equal(sdd(d, 'review', 'check', path.join(d, 'review pass.md'), '--feature', 'calc').code, 0);
  fs.appendFileSync(path.join(d, 'review pass.md'), '\nchanged\n');
  assert.match(sdd(d, 'guard', 'calc').out, /stale/);
});

test('#198 Julia keyword symbols do not absorb sibling test blocks', () => {
  const body = '# @id TEST-CALC-001 @verifies REQ-CALC-001\n@testset "TEST-CALC-001" begin\n@test :begin == Symbol("begin")\nend\n# @id TEST-OTHER-001 @verifies REQ-CALC-001\n@testset "TEST-OTHER-001" begin\n@test 2 == 2\nend\n';
  const d = batch2Source('t.jl', body);
  fakeOut(d, 'AssertionError: target');
  assert.equal(sdd(d, 'tdd', 'red', 'TEST-CALC-001').code, 0);
  fs.writeFileSync(path.join(d, 't.jl'), body.replace('2 == 2', '3 == 3'));
  fakeOut(d, 'pass', 0);
  assert.equal(sdd(d, 'tdd', 'green', 'TEST-CALC-001').code, 0);
});

test('#191 Cargo importer-local aliases and every Julia comma import reach dependents', () => {
  for (const [files, source, dependent] of [
    [{ 'source/Cargo.toml': '[package]\nname="source-pkg"\nversion="0.1.0"\n[lib]\nname="logic"\n',
      'source/src/lib.rs': '// @id CODE-CALC-001 @implements REQ-CALC-001\npub fn answer() -> i32 { 7 }\n',
      'client/Cargo.toml': '[package]\nname="client"\nversion="0.1.0"\n[dependencies]\nrenamed = { package = "source-pkg", path = "../source" }\n',
      'client/src/lib.rs': 'use renamed::*;\n// @id CODE-CLIENT-001 @implements REQ-CALC-001\npub fn value() -> i32 { answer() }\n' }, 'source/src/lib.rs', 'client/src/lib.rs'],
    [{ 'src/Shared.jl': 'module Shared\n# @id CODE-CALC-001 @implements REQ-CALC-001\nfunction value()\n7\nend\nend\n',
      'src/Client.jl': 'module Client\nusing LinearAlgebra, ..Shared\n# @id CODE-CLIENT-001 @implements REQ-CALC-001\nfunction compute()\nvalue()\nend\nend\n' }, 'src/Shared.jl', 'src/Client.jl'],
  ]) {
    const d = approved();
    writeAll(d, files);
    const result = sdd(d, 'impact', source, '--json');
    assert.equal(result.code, 0, result.out);
    assert.ok(JSON.parse(result.out).reachedFiles.includes(dependent), result.out);
  }
});

test('#192 Java wildcard imports never shadow existing project bindings', () => {
  const d = batch2Source('src/test/java/probe/tests/T.java', 'package probe.tests;\nimport probe.api.*;\nclass T {\n// @id TEST-CALC-001 @verifies REQ-CALC-001\nvoid test_calc_001() { Counter.value(); }\n}\n');
  writeAll(d, { 'src/main/java/probe/api/Counter.java': 'package probe.api;\npublic class Counter { public static int value() { return 42; } }\n' });
  const r = sdd(d, 'tdd', 'stub', 'TEST-CALC-001');
  assert.equal(r.code, 0, r.out);
  assert.equal(fs.existsSync(path.join(d, 'src/main/java/probe/tests/Counter.java')), false, r.out);
});

test('#192 PHP grouped aliases resolve the same PSR-4 stub destination', { skip: !has130('php') }, () => {
  const d = batch2Source('tests/T.php', '<?php\nuse Probe\\{Evaluator as Checker};\nclass T {\n// @id TEST-CALC-001 @verifies REQ-CALC-001\npublic function test_calc_001() { self::assertSame(2, Checker::sum(1, 1)); }\n}\n');
  writeAll(d, { 'composer.json': '{"autoload":{"psr-4":{"Probe\\\\":"src/"}}}' });
  const r = sdd(d, 'tdd', 'stub', 'TEST-CALC-001');
  assert.equal(r.code, 0, r.out);
  assert.match(rd130(d, 'src/Evaluator.php'), /namespace Probe;|class Evaluator/);
});

test('#192 C# unreferenced same-named types cannot suppress a missing visible type', () => {
  const d = batch2Source('Tests/T.cs', 'using Good;\nclass T {\n// @id TEST-CALC-001 @verifies REQ-CALC-001\npublic void test_calc_001() { var t = new Token(); }\n}\n');
  writeAll(d, { 'Tests/Tests.csproj': '<Project><ProjectReference Include="../Core/Core.csproj"/></Project>',
    'Core/Core.csproj': '<Project/>', 'Other/Other.csproj': '<Project/>', 'Other/Token.cs': 'namespace Unrelated;\npublic class Token {}\n' });
  const diagnostic = 'Tests/T.cs(4,47): error CS0246: The type or namespace name \'Token\' could not be found';
  const r = batch2Run(d, 'dotnet', `if [ "$1" = "--version" ]; then echo 10.0; exit 0; fi\nif [ -f Core/Token.cs ]; then exit 0; fi\necho "${diagnostic}"\nexit 1\n`, ['true'], 'tdd', 'stub', 'TEST-CALC-001');
  assert.equal(r.code, 0, r.out);
  assert.match(rd130(d, 'Core/Token.cs'), /namespace Good/);
  assert.equal(rd130(d, 'Other/Token.cs'), 'namespace Unrelated;\npublic class Token {}\n');
});

test('#193 CTest names with spaces own C++ pretty-function assertion aborts', () => {
  const d = batch2Source('test.cpp', '// @id TEST-CALC-001 @verifies REQ-CALC-001\nvoid test_calc_001() { oracle(); }\nvoid oracle() { assert(false); }\nvoid unrelated() { assert(false); }\n');
  const output = (functionName) => `1/1 Test #1: suite test_calc_001 case .... Subprocess aborted***Exception: 0.01 sec\ntest.cpp:4: void ${functionName}(): Assertion \`false' failed.\n`;
  fakeOut(d, output('oracle'));
  // Custom runners can also select a literal CTest registration.
  const r = batch2Run(d, 'ctest', 'cat out.txt; exit 1\n', ['ctest', '-R', 'suite test_calc_001 case'], 'tdd', 'red', 'TEST-CALC-001');
  assert.equal(r.code, 0, r.out);
  fakeOut(d, output('unrelated'));
  const crash = batch2Run(d, 'ctest', 'cat out.txt; exit 1\n', ['ctest', '-R', 'suite test_calc_001 case'], 'tdd', 'red', 'TEST-CALC-001');
  assert.equal(crash.code, 1, crash.out);
  assert.match(crash.out, /crashed/);
});

test('#194 C++20 CMake standard is used by a no-op stub syntax check', { skip: !has130('c++') }, () => {
  const d = batch2Source('test.cpp', '#include <concepts>\ntemplate<std::integral T> T same(T x) { return x; }\n// @id TEST-CALC-001 @verifies REQ-CALC-001\nvoid test_calc_001() { same(1); }\n');
  writeAll(d, { 'CMakeLists.txt': 'cmake_minimum_required(VERSION 3.16)\nproject(probe CXX)\nset(CMAKE_CXX_STANDARD 20)\nadd_executable(probe test.cpp)\n' });
  const r = sdd(d, 'tdd', 'stub', 'TEST-CALC-001');
  assert.equal(r.code, 0, r.out);
  assert.doesNotMatch(r.out, /does not compile/);
});

test('#195 PHPUnit same-named methods cannot borrow another declaring class failure', () => {
  const d = batch2Source('T.php', '<?php\nclass Other {\n// @id TEST-CALC-001 @verifies REQ-CALC-001\npublic function testSame(): void { self::assertTrue(true); }\n}\nclass Actual {\npublic function testSame(): void { self::assertTrue(false); }\n}\n');
  fakeOut(d, 'There was 1 failure:\n1) Actual::testSame\nFailed asserting true\nTests: 1, Assertions: 1, Failures: 1.');
  const r = sdd(d, 'tdd', 'red', 'TEST-CALC-001');
  assert.equal(r.code, 1, r.out);
  assert.equal(testEvidence(d).length, 0);
});

test('#197 exact .NET method selection aggregates all runtime display-name rows', () => {
  const d = batch2Source('T.cs', 'namespace Probe;\nclass T {\nconst string Label = "constant row";\n// @id TEST-CALC-001 @verifies REQ-CALC-001\n[DataTestMethod]\n[DataRow(1, DisplayName = "visible row")]\n[DataRow(2, DisplayName = Label)]\npublic void test_calc_001(int value) { Assert.AreEqual(value, Actual(value)); }\n}\n');
  writeAll(d, { 'T.csproj': '<Project/>' });
  const run = (...args) => batch2Run(d, 'dotnet', 'cat out.txt; exit "$(cat exit.txt)"\n', ['dotnet', 'test', '--filter', 'FullyQualifiedName~{idu}'], ...args);
  fs.writeFileSync(path.join(d, 'out.txt'), 'Failed visible row [1 ms]\nFailed constant row [1 ms]\nAssert.AreEqual failed. Expected:<2>. Actual:<0>\nTotal tests: 2\nFailed: 2\n');
  fs.writeFileSync(path.join(d, 'exit.txt'), '1');
  assert.equal(run('tdd', 'red', 'TEST-CALC-001').code, 0);
  fs.writeFileSync(path.join(d, 'out.txt'), 'Passed visible row [1 ms]\nFailed constant row [1 ms]\nAssert.AreEqual failed. Expected:<2>. Actual:<1>\nTotal tests: 2\nPassed: 1\nFailed: 1\n');
  const green = run('tdd', 'green', 'TEST-CALC-001');
  assert.equal(green.code, 1, green.out);
  assert.match(green.out, /test failed/);
  fs.writeFileSync(path.join(d, 'out.txt'), 'Passed visible row [1 ms]\nPassed constant row [1 ms]\nTotal tests: 2\nPassed: 2\n');
  fs.writeFileSync(path.join(d, 'exit.txt'), '0');
  assert.equal(run('tdd', 'green', 'TEST-CALC-001').code, 0);
});

test('#197 NUnit TestCaseSource runtime SetName belongs to the exact filtered method', () => {
  const d = batch2Source('T.cs', 'namespace Probe;\nclass T {\n// @id TEST-CALC-001 @verifies REQ-CALC-001\n[TestCaseSource(nameof(Cases))]\npublic void test_calc_001(int value) { Assert.AreEqual(2, value); }\nIEnumerable Cases() { yield return new TestCaseData(1).SetName("source custom case"); }\n}\n');
  writeAll(d, { 'T.csproj': '<Project/>' });
  const r = batch2Run(d, 'dotnet', 'echo "Failed source custom case [1 ms]"\necho "Expected is <2>"\necho "Total tests: 1"\necho "Failed: 1"\nexit 1\n', ['dotnet', 'test', '--filter', 'FullyQualifiedName~{idu}'], 'tdd', 'red', 'TEST-CALC-001');
  assert.equal(r.code, 0, r.out);
});

test('#197 constructed generic NUnit fixtures use TRX method ownership, not impossible equality', () => {
  const d = batch2Source('T.cs', 'namespace Probe;\n[TestFixture(typeof(int))]\nclass Generic<T> {\n// @id TEST-CALC-001 @verifies REQ-CALC-001\n[Test]\npublic void test_calc_001() { Assert.AreEqual(1, 2); }\n}\n');
  writeAll(d, { 'T.csproj': '<Project/>' });
  const trx = '<TestRun><TestDefinitions><UnitTest id="target"><TestMethod className="Probe.Generic&lt;System.Int32&gt;" name="test_calc_001"/></UnitTest><UnitTest id="sibling"><TestMethod className="Probe.Generic&lt;System.Int32&gt;" name="test_calc_001_extra"/></UnitTest></TestDefinitions><Results><UnitTestResult testId="target" outcome="Failed"/><UnitTestResult testId="sibling" outcome="Passed"/></Results></TestRun>';
  const r = batch2Run(d, 'dotnet', `printf "%s\\n" "$@" > args.log\nmkdir -p .sdd/results\nprintf '%s' '${trx}' > .sdd/results/sdd-target.trx\necho "Failed custom generic case [1 ms]"\necho "Expected is <1>"\nexit 1\n`, ['dotnet', 'test', '--filter', 'FullyQualifiedName~{idu}'], 'tdd', 'red', 'TEST-CALC-001');
  assert.equal(r.code, 0, r.out);
  assert.match(rd130(d, 'args.log'), /FullyQualifiedName~Probe.Generic&FullyQualifiedName~\.test_calc_001/);
  const missing = batch2Run(d, 'dotnet', 'echo "Failed custom generic case [1 ms]"; exit 1\n', ['dotnet', 'test', '--filter', 'FullyQualifiedName~{idu}'], 'tdd', 'green', 'TEST-CALC-001');
  assert.equal(missing.code, 1, missing.out);
  assert.match(missing.out, /generic .NET fixtures require observable TRX/);
});

test('#197 real NUnit constructed fixtures and SetName rows retain runtime method ownership', { skip: !has130('dotnet') }, (t) => {
  const d = batch2Source('T.cs', 'using NUnit.Framework;\nnamespace Probe;\n[TestFixture(typeof(int))]\npublic class Generic<T> {\n// @id TEST-CALC-001 @verifies REQ-CALC-001\n[Test]\npublic void test_calc_001() { Assert.That(Actual.Value(), Is.EqualTo(1)); }\n}\npublic class SourceCases {\n// @id TEST-SOURCE-001 @verifies REQ-CALC-001\n[TestCaseSource(nameof(Cases))]\npublic void test_source_001(int value) { Assert.That(Actual.Value(), Is.EqualTo(value)); }\npublic static System.Collections.IEnumerable Cases() { yield return new TestCaseData(1).SetName("source custom case"); }\n}\n');
  writeAll(d, { 'T.csproj': '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework><RollForward>Major</RollForward><IsTestProject>true</IsTestProject></PropertyGroup><ItemGroup><PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.14.1"/><PackageReference Include="NUnit" Version="4.3.2"/><PackageReference Include="NUnit3TestAdapter" Version="5.0.0"/></ItemGroup></Project>',
    'Actual.cs': 'namespace Probe;\n// @id CODE-CALC-001 @implements REQ-CALC-001\npublic static class Actual { public static int Value() => 0; }\n' });
  if (!restores(d, 'T.csproj')) return t.skip('NUnit packages cannot be restored');
  fs.writeFileSync(path.join(d, '.sdd/config.json'), JSON.stringify({ testCmd: ['dotnet', 'test', '--filter', 'FullyQualifiedName~{idu}'], checks: [] }));
  for (const id of ['TEST-CALC-001', 'TEST-SOURCE-001']) {
    const red = sdd(d, 'tdd', 'red', id);
    assert.equal(red.code, 0, red.out + '\n' + rd130(d, '.sdd/results/sdd-target.trx'));
  }
  fs.writeFileSync(path.join(d, 'Actual.cs'), rd130(d, 'Actual.cs').replace('=> 0', '=> 1'));
  for (const id of ['TEST-CALC-001', 'TEST-SOURCE-001']) {
    const green = sdd(d, 'tdd', 'green', id);
    assert.equal(green.code, 0, green.out + '\n' + rd130(d, '.sdd/results/sdd-target.trx'));
  }
});

test('#198 direct Julia runner exposes qualified standard macro/type nested summaries', { skip: !has130('julia') }, () => {
  for (const enclosing of ['Test.@testset "outer"', '@testset Test.DefaultTestSet "outer"']) {
    const d = batch2Source('test.jl', 'using Test\n' + enclosing + ' begin\n# @id TEST-CALC-001 @verifies REQ-CALC-001\n@testset "TEST-CALC-001" begin\n@test true\nend\nend\n');
    fs.writeFileSync(path.join(d, '.sdd/config.json'), JSON.stringify({ testCmd: ['julia', '--compile=min', '--project=.', '{file}'], checks: [] }));
    const r = sdd(d, 'tdd', 'red', 'TEST-CALC-001', '--characterization', 'visibility');
    assert.equal(r.code, 0, r.out);
  }
});

for (const [file, body, deps] of [
  ['tests/t.rs', 'mod support;\n// @id TEST-CALC-001 @verifies REQ-CALC-001\n#[test]\nfn test_calc_001() { assert_eq!(value(), support::expected()); }\n',
    { 'tests/support/mod.rs': 'mod deep;\npub fn expected() -> i32 { deep::oracle() }\n', 'tests/support/deep.rs': 'pub fn oracle() -> i32 { 7 }\n' }],
  ['tests/t.c', '#include "oracle.h"\n// @id TEST-CALC-001 @verifies REQ-CALC-001\nvoid test_calc_001(void) { assert(actual() == EXPECTED); }\n',
    { 'tests/oracle.h': '#include "deep.h"\n#define EXPECTED ORACLE\n', 'tests/deep.h': '#define ORACLE 7\n#include "oracle.h"\n' }],
]) {
  test(`#181 ${file} transitive external oracle hashes reject changed Red and stale Green`, () => {
    const d = batch2Source(file, body);
    writeAll(d, deps);
    fakeOut(d, 'AssertionError: external oracle');
    assert.equal(sdd(d, 'tdd', 'red', 'TEST-CALC-001').code, 0);
    fakeOut(d, 'pass', 0);
    assert.equal(sdd(d, 'tdd', 'green', 'TEST-CALC-001').code, 0);
    const oracle = Object.keys(deps).at(-1);
    fs.writeFileSync(path.join(d, oracle), deps[oracle].replace('7', '0'));
    const green = sdd(d, 'tdd', 'green', 'TEST-CALC-001');
    assert.equal(green.code, 1, green.out);
    assert.match(green.out, /changed since Red/);
    assert.match(sdd(d, 'gate', '--no-run').out, /test changed/);
  });
}

test('#181 C oracle headers protect root-local expectations but not annotated production', () => {
  const d = batch2Source('t.c', '#include "oracle.h"\n#include "subject.h"\n// @id TEST-CALC-001 @verifies REQ-CALC-001\nvoid test_calc_001(void) { assert(actual() == EXPECTED); }\n');
  writeAll(d, { 'oracle.h': '#define EXPECTED 7\n', 'subject.h': '// @id CODE-CALC-001 @implements REQ-CALC-001\nint actual(void);\n' });
  fakeOut(d, 'AssertionError: oracle');
  assert.equal(sdd(d, 'tdd', 'red', 'TEST-CALC-001').code, 0);
  fs.appendFileSync(path.join(d, 'subject.h'), '// production changed\n');
  fakeOut(d, 'pass', 0);
  assert.equal(sdd(d, 'tdd', 'green', 'TEST-CALC-001').code, 0);
  fs.writeFileSync(path.join(d, 'oracle.h'), '#define EXPECTED 0\n');
  assert.match(sdd(d, 'tdd', 'green', 'TEST-CALC-001').out, /changed since Red/);
});

test('#181 Rust path modules lock executable oracles across a real Cargo Red and Green', { skip: !has130('cargo') }, () => {
  const d = mk130({
    'Cargo.toml': '[package]\nname="oracle181"\nversion="0.1.0"\nedition="2021"\n',
    'src/lib.rs': '// @id CODE-A-001 @implements REQ-A-001\npub fn actual() -> i32 { 0 }\n',
    'tests/t.rs': '#[path="custom/oracle.rs"]\nmod support;\n// @id TEST-A-001 @verifies REQ-A-001\n#[test]\nfn test_a_001() { assert_eq!(oracle181::actual(), support::expected()); }\n',
    'tests/custom/oracle.rs': 'pub fn expected() -> i32 { 7 }\n',
  });
  const red = sdd(d, 'tdd', 'red', 'TEST-A-001');
  assert.equal(red.code, 0, red.out);
  fs.writeFileSync(path.join(d, 'src/lib.rs'), rd130(d, 'src/lib.rs').replace('{ 0 }', '{ 7 }'));
  const green = sdd(d, 'tdd', 'green', 'TEST-A-001');
  assert.equal(green.code, 0, green.out);
  fs.writeFileSync(path.join(d, 'tests/custom/oracle.rs'), 'pub fn expected() -> i32 { 0 }\n');
  fs.writeFileSync(path.join(d, 'src/lib.rs'), rd130(d, 'src/lib.rs').replace('{ 7 }', '{ 0 }'));
  assert.match(sdd(d, 'tdd', 'green', 'TEST-A-001').out, /changed since Red/);
});

test('#181 binary include_bytes oracle changes cannot collide through UTF-8 replacement characters', () => {
  const d = batch2Source('tests/t.rs', 'const EXPECTED: &[u8] = include_bytes!("oracle.bin");\n// @id TEST-CALC-001 @verifies REQ-CALC-001\n#[test]\nfn test_calc_001() { assert_eq!(actual(), EXPECTED); }\n');
  fs.writeFileSync(path.join(d, 'tests/oracle.bin'), Buffer.from([0xff, 0xfe]));
  fakeOut(d, 'AssertionError: bytes');
  assert.equal(sdd(d, 'tdd', 'red', 'TEST-CALC-001').code, 0);
  fs.writeFileSync(path.join(d, 'tests/oracle.bin'), Buffer.from([0xff, 0xff]));
  fakeOut(d, 'pass', 0);
  assert.match(sdd(d, 'tdd', 'green', 'TEST-CALC-001').out, /changed since Red/);
});

test('#182 root, grouped and nested Rust glob imports retain conservative downstream impact', () => {
  for (const clause of ['*', '{*}', 'exports::*', '{exports::*}']) {
    const d = batch2Source('low/tests/t.rs', '// @id TEST-CALC-001 @verifies REQ-CALC-001\n#[test]\nfn test_calc_001() {}\n');
    writeAll(d, {
      'low/Cargo.toml': '[package]\nname="low"\nversion="0.1.0"\n',
      'high/Cargo.toml': '[package]\nname="high"\nversion="0.1.0"\n[dependencies]\nlow={path="../low"}\n',
      'low/src/lib.rs': 'pub mod exports;\npub use exports::*;\n',
      'low/src/exports.rs': '// @id CODE-CALC-001 @implements REQ-CALC-001\npub fn value() -> i32 { 1 }\n',
      'high/src/lib.rs': `use low::${clause};\n// @id CODE-HIGH-001 @implements REQ-HIGH-001\npub fn consume() -> i32 { value() }\n`,
      'high/tests/client.rs': 'use high::consume;\n// @id TEST-HIGH-001 @verifies REQ-HIGH-001\n#[test]\nfn test_high_001() { assert_eq!(consume(), 1); }\n',
      '.sdd/specs/high.md': '---\nfeature: high\ntier: T1\n---\n| REQ-HIGH-001 | consume | TEST-HIGH-001 |\n',
    });
    const impact = sdd(d, 'impact', 'REQ-CALC-001', '--json');
    assert.equal(impact.code, 0, impact.out);
    assert.match(impact.out, /high\/src\/lib.rs/, clause);
    assert.match(impact.out, /TEST-HIGH-001/, clause);
  }
});

test('#183 Rust raw string and byte raw string braces preserve exact inline modules', { skip: !has130('cargo') }, () => {
  const d = mk130({
    'Cargo.toml': '[package]\nname="raw183"\nversion="0.1.0"\nedition="2021"\n',
    'src/lib.rs': 'mod tests {\nconst RAW: &str = r#""}"#;\nconst BYTES: &[u8] = br##""}}"##;\nconst PLAIN: &str = r"{";\n// @id TEST-A-001 @verifies REQ-A-001\n#[test]\nfn test_a_001() { assert_eq!(RAW.len()+BYTES.len()+PLAIN.len(), 0, "raw target assertion"); }\n}\n',
  });
  const red = sdd(d, 'tdd', 'red', 'TEST-A-001');
  assert.equal(red.code, 0, red.out);
  assert.match(red.out, /raw target assertion/);
});

for (const [ext, container, expected, runner] of [
  ['java', 'class Outer { @Nested class Inner {', 'probe.Outer$Inner.test_calc_001', 'mvn'],
  ['cs', 'class Outer { class Inner {', 'probe.Outer+Inner.test_calc_001', 'dotnet'],
  ['cs', 'record RecordTests {', 'probe.RecordTests.test_calc_001', 'dotnet'],
  ['cs', 'record class Outer { record Inner {', 'probe.Outer+Inner.test_calc_001', 'dotnet'],
]) {
  test(`#183 ${ext} ${container} uses runtime-qualified selection and attribution`, () => {
    const cls = expected.slice(0, -'.test_calc_001'.length);
    const source = `${ext === 'java' ? 'package probe;' : 'namespace probe;'}\n${container}\n// @id TEST-CALC-001 @verifies REQ-CALC-001\n${ext === 'java' ? '@Test' : '[Fact]'}\npublic void test_calc_001() { assert(false); }\n${container.includes('Inner') ? '}' : ''}\n}\n`;
    const d = batch2Source(`T.${ext}`, source);
    const cmd = runner === 'mvn' ? ['mvn', 'test', '-Dtest=*#*{idu}'] : ['dotnet', 'test', '--filter', 'FullyQualifiedName~{idu}'];
    const output = runner === 'mvn' ? `SDD-TEST ${cls} test_calc_001 FAILURE\nexpected: <2> but was: <1>` : `Failed ${expected} [1 ms]\nAssert.True() Failure`;
    const red = batch2Run(d, runner, `printf "%s\\n" "$@" > args.log\ncat <<'OUT'\n${output}\nOUT\nexit 1\n`, cmd, 'tdd', 'red', 'TEST-CALC-001');
    assert.equal(red.code, 0, red.out);
    const args = fs.readFileSync(path.join(d, 'args.log'), 'utf8');
    assert.ok(args.includes(runner === 'mvn' ? `-Dtest=${cls}#test_calc_001` : `FullyQualifiedName=${expected}`), args);
  });
}

test('#183 Maven successful build without fresh target results rejects all TDD evidence', () => {
  const d = batch2Source('T.java', 'package probe;\nclass Outer {\n@Nested class Inner {\n// @id TEST-CALC-001 @verifies REQ-CALC-001\n@Test\nvoid test_calc_001() { assertEquals(2,1); }\n}\n}\n');
  const cmd = ['mvn', 'test', '-Dtest=*#*{idu}'];
  const run = (body, ...args) => batch2Run(d, 'mvn', body, cmd, 'tdd', ...args);
  const red = run('echo "[INFO] BUILD SUCCESS"\n', 'red', 'TEST-CALC-001', '--characterization', 'unexecuted');
  assert.equal(red.code, 1, red.out);
  assert.match(red.out, /no test matched|never ran/);
  assert.equal(run('echo \'SDD-TEST probe.Outer$Inner test_calc_001 FAILURE\'\necho "expected: <2> but was: <1>"\nexit 1\n', 'red', 'TEST-CALC-001').code, 0);
  for (const sub of ['green', 'red']) {
    assert.equal(run('echo "[INFO] BUILD SUCCESS"\n', sub, 'TEST-CALC-001', ...(sub === 'red' ? ['--characterization', 'none'] : [])).code, 1);
  }
  assert.equal(run('echo \'SDD-TEST probe.Outer$Inner test_calc_001 SUCCESS\'\n', 'green', 'TEST-CALC-001').code, 0);
  assert.equal(run('echo "[INFO] BUILD SUCCESS"\n', 'refactor', 'TEST-CALC-001').code, 1);
});

test('#184 inline qualified JUnit annotations preserve sibling hash isolation and helpers', () => {
  const body = 'class Target {\n// @id TEST-CALC-001 @verifies REQ-CALC-001\n@org.junit.jupiter.api.Test void test_calc_001() { assertEquals(expected(),actual()); }\n@Test void sibling() { assertTrue(true); }\nint expected() { return 7; }\n}\n';
  const d = batch2Source('T.java', body);
  fakeOut(d, 'AssertionError: target');
  assert.equal(sdd(d, 'tdd', 'red', 'TEST-CALC-001').code, 0);
  fakeOut(d, 'pass', 0);
  assert.equal(sdd(d, 'tdd', 'green', 'TEST-CALC-001').code, 0);
  fs.writeFileSync(path.join(d, 'T.java'), body.replace('assertTrue(true)', 'assertEquals(4,2+2)'));
  const green = sdd(d, 'tdd', 'green', 'TEST-CALC-001');
  assert.equal(green.code, 0, green.out);
  fs.writeFileSync(path.join(d, 'T.java'), body.replace('return 7', 'return 0'));
  assert.match(sdd(d, 'tdd', 'green', 'TEST-CALC-001').out, /changed since Red/);
});

for (const attr of ['Before', 'After', 'BeforeClass', 'AfterClass', 'PreCondition', 'PostCondition', '\\PHPUnit\\Framework\\Attributes\\Before', 'Prime']) {
  test(`#184 PHPUnit ${attr} lifecycle attribute protects oracle hashes`, () => {
    const body = `<?php\nuse PHPUnit\\Framework\\Attributes\\Before as Prime;\nclass Target {\n#[${attr}]\npublic function primeOracle(): void { $this->oracle = 7; }\n// @id TEST-CALC-001 @verifies REQ-CALC-001\npublic function test_calc_001(): void { self::assertSame($this->oracle, actual()); }\npublic function unrelated(): void { $n = 99; }\n}\n`;
    const d = batch2Source('T.php', body);
    fakeOut(d, 'AssertionError: oracle');
    assert.equal(sdd(d, 'tdd', 'red', 'TEST-CALC-001').code, 0);
    fakeOut(d, 'pass', 0);
    fs.writeFileSync(path.join(d, 'T.php'), body.replace('$n = 99', '$n = 100'));
    assert.equal(sdd(d, 'tdd', 'green', 'TEST-CALC-001').code, 0);
    fs.writeFileSync(path.join(d, 'T.php'), body.replace('oracle = 7', 'oracle = 0'));
    assert.match(sdd(d, 'tdd', 'green', 'TEST-CALC-001').out, /changed since Red/);
  });
}

test('#184 grouped PHP import aliases and combined attributes protect lifecycle callbacks', () => {
  const body = '<?php\nuse PHPUnit\\Framework\\Attributes\\{Before as Prime, After as Finish};\nclass Target {\n#[Unrelated, Prime]\npublic function primeOracle(): void { $this->oracle = 7; }\n#[Finish] public function finishOracle(): void { $this->done = true; }\n// @id TEST-CALC-001 @verifies REQ-CALC-001\npublic function test_calc_001(): void { self::assertSame($this->oracle, actual()); }\n}\n';
  const d = batch2Source('T.php', body);
  fakeOut(d, 'AssertionError: oracle');
  assert.equal(sdd(d, 'tdd', 'red', 'TEST-CALC-001').code, 0);
  fs.writeFileSync(path.join(d, 'T.php'), body.replace('oracle = 7', 'oracle = 0'));
  fakeOut(d, 'pass', 0);
  assert.match(sdd(d, 'tdd', 'green', 'TEST-CALC-001').out, /changed since Red/);
});

test('#185 overloaded JUnit methods in one class fail closed, unrelated classes are allowed', () => {
  const body = 'package probe;\nclass Target {\n// @id TEST-CALC-001 @verifies REQ-CALC-001\n@Test void test_calc_001() { assertTrue(true); }\n@ParameterizedTest\nvoid test_calc_001(int n) { assertEquals(2,n); }\n}\nclass Other { void test_calc_001(String n) {} }\n';
  const d = batch2Source('T.java', body);
  const cmd = ['mvn', 'test', '-Dtest=*#*{idu}'];
  const output = 'echo "SDD-TEST probe.Target test_calc_001 SUCCESS"\necho "SDD-TEST probe.Target test_calc_001(int)[1] FAILURE"\necho "expected: <2> but was: <3>"\nexit 1\n';
  const red = batch2Run(d, 'mvn', output, cmd, 'tdd', 'red', 'TEST-CALC-001');
  assert.equal(red.code, 1, red.out);
  assert.match(red.out, /overload|ambiguous.*method|unique.*method/i);
  assert.equal(testEvidence(d).length, 0);
  fs.writeFileSync(path.join(d, 'T.java'), body.replace('void test_calc_001(int n)', 'void other(int n)'));
  const control = batch2Run(d, 'mvn', output, cmd, 'tdd', 'red', 'TEST-CALC-001');
  assert.equal(control.code, 1, control.out);
  assert.match(control.out, /itself passes|test passed/);
});

test('#185 solution-root .NET runner selects annotated test owning csproj', () => {
  const d = batch2Source('A/T.cs', 'namespace Probe;\nclass SharedTests {\n// @id TEST-CALC-001 @verifies REQ-CALC-001\n[Fact]\npublic void Calculates() { Assert.True(true); }\n}\n');
  writeAll(d, {
    'A/A.csproj': '<Project><PropertyGroup><IsTestProject>true</IsTestProject></PropertyGroup></Project>',
    'B/B.csproj': '<Project><PropertyGroup><IsTestProject>true</IsTestProject></PropertyGroup></Project>',
    'B/T.cs': 'namespace Probe;\nclass SharedTests { public void Calculates() { Assert.True(false); } }\n',
    'Probe.sln': '',
  });
  const red = batch2Run(d, 'dotnet', `printf "%s\\n" "$@" > args.log
echo "Passed Probe.SharedTests.Calculates [1 ms]"
if ! printf "%s\\n" "$@" | grep -q 'A/A.csproj'; then
  echo "Failed Probe.SharedTests.Calculates [1 ms]"
  echo "Assert.True() Failure"
  exit 1
fi
`, ['dotnet', 'test', '--nologo', '--filter', 'FullyQualifiedName~{idu}'], 'tdd', 'red', 'TEST-CALC-001');
  assert.equal(red.code, 1, red.out);
  assert.match(red.out, /test passed/);
  assert.match(fs.readFileSync(path.join(d, 'args.log'), 'utf8'), /A\/A.csproj/);
  assert.equal(testEvidence(d).length, 0);
});

test('#186 C standard assert in a reachable transitive helper is strong Red, unrelated helpers cannot excuse crashes', () => {
  const d = batch2Source('T.c', '// @id TEST-CALC-001 @verifies REQ-CALC-001\nvoid test_calc_001(void) { check(); }\nvoid check(void) { oracle(0); }\nvoid oracle(int n) { assert(n==1); }\nvoid unrelated(void) { assert(0); }\n');
  const output = (fn) => `1/1 Test #1: test_calc_001 ... Subprocess aborted***Exception: 0.1 sec\nT: T.c:4: ${fn}: Assertion \`n == 1' failed.\n`;
  fakeOut(d, output('oracle'));
  const red = sdd(d, 'tdd', 'red', 'TEST-CALC-001', '--expect', 'Assertion');
  assert.equal(red.code, 0, red.out);
  assert.doesNotMatch(red.out, /\[weak\]/);
  fakeOut(d, output('unrelated'));
  assert.match(sdd(d, 'tdd', 'red', 'TEST-CALC-001', '--weak').out, /crashed/);
});

for (const registration of ['group.test_calc_001', 'group/test_calc_001', 'group.test_calc_001.case+1']) {
  test(`#186 unique punctuation CTest registration ${registration} is escaped and anchored`, () => {
    const d = batch2Source('T.c', '// @id TEST-CALC-001 @verifies REQ-CALC-001\nvoid test_calc_001(void) { CHECK(0); }\n');
    const red = batch2Run(d, 'ctest', `if [ "$1" = "--show-only=json-v1" ]; then
echo '{"tests":[{"name":"${registration}"},{"name":"group.test_calc_0011"}]}'
exit 0
fi
printf "%s\\n" "$@" > args.log
echo "1/1 Test #1: ${registration} ... ***Failed"
echo "CHECK failed: target"
exit 1
`, ['ctest', '-R', '{idu}'], 'tdd', 'red', 'TEST-CALC-001');
    assert.equal(red.code, 0, red.out);
    const regex = fs.readFileSync(path.join(d, 'args.log'), 'utf8').split('\n')[1];
    assert.ok(new RegExp(regex).test(registration), regex);
    assert.ok(!new RegExp(regex).test(registration + '1'), regex);
    if (registration.includes('.')) assert.ok(!new RegExp(regex).test(registration.replace('.', 'X')), regex);
  });
}

test('#187 Julia --expect is confined to selected target failure diagnostics', () => {
  const d = batch2Source('T.jl', 'using Test\n# @id TEST-CALC-001 @verifies REQ-CALC-001\n@testset "TEST-CALC-001" begin\n@test 2 == 3\nend\n');
  const text = 'TEST-CALC-001: Test Failed at T.jl:4\nExpression: 2 == 3\nEvaluated: 2 == 3\nTEST-SIBLING-001: Test Failed at T.jl:9\nExpression: "SIBLING_ONLY_SENTINEL" == "other"\nTest Summary: | Fail Total Time\nTEST-CALC-001 | 1 1 0.1s\nTEST-SIBLING-001 | 1 1 0.1s\n';
  fakeOut(d, text);
  const wrong = sdd(d, 'tdd', 'red', 'TEST-CALC-001', '--expect', 'SIBLING_ONLY_SENTINEL');
  assert.equal(wrong.code, 1, wrong.out);
  assert.match(wrong.out, /wrong reason|does not contain/);
  const red = sdd(d, 'tdd', 'red', 'TEST-CALC-001', '--expect', '2 == 3');
  assert.equal(red.code, 0, red.out);
  assert.match(red.out, /fails with: Expression: 2 == 3/);
});

test('#187 Julia nested failure diagnostics use annotated source ownership, not sibling messages', () => {
  const d = batch2Source('T.jl', 'using Test\n# @id TEST-CALC-001 @verifies REQ-CALC-001\n@testset "TEST-CALC-001" begin\n@testset "detail" begin\n@test 2 == 3\nend\nend\n# @id TEST-SIBLING-001 @verifies REQ-CALC-001\n@testset "TEST-SIBLING-001" begin\n@test false\nend\n');
  fakeOut(d, 'detail: Test Failed at T.jl:5\nExpression: 2 == 3\nother: Test Failed at T.jl:10\nExpression: SIBLING_SENTINEL\nTest Summary: | Fail Total Time\nTEST-CALC-001 | 1 1 0.1s\n detail | 1 1 0.1s\nTEST-SIBLING-001 | 1 1 0.1s\n');
  const wrong = sdd(d, 'tdd', 'red', 'TEST-CALC-001', '--expect', 'SIBLING_SENTINEL');
  assert.equal(wrong.code, 1, wrong.out);
  assert.match(wrong.out, /does not contain/);
  const red = sdd(d, 'tdd', 'red', 'TEST-CALC-001', '--expect', '2 == 3');
  assert.equal(red.code, 0, red.out);
  assert.match(red.out, /fails with: Expression: 2 == 3/);
});

test('#187 hyphen-extended Julia IDs cannot supply skipped target execution', () => {
  const d = batch2Source('T.jl', 'using Test\n# @id TEST-CALC-001 @verifies REQ-CALC-001\n@testset "TEST-CALC-001" begin\n@test_skip false\nend\n');
  const run = (status) => fakeOut(d, `Test Summary: | ${status} Broken Total Time\nTEST-CALC-001 | 0 1 1 0.1s\nTEST-CALC-001-OTHER | 1 0 1 0.1s\n`, status === 'Pass' ? 0 : 1);
  run('Fail');
  const red = sdd(d, 'tdd', 'red', 'TEST-CALC-001');
  assert.equal(red.code, 1, red.out);
  assert.match(red.out, /skipped/);
  run('Pass');
  assert.equal(sdd(d, 'tdd', 'red', 'TEST-CALC-001', '--characterization', 'skipped').code, 1);
  assert.equal(testEvidence(d).length, 0);
});

test('#187 hyphen-extended passing Julia sibling cannot supply Green or Refactor for a skipped target', () => {
  const d = batch2Source('T.jl', 'using Test\n# @id TEST-CALC-001 @verifies REQ-CALC-001\n@testset "TEST-CALC-001" begin\nif skip_target()\n@test_skip false\nelse\n@test actual() == 1\nend\nend\n');
  fakeOut(d, 'Test Summary: | Fail Total Time\nTEST-CALC-001 | 1 1 0.1s\n');
  assert.equal(sdd(d, 'tdd', 'red', 'TEST-CALC-001').code, 0);
  fakeOut(d, 'Test Summary: | Pass Total Time\nTEST-CALC-001 | 1 1 0.1s\n', 0);
  assert.equal(sdd(d, 'tdd', 'green', 'TEST-CALC-001').code, 0);
  fakeOut(d, 'Test Summary: | Pass Broken Total Time\nTEST-CALC-001 | 0 1 1 0.1s\nTEST-CALC-001-OTHER | 1 0 1 0.1s\n', 0);
  for (const sub of ['green', 'refactor']) {
    const result = sdd(d, 'tdd', sub, 'TEST-CALC-001');
    assert.equal(result.code, 1, result.out);
    assert.match(result.out, /no test matched/);
  }
});

test('#187 passing Julia changed-target retest stays weak despite a failing sibling', () => {
  const body = 'using Test\n# @id TEST-CALC-001 @verifies REQ-CALC-001\n@testset "TEST-CALC-001" begin\n@test actual() == 1\nend\n';
  const d = batch2Source('T.jl', body);
  fakeOut(d, 'Test Summary: | Fail Total Time\nTEST-CALC-001 | 1 1 0.1s\n');
  assert.equal(sdd(d, 'tdd', 'red', 'TEST-CALC-001').code, 0);
  fakeOut(d, 'Test Summary: | Pass Total Time\nTEST-CALC-001 | 1 1 0.1s\nTest Summary: | Fail Total Time\nTEST-SIBLING-001 | 1 1 0.1s\n');
  assert.equal(sdd(d, 'tdd', 'green', 'TEST-CALC-001').code, 0);
  fs.writeFileSync(path.join(d, 'T.jl'), body.replace('@test actual() == 1', '@test actual() == 1\n@test actual() > 0'));
  const red = sdd(d, 'tdd', 'red', 'TEST-CALC-001', '--retest', 'Add positivity oracle');
  assert.equal(red.code, 0, red.out);
  assert.match(red.out, /\[weak\].*|retest/);
  const last = JSON.parse(rd130(d, '.sdd/tdd.jsonl').trim().split('\n').at(-1));
  assert.equal(last.weakWhy, 'retest');
  assert.equal(last.retest, 'Add positivity oracle');
  assert.equal(sdd(d, 'tdd', 'green', 'TEST-CALC-001').code, 0);
});

test('#188 Julia verbosity transform leaves custom testset constructors unchanged', { skip: !has130('julia') }, () => {
  const d = mk130({
    'Project.toml': 'name="Fixture"\n',
    'test/t.jl': `using Test
struct CompactSet <: Test.AbstractTestSet
    inner::Test.DefaultTestSet
    CompactSet(desc) = new(Test.DefaultTestSet(desc; verbose=true))
end
Test.record(t::CompactSet, x) = Test.record(t.inner, x)
Test.finish(t::CompactSet) = Test.finish(t.inner)
# @id TEST-A-001 @verifies REQ-A-001
@testset CompactSet "TEST-A-001" begin
    @test false
end
`,
  });
  const red = sdd(d, 'tdd', 'red', 'TEST-A-001');
  assert.equal(red.code, 0, red.out);
  assert.match(red.out, /Expression: false/);
});

test('#188 custom Julia script launcher preserves the selected file argument', () => {
  const d = batch2Source('test/t.jl', 'using Test\n# @id TEST-CALC-001 @verifies REQ-CALC-001\n@testset "TEST-CALC-001" begin\n@test false\nend\n');
  writeAll(d, { 'test/runner.jl': 'include(abspath(ARGS[1]))\n' });
  const red = batch2Run(d, 'julia', 'printf "%s\\n" "$@" > args.log\necho "TEST-CALC-001: Test Failed at test/t.jl:4"\necho "Expression: false"\necho "Test Summary: | Fail Total Time"\necho "TEST-CALC-001 | 1 1 0.1s"\nexit 1\n',
    ['julia', '--compile=min', '--project=.', 'test/runner.jl', '{file}'], 'tdd', 'red', 'TEST-CALC-001');
  assert.equal(red.code, 0, red.out);
  assert.equal(fs.readFileSync(path.join(d, 'args.log'), 'utf8'), '--compile=min\n--project=.\ntest/runner.jl\ntest/t.jl\n');
});

test('#171 Cargo selects the owning integration binary and package', { skip: !has130('cargo') }, () => {
  const d = mk130({
    'Cargo.toml': '[package]\nname="owner171"\nversion="0.1.0"\nedition="2021"\n',
    'src/lib.rs': '',
    'tests/target.rs': '// @id TEST-A-001 @verifies REQ-A-001\n#[test]\nfn test_a_001() { assert!(true); }\n',
    'tests/sibling.rs': '#[test]\nfn test_a_001() { assert!(false, "wrong binary"); }\n',
  });
  const r = sdd(d, 'tdd', 'red', 'TEST-A-001');
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /test passed/);
  assert.doesNotMatch(r.out, /wrong binary/);
  fs.writeFileSync(path.join(d, 'tests/target.rs'), rd130(d, 'tests/target.rs').replace('#[test]', '#[test]\n#[ignore]'));
  const skipped = sdd(d, 'tdd', 'red', 'TEST-A-001', '--characterization', 'ignored');
  assert.equal(skipped.code, 1, skipped.out);
  assert.match(skipped.out, /skipped|no test matched/);
});

test('#171 Rust outcome attribution does not merge identical names across executable headers', () => {
  const d = batch2Source('tests/target.rs', '// @id TEST-CALC-001 @verifies REQ-CALC-001\n#[test]\nfn test_calc_001() { assert!(true); }\n');
  fakeOut(d, 'Running tests/target.rs (target/debug/deps/target-abcd)\ntest test_calc_001 ... ignored\nRunning tests/sibling.rs (target/debug/deps/sibling-abcd)\ntest test_calc_001 ... ok\n', 0);
  assert.equal(sdd(d, 'tdd', 'red', 'TEST-CALC-001', '--characterization', 'ignored').code, 1);
  fakeOut(d, 'Running tests/target.rs (target/debug/deps/target-abcd)\ntest test_calc_001 ... ok\nRunning tests/sibling.rs (target/debug/deps/sibling-abcd)\ntest test_calc_001 ... FAILED\nassertion failed: wrong binary\n');
  assert.match(sdd(d, 'tdd', 'red', 'TEST-CALC-001').out, /itself passes/);
});

for (const runner of ['mvn', 'gradle']) {
  test(`#171 ${runner} exact class selection and disabled-target attribution`, () => {
    const d = batch2Source('tests/TargetTest.java', 'package probe;\nclass TargetTest {\n// @id TEST-CALC-001 @verifies REQ-CALC-001\n@Disabled\n@Test\npublic void test_calc_001() { assertEquals(1, 0); }\n}\n');
    const cmd = runner === 'mvn' ? ['mvn', 'test', '-Dtest=*#*{idu}'] : ['sh', '-c', 'gradle test --tests "*$0"', '{idu}'];
    const result = batch2Run(d, runner, 'printf "%s\\n" "$@" > args.log\nprintf "%s\\n" "SDD-TEST probe.TargetTest test_calc_001 SKIPPED" "SDD-TEST probe.OtherTest test_calc_001 SUCCESS" "Tests run: 2, Failures: 0, Skipped: 1"\n', cmd, 'tdd', 'red', 'TEST-CALC-001', '--characterization', 'disabled');
    assert.equal(result.code, 1, result.out);
    assert.match(result.out, /skipped|no test matched/);
    const args = fs.readFileSync(path.join(d, 'args.log'), 'utf8');
    assert.match(args, runner === 'mvn' ? /-Dtest=probe.TargetTest#test_calc_001/ : /probe.TargetTest.test_calc_001/);
  });
}

test('#171 Maven uses fresh exact-class XML, never stale reports or sibling results', () => {
  const d = batch2Source('tests/TargetTest.java', 'package probe;\nclass TargetTest {\n// @id TEST-CALC-001 @verifies REQ-CALC-001\n@Test\npublic void test_calc_001() { assertEquals(1, 0); }\n}\n');
  const reports = path.join(d, 'target/surefire-reports');
  fs.mkdirSync(reports, { recursive: true });
  fs.writeFileSync(path.join(reports, 'stale.xml'), '<testsuite><testcase classname="probe.TargetTest" name="test_calc_001"><failure/></testcase></testsuite>');
  const runXml = (xml, exit) => batch2Run(d, 'mvn', `mkdir -p target/surefire-reports
cat > target/surefire-reports/current.xml <<'XML'
${xml}
XML
echo "Tests run: 2, Failures: ${exit}, Errors: 0, Skipped: 1"
exit ${exit}
`, ['mvn', 'test', '-Dtest=*#*{idu}'], 'tdd', 'red', 'TEST-CALC-001', '--characterization', 'fixture');
  const skipped = runXml('<testsuite><testcase classname="probe.TargetTest" name="test_calc_001"><skipped/></testcase><testcase classname="probe.OtherTest" name="test_calc_001"/></testsuite>', 0);
  assert.equal(skipped.code, 1, skipped.out);
  assert.equal(fs.existsSync(path.join(reports, 'stale.xml')), false);
  const passed = runXml('<testsuite><testcase classname="probe.TargetTest" name="test_calc_001"/><testcase classname="probe.OtherTest" name="test_calc_001"><failure>assertion failed</failure></testcase></testsuite>', 1);
  assert.equal(passed.code, 1, passed.out);
  assert.match(passed.out, /itself passes/);
});

test('#171 Cargo workspace siblings cannot supply a same-named target Red', { skip: !has130('cargo') }, () => {
  const d = mk130({
    'Cargo.toml': '[workspace]\nmembers=["owner", "sibling"]\nresolver="2"\n',
    'owner/Cargo.toml': '[package]\nname="owner171"\nversion="0.1.0"\nedition="2021"\n',
    'owner/src/lib.rs': '',
    'owner/tests/target.rs': '// @id TEST-A-001 @verifies REQ-A-001\n#[test]\nfn test_a_001() { assert!(true); }\n',
    'sibling/Cargo.toml': '[package]\nname="sibling171"\nversion="0.1.0"\nedition="2021"\n',
    'sibling/src/lib.rs': '',
    'sibling/tests/target.rs': '#[test]\nfn test_a_001() { assert!(false, "wrong package"); }\n',
  });
  const red = sdd(d, 'tdd', 'red', 'TEST-A-001');
  assert.equal(red.code, 1, red.out);
  assert.match(red.out, /test passed/);
  assert.doesNotMatch(red.out, /wrong package/);
});

test('#172 out-of-line Rust modules retain exact module qualification', { skip: !has130('cargo') }, () => {
  const d = mk130({
    'Cargo.toml': '[package]\nname="modules172"\nversion="0.1.0"\nedition="2021"\n',
    'src/lib.rs': '#[cfg(test)]\nmod tests;\n',
    'src/tests.rs': '// @id TEST-A-001 @verifies REQ-A-001\n#[test]\nfn test_a_001() { assert!(false, "out of line target"); }\n',
  });
  const red = sdd(d, 'tdd', 'red', 'TEST-A-001');
  assert.equal(red.code, 0, red.out);
  assert.match(red.out, /out of line target/);
});

test('#172 C# character literals cannot pop enclosing class qualification', () => {
  const d = batch2Source('T.cs', "namespace Fixture;\nclass Target {\nconst char Close = '}';\n// @id TEST-CALC-001 @verifies REQ-CALC-001\n[Test]\npublic void test_calc_001() { Assert.True(true); }\n}\n");
  const r = batch2Run(d, 'dotnet', 'printf "%s\\n" "$@" > args.log\necho "Passed Fixture.Target.test_calc_001 [1 ms]"\necho "Total tests: 1"\necho "Passed: 1"\n', ['dotnet', 'test', '--filter', 'FullyQualifiedName~{idu}'], 'tdd', 'red', 'TEST-CALC-001', '--characterization', 'data');
  assert.equal(r.code, 0, r.out);
  assert.match(fs.readFileSync(path.join(d, 'args.log'), 'utf8'), /FullyQualifiedName=Fixture.Target.test_calc_001/);
});

for (const [name, output] of [
  ['Cargo', 'running 0 tests\ntest result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out\n'],
  ['VSTest minimal', 'Skipped! - Failed:     0, Passed:     0, Skipped:     1, Total:     1\n'],
  ['VSTest normal', 'Skipped ignored [1 ms]\nTotal tests: 1\nSkipped: 1\n'],
]) {
  test(`#173 ${name} zero execution rejects evidence and full PASS`, () => {
    const d = approved();
    impl(d, '(a,b) => a+b');
    fakeOut(d, 'AssertionError: target');
    assert.equal(sdd(d, 'tdd', 'red', 'TEST-CALC-001').code, 0);
    fakeOut(d, 'pass', 0);
    assert.equal(sdd(d, 'tdd', 'green', 'TEST-CALC-001').code, 0);
    fakeOut(d, output, 0, { checks: [{ name: 'test', cmd: ['node', '-e', `console.log(${JSON.stringify(output)})`] }] });
    for (const sub of ['green', 'refactor']) assert.equal(sdd(d, 'tdd', sub, 'TEST-CALC-001').code, 1, name);
    assert.equal(sdd(d, 'tdd', 'red', 'TEST-CALC-001', '--characterization', 'none').code, 1);
    const gate = sdd(d, 'gate');
    assert.equal(gate.code, 2, gate.out);
    assert.match(gate.out, /INCOMPLETE/);
  });
}

test('#173 a solution sibling no-match cannot override an executed NUnit target', () => {
  const d = batch2Source('T.cs', 'namespace Fixture;\nclass Target {\n// @id TEST-CALC-001 @verifies REQ-CALC-001\n[Test]\npublic void test_calc_001() { Assert.True(false); }\n}\n');
  fakeOut(d, 'Failed Fixture.Target.test_calc_001 [1 ms]\nExpected: True\nTotal tests: 1\nFailed: 1\nNo test matches the given testcase filter in Other.dll\n');
  const red = sdd(d, 'tdd', 'red', 'TEST-CALC-001');
  assert.equal(red.code, 0, red.out);
});

for (const [ext, setup, testBody] of [
  ['java', '@BeforeEach\nvoid prepareOracle() { oracle = 7; }', '@Test\nvoid test_calc_001() { assertEquals(oracle, value()); }'],
  ['java', '@BeforeAll\nstatic void prepareOracle() { oracle = 7; }', '@Test\nvoid test_calc_001() { assertEquals(oracle, value()); }'],
  ['php', 'protected function setUp(): void { $this->oracle = 7; }', 'public function test_calc_001(): void { self::assertSame($this->oracle, value()); }'],
  ['php', 'public static function setUpBeforeClass(): void { self::$oracle = 7; }', 'public function test_calc_001(): void { self::assertSame(self::$oracle, value()); }'],
  ['cs', '[TestInitialize]\npublic void Initialize() { oracle = 7; }', '[TestMethod]\npublic void test_calc_001() { Assert.AreEqual(oracle, value()); }'],
  ['cs', '[SetUp]\npublic void Initialize() { oracle = 7; }', '[Test]\npublic void test_calc_001() { Assert.AreEqual(oracle, value()); }'],
]) {
  test(`#174 ${ext} lifecycle ${setup.split('\n')[0]} protects Red and Green hashes`, () => {
    const body = `class Target {\n${setup}\n\n// @id TEST-CALC-001 @verifies REQ-CALC-001\n${testBody}\n}\n`;
    const d = batch2Source(`T.${ext}`, body);
    fakeOut(d, 'AssertionError: oracle');
    assert.equal(sdd(d, 'tdd', 'red', 'TEST-CALC-001').code, 0);
    fakeOut(d, 'pass', 0);
    assert.equal(sdd(d, 'tdd', 'green', 'TEST-CALC-001').code, 0);
    fs.writeFileSync(path.join(d, `T.${ext}`), body.replace('oracle = 7', 'oracle = 0'));
    const green = sdd(d, 'tdd', 'green', 'TEST-CALC-001');
    assert.equal(green.code, 1, green.out);
    assert.match(green.out, /changed since Red/);
    assert.match(sdd(d, 'gate', '--no-run').out, /test changed/);
  });
}

for (const [name, ext, body] of [
  ['C macro', 'c', '#define EXPECTED() expected()\n// @id TEST-CALC-001 @verifies REQ-CALC-001\nvoid test_calc_001(void) { CHECK(actual() == EXPECTED()); }\n\nint expected(void) { return 7; }\n'],
  ['C callback data', 'c', 'int expected(void);\nint (*oracles[])(void) = { expected };\n// @id TEST-CALC-001 @verifies REQ-CALC-001\nvoid test_calc_001(void) { CHECK(actual() == oracles[0]()); }\n\nint expected(void) { return 7; }\n'],
  ['PHP provider casing', 'php', "class Target {\n// @id TEST-CALC-001 @verifies REQ-CALC-001\n#[DataProviderExternal(Oracle::class, 'CASES')]\npublic function test_calc_001($n): void { self::assertSame($n, actual()); }\n}\nclass Oracle {\npublic static function cases(): array { return [[7]]; }\n}\n"],
  ['Julia helper', 'jl', 'using Test\nfunction run_tests()\n# @id TEST-CALC-001 @verifies REQ-CALC-001\n@testset "TEST-CALC-001" begin\n@test actual() == oracle()\nend\nend\n\noracle() = 7\nrun_tests()\n'],
  ['Julia shared data', 'jl', 'using Test\n# @id TEST-CALC-001 @verifies REQ-CALC-001\nfunction run_target()\n@testset "TEST-CALC-001" begin\n@test actual() == oracle()\nend\nend\n\nconst ORACLE = 7\noracle() = ORACLE\nrun_target()\n'],
]) {
  test(`#175 ${name} oracle dependencies protect Red and stale Green`, () => {
    const d = batch2Source(`T.${ext}`, body);
    fakeOut(d, 'AssertionError: oracle');
    assert.equal(sdd(d, 'tdd', 'red', 'TEST-CALC-001').code, 0);
    fakeOut(d, 'pass', 0);
    assert.equal(sdd(d, 'tdd', 'green', 'TEST-CALC-001').code, 0);
    fs.writeFileSync(path.join(d, `T.${ext}`), body.replace('7', '0'));
    const green = sdd(d, 'tdd', 'green', 'TEST-CALC-001');
    assert.equal(green.code, 1, green.out);
    assert.match(green.out, /changed since Red/);
    assert.match(sdd(d, 'gate', '--no-run').out, /test changed/);
  });
}

test('#176 Java explicit imports do not conflate equal class basenames', () => {
  const d = mk130({
    'pom.xml': '<project/>',
    'src/main/java/com/example/alpha/Service.java': 'package com.example.alpha;\npublic class Service {}\n',
    'src/test/java/com/example/probe/TargetTest.java': 'package com.example.probe;\nimport com.example.beta.Service;\nclass TargetTest {\n// @id TEST-A-001 @verifies REQ-A-001\n@Test\npublic void test_a_001() { assertEquals(1, Service.answer()); }\n}\n',
  });
  const r = sdd(d, 'tdd', 'stub', 'TEST-A-001');
  assert.equal(r.code, 0, r.out);
  assert.match(rd130(d, 'src/main/java/com/example/beta/Service.java'), /package com.example.beta|answer/);
  assert.equal(rd130(d, 'src/main/java/com/example/alpha/Service.java'), 'package com.example.alpha;\npublic class Service {}\n');
  assert.doesNotMatch(r.out, /not stubbed.*alpha/);
});

test('#176 PHP aliases and absolute path repositories resolve to real PSR-4 ownership', { skip: !has130('php') }, () => {
  for (const alias of [false, true]) {
    const cls = alias ? 'AliasBox' : 'Box';
    const d = mk130({
      'composer.json': '{}',
      'packages/gizmo/composer.json': '{"name":"fixture/gizmo","autoload":{"psr-4":{"Org\\\\Gizmo\\\\":"src/"}}}',
      'tests/T.php': `<?php\nuse Org\\Gizmo\\Box${alias ? ' as AliasBox' : ''};\n// @id TEST-A-001 @verifies REQ-A-001\npublic function test_a_001() { self::assertSame(1, ${cls}::add()); }\n`,
    });
    fs.writeFileSync(path.join(d, 'composer.json'), JSON.stringify({ repositories: [{ type: 'path', url: path.join(d, 'packages/*') }] }));
    const r = sdd(d, 'tdd', 'stub', 'TEST-A-001');
    assert.equal(r.code, 0, r.out);
    assert.match(rd130(d, 'packages/gizmo/src/Box.php'), /class Box|function add/);
    assert.equal(fs.existsSync(path.join(d, 'packages/gizmo/src/AliasBox.php')), false);
    assert.equal(fs.existsSync(path.join(d, 'src/Gizmo/Box.php')), false);
  }
});

test('#176 Julia transitive includes preserve real exported bindings', { skip: !has130('julia') }, () => {
  const d = mk130({
    'Project.toml': 'name="Fixture"\n',
    'src/Existing.jl': 'module Existing\nexport available\ninclude("inner.jl")\nend\n',
    'src/inner.jl': 'include("deep.jl")\n',
    'src/deep.jl': 'available() = 7\n',
    'test/t.jl': 'using Test\ninclude("../src/Existing.jl")\ninclude("../src/Fresh.jl")\nusing .Existing, .Fresh\n# @id TEST-A-001 @verifies REQ-A-001\n@testset "TEST-A-001" begin\n@test available() == 7\n@test freshfn() == 1\nend\n',
  });
  const r = sdd(d, 'tdd', 'stub', 'TEST-A-001');
  assert.equal(r.code, 0, r.out);
  assert.match(rd130(d, 'src/Fresh.jl'), /freshfn/);
  assert.doesNotMatch(rd130(d, 'src/Fresh.jl'), /available/);
  assert.equal(rd130(d, 'src/deep.jl'), 'available() = 7\n');
});

test('#177 CTest registration aliases select a unique exact ID, not the C function', { skip: !has130('cmake') || !has130('ctest') }, () => {
  const d = mk130({
    'CMakeLists.txt': 'cmake_minimum_required(VERSION 3.10)\nproject(alias177 NONE)\nenable_testing()\nset(target test_a_001)\nadd_test(NAME ${target} COMMAND sh -c "echo CHECK failed: registration; exit 1")\nadd_test(NAME test_a_0011 COMMAND sh -c "echo sibling; exit 1")\n',
    'tests/t.c': '// @id TEST-A-001 @verifies REQ-A-001\nvoid test_a_001_addition(void) { CHECK(0); }\n',
  });
  const r = sdd(d, 'tdd', 'red', 'TEST-A-001', '--expect', 'CHECK failed: registration');
  assert.equal(r.code, 0, r.out);
  assert.doesNotMatch(r.out, /sibling/);
});

test('#177 direct CTest discovery uses its cwd when no test directory is configured', () => {
  const d = batch2Source('T.c', '// @id TEST-CALC-001 @verifies REQ-CALC-001\nvoid test_calc_001_addition(void) { CHECK(0); }\n');
  const r = batch2Run(d, 'ctest', `if [ "$1" = "--show-only=json-v1" ]; then
  echo '{"tests":[{"name":"test_calc_001"}]}'
  exit 0
fi
printf "%s\\n" "$@" > args.log
echo "1/1 Test #1: test_calc_001 ... ***Failed"
echo "CHECK failed: target"
exit 1
`, ['ctest', '-R', '{idu}'], 'tdd', 'red', 'TEST-CALC-001');
  assert.equal(r.code, 0, r.out);
  assert.match(fs.readFileSync(path.join(d, 'args.log'), 'utf8'), /\^test_calc_001\$/);
});

test('#178 attributable standard C assert abort is strong Red, genuine crashes remain rejected', () => {
  const d = batch2Source('T.c', '// @id TEST-CALC-001 @verifies REQ-CALC-001\nvoid test_calc_001(void) { assert(actual() == 7); }\n');
  fakeOut(d, "1/1 Test #1: test_calc_001 ... Subprocess aborted***Exception: 0.1 sec\nT: T.c:3: test_calc_001: Assertion `actual() == 7' failed.\nThe following tests FAILED:\n1 - test_calc_001 (Subprocess aborted)\n");
  const red = sdd(d, 'tdd', 'red', 'TEST-CALC-001');
  assert.equal(red.code, 0, red.out);
  assert.doesNotMatch(red.out, /\[weak\]/);
  for (const text of [
    '1/1 Test #1: test_calc_001 ... ***Exception: SegFault\nAssertion failed in sibling\n',
    '1/1 Test #1: test_calc_001 ... Subprocess aborted***Exception:\n',
  ]) {
    fakeOut(d, text);
    assert.match(sdd(d, 'tdd', 'red', 'TEST-CALC-001', '--weak').out, /crashed/);
  }
});

test('#178 a target assertion abort does not excuse a sibling segmentation fault', () => {
  const d = batch2Source('T.c', '// @id TEST-CALC-001 @verifies REQ-CALC-001\nvoid test_calc_001(void) { assert(0); }\n');
  fakeOut(d, "1/2 Test #1: test_calc_001 ... Subprocess aborted***Exception: 0.1 sec\nT: T.c:3: test_calc_001: Assertion `0' failed.\n2/2 Test #2: sibling ... ***Exception: SegFault 0.1 sec\n");
  const red = sdd(d, 'tdd', 'red', 'TEST-CALC-001', '--weak');
  assert.equal(red.code, 1, red.out);
  assert.match(red.out, /crashed/);
});

test('#179 PHPUnit exact filters include newline dataset names', () => {
  const d = batch2Source('T.php', '<?php\nclass Target {\n// @id TEST-CALC-001 @verifies REQ-CALC-001\npublic function test_calc_001(): void { self::assertTrue(true); }\n}\n');
  const r = batch2Run(d, 'phpunit', 'printf "%s\\n" "$@" > args.log\necho "AssertionError: target"\nexit 1\n', ['phpunit', '--filter', '{idu}', '{file}'], 'tdd', 'red', 'TEST-CALC-001');
  assert.equal(r.code, 0, r.out);
  const args = fs.readFileSync(path.join(d, 'args.log'), 'utf8').split('\n');
  const filter = args[args.indexOf('--filter') + 1];
  const re = new RegExp(filter.slice(1, -1));
  assert.ok(re.test('Target::test_calc_001 with data set "line\nbreak"'), filter);
  assert.ok(!re.test('Target::test_calc_0011 with data set "line\nbreak"'), filter);
});

for (const dataset of ['#0', '@active']) {
  test(`#179 PHPUnit 12 ${dataset} failure belongs to the exact method`, () => {
    const d = batch2Source('T.php', '<?php\nclass Target {\n// @id TEST-CALC-001 @verifies REQ-CALC-001\npublic function test_calc_001($n): void { self::assertSame(3, actual()); }\n}\n');
    fakeOut(d, `There was 1 failure:\n1) Target::test_calc_001${dataset} with data (false)\nFailed asserting that 0 is identical to 3.\nTests: 2, Assertions: 1, Failures: 1, Skipped: 1.\n`);
    const red = sdd(d, 'tdd', 'red', 'TEST-CALC-001');
    assert.equal(red.code, 0, red.out);
    fakeOut(d, `There was 1 failure:\n1) Target::test_calc_0011${dataset} with data (false)\nFailed asserting sibling\nTests: 2, Assertions: 2, Failures: 1.\n`);
    assert.match(sdd(d, 'tdd', 'red', 'TEST-CALC-001').out, /itself passes/);
  });
}

for (const attr of ['[TestCase(1, TestName = "One sample")]', '[DataRow(1, DisplayName = "One sample")]']) {
  test(`#180 .NET custom case ${attr} retains method execution identity`, () => {
    const d = batch2Source('T.cs', `namespace Fixture;\nclass Target {\n// @id TEST-CALC-001 @verifies REQ-CALC-001\n${attr}\npublic void test_calc_001(int x) { Assert.AreEqual(1, x); }\n}\n`);
    fakeOut(d, 'Passed One sample [1 ms]\nTotal tests: 1\nPassed: 1\n', 0);
    const red = sdd(d, 'tdd', 'red', 'TEST-CALC-001', '--characterization', 'data');
    assert.equal(red.code, 0, red.out);
    assert.equal(sdd(d, 'tdd', 'green', 'TEST-CALC-001').code, 0);
    fakeOut(d, 'Failed One sample [1 ms]\nExpected: 99\nat Fixture.Target.test_calc_001(Int32 x)\nTotal tests: 1\nFailed: 1\n');
    assert.equal(sdd(d, 'tdd', 'red', 'TEST-CALC-001').code, 0);
    fakeOut(d, 'Passed Different sample [1 ms]\nTotal tests: 1\nPassed: 1\n', 0);
    assert.equal(sdd(d, 'tdd', 'green', 'TEST-CALC-001').code, 1);
  });
}

test('#180 default Julia runner exposes passing nested testsets without editing source', { skip: !has130('julia') }, () => {
  const body = 'using Test\n@testset "outer" begin\n# @id TEST-A-001 @verifies REQ-A-001\n@testset "TEST-A-001" begin\n@test actual() == 2\nend\nend\n';
  const production = '# @id CODE-A-001 @implements REQ-A-001\n';
  const d = mk130({ 'Project.toml': 'name="Fixture"\n', 'test/t.jl': 'include("../subject.jl")\n' + body, 'subject.jl': production + 'actual() = 0\n' });
  assert.equal(sdd(d, 'tdd', 'red', 'TEST-A-001').code, 0);
  fs.writeFileSync(path.join(d, 'subject.jl'), production + 'actual() = 2\n');
  const green = sdd(d, 'tdd', 'green', 'TEST-A-001');
  assert.equal(green.code, 0, green.out);
  assert.equal(rd130(d, 'test/t.jl'), 'include("../subject.jl")\n' + body);
});

test('#163 Git-less changed gate falls back to full checks and evidence', () => {
  const d = approved();
  fs.rmSync(path.join(d, '.git'), { recursive: true });
  impl(d, '(a,b) => a+b');
  fakeOut(d, 'pass', 0, { projects: [{ root: 'module', checks: [{ name: 'must-fail', cmd: ['node', '-e', 'console.log("CHECK RAN");process.exit(1)'], changedCmd: ['node', '-e', 'process.exit(0)'] }] }] });
  fs.mkdirSync(path.join(d, 'module'));
  const r = sdd(d, 'gate', '--changed');
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /Git.*unavailable.*full/i);
  assert.match(r.out, /no Green recorded/);
  assert.match(r.out, /CHECK RAN/);
  assert.doesNotMatch(r.out, /0\/0 tests|no changed files.*skipped/);
});

test('#163 Git-less Rust manifests retain cross-crate impact', () => {
  const d = approved();
  fs.rmSync(path.join(d, '.git'), { recursive: true });
  for (const name of ['low', 'high']) {
    fs.mkdirSync(path.join(d, name, 'src'), { recursive: true });
    fs.writeFileSync(path.join(d, name, 'Cargo.toml'), `[package]\nname = "${name}"\nversion = "0.1.0"\n`);
  }
  fs.writeFileSync(path.join(d, 'low/src/lib.rs'), '// @id CODE-CALC-001 @implements REQ-CALC-001\npub fn value() -> i32 { 1 }\n');
  fs.writeFileSync(path.join(d, 'high/src/lib.rs'), 'use low::value;\n// @id CODE-HIGH-001 @implements REQ-HIGH-001\npub fn consume() -> i32 { value() }\n');
  fs.writeFileSync(path.join(d, '.sdd/specs/high.md'), '---\nfeature: high\ntier: T1\n---\n| REQ-HIGH-001 | consume | TEST-HIGH-001 |\n');
  const r = sdd(d, 'impact', 'REQ-CALC-001', '--json');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /high\/src\/lib.rs/);
  assert.match(r.out, /REQ-HIGH-001/);
});

test('#163 C# discovery and compiler-driven stubs work without Git', () => {
  const d = mk130({
    'src/Lib/Lib.csproj': '<Project Sdk="Microsoft.NET.Sdk"/>',
    'tests/T/T.csproj': '<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.0"/><ProjectReference Include="../../src/Lib/Lib.csproj"/></ItemGroup></Project>',
    'tests/T/Tests.cs': 'using Lib;\n// @id TEST-A-001 @verifies REQ-A-001\npublic void test_a_001() { Assert.Equal(1, Engine.Compute()); }\n',
  });
  fs.rmSync(path.join(d, '.git'), { recursive: true });
  const bin = path.join(d, 'tools');
  fs.mkdirSync(bin);
  const column = rd130(d, 'tests/T/Tests.cs').split('\n')[2].indexOf('Engine') + 1;
  fs.writeFileSync(path.join(bin, 'dotnet'), `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 8.0.0; exit 0; fi\nif [ -f "${d}/src/Lib/Engine.cs" ]; then exit 0; fi\nprintf "%s\\n" "${d}/tests/T/Tests.cs(3,${column}): error CS0103: The name 'Engine' does not exist in the current context"\nexit 1\n`, { mode: 0o755 });
  const env = { ...ENV, PATH: `${bin}:${ENV.PATH}` };
  const go = (...args) => spawnSync('node', [SDD, '--root', d, ...args], { encoding: 'utf8', env });
  const init = go('init');
  assert.equal(init.status, 0, init.stdout + init.stderr);
  assert.match(fs.readFileSync(path.join(d, '.sdd/config.json'), 'utf8'), /dotnet/);
  const stub = go('tdd', 'stub', 'TEST-A-001');
  assert.equal(stub.status, 0, stub.stdout + stub.stderr);
  assert.match(stub.stdout, /compile-checked/);
  assert.match(fs.readFileSync(path.join(d, 'src/Lib/Engine.cs'), 'utf8'), /namespace Lib|Compute/);
});

for (const [stack, file, body, output] of [
  ['Rust', 'tests/calc.rs', '#[test]\nfn test_calc_001_descriptive() { assert!(true); }', 'running 2 tests\ntest test_calc_001_descriptive ... ok\ntest test_calc_001_descriptive1 ... FAILED\ntest result: FAILED. 1 passed; 1 failed;'],
  ['CTest', 'tests/calc.c', 'void test_calc_001_descriptive(void) { CHECK(1); }', '1/2 Test #1: test_calc_001_descriptive .... Passed 0.1 sec\n2/2 Test #2: test_calc_001_descriptive1 .... ***Failed 0.1 sec\nCHECK failed: sibling'],
  ['PHPUnit', 'tests/CalcTest.php', 'public function test_calc_001_descriptive(): void { self::assertTrue(true); }', 'There was 1 failure:\n1) CalcTest::test_calc_001_descriptive1\nFailed asserting sibling\nTests: 2, Assertions: 2, Failures: 1.'],
  ['.NET', 'tests/CalcTest.cs', '[Fact]\npublic void test_calc_001_descriptive() { Assert.True(true); }', 'Passed CalcTest.test_calc_001_descriptive [1 ms]\nFailed CalcTest.test_calc_001_descriptive1 [1 ms]\nAssert.True() Failure\nFailed! - Failed: 1, Passed: 1, Skipped: 0, Total: 2'],
]) {
  test(`#164 ${stack} exact target cannot borrow a descriptive sibling failure`, () => {
    const d = approved();
    fs.rmSync(path.join(d, 'add.test.mjs'));
    fs.mkdirSync(path.join(d, 'tests'));
    fs.writeFileSync(path.join(d, file), `// @id TEST-CALC-001 @verifies REQ-CALC-001\n${body}\n`);
    fakeOut(d, output, 1);
    const r = sdd(d, 'tdd', 'red', 'TEST-CALC-001');
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /itself passes|test passed/);
    assert.equal(testEvidence(d).length, 0);
  });
}

test('#164 Julia parses sequential summary schemas and exact testset names', () => {
  const d = approved();
  const pass = 'Test Summary: | Pass Total Time\nTEST-CALC-001 | 1 1 0.1s\n';
  const fail = 'Test Summary: | Fail Total Time\nTEST-CALC-0011 | 1 1 0.1s\nExpression: false\n';
  fakeOut(d, 'Test Summary: | Fail Total Time\nTEST-CALC-001 | 1 1 0.1s\n');
  assert.equal(sdd(d, 'tdd', 'red', 'TEST-CALC-001').code, 0);
  fakeOut(d, pass + fail);
  assert.equal(sdd(d, 'tdd', 'green', 'TEST-CALC-001').code, 0);
  const r = sdd(d, 'tdd', 'red', 'TEST-CALC-001');
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /itself passes/);
});

test('#164 qualified Rust and C# targets cannot borrow same-named methods in another scope', () => {
  for (const [ext, body, output] of [
    ['rs', 'mod selected {\n// @id TEST-CALC-001 @verifies REQ-CALC-001\n#[test]\nfn test_calc_001() { assert!(true); }\n}\n',
      'running 2 tests\ntest selected::test_calc_001 ... ok\ntest unrelated::test_calc_001 ... FAILED\ntest result: FAILED. 1 passed; 1 failed;'],
    ['cs', 'namespace Fixture;\nclass Selected {\n// @id TEST-CALC-001 @verifies REQ-CALC-001\n[Fact]\npublic void test_calc_001() { Assert.True(true); }\n}\n',
      'Passed Fixture.Selected.test_calc_001 [1 ms]\nFailed Fixture.Unrelated.test_calc_001 [1 ms]\nAssert.True() Failure\n'],
  ]) {
    const d = approved();
    fs.rmSync(path.join(d, 'add.test.mjs'));
    fs.writeFileSync(path.join(d, `Test.${ext}`), body);
    fakeOut(d, output, 1);
    const r = sdd(d, 'tdd', 'red', 'TEST-CALC-001');
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /itself passes/);
    fakeOut(d, output.replace(ext === 'rs' ? 'selected::test_calc_001 ... ok' : 'Passed Fixture.Selected.test_calc_001', ext === 'rs' ? 'selected::test_calc_001 ... ignored' : 'Skipped Fixture.Selected.test_calc_001'), 1);
    assert.equal(sdd(d, 'tdd', 'red', 'TEST-CALC-001').code, 1);
  }
});

test('#164 Cargo selects the complete nested annotated target exactly', { skip: !has130('cargo') }, () => {
  const d = mk130({
    'Cargo.toml': '[package]\nname = "exact164"\nversion = "0.1.0"\nedition = "2021"\n',
    'src/lib.rs': 'pub fn value() -> i32 { 1 }\n',
    'tests/t.rs': 'mod nested {\n// @id TEST-A-001 @verifies REQ-A-001\n#[test]\nfn test_a_001_descriptive() { assert_eq!(exact164::value(), 1); }\n#[test]\nfn test_a_001_descriptive1() { assert!(false, "sibling"); }\n}\n',
  });
  const r = sdd(d, 'tdd', 'red', 'TEST-A-001');
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /test passed/);
  assert.doesNotMatch(r.out, /sibling/);
  fs.writeFileSync(path.join(d, 'tests/t.rs'), rd130(d, 'tests/t.rs').replace('fn test_a_001_descriptive()', '#[ignore]\nfn test_a_001_descriptive()'));
  const ignored = sdd(d, 'tdd', 'red', 'TEST-A-001', '--characterization', 'ignored');
  assert.equal(ignored.code, 1, ignored.out);
  assert.match(ignored.out, /skipped/);
});

test('#164 default CTest selector is anchored to the complete function name', { skip: !has130('cmake') || !has130('ctest') }, () => {
  const d = mk130({
    'CMakeLists.txt': 'cmake_minimum_required(VERSION 3.10)\nproject(exact164 NONE)\nenable_testing()\nadd_test(NAME test_a_001_descriptive COMMAND sh -c "exit 0")\nadd_test(NAME test_a_001_descriptive1 COMMAND sh -c "echo sibling; exit 1")\n',
    'tests/t.c': '// @id TEST-A-001 @verifies REQ-A-001\nvoid test_a_001_descriptive(void) { CHECK(1); }\n',
  });
  const r = sdd(d, 'tdd', 'red', 'TEST-A-001');
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /test passed/);
  assert.doesNotMatch(r.out, /sibling/);
});

test('#164 default PHPUnit and VSTest filters are exact and preserve provider selection', () => {
  for (const stack of ['php', 'cs']) {
    const d = mk130(stack === 'php' ? {
      'composer.json': '{}',
      'tests/T.php': '<?php\nclass CalcTest {\n// @id TEST-A-001 @verifies REQ-A-001\npublic function test_a_001_descriptive(): void { self::assertTrue(true); }\n}\n',
    } : {
      'T.csproj': '<Project/>',
      'T.cs': 'namespace Fixture.Tests;\npublic class CalcTest {\n// @id TEST-A-001 @verifies REQ-A-001\n[Theory]\npublic void test_a_001_descriptive(int x) { Assert.True(true); }\n}\n',
    });
    const bin = path.join(d, 'tools');
    fs.mkdirSync(bin);
    const runner = stack === 'php' ? 'phpunit' : 'dotnet';
    fs.writeFileSync(path.join(bin, runner), '#!/bin/sh\nprintf "%s\\n" "$@" > args.log\necho "AssertionError: target"\nexit 1\n', { mode: 0o755 });
    const r = spawnSync('node', [SDD, '--root', d, 'tdd', 'red', 'TEST-A-001'], { encoding: 'utf8', env: { ...ENV, PATH: `${bin}:${ENV.PATH}` } });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const args = fs.readFileSync(path.join(d, 'args.log'), 'utf8').split('\n');
    const filter = args[args.indexOf('--filter') + 1];
    if (stack === 'php') {
      const re = new RegExp(filter.slice(1, -1));
      assert.ok(re.test('CalcTest::test_a_001_descriptive'));
      assert.ok(re.test('CalcTest::test_a_001_descriptive with data set "row1"'));
      assert.ok(!re.test('CalcTest::test_a_001_descriptive1'));
    } else {
      assert.equal(filter, 'FullyQualifiedName=Fixture.Tests.CalcTest.test_a_001_descriptive');
      assert.ok(args.includes('console;verbosity=normal'));
    }
  }
});

for (const [stack, output] of [
  ['Gradle', 'Tests run: 1, Failures: 0, Skipped: 1\n'],
  ['CTest', '1/1 Test #1: test_calc_001 .... ***Skipped 0.1 sec\n100% tests passed, 0 tests failed out of 1\n'],
  ['Julia', 'Test Summary: | Broken Total Time\nTEST-CALC-001 | 1 1 0.1s\n'],
]) {
  test(`#165 ${stack} skipped-only runs reject evidence and full gate is INCOMPLETE`, () => {
    const d = approved();
    impl(d, '(a,b) => a+b');
    fakeOut(d, output, 0, { checks: [{ name: 'test', cmd: ['node', '-e', `console.log(${JSON.stringify(output)})`] }] });
    const r = sdd(d, 'tdd', 'red', 'TEST-CALC-001', '--characterization', 'probe');
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /skipped|no test matched/);
    assert.match(sdd(d, 'gate').out, /all tests skipped.*INCOMPLETE/);
    fakeOut(d, 'AssertionError: target');
    assert.equal(sdd(d, 'tdd', 'red', 'TEST-CALC-001').code, 0);
    fakeOut(d, 'pass', 0);
    assert.equal(sdd(d, 'tdd', 'green', 'TEST-CALC-001').code, 0);
    fakeOut(d, output, 0);
    for (const sub of ['green', 'refactor']) assert.equal(sdd(d, 'tdd', sub, 'TEST-CALC-001').code, 1);
    fakeOut(d, output, 0, { checks: [{ name: 'test', cmd: ['node', '-e', `console.log(${JSON.stringify(output)})`] }] });
    assert.equal(sdd(d, 'gate').code, 2);
  });
}

test('#165 Julia missing target cannot borrow an executed control test', () => {
  const d = approved();
  fakeOut(d, 'Test Summary: | Pass Total Time\ncontrol | 1 1 0.1s\n', 0);
  const r = sdd(d, 'tdd', 'red', 'TEST-CALC-001', '--characterization', 'probe');
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /never ran|no test matched/);
});

for (const [ext, testBody, helper] of [
  ['rs', '#[test]\nfn test_calc_001() {\n  assert_eq!(value(), expected());\n}', 'fn expected() -> i32 { 1 }'],
  ['java', '@Test\npublic void test_calc_001() {\n  assertEquals(expected(), value());\n}', 'private int expected() { return 1; }'],
  ['php', 'public function test_calc_001(): void {\n  self::assertSame($this->expected(), value());\n}', 'private function expected(): int { return 1; }'],
  ['cs', '[Test]\npublic void test_calc_001() {\n  Assert.AreEqual(Expected(), value());\n}', 'private int Expected() => 1;'],
  ['c', 'void test_calc_001(void) {\n  CHECK(value() == expected());\n}', 'int expected(void) { return 1; }'],
]) {
  test(`#166 ${ext} shared oracle edits between Red and Green are refused`, () => {
    const d = approved();
    fs.rmSync(path.join(d, 'add.test.mjs'));
    const file = path.join(d, `Test.${ext}`);
    const body = `// @id TEST-CALC-001 @verifies REQ-CALC-001\n${testBody}\n\n${helper}\n`;
    fs.writeFileSync(file, body);
    fakeOut(d, 'AssertionError: oracle');
    const red = sdd(d, 'tdd', 'red', 'TEST-CALC-001');
    assert.equal(red.code, 0, red.out);
    fakeOut(d, 'pass', 0);
    assert.equal(sdd(d, 'tdd', 'green', 'TEST-CALC-001').code, 0);
    fs.writeFileSync(file, body.replace(helper, helper.replace('1', '2')));
    fakeOut(d, 'pass', 0);
    const green = sdd(d, 'tdd', 'green', 'TEST-CALC-001');
    assert.equal(green.code, 1, green.out);
    assert.match(green.out, /test file changed since Red/);
    assert.match(sdd(d, 'gate', '--no-run').out, /test changed since last Green/);
  });
}

test('#167 CTest child segfault is rejected even with --weak', () => {
  const d = approved();
  fakeOut(d, '1/1 Test #1: test_calc_001 ... ***Exception: SegFault 0.1 sec\nThe following tests FAILED:\n1 - test_calc_001 (SEGFAULT)\n');
  for (const args of [[], ['--weak'], ['--expect', 'SegFault']]) {
    const r = sdd(d, 'tdd', 'red', 'TEST-CALC-001', ...args);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /crashed/);
  }
  fakeOut(d, 'AssertionError: target');
  assert.equal(sdd(d, 'tdd', 'red', 'TEST-CALC-001').code, 0);
  fakeOut(d, 'pass', 0);
  assert.equal(sdd(d, 'tdd', 'green', 'TEST-CALC-001').code, 0);
  fakeOut(d, '1/1 Test #1: test_calc_001 ... ***Exception: SegFault 0.1 sec\n');
  for (const sub of ['green', 'refactor']) {
    const r = sdd(d, 'tdd', sub, 'TEST-CALC-001');
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /crashed/);
  }
});

test('#165 successful zero-test and Gradle NO-SOURCE checks are INCOMPLETE', () => {
  for (const output of ['No tests were found!!!', '> Task :cleanTest UP-TO-DATE\n> Task :test NO-SOURCE\nBUILD SUCCESSFUL']) {
    const d = approved();
    impl(d, '(a,b) => a+b');
    fakeOut(d, 'AssertionError: target');
    assert.equal(sdd(d, 'tdd', 'red', 'TEST-CALC-001').code, 0);
    fakeOut(d, 'pass', 0);
    assert.equal(sdd(d, 'tdd', 'green', 'TEST-CALC-001').code, 0);
    fakeOut(d, output, 0, { checks: [{ name: 'test', cmd: ['node', '-e', `console.log(${JSON.stringify(output)})`] }] });
    assert.equal(sdd(d, 'gate').code, 2);
    assert.equal(sdd(d, 'tdd', 'red', 'TEST-CALC-001', '--characterization', 'absent').code, 1);
  }
});

test('#165 mixed Gradle, CTest and Julia execution remains valid', () => {
  for (const output of [
    'Tests run: 2, Failures: 0, Skipped: 1\n',
    '1/2 Test #1: TEST-CALC-001 .... Passed 0.1 sec\n2/2 Test #2: control .... ***Skipped 0.1 sec\n',
    'Test Summary: | Pass Broken Total Time\nTEST-CALC-001 | 1 1 2 0.1s\n',
  ]) {
    const d = approved();
    impl(d, '(a,b) => a+b');
    fakeOut(d, output, 0, { checks: [{ name: 'test', cmd: ['node', '-e', `console.log(${JSON.stringify(output)})`] }] });
    assert.equal(sdd(d, 'tdd', 'red', 'TEST-CALC-001', '--characterization', 'executed').code, 0);
    assert.equal(sdd(d, 'tdd', 'green', 'TEST-CALC-001').code, 0);
    assert.equal(sdd(d, 'gate').code, 0);
  }
});

for (const [ext, body, helper] of [
  ['java', '@Test\npublic void test_calc_001() {\n  assertEquals(expected(), value());\n}', 'private int expected() { return 2; }'],
  ['cs', '[Test]\npublic void test_calc_001() {\n  Assert.AreEqual(expected(), value());\n}', 'private int expected() => 2;'],
]) {
  test(`#166 app050 F2 ${ext} oracle-only edit cannot fabricate Red to Green`, () => {
    const d = approved();
    fs.rmSync(path.join(d, 'add.test.mjs'));
    impl(d, '() => 1');
    const file = path.join(d, `Test.${ext}`);
    const source = `// @id TEST-CALC-001 @verifies REQ-CALC-001\n${body}\n\n${helper}\n`;
    fs.writeFileSync(file, source);
    fakeOut(d, 'AssertionError: expected 2 but was 1');
    assert.equal(sdd(d, 'tdd', 'red', 'TEST-CALC-001').code, 0);
    const production = fs.readFileSync(path.join(d, 'add.mjs'), 'utf8');
    fs.writeFileSync(file, source.replace(helper, helper.replace('2', '1')));
    fakeOut(d, 'pass', 0);
    const green = sdd(d, 'tdd', 'green', 'TEST-CALC-001');
    assert.equal(green.code, 1, green.out);
    assert.match(green.out, /test file changed since Red/);
    assert.equal(fs.readFileSync(path.join(d, 'add.mjs'), 'utf8'), production);
    assert.equal(sdd(d, 'gate', '--no-run').code, 1);
    assert.equal(testEvidence(d).length, 1);
  });
}

test('#168 PHP stubs resolve local Composer path manifests before installation', { skip: !has130('php') }, () => {
  const d = mk130({
    'composer.json': '{"require":{"fixture/ledger":"*"},"repositories":[{"type":"path","url":"packages/*"}]}',
    'packages/ledger/composer.json': '{"name":"fixture/ledger","autoload":{"psr-4":{"Fixture\\\\Ledger\\\\":"src/"}}}',
    'tests/T.php': '<?php\nuse Fixture\\Ledger\\Ledger;\n// @id TEST-A-001 @verifies REQ-A-001\npublic function test_a_001() { self::assertSame(1, Ledger::value()); }\n',
  });
  const r = sdd(d, 'tdd', 'stub', 'TEST-A-001');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /packages\/ledger\/src\/Ledger.php/);
  assert.equal(fs.existsSync(path.join(d, 'src/Ledger/Ledger.php')), false);
});

test('#168 PHPUnit throwing-stub errors and mixed skipped data rows are executed', () => {
  const d = approved();
  fakeOut(d, 'There was 1 error:\n1) CalcTest::test_calc_001\nLogicException: not implemented: add\nTests: 1, Assertions: 0, Errors: 1.\n');
  const red = sdd(d, 'tdd', 'red', 'TEST-CALC-001', '--expect', 'not implemented: add');
  assert.equal(red.code, 0, red.out);
  fakeOut(d, 'OK, but some tests were skipped!\nTests: 2, Assertions: 1, Skipped: 1.\n', 0);
  assert.equal(sdd(d, 'tdd', 'green', 'TEST-CALC-001').code, 0);
  assert.equal(sdd(d, 'tdd', 'red', 'TEST-CALC-001', '--characterization', 'mixed rows').code, 0);
});

test('#168 PHP stubs honor installed Composer path-package PSR-4 mappings', { skip: !has130('php') }, () => {
  const d = mk130({
    'composer.json': '{"require":{"fixture/ledger":"*"},"repositories":[{"type":"path","url":"packages/ledger"}]}',
    'packages/ledger/composer.json': '{"name":"fixture/ledger","autoload":{"psr-4":{"Fixture\\\\Ledger\\\\":"src/"}}}',
    'vendor/autoload.php': '<?php\nreturn new class { public function getPrefixesPsr4() { return ["Fixture\\\\Ledger\\\\" => [__DIR__ . "/../packages/ledger/src/"]]; } };',
    'tests/T.php': '<?php\nuse Fixture\\Ledger\\Ledger;\n// @id TEST-A-001 @verifies REQ-A-001\npublic function test_a_001() { self::assertSame(1, Ledger::value()); }\n',
  });
  const r = sdd(d, 'tdd', 'stub', 'TEST-A-001');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /packages\/ledger\/src\/Ledger.php/);
  assert.equal(fs.existsSync(path.join(d, 'src/Ledger/Ledger.php')), false);
  assert.match(rd130(d, 'packages/ledger/src/Ledger.php'), /namespace Fixture\\Ledger/);
  fs.rmSync(path.join(d, 'packages/ledger/src/Ledger.php'));
  fs.mkdirSync(path.join(d, 'vendor/fixture'));
  fs.symlinkSync(path.join(d, 'packages/ledger'), path.join(d, 'vendor/fixture/ledger'), 'dir');
  fs.writeFileSync(path.join(d, 'vendor/autoload.php'), '<?php\nreturn new class { public function getPrefixesPsr4() { return ["Fixture\\\\Ledger\\\\" => [__DIR__ . "/fixture/ledger/src/"]]; } };');
  const linked = sdd(d, 'tdd', 'stub', 'TEST-A-001');
  assert.equal(linked.code, 0, linked.out);
  assert.match(linked.out, /packages\/ledger\/src\/Ledger.php/);
});

test('#169 Julia comma imports wrap modules and stdlib bindings are not stubbed', { skip: !has130('julia') }, () => {
  const d = mk130({
    'Project.toml': 'name = "Fixture"\n',
    'src/Existing.jl': 'module Existing\nend\n',
    'test/t.jl': 'using Test, LinearAlgebra\ninclude("../src/Existing.jl")\ninclude("../src/Fresh.jl")\nusing .Existing, .Fresh\n# @id TEST-A-001 @verifies REQ-A-001\n@testset "TEST-A-001" begin\n  @test compute(1) == 2\n  @test dot([1], [1]) == 1\n  @test issymmetric([1;;])\nend\n',
  });
  const r = sdd(d, 'tdd', 'stub', 'TEST-A-001');
  assert.equal(r.code, 0, r.out);
  const body = rd130(d, 'src/Fresh.jl');
  assert.match(body, /^module Fresh\n/);
  assert.match(body, /export compute/);
  assert.doesNotMatch(body, /\bdot\b|\bissymmetric\b/);
});

test('#169 Julia @test_throws is assertion-origin strong Red', () => {
  const d = approved();
  fs.rmSync(path.join(d, 'add.test.mjs'));
  fs.writeFileSync(path.join(d, 'test.jl'), '# @id TEST-CALC-001 @verifies REQ-CALC-001\n@testset "TEST-CALC-001" begin\n  @test_throws ArgumentError invalid(0)\nend\n');
  fakeOut(d, 'not implemented: invalid\nTest Failed at test.jl:3\nExpression: invalid(0)\n');
  const r = sdd(d, 'tdd', 'red', 'TEST-CALC-001');
  assert.equal(r.code, 0, r.out);
  assert.doesNotMatch(r.out, /setup call|\[weak\]/);
});

test('#170 single-line C test excludes uncalled trailing functions but tracks called helpers', () => {
  const d = approved();
  fs.rmSync(path.join(d, 'add.test.mjs'));
  const file = path.join(d, 'test.c');
  const body = '// @id TEST-CALC-001 @verifies REQ-CALC-001\nvoid test_calc_001(void) { CHECK(value() == expected()); }\nint expected(void) { return 1; }\nint main(void) { test_calc_001(); }\n';
  fs.writeFileSync(file, body);
  fakeOut(d, 'CHECK failed: value');
  assert.equal(sdd(d, 'tdd', 'red', 'TEST-CALC-001').code, 0);
  fs.writeFileSync(file, body.replace('int main', 'int unused(void) { return 9; }\nint main'));
  fakeOut(d, 'pass', 0);
  const green = sdd(d, 'tdd', 'green', 'TEST-CALC-001');
  assert.equal(green.code, 0, green.out);
  const refactor = sdd(d, 'tdd', 'refactor', 'TEST-CALC-001');
  assert.doesNotMatch(refactor.out, /test body changed/);
});

test('#143 a timed-out run is neither Red nor Green', () => {
  const d = approved();
  fs.writeFileSync(path.join(d, '.sdd/config.json'), JSON.stringify({ schemaVersion: 1, testCmd: ['sh', '-c', 'sleep 5', 'x'], timeoutMs: 300 }));
  const r = sdd(d, 'tdd', 'red', 'TEST-CALC-001');
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /REJECTED.*timed out/, r.out);
});

test('#143 a crashed forked JVM is reported as a crash, not "no test matched"', () => {
  const d = approved();
  fakeOut(d, '[ERROR] There was an error in the forked process\njava.lang.OutOfMemoryError: Requested array size exceeds VM limit\nTests run: 0, Failures: 0, Errors: 0, Skipped: 0\n');
  const r = sdd(d, 'tdd', 'red', 'TEST-CALC-001');
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /REJECTED.*crashed/, r.out);
  assert.doesNotMatch(r.out, /no test matched/);
});

test('#143 several .NET test projects: a project without a match does not reject a genuine Red/Green', () => {
  const d = approved();
  const out = (res) => `Failed TEST_CALC_001 [1 ms]\n${res} - Failed: ${res === 'Failed!' ? 1 : 0}, Passed: ${res === 'Failed!' ? 0 : 1}, Skipped: 0, Total: 1, Duration: 1 ms - A.Tests.dll (net8.0)\nNo test matches the given testcase filter \`FullyQualifiedName~test_calc_001\` in /x/B.Tests.dll\n`;
  fakeOut(d, out('Failed!'));
  assert.match(sdd(d, 'tdd', 'red', 'TEST-CALC-001').out, /RED ok/);
  fakeOut(d, out('Passed!'), 0);
  assert.match(sdd(d, 'tdd', 'green', 'TEST-CALC-001').out, /GREEN ok/);
});

test('#143 Julia whole-file runner: a testset that never ran is not Red; a passing testset is Green despite a failing sibling', () => {
  const d = approved();
  const summary = (rows) => `Test Summary: | Pass  Fail  Total  Time\n${rows}\n`;
  fakeOut(d, summary('TEST-OTHER-001  |    1     1      2  0.1s'));
  const r = sdd(d, 'tdd', 'red', 'TEST-CALC-001');
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /never ran/, r.out);
  fakeOut(d, summary('TEST-CALC-001  |    1            1  0.1s\nTEST-OTHER-001  |    1     1      2  0.1s'));
  assert.equal(sdd(d, 'tdd', 'red', 'TEST-CALC-001', '--characterization', 'x').code, 1);
  fakeOut(d, summary('TEST-CALC-001  |    0     1      1  0.1s'));
  assert.equal(sdd(d, 'tdd', 'red', 'TEST-CALC-001').code, 0);
  fakeOut(d, summary('TEST-CALC-001  |    1            1  0.1s\nTEST-OTHER-001  |    1     1      2  0.1s'));
  assert.match(sdd(d, 'tdd', 'green', 'TEST-CALC-001').out, /GREEN ok/);
});

test('#143 Red reason is shown for NUnit "Expected is" and PHPUnit custom fail() messages', () => {
  for (const [o, re] of [['  Expected is <System.String[4]> with 4 elements, actual is <System.String[0]>\n  Values differ at index [0]\n', /fails with: Expected is <System\.String\[4\]>/], ['There was 1 failure:\n\n1) CalcTest::test_calc_001\nstep name accepted: ""\n\n/x/CalcTest.php:9\n', /fails with: step name accepted/]]) {
    const d = approved();
    fakeOut(d, o);
    const r = sdd(d, 'tdd', 'red', 'TEST-CALC-001');
    assert.match(r.out, re, r.out);
  }
});

test('#143 rejected run keeps the Rust assertion message and left/right values', () => {
  const d = approved();
  fakeOut(d, "running 1 test\nthread 'x' panicked at src/lib.rs:3:5:\nassertion `left == right` failed\n  left: 51\n right: 50\nnote: run with `RUST_BACKTRACE=1`\nfailures:\ntest result: FAILED. 0 passed; 1 failed\nerror: test failed, to rerun pass `--test x`\n");
  sdd(d, 'tdd', 'red', 'TEST-CALC-001');
  fakeOut(d, "running 1 test\nthread 'x' panicked at src/lib.rs:3:5:\nassertion `left == right` failed\n  left: 51\n right: 50\nnote: run with `RUST_BACKTRACE=1`\nfailures:\ntest result: FAILED. 0 passed; 1 failed\nerror: test failed, to rerun pass `--test x`\n");
  const g = sdd(d, 'tdd', 'green', 'TEST-CALC-001');
  assert.match(g.out, /left: 51/, g.out);
  assert.match(g.out, /right: 50/, g.out);
});

test('#142 weak Red: Assert.X (.NET), chained/tuple/derived/helper-wrapped asserted results and dotted stub names are not setup', () => {
  const cases = [
    ['  const p = add(0);', '  Assert.AreEqual(1, p.Line);'],
    ['  const v = add(0);', '  assert(4.0 <= v && v <= 8.0);'],
    ['  const r = add(0);', '  assert.deepEqual([r.x, r.y], [1, 2]);'],
    ['  const toks = add(0);', '  const got = [...toks, "x"];', '  assert.deepEqual(got, ["a"]);'],
    ['  const r = add(1);', '  assert.deepEqual(obj(r), { a: 1 });'],
  ];
  for (const body of cases) {
    const d = approved();
    fs.writeFileSync(path.join(d, 'add.mjs'), "export const add = () => { throw new Error('not implemented: add'); };\n");
    testFile(d, body);
    const r = sdd(d, 'tdd', 'red', 'TEST-CALC-001');
    assert.equal(r.code, 0, r.out);
    assert.doesNotMatch(r.out, /\[weak\]/, `${body.join(' | ')}\n${r.out}`);
  }
  // an assertion that also calls other code keeps a stubbed setup operand weak
  const d = approved();
  fs.writeFileSync(path.join(d, 'add.mjs'), "export const add = () => { throw new Error('not implemented: add'); };\n");
  testFile(d, ['  const seed = add(0, 0);', '  Assert.AreEqual(other(1, 2), 3 + seed);']);
  assert.match(sdd(d, 'tdd', 'red', 'TEST-CALC-001').out, /\[weak\].*setup call "add"/);
  // `Class.method` / `Class->method` stub messages name the method, not the class
  const e = approved();
  testFile(e, ['  const b = make();', '  b.go();', '  assert.equal(b.n, 1);']);
  fakeOut(e, 'Error: not implemented: Box.go\n    at go (add.test.mjs:7:5)\n');
  assert.doesNotMatch(sdd(e, 'tdd', 'red', 'TEST-CALC-001').out, /\[weak\]/);
  testFile(e, ['  const b = make();', '  b.go();', '  assert.equal(b.n, 1);']);
  fakeOut(e, 'not implemented in here\n');
  assert.doesNotMatch(sdd(e, 'tdd', 'red', 'TEST-CALC-001').out, /setup call "(in|here)"/);
});

test('#142 weak Red: Go panic stub in test setup and C# static initializer are weak; Go reason shows the panic', () => {
  const d = approved();
  testFile(d, ['  const c = New();', '  assert.equal(other(), 3);']);
  fakeOut(d, '--- FAIL: TestCalc (0.00s)\npanic: nyi: New [recovered]\n\ngoroutine 7 [running]:\nexample.com/x.New(...)\n\t/x/calc.go:3 +0x1\nexample.com/x.TestCalc(0xc0)\n\t/x/add.test.mjs:6 +0x2\n');
  const r = sdd(d, 'tdd', 'red', 'TEST-CALC-001');
  assert.match(r.out, /fails with: panic: nyi: New/, r.out);
  assert.match(r.out, /\[weak\].*setup call "New"/, r.out);
  const e = approved();
  testFile(e, ['  assert.equal(add(1, 2), 3);']);
  fakeOut(e, 'System.TypeInitializationException: The type initializer for \'T\' threw an exception.\n ---> System.NotImplementedException : The method or operation is not implemented.\n   at P.Satisfy(Func`2 f) in /x/P.cs:line 3\n');
  assert.match(sdd(e, 'tdd', 'red', 'TEST-CALC-001').out, /\[weak\].*setup call "Satisfy"/);
});

// ---- wave 3/4 dogfood-7 (#213-#224) ----
const oracleDrift = (d, id, edit) => {
  assert.equal(sdd(d, 'tdd', 'red', id).code, 0);
  fakeOut(d, 'pass', 0);
  assert.equal(sdd(d, 'tdd', 'green', id).code, 0, 'unchanged oracle keeps Green');
  edit();
  const g = sdd(d, 'tdd', 'green', id);
  assert.equal(g.code, 1, g.out);
  assert.match(g.out, /changed since Red/);
};

test('#219 JS/TS local test-support imports and data are hashed oracles; production is not', () => {
  const d = batch2Source('test/a.test.js', "import { expected } from './oracle.js';\nimport { add } from '../src/add.js';\nimport data from './data.json';\n// @id TEST-CALC-001 @verifies REQ-CALC-001\ntest('a', () => { assert.equal(add(1, 2), expected + data.n); });\n");
  writeAll(d, { 'test/oracle.js': 'export const expected = 4;\n', 'test/data.json': '{"n":0}', 'src/add.js': 'export const add = (a, b) => 0;\n' });
  fakeOut(d, 'AssertionError: 0 !== 4');
  oracleDrift(d, 'TEST-CALC-001', () => writeAll(d, { 'test/oracle.js': 'export const expected = 3;\n' }));
  writeAll(d, { 'test/oracle.js': 'export const expected = 3;\n', 'src/add.js': 'export const add = (a, b) => a + b;\n' });
  assert.equal(sdd(d, 'tdd', 'red', 'TEST-CALC-001', '--retest', 'oracle fixed').code, 0);
});

test('#214 Python conftest.py edits stale test evidence', () => {
  const d = batch2Source('tests/test_a.py', 'def test_calc_001(val):\n    # @id TEST-CALC-001 @verifies REQ-CALC-001\n    assert val == 2\n');
  writeAll(d, { 'tests/conftest.py': 'import pytest\n@pytest.fixture\ndef val():\n    return 1\n' });
  fakeOut(d, 'E   assert 1 == 2\nFAILED tests/test_a.py::test_calc_001 - assert 1 == 2\n1 failed');
  oracleDrift(d, 'TEST-CALC-001', () => writeAll(d, { 'tests/conftest.py': 'import pytest\n@pytest.fixture\ndef val():\n    return 2\n' }));
});

test('#224 R source()/helper/data oracles are hashed', () => {
  const d = batch2Source('tests/testthat/test-a.R', 'source("oracle_b.R")\ntest_that("a", {\n  # @id TEST-CALC-001 @verifies REQ-CALC-001\n  expect_equal(f(), expected_b + helper_v() + nrow(read.csv("oracle_c.csv")))\n})\n');
  writeAll(d, { 'tests/testthat/oracle_b.R': 'expected_b <- 1\n', 'tests/testthat/oracle_c.csv': 'a\n1\n', 'tests/testthat/helper-x.R': 'helper_v <- function() 1\n' });
  fakeOut(d, 'Failure (test-a.R:4:3): a\nf() not equal to 3\n');
  oracleDrift(d, 'TEST-CALC-001', () => writeAll(d, { 'tests/testthat/helper-x.R': 'helper_v <- function() 2\n' }));
});

test('#214 Red is not a load error just because a test names SqlSyntaxError; a real SyntaxError still is', () => {
  const d = batch2Source('tests/test_a.py', 'import pytest\ndef test_calc_001():\n    # @id TEST-CALC-001 @verifies REQ-CALC-001\n    with pytest.raises(SqlSyntaxError):\n        parse("x")\n');
  fakeOut(d, '    with pytest.raises(SqlSyntaxError):\n>       parse("x")\nE       Failed: DID NOT RAISE <class \'SqlSyntaxError\'>\nFAILED tests/test_a.py::test_calc_001\n1 failed');
  const ok = sdd(d, 'tdd', 'red', 'TEST-CALC-001');
  assert.equal(ok.code, 0, ok.out);
  const d2 = batch2Source('tests/test_a.py', 'def test_calc_001():\n    # @id TEST-CALC-001 @verifies REQ-CALC-001\n    assert 1 == 2\n');
  fakeOut(d2, 'E     File "tests/test_a.py", line 1\nE   SyntaxError: invalid syntax\n1 error');
  assert.match(sdd(d2, 'tdd', 'red', 'TEST-CALC-001').out, /REJECTED/);
});

test('#224 R parse errors and runner load failures are load errors, not Red', () => {
  const d = batch2Source('tests/testthat/test-a.R', 'test_that("a", {\n  # @id TEST-CALC-001 @verifies REQ-CALC-001\n  stopifnot(1 == 1))\n})\n');
  for (const text of ['Error: unexpected \')\' in "  stopifnot(1 == 1))"\nExecution halted', 'Error in dyn.load(file, DLLpath = DLLpath, ...) :\n  unable to load shared object \'rlang.so\'\nExecution halted']) {
    fakeOut(d, text);
    const r = sdd(d, 'tdd', 'red', 'TEST-CALC-001');
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /REJECTED/);
  }
});

test('#213 gate --changed still runs workspace-wide root tooling (typecheck) when only a nested project changed', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-nest-'));
  const git = (...a) => spawnSync('git', a, { cwd: d });
  const w = (f, c) => { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), c); };
  git('init', '-q'); git('config', 'user.email', 'a@b'); git('config', 'user.name', 't');
  w('package.json', '{"name":"r"}'); w('worker/pyproject.toml', '[project]\nname="w"\nversion="0"\n'); w('worker/a.py', 'x = 1\n'); w('other/pyproject.toml', '[project]\nname="o"\nversion="0"\n');
  sdd(d, 'init');
  const cfgPath = path.join(d, '.sdd/config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  cfg.checks = [{ name: 'typecheck', cmd: ['node', '-e', 'process.exit(1)'], changedCmd: ['node', '-e', 'process.exit(1)'] }];
  cfg.projects = [{ root: 'worker', checks: [] }, { root: 'other', checks: [] }];
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));
  git('add', '-A'); git('commit', '-qm', 'base');
  w('worker/a.py', 'x = 2\n');
  const r = sdd(d, 'gate', '--changed');
  assert.match(r.out, /✗ cmd typecheck/);
  assert.notEqual(r.code, 0);
  cfg.checks[0].name = 'test';
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));
  const t = sdd(d, 'gate', '--changed').out;
  assert.match(t, /cmd test: all changed files are inside nested projects \(worker\/\) — root test check skipped/);
  assert.doesNotMatch(t, /other\//);
});

test('#217 Rust `should panic` rows count and a crashed test host is not a Red', () => {
  const d = batch2Source('tests/t.rs', '// @id TEST-CALC-001 @verifies REQ-CALC-001\n#[test]\n#[should_panic]\nfn test_calc_001() { boom(); }\n');
  writeAll(d, { 'Cargo.toml': '[package]\nname="p"\nversion="0.1.0"\nedition="2021"\n', 'src/lib.rs': 'pub fn boom() {}\n' });
  fakeOut(d, '     Running tests/t.rs (target/debug/deps/t-abc)\n\nrunning 1 test\ntest test_calc_001 - should panic ... FAILED\n\nfailures:\n\n---- test_calc_001 stdout ----\nnote: test did not panic as expected\n\ntest result: FAILED. 0 passed; 1 failed; 0 ignored;\nerror: test failed, to rerun pass `--test t`\n\nCaused by:\n  process didn\'t exit successfully: `target/debug/deps/t-abc` (exit status: 101)\n');
  const ok = sdd(d, 'tdd', 'red', 'TEST-CALC-001');
  assert.equal(ok.code, 0, ok.out);
  const d2 = batch2Source('tests/t.rs', '// @id TEST-CALC-001 @verifies REQ-CALC-001\n#[test]\nfn test_calc_001() { deep(0); }\n');
  writeAll(d2, { 'Cargo.toml': '[package]\nname="p"\nversion="0.1.0"\nedition="2021"\n', 'src/lib.rs': 'pub fn deep(n: u64) -> u64 { deep(n) }\n' });
  for (const why of ['(signal: 6, SIGABRT: process abort signal)', '(exit status: 3)']) {
    fakeOut(d2, `     Running tests/t.rs (target/debug/deps/t-abc)\n\nrunning 1 test\nerror: test failed, to rerun pass \`--test t\`\n\nCaused by:\n  process didn't exit successfully: \`target/debug/deps/t-abc\` ${why}\n`);
    const r = sdd(d2, 'tdd', 'red', 'TEST-CALC-001', '--weak');
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /crashed/);
  }
});

test('#221 --retest over a strong Red warns and the gate reports the superseded strong Red', () => {
  const d = batch2Source('test/a.test.js', "// @id TEST-CALC-001 @verifies REQ-CALC-001\ntest('a', () => { assert.equal(add(1, 2), 4); });\n");
  fakeOut(d, 'AssertionError: 3 !== 4');
  assert.equal(sdd(d, 'tdd', 'red', 'TEST-CALC-001').code, 0);
  fakeOut(d, 'pass', 0);
  writeAll(d, { 'test/a.test.js': "// @id TEST-CALC-001 @verifies REQ-CALC-001\ntest('a', () => { assert.equal(add(1, 2), 3); });\n" });
  const r = sdd(d, 'tdd', 'red', 'TEST-CALC-001', '--retest', 'typo in expectation');
  assert.match(r.out, /earlier strong Red .* superseded/);
  assert.equal(sdd(d, 'tdd', 'green', 'TEST-CALC-001').code, 0);
  assert.match(sdd(d, 'gate', '--no-run').out, /superseded an earlier strong Red/);
});

test('#220 #223 C/C++ `TEST(name) {}` macro tests get isolated hash regions', () => {
  const src = (bodyB) => `#define TEST(n) static int n(void)\n/** @id CODE-CALC-001 @implements REQ-CALC-001 */\nint impl(void) { return 0; }\n// @id TEST-CALC-001 @verifies REQ-CALC-001\nTEST(test_calc_001) { return impl() == 1; }\n// @id TEST-CALC-002 @verifies REQ-CALC-001\nTEST(test_calc_002) { return ${bodyB}; }\n`;
  const d = batch2Source('t.c', src('2 == 2'));
  fakeOut(d, 'assertion failed: test_calc_001');
  assert.equal(sdd(d, 'tdd', 'red', 'TEST-CALC-001').code, 0);
  fakeOut(d, 'pass', 0);
  writeAll(d, { 't.c': src('3 == 3') });
  assert.equal(sdd(d, 'tdd', 'green', 'TEST-CALC-001').code, 0);
  writeAll(d, { 't.c': src('3 == 3').replace('return impl() == 1', 'return impl() == 2') });
  assert.match(sdd(d, 'tdd', 'green', 'TEST-CALC-001').out, /changed since Red/);
  const g = batch2Source('t.cpp', '#include <gtest/gtest.h>\n// @id TEST-CALC-001 @verifies REQ-CALC-001\nTEST(Suite, one) { EXPECT_EQ(1, 2); }\n// @id TEST-CALC-002 @verifies REQ-CALC-001\nTEST_F(Fix, two) { EXPECT_EQ(2, 2); }\n');
  fakeOut(g, 'Failure');
  assert.equal(sdd(g, 'tdd', 'red', 'TEST-CALC-001').code, 0);
  fakeOut(g, 'pass', 0);
  writeAll(g, { 't.cpp': '#include <gtest/gtest.h>\n// @id TEST-CALC-001 @verifies REQ-CALC-001\nTEST(Suite, one) { EXPECT_EQ(1, 2); }\n// @id TEST-CALC-002 @verifies REQ-CALC-001\nTEST_F(Fix, two) { EXPECT_EQ(2, 3); }\n// @id TEST-CALC-003 @verifies REQ-CALC-001\nTEST(Suite, three) { EXPECT_EQ(3, 3); }\n' });
  const gg = sdd(g, 'tdd', 'green', 'TEST-CALC-001'); assert.equal(gg.code, 0, gg.out);
});

test('#223 #220 macro-declared C tests use the macro argument as the exact CTest name', { skip: !has130('cmake') }, () => {
  const d = batch2Source('t.c', '#include <string.h>\n#define TEST(n) static int n(void)\n/** @id TEST-CALC-001 @verifies REQ-CALC-001 */\nTEST(test_calc_001) { return 0; }\nTEST(test_calc_001_extra) { return 1; }\nint main(int c, char **v) {\n  if (c > 1 && !strcmp(v[1], "test_calc_001")) return test_calc_001() ? 0 : 1;\n  if (c > 1 && !strcmp(v[1], "test_calc_001_extra")) return test_calc_001_extra() ? 0 : 1;\n  return 2;\n}\n');
  writeAll(d, { 'CMakeLists.txt': 'cmake_minimum_required(VERSION 3.16)\nproject(r C)\nenable_testing()\nadd_executable(t t.c)\nadd_test(NAME test_calc_001 COMMAND t test_calc_001)\nadd_test(NAME test_calc_001_extra COMMAND t test_calc_001_extra)\n' });
  fs.rmSync(path.join(d, '.sdd/config.json'), { force: true });
  assert.equal(sdd(d, 'init').code, 0);
  const r = sdd(d, 'tdd', 'red', 'TEST-CALC-001');
  assert.equal(r.code, 0, r.out);
});

test('#217 Rust macro_rules-generated tests resolve the first macro argument as the test name', () => {
  const d = batch2Source('tests/t.rs', '// @id TEST-CALC-001 @verifies REQ-CALC-001\ncase!(test_calc_001_one, { assert_eq!(1, 2) });\n');
  writeAll(d, { 'Cargo.toml': '[package]\nname="p"\nversion="0.1.0"\nedition="2021"\n' });
  fakeOut(d, 'running 1 test\ntest test_calc_001_one ... FAILED\n\nfailures:\n---- test_calc_001_one stdout ----\nassertion `left == right` failed\n\ntest result: FAILED. 0 passed; 1 failed;');
  const r = sdd(d, 'tdd', 'red', 'TEST-CALC-001');
  assert.equal(r.code, 0, r.out);
});

test('#222 PHP traits used by the test class are hashed oracles', () => {
  const d = batch2Source('tests/CalcTest.php', '<?php\nnamespace Probe\\Tests;\nuse Probe\\Support\\RowsTrait;\nfinal class CalcTest {\n    use RowsTrait;\n    // @id TEST-CALC-001 @verifies REQ-CALC-001\n    public function test_calc_001() { self::assertSame(self::rows(), 4); }\n}\n');
  writeAll(d, { 'tests/Support/RowsTrait.php': '<?php\nnamespace Probe\\Support;\ntrait RowsTrait { public static function rows(): int { return 5; } }\n' });
  fakeOut(d, 'There was 1 failure:\n1) Probe\\Tests\\CalcTest::test_calc_001\nFailed asserting that 5 is identical to 4.\nTests: 1, Assertions: 1, Failures: 1.');
  oracleDrift(d, 'TEST-CALC-001', () => writeAll(d, { 'tests/Support/RowsTrait.php': '<?php\nnamespace Probe\\Support;\ntrait RowsTrait { public static function rows(): int { return 4; } }\n' }));
});

test('#222 impact follows PHP `use function` / `use const` imports, including groups', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-i222-'));
  const w = (f, b) => { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), b); };
  spawnSync('git', ['init', '-q'], { cwd: d });
  for (const f of ['a', 'b', 'c']) w(`.sdd/specs/${f}.md`, `---\nfeature: ${f}\ntier: T1\n---\n- REQ-${f.toUpperCase()}-001 x\n`);
  w('src/A/fn.php', '<?php\nnamespace A;\nconst LIMIT = 3;\n// @id CODE-A-001 @implements REQ-A-001\nfunction twice(int $x): int { return $x * 2; }\n');
  w('src/B/D.php', '<?php\nnamespace B;\nuse function A\\twice;\nuse const A\\LIMIT;\n// @id CODE-B-001 @implements REQ-B-001\nclass D { function f() { return twice(LIMIT); } }\n');
  w('src/C/E.php', '<?php\nnamespace C;\nuse function A\\{twice as dbl};\n// @id CODE-C-001 @implements REQ-C-001\nclass E { function f() { return dbl(1); } }\n');
  sdd(d, 'init');
  const reached = JSON.parse(sdd(d, 'impact', 'src/A/fn.php', '--json').out).reachedFiles;
  assert.ok(reached.includes('src/B/D.php') && reached.includes('src/C/E.php'), reached.join(','));
});

test('#218 plan accepts an em dash as "no dependency"; impact sees `record struct` types', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-i218-'));
  const w = (f, b) => { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), b); };
  spawnSync('git', ['init', '-q'], { cwd: d });
  for (const f of ['a', 'b']) w(`.sdd/specs/${f}.md`, `---\nfeature: ${f}\ntier: T1\n---\n- REQ-${f.toUpperCase()}-001 x\n`);
  w('.sdd/plan.md', '| order | feature | depends | note |\n|---|---|---|---|\n| 1 | a | — | x |\n| 2 | b | a | y |\n');
  w('Geo/Pt.cs', 'namespace Lib.Geo;\n// @id CODE-A-001 @implements REQ-A-001\npublic readonly record struct Pt(int X, int Y);\n');
  w('Route/Route.cs', 'using Lib.Geo;\nnamespace Lib.Route;\n// @id CODE-B-001 @implements REQ-B-001\npublic class Route { Pt p; }\n');
  sdd(d, 'init');
  const pl = sdd(d, 'plan');
  assert.doesNotMatch(pl.out + pl.err, /unknown dependency/);
  assert.ok(JSON.parse(sdd(d, 'impact', 'Geo/Pt.cs', '--json').out).reachedFiles.includes('Route/Route.cs'));
});

test('#216 JUnit abstract base-class tests resolve to the single concrete subclass owner', () => {
  const d = batch2Source('tests/probe/BaseContract.java', 'package probe;\nabstract class BaseContract {\n// @id TEST-CALC-001 @verifies REQ-CALC-001\n@Test\nvoid test_calc_001() { assertEquals(1, 2); }\n}\n');
  writeAll(d, { 'tests/probe/ImplTest.java': 'package probe;\nclass ImplTest extends BaseContract {}\n' });
  const red = batch2Run(d, 'mvn', 'printf "%s\\n" "$@" > args.txt\necho "SDD-TEST probe.ImplTest test_calc_001 FAILURE"\necho "AssertionError: base"\nexit 1\n', ['mvn', 'test', '-Dtest={idu}'], 'tdd', 'red', 'TEST-CALC-001');
  assert.equal(red.code, 0, red.out);
  assert.match(rd130(d, 'args.txt'), /-Dtest=probe.ImplTest#test_calc_001/);
});

test('#216 message-less Java exceptions show the exception class in "fails with"', () => {
  const d = batch2Source('tests/probe/NpeTest.java', 'package probe;\nclass NpeTest {\n// @id TEST-CALC-001 @verifies REQ-CALC-001\n@Test\nvoid test_calc_001() { assertTrue(true); }\n}\n');
  const r = batch2Run(d, 'mvn', 'echo "SDD-TEST probe.NpeTest test_calc_001 FAILURE"\necho "java.lang.NullPointerException"\necho "	at probe.Prod.find(Prod.java:3)"\necho "[ERROR] [Help 1] http://cwiki.apache.org/confluence/display/MAVEN/MojoFailureException"\nexit 1\n', ['mvn', 'test', '-Dtest={idu}'], 'tdd', 'red', 'TEST-CALC-001');
  assert.match(r.out, /fails with: java\.lang\.NullPointerException/, r.out);
});

test('#226 a timed-out run kills the whole process group, not only the launcher', () => {
  const d = approved();
  fs.writeFileSync(path.join(d, '.sdd/config.json'), JSON.stringify({ schemaVersion: 1, testCmd: ['sh', '-c', 'sleep 47 & echo $! > child.pid; wait', 'x'], timeoutMs: 600 }));
  const r = sdd(d, 'tdd', 'red', 'TEST-CALC-001');
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /timed out after 600 ms \(hung test/, r.out);
  const pid = Number(fs.readFileSync(path.join(d, 'child.pid'), 'utf8'));
  let alive = true;
  for (let i = 0; i < 20 && alive; i++) { try { process.kill(pid, 0); spawnSync('sleep', ['0.1']); } catch { alive = false; } }
  assert.equal(alive, false, 'orphaned test process survived the timeout');
});

test('#228 tdd red survives a tracked Java file deleted without git rm', () => {
  const d = batch2Source('tests/probe/CalcTest.java', 'package probe;\nclass CalcTest {\n// @id TEST-CALC-001 @verifies REQ-CALC-001\n@Test\nvoid test_calc_001() { assertEquals(1, 2); }\n}\n');
  writeAll(d, { 'src/Old.java': 'package probe;\nclass Old {}\n' });
  spawnSync('git', ['init', '-q'], { cwd: d });
  spawnSync('git', ['add', '-A'], { cwd: d });
  fs.rmSync(path.join(d, 'src/Old.java'));
  const r = batch2Run(d, 'mvn', 'echo "SDD-TEST probe.CalcTest test_calc_001 FAILURE"\necho "AssertionError: x"\nexit 1\n', ['mvn', 'test', '-Dtest={idu}'], 'tdd', 'red', 'TEST-CALC-001');
  assert.doesNotMatch(r.out, /ENOENT|at .*\.mjs/, r.out);
  assert.equal(r.code, 0, r.out);
});

const goProject = (file, body, extra = {}) => {
  const d = batch2Source(file, body);
  writeAll(d, { 'go.mod': 'module example.org/m\n\ngo 1.21\n', 'calc.go': 'package m\n\nfunc Calc() int { return 2 }\n', ...extra });
  fs.writeFileSync(path.join(d, '.sdd/config.json'), JSON.stringify({ testCmd: ['go', 'test', './...', '-run', '{IDU}(_|$)'], checks: [] }));
  return d;
};

test('#215 Go Fuzz*, Benchmark* and Example* functions carry @id evidence', { skip: spawnSync('go', ['version']).status !== 0 }, () => {
  const d = goProject('calc_test.go', 'package m\n\nimport "testing"\n\n// @id TEST-CALC-001 @verifies REQ-CALC-001\nfunc FuzzTEST_CALC_001_calc(f *testing.F) {\n\tf.Add(1)\n\tf.Fuzz(func(t *testing.T, x int) {\n\t\tif Calc() != 1 {\n\t\t\tt.Fatal("calc")\n\t\t}\n\t})\n}\n\n// @id TEST-CALC-002 @verifies REQ-CALC-001\nfunc BenchmarkTEST_CALC_002_calc(b *testing.B) {\n\tfor i := 0; i < b.N; i++ {\n\t\tif Calc() != 1 {\n\t\t\tb.Fatal("calc")\n\t\t}\n\t}\n}\n\n// @id TEST-CALC-003 @verifies REQ-CALC-001\nfunc ExampleCalc_test_calc_003() {\n\t// Output: 1\n}\n');
  for (const id of ['TEST-CALC-001', 'TEST-CALC-002', 'TEST-CALC-003']) {
    const r = sdd(d, 'tdd', 'red', id);
    assert.equal(r.code, 0, id + r.out);
  }
  fs.writeFileSync(path.join(d, 'calc.go'), 'package m\n\nfunc Calc() int { return 1 }\n');
  for (const id of ['TEST-CALC-001', 'TEST-CALC-002']) assert.equal(sdd(d, 'tdd', 'green', id).code, 0, id);
});

test('#227 Go tests behind a //go:build tag run with -tags automatically', () => {
  const d = goProject('dbg_test.go', '//go:build dbg\n\npackage m\n\nimport "testing"\n\n// @id TEST-CALC-001 @verifies REQ-CALC-001\nfunc TestTEST_CALC_001_calc(t *testing.T) {\n\tif Calc() != 1 {\n\t\tt.Fatal("calc")\n\t}\n}\n');
  const red = sdd(d, 'tdd', 'red', 'TEST-CALC-001');
  assert.equal(red.code, 0, red.out);
  assert.match(red.out, /-tags dbg/);
  fs.writeFileSync(path.join(d, 'calc.go'), 'package m\n\nfunc Calc() int { return 1 }\n');
  assert.equal(sdd(d, 'tdd', 'green', 'TEST-CALC-001').code, 0);
});

test('#229 appending a test to a partial test-class sibling does not stale the other file', () => {
  const body = (n, extra = '') => `namespace Tests;\npublic partial class MoneyTests {\n${extra}// @id TEST-CALC-00${n} @verifies REQ-CALC-001\n[Fact]\npublic void test_calc_00${n}() { Assert.Equal(1, 2); }\n}\n`;
  const d = batch2Source('tests/MoneyTests.cs', body(1));
  writeAll(d, { 'tests/MoneyTests.Fx.cs': body(2) });
  fakeOut(d, 'AssertionError: target');
  for (const id of ['TEST-CALC-001', 'TEST-CALC-002']) assert.equal(sdd(d, 'tdd', 'red', id).code, 0, id);
  fakeOut(d, 'pass', 0);
  for (const id of ['TEST-CALC-001', 'TEST-CALC-002']) assert.equal(sdd(d, 'tdd', 'green', id).code, 0, id);
  const f = path.join(d, 'tests/MoneyTests.cs');
  fs.writeFileSync(f, rd130(d, 'tests/MoneyTests.cs').replace(/\}\n$/, '// @id TEST-CALC-003 @verifies REQ-CALC-001\n[Fact]\npublic void test_calc_003() { Assert.Equal(1, 2); }\n}\n'));
  const r = sdd(d, 'tdd', 'green', 'TEST-CALC-002');
  assert.equal(r.code, 0, r.out);
  assert.doesNotMatch(r.out, /changed since/);
  fs.writeFileSync(path.join(d, 'tests/MoneyTests.cs'), rd130(d, 'tests/MoneyTests.cs').replace('namespace Tests;', 'namespace Tests;\nusing Oracle;'));
  assert.equal(sdd(d, 'tdd', 'green', 'TEST-CALC-002').code, 1, 'shared sibling content is still an oracle');
});
const hasPhpunit = spawnSync('phpunit', ['--version'], { encoding: 'utf8' }).status === 0;
function phpProject(files) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-p222-'));
  spawnSync('git', ['init', '-q'], { cwd: d });
  const reqs = [1, 2, 3].map((n) => `| REQ-P-00${n} | The calc shall add ${n}. | TEST-P-00${n} |`).join('\n');
  writeAll(d, { '.sdd/specs/p.md': `---\nfeature: p\ntier: T1\n---\n# p\n| ID | EARS requirement | Test |\n| --- | --- | --- |\n${reqs}\n`, 'phpunit.xml': '<phpunit bootstrap="boot.php"><testsuites><testsuite name="t"><directory>tests</directory></testsuite></testsuites></phpunit>', 'boot.php': "<?php\nspl_autoload_register(function ($c) { foreach (['tests/', 'src/'] as $b) { $f = __DIR__ . '/' . $b . basename(str_replace('\\\\', '/', $c)) . '.php'; if (is_file($f)) require_once $f; } });\n", ...files });
  sdd(d, 'init');
  return d;
}

test('#222 PHPUnit: a sibling test\'s broken data provider is not credited as the target\'s Red', { skip: !hasPhpunit }, () => {
  const d = phpProject({ 'tests/PTest.php': "<?php\nnamespace T;\nuse PHPUnit\\Framework\\TestCase;\nuse PHPUnit\\Framework\\Attributes\\DataProvider;\nfinal class PTest extends TestCase\n{\n    public static function rows(): array { throw new \\LogicException('broken'); }\n    /** @id TEST-P-001 @verifies REQ-P-001 */\n    #[DataProvider('rows')]\n    public function test_p_001_sibling(int $x): void { $this->assertSame($x, $x); }\n    /** @id TEST-P-002 @verifies REQ-P-002 */\n    public function test_p_002_target(): void { $this->assertSame(4, 2 + 2); }\n}\n" });
  const r = sdd(d, 'tdd', 'red', 'TEST-P-002');
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /REJECTED TEST-P-002: .*(?:itself passes|test passed)/);
});

test('#222 PHPUnit: tests declared in an abstract base class or trait run through the concrete subclass', { skip: !hasPhpunit }, () => {
  const d = phpProject({
    'src/Calc.php': '<?php\nnamespace Lib;\n// @id CODE-P-001 @implements REQ-P-001\nfinal class Calc { public function add(int $a, int $b): int { return $a + $b + 1; } }\n',
    'tests/BaseTest.php': "<?php\nnamespace T;\nuse PHPUnit\\Framework\\TestCase;\nuse Lib\\Calc;\nabstract class BaseTest extends TestCase\n{\n    /** @id TEST-P-001 @verifies REQ-P-001 */\n    public function test_p_001_base(): void { $this->assertSame(5, (new Calc())->add(2, 3)); }\n}\n",
    'tests/AddsTrait.php': "<?php\nnamespace T;\nuse Lib\\Calc;\ntrait AddsTrait\n{\n    /** @id TEST-P-002 @verifies REQ-P-002 */\n    public function test_p_002_trait(): void { $this->assertSame(5, (new Calc())->add(2, 3)); }\n}\n",
    'tests/CalcTest.php': '<?php\nnamespace T;\nfinal class CalcTest extends BaseTest\n{\n    use AddsTrait;\n}\n',
  });
  for (const id of ['TEST-P-001', 'TEST-P-002']) {
    const r = sdd(d, 'tdd', 'red', id);
    assert.equal(r.code, 0, r.out);
    assert.doesNotMatch(r.out, /abstract|cannot be found/);
    assert.match(r.out, /^RED ok /);
  }
  fs.writeFileSync(path.join(d, 'src/Calc.php'), '<?php\nnamespace Lib;\n// @id CODE-P-001 @implements REQ-P-001\nfinal class Calc { public function add(int $a, int $b): int { return $a + $b; } }\n');
  for (const id of ['TEST-P-001', 'TEST-P-002']) { const g = sdd(d, 'tdd', 'green', id); assert.equal(g.code, 0, g.out); }
});

test('#221 C++ first Red after a clean build is not refused as "changed while running"', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-c221-'));
  spawnSync('git', ['init', '-q'], { cwd: d });
  const db = JSON.stringify([{ directory: '.', file: 'tests/t.cpp', arguments: ['c++', '-include', 'tests/oracle.hpp', '-c', 'tests/t.cpp'] }]);
  writeAll(d, {
    '.sdd/specs/c.md': '---\nfeature: c\ntier: T1\n---\n- REQ-C-001 x\n',
    'tests/t.cpp': '// @id TEST-C-001 @verifies REQ-C-001\nstatic int test_c_001() { return 1; }\n',
    'tests/oracle.hpp': '#define EXPECTED 7\n',
  });
  sdd(d, 'init');
  const cfg = path.join(d, '.sdd/config.json');
  const c = JSON.parse(fs.readFileSync(cfg, 'utf8'));
  c.testCmd = ['sh', '-c', 'mkdir -p build && printf "%s" "$0" > build/compile_commands.json; echo "Assertion failed: x"; exit 1', db];
  fs.writeFileSync(cfg, JSON.stringify(c));
  const r = sdd(d, 'tdd', 'red', 'TEST-C-001');
  assert.doesNotMatch(r.out, /changed while running/);
  assert.match(r.out, /^RED ok TEST-C-001/);
  assert.doesNotMatch(sdd(d, 'gate', '--no-run').out, /changed since/);
});

test('#223 Julia macro-generated @test failure is attributed through its call-site stack frame', () => {
  const d = batch2Source('T.jl', 'using Test\nmacro chk(x)\n    :(@testset "gen" begin @test $x == 2 end)\nend\n# @id TEST-CALC-001 @verifies REQ-CALC-001\n@testset "TEST-CALC-001 f" begin\n@chk(1)\nend\n# @id TEST-SIBLING-001 @verifies REQ-CALC-001\n@testset "TEST-SIBLING-001 g" begin\n@test 3 == 4\nend\n');
  const file = path.join(d, 'T.jl');
  fakeOut(d, `gen: Test Failed at ${file}:3\n  Expression: 1 == 2\n  Stacktrace:\n   [1] top-level scope\n     @ ${file}:7\n   [2] macro expansion\n     @ ${file}:3 [inlined]\nTEST-SIBLING-001 g: Test Failed at ${file}:11\n  Expression: 3 == 4\nTest Summary:       | Fail  Total  Time\nTEST-CALC-001 f     |    1      1  0.1s\n  gen               |    1      1  0.1s\nTEST-SIBLING-001 g  |    1      1  0.1s\n`);
  const red = sdd(d, 'tdd', 'red', 'TEST-CALC-001');
  assert.equal(red.code, 0, red.out);
  assert.match(red.out, /fails with: Expression: 1 == 2/);
});

test('#221 missing CTest registration hints at re-running cmake', { skip: !has130('cmake') || !has130('ctest') }, () => {
  const d = mk130({
    'CMakeLists.txt': 'cmake_minimum_required(VERSION 3.10)\nproject(reg221 NONE)\nenable_testing()\nadd_test(NAME other COMMAND sh -c "exit 0")\n',
    'tests/t.c': '// @id TEST-A-001 @verifies REQ-A-001\nvoid test_a_001_new(void) { CHECK(1); }\n',
  });
  const r = sdd(d, 'tdd', 'red', 'TEST-A-001');
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /CTest registration is missing or ambiguous.*re-run `cmake -S \. -B build`/);
});
test('#214 python tdd stub: namespace dir, __init__ re-exports and package-with-submodule layout', () => {
  const spec = '---\nfeature: a\ntier: T1\n---\n| REQ-A-001 | x shall hold. | TEST-A-001 |\n';
  const t = (imports) => `${imports}\n\ndef test_a_001():\n    """@id TEST-A-001 @verifies REQ-A-001"""\n    assert Clock().tick() == 1\n`;
  const d1 = mini(spec, { 'pyproject.toml': '[project]\nname="m"\nversion="0"\n', 'src/pkg/sub/leaf.py': 'X = 1\n', 'tests/test_a.py': t('from pkg import Clock') });
  sdd(d1, 'tdd', 'stub', 'TEST-A-001');
  assert.match(fs.readFileSync(path.join(d1, 'src/pkg/__init__.py'), 'utf8'), /class Clock/);
  assert.ok(!fs.existsSync(path.join(d1, 'src/pkg.py')));
  const d2 = mini(spec, { 'pyproject.toml': '[project]\nname="m"\nversion="0"\n', 'src/pkg/__init__.py': 'from .core import Clock\n', 'src/pkg/core.py': 'class Clock:\n    def tick(self):\n        return 1\n', 'tests/test_a.py': t('from pkg import Clock') });
  const r2 = sdd(d2, 'tdd', 'stub', 'TEST-A-001');
  assert.doesNotMatch(r2.out, /not stubbed/);
  assert.equal(fs.readFileSync(path.join(d2, 'src/pkg/__init__.py'), 'utf8'), 'from .core import Clock\n');
  const d3 = mini(spec, { 'pyproject.toml': '[project]\nname="m"\nversion="0"\n', 'src/pkg/__init__.py': '', 'tests/test_a.py': t('from pkg.sql import parse\nfrom pkg.sql.ast import Clock') });
  sdd(d3, 'tdd', 'stub', 'TEST-A-001');
  assert.ok(fs.existsSync(path.join(d3, 'src/pkg/sql/__init__.py')) && fs.existsSync(path.join(d3, 'src/pkg/sql/ast.py')));
  assert.ok(!fs.existsSync(path.join(d3, 'src/pkg/sql.py')));
  assert.match(fs.readFileSync(path.join(d3, 'src/pkg/sql/__init__.py'), 'utf8'), /def parse/);
});

test('#215 go tdd stub: a member called as a method anywhere in the file is never also emitted as a struct field', { skip: spawnSync('which', ['go']).status !== 0 }, () => {
  const d = mini('---\nfeature: a\ntier: T1\n---\n| REQ-A-001 | x shall hold. | TEST-A-001 |\n', {
    'go.mod': 'module example.com/kv/core\n\ngo 1.22\n',
    'ring/ring_test.go': [
      'package ring_test', '', 'import (', '\t"testing"', '', '\t"example.com/kv/core/ring"', ')', '',
      'func build(t testing.TB) *ring.Ring {', '\tt.Helper()', '\treturn ring.New(8)', '}', '',
      '// @id TEST-A-001', 'func TestA001(t *testing.T) {', '\tr := build(t)', '\t_ = r.Locate', '}', '',
      '// @id TEST-A-002', 'func TestA002(t *testing.T) {', '\tr := build(t)', '\t_, _ = r.Locate("k")', '}', '',
    ].join('\n'),
  });
  sdd(d, 'tdd', 'stub', 'TEST-A-001');
  const body = fs.readFileSync(path.join(d, 'ring/ring.go'), 'utf8');
  assert.match(body, /func \(\*?Ring\) Locate/);
  assert.doesNotMatch(body, /^\tLocate any$/m);
  assert.doesNotMatch(sdd(d, 'tdd', 'stub', 'TEST-A-001').out, /same name/);
});

test('#218 C# tdd stub honours `global using` namespaces declared in another file of the test project', DN, (t) => {
  const d = tree({
    'src/Lib/Lib.csproj': libProj(),
    'tests/T/T.csproj': testProj(XUNIT, ['..\\..\\src\\Lib\\Lib.csproj']),
    'tests/T/GlobalUsings.cs': 'global using Xunit;\nglobal using Lib.Calc;\n',
    'tests/T/CalcTests.cs': [
      'namespace T;', '', 'public class CalcTests', '{', '    /** @id TEST-A-001 @verifies REQ-A-001 */', '    [Fact]', '    public void adds()', '    {',
      '        Assert.Equal(3, Calculator.Add(1, 2));', '    }', '}', '',
    ].join('\n'),
  });
  if (!restores(d, 'tests/T/T.csproj')) return t.skip('NuGet packages cannot be restored');
  const r = sddRaw(d, 'tdd', 'stub', 'TEST-A-001');
  assert.ok(fs.existsSync(path.join(d, 'src/Lib/Calculator.cs')), r.out);
  assert.match(fs.readFileSync(path.join(d, 'src/Lib/Calculator.cs'), 'utf8'), /namespace Lib\.Calc;/);
  assert.match(r.out, /compile-checked/);
});

test('#219 JS tdd stub: require() of a missing relative module and dynamic import of a workspace package', () => {
  const d = jsStubProject({
    'package.json': '{"name":"root","private":true,"workspaces":["packages/*"],"scripts":{"test":"true"}}',
    'packages/lib/package.json': '{"name":"@x/lib","type":"module","main":"src/index.js"}',
    'packages/lib/src/index.js': 'export const one = () => 1;\n',
    'packages/app/test/a.test.cjs': "const { add } = require('../src/add.cjs');\n/** @id TEST-A-001 @verifies REQ-A-001 */\nit('TEST-A-001 adds', () => { add(1, 2); });\n",
    'packages/app/test/b.test.js': "/** @id TEST-A-002 @verifies REQ-A-002 */\nit('TEST-A-002 dyn', async () => {\n  const m = await import('@x/lib');\n  m.three();\n});\n",
  });
  sdd(d, 'tdd', 'stub', 'TEST-A-001');
  const cjs = fs.readFileSync(path.join(d, 'packages/app/src/add.cjs'), 'utf8');
  assert.match(cjs, /function add\(/);
  assert.match(cjs, /module\.exports = \{ add \}/);
  assert.doesNotMatch(cjs, /\bexport\b/);
  assert.equal(spawnSync('node', ['--check', path.join(d, 'packages/app/src/add.cjs')]).status, 0);
  sdd(d, 'tdd', 'stub', 'TEST-A-002');
  const lib = fs.readFileSync(path.join(d, 'packages/lib/src/index.js'), 'utf8');
  assert.match(lib, /^export const one = \(\) => 1;\n/);
  assert.match(lib, /three/);
});

test('#222 PHP tdd stub: enum cases with instance methods, `use function` / `use const` namespaced symbols', { skip: spawnSync('which', ['php']).status !== 0 }, () => {
  const spec = '---\nfeature: k\ntier: T1\n---\n| REQ-K-001 | x shall hold. | TEST-K-001 |\n| REQ-K-002 | y shall hold. | TEST-K-002 |\n';
  const d = mini(spec, {
    'composer.json': '{"autoload":{"psr-4":{"Kernel\\\\":"src/"}}}',
    'tests/KTest.php': [
      '<?php', 'use PHPUnit\\Framework\\TestCase;', 'use function Kernel\\{clamp, stable_id};', 'use const Kernel\\MAX_NIGHTS;', 'use Kernel\\Level;', '',
      'final class KTest extends TestCase', '{',
      '    /** @id TEST-K-001 @verifies REQ-K-001 */',
      "    public function test_k_001(): void { $this->assertSame(3, clamp(5, MAX_NIGHTS)); $this->assertSame('a', stable_id('a')); }",
      '    /** @id TEST-K-002 @verifies REQ-K-002 */',
      '    public function test_k_002(): void { $this->assertSame(2, Level::High->rank()); }', '}', '',
    ].join('\n'),
  });
  sdd(d, 'tdd', 'stub', 'TEST-K-001');
  const fns = fs.readFileSync(path.join(d, 'src/functions.php'), 'utf8');
  assert.match(fns, /namespace Kernel;/);
  assert.match(fns, /function clamp\(/);
  assert.match(fns, /function stable_id\(/);
  assert.match(fns, /const MAX_NIGHTS/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(d, 'composer.json'), 'utf8')).autoload.files, ['src/functions.php']);
  assert.equal(spawnSync('php', ['-l', path.join(d, 'src/functions.php')]).status, 0);
  sdd(d, 'tdd', 'stub', 'TEST-K-002');
  const en = fs.readFileSync(path.join(d, 'src/Level.php'), 'utf8');
  assert.match(en, /enum Level/);
  assert.match(en, /case High/);
  assert.match(en, /public function rank\(/);
  assert.doesNotMatch(en, /static function rank/);
});

test('#224 R tdd stub: testthat helper functions are not shadowed and missing functions are appended to an existing stub file', () => {
  const spec = '---\nfeature: x\ntier: T1\n---\n| REQ-X-001 | x shall hold. | TEST-X-001 |\n| REQ-X-002 | y shall hold. | TEST-X-002 |\n';
  const d = mini(spec, {
    'DESCRIPTION': 'Package: x\nVersion: 0\n',
    'tests/testthat/helper-data.R': 'sample_input <- function() c(1, 2, 3)\n',
    'tests/testthat/test-x.R': 'source("../../R/x.R")\n\n# @id TEST-X-001\n# @verifies REQ-X-001\nstopifnot(identical(fx(sample_input()), 6))\n\n# @id TEST-X-002\n# @verifies REQ-X-002\nstopifnot(identical(fy(sample_input()), 3L))\n',
  });
  sdd(d, 'tdd', 'stub', 'TEST-X-001');
  const first = fs.readFileSync(path.join(d, 'R/x.R'), 'utf8');
  assert.match(first, /fx <- function/);
  assert.doesNotMatch(first, /sample_input/);
  sdd(d, 'tdd', 'stub', 'TEST-X-002');
  const second = fs.readFileSync(path.join(d, 'R/x.R'), 'utf8');
  assert.match(second, /^fx <- function/);
  assert.match(second, /fy <- function/);
  assert.doesNotMatch(second, /sample_input/);
});

test('#221 C++ stub: a namespace-qualified using-declaration places the class in that namespace', { skip: !has130('g++') }, () => {
  const d = mk130({ 'tests/b.cpp': [
    '#include "cq/arena.hpp"', 'namespace {', 'using cq::mem::Arena;', '}', '// @id TEST-A-001 @verifies REQ-A-001',
    'int main() {', '  Arena a(1024);', '  a.reset();', '  return 0;', '}', '',
  ].join('\n') });
  const r = sdd(d, 'tdd', 'stub', 'TEST-A-001');
  const h = fs.readdirSync(d, { recursive: true }).find((f) => /arena\.hpp$/.test(f));
  const s = rd130(d, h);
  assert.match(s, /namespace cq \{ namespace mem \{/, s);
  assert.match(s, /class Arena/);
  assert.match(r.out, /compile-checked/, r.out);
});

const HAS_MIX = spawnSync('mix', ['--version'], { encoding: 'utf8' }).status === 0;
const exSpec = '---\nfeature: e\ntier: T1\n---\n| REQ-E-001 | add shall hold. | TEST-E-001 |\n| REQ-E-002 | sub shall hold. | TEST-E-002 |\n';
const exFiles = {
  'mix.exs': 'defmodule D.MixProject do\n  use Mix.Project\n  def project, do: [app: :d, version: "0.1.0", deps: []]\nend\n',
  'test/test_helper.exs': 'ExUnit.start()\n',
  'test/support/helpers.ex': 'defmodule D.Helpers do\n  def three, do: 3\nend\n',
  'test/d_test.exs': 'defmodule DTest do\n  use ExUnit.Case, async: true\n  alias D.Calc\n\n  describe "math" do\n    # @id TEST-E-001\n    # @verifies REQ-E-001\n    test "adds" do\n      assert Calc.add(1, 2) == D.Helpers.three()\n    end\n\n    # @id TEST-E-002\n    # @verifies REQ-E-002\n    @tag :slow\n    test "subs" do\n      assert Calc.sub(3, 2) == 99\n    end\n  end\nend\n',
};

test('ExUnit: mix detection, tdd stub, Red/Green attribution by test, impact and oracle hashing', { skip: !HAS_MIX }, () => {
  const d = mini(exSpec, exFiles);
  fs.rmSync(path.join(d, 'package.json'));
  fs.rmSync(path.join(d, '.sdd/config.json'));
  sdd(d, 'init');
  const cfg = JSON.parse(fs.readFileSync(path.join(d, '.sdd/config.json'), 'utf8'));
  assert.deepEqual(cfg.testCmd, ['mix', 'test', '{file}']);
  assert.deepEqual(cfg.checks.map((c) => c.cmd.join(' ')), ['mix test']);
  const st = sdd(d, 'tdd', 'stub', 'TEST-E-001');
  const lib = fs.readFileSync(path.join(d, 'lib/d/calc.ex'), 'utf8');
  assert.match(lib, /defmodule D\.Calc do/, st.out);
  assert.match(lib, /def add\(_a1, _a2\)/);
  assert.doesNotMatch(lib, /three|sub/);
  assert.match(lib, /^# @id CODE-E-001-STUB-001/, lib);
  const red = sdd(d, 'tdd', 'red', 'TEST-E-001', '--allow-setup-red');
  assert.match(red.out, /RED/i, red.out);
  fs.writeFileSync(path.join(d, 'lib/d/calc.ex'), '# @id CODE-E-001-STUB-001 @implements REQ-E-001\ndefmodule D.Calc do\n  def add(a, b), do: a + b\n  def sub(a, b), do: a - b\nend\n');
  const green = sdd(d, 'tdd', 'green', 'TEST-E-001');
  assert.match(green.out, /GREEN/i, green.out);
  // TEST-E-002 fails on its own assertion: attributed to it by file:line, not to TEST-E-001
  const red2 = sdd(d, 'tdd', 'red', 'TEST-E-002');
  assert.match(red2.out, /RED/i, red2.out);
  const imp = sdd(d, 'impact', 'lib/d/calc.ex');
  assert.match(imp.out, /test\/d_test\.exs/, imp.out);
  const before = sdd(d, 'tdd', 'refactor', 'TEST-E-001').out;
  fs.writeFileSync(path.join(d, 'test/support/helpers.ex'), 'defmodule D.Helpers do\n  def three, do: 4\nend\n');
  const stale = sdd(d, 'tdd', 'green', 'TEST-E-001');
  assert.match(stale.out, /REFUSED|REJECTED/, before + stale.out);
});

test('ExUnit: a missing module is a load error, a skipped/excluded test is not Green', { skip: !HAS_MIX }, () => {
  const d = mini(exSpec, { ...exFiles, 'test/d_test.exs': exFiles['test/d_test.exs'].replace('@tag :slow', '@tag :skip') }, ['mix', 'test', '{file}']);
  const r = sdd(d, 'tdd', 'red', 'TEST-E-001');
  assert.match(r.out, /REJECTED[^\n]*load\/compile error/, r.out);
  fs.mkdirSync(path.join(d, 'lib/d'), { recursive: true });
  fs.writeFileSync(path.join(d, 'lib/d/calc.ex'), 'defmodule D.Calc do\n  def add(a, b), do: a + b\n  def sub(a, b), do: a - b\nend\n');
  sdd(d, 'tdd', 'red', 'TEST-E-001', '--characterization', 'already implemented');
  const skipped = sdd(d, 'tdd', 'red', 'TEST-E-002');
  assert.match(skipped.out, /REJECTED[^\n]*no test matched|skipped/i, skipped.out);
});

test('#240 Julia stub resolves include(joinpath(@__DIR__, ...)); plan depends accepts whitespace separators', () => {
  const spec = '---\nfeature: c\ntier: T1\n---\n| REQ-C-001 | When add, the system shall sum. | TEST-C-001 |\n';
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-'));
  spawnSync('git', ['init', '-q'], { cwd: d });
  for (const [f, body] of Object.entries({ 'Project.toml': 'name = "X"\n', '.sdd/specs/c.md': spec, 'test/t.jl': 'include(joinpath(@__DIR__, "..", "src", "C.jl"))\n# @id TEST-C-001 @verifies REQ-C-001\n@test c_add(1, 2) == 3\n' })) { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), body); }
  const r = sdd(d, 'tdd', 'stub', 'TEST-C-001');
  assert.match(r.out, /src\/C\.jl/, r.out);
  assert.match(fs.readFileSync(path.join(d, 'src/C.jl'), 'utf8'), /c_add\(args\.\.\.; kwargs\.\.\.\) = error/);
  fs.writeFileSync(path.join(d, '.sdd/plan.md'), '| order | feature | depends | note |\n|---|---|---|---|\n| 1 | a | - | |\n| 2 | b | - | |\n| 3 | c | a b | |\n');
  assert.doesNotMatch(sdd(d, 'plan').out, /unknown dependency/);
});

test('#236 #239 stale/refused messages name the changed oracle dependency; --retest hint; gate --verbose accepted', () => {
  const d = project();
  fs.writeFileSync(path.join(d, '.sdd/specs/calc.md'), fs.readFileSync(path.join(d, '.sdd/specs/calc.md'), 'utf8').replace('tier: T2', 'tier: T1'));
  fs.writeFileSync(path.join(d, 'helper.mjs'), 'export const one = 1;\n');
  fs.writeFileSync(path.join(d, 'add.test.mjs'), fs.readFileSync(path.join(d, 'add.test.mjs'), 'utf8').replace("import { add }", "import { one } from './helper.mjs';\nimport { add }").replace('add(1, 2)', 'add(one, 2)'));
  impl(d, '(a, b) => { throw new Error("nope"); }');
  assert.match(sdd(d, 'tdd', 'red', 'TEST-CALC-001').out, /RED ok/);
  fs.writeFileSync(path.join(d, 'helper.mjs'), 'export const one = 1; // edited\n');
  impl(d, '(a, b) => a + b');
  const refused = sdd(d, 'tdd', 'green', 'TEST-CALC-001').out;
  assert.match(refused, /REFUSED: test file changed since Red[^\n]*helper\.mjs[^\n]*--retest/, refused);
  fs.writeFileSync(path.join(d, 'helper.mjs'), 'export const one = 1;\n');
  assert.match(sdd(d, 'tdd', 'green', 'TEST-CALC-001').out, /GREEN ok/);
  fs.writeFileSync(path.join(d, 'helper.mjs'), 'export const one = 1; // again\n');
  const gate = sdd(d, 'gate', '--no-run', '--verbose').out;
  assert.match(gate, /test changed since last Green\/Refactor — oracle dependency changed: helper\.mjs/, gate);
});

test('#238 Java @CsvFileSource(files=) resolves against the owning module even with a configured reactor root; a missing file is refused', () => {
  const body = 'package probe;\nclass T {\n// @id TEST-CALC-001 @verifies REQ-CALC-001\n@CsvFileSource(files="../../data/x.csv")\n@Test\nvoid test_calc_001() { assertTrue(true); }\n}\n';
  const d = batch2Source('java/m1/src/test/java/probe/T.java', body);
  writeAll(d, { 'java/pom.xml': '<project/>', 'java/m1/pom.xml': '<project/>', 'data/x.csv': '7,7\n' });
  const cmd = ['sh', '-c', `cat ${d}/out.txt; exit $(cat ${d}/code.txt)`, 'x'];
  const setup = (text, code) => { fs.writeFileSync(path.join(d, 'out.txt'), text); fs.writeFileSync(path.join(d, 'code.txt'), String(code)); };
  fs.writeFileSync(path.join(d, '.sdd/config.json'), JSON.stringify({ schemaVersion: 1, testCmd: cmd, projects: [{ root: 'java', testCmd: cmd, checks: [] }] }));
  setup('AssertionError: oracle', 1);
  const red = sdd(d, 'tdd', 'red', 'TEST-CALC-001');
  assert.equal(red.code, 0, red.out);
  setup('pass', 0);
  const green = sdd(d, 'tdd', 'green', 'TEST-CALC-001');
  assert.equal(green.code, 0, green.out);
  fs.writeFileSync(path.join(d, 'data/x.csv'), '7,7\n8,8\n');
  assert.match(sdd(d, 'gate', '--no-run').out, /test changed since last Green/);
  fs.rmSync(path.join(d, 'data/x.csv'));
  assert.equal(sdd(d, 'tdd', 'green', 'TEST-CALC-001').code, 1);
});

test('#237 PHPUnit helper-assertion failure keeps its message; a crashed/OOM PHP process is not a Red', () => {
  const d = batch2Source('T.php', '<?php\nclass Target {\n// @id TEST-CALC-001 @verifies REQ-CALC-001\npublic function test_calc_001(): void { $this->assertSum(5, 2, 3); }\n}\n');
  fakeOut(d, 'There was 1 failure:\n\n1) Target::test_calc_001\nFailed asserting that 0 is identical to 5.\n\n/w/tests/Support/Check.php:8\n/w/T.php:4\n\nFAILURES!\nTests: 1, Assertions: 1, Failures: 1.\n');
  const red = sdd(d, 'tdd', 'red', 'TEST-CALC-001');
  assert.equal(red.code, 0, red.out);
  assert.match(red.out, /fails with: Failed asserting that 0 is identical to 5\./, red.out);
  const e = batch2Source('T.php', '<?php\nclass Target {\n// @id TEST-CALC-001 @verifies REQ-CALC-001\npublic function test_calc_001(): void { deep(); }\n}\n');
  fakeOut(e, 'There was 1 error:\n\n1) Target::test_calc_001\nFatal error: Premature end of PHP process when running Target::test_calc_001.\n\nERRORS!\nTests: 1, Assertions: 0, Errors: 1.\n', 255);
  const crash = sdd(e, 'tdd', 'red', 'TEST-CALC-001');
  assert.equal(crash.code, 1, crash.out);
  assert.match(crash.out, /REJECTED.*crashed/, crash.out);
});

test('#225 node:test module-level throw from a stub is a weak Red (no test executed)', () => {
  const d = approved();
  fs.writeFileSync(path.join(d, 'add.test.mjs'), [
    "import { test } from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { add } from './add.mjs';",
    'const fixture = add(1, 2);',
    '/** @id TEST-CALC-001 @verifies REQ-CALC-001 */',
    "test('TEST-CALC-001 adds', () => assert.equal(fixture, 3));", '',
  ].join('\n'));
  impl(d, '(a, b) => { throw new Error("not implemented"); }');
  const red = sdd(d, 'tdd', 'red', 'TEST-CALC-001');
  assert.equal(red.code, 0, red.out);
  assert.match(red.out, /weak/i, red.out);
});
test('#230 review template names a per-feature file; #231 stale-test message shows the retest path', () => {
  const d = project();
  assert.match(sdd(d, 'review', 'template', 'calc').out, /\.sdd\/review-calc\.md/);
  const t = sdd(d, 'review', 'template', 'calc').out.replace('verdict: pending', 'verdict: pass');
  fs.writeFileSync(path.join(d, '.sdd/review-calc.md'), t);
  assert.match(sdd(d, 'review', 'check', '.sdd/review-calc.md', '--feature', 'calc').out, /REVIEW OK/);
  const ev = evidenceStatusProbe(d);
  assert.match(ev, /--retest/);
});
function evidenceStatusProbe(d) {
  const w = (a, c) => fs.writeFileSync(path.join(d, 'add.test.mjs'), [
    "import test from 'node:test'; import assert from 'node:assert'; import { add } from './add.mjs';",
    '/** @id TEST-CALC-001 @verifies REQ-CALC-001 */',
    `test('TEST-CALC-001 adds', () => assert.equal(${a}, 3));`, ''].join('\n'));
  w('add(1, 2)'); impl(d, '(a, b) => a - b');
  sdd(d, 'approve', 'record', 'calc', '--by', 'tester');
  sdd(d, 'tdd', 'red', 'TEST-CALC-001');
  impl(d, '(a, b) => a + b');
  sdd(d, 'tdd', 'green', 'TEST-CALC-001');
  w('add(1, 2) + 0');
  return sdd(d, 'gate', '--no-run').out;
}

test('#233 tech-writer lint ignores an app named todo but flags TODO', () => {
  const lint = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../tech-writer/scripts/lint.py');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-'));
  fs.writeFileSync(path.join(d, 'a.md'), '# todo-cli\n\nThe todo app lists tasks. Use todo add.\n\nTODO finish this.\n');
  const r = spawnSync('python3', [lint, path.join(d, 'a.md')], { encoding: 'utf8' });
  const o = r.stdout + r.stderr;
  assert.match(o, /placeholder/i, o);
  assert.equal((o.match(/placeholder/gi) ?? []).length >= 1, true);
  assert.doesNotMatch(o, /The todo app/, o);
});

test('#219 JS tdd stub: require() of an existing CJS module gets the missing names appended', () => {
  const d = jsStubProject({
    'src/add.cjs': 'function sub(a, b) { return a - b; }\nmodule.exports = { sub };\n',
    'test/a.test.cjs': "const { add, sub } = require('../src/add.cjs');\n/** @id TEST-A-001 @verifies REQ-A-001 */\nit('TEST-A-001 adds', () => { add(1, 2); sub(2, 1); });\n",
  });
  sdd(d, 'tdd', 'stub', 'TEST-A-001');
  const cjs = fs.readFileSync(path.join(d, 'src/add.cjs'), 'utf8');
  assert.match(cjs, /^function sub\(a, b\) \{ return a - b; \}\nmodule\.exports = \{ sub \};\n/);
  assert.match(cjs, /function add\(/);
  assert.match(cjs, /module\.exports\.add = add;/);
  assert.doesNotMatch(cjs, /\bexport\b|function sub[\s\S]*function sub/);
  assert.equal(spawnSync('node', ['--check', path.join(d, 'src/add.cjs')]).status, 0);
});

test('#215 go tdd stub: a result the test passes as a concrete type (*ring.Ring, []*ring.Ring) is not left as any', { skip: spawnSync('which', ['go']).status !== 0 }, () => {
  const spec = '---\nfeature: a\ntier: T1\n---\n| REQ-A-001 | x shall hold. | TEST-A-001 |\n';
  const ext = mini(spec, {
    'go.mod': 'module example.com/kv/core\n\ngo 1.22\n',
    'ring/ring_test.go': [
      'package ring_test', '', 'import (', '\t"testing"', '', '\t"example.com/kv/core/ring"', ')', '',
      'func build(t testing.TB) *ring.Ring {', '\treturn ring.Make(8)', '}', '',
      'func many(n int) []*ring.Ring {', '\treturn ring.Many(n)', '}', '',
      '// @id TEST-A-001', 'func TestA001(t *testing.T) {', '\tr := build(t)', '\t_ = r.Add("k")', '\t_ = many(2)', '}', '',
    ].join('\n'),
  });
  const o = sdd(ext, 'tdd', 'stub', 'TEST-A-001').out;
  const body = fs.readFileSync(path.join(ext, 'ring/ring.go'), 'utf8');
  assert.match(body, /func Make\(a0 any\) \*Ring/);
  assert.match(body, /func Many\(a0 any\) \[\]\*Ring/);
  assert.match(o, /compile-checked/, o);
  const inPkg = mini(spec, {
    'go.mod': 'module example.com/kv/core\n\ngo 1.22\n',
    'ring/ring_test.go': [
      'package ring', '', 'import "testing"', '',
      'func build(t testing.TB) *Ring {', '\treturn Make(8)', '}', '',
      '// @id TEST-A-001', 'func TestA001(t *testing.T) {', '\t_ = build(t)', '}', '',
    ].join('\n'),
  });
  const o2 = sdd(inPkg, 'tdd', 'stub', 'TEST-A-001').out;
  assert.match(fs.readFileSync(path.join(inPkg, 'ring/ring.go'), 'utf8'), /func Make\(a0 any\) \*Ring/);
  assert.match(o2, /compile-checked/, o2);
});

test('ExUnit tdd stub: a `use Mod` module gets a defmacro __using__/1 (also appended to an existing stub)', () => {
  const spec = '---\nfeature: a\ntier: T1\n---\n| REQ-A-001 | x shall hold. | TEST-A-001 |\n';
  const d = mini(spec, {
    'mix.exs': 'defmodule A.MixProject do\nend\n',
    'test/a_test.exs': ['defmodule ATest do', '  use ExUnit.Case', '  use A.Case', '', '  # @id TEST-A-001 @verifies REQ-A-001', '  test "TEST-A-001 x" do', '    assert A.Thing.run(1) == 2', '  end', 'end', ''].join('\n'),
  });
  sdd(d, 'tdd', 'stub', 'TEST-A-001');
  const c = fs.readFileSync(path.join(d, 'lib/a/case.ex'), 'utf8');
  assert.match(c, /defmodule A\.Case do/);
  assert.match(c, /defmacro __using__\(_opts\) do\n    quote do\n    end\n  end/);
  fs.writeFileSync(path.join(d, 'lib/a/case.ex'), 'defmodule A.Case do\n  def helper(_a1), do: raise("not implemented: helper")\nend\n');
  sdd(d, 'tdd', 'stub', 'TEST-A-001');
  assert.match(fs.readFileSync(path.join(d, 'lib/a/case.ex'), 'utf8'), /defmacro __using__\(_opts\)[\s\S]*end\n$/);
  assert.match(fs.readFileSync(path.join(d, 'lib/a/case.ex'), 'utf8'), /def helper/);
});

test('#236 C/C++ header-only implementation under include/ is not a test oracle; @oracle and test dirs still are', () => {
  const d = batch2Source('t.c', '#include "include/lib.h"\n#include "data/exp.h"\n// @id TEST-CALC-001 @verifies REQ-CALC-001\nvoid test_calc_001(void) { assert(twice(2) == EXPECTED); }\n');
  writeAll(d, { 'include/lib.h': 'static inline int twice(int n) { (void)n; return 0; }\n', 'data/exp.h': '#define EXPECTED 4\n' });
  fakeOut(d, 'AssertionError: twice');
  assert.equal(sdd(d, 'tdd', 'red', 'TEST-CALC-001').code, 0);
  fs.writeFileSync(path.join(d, 'include/lib.h'), 'static inline int twice(int n) { return n * 2; }\n');
  fakeOut(d, 'pass', 0);
  const g = sdd(d, 'tdd', 'green', 'TEST-CALC-001');
  assert.equal(g.code, 0, g.out);
  fs.writeFileSync(path.join(d, 'data/exp.h'), '#define EXPECTED 5\n');
  assert.match(sdd(d, 'tdd', 'green', 'TEST-CALC-001').out, /changed since Red/);
  fs.writeFileSync(path.join(d, 'data/exp.h'), '#define EXPECTED 4\n');
  fs.writeFileSync(path.join(d, 'include/lib.h'), '// @oracle\nstatic inline int twice(int n) { return n * 2; }\n');
  assert.match(sdd(d, 'tdd', 'green', 'TEST-CALC-001').out, /changed since Red/);
});

test('#236 C registration macros (`REG(fn);`) belong to the function they name, not to every sibling', () => {
  const src = (extra = '', reg = 'REG(test_calc_001);') => '#include <assert.h>\n// @id TEST-CALC-001 @verifies REQ-CALC-001\nvoid test_calc_001(void) { assert(1 == 2); }\n' + reg + '\n\n// @id TEST-CALC-002 @verifies REQ-CALC-001\nvoid test_calc_002(void) { assert(1 == 1); }\nREG(test_calc_002);\n' + extra;
  const d = batch2Source('t.c', src());
  fakeOut(d, 'Assertion failed: 1 == 2');
  assert.equal(sdd(d, 'tdd', 'red', 'TEST-CALC-001').code, 0);
  fakeOut(d, 'pass', 0);
  assert.equal(sdd(d, 'tdd', 'green', 'TEST-CALC-001').code, 0);
  fs.writeFileSync(path.join(d, 't.c'), src('\n// @id TEST-CALC-003 @verifies REQ-CALC-001\nvoid test_calc_003(void) { }\nREG(test_calc_003);\n\nint main(void) { return 0; }\n// trailing\n'));
  assert.doesNotMatch(sdd(d, 'gate', '--no-run').out, /TEST-CALC-001[^\n]*changed since last Green/);
  fs.writeFileSync(path.join(d, 't.c'), src('', 'REG(test_calc_001); REG2(x);'));
  fs.writeFileSync(path.join(d, 't.c'), src('', 'REGISTER(suite, test_calc_001);'));
  assert.match(sdd(d, 'gate', '--no-run').out, /TEST-CALC-001[^\n]*changed since last Green/);
});

test('#239 tdd refactor names a changed oracle dependency instead of claiming the test body changed', () => {
  const d = project();
  fs.writeFileSync(path.join(d, '.sdd/specs/calc.md'), fs.readFileSync(path.join(d, '.sdd/specs/calc.md'), 'utf8').replace('tier: T2', 'tier: T1'));
  fs.writeFileSync(path.join(d, 'helper.mjs'), 'export const one = 1;\n');
  fs.writeFileSync(path.join(d, 'add.test.mjs'), fs.readFileSync(path.join(d, 'add.test.mjs'), 'utf8').replace("import { add }", "import { one } from './helper.mjs';\nimport { add }").replace('add(1, 2)', 'add(one, 2)'));
  impl(d, '(a, b) => { throw new Error("nope"); }');
  sdd(d, 'tdd', 'red', 'TEST-CALC-001');
  impl(d, '(a, b) => a + b');
  assert.match(sdd(d, 'tdd', 'green', 'TEST-CALC-001').out, /GREEN ok/);
  fs.writeFileSync(path.join(d, 'helper.mjs'), 'export const one = 1; // edited\n');
  const r = sdd(d, 'tdd', 'refactor', 'TEST-CALC-001', '--wording', 'x').out;
  assert.match(r, /oracle dependency changed since the last Green: helper\.mjs/, r);
  assert.doesNotMatch(r, /test body changed/, r);
});

test('#238 `@data <path>` and config `oracleData` hash runtime data files (and directories) into the test oracle', () => {
  const d = batch2Source('tests/t.c', '// @data ../vectors/crc16.csv\n#include <assert.h>\n// @id TEST-CALC-001 @verifies REQ-CALC-001\nvoid test_calc_001(void) { assert(0); }\n');
  writeAll(d, { 'vectors/crc16.csv': '1,2\n', 'vectors2/a.csv': 'x\n' });
  fakeOut(d, 'Assertion failed: 0');
  assert.equal(sdd(d, 'tdd', 'red', 'TEST-CALC-001').code, 0);
  fakeOut(d, 'pass', 0);
  assert.equal(sdd(d, 'tdd', 'green', 'TEST-CALC-001').code, 0);
  assert.doesNotMatch(sdd(d, 'gate', '--no-run').out, /test changed since last Green/);
  fs.appendFileSync(path.join(d, 'vectors/crc16.csv'), '3,4\n');
  const g = sdd(d, 'gate', '--no-run').out;
  assert.match(g, /test changed since last Green\/Refactor — oracle dependency changed: vectors\/crc16\.csv/, g);
  fs.rmSync(path.join(d, 'vectors/crc16.csv'));
  assert.match(sdd(d, 'gate', '--no-run').out, /oracle dependency changed: vectors\/crc16\.csv/);
  fs.writeFileSync(path.join(d, 'vectors/crc16.csv'), '1,2\n');
  assert.doesNotMatch(sdd(d, 'gate', '--no-run').out, /test changed since last Green/);
  fakeOut(d, 'pass', 0, { oracleData: ['vectors2'] });
  assert.equal(sdd(d, 'tdd', 'refactor', 'TEST-CALC-001').code, 0);
  assert.doesNotMatch(sdd(d, 'gate', '--no-run').out, /test changed since last Green/);
  fs.writeFileSync(path.join(d, 'vectors2/b.csv'), 'y\n');
  assert.match(sdd(d, 'gate', '--no-run').out, /oracle dependency changed: vectors2/);
});

test('#237 a PHPUnit run does not outlive a killed sdd (watchdog kills its process group)', { skip: process.platform === 'win32' }, async () => {
  const d = batch2Source('T.php', '<?php\nclass Target {\n// @id TEST-CALC-001 @verifies REQ-CALC-001\npublic function test_calc_001(): void { }\n}\n');
  fs.writeFileSync(path.join(d, '.sdd/config.json'), JSON.stringify({ schemaVersion: 1, testCmd: ['sh', '-c', 'echo $$ > pid.txt; exec sleep 60', 'phpunit'], timeoutMs: 120000 }));
  const child = spawn('node', [SDD, '--root', d, 'tdd', 'red', 'TEST-CALC-001'], { stdio: 'ignore' });
  const pidFile = path.join(d, 'pid.txt');
  for (let i = 0; i < 50 && !fs.existsSync(pidFile); i++) await new Promise((r) => setTimeout(r, 100));
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  assert.ok(pid > 0);
  child.kill('SIGKILL');
  const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
  for (let i = 0; i < 50 && alive(); i++) await new Promise((r) => setTimeout(r, 100));
  const left = alive();
  if (left) process.kill(pid, 'SIGKILL');
  assert.equal(left, false);
});
test('#246 Elixir stub: multi-alias, alias-only empty module, umbrella sibling, pipe/keyword arity, test-local helper', () => {
  const spec = '---\nfeature: m\ntier: T1\n---\n| REQ-M-001 | a shall hold. | TEST-M-001 |\n| REQ-M-002 | b shall hold. | TEST-M-002 |\n| REQ-M-003 | c shall hold. | TEST-M-003 |\n';
  const mk = (n) => `  # @id TEST-M-00${n}\n  # @verifies REQ-M-00${n}\n`;
  const d = mini(spec, {
    'mix.exs': 'defmodule U.MixProject do\n  use Mix.Project\n  def project, do: [apps_path: "apps", deps: []]\nend\n',
    'apps/core/mix.exs': 'defmodule Core.MixProject do\n  use Mix.Project\n  def project, do: [app: :core, version: "0.1.0", deps: []]\nend\n',
    'apps/core/lib/store.ex': 'defmodule Core.Store do\n  def size(s), do: length(s)\nend\n',
    'apps/web/mix.exs': 'defmodule Web.MixProject do\n  use Mix.Project\n  def project, do: [app: :web, version: "0.1.0", deps: []]\nend\n',
    'apps/web/test/test_helper.exs': 'ExUnit.start()\n',
    'apps/web/test/m_test.exs': `defmodule MTest do\n  use ExUnit.Case\n  alias Raft.{Election, Log}\n  alias Web.Helper, as: H\n  defmodule Web.Helper do\n    def x, do: 1\n  end\n\n${mk(1)}  test "a" do\n    assert Election.f(Log.new()) == 1\n  end\n\n${mk(2)}  test "b" do\n    assert [1] |> Core.Store.size() == 1\n    assert Web.Client.new(1, "c", a: 1, b: 2) == 1\n    assert H.x() == 1\n  end\n\n${mk(3)}  test "c" do\n    assert Election.g(1) == 1\n  end\nend\n`,
  });
  fs.rmSync(path.join(d, 'package.json'));
  const r1 = sdd(d, 'tdd', 'stub', 'TEST-M-001'); assert.match(r1.out, /stubbed/, r1.out);
  const w = (f) => path.join(d, 'apps/web', f);
  assert.ok(fs.existsSync(w('lib/raft/election.ex')));
  assert.ok(fs.existsSync(w('lib/raft/log.ex')));
  assert.ok(!fs.existsSync(w('lib/raft.ex')));
  const r2 = sdd(d, 'tdd', 'stub', 'TEST-M-002');
  assert.ok(!fs.existsSync(w('lib/core/store.ex')), r2.out);
  assert.ok(!fs.existsSync(w('lib/web/helper.ex')), r2.out);
  assert.match(fs.readFileSync(w('lib/web/client.ex'), 'utf8'), /def new\(_a1, _a2, _a3\)/);
  sdd(d, 'tdd', 'stub', 'TEST-M-003');
  assert.match(fs.readFileSync(w('lib/raft/election.ex'), 'utf8'), /def g\(_a1\)/);
});

test('#247 Java stub: test-file upper-case field is not a class; chained .size() gets a list-like result', () => {
  const spec = '---\nfeature: s\ntier: T1\n---\n| REQ-S-001 | parse shall hold. | TEST-S-001 |\n';
  const d = mini(spec, {
    'pom.xml': '<project/>',
    'src/test/java/p/ParserTest.java': 'package p;\nimport java.nio.file.*;\nimport org.junit.jupiter.api.Test;\nimport static org.junit.jupiter.api.Assertions.*;\nclass ParserTest {\n  static final Path CONTRACT = Paths.get("c");\n  // @id TEST-S-001\n  // @verifies REQ-S-001\n  @Test void parses() throws Exception {\n    assertEquals(1, Parser.parse(Files.readString(CONTRACT.resolve("a.csv"))).size());\n  }\n}\n',
  });
  sdd(d, 'tdd', 'stub', 'TEST-S-001');
  assert.ok(!fs.existsSync(path.join(d, 'src/main/java/p/CONTRACT.java')));
  const o = sdd(d, 'tdd', 'stub', 'TEST-S-001').out; assert.match(fs.readdirSync(path.join(d, 'src/main/java/p')).join(), /Parser/, o); assert.match(fs.readFileSync(path.join(d, 'src/main/java/p/ParseResult.java'), 'utf8'), /ArrayList/);
});

test('#248 C stub: includes/build of a project subdirectory are searched, not only the repo root', { skip: spawnSync('which', ['cc']).status !== 0 }, () => {
  const spec = '---\nfeature: r\ntier: T1\n---\n| REQ-R-001 | f shall hold. | TEST-R-001 |\n';
  const d = mini(spec, {
    'c/CMakeLists.txt': 'project(c C)\n',
    'c/include/rx.h': '#pragma once\nint rx_f(int a);\n',
    'c/tests/t.c': '#include "rx.h"\n// @id TEST-R-001 @verifies REQ-R-001\nint main(void) { return rx_f(1) == 1 ? 0 : 1; }\n',
  });
  const out = sdd(d, 'tdd', 'stub', 'TEST-R-001').out;
  assert.doesNotMatch(out, /No such file/, out);
  assert.match(out, /compile-checked|nothing to stub/, out);
});

test('#244 weak Red: a stub reached through nested helpers is asserted when the result is asserted', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-js-'));
  fs.mkdirSync(path.join(d, '.sdd/specs'), { recursive: true });
  fs.writeFileSync(path.join(d, 'package.json'), '{}');
  spawnSync('git', ['init', '-q'], { cwd: d });
  fs.writeFileSync(path.join(d, '.sdd/specs/a.md'), T1SPEC);
  fs.writeFileSync(path.join(d, 'a.test.mjs'), "import assert from 'node:assert';\nimport { make } from './lib.mjs';\nfunction inner() {\n  return make();\n}\nfunction outer() {\n  const r = inner();\n  return r;\n}\n// @id TEST-A-001 @verifies REQ-A-001\ntest('TEST-A-001', () => {\n  const r = outer();\n  assert.equal(r.n, 1);\n});\n");
  fs.writeFileSync(path.join(d, 'lib.mjs'), "export function make() { throw new Error('not implemented: make'); }\n");
  sdd(d, 'init');
  setCmd(d, ['node', '-e', "const e=new Error('not implemented: make');e.stack='Error: '+e.message+'\\n    at x (a.test.mjs:4:1)';console.log(e.stack);process.exit(1)"]);
  const r = spawnSync('node', [SDD, '--root', d, 'tdd', 'red', 'TEST-A-001'], { encoding: 'utf8', env: ENV });
  assert.doesNotMatch(r.stdout, /setup call|\[weak\]/, r.stdout);
});

test('#245 Go: a goroutine panic aborting the test binary is a failing run, not "no test matched"', { skip: spawnSync('which', ['go']).status !== 0 }, () => {
  const spec = '---\nfeature: r\ntier: T1\n---\n| REQ-R-001 | F shall hold. | TEST-R-001 |\n';
  const d = mini(spec, {
    'go.mod': 'module r\n\ngo 1.21\n',
    'lib/lib.go': 'package lib\n\nfunc F() int { panic("not implemented") }\n',
    'lib/lib_test.go': 'package lib\n\nimport "testing"\n\n// @id TEST-R-001 @verifies REQ-R-001\nfunc TestTEST_R_001_goroutine(t *testing.T) {\n\tdone := make(chan int)\n\tgo func() { done <- F() }()\n\tif <-done != 1 {\n\t\tt.Fatal("x")\n\t}\n}\n',
  });
  fs.rmSync(path.join(d, 'package.json'));
  fs.rmSync(path.join(d, '.sdd/config.json'));
  sdd(d, 'init');
  sdd(d, 'approve', 'record', 'r', '--by', 'tester');
  const r = sdd(d, 'tdd', 'red', 'TEST-R-001');
  assert.doesNotMatch(r.out, /no test matched/, r.out);
  assert.match(r.out, /RED ok/, r.out);
});

test('#246 ExUnit Red excerpt comes from the target test failure block, not a compile-warning frame of another test', { skip: spawnSync('which', ['mix']).status !== 0 }, () => {
  const spec = '---\nfeature: w\ntier: T1\n---\n| REQ-W-001 | a shall hold. | TEST-W-001 |\n| REQ-W-002 | b shall hold. | TEST-W-002 |\n';
  const d = mini(spec, {
    'mix.exs': 'defmodule W.MixProject do\n  use Mix.Project\n  def project, do: [app: :w, version: "0.1.0", deps: []]\nend\n',
    'lib/w.ex': 'defmodule W do\n  def a, do: raise("nope")\n  def b, do: :ok\nend\n',
    'test/test_helper.exs': 'ExUnit.start()\n',
    'test/w_test.exs': 'defmodule WTest do\n  use ExUnit.Case\n\n  # @id TEST-W-001\n  # @verifies REQ-W-001\n  test "a" do\n    W.a()\n  end\n\n  # @id TEST-W-002\n  # @verifies REQ-W-002\n  test "b" do\n    assert W.b() == 2\n  end\nend\n',
  });
  fs.rmSync(path.join(d, 'package.json'));
  fs.rmSync(path.join(d, '.sdd/config.json'));
  sdd(d, 'init');
  sdd(d, 'approve', 'record', 'w', '--by', 'tester');
  const r = sdd(d, 'tdd', 'red', 'TEST-W-001');
  assert.match(r.out, /RED ok/, r.out);
  assert.doesNotMatch(r.out, /fails with:.*W\.b\(\) == 2/, r.out);
});

test('#246 review template and review check accept the feature positionally or via --feature', () => {
  const d = project();
  const t1 = sdd(d, 'review', 'template', 'calc');
  const t2 = sdd(d, 'review', 'template', '--feature', 'calc');
  assert.equal(t1.code, 0, t1.out);
  assert.equal(t2.out, t1.out);
  fs.writeFileSync(path.join(d, 'rv.md'), t1.out);
  const c1 = sdd(d, 'review', 'check', 'rv.md', '--feature', 'calc');
  const c2 = sdd(d, 'review', 'check', 'rv.md', 'calc');
  assert.equal(c2.out, c1.out);
  assert.doesNotMatch(c2.out, /usage|unknown feature/, c2.out);
});

test('#247 impact <data file> names the projects whose dependsOn covers it, not itself as impl', () => {
  const d = project();
  fs.mkdirSync(path.join(d, 'contract'), { recursive: true });
  fs.writeFileSync(path.join(d, 'contract/golden.csv'), 'a,b\n1,2\n');
  const cp = path.join(d, '.sdd/config.json');
  const c = fs.existsSync(cp) ? JSON.parse(fs.readFileSync(cp, 'utf8')) : {};
  c.projects = [{ root: 'core', dependsOn: ['./contract'], testCmd: ['true'], checks: [] }, { root: 'recon', dependsOn: ['contract/golden.csv'], testCmd: ['true'], checks: [] }, { root: 'other', testCmd: ['true'], checks: [] }];
  fs.writeFileSync(cp, JSON.stringify(c));
  const r = sdd(d, 'impact', 'contract/golden.csv');
  assert.doesNotMatch(r.out, /impl: contract/, r.out);
  assert.match(r.out, /dependent projects.*core, recon/, r.out);
  assert.doesNotMatch(r.out, /other/, r.out);
  const j = JSON.parse(sdd(d, 'impact', 'contract/golden.csv', '--json').out);
  assert.deepEqual(j.projects, ['core', 'recon']);
  assert.deepEqual(j.impl, []);
});

test('#245 Go: `if err := sut(); err != nil` treats the initialised call as asserted (not a weak setup Red)', { skip: spawnSync('which', ['go']).status !== 0 }, () => {
  const spec = '---\nfeature: r\ntier: T1\n---\n| REQ-R-001 | Import shall succeed. | TEST-R-001 |\n';
  const d = mini(spec, {
    'go.mod': 'module r\n\ngo 1.21\n',
    'lib/lib.go': 'package lib\n\ntype S struct{}\n\nfunc New() *S { return &S{} }\n\nfunc (s *S) Import(n int) error { panic("not implemented") }\n',
    'lib/lib_test.go': 'package lib\n\nimport "testing"\n\n// @id TEST-R-001 @verifies REQ-R-001\nfunc TestTEST_R_001(t *testing.T) {\n\tif err := New().Import(1); err != nil {\n\t\tt.Fatal(err)\n\t}\n}\n',
  });
  fs.rmSync(path.join(d, 'package.json'));
  fs.rmSync(path.join(d, '.sdd/config.json'));
  sdd(d, 'init');
  sdd(d, 'approve', 'record', 'r', '--by', 'tester');
  const r = sdd(d, 'tdd', 'red', 'TEST-R-001');
  assert.match(r.out, /RED ok/, r.out);
  assert.doesNotMatch(r.out, /setup call|\[weak\]/, r.out);
});

test('#251 weak Red: value derived from the stubbed call via a filtered comprehension is strong Red', () => {
  const spec = '---\nfeature: w\ntier: T1\napproval: auto\n---\n| REQ-W-001 | g shall triple. | TEST-W-001 |\n| REQ-W-002 | g shall triple. | TEST-W-002 |\n';
  const d = mini(spec, {
    'src/m.py': 'def g(xs):\n    raise NotImplementedError("g")\n',
    'tests/test_w.py': 'import sys\nsys.path.insert(0, "src")\nfrom m import g\n\n\n# @id TEST-W-001 @verifies REQ-W-001\ndef test_w_001():\n    o = g([1, 2])\n    s = {n for n in o}\n    assert s == {3, 6}\n\n\n# @id TEST-W-002 @verifies REQ-W-002\ndef test_w_002():\n    o = g([1, 2])\n    s = {n for n in o if isinstance(n, int)}\n    assert s == {3, 6}\n',
  });
  for (const id of ['TEST-W-001', 'TEST-W-002']) {
    const r = sdd(d, 'tdd', 'red', id);
    assert.match(r.out, /RED ok/, r.out);
    assert.doesNotMatch(r.out, /\[weak\]|setup call/, r.out);
  }
});

test('#252 an assertion/panic failure line outranks an incidental "No such file" LOAD_ERR match', () => {
  const d = mini(T1SPEC, { 'a.test.mjs': jsTest() }, ['sh', '-c', "printf \"thread 'x' panicked at tests/r.rs:4:5:\\nassertion \\`left == right\\` failed\\n  left: 0\\n right: 1\\nNo such file or directory\\n\"; exit 101"]);
  const r = sdd(d, 'tdd', 'red', 'TEST-A-001');
  assert.match(r.out, /RED ok/, r.out);
  assert.doesNotMatch(r.out, /\[weak\]|REJECTED/, r.out);
  setCmd(d, ['sh', '-c', 'echo "error: No such file or directory"; exit 1']);
  const f = path.join(d, 'a.test.mjs');
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('assert.ok(1)', 'assert.ok(2)'));
  assert.match(sdd(d, 'tdd', 'red', 'TEST-A-001').out, /REJECTED|weak/, 'genuine load error still rejected');
});

test('#249 tdd red --retest on 2+ tests updates only those tests and keeps other Red evidence', () => {
  const spec = '---\nfeature: a\ntier: T1\n---\n' + [1, 2, 3].map((n) => `| REQ-A-00${n} | r${n} shall hold. | TEST-A-00${n} |\n`).join('');
  const body = (a, b, c) => [a, b, c].map((v, i) => `// @id TEST-A-00${i + 1} @verifies REQ-A-00${i + 1}\ntest('TEST-A-00${i + 1} x', () => {\n  assert.ok(${v});\n});\n`).join('');
  const d = mini(spec, { 'a.test.mjs': body(1, 1, 1) }, FAIL);
  sdd(d, 'approve', 'record', 'a', '--by', 'tester');
  const ids = ['TEST-A-001', 'TEST-A-002', 'TEST-A-003'];
  assert.equal(sdd(d, 'tdd', 'red', ...ids).code, 0);
  setCmd(d, PASS);
  assert.equal(sdd(d, 'tdd', 'green', ...ids).code, 0);
  fs.writeFileSync(path.join(d, 'a.test.mjs'), body(2, 3, 1));
  const r = sdd(d, 'tdd', 'red', ...ids, '--retest', 'expectation was wrong');
  assert.equal((r.out.match(/RED ok/g) ?? []).length, 2, r.out);
  assert.match(r.out, /REFUSED.*TEST-A-003.*unchanged|REFUSED.*unchanged/, r.out);
  sdd(d, 'tdd', 'green', 'TEST-A-001', 'TEST-A-002');
  const g = sdd(d, 'gate', '--no-run').out;
  assert.match(g, /3\/3 tests Red→Green, 2 weak Red/, g);
  const led = fs.readFileSync(path.join(d, '.sdd/tdd.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(led.filter((e) => e.test === 'TEST-A-003').length, 2);
  assert.equal(led.filter((e) => e.type === 'red' && !e.weak).length, 3);
});

test('#241 gate --changed: dependsOn is transitive across projects', () => {
  const d = mini('---\nfeature: r\ntier: T1\n---\n| REQ-R-001 | x shall work. | TEST-R-001 |\n', { 'contract/c.json': '{}', 'lib/a.txt': 'a', 'app/b.txt': 'b' });
  const cp = path.join(d, '.sdd/config.json');
  const c = JSON.parse(fs.readFileSync(cp, 'utf8'));
  c.projects = [
    { root: 'lib', dependsOn: ['contract'], testCmd: ['true'], checks: [{ name: 'test', cmd: ['true'] }] },
    { root: 'app', dependsOn: ['lib'], testCmd: ['true'], checks: [{ name: 'test', cmd: ['true'] }] },
  ];
  fs.writeFileSync(cp, JSON.stringify(c));
  spawnSync('git', ['add', '-A'], { cwd: d });
  spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'i'], { cwd: d });
  fs.writeFileSync(path.join(d, 'contract/c.json'), '{"a":1}');
  const r = sdd(d, 'gate', '--changed');
  assert.doesNotMatch(r.out, /cmd app:test: no changed files/, r.out);
  assert.doesNotMatch(r.out, /cmd lib:test: no changed files/, r.out);
});

test('#242 impact traverses non-code artifacts declared in config.artifacts', () => {
  const spec = '---\nfeature: r\ntier: T1\n---\n| REQ-R-001 | x shall work. | TEST-R-001 |\n';
  const d = mini(spec, { 'contract/c.json': '{"a":1}', 'src/a.ts': '// @id CODE-R-001 @implements REQ-R-001\nexport const a = 1;\n' });
  const cp = path.join(d, '.sdd/config.json');
  const c = JSON.parse(fs.readFileSync(cp, 'utf8'));
  c.artifacts = { 'contract/c.json': ['src/a.ts'] };
  fs.writeFileSync(cp, JSON.stringify(c));
  const j = JSON.parse(sdd(d, 'impact', 'contract/c.json', '--json').out);
  assert.ok(j.reachedFiles.includes('src/a.ts'), JSON.stringify(j));
});

test('#253 ExUnit: appending a test after the last test does not stale it', () => {
  const src = (extra = '') => `defmodule ATest do\n  use ExUnit.Case\n\n  # @id TEST-CALC-001 @verifies REQ-CALC-001\n  test "one" do\n    assert 1 == 2\n  end\n${extra}end\n`;
  const d = batch2Source('test/a_test.exs', src());
  writeAll(d, { 'mix.exs': 'defmodule A.MixProject do\nend\n' });
  fakeOut(d, 'Failure');
  assert.equal(sdd(d, 'tdd', 'red', 'TEST-CALC-001').code, 0);
  fakeOut(d, 'pass', 0);
  writeAll(d, { 'test/a_test.exs': src() });
  assert.equal(sdd(d, 'tdd', 'green', 'TEST-CALC-001').code, 0);
  writeAll(d, { 'test/a_test.exs': src('\n  # @id TEST-CALC-002 @verifies REQ-CALC-001\n  test "two" do\n    assert 2 == 2\n  end\n') });
  const r = sdd(d, 'tdd', 'green', 'TEST-CALC-001');
  assert.doesNotMatch(r.out, /changed since/, r.out);
});

test('#259 C++ raw string literals do not break per-test hash isolation', () => {
  const src = (bodyB) => `#include <string>\n// @id TEST-CALC-001 @verifies REQ-CALC-001\nTESTCASE(one) {\n  const std::string s = R"({"a":"x\\"y"})";\n  CHECK(!s.empty());\n}\n// @id TEST-CALC-002 @verifies REQ-CALC-001\nTESTCASE(two) {\n  CHECK(1);${bodyB}\n}\n`;
  const d = batch2Source('t.cpp', src(''));
  fakeOut(d, 'Failure');
  assert.equal(sdd(d, 'tdd', 'red', 'TEST-CALC-001').code, 0);
  fakeOut(d, 'pass', 0);
  writeAll(d, { 't.cpp': src(' CHECK(2);') });
  const r = sdd(d, 'tdd', 'green', 'TEST-CALC-001');
  assert.equal(r.code, 0, r.out);
});

const gitC = (d, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: d, encoding: 'utf8' });

test('#254 gate --changed --baseline <ref> diffs committed changes; bad ref is an error', () => {
  const spec = '---\nfeature: r\ntier: T1\n---\n| REQ-R-001 | x shall work. | TEST-R-001 |\n';
  const d = mini(spec, { 'contract/c.json': '{}', 'src/a.test.ts': '// @id TEST-R-001 @verifies REQ-R-001\n' });
  const cp = path.join(d, '.sdd/config.json');
  const c = JSON.parse(fs.readFileSync(cp, 'utf8'));
  c.artifacts = { 'contract/c.json': ['src/a.test.ts'] };
  fs.writeFileSync(cp, JSON.stringify(c));
  gitC(d, 'add', '-A'); gitC(d, 'commit', '-qm', 'i');
  fs.writeFileSync(path.join(d, 'contract/c.json'), '{"a":1}');
  gitC(d, 'commit', '-qam', 'edit');
  const r = sdd(d, 'gate', '--changed', '--baseline', 'HEAD~1', '--no-run');
  assert.doesNotMatch(r.out, /changed scope\): 0\/0/, r.out);
  const bad = sdd(d, 'gate', '--changed', '--baseline', 'nope-ref', '--no-run');
  assert.equal(bad.code, 2, bad.out);
  assert.match(bad.out, /baseline/, bad.out);
});

test('#254 gate --changed: contract-only edit puts artifact consumers in scope', () => {
  const spec = '---\nfeature: r\ntier: T1\n---\n| REQ-R-001 | x shall work. | TEST-R-001 |\n';
  const d = mini(spec, { 'contract/c.json': '{}', 'src/a.test.ts': '// @id TEST-R-001 @verifies REQ-R-001\n' });
  const cp = path.join(d, '.sdd/config.json');
  const c = JSON.parse(fs.readFileSync(cp, 'utf8'));
  c.artifacts = { 'contract/c.json': ['src/a.test.ts'] };
  fs.writeFileSync(cp, JSON.stringify(c));
  gitC(d, 'add', '-A'); gitC(d, 'commit', '-qm', 'i');
  fs.writeFileSync(path.join(d, 'contract/c.json'), '{"a":1}');
  const r = sdd(d, 'gate', '--changed', '--no-run');
  assert.doesNotMatch(r.out, /changed scope\): 0\/0/, r.out);
});

test('#255 impact on a non-code artifact: no "same feature" bucket', () => {
  const spec = '---\nfeature: api\ntier: T1\n---\n| REQ-API-001 | x shall work. | TEST-API-001 |\n';
  const d = mini(spec, { 'contract/api.json': '{}', 'src/api.ts': '// @id CODE-API-001 @implements REQ-API-001\nexport const a = 1;\n', 'src/api.test.ts': '// @id TEST-API-001 @verifies REQ-API-001\nimport "./api";\n' });
  const cp = path.join(d, '.sdd/config.json');
  const c = JSON.parse(fs.readFileSync(cp, 'utf8'));
  c.artifacts = { 'contract/api.json': ['src/api.ts'] };
  fs.writeFileSync(cp, JSON.stringify(c));
  const r = sdd(d, 'impact', 'contract/api.json');
  assert.doesNotMatch(r.out, /same feature/, r.out);
  assert.match(r.out, /REQ-API-001/, r.out);
});

test('#255 impact on a data file lists transitive dependent projects', () => {
  const d = mini('---\nfeature: r\ntier: T1\n---\n| REQ-R-001 | x shall work. | TEST-R-001 |\n', { 'contract/g.json': '{}', 'lib/a.txt': 'a', 'app/b.txt': 'b' });
  const cp = path.join(d, '.sdd/config.json');
  const c = JSON.parse(fs.readFileSync(cp, 'utf8'));
  c.projects = [{ root: 'lib', dependsOn: ['contract'], testCmd: ['true'], checks: [] }, { root: 'app', dependsOn: ['lib'], testCmd: ['true'], checks: [] }];
  fs.writeFileSync(cp, JSON.stringify(c));
  const j = JSON.parse(sdd(d, 'impact', 'contract/g.json', '--json').out);
  assert.deepEqual([...j.projects].sort(), ['app', 'lib'], JSON.stringify(j));
});

const ex256Spec = '---\nfeature: e\ntier: T1\n---\n| REQ-E-001 | parse shall hold. | TEST-E-001 |\n| REQ-E-002 | helper shall hold. | TEST-E-002 |\n| REQ-E-003 | json shall hold. | TEST-E-003 |\n';
const ex256 = (extra = {}) => ({
  'mix.exs': exFiles['mix.exs'],
  'test/test_helper.exs': 'ExUnit.start()\n',
  'lib/d/calc.ex': '# @id CODE-E-001-STUB-001 @implements REQ-E-001\ndefmodule D.Calc do\n  def parse(_a1), do: raise("not implemented: parse")\n  def new(_a1), do: raise("not implemented: new")\n  def other(_a1), do: 1\n  def from_json(_a1), do: raise(\"not implemented: from_json\")\nend\n',
  'test/d_test.exs': 'defmodule DTest do\n  use ExUnit.Case\n  alias D.Calc\n\n  # @id TEST-E-001\n  # @verifies REQ-E-001\n  test "parse" do\n    assert {:ok, 1} = Calc.parse("1")\n  end\n\n  # @id TEST-E-002\n  # @verifies REQ-E-002\n  test "helper" do\n    room()\n    assert Calc.other(2) == 1\n  end\n\n  # @id TEST-E-003\n  # @verifies REQ-E-003\n  test "json" do\n    path = Path.join("test", "test_helper.exs")\n    assert {:ok, %{type: "D"}} = Calc.from_json(File.read!(path))\n  end\n\n  defp room, do: Calc.new(1)\nend\n',
  ...extra,
});

test('#256 ExUnit: pattern-match assert on the subject is not a setup Red; helper setup Red is weak; --expect naming the setup call stays weak', { skip: !HAS_MIX }, () => {
  const d = mini(ex256Spec, ex256(), ['mix', 'test', '{file}']);
  const a = sdd(d, 'tdd', 'red', 'TEST-E-001');
  assert.match(a.out, /RED ok/, a.out);
  assert.doesNotMatch(a.out, /\[weak\]/, a.out);
  const b = sdd(d, 'tdd', 'red', 'TEST-E-002');
  assert.match(b.out, /setup call "new"/, b.out);
  const c = sdd(d, 'tdd', 'red', 'TEST-E-002', '--expect', 'not implemented: new');
  assert.match(c.out, /setup call "new"/, c.out);
  const f = sdd(d, 'tdd', 'red', 'TEST-E-003');
  assert.match(f.out, /RED ok/, f.out);
  assert.doesNotMatch(f.out, /\[weak\]/, f.out);
  const e = sdd(d, 'tdd', 'red', 'TEST-E-002', '--expect', 'not implemented');
  assert.doesNotMatch(e.out, /setup call/, e.out);
});

test('#257 TS stub: a value stub for an imported class is upgraded on re-run; instance .apply() is stubbed', () => {
  const spec = '---\nfeature: r\ntier: T1\n---\n| REQ-R-001 | x shall work. | TEST-R-001 |\n| REQ-R-002 | y shall work. | TEST-R-002 |\n';
  const imp = 'import { Rep, LWW } from "../src/rep.ts";\n';
  const d = mini(spec, { 'test/a.test.ts': `${imp}/** @id TEST-R-001 @verifies REQ-R-001 */\ntest("a", () => { const r = new Rep(); r.apply(1); });\n`, 'src/rep.ts': 'export class Rep {\n  constructor(..._args: any[]) {}\n}\n\nexport const LWW: any = undefined;\n' });
  sdd(d, 'tdd', 'stub', 'TEST-R-001');
  assert.match(fs.readFileSync(path.join(d, 'src/rep.ts'), 'utf8'), /apply\(\.\.\._args/);
  fs.appendFileSync(path.join(d, 'test/a.test.ts'), '/** @id TEST-R-002 @verifies REQ-R-002 */\ntest("b", () => { new LWW(1).merge(2); });\n');
  sdd(d, 'tdd', 'stub', 'TEST-R-002');
  const s = fs.readFileSync(path.join(d, 'src/rep.ts'), 'utf8');
  assert.match(s, /export class LWW/, s);
  assert.doesNotMatch(s, /LWW: any = undefined/, s);
  assert.match(s, /merge\(\.\.\._args/, s);
});

test('#257 ExUnit stub: path-dep modules are not shadowed; %Mod{} gets defstruct; a new arity of a stubbed name is added', { skip: !HAS_MIX }, () => {
  const spec = '---\nfeature: e\ntier: T1\n---\n| REQ-E-001 | x shall hold. | TEST-E-001 |\n| REQ-E-002 | y shall hold. | TEST-E-002 |\n';
  const d = mini(spec, {
    'store/mix.exs': 'defmodule S.MixProject do\n  use Mix.Project\n  def project, do: [app: :s, version: "0.1.0", deps: []]\nend\n',
    'store/lib/s/mem.ex': 'defmodule S.Mem do\n  def put(a, b), do: {a, b}\nend\n',
    'app/mix.exs': 'defmodule A.MixProject do\n  use Mix.Project\n  def project, do: [app: :a, version: "0.1.0", deps: [{:s, path: "../store"}]]\nend\n',
    'app/test/test_helper.exs': 'ExUnit.start()\n',
    'app/test/a_test.exs': 'defmodule ATest do\n  use ExUnit.Case\n  alias S.Mem\n  alias A.Ev\n\n  # @id TEST-E-001\n  # @verifies REQ-E-001\n  test "x" do\n    assert {1, 2} = Mem.put(1, 2)\n    assert %Ev{id: 1, kind: "k"} = Ev.make(1)\n  end\nend\n',
  }, ['mix', 'test', '{file}']);
  sdd(d, 'tdd', 'stub', 'TEST-E-001');
  assert.ok(!fs.existsSync(path.join(d, 'app/lib/s/mem.ex')), 'path dep module must not be stubbed');
  const ev = fs.readFileSync(path.join(d, 'app/lib/a/ev.ex'), 'utf8');
  assert.match(ev, /defstruct \[:id, :kind\]/, ev);
  assert.match(ev, /def make\(_a1\)/, ev);
  fs.appendFileSync(path.join(d, 'app/test/a_test.exs'), '');
  const t = fs.readFileSync(path.join(d, 'app/test/a_test.exs'), 'utf8').replace(/end\n$/, '\n  # @id TEST-E-002\n  # @verifies REQ-E-002\n  test "y" do\n    assert Ev.make(1, 2) == nil\n  end\nend\n');
  fs.writeFileSync(path.join(d, 'app/test/a_test.exs'), t);
  sdd(d, 'tdd', 'stub', 'TEST-E-002');
  const ev2 = fs.readFileSync(path.join(d, 'app/lib/a/ev.ex'), 'utf8');
  assert.match(ev2, /def make\(_a1\)/, ev2);
  assert.match(ev2, /def make\(_a1, _a2\)/, ev2);
});

test('#258 gate --help prints usage and does not run the gate', () => {
  const d = mini('---\nfeature: r\ntier: T1\n---\n| REQ-R-001 | x shall work. | TEST-R-001 |\n');
  const r = sdd(d, 'gate', '--help');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /usage: gate/, r.out);
  assert.doesNotMatch(r.out, /SDD GATE/, r.out);
});

test('#258 trace --verbose lists every warning', () => {
  const rows = Array.from({ length: 9 }, (_, i) => `| REQ-R-00${i + 1} | x shall work. | TEST-R-00${i + 1} |`).join('\n');
  const d = mini(`---\nfeature: r\ntier: T1\n---\n${rows}\n`);
  const brief = sdd(d, 'trace').out;
  const full = sdd(d, 'trace', '--verbose').out;
  assert.match(brief, /more/, brief);
  assert.doesNotMatch(full, /… \+\d+ more/, full);
  assert.ok(full.split('\n').length > brief.split('\n').length, full);
});

test('#258 tdd red without testCmd gives a clear error, not a crash', () => {
  const d = mini('---\nfeature: r\ntier: T1\n---\n| REQ-R-001 | x shall work. | TEST-R-001 |\n', { 'a.test.mjs': '// @id TEST-R-001 @verifies REQ-R-001\nimport {test} from "node:test";\ntest("TEST-R-001 x", () => {});\n' });
  const cp = path.join(d, '.sdd/config.json');
  const c = JSON.parse(fs.readFileSync(cp, 'utf8'));
  delete c.testCmd;
  fs.writeFileSync(cp, JSON.stringify(c));
  const r = sdd(d, 'tdd', 'red', 'TEST-R-001');
  assert.doesNotMatch(r.out, /TypeError|at .*sdd\.mjs/, r.out);
  assert.match(r.out, /no testCmd/, r.out);
});

test('#258 gate: a check that ran zero tests does not claim tests were skipped', () => {
  const d = mini('---\nfeature: r\ntier: T1\n---\n| REQ-R-001 | x shall work. | TEST-R-001 |\n');
  const cp = path.join(d, '.sdd/config.json');
  const c = JSON.parse(fs.readFileSync(cp, 'utf8'));
  c.checks = [{ name: 'test', cmd: ['node', '-e', 'console.log("No tests found")'] }];
  fs.writeFileSync(cp, JSON.stringify(c));
  const r = sdd(d, 'gate');
  assert.match(r.out, /cmd test: /, r.out);
  assert.doesNotMatch(r.out, /all tests skipped/, r.out);
  assert.match(r.out, /no tests (found|ran)/i, r.out);
});

test('#261 Elixir stub: stdlib JSON is never stubbed; stub defstruct grows with later keys', () => {
  const spec = '---\nfeature: j\ntier: T1\n---\n| REQ-J-001 | a shall hold. | TEST-J-001 |\n| REQ-J-002 | b shall hold. | TEST-J-002 |\n';
  const mk = (n) => `  # @id TEST-J-00${n}\n  # @verifies REQ-J-00${n}\n`;
  const d = mini(spec, {
    'mix.exs': 'defmodule J.MixProject do\n  use Mix.Project\n  def project, do: [app: :j, version: "0.1.0", deps: []]\nend\n',
    'test/test_helper.exs': 'ExUnit.start()\n',
    'test/j_test.exs': `defmodule JTest do\n  use ExUnit.Case\n  alias J.Def\n\n${mk(1)}  test "a" do\n    assert JSON.decode("[1]") == {:ok, [1]}\n    assert %Def{name: 1} = Def.make()\n  end\n\n${mk(2)}  test "b" do\n    assert %Def{name: 1, version: 2, states: 3} = Def.make()\n  end\n`.concat('end\n'),
  });
  fs.rmSync(path.join(d, 'package.json'), { force: true });
  sdd(d, 'tdd', 'stub', 'TEST-J-001');
  assert.ok(!fs.existsSync(path.join(d, 'lib/json.ex')));
  const f = path.join(d, 'lib/j/def.ex');
  assert.match(fs.readFileSync(f, 'utf8'), /defstruct \[:name\]/);
  sdd(d, 'tdd', 'stub', 'TEST-J-002');
  assert.match(fs.readFileSync(f, 'utf8'), /defstruct \[:name, :version, :states\]/);
});

test('#260 Rust stub adds missing const/fn to an existing module', { skip: spawnSync('which', ['cargo']).status !== 0 }, () => {
  const spec = '---\nfeature: h\ntier: T1\n---\n| REQ-H-001 | a shall hold. | TEST-H-001 |\n';
  const d = mini(spec, {
    'Cargo.toml': '[package]\nname = "repro"\nversion = "0.1.0"\nedition = "2021"\n',
    'src/lib.rs': 'pub mod hash;\n',
    'src/hash.rs': 'pub fn other() {}\n',
    'tests/h_test.rs': 'use repro::hash::{GENESIS, fnv};\n\n// @id TEST-H-001\n// @verifies REQ-H-001\n#[test]\nfn test_h_001() {\n    assert_eq!(GENESIS.len(), 16);\n    assert_eq!(fnv(""), "x");\n}\n',
  });
  fs.rmSync(path.join(d, 'package.json'), { force: true });
  sdd(d, 'tdd', 'stub', 'TEST-H-001');
  const h = fs.readFileSync(path.join(d, 'src/hash.rs'), 'utf8');
  assert.match(h, /pub const GENESIS: &str/, h);
  assert.match(h, /pub fn fnv/, h);
  assert.match(h, /pub fn other/);
});

test('#262 Python stub: a class used in pytest.raises by another test is an Exception subclass', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-pyexc2-'));
  spawnSync('git', ['init', '-q'], { cwd: d });
  fs.mkdirSync(path.join(d, '.sdd/specs'), { recursive: true });
  fs.mkdirSync(path.join(d, 'tests'));
  fs.writeFileSync(path.join(d, 'tests/test_r.py'), 'import pytest\nfrom rp.schema import Schema, VErr\n\n# @id TEST-RP-001\n# @verifies REQ-RP-001\ndef test_rp_001():\n    assert Schema.load().name == "x"\n\n# @id TEST-RP-002\n# @verifies REQ-RP-002\ndef test_rp_002():\n    with pytest.raises(VErr):\n        Schema.load().validate({})\n');
  sdd(d, 'init');
  sdd(d, 'tdd', 'stub', 'TEST-RP-001');
  assert.match(fs.readFileSync(path.join(d, 'rp/schema.py'), 'utf8'), /class VErr\(Exception\)/);
});

// ---- wave 9 (#263): one weak-Red rule across languages ----
const weak263 = (body, out, name = 'add.test.mjs', file) => {
  const d = approved();
  if (file) { if (name !== 'add.test.mjs') fs.rmSync(path.join(d, 'add.test.mjs')); fs.writeFileSync(path.join(d, name), file); }
  else testFile(d, body);
  fakeOut(d, out);
  return sdd(d, 'tdd', 'red', 'TEST-CALC-001', ...(weak263.args ?? []));
};

test('#263 Rust import alias: the aliased subject is the asserted call, not a setup call', () => {
  const r = weak263(['  // use fscore::encoding::delta::{encode as delta_encode};', '  assert.equal(delta_encode(1), 2);'], "thread 'x' panicked at src/delta.rs:3:5:\nnot implemented: delta::encode\n");
  assert.match(r.out, /RED ok/, r.out);
  assert.doesNotMatch(r.out, /\[weak\]|setup call/, r.out);
});

test('#263 Java: a local holding the asserted SUT result is not setup', () => {
  const r = weak263(['  String h = Entry.computeHash(1);', '  assertEquals("lit", h);'], 'java.lang.UnsupportedOperationException: not implemented: computeHash\n');
  assert.doesNotMatch(r.out, /\[weak\]|setup call/, r.out);
});

test('#263 Go: a stub called in an if/for condition that gates the failure is the act', () => {
  const out = '--- FAIL: TestCalc (0.00s)\npanic: nyi: Allow [recovered]\n\ngoroutine 7 [running]:\nexample.com/x.(*B).Allow(...)\n\t/x/calc.go:3 +0x1\nexample.com/x.TestCalc(0xc0)\n\t/x/add.test.mjs:7 +0x2\n';
  const r = weak263(['  b := make()', '  if !b.Allow() {', '    t.Error("denied")', '  }'], out);
  assert.doesNotMatch(r.out, /\[weak\]|setup call/, r.out);
  const q = weak263(['  b := make()', '  for b.Allow() {', '  }', '  assert.equal(b.n, 3)'], out);
  assert.doesNotMatch(q.out, /\[weak\]|setup call/, q.out);
});

test('#263 ExUnit: a failure inside a defp helper called before the assertion is weak, like the inline setup call', () => {
  const ex = (call) => `defmodule T do\n  use ExUnit.Case\n  # @id TEST-CALC-001\n  # @verifies REQ-CALC-001\n  test "a" do\n${call}\n    assert Log.entries(l) == []\n  end\n\n  defp filled(n) do\n    Log.new(n)\n  end\nend\n`;
  const out = 'not implemented: new\n';
  const a = weak263(null, out, 'add.test.exs', ex('    l = filled(1)'));
  assert.match(a.out, /\[weak\].*setup call "new"/, a.out);
  const b = weak263(null, out, 'add.test.exs', ex('    l = Log.new(1)'));
  assert.match(b.out, /\[weak\].*setup call "new"/, b.out);
});

test('#264 config artifacts consumed by a test are part of its oracle: edit between Red and Green is refused, after Green it stales the gate', () => {
  const spec = '---\nfeature: a\ntier: T1\n---\n| REQ-A-001 | x shall hold. | TEST-A-001 |\n';
  const d = mini(spec, { 'a.test.mjs': '// @id TEST-A-001 @verifies REQ-A-001\n// body\n', 'contract/vec.json': '[1]\n' }, FAIL);
  const cp = path.join(d, '.sdd/config.json');
  const c = JSON.parse(fs.readFileSync(cp, 'utf8'));
  c.artifacts = { 'contract/vec.json': ['a.test.mjs'] };
  fs.writeFileSync(cp, JSON.stringify(c));
  assert.equal(sdd(d, 'tdd', 'red', 'TEST-A-001').code, 0);
  fs.writeFileSync(path.join(d, 'contract/vec.json'), '[1,2]\n');
  setCmd(d, PASS);
  const refused = sdd(d, 'tdd', 'green', 'TEST-A-001');
  assert.match(refused.out, /REFUSED[^\n]*contract\/vec\.json/, refused.out);
  fs.writeFileSync(path.join(d, 'contract/vec.json'), '[1]\n');
  assert.equal(sdd(d, 'tdd', 'green', 'TEST-A-001').code, 0);
  fs.writeFileSync(path.join(d, 'contract/vec.json'), '[1,3]\n');
  assert.match(sdd(d, 'gate', '--no-run').out, /oracle dependency changed: contract\/vec\.json/);
});

test('#265 green refusal names the replaced support file and hints the missing @id CODE annotation', () => {
  const spec = '---\nfeature: a\ntier: T1\n---\n| REQ-A-001 | x shall hold. | TEST-A-001 |\n';
  const d = mini(spec, { 'a.test.mjs': "import { s } from './helper.mjs';\n// @id TEST-A-001 @verifies REQ-A-001\n// body\n", 'helper.mjs': '// @id CODE-A-001-STUB @implements REQ-A-001\nexport const s = 0;\n' }, FAIL);
  assert.equal(sdd(d, 'tdd', 'red', 'TEST-A-001').code, 0);
  fs.writeFileSync(path.join(d, 'helper.mjs'), 'export const s = 1;\n');
  setCmd(d, PASS);
  const out = sdd(d, 'tdd', 'green', 'TEST-A-001').out;
  assert.match(out, /REFUSED[^\n]*oracle dependency changed: helper\.mjs/, out);
  assert.match(out, /@id CODE-/, out);
});

test('#264 tdd green warns when a shared implementation file changed after a sibling REQ was Green', () => {
  const spec = '---\nfeature: a\ntier: T1\n---\n| REQ-A-001 | x shall hold. | TEST-A-001 |\n| REQ-A-002 | y shall hold. | TEST-A-002 |\n';
  const d = mini(spec, { 'a.test.mjs': '// @id TEST-A-001 @verifies REQ-A-001\n// one\n// @id TEST-A-002 @verifies REQ-A-002\n// two\n', 'impl.mjs': '// @id CODE-A-001 @implements REQ-A-001 REQ-A-002\nexport const v = 0;\n' }, FAIL);
  assert.equal(sdd(d, 'tdd', 'red', 'TEST-A-001').code, 0);
  assert.equal(sdd(d, 'tdd', 'red', 'TEST-A-002').code, 0);
  setCmd(d, PASS);
  assert.doesNotMatch(sdd(d, 'tdd', 'green', 'TEST-A-001').out, /shared with other REQs/);
  const later = new Date(Date.now() + 5000);
  fs.writeFileSync(path.join(d, 'impl.mjs'), '// @id CODE-A-001 @implements REQ-A-001 REQ-A-002\nexport const v = 1;\n');
  fs.utimesSync(path.join(d, 'impl.mjs'), later, later);
  const out = sdd(d, 'tdd', 'green', 'TEST-A-002').out;
  assert.match(out, /shared with other REQs[^\n]*TEST-A-001/, out);
});

test('#266 impact on a contract file reaches REQs of transitively dependent projects (dependsOn closure)', () => {
  const spec = '---\nfeature: r\ntier: T1\n---\n| REQ-R-001 | x shall work. | TEST-R-001 |\n';
  const d = mini(spec, { 'contract/g.json': '{}', 'lib/a.ts': '// @id CODE-R-001 @implements REQ-R-001\nexport const a = 1;\n' });
  const cp = path.join(d, '.sdd/config.json');
  const c = JSON.parse(fs.readFileSync(cp, 'utf8'));
  c.projects = [{ root: 'lib', dependsOn: ['contract'], testCmd: ['true'], checks: [] }];
  fs.writeFileSync(cp, JSON.stringify(c));
  const r = sdd(d, 'impact', 'contract/g.json');
  assert.match(r.out, /REQ-R-001/, r.out);
});

test('#266 impact: config parity pair links two implementations of one algorithm', () => {
  const d = mini('---\nfeature: a\ntier: T1\n---\n| REQ-A-001 | x shall work. | TEST-A-001 |\n', {
    '.sdd/specs/b.md': '---\nfeature: b\ntier: T1\n---\n| REQ-B-001 | y shall work. | TEST-B-001 |\n',
    'rs/hash.rs': '// @id CODE-A-001 @implements REQ-A-001\nfn h() {}\n',
    'ex/hash.ex': '# @id CODE-B-001 @implements REQ-B-001\ndefmodule H do\nend\n',
  });
  const cp = path.join(d, '.sdd/config.json');
  const c = JSON.parse(fs.readFileSync(cp, 'utf8'));
  c.parity = [['rs/hash.rs', 'ex/hash.ex']];
  fs.writeFileSync(cp, JSON.stringify(c));
  const r = sdd(d, 'impact', 'rs/hash.rs');
  assert.match(r.out, /REQ-B-001/, r.out);
});

test('#266 impact REQ-X with only a bare comment hints at the missing @implements marker', () => {
  const d = mini('---\nfeature: r\ntier: T1\n---\n| REQ-R-001 | x shall work. | TEST-R-001 |\n', { 'src/a.ts': '// REQ-R-001\nexport const a = 1;\n' });
  const r = sdd(d, 'impact', 'REQ-R-001');
  assert.match(r.out, /bare comment/, r.out);
});

// ---- wave 10 (#268): Rust stub gaps ----
const rs268 = (files, ids = ['TEST-H-001']) => {
  const spec = '---\nfeature: h\ntier: T1\n---\n' + ids.map((_, i) => `| REQ-H-00${i + 1} | a shall hold. | TEST-H-00${i + 1} |\n`).join('');
  const d = mini(spec, { 'Cargo.toml': '[package]\nname = "hist"\nversion = "0.1.0"\nedition = "2021"\n', ...files });
  fs.rmSync(path.join(d, 'package.json'), { force: true });
  return d;
};
const has268 = { skip: spawnSync('which', ['cargo']).status !== 0 };

test('#268 Rust stub: a method needed by a later test is appended to the existing stub impl', has268, () => {
  const t = (n, body) => `// @id TEST-H-00${n} @verifies REQ-H-00${n}\n#[test]\nfn test_h_00${n}() {\n${body}\n}\n`;
  const d = rs268({
    'src/lib.rs': 'pub mod histogram;\n',
    'src/histogram.rs': '#[derive(Debug, Clone, Default, PartialEq)]\npub struct Histogram;\n\nimpl Histogram {\n    pub fn equi_width<A0, A1>(_a0: A0, _a1: A1) -> Self {\n        unimplemented!("Histogram::equi_width")\n    }\n\n    pub fn bucket_count(&self) -> i64 {\n        unimplemented!("Histogram::bucket_count")\n    }\n}\n',
    'tests/h.rs': 'use hist::histogram::Histogram;\n\n' + t(1, '    let h = Histogram::equi_width(&[1.0], 2);\n    assert_eq!(h.bucket_count(), 2);') + '\n' + t(2, '    let h = Histogram::equi_width(&[1.0], 2);\n    assert_eq!(h.total(), 2);'),
  }, ['a', 'b']);
  sdd(d, 'tdd', 'stub', 'TEST-H-002');
  const h = fs.readFileSync(path.join(d, 'src/histogram.rs'), 'utf8');
  assert.match(h, /pub fn total\(&self\)/, h);
  assert.match(h, /pub fn bucket_count/, h);
});

test('#268 Rust stub: `use krate::ops;` + `ops::f(..)` is a module, not a function', has268, () => {
  const d = rs268({
    'src/lib.rs': '',
    'tests/o.rs': 'use hist::ops;\n\n// @id TEST-H-001 @verifies REQ-H-001\n#[test]\nfn test_h_001() {\n    assert_eq!(ops::pages(10, 2), 5);\n}\n',
  });
  sdd(d, 'tdd', 'stub', 'TEST-H-001');
  const lib = fs.readFileSync(path.join(d, 'src/lib.rs'), 'utf8');
  assert.match(lib, /pub mod ops;/, lib);
  assert.doesNotMatch(lib, /fn ops/, lib);
  assert.match(fs.readFileSync(path.join(d, 'src/ops.rs'), 'utf8'), /pub fn pages/);
});

test('#268 Rust stub: payload variants are tuple variants; `use .. as Alias` resolves to the real type', has268, () => {
  const d = rs268({
    'src/lib.rs': '',
    'tests/e.rs': 'use hist::err::{Lit as L, HistError};\n\n// @id TEST-H-001 @verifies REQ-H-001\n#[test]\nfn test_h_001() {\n    let e = HistError::Duplicate("a".to_string());\n    assert_eq!(e, HistError::Empty);\n    assert_eq!(L::Int(3), L::Int(3));\n}\n',
  });
  sdd(d, 'tdd', 'stub', 'TEST-H-001');
  const e = fs.readFileSync(path.join(d, 'src/err.rs'), 'utf8');
  assert.match(e, /Duplicate\(/, e);
  assert.match(e, /Int\(/, e);
  assert.doesNotMatch(e, /Copy/, e);
});

test('#268 Rust stub: a string literal compared through a bound variable gives a String return', has268, () => {
  const d = rs268({
    'src/lib.rs': '',
    'tests/x.rs': 'use hist::explain;\n\n// @id TEST-H-001 @verifies REQ-H-001\n#[test]\nfn test_h_001() {\n    let text = explain(&1);\n    assert_eq!(text, "Filter rows=20");\n}\n',
  });
  sdd(d, 'tdd', 'stub', 'TEST-H-001');
  assert.match(fs.readFileSync(path.join(d, 'src/lib.rs'), 'utf8'), /fn explain<A0>\(_a0: A0\) -> String/);
});

// ---- wave 10 (#271): one weak-Red rule, Rust/pytest/ExUnit variants ----
const exs271 = (inner, pre = '') => `defmodule T do\n  use ExUnit.Case\n${pre}  # @id TEST-CALC-001\n  # @verifies REQ-CALC-001\n  test "a" do\n${inner}\n  end\n\n  defp filled(n) do\n    Log.new(n)\n  end\nend\n`;

const rs271 = (helper, body) => `import { test } from 'node:test';\n${helper}\n/** @id TEST-CALC-001 @verifies REQ-CALC-001 */\ntest('TEST-CALC-001 x', () => {\n${body.join('\n')}\n});\n`;
const rsOut = "thread 'x' panicked at src/m.rs:3:5:\nnot implemented: ";

test('#271 ExUnit: a failure raised in a setup block (child_spec undefined) is setup, with the function as the reason', () => {
  const pre = '  setup do\n    start_supervised!({Cache, name: nil})\n    :ok\n  end\n\n';
  const out = '  1) test a (T)\n     test/t.exs:9\n     ** (UndefinedFunctionError) function Cache.child_spec/1 is undefined or private\n     stacktrace:\n       Cache.child_spec([])\n       test/t.exs:3: T."__ex_unit_setup_0"/1\n       test/t.exs:1: T.__ex_unit__/2\n';
  const r = weak263(null, out, 'add.test.exs', exs271('    assert Foo.run(1) == 2', pre));
  assert.match(r.out, /\[weak\].*setup call "child_spec"/, r.out);
});

test('#271 Rust: a shared helper whose stub fails is setup even when the helper call is an argument of the asserted call', () => {
  const r = weak263(null, `${rsOut}default\n`, 'a.test.mjs', rs271('fn p() -> CostParams { CostParams::default() }', ['  assert_eq!(cost(&p(), 1), 2);']));
  assert.match(r.out, /\[weak\].*setup call "default"/, r.out);
});

test('#271 pytest: a fixture failure is setup even when the error is not a NotImplementedError', () => {
  const py = `import pytest\n\n\n@pytest.fixture\ndef eng():\n    return Engine()\n\n\n# @id TEST-CALC-001 @verifies REQ-CALC-001\ndef test_a(eng):\n    assert eng.run(1) == 2\n`;
  const out = 'ERROR at setup of test_a\nconftest.py:6: in eng\n    return Engine()\nE   TypeError: Engine() takes no arguments\n';
  const r = weak263(null, out, 'a.test.py', py);
  assert.match(r.out, /\[weak\].*setup call "eng"/, r.out);
});

test('#271 --expect after --allow-setup-red: the hint does not suggest --expect again', () => {
  weak263.args = ['--expect', 'not implemented: new'];
  const r = weak263(null, 'not implemented: new\n', 'add.test.exs', exs271('    l = Log.new(1)\n    assert Log.entries(l) == []'));
  weak263.args = undefined;
  assert.match(r.out, /\[weak\]/, r.out);
  assert.doesNotMatch(r.out, /use --expect/, r.out);
});

test('#267 gate --changed adds the parity peer of a changed file to the scope', () => {
  const d = mini('---\nfeature: a\ntier: T1\n---\n| REQ-A-001 | x shall work. | TEST-A-001 |\n', { 'rs/hash.rs': 'fn h() {}\n', 'ex/hash.ex': 'defmodule H do\nend\n' });
  const cp = path.join(d, '.sdd/config.json');
  const c = JSON.parse(fs.readFileSync(cp, 'utf8'));
  c.parity = [['rs/hash.rs', 'ex/hash.ex']];
  c.checks = [{ name: 'paths', cmd: ['node', '-e', '0'], changedCmd: ['node', '-e', 'console.log("SCOPE:" + process.argv.slice(1).join("|"));process.exit(1)', '{changedFiles}'] }];
  fs.writeFileSync(cp, JSON.stringify(c));
  spawnSync('git', ['add', '-A'], { cwd: d });
  spawnSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-qm', 'i'], { cwd: d });
  fs.writeFileSync(path.join(d, 'rs/hash.rs'), 'fn h() { 1 }\n');
  const r = sdd(d, 'gate', '--changed', '--verbose');
  assert.match(r.out, /SCOPE:[^\n]*ex\/hash\.ex/, r.out);
});

test('#276 a "- REQ-X:" Assumptions bullet is a reference, not a second definition', () => {
  const d = mini('---\nfeature: a\ntier: T1\n---\n| REQ-A-001 | x shall work. | TEST-A-001 |\n\n## Assumptions / risks\n- REQ-A-001: low confidence, kept as is.\n');
  const r = sdd(d, 'trace');
  assert.doesNotMatch(r.out, /duplicate REQ/, r.out);
});

test('#276 trace checks reverse-spec [src: path:line] annotations', () => {
  const d = mini('---\nfeature: a\ntier: T1\n---\n| REQ-A-001 | x shall work. [src: lib/a.ts:2] [src: lib/a.ts:99] [src: nope.ts:1] | TEST-A-001 |\n', { 'lib/a.ts': 'a\nb\n' });
  const r = sdd(d, 'trace', '--verbose');
  assert.match(r.out, /lib\/a\.ts:99\] line is beyond/, r.out);
  assert.match(r.out, /nope\.ts:1\] file does not exist/, r.out);
  assert.doesNotMatch(r.out, /lib\/a\.ts:2\]/, r.out);
});

test('#276 impact REQ-X with no @implements anywhere says so', () => {
  const d = mini('---\nfeature: r\ntier: T1\n---\n| REQ-R-001 | x shall work. | TEST-R-001 |\n');
  const r = sdd(d, 'impact', 'REQ-R-001');
  assert.match(r.out, /no @implements REQ-R-001 found/, r.out);
});

test('#276 tdd green warns when no code carries @implements for the REQ', () => {
  const d = mini('---\nfeature: a\ntier: T1\n---\n| REQ-A-001 | x shall work. | TEST-A-001 |\n', { 'a.test.mjs': '// @id TEST-A-001 @verifies REQ-A-001\n' }, FAIL);
  assert.equal(sdd(d, 'tdd', 'red', 'TEST-A-001').code, 0);
  setCmd(d, PASS);
  assert.match(sdd(d, 'tdd', 'green', 'TEST-A-001').out, /no code carries @implements REQ-A-001/);
});

test('#275 config deliverables: a golden artifact that is the deliverable gets a non-weak Red and does not stale tests', () => {
  const spec = '---\nfeature: g\ntier: T1\n---\n| REQ-G-001 | golden shall exist. | TEST-G-001 |\n| REQ-G-002 | other shall hold. | TEST-G-002 |\n';
  const t = "// @id TEST-G-001 @verifies REQ-G-001\n// @id TEST-G-002 @verifies REQ-G-002\n";
  const d = mini(spec, { 'c.test.mjs': t });
  const cp = path.join(d, '.sdd/config.json');
  const c = JSON.parse(fs.readFileSync(cp, 'utf8'));
  c.artifacts = { 'contract/plan.json': ['c.test.mjs'] };
  c.deliverables = ['contract/plan.json'];
  c.testCmd = ['node', '-e', 'const f=require("fs");const id=process.argv[1];if(id.endsWith("001")&&!f.existsSync("contract/plan.json")){console.log("AssertionError: missing");process.exit(1)}', '{id}'];
  fs.writeFileSync(cp, JSON.stringify(c));
  assert.equal(sdd(d, 'tdd', 'red', 'TEST-G-001').code, 0);
  assert.equal(sdd(d, 'tdd', 'red', 'TEST-G-002', '--characterization', 'data only').code, 0);
  fs.mkdirSync(path.join(d, 'contract'));
  fs.writeFileSync(path.join(d, 'contract/plan.json'), '{}');
  const g1 = sdd(d, 'tdd', 'green', 'TEST-G-001');
  assert.equal(g1.code, 0, g1.out);
  assert.doesNotMatch(g1.out, /\[weak\]/);
  const g2 = sdd(d, 'tdd', 'green', 'TEST-G-002');
  assert.equal(g2.code, 0, g2.out);
});

test('#272 --characterization on a failing test warns that the flag was ignored', () => {
  const d = mini(T1SPEC, { 'a.test.mjs': jsTest() }, FAIL);
  const r = sdd(d, 'tdd', 'red', 'TEST-A-001', '--characterization', 'data-only');
  assert.match(r.out, /RED ok/, r.out);
  assert.match(r.out, /--characterization ignored/, r.out);
});

test('#272 gate does not count characterization Reds as weak Reds', () => {
  const d = mini(T1SPEC, { 'a.test.mjs': jsTest() }, PASS);
  assert.equal(sdd(d, 'tdd', 'red', 'TEST-A-001', '--characterization', 'pins behaviour').code, 0);
  assert.equal(sdd(d, 'tdd', 'green', 'TEST-A-001').code, 0);
  const g = sdd(d, 'gate', '--no-run').out;
  assert.match(g, /1 characterization/, g);
  assert.doesNotMatch(g, /\d+ weak Red/, g);
});

test('#273 a Rust runtime unwrap() panic (thread id in the panic line) is a Red, not a load/compile error', () => {
  const d = mini(T1SPEC, { 'a.test.mjs': jsTest() }, ['sh', '-c', "printf \"thread 'x' (4242) panicked at tests/c.rs:5:10:\\ncalled \\`Result::unwrap()\\` on an \\`Err\\` value: Os { code: 2, kind: NotFound, message: \\\"No such file or directory\\\" }\\n\"; exit 101"]);
  const r = sdd(d, 'tdd', 'red', 'TEST-A-001');
  assert.match(r.out, /RED ok/, r.out);
  assert.doesNotMatch(r.out, /REJECTED|\[weak\]/, r.out);
});

test('#273 Green after a compile error says it is a load/compile error, not just "test failed"', () => {
  const d = mini(T1SPEC, { 'a.test.mjs': jsTest() }, FAIL);
  assert.equal(sdd(d, 'tdd', 'red', 'TEST-A-001').code, 0);
  setCmd(d, ['sh', '-c', 'echo "** (CompileError) lib/a.ex:3: cannot invoke remote function Access.get/2 inside guards"; exit 1']);
  const r = sdd(d, 'tdd', 'green', 'TEST-A-001');
  assert.match(r.out, /GREEN REJECTED[^\n]*compile error/, r.out);
});

test('#274 reverting a setup edit after a refactor recovers the earlier Green; the refactor is flagged as unproven', () => {
  const d = mini(T1SPEC, { 'a.test.mjs': jsTest(), 'helper.mjs': 'export const one = 1;\n' }, FAIL);
  const f = path.join(d, 'a.test.mjs');
  fs.writeFileSync(f, "import { one } from './helper.mjs';\n" + jsTest());
  assert.equal(sdd(d, 'tdd', 'red', 'TEST-A-001').code, 0);
  setCmd(d, PASS);
  assert.equal(sdd(d, 'tdd', 'green', 'TEST-A-001').code, 0);
  fs.writeFileSync(path.join(d, 'helper.mjs'), 'export const one = 1; // edited\n');
  assert.equal(sdd(d, 'tdd', 'refactor', 'TEST-A-001', '--wording', 'x').code, 0);
  assert.match(sdd(d, 'gate', '--no-run').out, /refactor-recorded after the test\/setup changed/);
  fs.writeFileSync(path.join(d, 'helper.mjs'), 'export const one = 1;\n');
  const g = sdd(d, 'gate', '--no-run').out;
  assert.doesNotMatch(g, /changed since last Green/, g);
  assert.doesNotMatch(g, /refactor-recorded after/, g);
});

// ---- wave 10 (#269/#270) ----
const stub10 = (files, id) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-w10-'));
  spawnSync('git', ['init', '-q'], { cwd: d });
  fs.mkdirSync(path.join(d, '.sdd/specs'), { recursive: true });
  for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), c); }
  sdd(d, 'init');
  if (files['mix.exs']) fs.rmSync(path.join(d, 'package.json'), { force: true });
  sdd(d, 'tdd', 'stub', id);
  return d;
};

test('#269 TS stub: a name ending in Error that is only called as a function stays a function', () => {
  const d = stub10({
    'sdk.test.ts': "import { mapError, NotFoundError } from './sdk';\n\n// @id TEST-S-001\n// @verifies REQ-S-001\ntest('s', () => {\n  const e = mapError(404, 'x');\n  expect(e instanceof NotFoundError).toBe(true);\n});\n",
  }, 'TEST-S-001');
  const s = fs.readFileSync(path.join(d, 'sdk.ts'), 'utf8');
  assert.match(s, /export function mapError/, s);
  assert.match(s, /export class NotFoundError extends Error/, s);
});

test('#269 pytest stub: methods called on a fixture-provided instance are added to the class', () => {
  const d = stub10({
    'tests/test_agg.py': "import pytest\nfrom winlib.agg import Agg\n\n@pytest.fixture\ndef agg():\n    return Agg()\n\n# @id TEST-AGG-001\n# @verifies REQ-AGG-001\ndef test_agg_001(agg):\n    agg.process(1)\n    assert agg.flush() == []\n",
  }, 'TEST-AGG-001');
  const s = fs.readFileSync(path.join(d, 'winlib/agg.py'), 'utf8');
  assert.match(s, /def process\(self/, s);
  assert.match(s, /def flush\(self/, s);
});

test('#270 Elixir stub: a module passed to start_supervised! is startable (use GenServer => child_spec/1)', () => {
  const d = stub10({
    'mix.exs': 'defmodule C.MixProject do\n  use Mix.Project\n  def project, do: [app: :c, version: "0.1.0", deps: []]\nend\n',
    'test/test_helper.exs': 'ExUnit.start()\n',
    'test/c_test.exs': 'defmodule CTest do\n  use ExUnit.Case\n\n  # @id TEST-C-001\n  # @verifies REQ-C-001\n  test "c" do\n    pid = start_supervised!({Cache, name: nil})\n    assert is_pid(pid)\n  end\nend\n',
  }, 'TEST-C-001');
  const s = fs.readFileSync(path.join(d, 'lib/cache.ex'), 'utf8');
  assert.match(s, /use GenServer/, s);
  assert.match(s, /def start_link/, s);
});

// ---- wave 11 (#278/#280) ----
test('#278 Rust include!(concat!(env!("OUT_DIR"), ..)) is a build artifact: red/green neither crash nor refuse', { skip: !has130('cargo') }, () => {
  const d = batch2Source('src/cases.rs', '// @id TEST-CALC-001 @verifies REQ-CALC-001\n#[test]\nfn test_calc_001() { assert_eq!(crate::answer(), 7); }\n');
  writeAll(d, {
    'Cargo.toml': '[package]\nname="outdir-probe"\nversion="0.1.0"\nedition="2021"\nbuild="build.rs"\n',
    'build.rs': 'fn main() { let o = std::env::var("OUT_DIR").unwrap(); std::fs::write(format!("{}/gen.rs", o), "pub const G: i32 = 1;").unwrap(); }\n',
    'src/lib.rs': '// @id CODE-CALC-001 @implements REQ-CALC-001\ninclude!(concat!(env!("OUT_DIR"), "/gen.rs"));\npub fn answer() -> i32 { G - 1 }\n#[cfg(test)] mod cases;\n',
  });
  fs.writeFileSync(path.join(d, '.sdd/config.json'), JSON.stringify({ testCmd: ['cargo', 'test', '--lib', '{idu}'], checks: [] }));
  const red = sdd(d, 'tdd', 'red', 'TEST-CALC-001');
  assert.equal(red.code, 0, red.out);
  assert.doesNotMatch(red.out, /\n\s+at /);
  fs.writeFileSync(path.join(d, 'src/lib.rs'), rd130(d, 'src/lib.rs').replace('G - 1', 'G + 6'));
  const green = sdd(d, 'tdd', 'green', 'TEST-CALC-001');
  assert.equal(green.code, 0, green.out);
  assert.doesNotMatch(green.out, /\n\s+at /);
});

test('#278 an unresolvable Rust include prints a clean REFUSED without a stack', { skip: !has130('cargo') }, () => {
  const d = batch2Source('src/cases.rs', '// @id TEST-CALC-001 @verifies REQ-CALC-001\n#[test]\nfn test_calc_001() { assert_eq!(crate::answer(), 7); }\n');
  writeAll(d, { 'Cargo.toml': '[package]\nname="inc-probe"\nversion="0.1.0"\nedition="2021"\n', 'src/lib.rs': '// @id CODE-CALC-001 @implements REQ-CALC-001\ninclude!(concat!(env!("SOME_DIR"), "/gen.rs"));\npub fn answer() -> i32 { 0 }\n#[cfg(test)] mod cases;\n' });
  fs.writeFileSync(path.join(d, '.sdd/config.json'), JSON.stringify({ testCmd: ['cargo', 'test', '--lib', '{idu}'], checks: [] }));
  const red = sdd(d, 'tdd', 'red', 'TEST-CALC-001');
  assert.equal(red.code, 1, red.out);
  assert.match(red.out, /REFUSED: unresolved Rust include ownership/);
  assert.doesNotMatch(red.out, /\n\s+at /);
});

test('#280 Rust stub: assert!(f(..)) returns bool; items of an existing cfg(test)-only module are added; macros get a clear note', { skip: !has130('cargo') }, () => {
  const toml = '[package]\nname = "s280"\nversion = "0.1.0"\nedition = "2021"\n';
  const b = mk130({ 'Cargo.toml': toml, 'tests/t.rs': 'use s280::ops::is_ok;\n// @id TEST-A-001 @verifies REQ-A-001\n#[test]\nfn t1() { assert!(is_ok(3)); }\n' });
  const ob = sdd(b, 'tdd', 'stub', 'TEST-A-001').out;
  assert.match(rd130(b, 'src/ops.rs'), /pub fn is_ok<A0>\(_a0: A0\) -> bool/, ob);
  assert.match(ob, /compile-checked/, ob);
  const m = mk130({ 'Cargo.toml': toml, 'src/lib.rs': 'pub mod ops;\n', 'src/ops.rs': '#[cfg(test)]\nmod tests {\n    pub fn double(x: i64) -> i64 { x }\n}\n', 'tests/t.rs': 'use s280::ops::double;\n// @id TEST-A-001 @verifies REQ-A-001\n#[test]\nfn t1() { assert_eq!(double(2), 4); }\n' });
  sdd(m, 'tdd', 'stub', 'TEST-A-001');
  assert.match(rd130(m, 'src/ops.rs'), /^pub fn double/m);
  const k = mk130({ 'Cargo.toml': toml, 'tests/t.rs': '// @id TEST-A-001 @verifies REQ-A-001\n#[test]\nfn t1() { let v = entries![1, 2]; assert_eq!(v.len(), 2); }\n' });
  const ok = sdd(k, 'tdd', 'stub', 'TEST-A-001').out;
  assert.match(ok, /macro entries! is not stubbed/, ok);
});

test('#279 pytest stub: packages on a sibling pythonpath entry are not shadowed; stub classes grow methods; parametrized constants load', () => {
  const d = stub10({
    'core/src/crdt_core/__init__.py': '',
    'core/src/crdt_core/hlc.py': 'class Clock:\n    pass\n',
    'oplog/pytest.ini': '[pytest]\npythonpath = src ../core/src\n',
    'oplog/src/oplog/__init__.py': '',
    'oplog/tests/test_a.py': "import pytest\nfrom crdt_core.hlc import Clock\nfrom oplog.reg import Reg, SCHEMA\n\n@pytest.mark.parametrize('s', SCHEMA)\n# @id TEST-A-001\n# @verifies REQ-A-001\ndef test_a(s):\n    r = Reg()\n    r.merge(1)\n    assert Clock\n",
  }, 'TEST-A-001');
  assert.equal(fs.existsSync(path.join(d, 'oplog/src/crdt_core')), false);
  const reg = path.join(d, 'oplog/src/oplog/reg.py');
  assert.match(fs.readFileSync(reg, 'utf8'), /SCHEMA = \[\]/);
  fs.writeFileSync(path.join(d, 'oplog/tests/test_a.py'), fs.readFileSync(path.join(d, 'oplog/tests/test_a.py'), 'utf8').replace('r.merge(1)', 'r.merge(1)\n    r.value()'));
  sdd(d, 'tdd', 'stub', 'TEST-A-001');
  assert.match(fs.readFileSync(reg, 'utf8'), /def value\(self/);
});

test('#281 TS stub emits @id/@implements so the later swap is not an ownership change', () => {
  const d = stub10({
    'sdk.test.ts': "import { mapError } from './sdk';\n\n// @id TEST-S-001\n// @verifies REQ-S-001\ntest('s', () => {\n  expect(mapError(404, 'x')).toBeTruthy();\n});\n",
  }, 'TEST-S-001');
  const s = fs.readFileSync(path.join(d, 'sdk.ts'), 'utf8');
  assert.match(s, /\/\/ @id CODE-S-001-STUB-001 @implements REQ-S-001/, s);
});

test('#282 Red: AssertionError embedding subprocess stderr is an assertion; missing declared deliverable is a valid Red', () => {
  const d = project();
  sdd(d, 'init');
  const cj = path.join(d, '.sdd/config.json');
  fs.writeFileSync(cj, JSON.stringify({ ...JSON.parse(fs.readFileSync(cj, 'utf8')), deliverables: ['contract/vectors.json'] }));
  fs.writeFileSync(path.join(d, 'add.test.mjs'), [
    "import { test } from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { spawnSync } from 'node:child_process';",
    '/** @id TEST-CALC-001 @verifies REQ-CALC-001 */',
    "test('TEST-CALC-001 cli', () => { const r = spawnSync('node', ['cli.ts'], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); });",
    '',
  ].join('\n'));
  sdd(d, 'approve', 'record', 'calc', '--by', 'tester');
  const r = sdd(d, 'tdd', 'red', 'TEST-CALC-001');
  assert.equal(r.code, 0, r.out);
  assert.doesNotMatch(r.out, /weak/);
  fs.writeFileSync(path.join(d, 'add.test.mjs'), [
    "import { test } from 'node:test';",
    "import fs from 'node:fs';",
    '/** @id TEST-CALC-001 @verifies REQ-CALC-001 */',
    "test('TEST-CALC-001 vectors', () => { JSON.parse(fs.readFileSync('contract/vectors.json', 'utf8')); });",
    '',
  ].join('\n'));
  const r2 = sdd(d, 'tdd', 'red', 'TEST-CALC-001');
  assert.equal(r2.code, 0, r2.out);
});

// ---- wave 11 (#283) ----
const W11SPEC = (n) => `---\nfeature: w\ntier: T1\napproval: auto\n---\n${Array.from({ length: n }, (_, i) => `| REQ-W-00${i + 1} | g shall hold. | TEST-W-00${i + 1} |`).join('\n')}\n`;
const lastRed = (d) => fs.readFileSync(path.join(d, '.sdd/tdd.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.type === 'red').at(-1);

test('#283 weak Red: a stub call paired with the call whose bound result is asserted is the act (strong Red)', () => {
  const d = mini(W11SPEC(1), {
    'src/m.py': 'def save(p, x):\n    raise NotImplementedError("save")\n\n\ndef load(p):\n    return p.get("v")\n',
    'tests/test_w.py': 'import sys\nsys.path.insert(0, "src")\nfrom m import save, load\n\n\n# @id TEST-W-001 @verifies REQ-W-001\ndef test_w_001():\n    p = {}\n    save(p, 1)\n    got = load(p)\n    assert got == 1\n',
  });
  const r = sdd(d, 'tdd', 'red', 'TEST-W-001');
  assert.match(r.out, /RED ok/, r.out);
  assert.doesNotMatch(r.out, /\[weak\]|setup call/, r.out);
});

test('#283 a TypeError raised by the test\'s own helper is not a genuine Red', () => {
  const d = mini(W11SPEC(1), {
    'tests/test_w.py': 'def mk(a, b):\n    return a + b\n\n\n# @id TEST-W-001 @verifies REQ-W-001\ndef test_w_001():\n    assert mk(a=1, c=2) == 3\n',
  });
  const r = sdd(d, 'tdd', 'red', 'TEST-W-001');
  assert.match(r.out, /RED REJECTED[^\n]*(?:own helper|test bug)/, r.out);
});

test('#283 a TypeError on a None stub used for setup is a weak Red', () => {
  const d = mini(W11SPEC(1), {
    'src/m.py': 'HLC = None\n\n\nclass Log:\n    @staticmethod\n    def entries(c):\n        return []\n',
    'tests/test_w.py': 'import sys\nsys.path.insert(0, "src")\nfrom m import HLC, Log\n\n\n# @id TEST-W-001 @verifies REQ-W-001\ndef test_w_001():\n    clock = HLC(1)\n    assert Log.entries(clock) == []\n',
  });
  const r = sdd(d, 'tdd', 'red', 'TEST-W-001');
  assert.match(r.out, /\[weak\]/, r.out);
  assert.match(r.out, /setup call "HLC"/, r.out);
});

test('#283 a module-level stub call that fails at load is a weak Red with a loud note', () => {
  const d = approved();
  fs.writeFileSync(path.join(d, 'add.test.mjs'), [
    "import { test } from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { add } from './add.mjs';",
    'const fixture = add(1, 2);',
    '/** @id TEST-CALC-001 @verifies REQ-CALC-001 */',
    "test('TEST-CALC-001 adds', () => assert.equal(fixture, 3));", '',
  ].join('\n'));
  impl(d, '(a, b) => { throw new Error("not implemented"); }');
  const r = sdd(d, 'tdd', 'red', 'TEST-CALC-001');
  assert.match(r.out, /\[weak\]/, r.out);
  assert.match(r.out, /before any test body ran/, r.out);
});

test('#283 a matcher-less assert.throws satisfied by the stub error is reported as vacuous', () => {
  const d = approved();
  fs.writeFileSync(path.join(d, 'add.test.mjs'), [
    "import { test } from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { add } from './add.mjs';",
    '/** @id TEST-CALC-001 @verifies REQ-CALC-001 */',
    "test('TEST-CALC-001 rejects', () => { assert.throws(() => add('x', 1)); });", '',
  ].join('\n'));
  impl(d, '(a, b) => { throw new Error("not implemented"); }');
  const r = sdd(d, 'tdd', 'red', 'TEST-CALC-001');
  assert.match(r.out, /REJECTED[^\n]*vacuous/, r.out);
});

test('#283 --retest after only an oracle artifact changed keeps the strong Red', () => {
  const d = mini(T1SPEC, { 'a.test.mjs': jsTest(), 'helper.mjs': 'export const one = 1;\n' }, FAIL);
  fs.writeFileSync(path.join(d, 'a.test.mjs'), "import { one } from './helper.mjs';\n" + jsTest());
  assert.equal(sdd(d, 'tdd', 'red', 'TEST-A-001').code, 0);
  setCmd(d, PASS);
  assert.equal(sdd(d, 'tdd', 'green', 'TEST-A-001').code, 0);
  fs.writeFileSync(path.join(d, 'helper.mjs'), 'export const one = 2;\n');
  const r = sdd(d, 'tdd', 'red', 'TEST-A-001', '--retest', 'oracle gained vectors');
  assert.match(r.out, /RED ok/, r.out);
  assert.doesNotMatch(r.out, /\[weak\]|superseded/, r.out);
  assert.equal(lastRed(d).weak, undefined);
  assert.equal(sdd(d, 'tdd', 'green', 'TEST-A-001').code, 0);
  assert.doesNotMatch(sdd(d, 'gate', '--no-run').out, /weak Red|superseded/);
});

// ---- wave 11 (#284) ----
test('#284 conftest.py defining only fixtures the test never uses does not stale the test; a used fixture still does', () => {
  const d = batch2Source('tests/test_a.py', 'def test_calc_001():\n    # @id TEST-CALC-001 @verifies REQ-CALC-001\n    assert 1 == 2\n');
  writeAll(d, { 'tests/conftest.py': 'import pytest\n@pytest.fixture\ndef val():\n    return 1\n' });
  fakeOut(d, 'E   assert 1 == 2\nFAILED tests/test_a.py::test_calc_001 - assert 1 == 2\n1 failed');
  assert.equal(sdd(d, 'tdd', 'red', 'TEST-CALC-001').code, 0);
  fakeOut(d, 'pass', 0);
  assert.equal(sdd(d, 'tdd', 'green', 'TEST-CALC-001').code, 0);
  writeAll(d, { 'tests/conftest.py': 'import pytest\n@pytest.fixture\ndef val():\n    return 2\n\n@pytest.fixture\ndef other():\n    return 3\n' });
  const g = sdd(d, 'gate', '--no-run');
  assert.doesNotMatch(g.out, /oracle dependency changed: .*conftest/, g.out);
});

test('#284 gate --changed never prints the raw {changedCargoPkgs} placeholder', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-cargo-'));
  const git = (...a) => spawnSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=t', ...a], { cwd: d });
  fs.mkdirSync(path.join(d, 'src'), { recursive: true });
  fs.writeFileSync(path.join(d, 'Cargo.toml'), '[package]\nname = "x"\nversion = "0.1.0"\nedition = "2021"\n');
  fs.writeFileSync(path.join(d, 'src/lib.rs'), 'pub fn a() {}\n');
  git('init', '-q');
  sdd(d, 'init');
  git('add', '-A'); git('commit', '-qm', 'base');
  fs.appendFileSync(path.join(d, 'Cargo.toml'), '\n# edit\n');
  const g = sdd(d, 'gate', '--changed').out;
  assert.match(g, /cannot scope changes for the changed Cargo packages/, g);
  assert.doesNotMatch(g, /\{changedCargoPkgs\}/, g);
});

const t1project = () => {
  const d = project();
  fs.writeFileSync(path.join(d, '.sdd/specs/calc.md'), '---\nfeature: calc\ntier: T1\n---\n| REQ-CALC-001 | When add is called, the system shall sum. | TEST-CALC-001 |\n');
  return d;
};

test('#285 approve prepare on T1 does not say state: missing nor suggest approve record', () => {
  const d = t1project();
  const r = sdd(d, 'approve', 'prepare', 'calc');
  assert.doesNotMatch(r.out, /state: missing|approve record/, r.out);
  assert.match(r.out, /T1/, r.out);
});

test('#285 re-recording Green/Refactor warns when a T1 row changed since the previous Green', () => {
  const d = t1project();
  impl(d, '(a, b) => a + b');
  assert.equal(sdd(d, 'tdd', 'red', 'TEST-CALC-001', '--characterization', 'pins current').code, 0);
  assert.equal(sdd(d, 'tdd', 'green', 'TEST-CALC-001').code, 0);
  fs.writeFileSync(path.join(d, '.sdd/specs/calc.md'), '---\nfeature: calc\ntier: T1\n---\n| REQ-CALC-001 | When add is called, the system shall subtract. | TEST-CALC-001 |\n');
  const g = sdd(d, 'tdd', 'refactor', 'TEST-CALC-001');
  assert.match(g.out, /REQ-CALC-001 .*changed since its previous Green/, g.out);
});

test('#285 --characterization output does not claim [weak]', () => {
  const d = t1project();
  impl(d, '(a, b) => a + b');
  const r = sdd(d, 'tdd', 'red', 'TEST-CALC-001', '--characterization', 'pins current');
  assert.doesNotMatch(r.out, /\[weak\]/, r.out);
});

test('#286 batch tdd red prints an identical REFUSED line once', () => {
  const d = project();
  fs.appendFileSync(path.join(d, 'add.test.mjs'), "/** @id TEST-CALC-002 @verifies REQ-CALC-001 */\ntest('TEST-CALC-002 b', () => assert.equal(1, 1));\n");
  const r = sdd(d, 'tdd', 'red', 'TEST-CALC-001', 'TEST-CALC-002');
  const n = r.out.split('\n').filter((l) => l.startsWith('REFUSED:')).length;
  assert.equal(n, 1, r.out);
});

test('#286 tdd red refuses a duplicate @id up front', () => {
  const d = t1project();
  fs.appendFileSync(path.join(d, 'add.test.mjs'), "/** @id TEST-CALC-001 @verifies REQ-CALC-001 */\ntest('dup', () => assert.equal(1, 1));\n");
  const r = sdd(d, 'tdd', 'red', 'TEST-CALC-001');
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /REFUSED: duplicate @id TEST-CALC-001/, r.out);
});

test('#286 gate does not pass a node:test run with zero tests', () => {
  const d = t1project();
  fs.writeFileSync(path.join(d, '.sdd/config.json'), JSON.stringify({ checks: [{ name: 'unit', cmd: ['node', '-e', "console.log('ℹ tests 0\\nℹ pass 0\\nℹ fail 0\\nℹ skipped 0')"] }] }));
  const g = sdd(d, 'gate');
  assert.match(g.out, /INCOMPLETE/, g.out);
});

test('#286 plan explains [no-spec] when the name differs from the spec feature', () => {
  const d = t1project();
  fs.writeFileSync(path.join(d, '.sdd/plan.md'), '| order | feature | depends | note |\n|---|---|---|---|\n| 1 | calculator | - | x |\n');
  const r = sdd(d, 'plan');
  assert.match(r.out, /no spec has feature: calculator.*calc/, r.out);
});

test('#286 green warns that shared-impl staleness cannot be checked for unannotated code', () => {
  const d = t1project();
  fs.writeFileSync(path.join(d, 'add.mjs'), 'export const add = (a, b) => a + b;\n');
  sdd(d, 'tdd', 'red', 'TEST-CALC-001', '--characterization', 'x');
  const r = sdd(d, 'tdd', 'green', 'TEST-CALC-001');
  assert.match(r.out, /no code carries @implements.*shared/, r.out);
});

const blockProject = () => {
  const spec = '---\nfeature: a\ntier: T1\n---\n| REQ-A-001 | x shall hold. | TEST-A-001 |\n| REQ-A-002 | y shall hold. | TEST-A-002 |\n';
  const d = mini(spec, { 'a.test.mjs': '// @id TEST-A-001 @verifies REQ-A-001\n// one\n// @id TEST-A-002 @verifies REQ-A-002\n// two\n', 'impl.mjs': '// @id CODE-A-001 @implements REQ-A-001\nexport function one() {\n  return 1;\n}\n\n// @id CODE-A-002 @implements REQ-A-002\nexport function two() {\n  return 2;\n}\n' }, FAIL);
  assert.equal(sdd(d, 'tdd', 'red', 'TEST-A-001').code, 0);
  assert.equal(sdd(d, 'tdd', 'red', 'TEST-A-002').code, 0);
  setCmd(d, PASS);
  assert.equal(sdd(d, 'tdd', 'green', 'TEST-A-001').code, 0);
  return d;
};
const touchImpl = (d, from, to) => {
  const p = path.join(d, 'impl.mjs'), later = new Date(Date.now() + 5000);
  fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace(from, to));
  fs.utimesSync(p, later, later);
};

test('#287 shared-impl warning is per @implements block: editing a sibling function does not flag', () => {
  const d = blockProject();
  touchImpl(d, 'return 2;', 'return 22;');
  assert.doesNotMatch(sdd(d, 'tdd', 'green', 'TEST-A-002').out, /shared with other REQs/);
});

test('#287 shared-impl warning still fires when the block itself changed', () => {
  const d = blockProject();
  touchImpl(d, 'return 1;', 'return 11;');
  assert.match(sdd(d, 'tdd', 'green', 'TEST-A-002').out, /shared with other REQs[^\n]*TEST-A-001/);
});

test('#287 ledger entries without implBlocks fall back to the file mtime', () => {
  const d = blockProject();
  const f = path.join(d, '.sdd/tdd.jsonl');
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').split('\n').map((l) => { if (!l.trim()) return l; const o = JSON.parse(l); delete o.implBlocks; return JSON.stringify(o); }).join('\n'));
  touchImpl(d, 'return 2;', 'return 22;');
  assert.match(sdd(d, 'tdd', 'green', 'TEST-A-002').out, /shared with other REQs[^\n]*TEST-A-001/);
});

test('#287 impact: dependsOnMode "referenced" drops a cross-language dependsOn edge without a real reference; default labels it declared', () => {
  const d = mini('---\nfeature: r\ntier: T1\n---\n| REQ-R-001 | x shall work. | TEST-R-001 |\n', { 'contract/g.json': '{}', 'py/a.py': 'print(1)\n', 'ts/b.ts': 'const p = "contract/g.json";\n' });
  const cp = path.join(d, '.sdd/config.json');
  const c = JSON.parse(fs.readFileSync(cp, 'utf8'));
  c.projects = [{ root: 'py', dependsOn: ['contract'], testCmd: ['true'], checks: [] }, { root: 'ts', dependsOn: ['contract'], testCmd: ['true'], checks: [] }];
  fs.writeFileSync(cp, JSON.stringify(c));
  const dflt = sdd(d, 'impact', 'contract/g.json');
  assert.match(dflt.out, /declared dependsOn only.*: py/, dflt.out);
  c.projects[0].dependsOnMode = 'referenced';
  fs.writeFileSync(cp, JSON.stringify(c));
  const j = JSON.parse(sdd(d, 'impact', 'contract/g.json', '--json').out);
  assert.deepEqual(j.projects, ['ts'], JSON.stringify(j));
});

// ---- #287 item 3: Rust doc tests ----
test('#287 a Rust doc test marked `/// @id TEST-.. @verifies REQ-..` gets Red/Green evidence via cargo test --doc', { skip: !has130('cargo') }, () => {
  const d = batch2Source('src/lib.rs', '// @id CODE-CALC-001 @implements REQ-CALC-001\n/// Answer.\n///\n/// @id TEST-CALC-001 @verifies REQ-CALC-001\n/// ```\n/// assert_eq!(docprobe::answer(), 7);\n/// ```\npub fn answer() -> i32 { 0 }\n');
  writeAll(d, { 'Cargo.toml': '[package]\nname="docprobe"\nversion="0.1.0"\nedition="2021"\n' });
  fs.writeFileSync(path.join(d, '.sdd/config.json'), JSON.stringify({ testCmd: ['cargo', 'test', '--lib', '{idu}'], checks: [] }));
  const red = sdd(d, 'tdd', 'red', 'TEST-CALC-001');
  assert.equal(red.code, 0, red.out);
  fs.writeFileSync(path.join(d, 'src/lib.rs'), rd130(d, 'src/lib.rs').replace('{ 0 }', '{ 7 }'));
  const green = sdd(d, 'tdd', 'green', 'TEST-CALC-001');
  assert.equal(green.code, 0, green.out);
  const tr = sdd(d, 'trace');
  assert.doesNotMatch(tr.out, /TEST-CALC-001[^\n]*(missing|no evidence)/i, tr.out);
});

// ---- #288 (Rust): return types from usage, traits, generics, macros, builder chains ----
const rs288 = (body, extra = {}) => rs268({ 'src/lib.rs': '', 'tests/x.rs': `${body}\n`, ...extra });
const t288 = (inner) => `// @id TEST-H-001 @verifies REQ-H-001\n#[test]\nfn test_h_001() {\n${inner}\n}\n`;
const stub288 = (d) => { const r = sdd(d, 'tdd', 'stub', 'TEST-H-001'); return { out: r.out, lib: fs.readFileSync(path.join(d, 'src/lib.rs'), 'utf8') }; };

test('#288 Rust stub: return types come from .len(), indexing, Option<&T>, Ok(())/Err(..) and comparisons', has268, () => {
  const d = rs288('use hist::{count, field, first, check, big};\n\n' + t288('    assert_eq!(count(&[1]).len(), 2);\n    assert_eq!(field(1)["k"], 3);\n    assert_eq!(first(1), Some(&5));\n    assert_eq!(check(1), Ok(()));\n    assert!(big(1) > 0);'));
  const { out, lib } = stub288(d);
  assert.match(lib, /fn count<A0>\(_a0: A0\) -> Vec<i64>/, lib);
  assert.match(lib, /fn field<A0>\(_a0: A0\) -> std::collections::HashMap<String, i64>/, lib);
  assert.match(lib, /fn first<A0>\(_a0: A0\) -> Option<&'static i64>/, lib);
  assert.match(lib, /fn check<A0>\(_a0: A0\) -> Result<\(\), String>/, lib);
  assert.match(lib, /fn big<A0>\(_a0: A0\) -> i64/, lib);
  assert.match(out, /compile-checked/, out);
});

test('#288 Rust stub: `impl Trait for X` in the test generates the trait with its associated types and method signatures', has268, () => {
  const d = rs288('use hist::Store;\n\nstruct Mem;\nimpl Store for Mem {\n    type Item = u8;\n    const CAP: usize = 4;\n    fn put(&mut self, mut v: u8) -> usize {\n        v as usize\n    }\n}\n\n' + t288('    let mut m = Mem;\n    assert_eq!(m.put(1), 1);'));
  const { out, lib } = stub288(d);
  assert.match(lib, /pub trait Store \{/, lib);
  assert.match(lib, /type Item;/, lib);
  assert.match(lib, /const CAP: usize;/, lib);
  assert.match(lib, /fn put\(&mut self, v: u8\) -> usize;/, lib);
  assert.match(out, /compile-checked/, out);
});

test('#288 Rust stub: explicit generic args and lifetimes generate generic types and fns', has268, () => {
  const d = rs288('use hist::{Log, conv};\n\n' + t288("    let _l: Log<u8, &'static str> = Log::<u8, &'static str>::new();\n    let v = conv::<u8>(3);\n    assert_eq!(v, 3);"));
  const { out, lib } = stub288(d);
  assert.match(lib, /pub struct Log<T0, T1>/, lib);
  assert.match(lib, /impl<T0, T1> Log<T0, T1>/, lib);
  assert.match(lib, /fn conv<T>\(_a0: impl Sized\) -> i64/, lib);
  assert.doesNotMatch(lib, /unimplemented!\("Log::new"\)/, lib);
  assert.match(out, /compile-checked/, out);
});

test('#288 Rust stub: an imported macro_rules! macro gets an exported throwing stub, not a fn', has268, () => {
  const d = rs288('use hist::entries;\n\n' + t288('    let _v = entries![1, 2];'));
  const { out, lib } = stub288(d);
  assert.match(lib, /#\[macro_export\]\nmacro_rules! entries/, lib);
  assert.match(lib, /unimplemented!\("entries!"\)/, lib);
  assert.doesNotMatch(lib, /fn entries/, lib);
  assert.match(out, /compile-checked/, out);
});

test('#288 Rust stub: builder chains get by-value methods returning Self, the last one throws with its inferred type', has268, () => {
  const d = rs288('use hist::Req;\n\n' + t288('    let r = Req::builder().path("/a").retries(3).build();\n    assert_eq!(r, 1);'));
  const { out, lib } = stub288(d);
  assert.match(lib, /pub fn path<A0>\(self, _a0: A0\) -> Self/, lib);
  assert.match(lib, /pub fn retries<A0>\(self, _a0: A0\) -> Self/, lib);
  assert.match(out, /compile-checked/, out);
});

// ---- r13b (#288 Python residuals) ----
const R13SPEC = '---\nfeature: w\ntier: T1\napproval: auto\n---\n| REQ-W-001 | g shall hold. | TEST-W-001 |\n';

test('#288 a type-only typing.Protocol import is stubbed as a Protocol, not a plain class', () => {
  const d = mini(R13SPEC, {
    'pyproject.toml': '[tool.pytest.ini_options]\npythonpath = ["src"]\n',
    'tests/test_w.py': 'from netsim.rng import Rng\n\n\ndef draw(r: Rng) -> int:\n    return 1\n\n\n# @id TEST-W-001 @verifies REQ-W-001\ndef test_w_001():\n    assert draw(None) == 1\n',
  });
  sdd(d, 'tdd', 'stub', 'TEST-W-001');
  const s = fs.readFileSync(path.join(d, 'src/netsim/rng.py'), 'utf8');
  assert.match(s, /from typing import Protocol/, s);
  assert.match(s, /class Rng\(Protocol\)/, s);
});

test('#288 imports made inside conftest.py fixtures are stubbed', () => {
  const d = mini(R13SPEC, {
    'tests/conftest.py': 'import pytest\n\n\n@pytest.fixture\ndef table():\n    from bcdis.table import OpTable\n    return OpTable()\n',
    'tests/test_w.py': '# @id TEST-W-001 @verifies REQ-W-001\ndef test_w_001(table):\n    assert table.size() == 1\n',
  });
  const r = sdd(d, 'tdd', 'stub', 'TEST-W-001');
  assert.ok(fs.existsSync(path.join(d, 'bcdis/table.py')), r.out);
  assert.match(fs.readFileSync(path.join(d, 'bcdis/table.py'), 'utf8'), /class OpTable/);
});

test('#288 "nothing to stub" for absolute imports says what was checked', () => {
  const d = mini(R13SPEC, {
    'tests/test_w.py': 'import json\nfrom os import path\n\n\n# @id TEST-W-001 @verifies REQ-W-001\ndef test_w_001():\n    assert json and path\n',
  });
  const r = sdd(d, 'tdd', 'stub', 'TEST-W-001');
  assert.doesNotMatch(r.out, /no missing relative imports/, r.out);
  assert.match(r.out, /checked 1 .*import/i, r.out);
});

test('#288 subprocess-subject test: stub prints a note; Red works without --weak on a genuine non-zero exit', () => {
  const d = mini(R13SPEC, {
    'tests/test_w.py': 'import subprocess\n\n\n# @id TEST-W-001 @verifies REQ-W-001\ndef test_w_001():\n    r = subprocess.run(["node", "cli.ts"], capture_output=True, text=True)\n    assert r.returncode == 0\n',
  }, ['python3', '-m', 'pytest', '-q', '{file}', '-k', '{idu}']);
  const s = sdd(d, 'tdd', 'stub', 'TEST-W-001');
  assert.match(s.out, /subprocess/, s.out);
  const r = sdd(d, 'tdd', 'red', 'TEST-W-001');
  assert.equal(r.code, 0, r.out);
  assert.doesNotMatch(r.out, /weak/i, r.out);
});

// ---- #290 (Rust stub: honest messages, enum variants, inline tests, annotations) ----
test('#290 Rust stub: a missing variant is added to the existing enum', has268, () => {
  const d = rs288('use hist::SchedError;\n\n' + t288('    assert_eq!(SchedError::ZeroLimit, SchedError::ZeroLimit);'), { 'src/lib.rs': '#[derive(Debug, Clone, Copy, PartialEq, Eq)]\npub enum SchedError {\n    Empty,\n}\n' });
  const { out, lib } = stub288(d);
  assert.match(lib, /enum SchedError \{\n    Empty,\n    ZeroLimit,\n\}/, lib);
  assert.match(out, /added variant SchedError::ZeroLimit/, out);
});

test('#290 Rust stub: an inline #[cfg(test)] test says why nothing is stubbed', has268, () => {
  const d = rs268({ 'src/lib.rs': 'pub fn f() -> i64 { 1 }\n#[cfg(test)]\nmod tests {\n    use super::*;\n    // @id TEST-H-001 @verifies REQ-H-001\n    #[test]\n    fn t() { assert_eq!(f(), 1); }\n}\n' });
  const r = sdd(d, 'tdd', 'stub', 'TEST-H-001');
  assert.match(r.out, /inline in the subject file/, r.out);
});

test('#290 Rust stub: a new stub file carries @id CODE-…-STUB / @implements', has268, () => {
  const d = rs288('use hist::geo::Point;\n\n' + t288('    let p = Point { x: 1 };\n    assert_eq!(p.x, 1);'));
  stub288(d);
  const f = fs.readFileSync(path.join(d, 'src/geo.rs'), 'utf8');
  assert.match(f, /^\/\/ @id CODE-H-001-STUB-001 @implements REQ-H-001\n/, f);
});

test('#291 python stub: `from pkg import mod` used as mod.f() stubs pkg/mod.py, not def mod in the package', () => {
  const d = mini(R13SPEC, {
    'pyproject.toml': '[tool.pytest.ini_options]\npythonpath = ["src"]\n',
    'tests/test_w.py': 'from lsmtool import codec\n\n\n# @id TEST-W-001 @verifies REQ-W-001\ndef test_w_001():\n    assert codec.encode(1) == 1\n',
  });
  sdd(d, 'tdd', 'stub', 'TEST-W-001');
  const f = path.join(d, 'src/lsmtool/codec.py');
  assert.ok(fs.existsSync(f), 'codec.py missing');
  assert.match(fs.readFileSync(f, 'utf8'), /def encode/);
  const init = path.join(d, 'src/lsmtool/__init__.py');
  assert.ok(!fs.existsSync(init) || !/def codec/.test(fs.readFileSync(init, 'utf8')));
  assert.ok(!fs.existsSync(path.join(d, 'src/lsmtool.py')));
});

test('#291 python stub: a collection-time (parametrize) stub failure gets an actionable hint', () => {
  const d = mini(R13SPEC, {
    'tests/test_w.py': 'import pytest\nfrom shapes import square\n\n\n# @id TEST-W-001 @verifies REQ-W-001\n@pytest.mark.parametrize("v,w", [(square(2), 4)])\ndef test_w_001(v, w):\n    assert v == w\n',
  }, ['python3', '-m', 'pytest', '-q', '{file}', '-k', '{idu}']);
  sdd(d, 'tdd', 'stub', 'TEST-W-001');
  const r = sdd(d, 'tdd', 'red', 'TEST-W-001');
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /parametrize/i, r.out);
  assert.match(r.out, /inside the test/i, r.out);
});

test('#291 python stub: a helper module next to the test file is not duplicated under src/', () => {
  const d = mini(R13SPEC, {
    'pyproject.toml': '[tool.pytest.ini_options]\npythonpath = ["src", "tools"]\n',
    'tests/helper_io.py': 'def make(x):\n    return x\n',
    'tests/test_w.py': 'from helper_io import make\n\n\n# @id TEST-W-001 @verifies REQ-W-001\ndef test_w_001():\n    assert make(1) == 1\n',
  });
  sdd(d, 'tdd', 'stub', 'TEST-W-001');
  assert.ok(!fs.existsSync(path.join(d, 'src/helper_io.py')));
});

test('#291 python stub files carry a CODE-…-STUB-001 @implements annotation', () => {
  const d = mini(R13SPEC, {
    'tests/test_w.py': 'from netsim.rng import Rng\n\n\n# @id TEST-W-001 @verifies REQ-W-001\ndef test_w_001():\n    assert Rng().x() == 1\n',
  });
  sdd(d, 'tdd', 'stub', 'TEST-W-001');
  assert.match(fs.readFileSync(path.join(d, 'netsim/rng.py'), 'utf8'), /^# @id CODE-W-001-STUB-001 @implements REQ-W-001\n/);
});

const R14C_PY = ['python3', '-m', 'pytest', '-q', '{file}', '-k', '{idu}'];
const r14c = (src, body) => mini(W11SPEC(1), {
  'src/m.py': src,
  'tests/test_w.py': `import sys\nsys.path.insert(0, "src")\nfrom m import *\n\n\n# @id TEST-W-001 @verifies REQ-W-001\ndef test_w_001():\n    ${body}\n`,
}, R14C_PY);

test('#292 a stubbed SUT call passed to an assert helper is the act, not setup', () => {
  const d = r14c('def chk(v):\n    assert v == 1\n\n\ndef act(x):\n    raise NotImplementedError("act")\n', 'chk(act(1))');
  const r = sdd(d, 'tdd', 'red', 'TEST-W-001');
  assert.match(r.out, /RED ok/, r.out);
  assert.doesNotMatch(r.out, /\[weak\]|setup call/, r.out);
});

test('#292 a `with X(...)` that fails on __enter__ is flagged as a setup Red', () => {
  const d = r14c('class Cli:\n    def __init__(self, p):\n        pass\n\n    def get(self, k):\n        return 1\n', 'with Cli("p") as c:\n        assert c.get("k") == 1');
  const r = sdd(d, 'tdd', 'red', 'TEST-W-001');
  assert.match(r.out, /\[weak\]/, r.out);
  assert.match(r.out, /setup call "Cli"/, r.out);
});

test('#292 a name only derived from the stack (never in the test) is not reported as a setup call', () => {
  const out = '--- FAIL: TestCalc (0.00s)\npanic: nyi: next [recovered]\n\ngoroutine 7 [running]:\nexample.com/x.(*It).next(...)\n\t/x/calc.go:3 +0x1\n';
  const r = weak263(['  const v = 1;', '  assert.equal(v, 1);'], out);
  assert.doesNotMatch(r.out, /\[weak\]|setup call/, r.out);
});

test('#292 destructured results of the asserted call are not setup, like plain assignment', () => {
  for (const bind of ['const [a, b] = add(1);', 'const { a, b } = add(1);']) {
    const d = approved();
    fs.writeFileSync(path.join(d, 'add.mjs'), "export const add = () => { throw new Error('not implemented: add'); };\n");
    testFile(d, [`  ${bind}`, '  assert.equal(a, b);']);
    const r = sdd(d, 'tdd', 'red', 'TEST-CALC-001');
    assert.doesNotMatch(r.out, /\[weak\]|setup call/, `${bind}\n${r.out}`);
  }
});

test('#293 config `generated` removes build outputs from the oracle: regenerating them does not refuse Green', () => {
  const spec = '---\nfeature: a\ntier: T1\n---\n| REQ-A-001 | x shall hold. | TEST-A-001 |\n';
  const d = mini(spec, { 'a.test.mjs': '// @id TEST-A-001 @verifies REQ-A-001\n// body\n', 'contract/vec.json': '[1]\n' }, FAIL);
  const cp = path.join(d, '.sdd/config.json');
  const c = JSON.parse(fs.readFileSync(cp, 'utf8'));
  c.artifacts = { 'contract/vec.json': ['a.test.mjs'] };
  c.generated = ['contract/**'];
  fs.writeFileSync(cp, JSON.stringify(c));
  assert.equal(sdd(d, 'tdd', 'red', 'TEST-A-001').code, 0);
  fs.writeFileSync(path.join(d, 'contract/vec.json'), '[1,2]\n');
  setCmd(d, PASS);
  const r = sdd(d, 'tdd', 'green', 'TEST-A-001');
  assert.equal(r.code, 0, r.out);
});

test('#293 editing only [src: file:line] provenance of a REQ does not invalidate its Green', () => {
  const spec = (n) => `---\nfeature: a\ntier: T1\n---\n| REQ-A-001 | x shall hold. [src: lib.rs:${n}] | TEST-A-001 |\n`;
  const d = mini(spec(10), { 'a.test.mjs': '// @id TEST-A-001 @verifies REQ-A-001\n// body\n' }, FAIL);
  assert.equal(sdd(d, 'tdd', 'red', 'TEST-A-001').code, 0);
  setCmd(d, PASS);
  assert.equal(sdd(d, 'tdd', 'green', 'TEST-A-001').code, 0);
  const sp = fs.readdirSync(path.join(d, '.sdd/specs')).map((f) => path.join(d, '.sdd/specs', f))[0];
  fs.writeFileSync(sp, spec(42));
  const g = sdd(d, 'gate', '--no-run').out;
  assert.doesNotMatch(g, /spec changed|requirement changed|REQ-A-001[^\n]*changed/i, g);
});

// ---- wave 12 (#294): impact parity one hop, producers, --all ----
test('#294 impact: parity reaches the counterpart but not its importers', () => {
  const d = mini('---\nfeature: a\ntier: T1\n---\n| REQ-A-001 | x shall work. | TEST-A-001 |\n', {
    '.sdd/specs/b.md': '---\nfeature: b\ntier: T1\n---\n| REQ-B-001 | y shall work. | TEST-B-001 |\n',
    '.sdd/specs/c.md': '---\nfeature: c\ntier: T1\n---\n| REQ-C-001 | z shall work. | TEST-C-001 |\n',
    'ts/u.ts': '// @id CODE-A-001 @implements REQ-A-001\nexport const u = 1;\n',
    'py/u.py': '# @id CODE-B-001 @implements REQ-B-001\nu = 1\n',
    'py/user.py': '# @id CODE-C-001 @implements REQ-C-001\nfrom u import u\n',
  });
  const cp = path.join(d, '.sdd/config.json');
  const c = JSON.parse(fs.readFileSync(cp, 'utf8'));
  c.parity = [['ts/u.ts', 'py/u.py']];
  fs.writeFileSync(cp, JSON.stringify(c));
  const r = sdd(d, 'impact', 'ts/u.ts');
  assert.match(r.out, /REQ-B-001/, r.out);
  assert.doesNotMatch(r.out, /REQ-C-001/, r.out);
});

test('#294 impact: artifact file lists its producers', () => {
  const d = mini('---\nfeature: a\ntier: T1\n---\n| REQ-A-001 | x shall work. | TEST-A-001 |\n', {
    'contract/f.json': '{}\n',
    'rust/build.rs': 'fn main() { std::fs::write("contract/f.json", "{}").unwrap(); }\n',
  });
  const r = sdd(d, 'impact', 'contract/f.json');
  assert.match(r.out, /producers: .*rust\/build\.rs/, r.out);
});

test('#294 impact --all disables the +N more truncation', () => {
  const files = { 'src/a.ts': '// @id CODE-A-001 @implements REQ-A-001\nexport const a = 1;\n' };
  let spec = '---\nfeature: b\ntier: T1\n---\n';
  for (let i = 1; i <= 12; i++) {
    const n = String(i).padStart(3, '0');
    spec += `| REQ-B-${n} | y shall work. | TEST-B-${n} |\n`;
    files[`src/m${i}.ts`] = `// @id CODE-B-${n} @implements REQ-B-${n}\nimport { a } from './a';\nexport const m${i} = a;\n`;
  }
  files['.sdd/specs/b.md'] = spec;
  const d = mini('---\nfeature: a\ntier: T1\n---\n| REQ-A-001 | x shall work. | TEST-A-001 |\n', files);
  assert.match(sdd(d, 'impact', 'src/a.ts').out, /\+\d+ more/);
  const all = sdd(d, 'impact', 'src/a.ts', '--all').out;
  assert.doesNotMatch(all, /\+\d+ more/, all);
  assert.match(all, /REQ-B-012/, all);
});

test('#295 design-lines message says non-blank lines', () => {
  const d = mini('---\nfeature: a\ntier: T2\n---\n## Design\nOne. Two sentences here.\n\n## Requirements\n| REQ-A-001 | x shall work. | TEST-A-001 |\n');
  assert.match(sdd(d, 'approve', 'record', 'a', '--by', 'x').out, /non-blank lines/);
});

test('#295 approve prepare prints requirements once', () => {
  const d = mini('---\nfeature: a\ntier: T1\n---\n| REQ-A-001 | x shall work. | TEST-A-001 |\n');
  const out = sdd(d, 'approve', 'prepare', 'a').out;
  assert.equal(out.split('\n').filter((l) => l.startsWith('requirements:')).length, 1, out);
});

test('#295 review check <feature> infers .sdd/review-<feature>.md', () => {
  const d = mini('---\nfeature: a\ntier: T1\n---\n| REQ-A-001 | x shall work. | TEST-A-001 |\n');
  const r = sdd(d, 'review', 'check', 'a');
  assert.match(r.out, /review-a\.md/, r.out);
  assert.doesNotMatch(r.out, /^usage/, r.out);
});

test('#295 a [src:] reverse-spec row is not warned about missing @implements', () => {
  const d = mini('---\nfeature: a\ntier: T1\n---\n| REQ-A-001 | x shall work. [src: old.py:1] | TEST-A-001 |\n', { 'old.py': 'x = 1\n', 'a.test.mjs': '// @id TEST-A-001 @verifies REQ-A-001\n' }, FAIL);
  assert.equal(sdd(d, 'tdd', 'red', 'TEST-A-001').code, 0);
  setCmd(d, PASS);
  assert.doesNotMatch(sdd(d, 'tdd', 'green', 'TEST-A-001').out, /no code carries @implements/);
});

test('#295 trace lists deferred REQ IDs', () => {
  const d = mini('---\nfeature: a\ntier: T1\n---\n| REQ-A-001 | one shall hold. | TEST-A-001 |\n| REQ-A-002 (deferred) | Later. | — |\n', { 'a.test.mjs': '// @id TEST-A-001 @verifies REQ-A-001\n' }, PASS);
  assert.match(sdd(d, 'trace').out, /deferred: REQ-A-002/);
});

test('#295 shared-impl warning names the refactor command with all stale IDs', () => {
  const d = blockProject();
  touchImpl(d, 'return 1;', 'return 11;');
  assert.match(sdd(d, 'tdd', 'green', 'TEST-A-002').out, /tdd refactor TEST-A-001/);
});

test('#295 batch tdd red prints an identical compiler tail once', () => {
  const spec = '---\nfeature: a\ntier: T1\n---\n| REQ-A-001 | x shall work. | TEST-A-001 |\n| REQ-A-002 | y shall work. | TEST-A-002 |\n';
  const d = mini(spec, { 'a.test.mjs': '// @id TEST-A-001 @verifies REQ-A-001\n// @id TEST-A-002 @verifies REQ-A-002\n' }, ['node', '-e', 'console.log("a\\nb\\nc\\nd\\ne\\nerror TS2304: Cannot find name x");process.exit(1)']);
  const out = sdd(d, 'tdd', 'red', 'TEST-A-001', 'TEST-A-002').out;
  assert.equal(out.split('error TS2304').length - 1, 1, out);
});

const r15b = (src, body) => {
  const d = r14c(src, body);
  const r = sdd(d, 'tdd', 'red', 'TEST-W-001');
  return r.out;
};
const STUBS15 = 'class C:\n    def push(self, v):\n        raise NotImplementedError("push")\n\n    def size(self):\n        return 0\n\n\ndef fill(x, out):\n    raise NotImplementedError("fill")\n\n\ndef run(x):\n    raise NotImplementedError("run")\n';

test('#299 out-parameter act: the stub filling an out argument that is asserted is the act', () => {
  const out = r15b(STUBS15, 'buf = []\n    fill(3, buf)\n    n = 1\n    assert buf == [3]');
  assert.doesNotMatch(out, /\[weak\]|setup call/, out);
});

test('#299 mutator then bound query: the stub mutator is the act', () => {
  const out = r15b(STUBS15, 'c = C()\n    c.push(1)\n    n = c.size()\n    assert n == 1');
  assert.doesNotMatch(out, /\[weak\]|setup call/, out);
});

test('#299 local helper wrapper whose bare call precedes state assertions is the act', () => {
  const d = mini(W11SPEC(1), {
    'src/m.py': STUBS15,
    'tests/test_w.py': 'import sys\nsys.path.insert(0, "src")\nfrom m import *\n\n\ndef go(out):\n    fill(1, out)\n\n\n# @id TEST-W-001 @verifies REQ-W-001\ndef test_w_001():\n    out = []\n    go(out)\n    assert out == [1]\n',
  }, R14C_PY);
  const out = sdd(d, 'tdd', 'red', 'TEST-W-001').out;
  assert.doesNotMatch(out, /\[weak\]|setup call/, out);
});

test('#299 trait/operator sugar (.parse(), |, .to_string()) never names the stubbed from_str/bitor/fmt: not a setup call', () => {
  for (const name of ['from_str', 'bitor', 'fmt']) {
    const r = weak263(['  const v = "1".parse();', '  assert.equal(v, 1);'], `thread 'x' panicked at src/lib.rs:3:5:\nnot implemented: ${name}\n`);
    assert.doesNotMatch(r.out, /\[weak\]|setup call/, `${name}\n${r.out}`);
  }
});

const SPEC2 = '---\nfeature: a\ntier: T1\n---\n| REQ-A-001 | x shall work. | TEST-A-001 |\n| REQ-A-002 | y shall work. | TEST-A-002 |\n';
const greenBoth = (files) => {
  const d = mini(SPEC2, files, FAIL);
  assert.equal(sdd(d, 'tdd', 'red', 'TEST-A-001').code, 0);
  assert.equal(sdd(d, 'tdd', 'red', 'TEST-A-002').code, 0);
  setCmd(d, PASS);
  assert.equal(sdd(d, 'tdd', 'green', 'TEST-A-001').code, 0);
  assert.equal(sdd(d, 'tdd', 'green', 'TEST-A-002').code, 0);
  return d;
};

test('#300 a comment-only CODE annotation added to the test file does not stale its tests', () => {
  const T = '// @id TEST-A-001 @verifies REQ-A-001\nit(1);\n\n// @id TEST-A-002 @verifies REQ-A-002\nit(2);\n';
  const d = greenBoth({ 'a.test.mjs': 'const helper = 1;\n\n' + T });
  fs.writeFileSync(path.join(d, 'a.test.mjs'), 'const helper = 1;\n\n// @id TEST-A-001 @verifies REQ-A-001\n// @id CODE-A-001 @implements REQ-A-001\nit(1);\n\n// @id TEST-A-002 @verifies REQ-A-002\nit(2);\n');
  const r = sdd(d, 'gate', '--no-run');
  assert.doesNotMatch(r.out, /test changed since/, r.out);
});

test('#300 a shared-preamble edit hints tdd refactor, not --retest', () => {
  const T = '// @id TEST-A-001 @verifies REQ-A-001\nit(1);\n\n// @id TEST-A-002 @verifies REQ-A-002\nit(2);\n';
  const d = greenBoth({ 'a.test.mjs': 'const helper = 1;\n\n' + T });
  fs.writeFileSync(path.join(d, 'a.test.mjs'), 'const helper = 2;\n\n' + T);
  const r = sdd(d, 'gate', '--no-run');
  assert.match(r.out, /own lines did not.*tdd refactor TEST-A-001/, r.out);
});

test('#301 impact reaches REQs of a project that dependsOn the changed code\'s project', () => {
  const d = mini('---\nfeature: a\ntier: T1\n---\n| REQ-A-001 | x shall work. | TEST-A-001 |\n', {
    '.sdd/specs/b.md': '---\nfeature: b\ntier: T1\n---\n| REQ-B-001 | y shall work. | TEST-B-001 |\n',
    'core/lib.rs': '// @id CODE-A-001 @implements REQ-A-001\nfn f() {}\n',
    'py/test_b.py': '# @id TEST-B-001 @verifies REQ-B-001\ndef test_b():\n    pass\n',
  });
  const cp = path.join(d, '.sdd/config.json');
  const c = JSON.parse(fs.readFileSync(cp, 'utf8'));
  c.projects = [{ root: 'core', testCmd: ['true'], checks: [] }, { root: 'py', dependsOn: ['core'], testCmd: ['true'], checks: [] }];
  fs.writeFileSync(cp, JSON.stringify(c));
  const j = JSON.parse(sdd(d, 'impact', 'REQ-A-001', '--json').out);
  assert.ok(j.otherReqs.some((x) => x.req === 'REQ-B-001'), JSON.stringify(j));
});

test('#301 gate --changed runs a project check when only its feature spec changed', () => {
  const d = mini('---\nfeature: a\ntier: T1\n---\n| REQ-A-001 | x shall work. | TEST-A-001 |\n', {
    'py/test_a.py': '# @id TEST-A-001 @verifies REQ-A-001\ndef test_a():\n    pass\n',
  });
  const git = (...a) => spawnSync('git', a, { cwd: d });
  git('config', 'user.email', 'a@b'); git('config', 'user.name', 't');
  const cp = path.join(d, '.sdd/config.json');
  const c = JSON.parse(fs.readFileSync(cp, 'utf8'));
  c.projects = [{ root: 'py', checks: [{ name: 't', cmd: ['node', '-e', '0'], changedCmd: ['node', '-e', '0'] }] }];
  fs.writeFileSync(cp, JSON.stringify(c));
  git('add', '-A'); git('commit', '-qm', 'base');
  fs.appendFileSync(path.join(d, '.sdd/specs/a.md'), '\n');
  const out = sdd(d, 'gate', '--changed').out;
  assert.match(out, /✓ cmd py:t/, out);
});

test('#302 tdd refactor on T1 after a test change needs --wording', () => {
  const d = mini('---\nfeature: a\ntier: T1\n---\n| REQ-A-001 | x shall work. | TEST-A-001 |\n', { 'a.test.mjs': '// @id TEST-A-001 @verifies REQ-A-001\n' }, FAIL);
  assert.equal(sdd(d, 'tdd', 'red', 'TEST-A-001').code, 0);
  setCmd(d, PASS);
  assert.equal(sdd(d, 'tdd', 'green', 'TEST-A-001').code, 0);
  fs.writeFileSync(path.join(d, 'a.test.mjs'), '// @id TEST-A-001 @verifies REQ-A-001\n// changed assertion\n');
  const r = sdd(d, 'tdd', 'refactor', 'TEST-A-001');
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /--wording/);
  assert.equal(sdd(d, 'tdd', 'refactor', 'TEST-A-001', '--wording', 'rename only').code, 1);
});

test('#302 gate trace line names deferred REQs', () => {
  const d = mini('---\nfeature: a\ntier: T1\n---\n| REQ-A-001 | one shall hold. | TEST-A-001 |\n| REQ-A-002 (deferred) | Later. | — |\n', { 'a.test.mjs': '// @id TEST-A-001 @verifies REQ-A-001\n' }, PASS);
  assert.match(sdd(d, 'gate', '--no-run').out, /deferred, not tested: REQ-A-002/);
});

test('#302 a TS transform/compile error on green is reported as a load error', () => {
  const d = mini('---\nfeature: a\ntier: T1\n---\n| REQ-A-001 | x shall work. | TEST-A-001 |\n', { 'a.test.mjs': '// @id TEST-A-001 @verifies REQ-A-001\n' }, FAIL);
  assert.equal(sdd(d, 'tdd', 'red', 'TEST-A-001').code, 0);
  setCmd(d, ['node', '-e', 'console.log("TSError: ⨯ Unable to compile TypeScript:\\nbad syntax");process.exit(1)']);
  assert.match(sdd(d, 'tdd', 'green', 'TEST-A-001').out, /load\/compile error/);
});

// ---- r15a (#298): Rust stub — include!/macro types, Default, associated items, throwing bodies ----
test('#298 Rust stub: a type a module defines via include!/macro is not appended again', has268, () => {
  const d = rs288('use hist::gen::Kind;\n\n' + t288('    assert_eq!(Kind::A, Kind::A);'), {
    'src/lib.rs': 'pub mod gen;\n',
    'src/gen.rs': 'include!("kind.rs");\n',
    'src/kind.rs': '#[derive(Debug, PartialEq)]\npub enum Kind {\n    A,\n}\n',
  });
  stub288(d);
  const g = fs.readFileSync(path.join(d, 'src/gen.rs'), 'utf8');
  assert.doesNotMatch(g, /pub enum Kind/, g);
});

test('#298 Rust stub: T::default() on a derive(Default) type adds no fn default to its impl', has268, () => {
  const d = rs288('use hist::geo::Cfg;\n\n' + t288('    let c = Cfg::default();\n    assert_eq!(c.size(), 0);'), {
    'src/lib.rs': 'pub mod geo;\n',
    'src/geo.rs': '#[derive(Debug, Default)]\npub struct Cfg;\n\nimpl Cfg {\n    pub fn other(&self) -> i64 { 1 }\n}\n',
  });
  stub288(d);
  const g = fs.readFileSync(path.join(d, 'src/geo.rs'), 'utf8');
  assert.doesNotMatch(g, /fn default/, g);
  assert.match(g, /fn size/, g);
});

test('#298 Rust stub: an associated const on an existing enum is not added as a variant', has268, () => {
  const d = rs288('use hist::Mode;\n\n' + t288('    assert_eq!(Mode::MAX, 3);\n    assert_eq!(Mode::A, Mode::A);'), {
    'src/lib.rs': '#[derive(Debug, PartialEq)]\npub enum Mode {\n    A,\n}\n',
  });
  const { lib } = stub288(d);
  assert.doesNotMatch(lib, /^\s*MAX\b/m, lib);
});

function flakyProject(flaky, cmdBody) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-flaky-'));
  spawnSync('git', ['init', '-q'], { cwd: d });
  fs.mkdirSync(path.join(d, '.sdd/specs'), { recursive: true });
  fs.writeFileSync(path.join(d, '.sdd/config.json'), JSON.stringify({ checks: [{ name: 'test', cmd: ['node', '-e', cmdBody] }], ...(flaky ? { flaky } : {}) }));
  return d;
}
const FLAKY_ONCE = "const f=require('fs');if(f.existsSync('m'))process.exit(0);f.writeFileSync('m','1');console.log('AssertionError: flaky');process.exit(1)";

test('#303 a test check that fails once and passes on re-run is reported as flaky suspected and still fails by default', () => {
  const d = flakyProject(null, FLAKY_ONCE);
  const r = sdd(d, 'gate');
  assert.match(r.out, /✗ cmd test FLAKY suspected: failed on the first run, passed on re-run 1\/1/);
  assert.match(r.out, /SDD GATE FAIL/);
});

test('#303 flaky.policy "warn" accepts a flaky suspected re-run pass', () => {
  const d = flakyProject({ policy: 'warn' }, FLAKY_ONCE);
  const r = sdd(d, 'gate');
  assert.match(r.out, /✓ cmd test FLAKY suspected/);
  assert.match(r.out, /accepted by flaky.policy "warn"/);
});

test('#303 a consistently failing test check is a plain failure and flaky.retries 0 disables the re-run', () => {
  const always = 'console.log("AssertionError: real");process.exit(1)';
  assert.doesNotMatch(sdd(flakyProject(null, always), 'gate').out, /FLAKY/);
  assert.match(sdd(flakyProject(null, always), 'gate').out, /✗ cmd test \(/);
  assert.doesNotMatch(sdd(flakyProject({ retries: 0 }, FLAKY_ONCE), 'gate').out, /FLAKY/);
});

test('#305 python stub: a class used as a dict value is instantiable, not a Protocol', () => {
  const d = mini(R13SPEC, {
    'tests/test_w.py': 'from kit import Alpha, Beta\n\nREG = {"a": Alpha, "b": Beta}\n\n\n# @id TEST-W-001 @verifies REQ-W-001\ndef test_w_001():\n    assert REG["a"]().go() == 1\n',
  });
  sdd(d, 'tdd', 'stub', 'TEST-W-001');
  const t = fs.readFileSync(path.join(d, 'kit.py'), 'utf8');
  assert.doesNotMatch(t, /Protocol/);
  assert.match(t, /class Alpha:/);
});

test('#305 python stub: a class used in `with` gets __enter__/__exit__', () => {
  const d = mini(R13SPEC, {
    'tests/test_w.py': 'from kit import Ctx\n\n\n# @id TEST-W-001 @verifies REQ-W-001\ndef test_w_001():\n    with Ctx(1) as c:\n        assert c.v == 1\n',
  });
  sdd(d, 'tdd', 'stub', 'TEST-W-001');
  const t = fs.readFileSync(path.join(d, 'kit.py'), 'utf8');
  assert.match(t, /def __enter__/);
  assert.match(t, /def __exit__/);
});

test('#305 python stub: a missing module goes where config `artifacts` maps it', () => {
  const d = mini(R13SPEC, {
    'py/src/keep.py': 'X = 1\n',
    'py/tests/test_w.py': 'from kit import f\n\n\n# @id TEST-W-001 @verifies REQ-W-001\ndef test_w_001():\n    assert f() == 1\n',
  });
  const cfg = path.join(d, '.sdd/config.json');
  const c = JSON.parse(fs.readFileSync(cfg, 'utf8'));
  c.artifacts = { 'py/tools/kit.py': ['py/tests/test_w.py'] };
  fs.writeFileSync(cfg, JSON.stringify(c));
  sdd(d, 'tdd', 'stub', 'TEST-W-001');
  assert.ok(fs.existsSync(path.join(d, 'py/tools/kit.py')), 'py/tools/kit.py missing');
  assert.ok(!fs.existsSync(path.join(d, 'py/src/kit.py')));
});

test('#305 TS stub: a .cjs module loaded through createRequire is created', () => {
  const d = jsStubProject({
    'test/a.test.ts': "import { createRequire } from 'node:module';\nconst req = createRequire(import.meta.url);\nconst { add } = req('../src/add.cjs');\n/** @id TEST-A-001 @verifies REQ-A-001 */\nit('TEST-A-001 adds', () => { add(1, 2); });\n",
  });
  sdd(d, 'tdd', 'stub', 'TEST-A-001');
  assert.ok(fs.existsSync(path.join(d, 'src/add.cjs')), 'add.cjs missing');
});

test('#306 a passing Red of a test-only REQ is recorded as characterization without the flag', () => {
  const d = mini(T1SPEC.replace('one shall hold.', 'one shall hold. (test-only)'), { 'a.test.mjs': jsTest() }, PASS);
  const r = sdd(d, 'tdd', 'red', 'TEST-A-001');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /characterization/);
  assert.equal(sdd(d, 'tdd', 'green', 'TEST-A-001').code, 0);
});

test('#306 a passing Red of a normal REQ is still rejected', () => {
  const d = mini(T1SPEC, { 'a.test.mjs': jsTest() }, PASS);
  assert.equal(sdd(d, 'tdd', 'red', 'TEST-A-001').code, 1);
});

test('#307 Rust `/// @id` doc-comment on a #[test] fn: editing the test body after Red stales it; a fenced doc test stays doc-block scoped', () => {
  const rs = (n) => `/// @id TEST-A-001 @verifies REQ-A-001\n#[test]\nfn t1() {\n    assert_eq!(f(), ${n});\n}\n\n/// @id TEST-A-002 @verifies REQ-A-002\n#[test]\nfn t2() {\n    assert_eq!(g(), 1);\n}\n`;
  const d = greenBoth({ 'tests/a.rs': rs(1) });
  fs.writeFileSync(path.join(d, 'tests/a.rs'), rs(2));
  const r = sdd(d, 'gate', '--no-run');
  assert.match(r.out, /TEST-A-001[^\n]*(test changed since|stale)/i, r.out);
  assert.doesNotMatch(r.out, /TEST-A-002[^\n]*(test changed since|stale)/i, r.out);
});

test('#307 duplicate CODE @id: the "no code carries @implements" warning names the duplicate', () => {
  const d = mini(SPEC2, {
    'a.test.mjs': '// @id TEST-A-001 @verifies REQ-A-001\nit(1);\n\n// @id TEST-A-002 @verifies REQ-A-002\nit(2);\n',
    'src/a.mjs': '// @id CODE-A-001 @implements REQ-A-002\nexport const a = 1;\n',
    'src/b.mjs': '// @id CODE-A-001 @implements REQ-A-001\nexport const b = 1;\n',
  }, FAIL);
  assert.equal(sdd(d, 'tdd', 'red', 'TEST-A-001').code, 0);
  setCmd(d, PASS);
  const g = sdd(d, 'tdd', 'green', 'TEST-A-001');
  assert.match(g.out, /duplicate @id found \(CODE-A-001/, g.out);
});

test('#308 impact with several targets reports every target', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-imp308-'));
  spawnSync('git', ['init', '-q'], { cwd: d });
  fs.mkdirSync(path.join(d, '.sdd/specs'), { recursive: true });
  fs.writeFileSync(path.join(d, '.sdd/specs/f.md'), '---\nfeature: f\ntier: T1\n---\n- REQ-A: the system shall a\n- REQ-B: the system shall b\n');
  const r = sdd(d, 'impact', 'REQ-A', 'REQ-B');
  assert.match(r.out, /IMPACT REQ-A/);
  assert.match(r.out, /IMPACT REQ-B/);
});

test('#308 impact lists a Python writer that opens the artifact with open(..., "w") as producer', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-imp308-'));
  spawnSync('git', ['init', '-q'], { cwd: d });
  fs.mkdirSync(path.join(d, 'contract'));
  fs.mkdirSync(path.join(d, 'tools'));
  fs.writeFileSync(path.join(d, 'contract/vectors.json'), '{}');
  fs.writeFileSync(path.join(d, 'tools/gen.py'), 'OUT = "contract/vectors.json"\nwith open(OUT, "w") as f:\n    f.write("{}")\n');
  spawnSync('git', ['add', '-A'], { cwd: d });
  assert.match(sdd(d, 'impact', 'contract/vectors.json').out, /producers: tools\/gen\.py/);
});

// ---- r16a (#304): Rust stub — ctor args/lifetimes, annotated return types, bound-only traits, workspace first test ----
test('#304 Rust stub: Type::new(&bytes) keeps its argument even after an earlier Vec::new(), and Type::of(..) takes the compared type', has268, () => {
  const d = rs288('use hist::{BitReader, Adler32};\n\n' + t288('    let mut out = Vec::new();\n    let bytes = vec![1u8, 2];\n    let mut r = BitReader::new(&bytes);\n    out.push(r.read(3));\n    assert_eq!(Adler32::of(&bytes), 5);'));
  const { lib } = stub288(d);
  assert.match(lib, /fn new<A0>\(_a0: A0\)/, lib);
  assert.match(lib, /fn of<A0>\([^\n]*-> i64/, lib);
});

test('#304 Rust stub: a `let n: u32` annotation and a comparison literal fix the return type', has268, () => {
  const d = rs288('use hist::{count, finish};\n\n' + t288('    let n: u32 = count(1);\n    assert_eq!(n, 2);\n    assert_eq!(finish(3), vec![]);'));
  const { lib } = stub288(d);
  assert.match(lib, /fn count[^\n]*-> u32/, lib);
  assert.match(lib, /fn finish[^\n]*-> Vec<i64>/, lib);
});

test('#304 Rust stub: a trait used only as a generic bound is a trait, not a struct', has268, () => {
  const d = rs288('use hist::Hasher;\n\nfn run<H: Hasher>(_h: &H) {}\n\n' + t288('    assert_eq!(1, 1);'));
  const { lib } = stub288(d);
  assert.match(lib, /pub trait Hasher/, lib);
  assert.doesNotMatch(lib, /struct Hasher/, lib);
});

test('#304 Rust stub: the first test of a workspace whose sibling crates lack src still stubs', has268, () => {
  const d = rs268({
    'Cargo.toml': '[workspace]\nmembers = ["a", "b"]\nresolver = "2"\n',
    'a/Cargo.toml': '[package]\nname = "a"\nversion = "0.1.0"\nedition = "2021"\n',
    'b/Cargo.toml': '[package]\nname = "b"\nversion = "0.1.0"\nedition = "2021"\n',
    'a/src/lib.rs': '',
    'a/tests/x.rs': 'use a::go;\n\n' + t288('    assert_eq!(go(1), 2);'),
  });
  const r = sdd(d, 'tdd', 'stub', 'TEST-H-001');
  assert.match(fs.readFileSync(path.join(d, 'a/src/lib.rs'), 'utf8'), /pub fn go/, r.out);
  assert.doesNotMatch(r.out, /verified.*fail|could not fully stub/i, r.out);
});

// ---- r17a (#304/#298/#290): Rust stub type inference ----
const ok17 = (out) => assert.doesNotMatch(out, /could not fully stub|verified:? ?fail|verify.*fail/i, out);

test('#298 Rust stub: nested struct literals give structs with typed fields, not unit structs / i64', has268, () => {
  const d = rs288('use hist::{Outer, Inner, run};\n\n' + t288('    let o = Outer { name: "a".to_string(), inner: Inner { x: 1u8, y: 2.5 }, tags: vec!["t".to_string()], pair: (1, "p".to_string()), on: Some(3) };\n    assert_eq!(run(&o), 3);'));
  const { out, lib } = stub288(d);
  assert.match(lib, /pub struct Outer \{[^}]*name: String[^}]*inner: (?:crate::)?Inner[^}]*tags: Vec<String>[^}]*pair: \(i64, String\)[^}]*on: Option<i64>/s, lib);
  assert.match(lib, /pub struct Inner \{[^}]*x: u8[^}]*y: f64/s, lib);
  ok17(out);
});

test('#298 Rust stub: instance methods are added to an existing (generic) impl, also for root-level imports', has268, () => {
  const d = rs288('use hist::{Stack, Counter};\n\n' + t288('    let mut s: Stack<i32> = Stack::new();\n    s.push(1);\n    assert_eq!(s.len(), 1);\n    let c = Counter { n: 1 };\n    assert_eq!(c.double(), 2);'), {
    'src/lib.rs': '#[derive(Debug, Default)]\npub struct Stack<T> {\n    pub items: Vec<T>,\n}\n\nimpl<T> Stack<T> {\n    pub fn new() -> Self {\n        Stack { items: Vec::new() }\n    }\n}\n\n#[derive(Debug, Default)]\npub struct Counter {\n    pub n: i64,\n}\n',
  });
  const { out, lib } = stub288(d);
  assert.match(lib, /impl<T> Stack<T> \{[^]*pub fn push[^]*pub fn len/, lib);
  assert.match(lib, /impl Counter \{[^]*pub fn double\(&self\)/, lib);
  assert.equal((lib.match(/pub struct Stack/g) ?? []).length, 1, lib);
  ok17(out);
});

test('#298 Rust stub: UFCS trait calls (`<T as Trait>::f(..)`, `Trait::f(&x)`) give a trait with methods and an impl, not a struct', has268, () => {
  const d = rs288('use hist::{Hasher, Crc};\n\n' + t288('    let c = Crc::new();\n    assert_eq!(Hasher::digest(&c, 5), 7);\n    assert_eq!(<Crc as Hasher>::name(), "crc");'));
  const { out, lib } = stub288(d);
  assert.match(lib, /pub trait Hasher \{[^}]*fn digest[^}]*&self/s, lib);
  assert.doesNotMatch(lib, /struct Hasher/, lib);
  assert.match(lib, /fn name\(\) -> String/, lib);
  assert.match(lib, /impl Hasher for Crc/, lib);
  ok17(out);
});

test('#298 Rust stub: an empty-collection / None argument is typed instead of an uninferable generic `A0`', has268, () => {
  const d = rs288('use hist::{checksum, pick};\n\n' + t288('    assert_eq!(checksum(&[]), 0);\n    assert_eq!(checksum(&[1u16, 2]), 3);\n    assert_eq!(pick(None, 1), 2);'));
  const { out, lib } = stub288(d);
  assert.match(lib, /fn checksum\(_a0: &\[u16\]\)/, lib);
  assert.match(lib, /fn pick<A1>\(_a0: Option<i64>, _a1: A1\)/, lib);
  ok17(out);
});

test('#304 Rust stub: several IDs (or --all) are stubbed in one run; a single ID still stubs only its own test', has268, () => {
  const t = (n, body) => `// @id TEST-H-00${n} @verifies REQ-H-00${n}\n#[test]\nfn test_h_00${n}() {\n${body}\n}\n`;
  const body = t(1, '    assert_eq!(hist::ops::alpha(1), 2);') + '\n' + t(2, '    assert_eq!(hist::ops::beta(1), 3);') + '\n' + t(3, '    assert_eq!(hist::ops::gamma(1), 4);');
  const mk = () => rs268({ 'src/lib.rs': '', 'tests/x.rs': body }, ['TEST-H-001', 'TEST-H-002', 'TEST-H-003']);
  const ops = (d) => fs.readFileSync(path.join(d, 'src/ops.rs'), 'utf8');
  const one = mk();
  sdd(one, 'tdd', 'stub', 'TEST-H-001');
  assert.doesNotMatch(ops(one), /fn beta/);
  const two = mk();
  const r = sdd(two, 'tdd', 'stub', 'TEST-H-001', 'TEST-H-002');
  assert.match(ops(two), /fn alpha/, r.out);
  assert.match(ops(two), /fn beta/, r.out);
  assert.doesNotMatch(ops(two), /fn gamma/);
  const all = mk();
  sdd(all, 'tdd', 'stub', 'TEST-H-001', '--all');
  assert.match(ops(all), /fn gamma/);
});

test('#304 Rust stub: consts/tables compared or iterated by the test are typed (tuples, Option, slices), not i64', has268, () => {
  const d = rs288('use hist::{LIMIT, PAIR, MAYBE, TABLE, CASES, NAME};\n\n' + t288('    assert_eq!(LIMIT, 5u8);\n    assert_eq!(PAIR, (1, "a"));\n    assert_eq!(MAYBE, Some(2.5));\n    assert_eq!(TABLE[0], (1, 2));\n    for (a, b) in CASES {\n        assert_eq!(a, b);\n    }\n    assert_eq!(NAME, "x");'));
  const { out, lib } = stub288(d);
  assert.match(lib, /const LIMIT: u8 = 0;/, lib);
  assert.match(lib, /const PAIR: \(i64, &str\) = \(0, ""\);/, lib);
  assert.match(lib, /const MAYBE: Option<f64> = None;/, lib);
  assert.match(lib, /const TABLE: &\[\(i64, i64\)\] = &\[\];/, lib);
  assert.match(lib, /const CASES: &\[\(i64, i64\)\] = &\[\];/, lib);
  assert.match(lib, /const NAME: &str/, lib);
  ok17(out);
});

test('#304 Rust stub: names imported for other tests do not break the file of the requested test', has268, () => {
  const t = (n, body) => `// @id TEST-H-00${n} @verifies REQ-H-00${n}\n#[test]\nfn test_h_00${n}() {\n${body}\n}\n`;
  const d = rs268({ 'src/lib.rs': '', 'tests/x.rs': 'use hist::{alpha, beta, Gadget};\n\n' + t(1, '    assert_eq!(alpha(1), 2);') + '\n' + t(2, '    let g = Gadget::new();\n    assert_eq!(beta(1, 2), 3);') }, ['TEST-H-001', 'TEST-H-002']);
  const r = sdd(d, 'tdd', 'stub', 'TEST-H-001');
  const lib = fs.readFileSync(path.join(d, 'src/lib.rs'), 'utf8');
  assert.match(lib, /fn alpha/, r.out);
  assert.match(lib, /fn beta<A0, A1>/, lib);
  assert.match(lib, /struct Gadget/, lib);
  ok17(r.out);
});

test('#304 Rust stub: enum variants carry typed fields (nested literals, tuples, Option, Vec)', has268, () => {
  const d = rs288('use hist::{Ev, Point};\n\n' + t288('    let a = Ev::Pair(1, "a".to_string());\n    let b = Ev::Move { to: Point { x: 1, y: 2 }, speed: 1.5 };\n    let c = Ev::Tag(Some(3), vec![1u8]);\n    assert_eq!(a, a.clone());\n    assert_eq!(b, b.clone());\n    assert_eq!(c, c.clone());'));
  const { out, lib } = stub288(d);
  assert.match(lib, /Pair\(i64, String\)/, lib);
  assert.match(lib, /Move \{ to: (?:crate::)?Point, speed: f64 \}/, lib);
  assert.match(lib, /Tag\(Option<i64>, Vec<u8>\)/, lib);
  ok17(out);
});

test('#304 Rust stub: a trait used through a generic bound / dyn gets the methods the test calls on it', has268, () => {
  const d = rs288('use hist::Sink;\n\nfn feed<S: Sink>(s: &mut S) {\n    s.write(3);\n}\n\nfn peek(s: &dyn Sink) -> usize {\n    s.count()\n}\n\n' + t288('    assert_eq!(1, 1);'));
  const { out, lib } = stub288(d);
  ok17(out);
  assert.match(lib, /pub trait Sink \{[^}]*fn write[^}]*&mut self/s, lib);
  assert.match(lib, /pub trait Sink \{[^}]*fn count\(&self\)/s, lib);
});

test('#290 Rust stub: methods on a returned value are not added to the type whose fn returned it', has268, () => {
  const d = rs288('use hist::Optimizer;\n\n' + t288('    let out = Optimizer::optimize(1);\n    assert_eq!(out, "x");\n    assert!(out.contains("x"));\n    assert_eq!(out.matches("x").count(), 1);'));
  const { out, lib } = stub288(d);
  assert.match(lib, /fn optimize<A0>\(_a0: A0\) -> String/, lib);
  assert.doesNotMatch(lib, /fn (contains|matches)/, lib);
  ok17(out);
});

test('#307 T2 Design: a one-line multi-sentence paragraph satisfies the Design check', () => {
  const d = mini('---\nfeature: a\ntier: T2\n---\n## Design\nComponent A reads input. It returns the sum. State is none.\n## Requirements\n| REQ-A-001 | one shall hold. | TEST-A-001 |\n', { 'a.test.mjs': jsTest() });
  const r = sddRaw(d, 'guard', 'a');
  assert.doesNotMatch(r.out, /needs a "## Design"/, r.out);
});

test('#308 gate --changed: a changed `artifacts` file scopes in the project holding its consumer', () => {
  const d = mini('---\nfeature: a\ntier: T1\n---\n| REQ-A-001 | x shall hold. | TEST-A-001 |\n', { 'svc/x.txt': 'x', 'data/cases.json': '{}' });
  fs.writeFileSync(path.join(d, '.sdd/config.json'), JSON.stringify({ testCmd: PASS, checks: [], artifacts: { 'data/cases.json': ['svc/x.txt'] }, projects: [{ root: 'svc', testCmd: PASS, checks: [{ name: 'ok', cmd: ['node', '-e', '0'] }] }] }));
  spawnSync('git', ['add', '-A'], { cwd: d });
  spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'i'], { cwd: d });
  fs.writeFileSync(path.join(d, 'data/cases.json'), '{"a":1}');
  const o = sdd(d, 'gate', '--changed').out;
  assert.match(o, /✓ cmd svc:ok/, o);
  assert.doesNotMatch(o, /root-owned data\/config changes/, o);
});

const r18cShapes = {
  forEach: ['  const r = add(1, 2);', '  r.forEach((x) => assert.equal(x, 3));'],
  destructure: ['  const r = add(1, 2);', '  const [a, b] = r;', '  assert.equal(a + b, 3);'],
  objDestructure: ['  const r = add(1, 2);', '  const { total } = r;', '  assert.equal(total, 3);'],
};
for (const [name, lines] of Object.entries(r18cShapes)) {
  test(`#306 r18c shape ${name}`, () => {
    const d = project();
    sdd(d, 'approve', 'record', 'calc', '--by', 'tester');
    fs.writeFileSync(path.join(d, 'add.test.mjs'), ["import { test } from 'node:test';", "import assert from 'node:assert/strict';", "import { add } from './add.mjs';", '/** @id TEST-CALC-001 @verifies REQ-CALC-001 */', "test('TEST-CALC-001 adds', () => {", ...lines, '});', ''].join('\n'));
    fs.writeFileSync(path.join(d, 'add.mjs'), "export const add = () => { throw new Error('not implemented: add'); };\n");
    const w = sdd(d, 'tdd', 'red', 'TEST-CALC-001');
    assert.equal(w.code, 0, w.out);
    assert.doesNotMatch(w.out, /\[weak\]|setup call/, w.out);
  });
}

test('#306 r18c Rust: default trait method delegating to a stubbed required method is not setup', has268, () => {
  const d = rs268({
    'src/lib.rs': 'pub trait Mk: Sized {\n    fn update(v: i64) -> Self;\n    fn of(v: i64) -> Self {\n        Self::update(v)\n    }\n}\n#[derive(Debug, PartialEq)]\npub struct P(pub i64);\nimpl Mk for P {\n    fn update(_v: i64) -> Self {\n        unimplemented!("update")\n    }\n}\n',
    'tests/m.rs': 'use hist::{Mk, P};\n\n// @id TEST-H-001 @verifies REQ-H-001\n#[test]\nfn test_h_001() {\n    let p = P::of(3);\n    assert_eq!(p, P(3));\n}\n',
  });
  fs.writeFileSync(path.join(d, '.sdd/config.json'), JSON.stringify({ testCmd: ['cargo', 'test', '--test', 'm', '{idu}'], checks: [] }));
  sdd(d, 'approve', 'record', 'h', '--by', 'tester');
  const w = sdd(d, 'tdd', 'red', 'TEST-H-001');
  assert.equal(w.code, 0, w.out);
  assert.doesNotMatch(w.out, /\[weak\]|setup call/, w.out);
});

test('#295 tdd refactor --stale re-verifies every test with a stale shared-implementation Green', () => {
  const spec = '---\nfeature: a\ntier: T1\n---\n| REQ-A-001 | x shall hold. | TEST-A-001 |\n| REQ-A-002 | y shall hold. | TEST-A-002 |\n';
  const d = mini(spec, { 'a.test.mjs': '// @id TEST-A-001 @verifies REQ-A-001\n// one\n// @id TEST-A-002 @verifies REQ-A-002\n// two\n', 'impl.mjs': '// @id CODE-A-001 @implements REQ-A-001 REQ-A-002\nexport const v = 0;\n' }, FAIL);
  assert.equal(sdd(d, 'tdd', 'red', 'TEST-A-001').code, 0);
  assert.equal(sdd(d, 'tdd', 'red', 'TEST-A-002').code, 0);
  setCmd(d, PASS);
  sdd(d, 'tdd', 'green', 'TEST-A-001');
  sdd(d, 'tdd', 'green', 'TEST-A-002');
  fs.writeFileSync(path.join(d, 'impl.mjs'), '// @id CODE-A-001 @implements REQ-A-001 REQ-A-002\nexport const v = 1;\n');
  const r = sdd(d, 'tdd', 'refactor', '--stale');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /TEST-A-001/, r.out);
  assert.match(r.out, /TEST-A-002/, r.out);
  assert.match(sdd(d, 'tdd', 'refactor', '--stale').out, /no test has a stale/);
});

test('#295 --characterization without a reason explains the flag', () => {
  const d = t1project();
  const r = sdd(d, 'tdd', 'red', 'TEST-CALC-001', '--characterization');
  assert.equal(r.code, 2);
  assert.match(r.out, /passes without any implementation/, r.out);
});

test('#295 the missing-@implements warning is not repeated once the test already has a Green', () => {
  const d = t1project();
  fs.writeFileSync(path.join(d, 'add.mjs'), 'export const add = (a, b) => a + b;\n');
  sdd(d, 'tdd', 'red', 'TEST-CALC-001', '--characterization', 'x');
  assert.match(sdd(d, 'tdd', 'green', 'TEST-CALC-001').out, /no code carries @implements/);
  assert.doesNotMatch(sdd(d, 'tdd', 'green', 'TEST-CALC-001').out, /no code carries @implements/);
});

test('#303 a flaky suspected gate run is recorded in the ledger with the policy outcome', () => {
  for (const [flaky, outcome] of [[null, 'fail'], [{ policy: 'warn' }, 'accepted']]) {
    const d = flakyProject(flaky, FLAKY_ONCE);
    sdd(d, 'gate');
    const es = fs.readFileSync(path.join(d, '.sdd/tdd.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(es.length, 1);
    assert.equal(es[0].type, 'flaky');
    assert.equal(es[0].outcome, outcome);
    assert.match(sdd(d, 'tdd', 'check').out, /LEDGER OK \(1 entries\)/);
  }
});

test('#296 Java: for-each variables and re-declared variable names resolve to the nearest declaration', () => {
  const d = mk130({ 'src/test/java/CalcTest.java': [
    'public class CalcTest {',
    '  // @id TEST-A-001 @verifies REQ-A-001',
    '  static void t() {',
    '    Calc c = new Calc();',
    '    for (Item i : c.items()) { String q = i.name(); }',
    '    { Widget w = new Widget(); w.run(); }',
    '    { Gadget w = new Gadget(); w.spin(); }',
    '  }',
    '}',
    '',
  ].join('\n') });
  sdd(d, 'tdd', 'stub', 'TEST-A-001');
  assert.match(rd130(d, 'src/main/java/Item.java'), /name\(\)/);
  assert.doesNotMatch(rd130(d, 'src/main/java/Widget.java'), /spin/);
  assert.doesNotMatch(rd130(d, 'src/main/java/Gadget.java'), /run/);
});

test('#296 Go: results used arithmetically, as typed arguments or ranged over get concrete types, not any', { skip: !has130('go') }, () => {
  const d = mk130({
    'go.mod': 'module example.com/m\n\ngo 1.21\n',
    'calc/calc_test.go': 'package calc\n\nimport (\n\t"strings"\n\t"testing"\n)\n\n// @id TEST-A-001 @verifies REQ-A-001\nfunc TestAdd(t *testing.T) {\n\tc := NewCalc(2)\n\tgot := c.Add(1, 2)\n\tif got+1 != 4 {\n\t\tt.Fatal(got)\n\t}\n\tname := c.Name()\n\tif strings.ToUpper(name) != "X" {\n\t\tt.Fatal(name)\n\t}\n\tfor _, it := range c.Items() {\n\t\t_ = it.ID\n\t}\n}\n',
  });
  const out = sdd(d, 'tdd', 'stub', 'TEST-A-001').out;
  assert.doesNotMatch(out, /does not compile|could not fully stub/, out);
  const g = rd130(d, 'calc/calc.go');
  assert.match(g, /\) Add\(a0, a1 any\) int/);
  assert.match(g, /\) Name\(\) string/);
});

test('#296 C#: a type used in `case T.X:` is an enum even when it is also a declared type', { skip: !has130('dotnet') }, () => {
  const d = mk130({
    'T/T.csproj': '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>\n',
    'T/CalcTests.cs': 'class CalcTests {\n  // @id TEST-A-001 @verifies REQ-A-001\n  static void T() {\n    var c = new Calc(2);\n    Status st = c.Status();\n    switch (st) { case Status.Active: break; case Status.Done: break; }\n  }\n}\n',
  });
  const out = sdd(d, 'tdd', 'stub', 'TEST-A-001').out;
  assert.doesNotMatch(out, /does not compile|could not fully stub/, out);
  assert.match(rd130(d, 'T/Status.cs'), /public enum Status/);
});

test('#296 ExUnit: a stub called in a refute assertion is the asserted behaviour, not setup', () => {
  const r = weak263(null, '** (RuntimeError) not implemented: add\n', 'add.test.exs', exs271('    assert_raise ArgumentError, fn -> Calc.boom(1) end\n    refute Calc.add(1, 1) == 3'));
  assert.match(r.out, /RED ok/, r.out);
  assert.doesNotMatch(r.out, /\[weak\]|setup call/, r.out);
});

test('#309 a comment-only edit to a nested @implements annotation does not stale the OUTER block', () => {
  const d = blockProject();
  fs.writeFileSync(path.join(d, 'impl.mjs'), '// @id CODE-A-001 @implements REQ-A-001\nexport function one() {\n  // @id CODE-A-002 @implements REQ-A-002\n  const two = () => 2;\n  return 1;\n}\n');
  sdd(d, 'tdd', 'green', 'TEST-A-001');
  touchImpl(d, '@implements REQ-A-002', '@implements REQ-A-002 (edited note)');
  assert.doesNotMatch(sdd(d, 'tdd', 'green', 'TEST-A-002').out, /shared with other REQs[^\n]*TEST-A-001/);
});

test('#308 gate --changed: a root Cargo workspace manifest belongs to the project holding its members', () => {
  const d = mini('---\nfeature: a\ntier: T1\n---\n| REQ-A-001 | x shall hold. | TEST-A-001 |\n', { 'Cargo.toml': '[workspace]\nmembers = ["rs/crates/a"]\n', 'rs/crates/a/Cargo.toml': '[package]\nname = "a"\n' });
  fs.writeFileSync(path.join(d, '.sdd/config.json'), JSON.stringify({ testCmd: PASS, checks: [], projects: [{ root: 'rs', testCmd: PASS, checks: [{ name: 'ok', cmd: ['node', '-e', '0'] }] }] }));
  spawnSync('git', ['add', '-A'], { cwd: d });
  spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'i'], { cwd: d });
  fs.appendFileSync(path.join(d, 'Cargo.toml'), '# c\n');
  const o = sdd(d, 'gate', '--changed').out;
  assert.match(o, /✓ cmd rs:ok/, o);
  assert.doesNotMatch(o, /root-owned data\/config changes/, o);
});

// ---- r21c (#309 Stubs) ----
const jr21 = (src) => mk130({ 'src/test/java/CalcTest.java': src.join('\n') + '\n' });
const jc21 = (d) => { const files = ['src/test/java/CalcTest.java', ...fs.readdirSync(path.join(d, 'src/main/java')).map((f) => `src/main/java/${f}`)]; return spawnSync('javac', ['-d', path.join(d, 'out'), ...files.map((f) => path.join(d, f))], { encoding: 'utf8' }); };

test('#309 Java: same-arity calls with different literal/return types get typed overloads that compile', { skip: !has130('javac') }, () => {
  const d = jr21(['public class CalcTest {', '  // @id TEST-A-001 @verifies REQ-A-001', '  static void t() {', '    Calc c = new Calc();', '    int a = c.apply(1);', '    String b = c.apply("x");', '  }', '}']);
  sdd(d, 'tdd', 'stub', 'TEST-A-001');
  const r = jc21(d);
  assert.equal(r.status, 0, r.stderr);
});

test('#309 Java: nested types (Calc.Mode) become nested members of the outer stub', { skip: !has130('javac') }, () => {
  const d = jr21(['public class CalcTest {', '  // @id TEST-A-001 @verifies REQ-A-001', '  static void t() {', '    Calc c = new Calc();', '    Calc.Mode m = Calc.Mode.FAST;', '    c.run(m);', '  }', '}']);
  sdd(d, 'tdd', 'stub', 'TEST-A-001');
  const r = jc21(d);
  assert.equal(r.status, 0, r.stderr);
});

test('#309 TS stub: an error subclass the test asserts instanceof together with a generic base extends that base', () => {
  const d = stub10({
    'sdk.test.ts': "import { NotFoundError, AppError, mapError } from './sdk';\n\n// @id TEST-S-001\n// @verifies REQ-S-001\ntest('s', () => {\n  const e = mapError(404);\n  expect(e).toBeInstanceOf(NotFoundError);\n  expect(e).toBeInstanceOf(AppError);\n});\n",
  }, 'TEST-S-001');
  const s = fs.readFileSync(path.join(d, 'sdk.ts'), 'utf8');
  assert.match(s, /class AppError extends Error/, s);
  assert.match(s, /class NotFoundError extends AppError/, s);
  assert.ok(s.indexOf('class AppError') < s.indexOf('class NotFoundError'), 'parent is declared first');
});

test('#309 stubThrowingConstructors (opt-in) makes JS/TS and Java class constructors throw; default stays non-throwing', { skip: !has130('javac') }, () => {
  const tsFiles = { 'sdk.test.ts': "import { Widget } from './sdk';\n\n// @id TEST-S-001\n// @verifies REQ-S-001\ntest('s', () => {\n  const w = new Widget(1);\n});\n" };
  const off = stub10(tsFiles, 'TEST-S-001');
  assert.match(fs.readFileSync(path.join(off, 'sdk.ts'), 'utf8'), /constructor\(\.\.\._args: any\[\]\) \{\}/);
  const on = stub10({ ...tsFiles, '.sdd/config.json': JSON.stringify({ stubThrowingConstructors: true }) }, 'TEST-S-001');
  assert.match(fs.readFileSync(path.join(on, 'sdk.ts'), 'utf8'), /constructor\(\.\.\._args: any\[\]\) \{\n    throw new Error\('not implemented: Widget'\)/);
  const j = mk130({ '.sdd/config.json': JSON.stringify({ stubThrowingConstructors: true }), 'src/test/java/CalcTest.java': 'public class CalcTest {\n  // @id TEST-A-001 @verifies REQ-A-001\n  static void t() { Calc c = new Calc(1); }\n}\n' });
  sdd(j, 'tdd', 'stub', 'TEST-A-001');
  assert.match(rd130(j, 'src/main/java/Calc.java'), /public Calc\(int a0\) \{\n\s+throw new UnsupportedOperationException\("not implemented: Calc"\)/);
});

test('#309 ExUnit: DSL macros of a `use`d support module are stubbed as throwing macros and the test compiles', { skip: !HAS_MIX }, () => {
  const d = stub10({
    'mix.exs': 'defmodule D.MixProject do\n  use Mix.Project\n  def project, do: [app: :d, version: "0.1.0", deps: []]\nend\n',
    'test/test_helper.exs': 'ExUnit.start()\n',
    'test/d_test.exs': 'defmodule DTest do\n  use ExUnit.Case\n  use D.Dsl\n\n  # @id TEST-E-001\n  # @verifies REQ-E-001\n  test "dsl" do\n    rule :a do\n      1\n    end\n    check_ok 1, 2\n  end\nend\n',
    '.sdd/specs/e.md': '---\nfeature: e\ntier: T1\n---\n| REQ-E-001 | dsl shall hold. | TEST-E-001 |\n',
  }, 'TEST-E-001');
  const lib = fs.readFileSync(path.join(d, 'lib/d/dsl.ex'), 'utf8');
  assert.match(lib, /defmacro rule\(_a1, _a2\)/, lib);
  assert.match(lib, /defmacro check_ok\(_a1, _a2\)/, lib);
  const r = spawnSync('mix', ['test', 'test/d_test.exs'], { cwd: d, encoding: 'utf8', timeout: 120000 });
  assert.doesNotMatch(r.stdout + r.stderr, /undefined function|CompileError/, r.stdout + r.stderr);
  assert.match(r.stdout + r.stderr, /not implemented: rule/, r.stdout + r.stderr);
});

test('#309 a (characterization) REQ marker waives the unannotated-implementation first-Green warning', () => {
  const d = t1project();
  fs.writeFileSync(path.join(d, '.sdd/specs/calc.md'), '---\nfeature: calc\ntier: T1\n---\n| REQ-CALC-001 | (characterization) When add is called, the system shall sum. | TEST-CALC-001 |\n');
  fs.writeFileSync(path.join(d, 'add.mjs'), 'export const add = (a, b) => a + b;\n');
  assert.equal(sdd(d, 'tdd', 'red', 'TEST-CALC-001', '--characterization', 'x').code, 0);
  const r = sdd(d, 'tdd', 'green', 'TEST-CALC-001');
  assert.doesNotMatch(r.out, /no code carries @implements/, r.out);
});

test('#309 trace validates [src:] ranges, blank lines and anchors', () => {
  const d = mini('---\nfeature: a\ntier: T1\n---\n| REQ-A-001 | x shall work. [src: lib/a.ts:1-9] [src: lib/a.ts:3] [src: lib/a.ts:1 `foo`] [src: lib/a.ts:1-2 `alpha`] | TEST-A-001 |\n', { 'lib/a.ts': 'alpha\nb\n\n' });
  const r = sdd(d, 'trace', '--verbose');
  assert.match(r.out, /lib\/a\.ts:1-9\] line range does not resolve/, r.out);
  assert.match(r.out, /lib\/a\.ts:3\] cites only blank lines/, r.out);
  assert.match(r.out, /lib\/a\.ts:1\] anchor `foo` not found/, r.out);
  assert.doesNotMatch(r.out, /lib\/a\.ts:1-2\]/, r.out);
});

function r22aProject(header) {
  const d = t1project();
  fs.writeFileSync(path.join(d, 'add.test.mjs'), ["import { test } from 'node:test';", "import assert from 'node:assert/strict';", "import { add } from './add.mjs';", header, '/** @id TEST-CALC-001 @verifies REQ-CALC-001 */', "test('TEST-CALC-001 adds', () => assert.equal(add(1, 2), 3));", ''].join('\n'));
  return d;
}
const r22aHeader = (d, h) => fs.writeFileSync(path.join(d, 'add.test.mjs'), fs.readFileSync(path.join(d, 'add.test.mjs'), 'utf8').replace(/^\/\/ \w$/m, h));

test('#309 r22a: T1 stale hint for a header-only edit after Green names --wording (a bare refactor would be REFUSED)', () => {
  const d = r22aProject('// a');
  impl(d, '(a, b) => a + b');
  assert.equal(sdd(d, 'tdd', 'red', 'TEST-CALC-001', '--characterization', 'pins').code, 0);
  assert.equal(sdd(d, 'tdd', 'green', 'TEST-CALC-001').code, 0);
  r22aHeader(d, '// b');
  const g = sdd(d, 'gate');
  assert.match(g.out, /tdd refactor TEST-CALC-001 --wording/, g.out);
  assert.equal(sdd(d, 'tdd', 'refactor', 'TEST-CALC-001').code, 1);
  const r = sdd(d, 'tdd', 'refactor', 'TEST-CALC-001', '--wording', 'header comment');
  assert.equal(r.code, 0, r.out);
});

test('#309 r22a: tdd green refusal after a header-only edit does not suggest --retest', () => {
  const d = r22aProject('// a');
  fs.writeFileSync(path.join(d, 'add.mjs'), 'export const add = () => { throw new Error("x"); };\n');
  assert.equal(sdd(d, 'tdd', 'red', 'TEST-CALC-001').code, 0);
  r22aHeader(d, '// b');
  const r = sdd(d, 'tdd', 'green', 'TEST-CALC-001');
  assert.match(r.out, /REFUSED/, r.out);
  assert.match(r.out, /only shared test-file content/, r.out);
  assert.doesNotMatch(r.out, /--retest/, r.out);
});

test('#309 r22a: T1 refactor refusal after a test-body edit offers --retest; empty --wording is called out', () => {
  const d = r22aProject('// a');
  impl(d, '(a, b) => a + b');
  assert.equal(sdd(d, 'tdd', 'red', 'TEST-CALC-001', '--characterization', 'pins').code, 0);
  assert.equal(sdd(d, 'tdd', 'green', 'TEST-CALC-001').code, 0);
  fs.writeFileSync(path.join(d, 'add.test.mjs'), fs.readFileSync(path.join(d, 'add.test.mjs'), 'utf8').replace('add(1, 2), 3', 'add(2, 2), 4'));
  const r = sdd(d, 'tdd', 'refactor', 'TEST-CALC-001', '--wording', ' ');
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /--wording needs a non-empty reason/, r.out);
  assert.match(r.out, /tdd red TEST-CALC-001 --retest/, r.out);
  assert.doesNotMatch(r.out, /Only shared test-file content/, r.out);
});

test('#309 approve record --review: empty or nonexistent path is refused for human approvers too', () => {
  const d = project();
  for (const rv of ['', 'nope/review.md']) {
    const r = sdd(d, 'approve', 'record', 'calc', '--by', 'tester', '--review', rv);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /REFUSED: --review/, r.out);
  }
  assert.equal(sdd(d, 'approve', 'record', 'calc', '--by', 'tester').code, 0);
});

test('#309 specEditPolicy reapprove: T1 refactor after a row edit needs --wording; default only warns', () => {
  const run = (cfg) => {
    const d = t1project();
    impl(d, '(a, b) => a + b');
    assert.equal(sdd(d, 'tdd', 'red', 'TEST-CALC-001', '--characterization', 'pins current').code, 0);
    assert.equal(sdd(d, 'tdd', 'green', 'TEST-CALC-001').code, 0);
    if (cfg) fs.writeFileSync(path.join(d, '.sdd/config.json'), JSON.stringify({ testCmd: ['node', '-e', '0'], checks: [], ...cfg }));
    fs.writeFileSync(path.join(d, '.sdd/specs/calc.md'), '---\nfeature: calc\ntier: T1\n---\n| REQ-CALC-001 | When add is called, the system shall subtract. | TEST-CALC-001 |\n');
    return d;
  };
  const dflt = run(null);
  assert.equal(sdd(dflt, 'tdd', 'refactor', 'TEST-CALC-001').code, 0);
  const d = run({ specEditPolicy: 'reapprove' });
  const r = sdd(d, 'tdd', 'refactor', 'TEST-CALC-001');
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /REFUSED.*REQ-CALC-001.*--wording/s, r.out);
  assert.match(sdd(d, 'gate', '--no-run').out, /changed in the spec/);
  assert.equal(sdd(d, 'tdd', 'refactor', 'TEST-CALC-001', '--wording', 'reworded only').code, 0);
});

test('#309 artifactStaleness: editing a declared artifact a test references by name stales its evidence (opt-in)', () => {
  const spec = '---\nfeature: a\ntier: T1\n---\n| REQ-A-001 | x shall hold. | TEST-A-001 |\n';
  const run = (on) => {
    const d = mini(spec, { 'a.test.mjs': "// @id TEST-A-001 @verifies REQ-A-001\n// reads 'data/golden.json'\n", 'data/golden.json': '[1]\n' }, FAIL);
    const cp = path.join(d, '.sdd/config.json');
    const c = JSON.parse(fs.readFileSync(cp, 'utf8'));
    c.artifacts = { 'data/golden.json': ['src/impl.mjs'] };
    if (on) c.artifactStaleness = true;
    fs.writeFileSync(cp, JSON.stringify(c));
    assert.equal(sdd(d, 'tdd', 'red', 'TEST-A-001').code, 0);
    setCmd(d, PASS);
    assert.equal(sdd(d, 'tdd', 'green', 'TEST-A-001').code, 0);
    fs.writeFileSync(path.join(d, 'data/golden.json'), '[2]\n');
    return d;
  };
  const out = sdd(run(true), 'gate', '--no-run').out;
  assert.match(out, /artifact data\/golden\.json changed[^\n]*tdd refactor/, out);
  assert.doesNotMatch(sdd(run(false), 'gate', '--no-run').out, /artifact data\/golden\.json changed/);
});

test('#309 artifactStaleness: tdd refactor re-records the artifact hash and clears the stale evidence', () => {
  const spec = '---\nfeature: a\ntier: T1\n---\n| REQ-A-001 | x shall hold. | TEST-A-001 |\n';
  const d = mini(spec, { 'a.test.mjs': "// @id TEST-A-001 @verifies REQ-A-001\n// reads 'data/golden.json'\n", 'data/golden.json': '[1]\n' }, FAIL);
  const cp = path.join(d, '.sdd/config.json');
  const c = JSON.parse(fs.readFileSync(cp, 'utf8'));
  c.artifacts = { 'data/golden.json': ['src/impl.mjs'] };
  c.artifactStaleness = true;
  fs.writeFileSync(cp, JSON.stringify(c));
  assert.equal(sdd(d, 'tdd', 'red', 'TEST-A-001').code, 0);
  setCmd(d, PASS);
  assert.equal(sdd(d, 'tdd', 'green', 'TEST-A-001').code, 0);
  fs.writeFileSync(path.join(d, 'data/golden.json'), '[2]\n');
  assert.match(sdd(d, 'gate', '--no-run').out, /artifact data\/golden\.json changed/);
  assert.equal(sdd(d, 'tdd', 'refactor', 'TEST-A-001').code, 0);
  assert.doesNotMatch(sdd(d, 'gate', '--no-run').out, /artifact data\/golden\.json changed/);
});

const symbolCfg = (d, on = true) => { const cp = path.join(d, '.sdd/config.json'); const c = JSON.parse(fs.readFileSync(cp, 'utf8')); if (on) c.preambleGranularity = 'symbol'; fs.writeFileSync(cp, JSON.stringify(c)); };
const symbolCase = (file, pre, tests, edit, on = true) => {
  const d = mini(SPEC2, {}, FAIL);
  if (on) symbolCfg(d);
  fs.writeFileSync(path.join(d, file), pre + tests);
  assert.equal(sdd(d, 'tdd', 'red', 'TEST-A-001').code, 0);
  assert.equal(sdd(d, 'tdd', 'red', 'TEST-A-002').code, 0);
  setCmd(d, PASS);
  assert.equal(sdd(d, 'tdd', 'green', 'TEST-A-001').code, 0);
  assert.equal(sdd(d, 'tdd', 'green', 'TEST-A-002').code, 0);
  fs.writeFileSync(path.join(d, file), edit(pre) + tests);
  return d;
};
const staleIds = (d) => [...sdd(d, 'gate', '--no-run').out.matchAll(/(TEST-A-00\d)[^\n]*test changed since/g)].map((m) => m[1]);

test('#300 preambleGranularity symbol: a TS/JS fixture edit stales only tests that reference it', () => {
  const pre = "import { x } from './x.mjs';\nconst fixture = { a: 1 };\nfunction other() { return 2; }\n\n";
  const T = '// @id TEST-A-001 @verifies REQ-A-001\nit(fixture.a);\n\n// @id TEST-A-002 @verifies REQ-A-002\nit(other());\n';
  const d = symbolCase('a.test.mjs', pre, T, (p) => p.replace('a: 1', 'a: 9'));
  assert.deepEqual(staleIds(d), ['TEST-A-001']);
  const g = symbolCase('a.test.mjs', pre, T, (p) => p.replace("'./x.mjs'", "'./y.mjs'"));
  assert.deepEqual(staleIds(g).sort(), ['TEST-A-001', 'TEST-A-002']);
});

test('#300 preambleGranularity symbol: transitive helper use and default behaviour', () => {
  const pre = "const base = 1;\nconst derived = () => base;\nfunction other() { return 2; }\n\n";
  const T = '// @id TEST-A-001 @verifies REQ-A-001\nit(derived());\n\n// @id TEST-A-002 @verifies REQ-A-002\nit(other());\n';
  const d = symbolCase('a.test.mjs', pre, T, (p) => p.replace('base = 1', 'base = 5'));
  assert.deepEqual(staleIds(d), ['TEST-A-001']);
  const def = symbolCase('a.test.mjs', pre, T, (p) => p.replace('base = 1', 'base = 5'), false);
  assert.deepEqual(staleIds(def).sort(), ['TEST-A-001', 'TEST-A-002']);
});

test('#300 preambleGranularity symbol: Python top-level helper edit stales only referencing tests', () => {
  const pre = "import os\n\nFIXTURE = 1\n\ndef helper():\n    return 2\n\n";
  const T = '# @id TEST-A-001 @verifies REQ-A-001\ndef test_a():\n    assert FIXTURE\n\n# @id TEST-A-002 @verifies REQ-A-002\ndef test_b():\n    assert helper()\n';
  const d = symbolCase('test_a.py', pre, T, (p) => p.replace('return 2', 'return 3'));
  assert.deepEqual(staleIds(d), ['TEST-A-002']);
});

test('#300 preambleGranularity symbol: Rust top-level const edit stales only referencing tests', () => {
  const pre = "use std::fmt;\nconst LIMIT: u32 = 1;\nconst OTHER: u32 = 2;\n\n";
  const T = '// @id TEST-A-001 @verifies REQ-A-001\n#[test]\nfn a() { assert_eq!(LIMIT, 1); }\n\n// @id TEST-A-002 @verifies REQ-A-002\n#[test]\nfn b() { assert_eq!(OTHER, 2); }\n';
  const d = symbolCase('a_test.rs', pre, T, (p) => p.replace('LIMIT: u32 = 1', 'LIMIT: u32 = 7'));
  assert.deepEqual(staleIds(d), ['TEST-A-001']);
});

test('#310 Rust stub: a const used with float literals is f64, not i64', has268, () => {
  const d = rs288('use hist::EPSILON;\n\n' + t288('    let h = EPSILON / 2.0;\n    assert!(h > 0.0);\n    assert_eq!(EPSILON, 1e-5);'));
  const { out, lib } = stub288(d);
  assert.match(lib, /const EPSILON: f64 = 0\.0;/, lib);
  ok17(out);
});

test('#310 Rust stub: const only divided/compared with a float literal is f64', has268, () => {
  const d = rs288('use hist::TOL;\n\n' + t288('    let h = TOL / 2.0;\n    assert!(h < 1.0);'));
  const { out, lib } = stub288(d);
  assert.match(lib, /const TOL: f64 = 0\.0;/, lib);
  ok17(out);
});

test('#310 Rust stub: Type::new(args) with a value in scope is a constructor, not a trait', has268, () => {
  const d = rs288('use hist::{Encoder, Vocab};\n\n' + t288('    let v = Vocab::new();\n    let e = Encoder::new(&v, 2);\n    assert_eq!(e.size(), 2);'));
  const { out, lib } = stub288(d);
  assert.doesNotMatch(lib, /pub trait Encoder/, lib);
  assert.match(lib, /struct Encoder/, lib);
  ok17(out);
});

test('#310 Rust stub: <T as Trait>::Assoc makes Trait a trait with an associated type', has268, () => {
  const d = rs288('use hist::{BpeModel, Model};\n\n' + t288('    let m = BpeModel::new();\n    let o: <BpeModel as Model>::Output = m.run(1);\n    assert_eq!(1, 1);'));
  const { out, lib } = stub288(d);
  assert.match(lib, /pub trait Model \{[^}]*type Output/s, lib);
  ok17(out);
});

test('#310 Rust stub: methods called on a `let mut` receiver take &mut self', has268, () => {
  const d = rs288('use hist::Server;\n\n' + t288('    let mut s = Server::new();\n    assert_eq!(s.handle_line("x"), 1);'));
  const { out, lib } = stub288(d);
  assert.match(lib, /fn handle_line[^(]*\(&mut self/, lib);
  ok17(out);
});

test('#310 Rust stub: enum variants and inherent methods used via a helper are kept', has268, () => {
  const d = rs288('use hist::Json;\n\n' + t288('    let j = Json::Obj(vec![]);\n    let n = Json::Null;\n    assert!(j.get("a").is_none());\n    assert_eq!(n, Json::Null);'));
  const { out, lib } = stub288(d);
  assert.match(lib, /Obj\(/, lib);
  assert.match(lib, /Null/, lib);
  assert.match(lib, /fn get/, lib);
  ok17(out);
});

test('#311 r23b: (characterization) REQ Red is labelled with its own marker; setup-Red advice covers the stubbed-setup case', () => {
  const d = t1project();
  fs.writeFileSync(path.join(d, '.sdd/specs/calc.md'), '---\nfeature: calc\ntier: T1\n---\n| REQ-CALC-001 | (characterization) When add is called, the system shall sum. | TEST-CALC-001 |\n');
  fs.writeFileSync(path.join(d, 'add.mjs'), 'export const add = (a, b) => a + b;\n');
  const r = sdd(d, 'tdd', 'red', 'TEST-CALC-001');
  assert.match(r.out, /characterization: \(characterization\) REQ \(test passed\)/, r.out);
  assert.doesNotMatch(r.out, /\(test-only\) REQ/, r.out);

  const p = project();
  sdd(p, 'approve', 'record', 'calc', '--by', 'tester');
  fs.writeFileSync(path.join(p, 'add.test.mjs'), ["import { test } from 'node:test';", "import assert from 'node:assert/strict';", "import { add, reset } from './add.mjs';", '/** @id TEST-CALC-001 @verifies REQ-CALC-001 */', "test('TEST-CALC-001 adds', () => {", '  reset();', '  assert.equal(add(1, 2), 3);', '});', ''].join('\n'));
  fs.writeFileSync(path.join(p, 'add.mjs'), "export const add = () => 3;\nexport const reset = () => { throw new Error('not implemented: reset'); };\n");
  assert.match(sdd(p, 'tdd', 'red', 'TEST-CALC-001').out, /stub "reset" with a minimal working body/);
});

// ---- r23c (#312 artifact staleness / cargo workspace / impact) ----
const art312 = (extra = {}) => {
  const d = mini(SPEC2, { 'a.test.mjs': "// @id TEST-A-001 @verifies REQ-A-001\n// reads 'data/golden.json'\n\n// @id TEST-A-002 @verifies REQ-A-002\n// unrelated\n", 'data/golden.json': '[1]\n' }, FAIL);
  const cp = path.join(d, '.sdd/config.json');
  const c = JSON.parse(fs.readFileSync(cp, 'utf8'));
  Object.assign(c, { artifacts: { 'data/golden.json': ['src/impl.mjs'] }, artifactStaleness: true }, extra);
  fs.writeFileSync(cp, JSON.stringify(c));
  for (const t of ['TEST-A-001', 'TEST-A-002']) assert.equal(sdd(d, 'tdd', 'red', t).code, 0);
  setCmd(d, PASS);
  for (const t of ['TEST-A-001', 'TEST-A-002']) assert.equal(sdd(d, 'tdd', 'green', t).code, 0);
  fs.writeFileSync(path.join(d, 'data/golden.json'), '[2]\n');
  return d;
};

test('#312 tdd refactor --stale also re-verifies artifact-stale tests', () => {
  const d = art312();
  assert.match(sdd(d, 'gate', '--no-run').out, /artifact data\/golden\.json changed/);
  const r = sdd(d, 'tdd', 'refactor', '--stale');
  assert.match(r.out, /re-verifying 2 stale test\(s\): TEST-A-001 TEST-A-002/, r.out);
  assert.doesNotMatch(sdd(d, 'gate', '--no-run').out, /artifact data\/golden\.json changed/);
});

test('#312 artifactGranularity "test": only the test that names the artifact goes stale', () => {
  const d = art312({ artifactGranularity: 'test' });
  const o = sdd(d, 'gate', '--no-run').out;
  assert.match(o, /TEST-A-001[^\n]*artifact data\/golden\.json changed/, o);
  assert.doesNotMatch(o, /TEST-A-002[^\n]*artifact/, o);
});

test('#312 gate --changed: a Cargo workspace manifest with a member glob belongs to the project at a member crate', () => {
  const d = mini('---\nfeature: a\ntier: T1\n---\n| REQ-A-001 | x shall hold. | TEST-A-001 |\n', { 'rs/Cargo.toml': '[workspace]\nmembers = ["crates/*"]\n', 'rs/crates/a/Cargo.toml': '[package]\nname = "a"\n' });
  fs.writeFileSync(path.join(d, '.sdd/config.json'), JSON.stringify({ testCmd: PASS, checks: [], projects: [{ root: 'rs/crates/a', testCmd: PASS, checks: [{ name: 'ok', cmd: ['node', '-e', '0'] }] }] }));
  spawnSync('git', ['add', '-A'], { cwd: d });
  spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'i'], { cwd: d });
  fs.appendFileSync(path.join(d, 'rs/Cargo.toml'), '# c\n');
  const o = sdd(d, 'gate', '--changed').out;
  assert.match(o, /✓ cmd rs\/crates\/a:ok/, o);
  assert.doesNotMatch(o, /root-owned data\/config changes/, o);
});

test('#312 impact: a Cargo workspace manifest reaches the member crates\' REQs; a declared artifact only its readers', () => {
  const spec = '---\nfeature: a\ntier: T1\n---\n| REQ-A-001 | x shall hold. | TEST-A-001 |\n';
  const d = mini(spec, {
    '.sdd/specs/b.md': '---\nfeature: b\ntier: T1\n---\n| REQ-B-001 | y shall hold. | TEST-B-001 |\n',
    '.sdd/specs/c.md': '---\nfeature: c\ntier: T1\n---\n| REQ-C-001 | z shall hold. | TEST-C-001 |\n',
    'rs/Cargo.toml': '[workspace]\nmembers = ["crates/*"]\n', 'rs/crates/a/Cargo.toml': '[package]\nname = "a"\n',
    'rs/crates/a/src/lib.rs': '// @id CODE-A-001 @implements REQ-A-001\npub fn a() {}\n',
    'ts/x.test.mjs': "// @id TEST-B-001 @verifies REQ-B-001\n// reads 'contract/g.json'\n",
    'ts/y.test.mjs': "// @id TEST-C-001 @verifies REQ-C-001\n// unrelated\n",
    'contract/g.json': '[]\n',
  });
  const cp = path.join(d, '.sdd/config.json');
  const c = JSON.parse(fs.readFileSync(cp, 'utf8'));
  c.projects = [{ root: 'ts', testCmd: PASS, dependsOn: ['contract'] }];
  c.artifacts = { 'contract/g.json': ['ts/x.test.mjs'] };
  fs.writeFileSync(cp, JSON.stringify(c));
  const cargo = JSON.parse(sdd(d, 'impact', 'rs/Cargo.toml', '--json').out);
  assert.ok(cargo.otherReqs.some((o) => o.req === 'REQ-A-001'), JSON.stringify(cargo));
  const g = JSON.parse(sdd(d, 'impact', 'contract/g.json', '--json').out);
  assert.deepEqual(g.otherReqs.map((o) => o.req), ['REQ-B-001'], JSON.stringify(g));
});

// ---- r23d (#313): tdd stub CLI ----
const stubJs = (id, n) => `// @id TEST-A-00${id} @verifies REQ-A-00${id}\ntest('TEST-A-00${id} x', () => {\n  assert.equal(f${n}(1), 1);\n});\n`;
const T2SPEC313 = '---\nfeature: a\ntier: T2\napproval: human\n---\n## Design\nx\n\n| REQ-A-001 | one shall hold. | TEST-A-001 |\n| REQ-A-002 | two shall hold. | TEST-A-002 |\n';

test('#313 tdd stub: `--all <ID>` takes the ID (flag before the ID) and usage lists --all', () => {
  const d = mini(T2SPEC313, { 'a.test.mjs': "import { f1, f2 } from './lib.mjs';\n" + stubJs(1, 1) + stubJs(2, 2) }, PASS);
  const r = sdd(d, 'tdd', 'stub', '--all', 'TEST-A-001');
  assert.doesNotMatch(r.out, /undefined/, r.out);
  assert.equal(r.code, 0, r.out);
  assert.match(sdd(d, 'tdd', 'bogus').out, /--all/);
});

test('#313 tdd stub: IDs from two test files name the other file, not "is not a TEST"', () => {
  const d = mini(T2SPEC313, { 'a.test.mjs': "import { f1 } from './lib.mjs';\n" + stubJs(1, 1), 'b.test.mjs': "import { f2 } from './lib.mjs';\n" + stubJs(2, 2) }, PASS);
  const r = sdd(d, 'tdd', 'stub', 'TEST-A-001', 'TEST-A-002');
  assert.equal(r.code, 2, r.out);
  assert.doesNotMatch(r.out, /is not a TEST/, r.out);
  assert.match(r.out, /b\.test\.mjs/, r.out);
});

test('#313 tdd stub: an unapproved T2 feature gets a warning that tdd red will refuse', () => {
  const d = mini(T2SPEC313, { 'a.test.mjs': "import { f1 } from './lib.mjs';\n" + stubJs(1, 1) }, PASS);
  const r = sdd(d, 'tdd', 'stub', 'TEST-A-001');
  assert.match(r.out, /! .*approv.*tdd red/i, r.out);
});

test('#314 a (characterization) REQ Red names its own marker, a (test-only) REQ keeps its label', () => {
  const c = sdd(mini(T1SPEC.replace('one shall hold.', 'one shall hold. (characterization)'), { 'a.test.mjs': jsTest() }, PASS), 'tdd', 'red', 'TEST-A-001');
  assert.match(c.out, /characterization: \(characterization\) REQ/, c.out);
  assert.doesNotMatch(c.out, /\(test-only\)/, c.out);
  const t = sdd(mini(T1SPEC.replace('one shall hold.', 'one shall hold. (test-only)'), { 'a.test.mjs': jsTest() }, PASS), 'tdd', 'red', 'TEST-A-001');
  assert.match(t.out, /\(test-only\) REQ/, t.out);
});

test('#314 approve <feature> without a subcommand names the missing subcommand', () => {
  const d = mini(T1SPEC, {}, PASS);
  const r = sdd(d, 'approve', 'a');
  assert.equal(r.code, 2);
  assert.match(r.out, /approve record a/, r.out);
  assert.doesNotMatch(r.out, /unknown feature ""/, r.out);
});

test('#314 a flaky gate pass says the ledger was appended', () => {
  const r = sdd(flakyProject({ policy: 'warn' }, FLAKY_ONCE), 'gate');
  assert.match(r.out, /appended to \.sdd\/tdd\.jsonl/, r.out);
});

// ---- r24a (design 3.1 scope confidence) ----
function scopeProj(extra = {}, files = {}) {
  const d = mini('---\nfeature: a\ntier: T1\n---\n| REQ-A-001 | x shall hold. | TEST-A-001 |\n', { 'app/package.json': '{}', 'app/x.mjs': 'export {};\n', ...files });
  fs.writeFileSync(path.join(d, '.sdd/config.json'), JSON.stringify({ testCmd: PASS, checks: [], projects: [{ root: 'app', testCmd: PASS, checks: [{ name: 'ok', cmd: ['node', '-e', '0'] }] }], ...extra }));
  spawnSync('git', ['add', '-A'], { cwd: d });
  spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'i'], { cwd: d });
  return d;
}
test('r24a gate --changed prints a scope summary line and exposes it in --json', () => {
  const d = scopeProj();
  fs.appendFileSync(path.join(d, 'app/x.mjs'), '// c\n');
  assert.match(sdd(d, 'gate', '--changed').out, /^scope: exact=1 widened=0 unknown=0$/m);
  assert.deepEqual(JSON.parse(sdd(d, 'gate', '--changed', '--json').out).scope.exact, 1);
});
test('r24a an unclaimed changed file warns by default and fails under scopePolicy strict; allow-list waives', () => {
  const d = scopeProj({}, { 'misc/data.bin': 'a' });
  fs.appendFileSync(path.join(d, 'misc/data.bin'), 'b');
  const w = sdd(d, 'gate', '--changed');
  assert.match(w.out, /! scope: 1 changed file\(s\) not claimed.*misc\/data\.bin/, w.out);
  assert.match(w.out, /unknown=1/, w.out);
  assert.doesNotMatch(w.out, /✗ scope/, w.out);
  const cp = path.join(d, '.sdd/config.json');
  const c = JSON.parse(fs.readFileSync(cp, 'utf8'));
  fs.writeFileSync(cp, JSON.stringify({ ...c, scopePolicy: 'strict' }));
  const s = sdd(d, 'gate', '--changed');
  assert.equal(s.code, 1, s.out);
  assert.match(s.out, /✗ scope:.*misc\/data\.bin/, s.out);
  assert.doesNotMatch(sdd(d, "gate", "--changed", "--allow-unscoped", "misc/**").out, /✗ scope/);
  assert.match(fs.readFileSync(path.join(d, '.sdd/tdd.jsonl'), 'utf8'), /scope-waiver/);
  fs.writeFileSync(cp, JSON.stringify({ ...c, scopePolicy: 'strict', unscoped: ['misc/**'] }));
  const u = sdd(d, 'gate', '--changed');
  assert.doesNotMatch(u.out, /✗ scope/, u.out);
  assert.match(u.out, /unscoped by config/, u.out);
});
test('r24a default ignore globs (docs, .github, LICENSE) never count as unscoped', () => {
  const d = scopeProj({ scopePolicy: 'strict' }, { 'docs/a.md': 'a', LICENSE: 'a', '.github/w.yml': 'a' });
  for (const f of ['docs/a.md', 'LICENSE', '.github/w.yml']) fs.appendFileSync(path.join(d, f), 'b');
  const o = sdd(d, 'gate', '--changed').out;
  assert.match(o, /unknown=0/, o);
  assert.doesNotMatch(o, /✗ scope/, o);
});
test('r24a a root package.json / Cargo.toml change widens to every project of that ecosystem', () => {
  const d = scopeProj({}, { 'package.json': '{"private":true}\n', 'Cargo.toml': '[package]\nname="r"\n', 'rs/Cargo.toml': '[package]\nname="b"\n' });
  const cp = path.join(d, '.sdd/config.json');
  const c = JSON.parse(fs.readFileSync(cp, 'utf8'));
  c.projects.push({ root: 'rs', testCmd: PASS, checks: [{ name: 'ok', cmd: ['node', '-e', '0'] }] });
  fs.writeFileSync(cp, JSON.stringify(c));
  spawnSync('git', ['add', '-A'], { cwd: d });
  spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'p'], { cwd: d });
  fs.appendFileSync(path.join(d, 'package.json'), ' \n');
  const o = sdd(d, 'gate', '--changed').out;
  assert.match(o, /✓ cmd app:ok/, o);
  assert.doesNotMatch(o, /✓ cmd rs:ok/, o);
  fs.appendFileSync(path.join(d, 'Cargo.toml'), '# c\n');
  const o2 = sdd(d, 'gate', '--changed').out;
  assert.match(o2, /✓ cmd rs:ok/, o2);
});
test('r24a init writes scopePolicy strict for a new config only', () => {
  const d = mini('---\nfeature: a\ntier: T1\n---\n| REQ-A-001 | x shall hold. | TEST-A-001 |\n');
  const cp = path.join(d, '.sdd/config.json');
  assert.equal(JSON.parse(fs.readFileSync(cp, 'utf8')).scopePolicy, 'strict');
  const c = JSON.parse(fs.readFileSync(cp, 'utf8'));
  delete c.scopePolicy;
  fs.writeFileSync(cp, JSON.stringify(c));
  sdd(d, 'init');
  assert.equal(JSON.parse(fs.readFileSync(cp, 'utf8')).scopePolicy, undefined);
});

const R24B_SPEC = '---\nfeature: h\ntier: T1\n---\n| REQ-H-001 | a shall hold. | TEST-H-001 |\n';
const r24bProject = (test) => mini(R24B_SPEC, {
  'Cargo.toml': '[package]\nname = "repro"\nversion = "0.1.0"\nedition = "2021"\n',
  'src/lib.rs': '',
  'tests/h_test.rs': `use repro::LIMIT;\n\n// @id TEST-H-001\n// @verifies REQ-H-001\n#[test]\nfn test_h_001() {\n${test}\n}\n`,
});
const cargoOk = { skip: spawnSync('which', ['cargo']).status !== 0 };

test('#r24b a const with no type evidence gets an SDD-TODO(stub) placeholder, not a wrong i64', cargoOk, () => {
  const d = r24bProject('    assert!(LIMIT.is_ok());');
  const r = sdd(d, 'tdd', 'stub', 'TEST-H-001', '--report');
  const lib = fs.readFileSync(path.join(d, 'src/lib.rs'), 'utf8');
  assert.match(lib, /SDD-TODO\(stub\): type unknown/, lib);
  assert.doesNotMatch(lib, /LIMIT: i64/, lib);
  assert.match(r.out, /LIMIT \| guessed \| tests\/h_test\.rs:\d+/, r.out);
});

test('#r24b a const typed by a float literal stays f64 and is reported inferred', cargoOk, () => {
  const d = r24bProject('    assert_eq!(LIMIT, 1e-5);');
  const r = sdd(d, 'tdd', 'stub', 'TEST-H-001', '--report');
  assert.match(fs.readFileSync(path.join(d, 'src/lib.rs'), 'utf8'), /pub const LIMIT: f64/);
  assert.match(r.out, /LIMIT \| inferred \|/, r.out);
});

test('#r24b tdd red names the SDD-TODO(stub) element instead of accepting a compile error', cargoOk, () => {
  const d = r24bProject('    assert!(LIMIT.is_ok());');
  sdd(d, 'tdd', 'stub', 'TEST-H-001');
  setCmd(d, ['cargo', 'test', '--offline', '{testName}']);
  const r = sdd(d, 'tdd', 'red', 'TEST-H-001');
  assert.match(r.out, /REJECTED[^\n]*SDD-TODO\(stub\) element LIMIT[^\n]*fill the type of LIMIT by hand/, r.out);
});

test('r24c suspect Red: heuristic setup-call Red is recorded as suspect, accepted, hinted and listed in the gate; load-time stub stays plain weak', () => {
  const d = project();
  sdd(d, 'approve', 'record', 'calc', '--by', 'tester');
  fs.writeFileSync(path.join(d, 'add.test.mjs'), [
    "import { test } from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { add, reset } from './add.mjs';",
    '/** @id TEST-CALC-001 @verifies REQ-CALC-001 */',
    "test('TEST-CALC-001 adds', () => {",
    '  reset();',
    '  assert.equal(add(1, 2), 3);',
    '});',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(d, 'add.mjs'), "export const add = () => 3;\nexport const reset = () => { throw new Error('not implemented: reset'); };\n");
  const r = sdd(d, 'tdd', 'red', 'TEST-CALC-001');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /! suspect Red.*tdd red TEST-CALC-001 --allow-setup-red/, r.out);
  const last = fs.readFileSync(path.join(d, '.sdd/tdd.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).at(-1);
  assert.equal(last.suspect, true);
  assert.equal(last.weak, true);
  const hint = sdd(d, 'tdd', 'red', 'TEST-CALC-001', '--allow-setup-red');
  assert.equal(hint.code, 0, hint.out);
  assert.doesNotMatch(hint.out, /suspect/);
  sdd(d, 'tdd', 'red', 'TEST-CALC-001');
  fs.writeFileSync(path.join(d, 'add.mjs'), 'export const add = (a, b) => a + b;\nexport const reset = () => {};\n');
  assert.equal(sdd(d, 'tdd', 'green', 'TEST-CALC-001').code, 0);
  assert.match(sdd(d, 'gate', '--no-run').out, /1 suspect Red.*TEST-CALC-001/);
});

// ---- r25c ----
test('r25c gate --json exposes weak/suspect Reds', () => {
  const d = mini('---\nfeature: calc\ntier: T1\n---\n| REQ-CALC-001 | calc shall add. | TEST-CALC-001 |\n', {});
  const j = JSON.parse(sdd(d, 'gate', '--no-run', '--json').out);
  assert.deepEqual(j.tdd, { weak: [], suspect: [] });
});
test('r25c gate --changed --explain prints closure and per-file claims; default output unchanged', () => {
  const d = scopeProj();
  fs.appendFileSync(path.join(d, 'app/x.mjs'), '// c\n');
  const e = sdd(d, 'gate', '--changed', '--explain');
  assert.match(e.out, /explain app:ok: scope=exact closure=1 \[app\]/, e.out);
  assert.match(e.out, /app\/x\.mjs: claimed: under app/, e.out);
  assert.doesNotMatch(sdd(d, 'gate', '--changed').out, /explain/);
  assert.ok(JSON.parse(sdd(d, 'gate', '--changed', '--explain', '--json').out).scope.explain.length);
});
for (const [name, manifest, rootFile] of [['go', 'go.mod', 'go.sum'], ['java', 'pom.xml', 'build.gradle.kts'], ['elixir', 'mix.exs', 'mix.lock'], ['csharp', 'App.csproj', 'Directory.Build.props']]) {
  test(`r25c root ${rootFile} change widens to ${name} projects`, () => {
    const d = scopeProj({}, { [`app/${manifest}`]: '', [rootFile]: 'a\n' });
    spawnSync('git', ['add', '-A'], { cwd: d });
    spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'm'], { cwd: d });
    fs.appendFileSync(path.join(d, rootFile), 'b\n');
    const r = sdd(d, 'gate', '--changed');
    assert.match(r.out, /✓ cmd app:ok/, r.out);
    assert.match(r.out, /scope: exact=0 widened=1 unknown=0/, r.out);
  });
}

// ---- r24d (design 3.4 self-verification) ----
// (1) scope differential: `gate --changed` scope must be a superset of the brute-force oracle's relevant checks
const R24D_HASH = "const fs=require('fs'),p=require('path'),c=require('crypto');const h=c.createHash('sha1');const w=(x)=>{if(!fs.existsSync(x))return;if(fs.statSync(x).isDirectory()){for(const e of fs.readdirSync(x).sort())w(p.join(x,e));}else{h.update(x+'\\0'+fs.readFileSync(x));}};for(const a of process.argv.slice(1))w(a);console.log(h.digest('hex'));";
const r24dGit = (d, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: d, encoding: 'utf8' });
function r24dWorkspace({ files, projects, rootInputs }) {
  const d = mini('---\nfeature: a\ntier: T1\n---\n| REQ-A-001 | x shall hold. | TEST-A-001 |\n', files);
  fs.rmSync(path.join(d, 'package.json'), { force: true });
  const closure = (p, seen = new Set()) => { for (const x of [p.root, ...(p.dependsOn ?? [])]) if (!seen.has(x)) { seen.add(x); const q = projects.find((y) => y.root === x); if (q && q !== p) closure(q, seen); } return [...seen]; };
  const inputsOf = (p) => [...closure(p), ...rootInputs].map((x) => path.join(d, x));
  const cmdOf = (p) => ['node', '-e', R24D_HASH, ...inputsOf(p)];
  fs.writeFileSync(path.join(d, '.sdd/config.json'), JSON.stringify({ testCmd: PASS, checks: [], projects: projects.map((p) => ({ root: p.root, dependsOn: p.dependsOn, testCmd: PASS, checks: [{ name: 'ok', cmd: cmdOf(p) }] })) }));
  r24dGit(d, 'add', '-A');
  r24dGit(d, 'commit', '-qm', 'i');
  const result = (p) => spawnSync(cmdOf(p)[0], cmdOf(p).slice(1), { cwd: path.join(d, p.root), encoding: 'utf8' }).stdout;
  return { d, result };
}
function r24dDifferential(ws, projects, mutate, { policy } = {}) {
  const { d, result } = ws;
  const base = Object.fromEntries(projects.map((p) => [p.root, result(p)]));
  mutate(d);
  const relevant = projects.filter((p) => result(p) !== base[p.root]).map((p) => p.root);
  const cp = path.join(d, '.sdd/config.json');
  if (policy) fs.writeFileSync(cp, JSON.stringify({ ...JSON.parse(fs.readFileSync(cp, 'utf8')), scopePolicy: policy }));
  const g = sdd(d, 'gate', '--changed');
  const ran = projects.filter((p) => new RegExp(`✓ cmd ${p.root.replace(/[/.]/g, '\\$&')}:ok`).test(g.out)).map((p) => p.root);
  r24dGit(d, 'checkout', '-q', '--', '.');
  r24dGit(d, 'clean', '-fdq', '-e', '.sdd');
  return { relevant, ran, out: g.out, code: g.code };
}
const R24D_ECOSYSTEMS = {
  cargo: {
    files: { 'Cargo.toml': '[workspace]\nmembers=["crates/a","crates/b","crates/c"]\n', 'Cargo.lock': '# lock\n', 'rust-toolchain.toml': '[toolchain]\nchannel="stable"\n', '.cargo/config.toml': '[build]\n', 'crates/a/Cargo.toml': '[package]\nname="a"\n', 'crates/a/src/lib.rs': 'pub fn a() {}\n', 'crates/b/Cargo.toml': '[package]\nname="b"\n', 'crates/b/src/lib.rs': 'pub fn b() {}\n', 'crates/c/Cargo.toml': '[package]\nname="c"\n', 'crates/c/src/lib.rs': 'pub fn c() {}\n', 'misc/data.bin': 'x' },
    projects: [{ root: 'crates/a' }, { root: 'crates/b' }, { root: 'crates/c', dependsOn: ['crates/b'] }],
    rootInputs: ['Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml', '.cargo/config.toml'],
  },
  js: {
    files: { 'package.json': '{"private":true,"workspaces":["packages/*"]}\n', 'package-lock.json': '{}\n', 'pnpm-workspace.yaml': 'packages:\n  - packages/*\n', 'packages/x/package.json': '{"name":"x"}\n', 'packages/x/index.mjs': 'export const x = 1;\n', 'packages/y/package.json': '{"name":"y"}\n', 'packages/y/index.mjs': 'export const y = 1;\n', 'misc/data.bin': 'x' },
    projects: [{ root: 'packages/x' }, { root: 'packages/y', dependsOn: ['packages/x'] }],
    rootInputs: ['package.json', 'package-lock.json', 'pnpm-workspace.yaml'],
  },
  python: {
    files: { 'pyproject.toml': '[tool]\n', 'requirements.txt': 'a\n', 'py/a/pyproject.toml': '[project]\nname="a"\n', 'py/a/a.py': 'A = 1\n', 'py/b/requirements.txt': 'b\n', 'py/b/b.py': 'B = 1\n', 'misc/data.bin': 'x' },
    projects: [{ root: 'py/a' }, { root: 'py/b' }],
    rootInputs: ['pyproject.toml', 'requirements.txt'],
  },
};
for (const [eco, spec] of Object.entries(R24D_ECOSYSTEMS)) {
  test(`r24d scope differential (${eco}): every single-file mutation keeps scope ⊇ oracle-relevant checks`, () => {
    const ws = r24dWorkspace(spec);
    const claimedFiles = Object.keys(spec.files).filter((f) => f !== 'misc/data.bin');
    const mutations = [
      ...claimedFiles.map((f) => [`edit ${f}`, (d) => fs.appendFileSync(path.join(d, f), '\n# r24d mutation\n')]),
      ...spec.projects.map((p) => [`add file in ${p.root}`, (d) => fs.writeFileSync(path.join(d, p.root, 'added.txt'), 'new\n')]),
    ];
    let relevantSeen = 0;
    for (const [name, mutate] of mutations) {
      const r = r24dDifferential(ws, spec.projects, mutate);
      relevantSeen += r.relevant.length;
      assert.deepEqual(r.relevant.filter((x) => !r.ran.includes(x)), [], `${eco}: ${name} silently skipped a relevant check (ran=${r.ran} relevant=${r.relevant})\n${r.out}`);
      assert.doesNotMatch(r.out, /✗ cmd/, `${eco}: ${name}\n${r.out}`);
    }
    assert.ok(relevantSeen >= spec.projects.length + spec.rootInputs.length, `${eco}: oracle found only ${relevantSeen} relevant checks, differential is vacuous`);
  });
  test(`r24d scope differential (${eco}): an unclaimed file is irrelevant to every check but warns, and fails under strict`, () => {
    const ws = r24dWorkspace(spec);
    const mutate = (d) => fs.appendFileSync(path.join(d, 'misc/data.bin'), 'y');
    const w = r24dDifferential(ws, spec.projects, mutate);
    assert.deepEqual(w.relevant, []);
    assert.match(w.out, /! scope: 1 changed file\(s\) not claimed.*misc\/data\.bin/, w.out);
    assert.doesNotMatch(w.out, /✗ scope/, w.out);
    const s = r24dDifferential(ws, spec.projects, mutate, { policy: 'strict' });
    assert.equal(s.code, 1, s.out);
    assert.match(s.out, /✗ scope:.*misc\/data\.bin/, s.out);
  });
}

// (2) stub round-trip: synthetic Rust tests modelled on the wave-15 stub captures (own code, not copied)
const R24D_NO_CARGO = spawnSync('which', ['cargo']).status !== 0;
const r24dCargoSkip = R24D_NO_CARGO ? 'SKIP: toolchain missing (cargo)' : false;
const r24dRustStub = (body, uses, source = '') => {
  const d = mini(R24B_SPEC, {
    'Cargo.toml': '[package]\nname = "repro"\nversion = "0.1.0"\nedition = "2021"\n',
    'src/lib.rs': source,
    'tests/h_test.rs': `use repro::{${uses}};\n\n// @id TEST-H-001\n// @verifies REQ-H-001\n#[test]\nfn test_h_001() {\n${body}\n}\n`,
  });
  const r = sdd(d, 'tdd', 'stub', 'TEST-H-001', '--report');
  const lib = fs.readFileSync(path.join(d, 'src/lib.rs'), 'utf8');
  const rows = [...r.out.matchAll(/^ {2}([\w:]+) \| (shown|inferred|guessed) \| (\S+)$/gm)].map((m) => ({ element: m[1], confidence: m[2], evidence: m[3] }));
  return { d, out: r.out, lib, rows };
};
// every generated const/type either has evidence-backed confidence or an SDD-TODO(stub) marker, and --report lists it
function r24dAssertStubInvariants({ d, out, lib, rows }, label) {
  const lines = lib.split('\n');
  for (const l of lines) {
    const c = /^pub const (\w+): (.+?) =/.exec(l);
    if (c) {
      const row = rows.find((r) => r.element === c[1]);
      assert.ok(row, `${label}: const ${c[1]} is not listed by --report\n${out}`);
      if (/SDD-TODO\(stub\)/.test(l)) assert.equal(row.confidence, 'guessed', `${label}: marked ${c[1]} must be reported guessed`);
      else { assert.notEqual(row.confidence, 'guessed', `${label}: ${c[1]} is guessed but carries no SDD-TODO(stub) marker`); assert.notEqual(c[2], '()', `${label}: unit placeholder without marker for ${c[1]}`); }
    }
    const t = /^pub (?:struct|enum|trait) (\w+)/.exec(l);
    if (t) assert.ok(rows.some((r) => r.element === t[1]), `${label}: type ${t[1]} is not listed by --report\n${out}`);
  }
  for (const row of rows) {
    if (row.confidence === 'guessed') assert.match(lib, new RegExp(`(?:const|fn) ${row.element.split('::').at(-1)}[^\\n]*SDD-TODO\\(stub\\)`), `${label}: guessed ${row.element} has no marker`);
    const m = /^(.+):(\d+)$/.exec(row.evidence);
    assert.ok(m, `${label}: evidence of ${row.element} has no file:line (${row.evidence})`);
    assert.match(fs.readFileSync(path.join(d, m[1]), 'utf8').split('\n')[Number(m[2]) - 1] ?? '', new RegExp(`\\b${row.element.split('::').at(-1)}\\b`), `${label}: evidence line for ${row.element} does not mention it`);
  }
}
const R24D_STUB_CORPUS = {
  'str const compared with a literal': ['NAME', '    assert_eq!(NAME, "abc");', /pub const NAME: &str/],
  'float const next to a float literal': ['EPSILON', '    assert!((1.0f64 - 1.0).abs() < EPSILON / 2.0);', /pub const EPSILON: f64/],
  'indexed const compared with a typed literal': ['PRIMES', '    assert_eq!(PRIMES[0], 2u32);', /pub const PRIMES: &\[u32\]/],
  'const compared with Some(typed)': ['MAYBE', '    assert_eq!(MAYBE, Some(3u8));', /pub const MAYBE: Option<u8>/],
  'method called on a const with no type evidence': ['LIMIT', '    assert!(LIMIT.is_ok());', /LIMIT: \(\) = \(\); \/\/ SDD-TODO\(stub\)/],
};
for (const [name, [id, body, expected]] of Object.entries(R24D_STUB_CORPUS)) {
  test(`r24d stub round-trip: ${name} -> evidence-typed or SDD-TODO(stub), listed by --report`, cargoOk, () => {
    const s = r24dRustStub(body, id);
    assert.match(s.lib, expected, s.lib);
    r24dAssertStubInvariants(s, name);
  });
  test(`r24d stub round-trip: ${name} -> compiles or carries a marker`, { skip: r24dCargoSkip }, () => {
    const s = r24dRustStub(body, id);
    const b = spawnSync('cargo', ['test', '--offline', '--no-run'], { cwd: s.d, encoding: 'utf8', env: ENV });
    if (b.status !== 0) assert.match(s.lib, /SDD-TODO\(stub\)/, `${name}: stub does not compile and has no SDD-TODO(stub) marker\n${b.stderr}`);
  });
}
test('r24d stub round-trip: struct/enum shapes from a call-heavy test are all listed by --report', cargoOk, () => {
  const s = r24dRustStub("    let s = Segment::Glob(vec![Token::Lit('a')]);\n    assert!(s.is_glob());", 'Segment, Token');
  assert.match(s.lib, /pub enum Segment/);
  assert.match(s.lib, /pub enum Token/);
  r24dAssertStubInvariants(s, 'types');
});
test('r24d stub round-trip: toolchain gaps are counted, never silently dropped', () => {
  assert.ok(R24D_NO_CARGO || r24dCargoSkip === false, 'SKIP: toolchain missing (cargo) must be a counted skip, not a pass');
});

/** @id TEST-RSTUB-001 @verifies REQ-RSTUB-001 */
test('#381 TEST-RSTUB-001 unsupported function returns carry named markers and guessed rows', () => {
  assert.equal(R24D_NO_CARGO, false, 'cargo is required');
  for (const [name, body] of [
    ['mystery', 'assert!(mystery(5).ok());'],
    ['parse_flag', 'assert!(parse_flag("yes").ok().is_some());'],
  ]) {
    const s = r24dRustStub(`    ${body}`, name);
    assert.match(s.lib, new RegExp(`fn ${name}[^\\n]*SDD-TODO\\(stub\\)`), s.lib);
    assert.equal(s.rows.find(row => row.element === name)?.confidence, 'guessed', s.out);
    assert.match(s.out, new RegExp(`! ${name}:.*fill the type by hand`), s.out);
    r24dAssertStubInvariants(s, name);
  }
});
/** @id TEST-RSTUB-CONTROL-001 @verifies REQ-RSTUB-004 */
test('#381 TEST-RSTUB-CONTROL-001 evidenced functions and typed constants preserve native compilation', () => {
  assert.equal(R24D_NO_CARGO, false, 'cargo is required');
  const s = r24dRustStub('    assert_eq!(tally(&[1u8, 2]), 3);', 'tally');
  assert.match(s.lib, /pub fn tally/);
  assert.equal(s.rows.find(row => row.element === 'tally')?.confidence, 'inferred', s.out);
  const typed = r24dRustStub('    let x: f64 = TOLERANCE; assert!(x >= 0.0);', 'TOLERANCE');
  assert.match(typed.lib, /pub const TOLERANCE: f64 = 0.0;/);
  assert.equal(typed.rows.find(row => row.element === 'TOLERANCE')?.confidence, 'shown', typed.out);
  for (const fixture of [s, typed]) {
    assert.doesNotMatch(fixture.lib, /SDD-TODO\(stub\)/);
    const native = spawnSync('cargo', ['test', '--offline', '--no-run'], { cwd: fixture.d, encoding: 'utf8', env: ENV });
    assert.equal(native.status, 0, native.stderr);
    r24dAssertStubInvariants(fixture, 'supported control');
  }
});
/** @id TEST-RSTUB-002 @verifies REQ-RSTUB-002 */
test('#381 TEST-RSTUB-002 methods report owner-specific evidence or marked unknown returns', () => {
  assert.equal(R24D_NO_CARGO, false, 'cargo is required');
  for (const body of [
    'assert_eq!(Ratio::new(1, 2).value(), 0.5);',
    'assert_eq!(Gauge::new(4, 8).fraction(), 0.25);',
    'assert_eq!(0.25, Gauge::new(4, 8).fraction(), "message");',
    'assert!(Gauge::new(4, 8).fraction() == 0.25);',
    'let g = Gauge::new(4, 8);\n    assert_eq!(g.fraction(), 0.25);\n    assert_eq!(Switch::new().fraction(), true);',
  ]) {
    const ratio = body.includes('Ratio'), s = r24dRustStub(`    ${body}`, ratio ? 'Ratio' : body.includes('Switch') ? 'Gauge, Switch' : 'Gauge');
    const owner = ratio ? 'Ratio' : 'Gauge', method = ratio ? 'value' : 'fraction';
    assert.match(s.lib, new RegExp(`fn ${method}\\(&self\\) -> f64`), s.lib);
    assert.equal(s.rows.find(row => row.element === `${owner}::${method}`)?.confidence, 'inferred', s.out);
    if (body.includes('Switch')) {
      assert.match(s.lib, /fn fraction\(&self\) -> bool/, s.lib);
      assert.equal(s.rows.find(row => row.element === 'Switch::fraction')?.confidence, 'inferred', s.out);
      assert.notEqual(s.rows.find(row => row.element === 'Gauge::fraction')?.evidence,
        s.rows.find(row => row.element === 'Switch::fraction')?.evidence, 'distinct owners need their actual usage lines');
    }
    assert.doesNotMatch(s.lib, /SDD-TODO\(stub\)/);
    const native = spawnSync('cargo', ['test', '--offline', '--no-run'], { cwd: s.d, encoding: 'utf8', env: ENV });
    assert.equal(native.status, 0, native.stderr);
    r24dAssertStubInvariants(s, 'method control');
  }
  for (const body of [
    'assert!(Gauge::new(4, 8).fraction().ok().is_some(), "0.25");',
    'assert_eq!(Switch::new().fraction(), true);\n    assert!(Gauge::new(4, 8).fraction().ok().is_some());',
  ]) {
    const unknown = r24dRustStub(`    ${body}`, body.includes('Switch') ? 'Gauge, Switch' : 'Gauge');
    assert.match(unknown.lib, /fn fraction[^\n]*SDD-TODO\(stub\)/, unknown.lib);
    assert.equal(unknown.rows.find(row => row.element === 'Gauge::fraction')?.confidence, 'guessed', unknown.out);
    assert.match(unknown.out, /! Gauge::fraction:.*fill the type by hand/, unknown.out);
    r24dAssertStubInvariants(unknown, 'unsupported method');
  }
});
/** @id TEST-RSTUB-003 @verifies REQ-RSTUB-003 */
test('#381 TEST-RSTUB-003 unsupported loop element types remain explicitly guessed', () => {
  assert.equal(R24D_NO_CARGO, false, 'cargo is required');
  for (const [name, body] of [
    ['TABLE', 'for (a, b) in TABLE { assert_eq!(a, b); }'],
    ['SWITCHES', 'for (enabled, expected) in SWITCHES { assert_eq!(*enabled, true); assert_eq!(expected, expected); }'],
    ['ITEMS', 'for enabled in ITEMS { assert_eq!(enabled, enabled); }'],
  ]) {
    const s = r24dRustStub(`    ${body}`, name);
    assert.match(s.lib, new RegExp(`const ${name}[^\\n]*SDD-TODO\\(stub\\)`), s.lib);
    assert.equal(s.rows.find(row => row.element === name)?.confidence, 'guessed', s.out);
    assert.match(s.out, new RegExp(`! ${name}:.*fill the type by hand`), s.out);
    r24dAssertStubInvariants(s, name);
  }
});
/** @id TEST-RSTUB-004 @verifies REQ-RSTUB-004 */
test('#381 TEST-RSTUB-004 placeholder compile failures refuse Red and preserve evidence bytes', () => {
  assert.equal(R24D_NO_CARGO, false, 'cargo is required');
  for (const [uses, body, element, repaired] of [
    ['parse_flag', 'assert!(parse_flag("yes").ok().is_some());', 'parse_flag', 'pub fn parse_flag(_: &str) -> Result<bool, ()> { Err(()) }\n'],
    ['Gauge', 'assert!(Gauge::new(4, 8).fraction().ok().is_some());', 'fraction', 'pub struct Gauge; impl Gauge { pub fn new(_: i32, _: i32) -> Self { Self } pub fn fraction(&self) -> Result<bool, ()> { Err(()) } }\n'],
    ['SWITCHES', 'for (enabled, expected) in SWITCHES { assert_eq!(*enabled, true); assert_eq!(expected, expected); }', 'SWITCHES', 'pub const SWITCHES: &[(bool, bool)] = &[(true, false)];\n'],
  ]) {
    const s = r24dRustStub(`    ${body}`, uses), source = path.join(s.d, 'src/lib.rs'), ledger = path.join(s.d, '.sdd/tdd.jsonl');
    const native = spawnSync('cargo', ['test', '--offline', '--no-run'], { cwd: s.d, encoding: 'utf8', env: ENV });
    assert.notEqual(native.status, 0, 'placeholder must reproduce native type failure');
    const rejected = sdd(s.d, 'tdd', 'red', 'TEST-H-001');
    assert.equal(rejected.code, 1, rejected.out);
    assert.match(rejected.out, new RegExp(`SDD-TODO\\(stub\\) element ${element}.*not a Red`), rejected.out);
    assert.equal(fs.existsSync(ledger), false, rejected.out);
    fs.writeFileSync(source, repaired);
    const valid = spawnSync('cargo', ['test', '--offline', '--no-run'], { cwd: s.d, encoding: 'utf8', env: ENV });
    assert.equal(valid.status, 0, valid.stderr);
    if (uses !== 'parse_flag') continue;
    const red = sdd(s.d, 'tdd', 'red', 'TEST-H-001');
    assert.equal(red.code, 0, red.out);
    assert.doesNotMatch(red.out, /\[weak\]/);
    const before = fs.readFileSync(ledger);
    fs.writeFileSync(source, s.lib);
    const refusedAgain = sdd(s.d, 'tdd', 'red', 'TEST-H-001');
    assert.equal(refusedAgain.code, 1, refusedAgain.out);
    assert.match(refusedAgain.out, /SDD-TODO\(stub\) element parse_flag.*not a Red/, refusedAgain.out);
    assert.deepEqual(fs.readFileSync(ledger), before);
  }
});

/** @id TEST-RSTUB-005 @verifies REQ-RSTUB-005 */
test('TEST-RSTUB-005 explicit adjacent Result aliases type whole calls without inventing payloads', () => {
  assert.equal(R24D_NO_CARGO, false, 'cargo is required');
  for (const [uses, call, element, errorType] of [
    ['parse_flag', 'parse_flag("yes")', 'parse_flag', '()'],
    ['Gauge', 'Gauge::new().parse("yes")', 'Gauge::parse', 'String'],
    ['Gauge', 'g.parse("yes")', 'Gauge::parse', '()'],
  ]) {
    for (const direct of [false, true]) {
      const ty = `Result<bool, ${errorType}>`;
      const s = r24dRustStub(`    ${call.startsWith('g.') ? 'let g = Gauge::new();\n    ' : ''}${direct
        ? `let parsed: ${ty} = ${call}; assert!(parsed.ok().is_some());`
        : `let parsed = ${call}; let typed: ${ty} = parsed; assert!(typed.ok().is_some());`}`, uses);
      assert.match(s.lib, new RegExp(`fn ${element.split('::').at(-1)}[^\\n]*-> Result<bool, ${errorType === '()' ? '\\(\\)' : errorType}>`), s.lib);
      assert.equal(s.rows.find(row => row.element === element)?.confidence,
        direct && uses === 'parse_flag' ? 'shown' : 'inferred', s.out);
      assert.doesNotMatch(s.lib, /SDD-TODO\(stub\)/, s.lib);
      const native = spawnSync('cargo', ['test', '--offline', '--no-run'], { cwd: s.d, encoding: 'utf8', env: ENV });
      assert.equal(native.status, 0, native.stderr);
      r24dAssertStubInvariants(s, 'explicit Result');
    }
  }
  for (const [uses, call, element] of [
    ['parse_flag', 'parse_flag("yes")', 'parse_flag'],
    ['Gauge', 'Gauge::new().parse("yes")', 'Gauge::parse'],
    ['Gauge', 'g.parse("yes")', 'Gauge::parse'],
  ]) for (const body of [
    `assert!(${call}.ok().is_some());`,
    `let parsed = ${call}.ok(); let typed: Result<bool, ()> = parsed;`,
    `let parsed = ${call}; let parsed = Err(()); let typed: Result<bool, ()> = parsed;`,
    `let parsed = ${call}; let other: Result<bool, ()> = Err(());`,
    `let parsed = ${call}; let typed: Result<_, ()> = parsed;`,
  ]) {
    const s = r24dRustStub(`    ${call.startsWith('g.') ? 'let g = Gauge::new();\n    ' : ''}${body}`, uses);
    assert.match(s.lib, new RegExp(`fn ${element.split('::').at(-1)}[^\\n]*SDD-TODO\\(stub\\)`), s.lib);
    assert.equal(s.rows.find(row => row.element === element)?.confidence, 'guessed', s.out);
    r24dAssertStubInvariants(s, 'insufficient Result evidence');
  }
});

/** @id TEST-RSTUB-006 @verifies REQ-RSTUB-006 */
test('TEST-RSTUB-006 boolean loop evidence is complete consistent and scoped to each binding', () => {
  assert.equal(R24D_NO_CARGO, false, 'cargo is required');
  const comparisons = [
    v => `assert_eq!(*${v}, true);`,
    v => `assert_eq!(false, *${v});`,
    v => `assert_ne!(*${v}, false);`,
    v => `assert!(*${v} == true);`,
    v => `assert!(false != *${v});`,
  ];
  for (const tuple of [false, true]) for (const compare of comparisons) {
    const s = r24dRustStub(`    for ${tuple ? '(enabled, expected)' : 'enabled'} in SWITCHES { ${compare('enabled')} ${tuple ? compare('expected') : ''} }`, 'SWITCHES');
    assert.match(s.lib, tuple ? /const SWITCHES: &\[\(bool, bool\)\] = &\[\];/ : /const SWITCHES: &\[bool\] = &\[\];/, s.lib);
    assert.equal(s.rows.find(row => row.element === 'SWITCHES')?.confidence, 'inferred', s.out);
    assert.doesNotMatch(s.lib, /SDD-TODO\(stub\)/);
    const native = spawnSync('cargo', ['test', '--offline', '--no-run'], { cwd: s.d, encoding: 'utf8', env: ENV });
    assert.equal(native.status, 0, native.stderr);
    r24dAssertStubInvariants(s, 'bool loop');
  }
  for (const body of [
    'for (enabled, expected) in SWITCHES { assert_eq!(*enabled, true); }',
    'for (enabled, expected) in SWITCHES { assert_eq!(*enabled, true); assert_eq!(*expected, 1); }',
    'for enabled in SWITCHES { assert_eq!(*enabled, true); assert_eq!(*enabled, 1); }',
    'for enabled in SWITCHES { assert_eq!(enabled, enabled); } let enabled = &true; assert_eq!(*enabled, true);',
    'for enabled in SWITCHES { let enabled = &true; assert_eq!(*enabled, true); }',
    'for enabled in SWITCHES { for enabled in &[true] { assert_eq!(*enabled, true); } }',
    'for enabled in SWITCHES { assert_eq!(*enabled, true); } for enabled in SWITCHES { assert_eq!(enabled, enabled); }',
    'for enabled in SWITCHES { assert_eq!(enabled, enabled, "*enabled == true"); /* assert_eq!(*enabled, true); */ }',
  ]) {
    const s = r24dRustStub(`    ${body}`, 'SWITCHES');
    assert.match(s.lib, /const SWITCHES[^\n]*SDD-TODO\(stub\)/, s.lib);
    assert.equal(s.rows.find(row => row.element === 'SWITCHES')?.confidence, 'guessed', s.out);
    r24dAssertStubInvariants(s, 'insufficient bool evidence');
  }
});

/** @id TEST-RSTUB-007 @verifies REQ-RSTUB-007 */
test('TEST-RSTUB-007 same-name method arguments and empty constraints belong to their owner', () => {
  assert.equal(R24D_NO_CARGO, false, 'cargo is required');
  for (const shape of ['bound', 'direct', 'builder']) for (const reverse of [false, true]) {
    const calls = shape === 'bound'
      ? ['assert_eq!(g.check(1), true);', 'assert_eq!(s.check(1, (2, 3)), false);']
      : [`assert_eq!(Gauge::new()${shape === 'builder' ? '.ready()' : ''}.check(1), true);`,
        `assert_eq!(Switch::new()${shape === 'builder' ? '.ready()' : ''}.check(1, (2, 3)), false);`];
    const s = r24dRustStub(`    ${shape === 'bound' ? 'let g = Gauge::new(); let s = Switch::new();\n    ' : ''}${(reverse ? calls.reverse() : calls).join('\n    ')}`, 'Gauge, Switch');
    const gauge = /impl Gauge \{([^]*?)\n\}/.exec(s.lib)?.[1] ?? '';
    const sw = /impl Switch \{([^]*?)\n\}/.exec(s.lib)?.[1] ?? '';
    assert.match(gauge, /fn check<A0>\(&self, _a0: A0\) -> bool/, s.lib);
    assert.match(sw, /fn check<A0, A1>\(&self, _a0: A0, _a1: A1\) -> bool/, s.lib);
    assert.equal(s.rows.find(row => row.element === 'Gauge::check')?.confidence, 'inferred', s.out);
    assert.equal(s.rows.find(row => row.element === 'Switch::check')?.confidence, 'inferred', s.out);
    const native = spawnSync('cargo', ['test', '--offline', '--no-run'], { cwd: s.d, encoding: 'utf8', env: ENV });
    assert.equal(native.status, 0, native.stderr);
    r24dAssertStubInvariants(s, 'owned arity');
  }
  for (const shape of ['bound', 'direct', 'builder']) for (const reverse of [false, true]) {
    const receiver = owner => shape === 'bound' ? (owner === 'Gauge' ? 'g' : 's') : `${owner}::new()${shape === 'builder' ? '.ready()' : ''}`;
    const calls = [`assert_eq!(${receiver('Gauge')}.empty(vec![]), true); assert_eq!(${receiver('Gauge')}.empty(vec![true]), false);`,
      `assert_eq!(${receiver('Switch')}.empty(None), true); assert_eq!(${receiver('Switch')}.empty(Some(1)), false);`];
    const s = r24dRustStub(`    ${shape === 'bound' ? 'let g = Gauge::new(); let s = Switch::new();\n    ' : ''}${(reverse ? calls.reverse() : calls).join('\n    ')}`, 'Gauge, Switch');
    assert.match(/impl Gauge \{([^]*?)\n\}/.exec(s.lib)?.[1] ?? '', /fn empty\(&self, _a0: Vec<bool>\) -> bool/, s.lib);
    assert.match(/impl Switch \{([^]*?)\n\}/.exec(s.lib)?.[1] ?? '', /fn empty\(&self, _a0: Option<i64>\) -> bool/, s.lib);
    const native = spawnSync('cargo', ['test', '--offline', '--no-run'], { cwd: s.d, encoding: 'utf8', env: ENV });
    assert.equal(native.status, 0, native.stderr);
    r24dAssertStubInvariants(s, 'owned empty constraints');
  }
  const control = r24dRustStub('    assert_eq!(Gauge::new().check(), true); assert_eq!(Switch::new().check(1), false);', 'Gauge, Switch');
  assert.match(/impl Gauge \{([^]*?)\n\}/.exec(control.lib)?.[1] ?? '', /fn check\(&self\) -> bool/, control.lib);
  assert.match(/impl Switch \{([^]*?)\n\}/.exec(control.lib)?.[1] ?? '', /fn check<A0>\(&self, _a0: A0\) -> bool/, control.lib);
  const repair = r24dRustStub('    fn probe(g: Gauge) { assert_eq!(g.check(1, 2), 1); }\n    probe(Gauge);', 'Gauge', 'pub struct Gauge;\n');
  assert.match(repair.lib, /fn check<A0, A1>\(&self, _a0: A0, _a1: A1\) -> i64/, repair.lib);
  assert.equal(repair.rows.find(row => row.element === 'Gauge::check')?.confidence, 'guessed', repair.out);
  assert.match(repair.lib, /fn check[^\n]*SDD-TODO\(stub\)/, repair.lib);
  const native = spawnSync('cargo', ['test', '--offline', '--no-run'], { cwd: repair.d, encoding: 'utf8', env: ENV });
  assert.equal(native.status, 0, native.stderr);
});

import { createHash } from 'node:crypto';
// (3) ledger invariants: replay hand-built tdd.jsonl chains through `gate --no-run` / merge-ledger
const R24D_SPEC = '---\nfeature: calc\ntier: T1\n---\n| REQ-CALC-001 | When add is called, the system shall sum. | TEST-CALC-001 |\n';
const r24dChain = (entries) => {
  let prev = '';
  return entries.map((e, i) => { const x = { ...e, seq: i + 1, prev }; delete x.hash; x.hash = createHash('sha256').update(JSON.stringify(x)).digest('hex'); prev = x.hash; return JSON.stringify(x); }).join('\n') + '\n';
};
const r24dLedger = (d) => fs.readFileSync(path.join(d, '.sdd/tdd.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
function r24dRedGreen() {
  const d = mini(R24D_SPEC, {
    'add.test.mjs': "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from './add.mjs';\n/** @id TEST-CALC-001 @verifies REQ-CALC-001 */\ntest('TEST-CALC-001 adds', () => assert.equal(add(1, 2), 3));\n",
    'add.mjs': '/** @id CODE-CALC-001 @implements REQ-CALC-001 */\nexport const add = () => 0;\n',
  });
  assert.equal(sdd(d, 'tdd', 'red', 'TEST-CALC-001').code, 0);
  fs.writeFileSync(path.join(d, 'add.mjs'), '/** @id CODE-CALC-001 @implements REQ-CALC-001 */\nexport const add = (a, b) => a + b;\n');
  assert.equal(sdd(d, 'tdd', 'green', 'TEST-CALC-001').code, 0);
  const [red, green] = r24dLedger(d);
  assert.equal(red.type, 'red');
  assert.equal(green.type, 'green');
  return { d, red, green, write: (es) => fs.writeFileSync(path.join(d, '.sdd/tdd.jsonl'), r24dChain(es)), evidence: () => /tdd evidence[^:]*: (\d+)\/(\d+)/.exec(sdd(d, 'gate', '--no-run').out) };
}
test('r24d ledger invariant: a Red followed by a Green with the same test hash is covered', () => {
  const { d, red, green, write, evidence } = r24dRedGreen();
  write([red, green]);
  assert.deepEqual(evidence().slice(1), ['1', '1']);
  assert.match(sdd(d, 'tdd', 'check').out, /LEDGER OK/);
});
test('r24d ledger invariant: Red-before-Green — a Green with no Red, or ordered before its Red, is never covered', () => {
  const { red, green, write, evidence } = r24dRedGreen();
  write([green]);
  assert.deepEqual(evidence().slice(1), ['0', '1']);
  write([green, red]);
  assert.deepEqual(evidence().slice(1), ['0', '1']);
  write([{ ...red, test: 'TEST-CALC-009' }, green]);
  assert.deepEqual(evidence().slice(1), ['0', '1']);
});
test('r24d ledger invariant: a Green recorded for a different test hash than its Red is not evidence', () => {
  const { red, green, write, evidence } = r24dRedGreen();
  write([red, { ...green, fileSha: 'f'.repeat(64) }]);
  assert.deepEqual(evidence().slice(1), ['0', '1']);
});
test('r24d ledger invariant: no Green on stale evidence — test edit or REQ edit after Green invalidates it; CLI refuses a Green without a matching Red', () => {
  const a = r24dRedGreen();
  fs.writeFileSync(path.join(a.d, 'add.test.mjs'), fs.readFileSync(path.join(a.d, 'add.test.mjs'), 'utf8').replace('add(1, 2), 3', 'add(1, 2), 4'));
  assert.deepEqual(a.evidence().slice(1), ['0', '1']);
  const g = sdd(a.d, 'tdd', 'green', 'TEST-CALC-001');
  assert.notEqual(g.code, 0, g.out);
  assert.match(g.out, /REFUSED/, g.out);
  const b = r24dRedGreen();
  fs.writeFileSync(path.join(b.d, '.sdd/specs/calc.md'), R24D_SPEC.replace('shall sum', 'shall add up'));
  assert.deepEqual(b.evidence().slice(1), ['0', '1']);
  const c = mini(R24D_SPEC, { 'add.test.mjs': fs.readFileSync(path.join(a.d, 'add.test.mjs'), 'utf8'), 'add.mjs': '/** @id CODE-CALC-001 @implements REQ-CALC-001 */\nexport const add = (a, b) => a + b;\n' });
  assert.match(sdd(c, 'tdd', 'green', 'TEST-CALC-001').out, /REFUSED: no Red recorded/);
});
test('r24d ledger invariant: merge-ledger is idempotent (merge twice = merge once) and keeps a valid chain', () => {
  const { d, red, green } = r24dRedGreen();
  const ledgerPath = path.join(d, '.sdd/tdd.jsonl');
  const other = { ...red, test: 'TEST-CALC-002', at: '2026-01-01T00:00:00.000Z' };
  const flaky = { v: 1, type: 'flaky', check: 'test', retry: 1, retries: 1, policy: 'warn', outcome: 'accepted', at: '2026-01-02T00:00:00.000Z' };
  const [base, side1, side2] = [r24dChain([red]), r24dChain([red, green]), r24dChain([red, other, flaky])];
  const forks = [
    side1,
    `${base.trimEnd()}\n<<<<<<< HEAD\n${side1.split('\n')[1]}\n=======\n${side2.split('\n')[1]}\n${side2.split('\n')[2]}\n>>>>>>> branch\n`,
    `${side1}${side2}`,
  ];
  for (const f of forks) {
    fs.writeFileSync(ledgerPath, f);
    assert.equal(sdd(d, 'tdd', 'merge-ledger').code, 0);
    const once = fs.readFileSync(ledgerPath, 'utf8');
    assert.match(sdd(d, 'tdd', 'check').out, /LEDGER OK/, once);
    assert.match(sdd(d, 'tdd', 'merge-ledger').out, /\(\d+ unchanged, 0 re-chained/);
    assert.equal(fs.readFileSync(ledgerPath, 'utf8'), once, 'second merge changed the ledger');
  }
});

test('#r25a TS const with no evidence gets an SDD-TODO(stub) marker and is reported guessed; called/class output is unchanged', () => {
  const d = mini(R24B_SPEC, { 'test/h.test.ts': "import { MAX, run } from '../src/lib';\n\n/** @id TEST-H-001 @verifies REQ-H-001 */\ntest('h', () => { expect(MAX).toBe(1); run(); });\n" });
  const r = sdd(d, 'tdd', 'stub', 'TEST-H-001', '--report');
  const lib = fs.readFileSync(path.join(d, 'src/lib.ts'), 'utf8');
  assert.match(lib, /export const MAX: any = undefined; \/\/ SDD-TODO\(stub\): type unknown/, lib);
  assert.match(lib, /export function run\(\.\.\._args: any\[\]\): any \{/, lib);
  assert.doesNotMatch(lib, /run[^\n]*SDD-TODO/, lib);
  assert.match(r.out, /MAX \| guessed \| test\/h\.test\.ts:\d+/, r.out);
  assert.match(r.out, /! MAX: type unknown/, r.out);
});

test('#r25a Python const with no evidence gets an SDD-TODO(stub) marker; an evidenced `[]` const stays unmarked', () => {
  const d = mini(R24B_SPEC, { 'test_h.py': 'from lib import LIMIT, ROWS\n\n# @id TEST-H-001 @verifies REQ-H-001\ndef test_h():\n    assert LIMIT\n    assert ROWS[0] == 1\n' });
  const r = sdd(d, 'tdd', 'stub', 'TEST-H-001', '--report');
  const lib = fs.readFileSync(path.join(d, 'lib.py'), 'utf8');
  assert.match(lib, /^LIMIT = None  # SDD-TODO\(stub\): type unknown/m, lib);
  assert.match(lib, /^ROWS = \[\]$/m, lib);
  assert.match(r.out, /LIMIT \| guessed \| test_h\.py:\d+/, r.out);
  assert.match(r.out, /ROWS \| inferred \|/, r.out);
});

test('#r25a tdd red rejects a load error located in a marked TS/JS stub element', () => {
  const d = mini(R24B_SPEC, { 'h.test.mjs': "import { MAX } from './lib.mjs';\n\n/** @id TEST-H-001 @verifies REQ-H-001 */\ntest('h', () => { MAX; });\n", 'lib.mjs': 'export const MAX = ; // SDD-TODO(stub): type unknown\n' }, ['node', '--test', 'h.test.mjs']);
  const r = sdd(d, 'tdd', 'red', 'TEST-H-001');
  assert.match(r.out, /REJECTED[^\n]*SDD-TODO\(stub\) element MAX[^\n]*fill MAX by hand/, r.out);
});

test('#r25a tdd red rejects a load error located in a marked Python stub element', () => {
  const d = mini(R24B_SPEC, { 'test_h.py': 'from lib import LIMIT\n\n# @id TEST-H-001 @verifies REQ-H-001\ndef test_h():\n    assert LIMIT\n', 'lib.py': 'LIMIT = (  # SDD-TODO(stub): type unknown\n' }, ['python3', '-m', 'pytest', '-q', 'test_h.py']);
  const r = sdd(d, 'tdd', 'red', 'TEST-H-001');
  assert.match(r.out, /REJECTED[^\n]*SDD-TODO\(stub\) element LIMIT[^\n]*fill LIMIT by hand/, r.out);
});

test('#r25a Rust: a const typed in the test is shown; an unsupported fn is marked and guessed', cargoOk, () => {
  const d = mini(R24B_SPEC, {
    'Cargo.toml': '[package]\nname = "repro"\nversion = "0.1.0"\nedition = "2021"\n',
    'src/lib.rs': '',
    'tests/h_test.rs': 'use repro::{LIMIT, run, size};\n\n// @id TEST-H-001\n// @verifies REQ-H-001\n#[test]\nfn test_h_001() {\n    let x: f64 = LIMIT;\n    let n: usize = size(2);\n    run(1);\n    assert!(x > 0.0 && n > 0);\n}\n',
  });
  const r = sdd(d, 'tdd', 'stub', 'TEST-H-001', '--report');
  const lib = fs.readFileSync(path.join(d, 'src/lib.rs'), 'utf8');
  assert.match(r.out, /LIMIT \| shown \|/, r.out);
  assert.match(r.out, /size \| shown \|/, r.out);
  assert.match(r.out, /run \| guessed \|/, r.out);
  assert.match(r.out, /! run: type unknown.*fill the type by hand/, r.out);
  assert.match(lib, /pub fn run[^\n]*-> i64 \{/, lib);
  assert.match(lib, /run[^\n]*SDD-TODO/, lib);
});

// ---- r25b (gate fail-open audit) ----
function failOpenProj(cfg, files = {}) {
  const d = mini('---\nfeature: a\ntier: T1\n---\n| REQ-A-001 | x shall hold. | TEST-A-001 |\n', { 'app/package.json': '{}', 'app/x.mjs': 'export {};\n', 'lib.mjs': 'export {};\n', ...files });
  fs.writeFileSync(path.join(d, '.sdd/config.json'), JSON.stringify({ testCmd: PASS, ...cfg }));
  spawnSync('git', ['add', '-A'], { cwd: d });
  spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'i'], { cwd: d });
  return d;
}
test('r25b deleting a file does not let a changedCmd check skip as "no changed files"', () => {
  const full = ['node', '-e', "process.exit(require('fs').existsSync('lib.mjs')?0:1)"];
  const d = failOpenProj({ checks: [{ name: 'unit', cmd: full, changedCmd: ['node', '-e', '0', '{changedFiles}'] }] });
  fs.rmSync(path.join(d, 'lib.mjs'));
  const r = sdd(d, 'gate', '--changed');
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /deleted/, r.out);
});
test('r25b a root test check skipped for a nested project without checks fails under scopePolicy strict, warns otherwise', () => {
  const cfg = { checks: [{ name: 'test', cmd: FAIL }], projects: [{ root: 'app', testCmd: PASS }] };
  const d = failOpenProj(cfg);
  fs.appendFileSync(path.join(d, 'app/x.mjs'), '// c\n');
  const w = sdd(d, 'gate', '--changed');
  assert.match(w.out, /! .*app\/ has no check of its own/, w.out);
  fs.writeFileSync(path.join(d, '.sdd/config.json'), JSON.stringify({ testCmd: PASS, ...cfg, scopePolicy: 'strict' }));
  const s = sdd(d, 'gate', '--changed');
  assert.equal(s.code, 1, s.out);
  assert.match(s.out, /✗ .*no check of its own/, s.out);
});

// ---- r25d: flow-based ACT classification (design 3.3 follow-up) ----
test('r25d py: the constructed SUT is the receiver of the asserted expression (act, not setup)', () => {
  const src = 'class Store:\n    def __init__(self):\n        raise NotImplementedError("Store")\n\n    def append(self, v):\n        pass\n\n    def get(self):\n        return []\n';
  const d = r14c(src, 's = Store()\n    assert [1] == s.get()');
  const r = sdd(d, 'tdd', 'red', 'TEST-W-001');
  assert.match(r.out, /RED ok/, r.out);
  assert.doesNotMatch(r.out, /\[weak\]|setup call/, r.out);
});

test('r25d py: a bare act whose output stream is read through a method (`out.getvalue()`) is the act', () => {
  const src = 'def serve(i, o):\n    raise NotImplementedError("serve")\n';
  const d = r14c(src, 'import io\n    i, o = io.StringIO("x"), io.StringIO()\n    serve(i, o)\n    assert "x" == o.getvalue()');
  const r = sdd(d, 'tdd', 'red', 'TEST-W-001');
  assert.doesNotMatch(r.out, /\[weak\]|setup call/, r.out);
});

test('r25d js: identical shapes get identical verdicts whatever the helper is named; iteration over the result flows into the assertion', () => {
  const mod = "export class Store { constructor() { throw new Error('not implemented: Store'); } }\nexport const sphere = () => { throw new Error('not implemented: sphere'); };\n";
  for (const body of [
    ['  const s = new Store();', '  await s.append(1);', '  assert.deepEqual(await s.get(), [1]);'],
    ['  const s = new Store();', '  assert.equal(1, s.get().length);'],
    ['  const s = sphere();', '  for (const p of s.polygons) {', '    assert.ok(p.x > 0);', '  }'],
    ['  const s = sphere();', '  s.polygons.forEach((p) => assert.ok(p.x > 0));'],
  ]) {
    const d = approved();
    fs.writeFileSync(path.join(d, 'add.mjs'), mod);
    testFile(d, body);
    fs.writeFileSync(path.join(d, 'add.test.mjs'), fs.readFileSync(path.join(d, 'add.test.mjs'), 'utf8').replace('{ add }', '{ Store, sphere }').replace('() => {\n', 'async () => {\n'));
    const r = sdd(d, 'tdd', 'red', 'TEST-CALC-001');
    assert.doesNotMatch(r.out, /\[weak\]|setup call/, `${body.join('\n')}\n${r.out}`);
  }
});

test('r25d rust: a `for p in &s.polygons { assert!(..) }` over the stub result is the act', () => {
  const r = weak263(null, `${rsOut}sphere\n`, 'a.test.mjs', rs271('', ['  let s = sphere(1);', '  for p in &s.polygons {', '    assert!(p.x > 0);', '  }']));
  assert.doesNotMatch(r.out, /\[weak\]|setup call/, r.out);
});

test('r25d conservative: a stub result never used by the assertion stays setup', () => {
  const r = weak263(null, `${rsOut}sphere\n`, 'a.test.mjs', rs271('', ['  let s = sphere(1);', '  assert_eq!(other(), 2);']));
  assert.match(r.out, /\[weak\].*setup call "sphere"/, r.out);
});

// ---- r26a (#316) ----
test('r26a a new unmapped .sh file is unclaimed like .txt: warn, fail under strict', () => {
  const d = scopeProj({ checks: [{ name: 'root', cmd: ['node', '-e', '0'] }] }, { 'tools/x.sh': 'echo a\n' });
  fs.appendFileSync(path.join(d, 'tools/x.sh'), 'echo b\n');
  const w = sdd(d, 'gate', '--changed');
  assert.match(w.out, /! scope: 1 changed file\(s\) not claimed.*tools\/x\.sh/, w.out);
  fs.writeFileSync(path.join(d, '.sdd/config.json'), JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(d, '.sdd/config.json'), 'utf8')), scopePolicy: 'strict' }));
  const s = sdd(d, 'gate', '--changed');
  assert.equal(s.code, 1, s.out);
  assert.match(s.out, /✗ scope:.*tools\/x\.sh/, s.out);
});
test('r26a a new unannotated source file under a project warns, fails under strict, and is listed by --explain', () => {
  const d = scopeProj();
  fs.writeFileSync(path.join(d, 'app/stray.mjs'), 'export const z = 1;\n');
  const w = sdd(d, 'gate', '--changed', '--explain');
  assert.match(w.out, /! scope: 1 new source file\(s\).*app\/stray\.mjs/, w.out);
  assert.match(w.out, /explain unannotated: app\/stray\.mjs/, w.out);
  fs.writeFileSync(path.join(d, 'app/stray.mjs'), '// @id CODE-A-001 @implements REQ-A-001\nexport const z = 1;\n');
  assert.doesNotMatch(sdd(d, 'gate', '--changed').out, /new source file/);
  fs.writeFileSync(path.join(d, 'app/stray.mjs'), 'export const z = 1;\n');
  fs.writeFileSync(path.join(d, '.sdd/config.json'), JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(d, '.sdd/config.json'), 'utf8')), scopePolicy: 'strict' }));
  const s = sdd(d, 'gate', '--changed');
  assert.equal(s.code, 1, s.out);
  assert.match(s.out, /✗ scope: 1 new source file/, s.out);
});

const r317 = (cfg, impl) => {
  const d = mini(SPEC2, { 'a.test.mjs': '// @id TEST-A-001 @verifies REQ-A-001\n// one\n// @id TEST-A-002 @verifies REQ-A-002\n// two\n', 'lib.rs': impl }, FAIL);
  if (cfg) symbolCfg(d);
  for (const t of ['TEST-A-001', 'TEST-A-002']) assert.equal(sdd(d, 'tdd', 'red', t).code, 0);
  setCmd(d, PASS);
  for (const t of ['TEST-A-001', 'TEST-A-002']) assert.equal(sdd(d, 'tdd', 'green', t).code, 0);
  return d;
};

test('#317 symbol granularity: an edit inside a Rust impl of the annotated type is stale; unrelated impls are not', () => {
  const impl = '// @id CODE-A-001 @implements REQ-A-001 REQ-A-002\npub struct X { n: u32 }\n\nimpl Default for X {\n    fn default() -> Self { X { n: 1 } }\n}\n\nimpl Y {\n    fn y() -> u32 { 1 }\n}\n';
  const d = r317(true, impl);
  fs.writeFileSync(path.join(d, 'lib.rs'), impl.replace('{ n: 1 }', '{ n: 2 }'));
  assert.match(sdd(d, 'tdd', 'refactor', '--stale').out, /re-verifying 2 stale test\(s\)/);
  const e = r317(true, impl);
  fs.writeFileSync(path.join(e, 'lib.rs'), impl.replace('{ 1 }', '{ 5 }'));
  assert.match(sdd(e, 'tdd', 'refactor', '--stale').out, /edit fell outside any annotated CODE span in lib\.rs \(tests: TEST-A-001 TEST-A-002\)/);
});

test('#317 --stale reports an edit outside any annotated span instead of silently selecting nothing', () => {
  const impl = '// @id CODE-A-001 @implements REQ-A-001 REQ-A-002\nexport function v() { return 0; }\n\nfunction shared() {\n  return 1;\n}\n';
  const d = r317(false, impl);
  fs.writeFileSync(path.join(d, 'lib.rs'), impl.replace('return 1', 'return 2'));
  const o = sdd(d, 'tdd', 'refactor', '--stale').out;
  assert.match(o, /edit fell outside any annotated CODE span in lib\.rs \(tests: TEST-A-001 TEST-A-002\)/, o);
  assert.match(o, /no test has a stale/, o);
});

test('#317 --stale agrees with the gate: a REQ wording change the gate says to re-run is selected', () => {
  const d = r317(false, '// @id CODE-A-001 @implements REQ-A-001\nexport const v = 0;\n');
  const sp = path.join(d, '.sdd/specs/a.md');
  fs.writeFileSync(sp, fs.readFileSync(sp, 'utf8').replace('x shall work.', 'x shall always work.'));
  assert.match(sdd(d, 'gate', '--no-run').out, /re-verify with tdd refactor/);
  assert.match(sdd(d, 'tdd', 'refactor', '--stale').out, /re-verifying 1 stale test\(s\): TEST-A-001/);
});

// ---- r26c: Rust/TS stub fidelity (#318) ----
const R26C_LIB = 'pub trait Pager { fn alloc(&mut self) -> u32; }\npub struct Mem;\nimpl Pager for Mem { fn alloc(&mut self) -> u32 { 1 } }\npub struct Cache<P: Pager> { pub p: P }\nimpl<P: Pager> Cache<P> {\n    pub fn new(p: P) -> Self { Cache { p } }\n}\npub struct Session;\nimpl Session {\n    pub fn new() -> Self { Session }\n}\n';
const R26C_TEST = (body, head = 'use repro::{Cache, Mem, Session};\n') => `${head}\n// @id TEST-H-001\n// @verifies REQ-H-001\n#[test]\nfn test_h_001() {\n${body}\n}\n`;
const r26cProj = (test) => mini(R24B_SPEC, { 'Cargo.toml': '[package]\nname = "repro"\nversion = "0.1.0"\nedition = "2021"\n', 'src/lib.rs': R26C_LIB, 'tests/h_test.rs': test });

test('r26c Rust: a method called on a `let mut` receiver takes &mut self, and is listed in --report', cargoOk, () => {
  const d = r26cProj(R26C_TEST('    let mut s = Session::new();\n    s.handle(3);\n    assert_eq!(s.handle(4), 4);'));
  const r = sdd(d, 'tdd', 'stub', 'TEST-H-001', '--report');
  const lib = fs.readFileSync(path.join(d, 'src/lib.rs'), 'utf8');
  assert.match(lib, /fn handle<A0>\(&mut self[^\n]*SDD-TODO\(stub\)/, lib);
  assert.match(r.out, /Session::handle \| guessed \|/, r.out);
});

test('r26c Rust: methods are added to a generic `impl<P: Trait> Type<P>` block', cargoOk, () => {
  const d = r26cProj(R26C_TEST('    let mut c = Cache::new(Mem);\n    c.flush(1);\n    assert_eq!(c.len(), 0);'));
  sdd(d, 'tdd', 'stub', 'TEST-H-001');
  const lib = fs.readFileSync(path.join(d, 'src/lib.rs'), 'utf8');
  assert.match(lib, /impl<P: Pager> Cache<P> \{[^]*fn flush[^]*fn len/, lib);
});

test('r26c Rust: a method no test references is never invented', cargoOk, () => {
  const d = r26cProj(R26C_TEST('    let mut s = Session::new();\n    s.handle(3);', 'use repro::*;\n'));
  sdd(d, 'tdd', 'stub', 'TEST-H-001');
  const lib = fs.readFileSync(path.join(d, 'src/lib.rs'), 'utf8');
  assert.match(lib, /fn handle/, lib);
  assert.doesNotMatch(lib, /as_str|fn (?!new|handle|alloc)\w+\(&/, lib);
});

test('r26c Rust: macro_rules! / `use crate::*` in the test file degrade to partial stubs with a message, not a refusal', cargoOk, () => {
  const d = r26cProj(R26C_TEST('    let mut s = Session::new();\n    s.handle(3);\n    ck!(1);\n    assert_eq!(top(2), 2);', 'use repro::*;\nmacro_rules! ck { ($e:expr) => { assert!($e == 1) }; }\n'));
  const r = sdd(d, 'tdd', 'stub', 'TEST-H-001');
  const lib = fs.readFileSync(path.join(d, 'src/lib.rs'), 'utf8');
  assert.match(lib, /fn handle/, r.out + lib);
  assert.match(r.out, /macro_rules! in the test file/, r.out);
  assert.match(r.out, /wildcard/, r.out);
});

test('r26c TS: a stub param/const with a literal or annotation avoids any, and --report lists the element', () => {
  const d = mini(R24B_SPEC, { 'package.json': '{"type":"module"}\n', 'h.test.ts': "import { LIMIT, run } from './h';\n// @id TEST-H-001\n// @verifies REQ-H-001\ntest('x', () => { const n: number = LIMIT; expect(run(1, 'a')).toBe(2); });\n" });
  const r = sdd(d, 'tdd', 'stub', 'TEST-H-001', '--report');
  const src = fs.readFileSync(path.join(d, 'h.ts'), 'utf8');
  assert.doesNotMatch(src, /LIMIT[^\n]*: any/, src);
  assert.doesNotMatch(r.out, /no inferred elements/, r.out);
  assert.match(r.out, /LIMIT \| inferred \|/, r.out);
  assert.match(r.out, /run \| guessed \|/, r.out);
});

// ---- r26d: helper-wrapped asserts, --expect override (S2-4) ----
test('r26d weak Red: a test-file helper that only wraps an assertion does not make its stub-calling argument a setup call', () => {
  const helper = 'fn near(a: f64) {\n  let e = 1.0;\n  assert!((a - e).abs() < 1e-9);\n}\nfn got(n: i32) -> f64 { sphere(n) }';
  const r = weak263(null, `${rsOut}sphere\n`, 'a.test.mjs', rs271(helper, ['  near(got(1));']));
  assert.match(r.out, /RED ok/, r.out);
  assert.doesNotMatch(r.out, /\[weak\]|setup call/, r.out);
});

test('r26d weak Red: --expect text found in the failure overrides the setup classification', () => {
  weak263.args = ['--expect', 'not implemented: sphere (layout)'];
  const r = weak263(null, `${rsOut}sphere (layout)\n`, 'a.test.mjs', rs271('', ['  const s = sphere(1);', '  assert.equal(other(), 2);']));
  weak263.args = undefined;
  assert.match(r.out, /RED ok/, r.out);
  assert.doesNotMatch(r.out, /\[weak\]|setup call/, r.out);
});

// ---- r26d: generated artifact producers (S2-3) ----
const r26dGen = (producers) => {
  const spec = '---\nfeature: a\ntier: T1\n---\n| REQ-A-001 | x shall hold. | TEST-A-001 |\n';
  const d = mini(spec, { 'a.test.mjs': '// @id TEST-A-001 @verifies REQ-A-001\n// body\n', 'contract/golden.json': '[1]\n' }, FAIL);
  const cp = path.join(d, '.sdd/config.json');
  const c = JSON.parse(fs.readFileSync(cp, 'utf8'));
  c.artifacts = { 'contract/golden.json': ['a.test.mjs'] };
  if (producers) c.artifactProducers = producers;
  fs.writeFileSync(cp, JSON.stringify(c));
  assert.equal(sdd(d, 'tdd', 'red', 'TEST-A-001').code, 0);
  fs.writeFileSync(path.join(d, 'contract/golden.json'), '[1,2]\n');
  setCmd(d, PASS);
  return d;
};

test('r26d artifactProducers: regenerating a declared artifact between Red and Green is accepted and recorded', () => {
  const d = r26dGen({ 'contract/golden.json': 'llcli golden' });
  const r = sdd(d, 'tdd', 'green', 'TEST-A-001');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /regenerated since Red.*contract\/golden\.json/, r.out);
  const last = fs.readFileSync(path.join(d, '.sdd/tdd.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).at(-1);
  assert.ok(last.produced?.['contract/golden.json'], JSON.stringify(last));
});

test('r26d undeclared generated artifact: the refusal names the artifactProducers workaround', () => {
  const d = r26dGen(null);
  const r = sdd(d, 'tdd', 'green', 'TEST-A-001');
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /artifactProducers/, r.out);
});

test('r26d impact: a producer declared in config artifactProducers is listed for a data artifact', () => {
  const d = r26dGen({ 'contract/golden.json': 'llcli golden' });
  const r = sdd(d, 'impact', 'contract/golden.json');
  assert.match(r.out, /producers: .*llcli golden/, r.out);
});

test('r26d gate compact output names the trace warnings', () => {
  const spec = '---\nfeature: a\ntier: T1\n---\n| REQ-A-001 | x shall hold. | TEST-A-001 |\n';
  const d = mini(spec, { 'a.test.mjs': '// @id TEST-A-001 @verifies REQ-A-001\n// body\n' }, PASS);
  const r = sdd(d, 'gate', '--no-run');
  assert.match(r.out, /warnings/, r.out);
  assert.match(r.out, /warning: REQ-A-001 has no @implements code/, r.out);
});

// ---- r27a (#320): a declared artifact missing from disk fails the gate ----
const r27aProj = (cfg) => failOpenProj({ artifacts: { 'contract/core-ast.md': ['lib.mjs'] }, ...cfg }, { 'contract/core-ast.md': '# ast\n' });
test('r27a full gate fails naming a declared artifact deleted from disk', () => {
  const d = r27aProj({});
  fs.rmSync(path.join(d, 'contract/core-ast.md'));
  const r = sdd(d, 'gate', '--no-run');
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /✗.*contract\/core-ast\.md/, r.out);
});
test('r27a gate --changed fails when the declared artifact was deleted in the diff (git rm)', () => {
  const d = r27aProj({});
  spawnSync('git', ['rm', '-q', 'contract/core-ast.md'], { cwd: d });
  const r = sdd(d, 'gate', '--changed', '--baseline', 'HEAD', '--no-run');
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /✗.*contract\/core-ast\.md/, r.out);
});
test('r27a a declared artifact that never existed also fails; a present one passes', () => {
  const d = r27aProj({ artifacts: { 'contract/never.md': ['lib.mjs'] } });
  const r = sdd(d, 'gate', '--no-run');
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /✗.*contract\/never\.md/, r.out);
  assert.doesNotMatch(r.out, /✗.*core-ast/, r.out);
});

// ---- r27c (#322 root Cargo.toml widens to projects that dependsOn a rebuilt package) ----
const r27c = (pyChecks) => {
  const d = mini('---\nfeature: a\ntier: T1\n---\n| REQ-A-001 | x shall hold. | TEST-A-001 |\n', { 'Cargo.toml': '[workspace]\nmembers = ["crates/a"]\n', 'crates/a/Cargo.toml': '[package]\nname = "a"\n', 'py/p/pyproject.toml': '[project]\nname = "p"\n' });
  fs.writeFileSync(path.join(d, '.sdd/config.json'), JSON.stringify({ testCmd: PASS, checks: [], projects: [{ root: 'crates/a', testCmd: PASS, checks: [{ name: 'ok', cmd: ['node', '-e', '0'] }] }, { root: 'py/p', dependsOn: ['crates/a'], testCmd: PASS, checks: pyChecks }] }));
  spawnSync('git', ['add', '-A'], { cwd: d });
  spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'i'], { cwd: d });
  fs.appendFileSync(path.join(d, 'Cargo.toml'), '# c\n');
  return d;
};

test('r27c #322 gate --changed: a root Cargo.toml change also runs projects that dependsOn a rebuilt package', () => {
  const o = sdd(r27c([{ name: 'py', cmd: ['node', '-e', '0'] }]), 'gate', '--changed').out;
  assert.match(o, /✓ cmd crates\/a:ok/, o);
  assert.match(o, /✓ cmd py\/p:py/, o);
  assert.doesNotMatch(o, /py\/p:py[^\n]*skipped/, o);
});

test('r27c #322 gate --changed: a dependent project with no check of its own makes the result INCOMPLETE', () => {
  const r = sdd(r27c([]), 'gate', '--changed');
  assert.match(r.out, /py\/p[^\n]*not re-verified/, r.out);
  assert.match(r.out, /INCOMPLETE/, r.out);
});

test('r27d tdd refactor --wording is refused when the test body changed since Green', () => {
  const d = mini('---\nfeature: a\ntier: T1\n---\n| REQ-A-001 | x shall work. | TEST-A-001 |\n', { 'a.test.mjs': '// @id TEST-A-001 @verifies REQ-A-001\n// assert total == 3\n' }, FAIL);
  assert.equal(sdd(d, 'tdd', 'red', 'TEST-A-001').code, 0);
  setCmd(d, PASS);
  assert.equal(sdd(d, 'tdd', 'green', 'TEST-A-001').code, 0);
  fs.writeFileSync(path.join(d, 'a.test.mjs'), '// @id TEST-A-001 @verifies REQ-A-001\n// assert total >= 0\n');
  const r = sdd(d, 'tdd', 'refactor', 'TEST-A-001', '--wording', 'just wording');
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /--wording only covers spec rows.*tdd red/s, r.out);
});

test('r27d a new test file carrying @id TEST-/@verifies is not an unannotated source under strict', () => {
  const d = scopeProj();
  fs.writeFileSync(path.join(d, '.sdd/config.json'), JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(d, '.sdd/config.json'), 'utf8')), scopePolicy: 'strict' }));
  fs.writeFileSync(path.join(d, 'app/check.mjs'), '// @id TEST-A-009 @verifies REQ-A-001\nexport const t = 1;\n');
  assert.doesNotMatch(sdd(d, 'gate', '--changed').out, /new source file/);
});

// ---- r27e (#324 manifest defining a check command) ----
const r27eProj = (manifest, name, body, cmd, extra = {}) => {
  const d = mini('---\nfeature: a\ntier: T1\n---\n| REQ-A-001 | x shall hold. | TEST-A-001 |\n', { [name]: body });
  fs.writeFileSync(path.join(d, '.sdd/config.json'), JSON.stringify({ testCmd: PASS, checks: [{ name: 'test', cmd }], ...extra }));
  spawnSync('git', ['add', '-A'], { cwd: d });
  spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'i'], { cwd: d });
  fs.writeFileSync(path.join(d, name), manifest);
  return d;
};
test('r27e changed package.json script behind `npm run test` warns, fails under strict', () => {
  const old = '{"scripts":{"test":"node --test"}}', nw = '{"scripts":{"test":"node --test one.test.mjs"}}';
  const d = r27eProj(nw, 'package.json', old, ['sh', '-c', 'npm run test || true']);
  const w = sdd(d, 'gate', '--changed');
  assert.match(w.out, /! scope: .*check test runs package\.json script "test"/, w.out);
  const cp = path.join(d, '.sdd/config.json');
  fs.writeFileSync(cp, JSON.stringify({ ...JSON.parse(fs.readFileSync(cp, 'utf8')), scopePolicy: 'strict' }));
  const s = sdd(d, 'gate', '--changed');
  assert.equal(s.code, 1, s.out);
  assert.match(s.out, /✗ scope:.*script "test"/, s.out);
});
test('r27e unrelated package.json script change does not warn', () => {
  const d = r27eProj('{"scripts":{"test":"node --test","lint":"x"}}', 'package.json', '{"scripts":{"test":"node --test"}}', ['sh', '-c', 'npm run test || true']);
  assert.doesNotMatch(sdd(d, 'gate', '--changed').out, /defines what a gate check runs/);
});
test('r27e changed pyproject.toml behind a pytest check warns', () => {
  const d = r27eProj('[tool.pytest.ini_options]\naddopts="-k one"\n', 'pyproject.toml', '[tool.pytest.ini_options]\n', ['python3', '-m', 'pytest', '--version']);
  assert.match(sdd(d, 'gate', '--changed').out, /! scope: .*check test runs pytest, configured by pyproject\.toml/);
});
test('r27e changed .cargo/config.toml alias behind a cargo check warns', () => {
  const d = r27eProj('[alias]\nt = "test one"\n', '.cargo/config.toml', '[alias]\nt = "test"\n', ['cargo', 't']);
  assert.match(sdd(d, 'gate', '--changed').out, /! scope: .*cargo alias "t"/);
});

// ---- r27b (#321 artifactStaleness consumer via imports; array-shaped artifacts) ----
const r27b = (artifacts) => {
  const d = mini(SPEC2, { 'a.test.mjs': "// @id TEST-A-001 @verifies REQ-A-001\nimport './src/impl.mjs';\n", 'src/impl.mjs': "import './arity.mjs';\n", 'src/arity.mjs': 'export const x = 1;\n', 'contract/primitives.json': '[1]\n' }, FAIL);
  const cp = path.join(d, '.sdd/config.json');
  const c = JSON.parse(fs.readFileSync(cp, 'utf8'));
  Object.assign(c, { artifacts, artifactStaleness: true });
  fs.writeFileSync(cp, JSON.stringify(c));
  assert.equal(sdd(d, 'tdd', 'red', 'TEST-A-001').code, 0);
  setCmd(d, PASS);
  const g = sdd(d, 'tdd', 'green', 'TEST-A-001');
  assert.equal(g.code, 0, g.out);
  return { d, g };
};

test('r27b artifactStaleness: a test reaching the configured consumer via imports goes stale when the artifact changes', () => {
  const { d } = r27b({ 'contract/primitives.json': ['src/arity.mjs'] });
  fs.writeFileSync(path.join(d, 'contract/primitives.json'), '[2]\n');
  assert.match(sdd(d, 'gate', '--no-run').out, /artifact contract\/primitives\.json changed/);
});

test('r27b artifactStaleness: an unreached consumer does not stale the test', () => {
  const { d } = r27b({ 'contract/primitives.json': ['src/other.mjs'] });
  fs.writeFileSync(path.join(d, 'contract/primitives.json'), '[2]\n');
  assert.doesNotMatch(sdd(d, 'gate', '--no-run').out, /artifact contract\/primitives\.json changed/);
});

test('r27b artifactStaleness: `artifacts` given as an array is explained and not recorded as keys 0/1', () => {
  const { d, g } = r27b(['contract/primitives.json', 'src/arity.mjs']);
  assert.match(g.out, /`artifacts` must be an object/, g.out);
  const last = fs.readFileSync(path.join(d, '.sdd/tdd.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).at(-1);
  assert.doesNotMatch(JSON.stringify(last.artifactShas ?? {}), /"[01]"/);
});

// ---- r28a (#325 full gate: check-defining file changed since the last Green) ----
const r28a = (name, orig, cmd, extra = {}) => {
  const d = mini(SPEC2, { 'a.test.mjs': "// @id TEST-A-001 @verifies REQ-A-001\n", [name]: orig }, FAIL);
  const cp = path.join(d, '.sdd/config.json');
  fs.writeFileSync(cp, JSON.stringify({ ...JSON.parse(fs.readFileSync(cp, 'utf8')), checks: [{ name: 'test', cmd }], scopePolicy: 'warn', ...extra }));
  assert.equal(sdd(d, 'tdd', 'red', 'TEST-A-001').code, 0);
  setCmd(d, PASS);
  assert.equal(sdd(d, 'tdd', 'green', 'TEST-A-001').code, 0);
  return d;
};
test('r28a full gate warns when the package.json script changed after Green, fails under strict', () => {
  const d = r28a('package.json', '{"scripts":{"test":"node --test"}}', ['sh', '-c', 'true # npm run test']);
  assert.doesNotMatch(sdd(d, 'gate').out, /differs from the last Green/);
  fs.writeFileSync(path.join(d, 'package.json'), '{"scripts":{"test":"node --test one.test.mjs"}}');
  const w = sdd(d, 'gate');
  assert.match(w.out, /! scope: .*differs from the last Green record — check test \(package\.json changed\)/, w.out);
  const cp = path.join(d, '.sdd/config.json');
  fs.writeFileSync(cp, JSON.stringify({ ...JSON.parse(fs.readFileSync(cp, 'utf8')), scopePolicy: 'strict' }));
  const s = sdd(d, 'gate');
  assert.equal(s.code, 1, s.out);
  assert.match(s.out, /✗ scope:.*package\.json changed/, s.out);
});
test('r28a full gate warns when pytest testpaths in pyproject.toml changed after Green; other sections do not', () => {
  const d = r28a('pyproject.toml', '[tool.pytest.ini_options]\ntestpaths = ["tests"]\n[project]\nname="x"\n', ['sh', '-c', 'true # python -m pytest']);
  fs.writeFileSync(path.join(d, 'pyproject.toml'), '[tool.pytest.ini_options]\ntestpaths = ["tests"]\n[project]\nname="y"\n');
  assert.doesNotMatch(sdd(d, 'gate').out, /differs from the last Green/);
  fs.writeFileSync(path.join(d, 'pyproject.toml'), '[tool.pytest.ini_options]\ntestpaths = ["tests/one.py"]\n[project]\nname="x"\n');
  assert.match(sdd(d, 'gate').out, /! scope: .*check test \(pyproject\.toml changed\)/);
});
test('r28a no recorded check-def hash (old ledger) means no warning', () => {
  const d = mini(SPEC2, { 'package.json': '{"scripts":{"test":"a"}}' });
  const cp = path.join(d, '.sdd/config.json');
  fs.writeFileSync(cp, JSON.stringify({ ...JSON.parse(fs.readFileSync(cp, 'utf8')), checks: [{ name: 'test', cmd: ['sh', '-c', 'true # npm run test'] }] }));
  fs.writeFileSync(path.join(d, 'package.json'), '{"scripts":{"test":"b"}}');
  assert.doesNotMatch(sdd(d, 'gate').out, /differs from the last Green/);
});

// r28b #326: weakening a policy key in .sdd/config.json is visible to gate --changed
const r28b = (base, patch) => {
  const d = mini('---\nfeature: a\ntier: T1\n---\n| REQ-A-001 | x shall hold. | TEST-A-001 |\n', {}, PASS);
  const cp = path.join(d, '.sdd/config.json');
  fs.writeFileSync(cp, JSON.stringify({ ...JSON.parse(fs.readFileSync(cp, 'utf8')), ...base }));
  const git = (...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: d });
  git('add', '-A'); git('commit', '-qm', 'i');
  fs.writeFileSync(cp, JSON.stringify({ ...JSON.parse(fs.readFileSync(cp, 'utf8')), ...patch }));
  return d;
};

test('r28b scopePolicy strict -> warn fails gate --changed unless --allow-config-weaken', () => {
  const d = r28b({ scopePolicy: 'strict' }, { scopePolicy: 'warn' });
  const g = sdd(d, 'gate', '--changed');
  assert.equal(g.code, 1, g.out);
  assert.match(g.out, /✗ config: .*scopePolicy/, g.out);
  const ok = sdd(d, 'gate', '--changed', '--allow-config-weaken');
  assert.match(ok.out, /! config: .*scopePolicy/, ok.out);
  assert.doesNotMatch(ok.out, /✗ config/, ok.out);
});

test('r28b weakening keys under a non-strict baseline warn only', () => {
  const d = r28b({ scopePolicy: 'warn', specEditPolicy: 'reapprove', flaky: { retries: 1 }, artifactStaleness: true }, { specEditPolicy: 'off', flaky: { retries: 3, policy: 'warn' }, artifactStaleness: false, unscoped: ['src/**'] });
  const g = sdd(d, 'gate', '--changed');
  for (const k of ['specEditPolicy', 'flaky.retries', 'flaky.policy', 'unscoped', 'artifactStaleness']) assert.match(g.out, new RegExp(`! config: .*${k.replace('.', '\\.')}`), `${k}\n${g.out}`);
  assert.doesNotMatch(g.out, /✗ config/, g.out);
});

test('r28b a config change that does not weaken stays silent', () => {
  const d = r28b({ scopePolicy: 'warn' }, { scopePolicy: 'strict' });
  assert.doesNotMatch(sdd(d, 'gate', '--changed').out, /config:/);
});

// r29a #327: a lockfile in a workspace sub-root widens like its manifest; the change set survives a check that rewrites it
const r29a = (files, lock, firstCmd) => {
  const d = mini('---\nfeature: a\ntier: T1\n---\n| REQ-A-001 | x shall hold. | TEST-A-001 |\n', { ...files, [lock]: 'v1\n' });
  const roots = Object.keys(files).filter((f) => /\/(package|Cargo)\.(json|toml)$/.test(f) && f.split('/').length > 2).map((f) => path.posix.dirname(f));
  fs.writeFileSync(path.join(d, '.sdd/config.json'), JSON.stringify({ testCmd: PASS, checks: [], projects: roots.map((r, i) => ({ root: r, testCmd: PASS, checks: [{ name: 'ok', cmd: i === 0 ? firstCmd : ['node', '-e', '0'] }] })) }));
  spawnSync('git', ['add', '-A'], { cwd: d });
  spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'i'], { cwd: d });
  fs.appendFileSync(path.join(d, lock), 'v2\n');
  return d;
};
test('r29a #327 a package-lock.json in a workspace sub-root runs every project under it', () => {
  const d = r29a({ 'js/package.json': '{"workspaces":["packages/*"]}', 'js/packages/a/package.json': '{"name":"a"}', 'js/packages/b/package.json': '{"name":"b"}' }, 'js/package-lock.json', ['node', '-e', '0']);
  const o = sdd(d, 'gate', '--changed').out;
  assert.match(o, /✓ cmd js\/packages\/a:ok/, o);
  assert.match(o, /✓ cmd js\/packages\/b:ok/, o);
});
test('r29a #327 a check that rewrites the lockfile does not hide the change from later projects', () => {
  const d = r29a({ 'rust/Cargo.toml': '[workspace]\nmembers = ["crates/*"]\n', 'rust/crates/a/Cargo.toml': '[package]\nname = "a"\n', 'rust/crates/b/Cargo.toml': '[package]\nname = "b"\n' }, 'rust/Cargo.lock', ['git', 'checkout', '--', '../../Cargo.lock']);
  const o = sdd(d, 'gate', '--changed').out;
  assert.match(o, /✓ cmd rust\/crates\/b:ok/, o);
  assert.doesNotMatch(o, /skipped/, o);
});

// r29b #328: a removed/rewritten committed ledger entry fails gate --changed and tdd check
const r29b = () => {
  const d = r28a('x.txt', 'x', PASS);
  const git = (...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: d });
  git('add', '-A'); git('commit', '-qm', 'ledger');
  return { d, lp: path.join(d, '.sdd/tdd.jsonl') };
};
test('r29b deleting the last ledger line fails gate --changed and tdd check', () => {
  const { d, lp } = r29b();
  fs.writeFileSync(lp, fs.readFileSync(lp, 'utf8').trim().split('\n').slice(0, -1).join('\n') + '\n');
  const g = sdd(d, 'gate', '--changed');
  assert.equal(g.code, 1, g.out);
  assert.match(g.out, /✗ ledger: .*tdd\.jsonl/, g.out);
  assert.match(sdd(d, 'tdd', 'check').out, /LEDGER FAIL: .*removed or modified/);
});
test('r29b a rewritten ledger line fails; a pure append and merge-ledger stay fine', () => {
  const { d, lp } = r29b();
  const orig = fs.readFileSync(lp, 'utf8');
  sdd(d, 'tdd', 'refactor', 'TEST-A-001');
  assert.doesNotMatch(sdd(d, 'gate', '--changed').out, /✗ ledger/);
  assert.match(sdd(d, 'tdd', 'check').out, /LEDGER OK/);
  fs.writeFileSync(lp, orig);
  sdd(d, 'tdd', 'merge-ledger');
  assert.doesNotMatch(sdd(d, 'tdd', 'check').out, /LEDGER FAIL/);
  const ls = orig.trim().split('\n');
  ls[0] = ls[0].replace('"exit":', '"exit":9,"x":');
  fs.writeFileSync(lp, ls.join('\n') + '\n');
  assert.match(sdd(d, 'gate', '--changed').out, /✗ ledger: .*tdd\.jsonl/);
});

const r29c = () => {
  const spec = T1SPEC + '| REQ-A-002 | two shall hold. | TEST-A-002 |\n';
  const d = mini(spec, { 'a.test.mjs': jsTest('// @id TEST-A-002 @verifies REQ-A-002\ntest(\'TEST-A-002 y\', () => {\n  assert.ok(1);\n});\n') }, PASS);
  for (const t of ['TEST-A-001', 'TEST-A-002']) { sdd(d, 'tdd', 'red', t, '--characterization', 'x'); assert.equal(sdd(d, 'tdd', 'green', t).code, 0); }
  fs.writeFileSync(specPath(d), T1SPEC);
  fs.writeFileSync(path.join(d, 'a.test.mjs'), jsTest());
  return d;
};

test('r29c a REQ with Green evidence deleted from the spec warns, fails under strict, and approve retire clears it (#329)', () => {
  const d = r29c();
  const cp = path.join(d, '.sdd/config.json');
  fs.writeFileSync(cp, JSON.stringify({ ...JSON.parse(fs.readFileSync(cp, 'utf8')), scopePolicy: 'warn' }));
  for (const a of [['gate'], ['gate', '--changed']]) {
    const w = sdd(d, ...a);
    assert.match(w.out, /! req REQ-A-002: has Green evidence.*approve retire REQ-A-002/, w.out);
  }
  fs.writeFileSync(cp, JSON.stringify({ ...JSON.parse(fs.readFileSync(cp, 'utf8')), scopePolicy: 'strict' }));
  for (const a of [['gate'], ['gate', '--changed']]) {
    const s = sdd(d, ...a);
    assert.equal(s.code, 1, s.out);
    assert.match(s.out, /✗ req REQ-A-002/, s.out);
  }
  assert.match(sdd(d, 'approve', 'retire', 'REQ-A-002', '--by', 'ai:x').out, /REFUSED/);
  assert.match(sdd(d, 'approve', 'retire', 'REQ-A-001', '--by', 'alice').out, /REFUSED.*still exists/);
  assert.equal(sdd(d, 'approve', 'retire', 'REQ-A-002', '--by', 'alice').code, 0);
  assert.doesNotMatch(sdd(d, 'gate').out, /req REQ-A-002/);
});

// ---- r29d (#330): stub members on a Green class ----
const r29d = () => {
  const spec = '---\nfeature: a\ntier: T1\n---\n| REQ-A-001 | a shall hold. | TEST-A-001 |\n| REQ-B-001 | b shall hold. | TEST-B-001 |\n';
  const d = mini(spec, {
    'lib.mjs': '// @id CODE-A-001 @implements REQ-A-001\nexport class Box {\n  get() { return 1; }\n}\n',
    'a.test.mjs': "import { Box } from './lib.mjs';\n// @id TEST-A-001 @verifies REQ-A-001\ntest('TEST-A-001 x', () => {\n  assert.equal(new Box().get(), 1);\n});\n",
    'b.test.mjs': "import { Box } from './lib.mjs';\n// @id TEST-B-001 @verifies REQ-B-001\ntest('TEST-B-001 x', () => {\n  const s = 'abc';\n  assert.ok(s.startsWith('a'));\n  const t = new Box();\n  t.extra();\n});\n",
  }, FAIL);
  sdd(d, 'tdd', 'red', 'TEST-A-001');
  setCmd(d, PASS);
  sdd(d, 'tdd', 'green', 'TEST-A-001');
  return d;
};

test('#330 stub members added to an existing TS type carry SDD-TODO(stub), a report row and a Green-file note', () => {
  const d = r29d();
  const r = sdd(d, 'tdd', 'stub', '--all', 'TEST-B-001', '--report');
  const lib = fs.readFileSync(path.join(d, 'lib.mjs'), 'utf8');
  assert.match(lib, /extra\([^)]*\) \{ \/\/ SDD-TODO\(stub\)/, lib);
  assert.match(r.out, /Box\.extra \| guessed/, r.out);
  assert.match(r.out, /lib\.mjs was modified but already implements Green REQ-A-001/, r.out);
});

test('#330 a receiver name bound to different types is ambiguous: not guessed into the class', () => {
  const d = r29d();
  fs.writeFileSync(path.join(d, 'b.test.mjs'), "import { Box } from './lib.mjs';\n// @id TEST-B-001 @verifies REQ-B-001\ntest('TEST-B-001 x', () => {\n  let s = 'abc';\n  assert.ok(s.startsWith('a'));\n  s = new Box();\n  s.startsWith('b');\n});\n");
  const r = sdd(d, 'tdd', 'stub', '--all', 'TEST-B-001', '--report');
  assert.doesNotMatch(fs.readFileSync(path.join(d, 'lib.mjs'), 'utf8'), /startsWith/);
  assert.match(r.out, /Box\.startsWith \| ambiguous/, r.out);
});

test('#330 gate warns (strict: fails) on leftover stub markers in a Green REQ file', () => {
  const d = r29d();
  fs.appendFileSync(path.join(d, 'lib.mjs'), "export function left() { throw new Error('not implemented: left'); }\n");
  const cp = path.join(d, '.sdd/config.json');
  fs.writeFileSync(cp, JSON.stringify({ ...JSON.parse(fs.readFileSync(cp, 'utf8')), scopePolicy: 'warn' }));
  const g = sdd(d, 'gate');
  assert.match(g.out, /! stub: 1 source file\(s\) of Green REQs still hold/, g.out);
  fs.writeFileSync(cp, JSON.stringify({ ...JSON.parse(fs.readFileSync(cp, 'utf8')), scopePolicy: 'strict' }));
  const s = sdd(d, 'gate');
  assert.match(s.out, /✗ stub: 1 source file/, s.out);
  assert.equal(s.code, 1, s.out);
});

// r29e #331: loosening checks/testCmd/changedCmd/dependsOn/artifacts/generated/artifactProducers is reported like r28b
const r29eBase = {
  checks: [{ name: 'a', cmd: ['node', '-e', '0'] }, { name: 'b', cmd: ['node', '-e', '0'] }],
  projects: [{ root: 'p', testCmd: ['node', '-e', '0'], changedCmd: ['node', '-e', '0'], dependsOn: ['q'], checks: [{ name: 'c', cmd: ['node', '-e', '0'], changedCmd: ['node', '-e', '0'] }] }, { root: 'q' }],
  artifacts: { 'contract/x.json': ['p/t.js', 'q/t.js'] },
  generated: ['dist/**'],
};
test('r29e no-op check/testCmd/changedCmd, removed checks, dependsOn, artifacts consumers, wider generated, new producers are reported', () => {
  const t = (patch, re, scopePolicy = 'warn') => {
    const d = r28b({ ...r29eBase, scopePolicy }, patch);
    for (const g of [sdd(d, 'gate', '--changed'), sdd(d, 'gate', '--no-run')]) assert.match(g.out, re, g.out);
    return d;
  };
  t({ checks: [{ name: 'a', cmd: ['true'] }, { name: 'b', cmd: ['node', '-e', '0'] }] }, /! config: .*check a cmd replaced by a no-op/);
  t({ checks: [{ name: 'a', cmd: ['node', '-e', '0'] }] }, /! config: .*root checks removed: b/);
  t({ projects: [{ ...r29eBase.projects[0], testCmd: ['echo', 'ok'] }, { root: 'q' }] }, /! config: .*project p testCmd replaced by a no-op/);
  t({ projects: [{ ...r29eBase.projects[0], changedCmd: [':'] }, { root: 'q' }] }, /! config: .*project p changedCmd replaced by a no-op/);
  t({ projects: [{ ...r29eBase.projects[0], checks: [] }, { root: 'q' }] }, /! config: .*project p checks removed: c/);
  t({ projects: [{ ...r29eBase.projects[0], dependsOn: [] }, { root: 'q' }] }, /! config: .*project p dependsOn removed: q/);
  t({ artifacts: {} }, /! config: .*artifacts entry contract\/x\.json removed/);
  t({ artifacts: { 'contract/x.json': ['p/t.js'] } }, /! config: .*consumers removed: q\/t\.js/);
  t({ generated: ['dist/**', 'tests/**'] }, /! config: .*generated \+= tests\/\*\*/);
  t({ artifactProducers: { 'contract/x.json': 'gen' } }, /! config: .*artifactProducers \+= contract\/x\.json/);
  const d = t({ projects: [{ ...r29eBase.projects[0], testCmd: ['exit', '0'] }, { root: 'q' }] }, /✗ config: .*testCmd/, 'strict');
  assert.equal(sdd(d, 'gate', '--changed').code, 1);
  assert.match(sdd(d, 'gate', '--changed', '--allow-config-weaken').out, /! config: .*accepted by --allow-config-weaken/);
});
test('r29e adding a project, a check, a consumer or editing a command stays silent', () => {
  const d = r28b({ ...r29eBase, scopePolicy: 'strict' }, {
    checks: [...r29eBase.checks, { name: 'new', cmd: ['true'] }],
    projects: [{ ...r29eBase.projects[0], testCmd: ['node', '-e', '1'], checks: [...r29eBase.projects[0].checks, { name: 'd', cmd: ['true'] }] }, { root: 'q' }, { root: 'r', checks: [{ name: 'e', cmd: ['true'] }] }],
    artifacts: { ...r29eBase.artifacts, 'contract/y.json': ['p/t.js'] },
  });
  for (const g of [sdd(d, 'gate', '--changed'), sdd(d, 'gate', '--no-run')]) assert.doesNotMatch(g.out, /config: .*(weakens|loosens)/, g.out);
});
test('r29e full gate skips an untracked config', () => {
  const d = mini('---\nfeature: a\ntier: T1\n---\n| REQ-A-001 | x shall hold. | TEST-A-001 |\n', {}, PASS);
  assert.doesNotMatch(sdd(d, 'gate', '--no-run').out, /config:/);
});

/** @id TEST-RUNNER-SELECTION-001 @verifies REQ-RUNNER-SELECTION-001 */
test('#332 TEST-RUNNER-SELECTION-001 runner argument changes require acknowledgement under strict policy', () => {
  for (const [before, after] of [
    [['cargo', 'test'], ['cargo', 'test', 'wire_round_trip']],
    [['python3', '-m', 'pytest', 'tests'], ['python3', '-m', 'pytest', 'tests', '-k', 'test_x']],
    [['pytest', 'tests'], ['pytest', 'tests/test_one.py']],
    [['go', 'test', './...'], ['go', 'test', './...', '-run', 'TestOne']],
    [['npm', 'test'], ['npm', 'test', '--', '--grep', 'one']],
    [['sh', '-c', 'cargo test'], ['sh', '-c', 'cargo test wire_round_trip']],
  ]) {
    for (const location of ['root check', 'root testCmd', 'root changedCmd', 'project check', 'project testCmd', 'project changedCmd']) {
      const scope = (cmd) => location.endsWith('check') ? { checks: [{ name: 'test', cmd, changedCmd: cmd }] } : { [location.split(' ')[1]]: cmd };
      const config = (cmd) => location.startsWith('project') ? { projects: [{ root: 'p', ...scope(cmd) }] } : scope(cmd);
      const d = r28b({ scopePolicy: 'strict', ...config(before) }, config(after));
      for (const args of [['--no-run'], ['--changed', '--baseline', 'HEAD', '--no-run']]) {
        const bad = sdd(d, 'gate', ...args);
        assert.equal(bad.code, 1, `${location}: ${bad.out}`);
        assert.match(bad.out, /✗ config: .*runner arguments\/selection changed/, bad.out);
        const accepted = sdd(d, 'gate', ...args, '--allow-config-weaken');
        assert.match(accepted.out, /! config: .*accepted by --allow-config-weaken/, accepted.out);
        assert.doesNotMatch(accepted.out, /✗ config:/, accepted.out);
      }
    }
  }
  const d = r28b({ scopePolicy: 'warn', checks: [{ name: 'test', cmd: ['cargo', 'test'] }] }, { checks: [{ name: 'test', cmd: ['cargo', 'test', 'one'] }] });
  assert.match(sdd(d, 'gate', '--no-run').out, /! config: .*runner arguments\/selection changed/);
  const unchanged = r28b({ scopePolicy: 'strict', checks: [{ name: 'test', cmd: ['cargo', 'test'] }] }, {});
  assert.doesNotMatch(sdd(unchanged, 'gate', '--no-run').out, /config:/);
});

test('#332 narrowed Node runner cannot silently hide an independently failing test', () => {
  const before = ['node', '--test', 'runner.test.mjs'];
  const after = ['node', '--test', '--test-name-pattern=passing', 'runner.test.mjs'];
  const d = r28b({ scopePolicy: 'strict', checks: [{ name: 'test', cmd: before }] }, {});
  fs.writeFileSync(path.join(d, 'runner.test.mjs'), "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\n// @id TEST-A-001 @verifies REQ-A-001\ntest('TEST-A-001 passing', () => assert.ok(true));\ntest('regression', () => assert.fail('omitted regression'));\n");
  setCmd(d, FAIL);
  assert.equal(sdd(d, 'tdd', 'red', 'TEST-A-001').code, 0);
  setCmd(d, PASS);
  assert.equal(sdd(d, 'tdd', 'green', 'TEST-A-001').code, 0);
  assert.equal(spawnSync(before[0], before.slice(1), { cwd: d, env: ENV }).status, 1);
  assert.equal(spawnSync(after[0], after.slice(1), { cwd: d, env: ENV }).status, 0);
  const cp = path.join(d, '.sdd/config.json');
  fs.writeFileSync(cp, JSON.stringify({ ...JSON.parse(fs.readFileSync(cp, 'utf8')), checks: [{ name: 'test', cmd: after }] }));
  for (const args of [[], ['--changed', '--baseline', 'HEAD']]) {
    const bad = sdd(d, 'gate', ...args);
    assert.equal(bad.code, 1, bad.out);
    assert.match(bad.out, /✗ config: .*runner arguments\/selection changed/, bad.out);
    const accepted = sdd(d, 'gate', ...args, '--allow-config-weaken');
    assert.equal(accepted.code, 0, accepted.out);
    assert.match(accepted.out, /! config: .*accepted by --allow-config-weaken/, accepted.out);
  }
});

test('#332 runner wrappers and argv boundaries retain selection integrity', () => {
  for (const [before, after] of [
    [['pnpm', 'exec', 'vitest', 'run'], ['pnpm', 'exec', 'vitest', 'run', 'one.test.js']],
    [['npx', 'jest'], ['npx', 'jest', '--testNamePattern=one']],
    [['sh', '-lc', 'node --test'], ['sh', '-lc', 'node --test --test-name-pattern=one']],
    [['/usr/bin/pytest', '-k', 'one two'], ['/usr/bin/pytest', '-k', 'one', 'two']],
  ]) {
    const d = r28b({ scopePolicy: 'strict', checks: [{ name: 'test', cmd: before }] }, { checks: [{ name: 'test', cmd: after }] });
    for (const args of [['--no-run'], ['--changed', '--no-run']]) {
      const bad = sdd(d, 'gate', ...args);
      assert.equal(bad.code, 1, bad.out);
      assert.match(bad.out, /✗ config: .*runner arguments\/selection changed/, bad.out);
    }
  }
});

test('#332 runner global options cannot hide selector changes', () => {
  for (const before of [['cargo', '+nightly', 'test'], ['python3', '-u', '-m', 'pytest'], ['go', '-C', 'pkg', 'test', './...']]) {
    const d = r28b({ scopePolicy: 'strict', checks: [{ name: 'test', cmd: before }] }, { checks: [{ name: 'test', cmd: [...before, 'one'] }] });
    const bad = sdd(d, 'gate', '--no-run');
    assert.equal(bad.code, 1, bad.out);
    assert.match(bad.out, /✗ config: .*runner arguments\/selection changed/, bad.out);
  }
});

test('r30b #333 full gate detects newly introduced check definitions and refreshes their evidence', () => {
  const cases = [
    ['pytest.ini', '[pytest]\naddopts = -k test_sum_001\n', 'pytest'],
    ['tox.ini', '[pytest]\naddopts = -k test_sum_001\n', 'pytest'],
    ['setup.cfg', '[tool:pytest]\naddopts = -k test_sum_001\n', 'pytest'],
    ['conftest.py', 'def pytest_collection_modifyitems(items):\n    items[:] = items[:1]\n', 'pytest'],
    ['tests/conftest.py', 'def pytest_collection_modifyitems(items):\n    items[:] = items[:1]\n', 'pytest'],
    ['.cargo/config', '[alias]\nversion = "test one"\n', 'cargo'],
    ['.cargo/config.toml', '[alias]\nversion = "test one"\n', 'cargo'],
    ['python/pytest.ini', '[pytest]\naddopts = -k test_sum_001\n', 'project'],
  ];
  for (const [file, text, kind] of cases) {
    const cmd = kind === 'cargo' ? ['cargo', 'version'] : ['sh', '-c', 'true # python -m pytest'];
    const extra = kind === 'project'
      ? { checks: [], projects: [{ root: 'python', checks: [{ name: 'test', cmd }] }] }
      : {};
    const d = mini(T1SPEC, {
      'a.test.mjs': '// @id TEST-A-001 @verifies REQ-A-001\n',
      'pyproject.toml': '[tool.pytest.ini_options]\ntestpaths = ["tests"]\n',
      'python/.gitkeep': '',
    }, FAIL);
    const cp = path.join(d, '.sdd/config.json');
    fs.writeFileSync(cp, JSON.stringify({ ...JSON.parse(fs.readFileSync(cp, 'utf8')), checks: [{ name: 'test', cmd }], scopePolicy: 'warn', ...extra }));
    assert.equal(sdd(d, 'tdd', 'red', 'TEST-A-001').code, 0);
    setCmd(d, PASS);
    assert.equal(sdd(d, 'tdd', 'green', 'TEST-A-001').code, 0);
    const policy = (scopePolicy) => fs.writeFileSync(cp, JSON.stringify({ ...JSON.parse(fs.readFileSync(cp, 'utf8')), scopePolicy }));
    assert.equal(sdd(d, 'gate').code, 0);
    fs.mkdirSync(path.dirname(path.join(d, file)), { recursive: true });
    fs.writeFileSync(path.join(d, file), text);
    const gate = () => sdd(d, 'gate');
    const w = gate();
    assert.match(w.out, /! scope: .*differs from the last Green record/, `${file}: ${w.out}`);
    assert.ok(w.out.includes(file), w.out);
    policy('strict');
    const s = gate();
    assert.equal(s.code, 1, `${file}: ${s.out}`);
    assert.match(s.out, /✗ scope: .*differs from the last Green record/, s.out);
    assert.equal(sdd(d, 'tdd', 'refactor', 'TEST-A-001').code, 0);
    const refreshed = gate();
    assert.equal(refreshed.code, 0, refreshed.out);
    assert.doesNotMatch(refreshed.out, /differs from the last Green record/);
    fs.rmSync(path.join(d, file));
    const removed = gate();
    assert.equal(removed.code, 1, removed.out);
    assert.match(removed.out, /no longer defines it/, removed.out);
  }
});

function testEvidence(d) {
  const ledger = path.join(d, '.sdd/tdd.jsonl');
  return fs.existsSync(ledger) ? fs.readFileSync(ledger, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).filter((e) => e.test) : [];
}

/** @id TEST-R30C-001 @verifies REQ-R30C-001 */
test('TEST-R30C-001 r30c #334 hand-rehashed approval and review cannot bless an unreviewed Design edit', async () => {
  const { createHash } = await import('node:crypto');
  const d = mini('---\nfeature: a\ntier: T2\n---\n## Design\nPure calculation.\nNo state.\n\n| REQ-A-001 | one shall hold. | TEST-A-001 |\n', { 'a.test.mjs': jsTest() }, PASS);
  fs.writeFileSync(path.join(d, '.sdd/config.json'), JSON.stringify({ testCmd: PASS, checks: [{ name: 'ok', cmd: PASS }] }));
  const review = '.sdd/review-a.md';
  const refreshReview = () => {
    const hash = sdd(d, 'approve', 'prepare', 'a').out.match(/sha256:([0-9a-f]{64})/)[1];
    fs.writeFileSync(path.join(d, review), `spec: sha256:${hash}\nverdict: pass\nopen: 0\n`);
    return hash;
  };
  refreshReview();
  assert.equal(sdd(d, 'approve', 'record', 'a', '--by', 'ai:duck', '--review', review).code, 0);
  assert.equal(sdd(d, 'tdd', 'red', 'TEST-A-001', '--characterization', 'pure fixture').code, 0);
  assert.equal(sdd(d, 'tdd', 'green', 'TEST-A-001').code, 0);
  const baseline = sdd(d, 'gate');
  assert.equal(baseline.code, 0, baseline.out);
  spawnSync('git', ['add', '-A'], { cwd: d });
  assert.equal(spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'approved baseline'], { cwd: d }).status, 0);
  fs.appendFileSync(specPath(d), '\nUnreviewed Design addition.\n');
  assert.match(sdd(d, 'gate').out, /lock a: stale/);
  const specHash = refreshReview();
  const ap = path.join(d, '.sdd/approvals.json');
  const approvals = JSON.parse(fs.readFileSync(ap, 'utf8'));
  const oldAt = approvals.a.at;
  approvals.a.artifacts['.sdd/specs/a.md'] = specHash;
  approvals.a.reviewSha = createHash('sha256').update(fs.readFileSync(path.join(d, review))).digest('hex');
  fs.writeFileSync(ap, JSON.stringify(approvals));
  assert.equal(approvals.a.at, oldAt);
  for (const args of [['gate'], ['gate', '--changed']]) {
    const forged = sdd(d, ...args);
    assert.equal(forged.code, 1, forged.out);
    assert.match(forged.out, /lock a: .*provenance/, forged.out);
  }
  assert.match(sdd(d, 'guard').out, /approval .*provenance/);
  assert.match(sdd(d, 'tdd', 'red', 'TEST-A-001').out, /REFUSED.*provenance/);
  assert.equal(sdd(d, 'approve', 'record', 'a', '--by', 'ai:duck', '--review', review).code, 0);
  assert.equal(sdd(d, 'gate').code, 0);
});

test('r30c #334 legacy approvals require unchanged committed provenance and can migrate', () => {
  const d = project();
  assert.equal(sdd(d, 'approve', 'record', 'calc', '--by', 'ai:duck', '--review', 'no findings').code, 0);
  const ledger = path.join(d, '.sdd/tdd.jsonl');
  fs.rmSync(ledger);
  assert.match(sdd(d, 'guard').out, /provenance/);
  spawnSync('git', ['add', '-A'], { cwd: d });
  assert.equal(spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'legacy approval'], { cwd: d }).status, 0);
  assert.equal(sdd(d, 'guard').code, 0);
  const ap = path.join(d, '.sdd/approvals.json');
  const a = JSON.parse(fs.readFileSync(ap, 'utf8'));
  a.calc.at = '2000-01-01T00:00:00.000Z';
  fs.writeFileSync(ap, JSON.stringify(a));
  assert.match(sdd(d, 'guard').out, /provenance/);
  assert.equal(sdd(d, 'approve', 'record', 'calc', '--by', 'ai:duck', '--review', 'reviewed again').code, 0);
  assert.equal(sdd(d, 'guard').code, 0);
  const event = JSON.parse(fs.readFileSync(ledger, 'utf8').trim());
  assert.equal(event.type, 'approval');
  assert.equal(event.feature, 'calc');
  assert.match(event.approvalSha, /^[0-9a-f]{64}$/);
  spawnSync('git', ['add', '-A'], { cwd: d });
  assert.equal(spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'migrated approval'], { cwd: d }).status, 0);
  fs.rmSync(ledger);
  assert.match(sdd(d, 'guard').out, /provenance/);
});

test('r30c #334 approval events survive merge-ledger and cannot be written onto a broken chain', () => {
  const d = project();
  assert.equal(sdd(d, 'approve', 'record', 'calc', '--by', 'ai:duck', '--review', 'no findings').code, 0);
  assert.equal(sdd(d, 'tdd', 'merge-ledger').code, 0);
  assert.equal(sdd(d, 'guard').code, 0);
  const ledger = path.join(d, '.sdd/tdd.jsonl');
  const original = fs.readFileSync(ledger, 'utf8');
  fs.writeFileSync(ledger, original.replace('"approvalSha":"', '"approvalSha":"0'));
  assert.match(sdd(d, 'guard').out, /provenance/);
  assert.match(sdd(d, 'approve', 'record', 'calc', '--by', 'ai:duck', '--review', 'no findings').out, /REFUSED.*ledger.*broken/);
  fs.writeFileSync(ledger, original);
  assert.equal(sdd(d, 'guard').code, 0);
});

function r30dFlakyProject(flaky, cmdBody) {
  const d = flakyProject(flaky, cmdBody);
  fs.writeFileSync(path.join(d, '.sdd/specs/retry.md'),
    '---\nfeature: retry\ntier: T1\n---\n| REQ-RETRY-001 (deferred) | The system shall support retries. | — |\n');
  return d;
}

test('#335 a skipped Node retry cannot recover a failed test check', () => {
  const d = r30dFlakyProject({ retries: 1, policy: 'warn' }, '');
  fs.writeFileSync(path.join(d, 'retry.test.mjs'), [
    "import { test } from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import fs from 'node:fs';",
    "const skip = fs.existsSync('retry-marker');",
    "test('retry target', { skip }, () => {",
    "  fs.writeFileSync('retry-marker', '1');",
    "  assert.fail('first attempt fails');",
    "});",
  ].join('\n'));
  fs.writeFileSync(path.join(d, '.sdd/config.json'), JSON.stringify({
    checks: [{ name: 'test', cmd: ['node', '--test', '--test-name-pattern=retry target', 'retry.test.mjs'] }],
    flaky: { retries: 1, policy: 'warn' },
  }));
  const first = sdd(d, 'gate');
  assert.equal(first.code, 1, first.out);
  assert.match(first.out, /✗ cmd test \(/);
  assert.doesNotMatch(first.out, /FLAKY suspected/);
  assert.equal(fs.existsSync(path.join(d, '.sdd/tdd.jsonl')), false);
  const second = sdd(d, 'gate');
  assert.equal(second.code, 2, second.out);
  assert.match(second.out, /INCOMPLETE, no passing assertions/);
});

test('#335 no-execution retry summaries do not produce flaky recovery evidence', () => {
  const summaries = [
    'Tests  1 skipped (1)',
    '1 skipped in 0.01s',
    's [100%]',
    'test result: ok. 0 passed; 0 failed; 1 ignored;',
    'No tests found',
    'Tests: 1, Assertions: 0',
  ];
  for (const policy of ['warn', 'fail']) {
    for (const summary of summaries) {
      const d = r30dFlakyProject({ retries: 1, policy },
        `const f=require('fs');if(f.existsSync('m')){console.log(${JSON.stringify(summary)});}else{f.writeFileSync('m','1');console.log('AssertionError: first attempt');process.exit(1);}`);
      const r = sdd(d, 'gate');
      assert.equal(r.code, 1, `${policy}: ${summary}\n${r.out}`);
      assert.match(r.out, /✗ cmd test \(/);
      assert.doesNotMatch(r.out, /FLAKY suspected/);
      assert.equal(fs.existsSync(path.join(d, '.sdd/tdd.jsonl')), false);
    }
  }
});

test('#335 a later executed retry may recover after a skipped retry', () => {
  const d = r30dFlakyProject({ retries: 2, policy: 'warn' },
    "const f=require('fs');const n=f.existsSync('m')?Number(f.readFileSync('m','utf8')):0;f.writeFileSync('m',String(n+1));if(n===0){console.log('AssertionError: first attempt');process.exit(1);}console.log(n===1?'Tests  1 skipped (1)':'Tests  1 passed (1)');");
  const r = sdd(d, 'gate');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /FLAKY suspected: .*passed on re-run 2\/2/);
  const entries = fs.readFileSync(path.join(d, '.sdd/tdd.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].type, 'flaky');
  assert.equal(entries[0].retry, 2);
  assert.equal(entries[0].outcome, 'accepted');
});

test('r30e #336 approve retire refuses generic and normalized automation names without changing records', () => {
  for (const target of ['REQ-A-002', 'a']) {
    const d = mini(T1SPEC);
    fs.rmSync(specPath(d));
    const file = path.join(d, '.sdd', target.startsWith('REQ-') ? 'retired-reqs.json' : 'approvals.json');
    const original = JSON.stringify(target.startsWith('REQ-')
      ? { 'REQ-OTHER-001': { by: 'Alice', at: '2026-01-01T00:00:00Z' } }
      : { a: { by: 'Alice', tier: 'T2' }, other: { by: 'Bob', tier: 'T2' } });
    fs.writeFileSync(file, original);
    for (const by of ['bot', 'agent', 'copilot', 'assistant', 'claude', 'gpt', 'human', 'user', 'ai', 'me', 'test', '', 'ai:probe', ' AI : probe ', ' ＢＯＴ ', 'b\u200bot', 'CoPiLoT']) {
      const r = sddRaw(d, 'approve', 'retire', target, '--by', by);
      assert.equal(r.code, 1, `${target} --by ${JSON.stringify(by)}: ${r.out}`);
      assert.match(r.out, /REFUSED.*human approver/, r.out);
      assert.equal(fs.readFileSync(file, 'utf8'), original, 'refused retirement must not write records');
    }
    const missing = sddRaw(d, 'approve', 'retire', target);
    assert.equal(missing.code, 1, missing.out);
    assert.equal(fs.readFileSync(file, 'utf8'), original);
    const accepted = sddRaw(d, 'approve', 'retire', target, '--by', ' Ａlice\u200b ');
    assert.equal(accepted.code, 0, accepted.out);
    const records = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (target.startsWith('REQ-')) {
      assert.equal(records[target].by, 'Alice');
      assert.deepEqual(records['REQ-OTHER-001'], JSON.parse(original)['REQ-OTHER-001']);
    } else {
      assert.equal(Object.hasOwn(records, target), false);
      assert.deepEqual(records.other, JSON.parse(original).other);
    }
  }
});

test('r30e #336 rejected bot retirement does not create a REQ retirement file', () => {
  const d = mini(T1SPEC);
  const r = sddRaw(d, 'approve', 'retire', 'REQ-A-002', '--by', 'bot');
  assert.equal(r.code, 1, r.out);
  assert.equal(fs.existsSync(path.join(d, '.sdd/retired-reqs.json')), false);
});

test('r30e #336 strict gate keeps vanished Green REQs failing after bot retirement is refused', () => {
  const imports = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\n";
  const extra = "// @id TEST-A-002 @verifies REQ-A-002\ntest('TEST-A-002 y', () => assert.ok(1));\n";
  const d = mini(T1SPEC + '| REQ-A-002 | two shall hold. | TEST-A-002 |\n', { 'a.test.mjs': imports + jsTest(extra) }, ['node', '--test', '--test-name-pattern={id}', 'a.test.mjs']);
  const cp = path.join(d, '.sdd/config.json');
  fs.writeFileSync(cp, JSON.stringify({ ...JSON.parse(fs.readFileSync(cp, 'utf8')), scopePolicy: 'strict', checks: [{ name: 'test', cmd: ['node', '--test', 'a.test.mjs'] }] }));
  for (const id of ['TEST-A-001', 'TEST-A-002']) {
    const red = sdd(d, 'tdd', 'red', id, '--characterization', 'retirement guard fixture');
    assert.equal(red.code, 0, red.out);
    const green = sdd(d, 'tdd', 'green', id);
    assert.equal(green.code, 0, green.out);
  }
  fs.writeFileSync(specPath(d), T1SPEC);
  fs.writeFileSync(path.join(d, 'a.test.mjs'), imports + jsTest());
  const before = sdd(d, 'gate');
  assert.equal(before.code, 1, before.out);
  assert.match(before.out, /✗ req REQ-A-002/, before.out);
  const refused = sddRaw(d, 'approve', 'retire', 'REQ-A-002', '--by', 'bot');
  assert.equal(refused.code, 1, refused.out);
  const after = sdd(d, 'gate');
  assert.equal(after.code, 1, after.out);
  assert.match(after.out, /✗ req REQ-A-002/, after.out);
  const accepted = sddRaw(d, 'approve', 'retire', 'REQ-A-002', '--by', 'Alice');
  assert.equal(accepted.code, 0, accepted.out);
  const cleared = sdd(d, 'gate');
  assert.equal(cleared.code, 0, cleared.out);
  assert.doesNotMatch(cleared.out, /req REQ-A-002/);
});

/** @id TEST-GATESNAPSHOT-001 @verifies REQ-GATESNAPSHOT-001 */
test('TEST-GATESNAPSHOT-001 #337 prepare lockfile rewrites preserve workspace and transitive consumer checks', () => {
  for (const exit of [0, 1]) {
    const d = mini(T1SPEC, {
      'a.test.mjs': jsTest(),
      'lib.mjs': '// @id CODE-A-001 @implements REQ-A-001\nexport const value = 1;\n',
      'rust/Cargo.toml': '[workspace]\nmembers = ["crates/*"]\n',
      'rust/Cargo.lock': 'v1\n',
      'rust/crates/a/Cargo.toml': '[package]\nname = "a"\n',
      'rust/crates/b/Cargo.toml': '[package]\nname = "b"\n',
      'python/direct/pyproject.toml': '[project]\nname = "direct"\n',
      'python/transitive/pyproject.toml': '[project]\nname = "transitive"\n',
      'unrelated/package.json': '{}',
    }, FAIL);
    assert.equal(sdd(d, 'tdd', 'red', 'TEST-A-001').code, 0);
    setCmd(d, PASS);
    assert.equal(sdd(d, 'tdd', 'green', 'TEST-A-001').code, 0);
    fs.writeFileSync(path.join(d, '.sdd/config.json'), JSON.stringify({
      testCmd: PASS,
      checks: [],
      prepare: { cmd: ['git', 'checkout', '--', 'rust/Cargo.lock'] },
      projects: [
        { root: 'rust/crates/a', checks: [{ name: 'probe', cmd: ['node', '-e', `process.exit(${exit})`] }] },
        { root: 'rust/crates/b', checks: [{ name: 'ok', cmd: PASS }] },
        { root: 'python/direct', dependsOn: ['rust/crates/a'], checks: [{ name: 'ok', cmd: PASS }] },
        { root: 'python/transitive', dependsOn: ['python/direct'], checks: [{ name: 'ok', cmd: PASS }] },
        { root: 'unrelated', checks: [{ name: 'ok', cmd: FAIL }] },
      ],
    }));
    assert.equal(spawnSync('git', ['add', '-A'], { cwd: d }).status, 0);
    assert.equal(spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'baseline'], { cwd: d }).status, 0);
    fs.appendFileSync(path.join(d, 'rust/Cargo.lock'), '# normalize me\n');
    const g = sdd(d, 'gate', '--changed', '--baseline', 'HEAD', '--explain');
    assert.equal(fs.readFileSync(path.join(d, 'rust/Cargo.lock'), 'utf8'), 'v1\n');
    assert.match(g.out, /✓ prepare \(/, g.out);
    assert.match(g.out, new RegExp(`${exit ? '✗' : '✓'} cmd rust/crates/a:probe`), g.out);
    for (const root of ['rust/crates/b', 'python/direct', 'python/transitive']) assert.ok(g.out.includes(`✓ cmd ${root}:ok`), g.out);
    assert.match(g.out, /cmd unrelated:ok: no changed files.*skipped/, g.out);
    assert.equal(g.code, exit, g.out);
    assert.match(g.out, new RegExp(`SDD GATE ${exit ? 'FAIL' : 'PASS'}`), g.out);
  }
});

test('#338 vanished secondary REQs in grouped Green evidence warn, fail strict gates, and require human retirement', () => {
  const spec = T1SPEC + '| REQ-A-002 | two shall hold. | TEST-A-001 |\n';
  const source = (reqs, offset) => `// @id CODE-A-001 @implements ${reqs}\nexport const add = (value) => value + ${offset};\n`;
  const testBody = (id, reqs, extra = '') => `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from './add.mjs';\n// @id ${id} @verifies ${reqs}\ntest('${id} increments', () => {\n  assert.equal(add(1), 2);\n${extra}});\n`;
  const d = mini(spec, {
    'add.mjs': source('REQ-A-001 REQ-A-002', 0),
    'a.test.mjs': testBody('TEST-A-001', 'REQ-A-001 REQ-A-002', '  assert.equal(add(2), 3);\n'),
  }, ['node', '--test', 'a.test.mjs']);
  const cp = path.join(d, '.sdd/config.json');
  const config = { ...JSON.parse(fs.readFileSync(cp, 'utf8')), checks: [{ name: 'test', cmd: ['node', '--test', 'a.test.mjs'] }] };
  fs.writeFileSync(cp, JSON.stringify(config));
  assert.equal(sdd(d, 'tdd', 'red', 'TEST-A-001').code, 0);
  fs.writeFileSync(path.join(d, 'add.mjs'), source('REQ-A-001 REQ-A-002', 1));
  assert.equal(sdd(d, 'tdd', 'green', 'TEST-A-001').code, 0);
  const oldGreen = fs.readFileSync(path.join(d, '.sdd/tdd.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).find((e) => e.type === 'green');
  assert.equal(oldGreen.req, 'REQ-A-001');
  assert.deepEqual(Object.keys(oldGreen.reqShas), ['REQ-A-001', 'REQ-A-002']);
  const baseline = sdd(d, 'gate');
  assert.equal(baseline.code, 0, baseline.out);

  fs.writeFileSync(specPath(d), T1SPEC.replace('TEST-A-001', 'TEST-A-002'));
  fs.writeFileSync(path.join(d, 'a.test.mjs'), testBody('TEST-A-002', 'REQ-A-001'));
  fs.writeFileSync(path.join(d, 'add.mjs'), source('REQ-A-001', 0));
  assert.equal(sdd(d, 'tdd', 'red', 'TEST-A-002').code, 0);
  fs.writeFileSync(path.join(d, 'add.mjs'), source('REQ-A-001', 1));
  assert.equal(sdd(d, 'tdd', 'green', 'TEST-A-002').code, 0);

  for (const policy of ['warn', 'strict']) {
    fs.writeFileSync(cp, JSON.stringify({ ...config, scopePolicy: policy }));
    for (const args of [['gate'], ['gate', '--changed']]) {
      const result = sdd(d, ...args);
      assert.equal(result.code, policy === 'strict' ? 1 : 0, result.out);
      assert.match(result.out, /req REQ-A-002: has Green evidence.*approve retire REQ-A-002/, result.out);
      assert.equal(result.out.split('req REQ-A-002:').length - 1, 1, result.out);
      assert.doesNotMatch(result.out, /req REQ-A-001: has Green evidence/);
    }
  }
  assert.match(sdd(d, 'approve', 'retire', 'REQ-A-002', '--by', 'ai:reviewer').out, /REFUSED/);
  assert.equal(sdd(d, 'approve', 'retire', 'REQ-A-002', '--by', 'alice').code, 0);
  for (const args of [['gate'], ['gate', '--changed']]) {
    const result = sdd(d, ...args);
    assert.equal(result.code, 0, result.out);
    assert.doesNotMatch(result.out, /req REQ-A-002: has Green evidence/);
  }
});

/** @id TEST-R36D-TS-001 @verifies REQ-R36D-TS-001 */
test('#339 native Node TypeScript parse failures cannot establish Red for any selected ID TEST-R36D-TS-001', () => {
  const ids = ['TEST-A-001', 'TEST-A-002'];
  const child = spawnSync('node', ['-p', 'JSON.stringify([process.version, process.execPath, !!process.features.typescript])'], { encoding: 'utf8', env: ENV });
  assert.equal(child.status, 0, child.stdout + child.stderr);
  const runtime = JSON.parse(child.stdout);
  assert.equal(runtime[0], process.version);
  assert.equal(fs.realpathSync(runtime[1]), fs.realpathSync(process.execPath));
  assert.equal(runtime[2], !!process.features.typescript);
  const stripsTypes = runtime[2];
  console.log(`r36d #339 actual child=${JSON.stringify(runtime)}`);
  const subject = (body) => `// @id CODE-A-001 @implements REQ-A-001\nexport const answer: number = ${body};\n`;
  const d = mini(T1SPEC, {
    'package.json': '{"type":"module"}',
    'subject.ts': subject('1') + 'const broken = ;\n',
    'a.test.mjs': [
      "import { test } from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { answer } from './subject.ts';",
      ...ids.flatMap((id) => [
        `// @id ${id} @verifies REQ-A-001`,
        `test('${id} answer', () => assert.equal(answer, 1));`,
      ]),
      '',
    ].join('\n'),
  }, ['node', '--test', '--test-reporter=spec', '--test-name-pattern={id}', '{file}']);
  const parser = spawnSync('node', ['--test', '--test-reporter=spec', 'a.test.mjs'], { cwd: d, encoding: 'utf8', env: ENV });
  assert.equal(parser.status, 1, parser.stdout + parser.stderr);
  assert.match(parser.stdout + parser.stderr, stripsTypes
    ? /SyntaxError \[ERR_INVALID_TYPESCRIPT_SYNTAX\]:/
    : /TypeError \[ERR_UNKNOWN_FILE_EXTENSION\]: Unknown file extension "\.ts"/);
  console.log(`r36d native invalid typed source exit=${parser.status}\n${parser.stdout}${parser.stderr}`);
  const ledger = path.join(d, '.sdd/tdd.jsonl');
  for (const id of ids) {
    const red = sdd(d, 'tdd', 'red', id);
    assert.equal(red.code, 1, red.out);
    assert.match(red.out, /RED REJECTED.*load\/compile error/);
    assert.equal(fs.existsSync(ledger), false);
  }
  fs.writeFileSync(path.join(d, 'subject.ts'), subject('1'));
  const valid = spawnSync('node', ['--test', '--test-reporter=spec', 'a.test.mjs'], { cwd: d, encoding: 'utf8', env: ENV });
  assert.equal(valid.status, stripsTypes ? 0 : 1, valid.stdout + valid.stderr);
  if (stripsTypes) {
    for (const id of ids) assert.match(valid.stdout, new RegExp(`✔ ${id} answer`), valid.stdout);
  } else assert.match(valid.stdout + valid.stderr, /TypeError \[ERR_UNKNOWN_FILE_EXTENSION\]: Unknown file extension "\.ts"/);
  console.log(`r36d native valid typed source exit=${valid.status}\n${valid.stdout}${valid.stderr}`);
  const noRed = sdd(d, 'tdd', 'green', ids[0]);
  assert.equal(noRed.code, 1, noRed.out);
  assert.equal(fs.existsSync(ledger), false);
  fs.writeFileSync(path.join(d, 'subject.ts'), subject('0'));
  if (stripsTypes) {
    const red = sdd(d, 'tdd', 'red', ids[0]);
    assert.equal(red.code, 0, red.out);
    assert.doesNotMatch(red.out, /\[weak\]/);
    fs.writeFileSync(path.join(d, 'subject.ts'), subject('1'));
    const green = sdd(d, 'tdd', 'green', ids[0]);
    assert.equal(green.code, 0, green.out);
    assert.deepEqual(testEvidence(d).map(({ type, test, weak }) => [type, test, !!weak]),
      [['red', ids[0], false], ['green', ids[0], false]]);
    console.log('r36d genuine native TS strong Red/Green persisted');
  } else {
    for (const id of ids) {
      const unsupported = sdd(d, 'tdd', 'red', id);
      assert.equal(unsupported.code, 1, unsupported.out);
      assert.match(unsupported.out, /RED REJECTED.*load\/compile error/, unsupported.out);
      assert.equal(fs.existsSync(ledger), false);
    }
    console.log('r36d unsupported native TS default Red refused for both IDs; ledger absent');
  }

  for (const body of ['return 0;', "throw new Error('not implemented: answer');"]) {
    const js = mini(T1SPEC, {
      'subject.mjs': `// @id CODE-A-001 @implements REQ-A-001\nexport const answer = () => { ${body} };\n`,
      'a.test.mjs': "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { answer } from './subject.mjs';\n/** @id TEST-A-001 @verifies REQ-A-001 */\ntest('TEST-A-001 answer', () => assert.equal(answer(), 1));\n",
    }, ['node', '--test', '--test-reporter=spec', '--test-name-pattern={id}', '{file}']);
    const native = spawnSync('node', ['--test', '--test-reporter=spec', 'a.test.mjs'], { cwd: js, encoding: 'utf8', env: ENV });
    assert.equal(native.status, 1, native.stdout + native.stderr);
    assert.match(native.stdout + native.stderr, body === 'return 0;'
      ? /AssertionError \[ERR_ASSERTION\]/
      : /Error: not implemented: answer/);
    const red = sdd(js, 'tdd', 'red', ids[0]);
    assert.equal(red.code, 0, red.out);
    assert.doesNotMatch(red.out, /\[weak\]/);
    fs.writeFileSync(path.join(js, 'subject.mjs'), '// @id CODE-A-001 @implements REQ-A-001\nexport const answer = () => 1;\n');
    const green = sdd(js, 'tdd', 'green', ids[0]);
    assert.equal(green.code, 0, green.out);
    assert.deepEqual(testEvidence(js).map(({ type, test, weak }) => [type, test, !!weak]),
      [['red', ids[0], false], ['green', ids[0], false]]);
    console.log(`r36d JS ${body} native exit=${native.status}; strong Red/Green persisted\n${native.stdout}${native.stderr}`);
    if (!stripsTypes) {
      fs.writeFileSync(path.join(js, 'subject.ts'), 'export const answer = (): number => 0;\n');
      fs.writeFileSync(path.join(js, 'subject.mjs'), "export { answer } from './subject.ts';\n");
      const jsLedger = path.join(js, '.sdd/tdd.jsonl');
      const before = fs.readFileSync(jsLedger);
      const loaded = spawnSync('node', ['--test', '--test-reporter=spec', 'a.test.mjs'], { cwd: js, encoding: 'utf8', env: ENV });
      assert.equal(loaded.status, 1, loaded.stdout + loaded.stderr);
      assert.match(loaded.stdout + loaded.stderr, /TypeError \[ERR_UNKNOWN_FILE_EXTENSION\]: Unknown file extension "\.ts"/);
      const rejected = sdd(js, 'tdd', 'red', ids[0]);
      assert.equal(rejected.code, 1, rejected.out);
      assert.match(rejected.out, /RED REJECTED.*load\/compile error/, rejected.out);
      assert.deepEqual(fs.readFileSync(jsLedger), before);
      console.log(`r36d unsupported native TS preserves existing JS Red/Green ledger bytes\n${loaded.stdout}${loaded.stderr}`);
    }
  }
});

function r31aFixture(files, checks, projects = []) {
  const d = mini(T1SPEC, { 'a.test.mjs': jsTest(), ...files }, FAIL);
  const cp = path.join(d, '.sdd/config.json');
  fs.writeFileSync(cp, JSON.stringify({
    ...JSON.parse(fs.readFileSync(cp, 'utf8')),
    scan: { include: ['a.test.mjs'] },
    scopePolicy: 'warn', unscoped: ['**'], checks, projects,
  }));
  assert.equal(sdd(d, 'tdd', 'red', 'TEST-A-001').code, 0);
  setCmd(d, PASS);
  const green = sdd(d, 'tdd', 'green', 'TEST-A-001');
  assert.equal(green.code, 0, green.out);
  assert.equal(spawnSync('git', ['add', '-A'], { cwd: d }).status, 0);
  assert.equal(spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'check closure baseline'], { cwd: d }).status, 0);
  return d;
}

function r31aDrift(d, file) {
  const cp = path.join(d, '.sdd/config.json');
  for (const policy of ['warn', 'strict']) {
    fs.writeFileSync(cp, JSON.stringify({ ...JSON.parse(fs.readFileSync(cp, 'utf8')), scopePolicy: policy }));
    for (const args of [['gate'], ['gate', '--changed', '--baseline', 'HEAD']]) {
      const g = sdd(d, ...args);
      assert.equal(g.code, policy === 'strict' ? 1 : 0, g.out);
      assert.match(g.out, /scope: .*defin(?:es|ing) what a gate check runs/, g.out);
      assert.ok(g.out.includes(file), `${file}: ${g.out}`);
    }
  }
}

/** @id TEST-CHECK-CLOSURE-001 @verifies REQ-CHECK-CLOSURE-001 */
test('TEST-CHECK-CLOSURE-001 r31a #340 command closure follows interpreter targets nested wrappers make recipes and cycles', () => {
  const cases = [
    [{ 'tools/run.py': 'import subprocess\nsubprocess.call(["sh", "tools/nested.sh"])\n', 'tools/nested.sh': 'true\n' }, ['sh', '-c', 'true # python3 tools/run.py'], 'tools/nested.sh'],
    [{ 'tools/run.mjs': "import { spawnSync } from 'node:child_process';\nspawnSync('sh', ['tools/nested.sh'], {stdio:'inherit'});\n", 'tools/nested.sh': 'true\n' }, ['node', 'tools/run.mjs'], 'tools/nested.sh'],
    [{ 'tools/check.sh': 'make verify\n', Makefile: 'verify:\n\tsh tools/nested.sh\n', 'tools/nested.sh': 'true\n' }, ['sh', 'tools/check.sh'], 'tools/nested.sh'],
    [{ 'tools/run.sh': 'true # sh tools/loop.sh\n', 'tools/loop.sh': 'true # sh tools/run.sh\n' }, ['sh', 'tools/run.sh'], 'tools/loop.sh'],
    [{ 'tools/check space.mjs': 'process.exit(0);\n' }, ['node', 'tools/check space.mjs'], 'tools/check space.mjs'],
  ];
  for (const [files, cmd, target] of cases) {
    const d = r31aFixture(files, [{ name: 'test', cmd }]);
    assert.equal(sdd(d, 'gate').code, 0);
    fs.appendFileSync(path.join(d, target), target.endsWith('.mjs') ? '// changed selection\n' : '# changed selection\n');
    r31aDrift(d, target);
  }
});

/** @id TEST-CHECK-CLOSURE-002 @verifies REQ-CHECK-CLOSURE-001 */
test('TEST-CHECK-CLOSURE-002 r31a #340 package wrappers include nested script calls project cwd and symlink targets', () => {
  const d = r31aFixture({
    'app/package.json': JSON.stringify({ scripts: { test: 'npm run inner', inner: 'node tools/check.mjs' } }),
    'app/tools/check.mjs': 'process.exit(0);\n',
    'app/tools/narrow.mjs': 'process.exit(0); // narrowed\n',
  }, [], [{ root: 'app', checks: [{ name: 'test', cmd: ['npm', 'run', 'test'] }] }]);
  const baseline = sdd(d, 'gate');
  assert.equal(baseline.code, 0, baseline.out);
  fs.rmSync(path.join(d, 'app/tools/check.mjs'));
  fs.symlinkSync('narrow.mjs', path.join(d, 'app/tools/check.mjs'));
  r31aDrift(d, 'app/tools/check.mjs');
});

/** @id TEST-CHECK-CLOSURE-003 @verifies REQ-CHECK-CLOSURE-002 */
test('TEST-CHECK-CLOSURE-003 r31a #343 npm pnpm yarn lifecycle additions edits removals and hook wrappers are definitions', () => {
  for (const manager of ['npm', 'pnpm', 'yarn']) {
    for (const hook of ['pretest', 'posttest']) {
      const files = {
        'package.json': JSON.stringify({ scripts: { test: 'node -e 0', [hook]: 'node tools/hook.mjs', unrelated: 'true' } }),
        'tools/hook.mjs': 'process.exit(0);\n',
      };
      const cmd = manager === 'npm' ? ['npm', 'test'] : ['sh', '-c', `true # ${manager} run test`];
      const d = r31aFixture(files, [{ name: 'test', cmd }]);
      const pkg = path.join(d, 'package.json');
      fs.writeFileSync(pkg, JSON.stringify({ scripts: { ...JSON.parse(files['package.json']).scripts, unrelated: 'false' } }));
      for (const args of [['gate'], ['gate', '--changed']]) {
        const unchanged = sdd(d, ...args);
        assert.equal(unchanged.code, 0, unchanged.out);
        assert.doesNotMatch(unchanged.out, /scope: .*defin(?:es|ing) what a gate check runs/, unchanged.out);
      }
      fs.appendFileSync(path.join(d, 'tools/hook.mjs'), '// hook selection changed\n');
      r31aDrift(d, 'tools/hook.mjs');
      fs.writeFileSync(path.join(d, 'tools/hook.mjs'), files['tools/hook.mjs']);
      fs.writeFileSync(pkg, JSON.stringify({ scripts: { ...JSON.parse(files['package.json']).scripts, [hook]: 'node -e 0' } }));
      r31aDrift(d, 'package.json');
      fs.writeFileSync(pkg, JSON.stringify({ scripts: { test: 'node -e 0', unrelated: 'true' } }));
      r31aDrift(d, 'package.json');
    }
    const d = r31aFixture({ 'package.json': '{"scripts":{"test":"node -e 0"}}' }, [{ name: 'test', cmd: ['sh', '-c', `true # ${manager} test`] }]);
    fs.writeFileSync(path.join(d, 'package.json'), '{"scripts":{"test":"node -e 0","pretest":"node -e 0"}}');
    r31aDrift(d, 'package.json');
  }
});

/** @id TEST-CHECK-CLOSURE-004 @verifies REQ-CHECK-CLOSURE-003 */
test('TEST-CHECK-CLOSURE-004 r31a #344 Cargo closure tracks complete ancestor config and toolchains including additions and removals', () => {
  for (const target of ['.cargo/config', '.cargo/config.toml', 'rust-toolchain', 'rust-toolchain.toml', 'workspace/.cargo/config.toml', 'workspace/crate/.cargo/config.toml']) {
    const d = r31aFixture({
      [target]: target.includes('toolchain') ? '# baseline toolchain\n' : '[build]\nrustflags = []\n',
      'workspace/crate/Cargo.toml': '[package]\nname = "fixture"\n',
    }, [], [{ root: 'workspace/crate', checks: [{ name: 'test', cmd: ['sh', '-c', 'true # cargo +stable test'] }] }]);
    fs.appendFileSync(path.join(d, target), '# selection changed\n');
    r31aDrift(d, target);
    const refactor = sdd(d, 'tdd', 'refactor', 'TEST-A-001');
    assert.equal(refactor.code, 0, refactor.out);
    const refreshed = sdd(d, 'gate');
    assert.equal(refreshed.code, 0, refreshed.out);
    fs.rmSync(path.join(d, target));
    r31aDrift(d, target);
  }
  const d = r31aFixture({ 'workspace/crate/Cargo.toml': '[package]\nname = "fixture"\n' }, [], [{ root: 'workspace/crate', checks: [{ name: 'test', cmd: ['sh', '-c', 'true # cargo test'] }] }]);
  fs.mkdirSync(path.join(d, '.cargo'), { recursive: true });
  fs.writeFileSync(path.join(d, '.cargo/config.toml'), '[build]\nrustflags = ["--cfg", "skip_second"]\n[env]\nTEST_FILTER = "one"\n');
  r31aDrift(d, '.cargo/config.toml');
});

/** @id TEST-CHECK-CLOSURE-005 @verifies REQ-CHECK-CLOSURE-001 */
test('TEST-CHECK-CLOSURE-005 r31a #340 changed checks share closure and committed wrapper drift still fails changed gate', () => {
  const d = r31aFixture({ 'tools/changed.sh': 'true\n' }, [{ name: 'test', cmd: PASS, changedCmd: ['sh', 'tools/changed.sh'] }]);
  fs.appendFileSync(path.join(d, 'tools/changed.sh'), '# select fewer tests\n');
  assert.equal(spawnSync('git', ['add', '-A'], { cwd: d }).status, 0);
  assert.equal(spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'committed wrapper drift'], { cwd: d }).status, 0);
  r31aDrift(d, 'tools/changed.sh');
});

test('r31a #340 unchanged committed symlink wrappers are not definition drift', () => {
  const d = r31aFixture({ 'tools/target.sh': 'true\n' }, [{ name: 'test', cmd: ['sh', 'tools/check.sh'] }]);
  fs.symlinkSync('target.sh', path.join(d, 'tools/check.sh'));
  assert.equal(sdd(d, 'tdd', 'refactor', 'TEST-A-001').code, 0);
  assert.equal(spawnSync('git', ['add', '-A'], { cwd: d }).status, 0);
  assert.equal(spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'symlink wrapper baseline'], { cwd: d }).status, 0);
  const clean = sdd(d, 'gate', '--changed');
  assert.equal(clean.code, 0, clean.out);
  assert.doesNotMatch(clean.out, /scope: .*defin(?:es|ing) what a gate check runs/, clean.out);
  fs.appendFileSync(path.join(d, 'tools/target.sh'), '# nested target change\n');
  r31aDrift(d, 'tools/check.sh');
});

test('r31a #344 Cargo definitions above the repo root remain covered by Green snapshots', () => {
  const original = r31aFixture({}, [{ name: 'test', cmd: ['sh', '-c', 'true # cargo test'] }]);
  const parent = fs.mkdtempSync(path.join(work, 'cargo-ancestor-'));
  const d = path.join(parent, 'repo');
  fs.renameSync(original, d);
  fs.mkdirSync(path.join(parent, '.cargo'));
  const target = path.join(parent, '.cargo/config.toml');
  fs.writeFileSync(target, '[build]\nrustflags = []\n');
  const refactor = sdd(d, 'tdd', 'refactor', 'TEST-A-001');
  assert.equal(refactor.code, 0, refactor.out);
  assert.equal(sdd(d, 'gate', '--changed').code, 0);
  fs.appendFileSync(target, '# changed effective ancestor\n');
  r31aDrift(d, '../.cargo/config.toml');
});

test('r31a #340 file-valued interpreter options are part of the command closure', () => {
  const d = r31aFixture({ 'tools/preload.mjs': 'export {};\n' }, [{ name: 'test', cmd: ['node', '--import=./tools/preload.mjs', '-e', '0'] }]);
  fs.appendFileSync(path.join(d, 'tools/preload.mjs'), '// changed selection\n');
  r31aDrift(d, 'tools/preload.mjs');
});

test('r31a #344 Cargo-home configuration is hashed as a complete definition', () => {
  const previous = ENV.CARGO_HOME;
  ENV.CARGO_HOME = '.cargo-home';
  try {
    const d = r31aFixture({ '.cargo-home/config.toml': '[build]\nrustflags = []\n' }, [{ name: 'test', cmd: ['sh', '-c', 'true # cargo test'] }]);
    fs.appendFileSync(path.join(d, '.cargo-home/config.toml'), '[env]\nSELECT = "smoke"\n');
    r31aDrift(d, '.cargo-home/config.toml');
  } finally {
    if (previous === undefined) delete ENV.CARGO_HOME;
    else ENV.CARGO_HOME = previous;
  }
});

test('r31a #340 script-relative nested wrapper imports belong to the same closure', () => {
  const d = r31aFixture({
    'tools/run.mjs': "import './nested.mjs';\n",
    'tools/nested.mjs': 'export {};\n',
  }, [{ name: 'test', cmd: ['node', 'tools/run.mjs'] }]);
  fs.appendFileSync(path.join(d, 'tools/nested.mjs'), '// changed selection\n');
  r31aDrift(d, 'tools/nested.mjs');
});

const r31bPoison = {
  PYTEST_ADDOPTS: '-k passing',
  PYTEST_PLUGINS: 'selector_plugin',
  CARGO_ENCODED_RUSTFLAGS: '--cfg\u001fskip_tests',
  CARGO_BUILD_RUSTFLAGS: '--cfg skip_tests',
  CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_RUNNER: 'true',
  RUSTFLAGS: '--cfg skip_tests',
  RUSTDOCFLAGS: '--cfg skip_tests',
  NODE_OPTIONS: '--no-warnings',
  GOFLAGS: '-tags=skip_tests',
  JAVA_TOOL_OPTIONS: '-DskipTests=true',
  JDK_JAVA_OPTIONS: '-DskipTests=true',
  MAVEN_OPTS: '-DskipTests=true',
  GRADLE_OPTS: '-DskipTests=true',
  SDD_CUSTOM_SELECTOR: 'passing',
};
const r31bRun = (d, env, ...args) => {
  const r = spawnSync('node', [SDD, '--root', d, ...args], { encoding: 'utf8', env: { ...ENV, ...env } });
  return { code: r.status, out: r.stdout + r.stderr };
};

test('#341 inherited runner environment is sanitized for TDD prepare root and project checks', () => {
  const d = mini(T1SPEC, { 'a.test.mjs': jsTest(), 'p/.gitkeep': '' }, FAIL);
  const probe = `import assert from 'node:assert/strict';
for (const key of ${JSON.stringify(Object.keys(r31bPoison))}) assert.equal(process.env[key], undefined, key);
assert.equal(process.env.PATH, ${JSON.stringify(ENV.PATH)});
assert.equal(process.env.HOME, ${JSON.stringify(ENV.HOME)});
`;
  fs.writeFileSync(path.join(d, 'probe.mjs'), probe);
  const red = sdd(d, 'tdd', 'red', 'TEST-A-001');
  assert.equal(red.code, 0, red.out);
  const cp = path.join(d, '.sdd/config.json');
  fs.writeFileSync(cp, JSON.stringify({
    ...JSON.parse(fs.readFileSync(cp, 'utf8')),
    testCmd: ['node', 'probe.mjs'],
    prepare: { cmd: ['node', 'probe.mjs'] },
    checks: [{ name: 'probe', cmd: ['node', 'probe.mjs'], changedCmd: ['node', 'probe.mjs'] }],
    projects: [{ root: 'p', checks: [{ name: 'probe', cmd: ['node', '../probe.mjs'], changedCmd: ['node', '../probe.mjs'] }] }],
  }));
  const green = r31bRun(d, r31bPoison, 'tdd', 'green', 'TEST-A-001');
  assert.equal(green.code, 0, green.out);
  const entry = fs.readFileSync(path.join(d, '.sdd/tdd.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).at(-1);
  assert.ok(entry.runnerEnv.allowlist.includes('PATH'));
  assert.ok(entry.runnerEnv.removed.includes('PYTEST_ADDOPTS'));
  assert.ok(!entry.runnerEnv.allowlist.includes('NODE_OPTIONS'));
  for (const args of [[], ['--changed']]) {
    const result = r31bRun(d, r31bPoison, 'gate', ...args, '--json');
    assert.equal(result.code, 0, result.out);
    const report = JSON.parse(result.out);
    assert.equal(report.verdict, 'PASS');
    assert.ok(report.runnerEnv.allowlist.includes('PATH'));
    assert.ok(report.runnerEnv.removed.includes('SDD_CUSTOM_SELECTOR'));
    assert.ok(report.lines.some((line) => line.includes('cmd p:probe')), result.out);
    assert.ok(!JSON.stringify(report.runnerEnv).includes('selector_plugin'));
  }
});

test('#341 inherited PYTEST_ADDOPTS cannot hide a real pytest regression in full or changed gates', {
  skip: spawnSync('python3', ['-m', 'pytest', '--version']).status !== 0,
}, () => {
  const d = mini(T1SPEC, {
    'pytest.ini': '[pytest]\n',
    'test_a.py': `from pathlib import Path
# @id TEST-A-001 @verifies REQ-A-001
def test_a_001_passing():
    assert True

def test_regression():
    assert not Path(".sdd/regression").exists(), "omitted regression"
`,
  }, ['python3', '-m', 'pytest', '-q', 'test_a.py', '-k', 'test_a_001_passing']);
  const cp = path.join(d, '.sdd/config.json');
  fs.writeFileSync(cp, JSON.stringify({
    ...JSON.parse(fs.readFileSync(cp, 'utf8')), flaky: { retries: 0 },
    checks: [{ name: 'test', cmd: ['python3', '-m', 'pytest', '-q', 'test_a.py'] }],
  }));
  const red = sdd(d, 'tdd', 'red', 'TEST-A-001', '--characterization', 'environment fixture');
  assert.equal(red.code, 0, red.out);
  const green = sdd(d, 'tdd', 'green', 'TEST-A-001');
  assert.equal(green.code, 0, green.out);
  assert.equal(sdd(d, 'gate').code, 0);
  fs.writeFileSync(path.join(d, '.sdd/regression'), 'fail\n');
  for (const args of [[], ['--changed']]) {
    const result = r31bRun(d, { PYTEST_ADDOPTS: '-k test_a_001_passing' }, 'gate', ...args);
    assert.equal(result.code, 1, result.out);
    assert.match(result.out, /✗ cmd test/, result.out);
    assert.match(result.out, /omitted regression/, result.out);
  }
});

test('#341 env prefixes and shell assignments retain runner selection integrity', () => {
  for (const [before, after] of [
    [['env', 'PYTEST_ADDOPTS=', 'python3', '-m', 'pytest'], ['env', 'PYTEST_ADDOPTS=-k one', 'python3', '-m', 'pytest']],
    [['/usr/bin/env', '-i', '--', 'cargo', 'test'], ['/usr/bin/env', '-i', '--', 'cargo', 'test', 'one']],
    [['env', '-u', 'NODE_OPTIONS', 'node', '--test'], ['env', '-u', 'NODE_OPTIONS', 'node', '--test', '--test-name-pattern=one']],
    [['sh', '-c', "PYTEST_ADDOPTS='' python3 -m pytest"], ['sh', '-c', "PYTEST_ADDOPTS='-k one' python3 -m pytest"]],
    [['sh', '-lc', 'env CI=1 npm test'], ['sh', '-lc', 'env CI=1 npm test -- --grep one']],
    [['env', 'CI=1', 'sh', '-c', 'go test ./...'], ['env', 'CI=1', 'sh', '-c', 'go test ./... -run One']],
  ]) {
    for (const location of ['root check', 'root testCmd', 'root changedCmd', 'project check', 'project testCmd', 'project changedCmd']) {
      const scope = (cmd) => location.endsWith('check') ? { checks: [{ name: 'test', cmd, changedCmd: cmd }] } : { [location.split(' ')[1]]: cmd };
      const config = (cmd) => location.startsWith('project') ? { projects: [{ root: 'p', ...scope(cmd) }] } : scope(cmd);
      const d = r28b({ scopePolicy: 'strict', ...config(before) }, config(after));
      for (const args of [['--no-run'], ['--changed', '--baseline', 'HEAD', '--no-run']]) {
        const result = sdd(d, 'gate', ...args);
        assert.equal(result.code, 1, `${location}: ${result.out}`);
        assert.match(result.out, /✗ config: .*runner arguments\/selection changed/, result.out);
      }
      const acknowledged = sdd(d, 'gate', '--no-run', '--allow-config-weaken');
      assert.match(acknowledged.out, /accepted by --allow-config-weaken/, acknowledged.out);
      assert.doesNotMatch(acknowledged.out, /✗ config:/, acknowledged.out);
    }
  }
  const cmd = ['env', 'PYTEST_ADDOPTS=', 'python3', '-m', 'pytest'];
  const unchanged = r28b({ scopePolicy: 'strict', checks: [{ name: 'test', cmd }] }, {});
  assert.doesNotMatch(sdd(unchanged, 'gate', '--no-run').out, /config:/);
  const warning = r28b({ scopePolicy: 'warn', checks: [{ name: 'test', cmd }] }, {
    checks: [{ name: 'test', cmd: ['env', 'PYTEST_ADDOPTS=-k one', 'python3', '-m', 'pytest'] }],
  });
  assert.match(sdd(warning, 'gate', '--no-run').out, /! config: .*runner arguments\/selection changed/);
});

test('#341 extended env options cannot obscure runner selection changes', () => {
  for (const before of [
    ['env', '--ignore-environment', '--unset=NODE_OPTIONS', '--chdir=.', 'node', '--test'],
    ['env', '-C', '.', '--unset', 'NODE_OPTIONS', 'node', '--test'],
    ['env', '-S', 'node --test'],
    ['env', '--split-string', 'node --test'],
    ['env', '--split-string=node --test'],
  ]) {
    const after = [...before, '--test-name-pattern=one'];
    const d = r28b({ scopePolicy: 'strict', checks: [{ name: 'test', cmd: before }] }, {
      checks: [{ name: 'test', cmd: after }],
    });
    const result = sdd(d, 'gate', '--no-run');
    assert.match(result.out, /✗ config: .*runner arguments\/selection changed/, result.out);
  }
});

test('#341 explicit PYTEST_ADDOPTS prefix requires review before hiding a real regression', {
  skip: spawnSync('python3', ['-m', 'pytest', '--version']).status !== 0,
}, () => {
  const before = ['env', 'PYTEST_ADDOPTS=', 'python3', '-m', 'pytest', '-q', 'test_a.py'];
  const d = mini(T1SPEC, {
    'pytest.ini': '[pytest]\n',
    'test_a.py': `from pathlib import Path
# @id TEST-A-001 @verifies REQ-A-001
def test_a_001_passing():
    assert True

def test_regression():
    assert not Path(".sdd/regression").exists(), "omitted regression"
`,
  }, ['python3', '-m', 'pytest', '-q', 'test_a.py', '-k', 'test_a_001_passing']);
  const cp = path.join(d, '.sdd/config.json');
  const config = {
    ...JSON.parse(fs.readFileSync(cp, 'utf8')), scopePolicy: 'strict', flaky: { retries: 0 },
    checks: [{ name: 'test', cmd: before }],
  };
  fs.writeFileSync(cp, JSON.stringify(config));
  assert.equal(sdd(d, 'tdd', 'red', 'TEST-A-001', '--characterization', 'env prefix fixture').code, 0);
  assert.equal(sdd(d, 'tdd', 'green', 'TEST-A-001').code, 0);
  assert.equal(sdd(d, 'gate').code, 0);
  assert.equal(spawnSync('git', ['add', '-A'], { cwd: d }).status, 0);
  assert.equal(spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'baseline'], { cwd: d }).status, 0);
  fs.writeFileSync(path.join(d, '.sdd/regression'), 'fail\n');
  fs.writeFileSync(cp, JSON.stringify({
    ...config, checks: [{ name: 'test', cmd: ['env', 'PYTEST_ADDOPTS=-k test_a_001_passing', ...before.slice(2)] }],
  }));
  for (const args of [[], ['--changed', '--baseline', 'HEAD']]) {
    const result = sdd(d, 'gate', ...args);
    assert.equal(result.code, 1, result.out);
    assert.match(result.out, /✗ config: .*runner arguments\/selection changed/, result.out);
    const acknowledged = sdd(d, 'gate', ...args, '--allow-config-weaken');
    assert.equal(acknowledged.code, 0, acknowledged.out);
    assert.match(acknowledged.out, /accepted by --allow-config-weaken/, acknowledged.out);
  }
});

function r31cVerifiedProject(extra = {}) {
  const d = mini(T1SPEC, {
    'value.mjs': '// @id CODE-A-001 @implements REQ-A-001\nexport const value = 0;\n',
    'a.test.mjs': "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { value } from './value.mjs';\n// @id TEST-A-001 @verifies REQ-A-001\ntest('TEST-A-001 value', () => assert.equal(value, 1));\n",
  });
  fs.writeFileSync(path.join(d, '.sdd/config.json'), JSON.stringify({
    testCmd: ['node', '--test', '--test-name-pattern={id}', '{file}'],
    checks: [{ name: 'test', cmd: ['node', '--test', 'a.test.mjs'] }],
    flaky: { retries: 0 },
    ...extra,
  }));
  const red = sdd(d, 'tdd', 'red', 'TEST-A-001');
  assert.equal(red.code, 0, red.out);
  fs.writeFileSync(path.join(d, 'value.mjs'), '// @id CODE-A-001 @implements REQ-A-001\nexport const value = 1;\n');
  const green = sdd(d, 'tdd', 'green', 'TEST-A-001');
  assert.equal(green.code, 0, green.out);
  return d;
}

const r31cMutation = "const f=require('fs');f.writeFileSync('value.mjs',f.readFileSync('value.mjs','utf8').replace('value = 1','value = 0'));f.writeFileSync('a.test.mjs',f.readFileSync('a.test.mjs','utf8').replace('assert.equal(value, 1)','assert.ok(true)'));";

test('r31c #342 prepare cannot rewrite validated tests even when declared as outputs', () => {
  for (const args of [[], ['--changed']]) {
    const d = r31cVerifiedProject({
      prepare: { cmd: ['node', '-e', r31cMutation], outputs: ['a.test.mjs'] },
    });
    const r = sdd(d, 'gate', ...args);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /gate inputs changed.*prepare.*a\.test\.mjs/, r.out);
    assert.doesNotMatch(r.out, /SDD GATE PASS/);
    assert.equal(fs.existsSync(path.join(d, '.sdd/prepare-cache.json')), false, 'mutating preparation must not be cached');
  }
});

test('r31c #342 checks cannot mutate validated tests specs ledger or policy inputs', () => {
  for (const target of ['a.test.mjs', '.sdd/specs/a.md', '.sdd/tdd.jsonl', '.sdd/config.json', '.sdd/approvals.json', '.sdd/retired-reqs.json', '.sdd/trace-baseline.json']) {
    const d = r31cVerifiedProject({
      checks: [{ name: 'probe', cmd: ['node', '-e', `require('fs').appendFileSync(${JSON.stringify(target)}, '\\n');`] }],
    });
    const r = sdd(d, 'gate');
    assert.equal(r.code, 1, `${target}: ${r.out}`);
    assert.match(r.out, /gate inputs changed.*check probe/, r.out);
    assert.ok(r.out.includes(target), r.out);
  }
});

test('r31c #342 deleted evidence inputs and newly annotated files cannot keep PASS', () => {
  for (const script of [
    "require('fs').unlinkSync('a.test.mjs');",
    "require('fs').unlinkSync('.sdd/tdd.jsonl');",
    "require('fs').writeFileSync('.sdd/specs/new.md','---\\nfeature: new\\ntier: T1\\n---\\n');",
    "require('fs').writeFileSync('new.test.mjs','// @id TEST-A-002 @verifies REQ-A-001\\n');",
  ]) {
    const d = r31cVerifiedProject({ checks: [{ name: 'probe', cmd: ['node', '-e', script] }] });
    const r = sdd(d, 'gate', '--changed');
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /gate inputs changed.*check probe/, r.out);
  }
});

test('r31c #342 gate detects oracle changes despite an unchanged annotated test', () => {
  const d = r31cVerifiedProject();
  fs.writeFileSync(path.join(d, 'oracle.json'), '1');
  fs.appendFileSync(path.join(d, 'a.test.mjs'), "\nimport { readFileSync } from 'node:fs';\nconst expected = JSON.parse(readFileSync('oracle.json', 'utf8'));\n");
  const cfg = JSON.parse(fs.readFileSync(path.join(d, '.sdd/config.json'), 'utf8'));
  cfg.oracleData = ['oracle.json'];
  cfg.checks = [{ name: 'probe', cmd: ['node', '-e', "require('fs').writeFileSync('oracle.json','2');"] }];
  fs.writeFileSync(path.join(d, '.sdd/config.json'), JSON.stringify(cfg));
  fs.writeFileSync(path.join(d, 'value.mjs'), '// @id CODE-A-001 @implements REQ-A-001\nexport const value = 0;\n');
  assert.equal(sdd(d, 'tdd', 'red', 'TEST-A-001').code, 0);
  fs.writeFileSync(path.join(d, 'value.mjs'), '// @id CODE-A-001 @implements REQ-A-001\nexport const value = 1;\n');
  assert.equal(sdd(d, 'tdd', 'green', 'TEST-A-001').code, 0);
  const r = sdd(d, 'gate');
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /gate inputs changed.*oracle\.json/, r.out);
});

test('r31c #342 mutations are rejected before a later check can restore the test', () => {
  const d = r31cVerifiedProject({
    checks: [
      { name: 'mutate', cmd: ['node', '-e', "const f=require('fs');f.copyFileSync('a.test.mjs','saved.txt');f.appendFileSync('a.test.mjs','\\n// changed\\n');"] },
      { name: 'restore', cmd: ['node', '-e', "const f=require('fs');f.copyFileSync('saved.txt','a.test.mjs');f.writeFileSync('restored.txt','yes');"] },
    ],
  });
  const r = sdd(d, 'gate');
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /gate inputs changed.*check mutate/, r.out);
  assert.equal(fs.existsSync(path.join(d, 'restored.txt')), false);
});

test('r31c #342 test retries cannot normalize a mutated validated test', () => {
  const d = r31cVerifiedProject({
    flaky: { retries: 1, policy: 'warn' },
    checks: [{ name: 'test', cmd: ['node', '-e', "const f=require('fs');if(!f.existsSync('retry.txt')){f.copyFileSync('a.test.mjs','saved.txt');f.appendFileSync('a.test.mjs','\\n// changed\\n');f.writeFileSync('retry.txt','first');console.log('AssertionError: first');process.exit(1);}f.copyFileSync('saved.txt','a.test.mjs');"] }],
  });
  const before = fs.readFileSync(path.join(d, '.sdd/tdd.jsonl'), 'utf8');
  const r = sdd(d, 'gate');
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /gate inputs changed.*check test/, r.out);
  assert.doesNotMatch(r.out, /FLAKY suspected/);
  assert.equal(fs.readFileSync(path.join(d, '.sdd/tdd.jsonl'), 'utf8'), before);
});

test('r31c #342 declared generated outputs and cached preparation remain valid', () => {
  const d = r31cVerifiedProject({
    generated: ['dist/**'],
    prepare: {
      inputs: ['value.mjs'],
      outputs: ['dist'],
      cmd: ['node', '-e', "const f=require('fs');f.mkdirSync('dist',{recursive:true});f.writeFileSync('dist/value.json','1');f.appendFileSync('build-count.txt','1');"],
    },
  });
  for (let i = 0; i < 2; i++) {
    const r = sdd(d, 'gate');
    assert.equal(r.code, 0, r.out);
    if (i) assert.match(r.out, /prepare: up to date/, r.out);
  }
  assert.equal(fs.readFileSync(path.join(d, 'build-count.txt'), 'utf8'), '1');
});

test('r31c #342 gate-owned flaky ledger appends do not count as input tampering', () => {
  const d = r31cVerifiedProject({
    flaky: { retries: 1, policy: 'warn' },
    checks: [
      { name: 'test', cmd: ['node', '-e', "const f=require('fs');if(!f.existsSync('retry.txt')){f.writeFileSync('retry.txt','first');console.log('AssertionError: first');process.exit(1);}console.log('Tests 1 passed (1)');"] },
      { name: 'after', cmd: PASS },
    ],
  });
  const r = sdd(d, 'gate');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /FLAKY suspected/, r.out);
  assert.doesNotMatch(r.out, /gate inputs changed/);
  const entries = fs.readFileSync(path.join(d, '.sdd/tdd.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(entries.at(-1).type, 'flaky');
});

test('r31c #342 scoped and full fallback executions each protect validated inputs', () => {
  for (const mutateScoped of [true, false]) {
    const mutate = "require('fs').appendFileSync('a.test.mjs','\\n// mutated\\n');";
    const d = r31cVerifiedProject({
      checks: [{
        name: 'probe',
        changedCmd: ['node', '-e', `${mutateScoped ? mutate : ''}console.log('No tests found');`],
        cmd: ['node', '-e', `${mutateScoped ? "require('fs').writeFileSync('unexpected-fallback.txt','ran');" : mutate}`],
      }],
    });
    const r = sdd(d, 'gate', '--changed');
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /gate inputs changed.*check probe/, r.out);
    if (mutateScoped) assert.equal(fs.existsSync(path.join(d, 'unexpected-fallback.txt')), false);
    else assert.match(r.out, /gate inputs changed.*full fallback/, r.out);
  }
});

test('r31c #342 a passing retry that mutates inputs cannot append flaky evidence', () => {
  const d = r31cVerifiedProject({
    flaky: { retries: 1, policy: 'warn' },
    checks: [{ name: 'test', cmd: ['node', '-e', "const f=require('fs');if(!f.existsSync('retry.txt')){f.writeFileSync('retry.txt','first');console.log('AssertionError: first');process.exit(1);}f.appendFileSync('a.test.mjs','\\n// mutated\\n');"] }],
  });
  const before = fs.readFileSync(path.join(d, '.sdd/tdd.jsonl'), 'utf8');
  const r = sdd(d, 'gate');
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /gate inputs changed.*check test retry 1/, r.out);
  assert.equal(fs.readFileSync(path.join(d, '.sdd/tdd.jsonl'), 'utf8'), before);
});

test('r31c #342 local command wrappers and imported helpers share the protected closure', () => {
  for (const stage of ['prepare', 'check']) {
    const command = ['node', 'checks/run.mjs'];
    const d = r31cVerifiedProject(stage === 'prepare'
      ? { prepare: { cmd: command } }
      : { checks: [{ name: 'probe', cmd: command }] });
    fs.mkdirSync(path.join(d, 'checks'));
    fs.writeFileSync(path.join(d, 'checks/helper.mjs'), 'export const value = 1;\n');
    fs.writeFileSync(path.join(d, 'checks/run.mjs'), "import './helper.mjs';\nimport fs from 'node:fs';\nfs.writeFileSync('checks/helper.mjs','export const value = 0;\\n');\n");
    const r = sdd(d, 'gate');
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /gate inputs changed.*checks\/helper\.mjs/, r.out);
  }
});

test('r31c #342 declared oracle outputs may be regenerated without exempting evidence', () => {
  const d = r31cVerifiedProject({
    oracleData: ['output.json'],
    prepare: {
      outputs: ['output.json'],
      cmd: ['node', '-e', "require('fs').writeFileSync('output.json','1');"],
    },
  });
  const r = sdd(d, 'gate');
  assert.equal(r.code, 0, r.out);
  assert.equal(fs.readFileSync(path.join(d, 'output.json'), 'utf8'), '1');
  assert.doesNotMatch(r.out, /gate inputs changed/);
});

test('r31c #342 test command imports retain declared generated-output exemptions', () => {
  const d = r31cVerifiedProject({
    generated: ['dist/**'],
    prepare: { outputs: ['dist'], cmd: ['node', '-e', "require('fs').writeFileSync('dist/generated.mjs','export const built = 2;\\n');"] },
  });
  fs.mkdirSync(path.join(d, 'dist'));
  fs.writeFileSync(path.join(d, 'dist/generated.mjs'), 'export const built = 1;\n');
  fs.appendFileSync(path.join(d, 'a.test.mjs'), "\nimport { built } from './dist/generated.mjs';\n");
  fs.writeFileSync(path.join(d, 'value.mjs'), '// @id CODE-A-001 @implements REQ-A-001\nexport const value = 0;\n');
  assert.equal(sdd(d, 'tdd', 'red', 'TEST-A-001').code, 0);
  fs.writeFileSync(path.join(d, 'value.mjs'), '// @id CODE-A-001 @implements REQ-A-001\nexport const value = 1;\n');
  assert.equal(sdd(d, 'tdd', 'green', 'TEST-A-001').code, 0);
  const r = sdd(d, 'gate');
  assert.equal(r.code, 0, r.out);
  assert.match(fs.readFileSync(path.join(d, 'dist/generated.mjs'), 'utf8'), /built = 2/);
});

function r31dLedgerFixture() {
  const fixture = r24dRedGreen();
  const cp = path.join(fixture.d, '.sdd/config.json');
  const cfg = JSON.parse(fs.readFileSync(cp, 'utf8'));
  cfg.checks = [{ name: 'test', cmd: ['node', '--test', '--test-name-pattern=TEST-CALC-001', 'add.test.mjs'] }];
  fs.writeFileSync(cp, JSON.stringify(cfg));
  const baseline = sdd(fixture.d, 'gate');
  assert.equal(baseline.code, 0, baseline.out);
  return fixture;
}

for (const [name, mutate] of [
  ['Green exit 9', (red, green) => [red, { ...green, exit: 9 }]],
  ['Refactor exit 9', (red, green) => [red, green, { ...green, type: 'refactor', exit: 9 }]],
  ['passing ordinary Red', (red, green) => [{ ...red, exit: 0 }, green]],
  ['passing weak Red without an exception', (red, green) => [{ ...red, exit: 0, weak: true }, green]],
  ['missing Green exit', (red, green) => { delete green.exit; return [red, green]; }],
  ['missing Red exit', (red, green) => { delete red.exit; return [red, green]; }],
  ...['test', 'req', 'file', 'fileSha', 'cmdSha', 'ms', 'at', 'v'].map((field) =>
    [`missing ${field}`, (red, green) => { delete green[field]; return [red, green]; }]),
  ['invalid timestamp', (red, green) => [red, { ...green, at: 'not-a-date' }]],
  ['backwards timestamp', (red, green) => [red, { ...green, at: new Date(Date.parse(red.at) - 1).toISOString() }]],
  ['string exit', (red, green) => [red, { ...green, exit: '0' }]],
  ['negative exit', (red, green) => [{ ...red, exit: -1 }, green]],
  ['negative duration', (red, green) => [red, { ...green, ms: -1 }]],
  ['unknown event type', (red, green) => [red, green, { ...green, type: 'success' }]],
]) {
  test(`r31d #345 ledger rejects ${name}`, () => {
    const { d, red, green, write } = r31dLedgerFixture();
    write(mutate(red, green));
    for (const args of [['tdd', 'check'], ['gate'], ['gate', '--changed']]) {
      const result = sdd(d, ...args);
      assert.equal(result.code, 1, `${name}: ${result.out}`);
      assert.match(result.out, /(?:LEDGER FAIL:|✗ ledger:).*invalid.*seq/i, result.out);
    }
  });
}

for (const seq of [1, 3, '2']) {
  test(`r31d #345 ledger rejects sequence ${JSON.stringify(seq)}`, () => {
    const { d, red, green } = r31dLedgerFixture();
    const e = { ...green, seq, prev: red.hash };
    delete e.hash;
    e.hash = createHash('sha256').update(JSON.stringify(e)).digest('hex');
    fs.writeFileSync(path.join(d, '.sdd/tdd.jsonl'), [red, e].map(JSON.stringify).join('\n') + '\n');
    const result = sdd(d, 'tdd', 'check');
    assert.equal(result.code, 1, result.out);
    assert.match(result.out, /LEDGER FAIL:.*invalid.*seq/i, result.out);
  });
}

test('r31d #345 ledger permits explicit passing Red exceptions and equal timestamps', () => {
  const { d, red, green, write } = r31dLedgerFixture();
  for (const exception of [
    { weak: true, characterization: 'existing golden', weakWhy: 'characterization' },
    { weak: true, retest: 'corrected expectation', weakWhy: 'retest' },
    { rebaselined: true, retest: 'regenerated oracle' },
  ]) {
    write([{ ...red, exit: 0, ...exception }, { ...green, at: red.at }]);
    const checked = sdd(d, 'tdd', 'check');
    assert.equal(checked.code, 0, checked.out);
    const gate = sdd(d, 'gate');
    assert.equal(gate.code, 0, gate.out);
    assert.match(gate.out, /1\/1 tests Red→Green/, gate.out);
  }
});

test('r31d #345 selected passing test records zero outcome and preserves failing runner status', () => {
  const d = approved();
  const summary = (row) => `Test Summary: | Pass  Fail  Total  Time\n${row}\n`;
  fakeOut(d, summary('TEST-CALC-001 |    0     1      1  0.1s'));
  const red = sdd(d, 'tdd', 'red', 'TEST-CALC-001');
  assert.equal(red.code, 0, red.out);
  fakeOut(d, summary('TEST-CALC-001 |    1            1  0.1s\nTEST-OTHER-001 |    0     1      1  0.1s'));
  for (const sub of ['green', 'refactor']) {
    const result = sdd(d, 'tdd', sub, 'TEST-CALC-001');
    assert.equal(result.code, 0, result.out);
    const entry = r24dLedger(d).at(-1);
    assert.equal(entry.exit, 0);
    assert.equal(entry.runnerExit, 1);
    const checked = sdd(d, 'tdd', 'check');
    assert.equal(checked.code, 0, checked.out);
  }
});

test('r31d #345 merge-ledger orders an older branch event before its preserved prefix', () => {
  const { d, red, green } = r31dLedgerFixture();
  const older = { v: 1, type: 'flaky', check: 'test', retry: 1, retries: 1, policy: 'warn', outcome: 'accepted', at: new Date(Date.parse(red.at) - 1).toISOString() };
  const lp = path.join(d, '.sdd/tdd.jsonl');
  fs.writeFileSync(lp, `${r24dChain([red, green])}${r24dChain([red, older])}`);
  const merged = sdd(d, 'tdd', 'merge-ledger');
  assert.equal(merged.code, 0, merged.out);
  const entries = r24dLedger(d);
  assert.deepEqual(entries.map((e) => e.type), ['flaky', 'red', 'green']);
  const checked = sdd(d, 'tdd', 'check');
  assert.equal(checked.code, 0, checked.out);
  const once = fs.readFileSync(lp, 'utf8');
  assert.equal(sdd(d, 'tdd', 'merge-ledger').code, 0);
  assert.equal(fs.readFileSync(lp, 'utf8'), once);
});

for (const args of [['gate'], ['gate', '--changed'], ['gate', '--changed', '--baseline', 'HEAD'], ['tdd', 'check']]) {
  test(`r31d #346 missing committed ledger fails ${args.join(' ')}`, () => {
    const { d } = r31dLedgerFixture();
    const lp = path.join(d, '.sdd/tdd.jsonl');
    assert.equal(spawnSync('git', ['add', '-A'], { cwd: d }).status, 0);
    assert.equal(spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'ledger baseline'], { cwd: d }).status, 0);
    const count = r24dLedger(d).length;
    fs.unlinkSync(lp);
    const result = sdd(d, ...args);
    assert.equal(result.code, 1, result.out);
    assert.match(result.out, new RegExp(`${count} ledger entries of HEAD removed or modified.*tdd\\.jsonl`), result.out);
  });
}

test('r31d #346 missing ledger is compared with an explicit non-HEAD baseline', () => {
  const { d } = r31dLedgerFixture();
  const lp = path.join(d, '.sdd/tdd.jsonl');
  assert.equal(spawnSync('git', ['add', '-A'], { cwd: d }).status, 0);
  assert.equal(spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'ledger baseline'], { cwd: d }).status, 0);
  assert.equal(spawnSync('git', ['tag', 'ledger-baseline'], { cwd: d }).status, 0);
  fs.unlinkSync(lp);
  assert.equal(spawnSync('git', ['add', '-A'], { cwd: d }).status, 0);
  assert.equal(spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'remove ledger'], { cwd: d }).status, 0);
  const result = sdd(d, 'gate', '--changed', '--baseline', 'ledger-baseline');
  assert.equal(result.code, 1, result.out);
  assert.match(result.out, /ledger entries of ledger-baseline removed or modified.*tdd\.jsonl/, result.out);
});

test('r31d #346 absent never-committed and empty baseline ledgers are not regressions', () => {
  const d = mini(T1SPEC);
  const lp = path.join(d, '.sdd/tdd.jsonl');
  for (const committedEmpty of [false, true]) {
    if (committedEmpty) {
      fs.writeFileSync(lp, '');
      assert.equal(spawnSync('git', ['add', '-A'], { cwd: d }).status, 0);
      assert.equal(spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'empty ledger'], { cwd: d }).status, 0);
      fs.unlinkSync(lp);
    }
    const result = sdd(d, 'tdd', 'check');
    assert.equal(result.code, 0, result.out);
    assert.match(result.out, /LEDGER OK \(0 entries\)/);
  }
});

test('r31d #345 malformed auxiliary events cannot hide behind a valid chain', () => {
  const { d, red, green, write } = r31dLedgerFixture();
  for (const event of [
    { type: 'approval', feature: 'calc' },
    { type: 'flaky', check: 'test', retry: 1, retries: 1, policy: 'fail', outcome: 'accepted' },
    { type: 'scope-waiver', globs: ['build/**'] },
  ]) {
    write([red, green, { v: 1, at: green.at, ...event }]);
    const result = sdd(d, 'tdd', 'check');
    assert.equal(result.code, 1, result.out);
    assert.match(result.out, /LEDGER FAIL:.*invalid.*seq/i, result.out);
  }
});

test('r31d #345 non-object JSON ledger rows fail cleanly instead of throwing', () => {
  const { d } = r31dLedgerFixture();
  const lp = path.join(d, '.sdd/tdd.jsonl');
  for (const entry of [null, [], 1, 'event']) {
    fs.writeFileSync(lp, JSON.stringify(entry) + '\n');
    for (const args of [['tdd', 'check'], ['gate'], ['gate', '--changed']]) {
      const result = sdd(d, ...args);
      assert.equal(result.code, 2, result.out);
      assert.match(result.out, /LEDGER CORRUPT:.*line 1.*object/, result.out);
      assert.doesNotMatch(result.out, /TypeError|at verifyChain/, result.out);
    }
  }
});

test('r31d #345 merge-ledger preserves Red-before-Green when timestamps are equal', () => {
  const { d, red, green } = r31dLedgerFixture();
  const older = { v: 1, type: 'scope-waiver', globs: ['build/**'], files: ['build/output.txt'], at: new Date(Date.parse(red.at) - 1).toISOString() };
  fs.writeFileSync(path.join(d, '.sdd/tdd.jsonl'), `${r24dChain([red, { ...green, at: red.at }])}${r24dChain([older])}`);
  const merged = sdd(d, 'tdd', 'merge-ledger');
  assert.equal(merged.code, 0, merged.out);
  assert.deepEqual(r24dLedger(d).map((e) => e.type), ['scope-waiver', 'red', 'green']);
  const result = sdd(d, 'gate');
  assert.equal(result.code, 0, result.out);
  assert.match(result.out, /1\/1 tests Red→Green/, result.out);
});

function r32aLargeLedgerFixture() {
  const fixture = r31dLedgerFixture();
  const events = r24dLedger(fixture.d);
  const audit = { v: 1, type: 'scope-waiver', globs: ['archive/**'], files: ['archive/tail.json'], at: events.at(-1).at };
  events.push({ ...audit, files: [`archive/${'x'.repeat(3 * 1024 * 1024)}.json`] }, audit);
  fixture.write(events);
  assert.equal(spawnSync('git', ['add', '-A'], { cwd: fixture.d }).status, 0);
  assert.equal(spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'large ledger baseline'], { cwd: fixture.d }).status, 0);
  return { ...fixture, events };
}

for (const args of [['tdd', 'check'], ['gate'], ['gate', '--changed'], ['gate', '--changed', '--baseline', 'HEAD']]) {
  test(`r32a #347 large committed ledger rejects tail removal in ${args.join(' ')}`, () => {
    const { d, events, write } = r32aLargeLedgerFixture();
    write(events.slice(0, -1));
    const result = sdd(d, ...args);
    assert.equal(result.code, 1, result.out);
    assert.match(result.out, /1 ledger entry of HEAD removed or modified/, result.out);
    write(events);
    const intact = sdd(d, ...args);
    assert.equal(intact.code, 0, intact.out);
    write([...events, { ...events.at(-1), files: ['archive/appended.json'] }]);
    const appended = sdd(d, ...args);
    assert.equal(appended.code, 0, appended.out);
  });
}

test('r32a #347 large ledger rejects whole-file deletion and rewritten re-chained events', () => {
  const { d, events, write } = r32aLargeLedgerFixture();
  fs.unlinkSync(path.join(d, '.sdd/tdd.jsonl'));
  const deleted = sdd(d, 'tdd', 'check');
  assert.equal(deleted.code, 1, deleted.out);
  assert.match(deleted.out, /ledger entries of HEAD removed or modified/, deleted.out);
  write(events.map((e, i) => i === events.length - 2 ? { ...e, files: ['archive/rewritten.json'] } : e));
  const rewritten = sdd(d, 'gate');
  assert.equal(rewritten.code, 1, rewritten.out);
  assert.match(rewritten.out, /1 ledger entry of HEAD removed or modified/, rewritten.out);
});

test('r32a #347 large explicit baseline rejects deletion after HEAD no longer contains the ledger', () => {
  const { d, events, write } = r32aLargeLedgerFixture();
  assert.equal(spawnSync('git', ['tag', 'large-baseline'], { cwd: d }).status, 0);
  fs.unlinkSync(path.join(d, '.sdd/tdd.jsonl'));
  assert.equal(spawnSync('git', ['add', '-A'], { cwd: d }).status, 0);
  assert.equal(spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'ledger removed'], { cwd: d }).status, 0);
  write(events.slice(0, -1));
  const result = sdd(d, 'gate', '--changed', '--baseline', 'large-baseline');
  assert.equal(result.code, 1, result.out);
  assert.match(result.out, /1 ledger entry of large-baseline removed or modified/, result.out);
});

for (const [name, fault] of [
  ['oversized capture', "{ status: null, error: Object.assign(new Error('capture limit'), { code: 'ENOBUFS' }), stdout: '', stderr: '' }"],
  ['nonzero read', "{ status: 128, stdout: '', stderr: 'fatal: cannot read ledger object' }"],
  ['partial successful capture with error', "{ status: 0, error: Object.assign(new Error('capture limit'), { code: 'ENOBUFS' }), stdout: '', stderr: '' }"],
  ['signal during read', "{ status: null, signal: 'SIGTERM', stdout: '', stderr: '' }"],
]) {
  test(`r32a #347 committed ledger fails closed on ${name}`, () => {
    const { d } = r31dLedgerFixture();
    assert.equal(spawnSync('git', ['add', '-A'], { cwd: d }).status, 0);
    assert.equal(spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'ledger baseline'], { cwd: d }).status, 0);
    const preload = path.join(d, 'ledger-read-fault.cjs');
    fs.writeFileSync(preload, `const cp = require('node:child_process');
const real = cp.spawnSync;
cp.spawnSync = (cmd, args, opts) => cmd === 'git' && args[0] === 'show' && args[1]?.endsWith(':./.sdd/tdd.jsonl') ? ${fault} : real(cmd, args, opts);
require('node:module').syncBuiltinESMExports();
`);
    for (const args of [['tdd', 'check'], ['gate'], ['gate', '--changed'], ['tdd', 'refactor', 'TEST-CALC-001']]) {
      const before = fs.readFileSync(path.join(d, '.sdd/tdd.jsonl'), 'utf8');
      const result = spawnSync('node', ['--require', preload, SDD, '--root', d, ...args], { encoding: 'utf8', env: ENV });
      const output = result.stdout + result.stderr;
      assert.equal(result.status, 1, output);
      assert.match(output, /cannot read .*ledger.*HEAD|cannot read .*HEAD.*ledger/i, output);
      assert.doesNotMatch(output, /SDD GATE PASS|LEDGER OK|REFACTOR RECORDED/, output);
      assert.equal(fs.readFileSync(path.join(d, '.sdd/tdd.jsonl'), 'utf8'), before);
    }
  });
}

test('r32a #347 invalid explicit baseline cannot silently disable ledger comparison', () => {
  const { d } = r31dLedgerFixture();
  const result = sdd(d, 'gate', '--baseline', 'missing-baseline');
  assert.equal(result.code, 1, result.out);
  assert.match(result.out, /cannot read .*ledger.*missing-baseline|cannot read .*missing-baseline.*ledger/i, result.out);
});

for (const target of ['Cargo.toml', 'crates/core/Cargo.toml', 'crates/core/build.rs', 'crates/core/custom-build.rs']) {
  test(`r32b #348 Cargo admission closure locks ${target}`, () => {
    const d = r31aFixture({
      'Cargo.toml': '[workspace]\nmembers=["crates/core"]\nresolver="2"\n',
      'crates/core/Cargo.toml': '[package]\nname="core"\nversion="0.1.0"\nbuild="custom-build.rs"\n[features]\ndefault=["verified"]\nverified=[]\n',
      'crates/core/build.rs': 'fn main() {}\n',
      'crates/core/custom-build.rs': 'fn main() { println!("cargo:rustc-cfg=verified"); }\n',
    }, [{ name: 'test', cmd: ['sh', '-c', 'true # cargo test --workspace'] }]);
    fs.appendFileSync(path.join(d, target), target.endsWith('.rs') ? '// cfg changed\n' : '# admission changed\n');
    r31aDrift(d, target);
  });
}

for (const [cmd, files, target] of [
  [['tsc', '--noEmit'], { 'tsconfig.json': '{"include":["src/**","types/**"]}' }, 'tsconfig.json'],
  [['tsc', '-p', 'config/check.json'], { 'config/check.json': '{"extends":"../base.json"}', 'base.json': '{"exclude":[]}' }, 'base.json'],
  [['tsc', '--project=config/check.json'], { 'config/check.json': '{"extends":["../one.json","../two.json"]}', 'one.json': '{}', 'two.json': '{"include":["types/**"]}' }, 'two.json'],
  [['tsc', '-b', 'config/check.json'], { 'config/check.json': '{"references":[{"path":"../types"}]}', 'types/tsconfig.json': '{"include":["**/*.ts"]}' }, 'types/tsconfig.json'],
  [['tsc', '--noEmit'], { 'tsconfig.json': '{"extends":"@fixture/config"}', 'node_modules/@fixture/config/package.json': '{"tsconfig":"base.json"}', 'node_modules/@fixture/config/base.json': '{"include":["types/**"]}' }, 'node_modules/@fixture/config/base.json'],
  [['tsc', '--noEmit'], { 'tsconfig.json': '// comment\n{"extends":"./base",}', 'base.json': '{"include":["types/**"],}' }, 'base.json'],
]) {
  test(`r32b #352 TypeScript admission closure locks ${target} via ${cmd.join(' ')}`, () => {
    const d = r31aFixture(files, [{ name: 'typecheck', cmd: ['sh', '-c', `true # ${cmd.join(' ')}`] }]);
    fs.appendFileSync(path.join(d, target), '\n// selection changed\n');
    r31aDrift(d, target);
  });
}

test('r32b #352 TypeScript closure tracks additions removals and project cwd through npm', () => {
  const d = r31aFixture({
    'app/package.json': '{"scripts":{"typecheck":"tsc --noEmit"}}',
    'app/tsconfig.json': '{"extends":"../base.json"}',
    'base.json': '{}',
  }, [], [{ root: 'app', checks: [{ name: 'typecheck', cmd: ['sh', '-c', 'true # npm run typecheck'] }] }]);
  fs.unlinkSync(path.join(d, 'base.json'));
  r31aDrift(d, 'base.json');
  assert.equal(sdd(d, 'tdd', 'refactor', 'TEST-A-001').code, 0);
  fs.writeFileSync(path.join(d, 'base.json'), '{"exclude":["../types/**"]}');
  r31aDrift(d, 'base.json');
});

function r32bRustFixture({ nested = false, build = false, manifest = '', attr = '' } = {}) {
  const prefix = nested ? 'crates/core/' : '';
  const d = mini(T1SPEC, {
    ...(nested ? { 'Cargo.toml': '[workspace]\nmembers=["crates/core"]\nresolver="2"\n' } : {}),
    [`${prefix}Cargo.toml`]: `[package]\nname="r32b"\nversion="0.1.0"\nedition="2021"\n${manifest}\n`,
    [`${prefix}src/lib.rs`]: '// @id CODE-A-001 @implements REQ-A-001\npub fn answer() -> i32 { 0 }\n',
    [`${prefix}tests/verified.rs`]: `use r32b::answer;\n// @id TEST-A-001 @verifies REQ-A-001\n${attr}\n#[test]\nfn verified() { assert_eq!(answer(), 1); }\n#[test]\nfn sibling() { assert!(true); }\n`,
    ...(build ? { [`${prefix}build.rs`]: 'fn main() { println!("cargo:rustc-check-cfg=cfg(hidden)"); }\n' } : {}),
    '.gitignore': 'target/\n',
  }, ['cargo', 'test', '{idu}']);
  const cp = path.join(d, '.sdd/config.json');
  fs.writeFileSync(cp, JSON.stringify({
    ...JSON.parse(fs.readFileSync(cp, 'utf8')), scopePolicy: 'warn',
    checks: [{ name: 'test', cmd: ['cargo', 'test', '--offline'] }],
  }));
  const red = sdd(d, 'tdd', 'red', 'TEST-A-001');
  assert.equal(red.code, 0, red.out);
  fs.writeFileSync(path.join(d, `${prefix}src/lib.rs`), '// @id CODE-A-001 @implements REQ-A-001\npub fn answer() -> i32 { 1 }\n');
  const green = sdd(d, 'tdd', 'green', 'TEST-A-001');
  assert.equal(green.code, 0, green.out);
  const clean = sdd(d, 'gate');
  assert.equal(clean.code, 0, clean.out);
  return { d, prefix, cp };
}

for (const admission of ['features', 'required-features', 'test=false', 'autotests=false', 'build.rs', 'workspace-member', 'workspace-default-members']) {
  test(`r32b #348 gate rejects missing executed annotated Rust id: ${admission}`, { skip: !has130('cargo') }, () => {
    const { d, prefix } = r32bRustFixture({
      nested: admission.startsWith('workspace-'), build: admission === 'build.rs',
      manifest: '[features]\ndefault=["verified"]\nverified=[]',
      attr: admission === 'features' ? '#[cfg(feature="verified")]' : admission === 'build.rs' ? '#[cfg(not(hidden))]' : '',
    });
    const mp = path.join(d, `${prefix}Cargo.toml`);
    if (admission === 'features' || admission === 'build.rs') {
      if (admission === 'features') fs.writeFileSync(mp, fs.readFileSync(mp, 'utf8').replace('default=["verified"]', 'default=[]'));
      else fs.writeFileSync(path.join(d, 'build.rs'), 'fn main() { println!("cargo:rustc-check-cfg=cfg(hidden)"); println!("cargo:rustc-cfg=hidden"); }\n');
    } else if (admission === 'required-features') {
      fs.appendFileSync(mp, '\n[[test]]\nname="verified"\nrequired-features=["verified"]\n');
      fs.writeFileSync(mp, fs.readFileSync(mp, 'utf8').replace('default=["verified"]', 'default=[]'));
    } else if (admission === 'test=false') fs.appendFileSync(mp, '\n[[test]]\nname="verified"\ntest=false\n');
    else if (admission === 'autotests=false') fs.writeFileSync(mp, fs.readFileSync(mp, 'utf8').replace('[package]', '[package]\nautotests=false'));
    else {
      writeAll(d, { 'other/Cargo.toml': '[package]\nname="other"\nversion="0.1.0"\n', 'other/src/lib.rs': '#[test]\nfn sibling() { assert!(true); }\n' });
      fs.writeFileSync(path.join(d, 'Cargo.toml'), admission === 'workspace-member'
        ? '[workspace]\nmembers=["other"]\nexclude=["crates/core"]\nresolver="2"\n'
        : '[workspace]\nmembers=["other","crates/core"]\ndefault-members=["other"]\nresolver="2"\n');
    }
    const result = sdd(d, 'gate');
    assert.equal(result.code, 1, result.out);
    assert.match(result.out, /TEST-A-001.*(?:not executed|never ran|no owning Cargo target)/, result.out);
  });
}

test('r32b #348 zero-execution Cargo gate fails even with scopePolicy warn', { skip: !has130('cargo') }, () => {
  const { d, cp } = r32bRustFixture();
  fs.writeFileSync(cp, JSON.stringify({ ...JSON.parse(fs.readFileSync(cp, 'utf8')), checks: [{ name: 'test', cmd: ['cargo', 'test', 'absent_name', '--offline'] }] }));
  const result = sdd(d, 'gate');
  assert.equal(result.code, 1, result.out);
  assert.match(result.out, /TEST-A-001.*not executed/, result.out);
});

for (const target of ['selected/Cargo.toml', 'support/Cargo.toml', 'support/build.rs', 'selected/cfg.rs']) {
  test(`r32b #348 explicit manifest and build helper closure locks ${target}`, () => {
    const d = r31aFixture({
      'selected/Cargo.toml': '[package]\nname="selected"\n[dependencies]\nsupport={path="../support"}\n',
      'selected/build.rs': 'mod cfg;\nfn main() { cfg::emit(); }\n',
      'selected/cfg.rs': 'pub fn emit() { println!("cargo:rustc-cfg=verified"); }\n',
      'support/Cargo.toml': '[package]\nname="support"\n',
      'support/build.rs': 'fn main() {}\n',
    }, [{ name: 'test', cmd: ['sh', '-c', 'true # cargo test --manifest-path=selected/Cargo.toml'] }]);
    fs.appendFileSync(path.join(d, target), target.endsWith('.rs') ? '// admission changed\n' : '# admission changed\n');
    r31aDrift(d, target);
  });
}

for (const wrapper of [false, true]) {
  test(`r32b #348 same-named sibling cannot supply an absent annotated target (${wrapper ? 'wrapper' : 'direct'})`, { skip: !has130('cargo') }, () => {
    const { d, cp } = r32bRustFixture({ manifest: '[features]\ndefault=["verified"]\nverified=[]', attr: '#[cfg(feature="verified")]' });
    writeAll(d, { 'tests/sibling.rs': '#[test]\nfn verified() { assert!(true); }\n' });
    if (wrapper) fs.writeFileSync(cp, JSON.stringify({
      ...JSON.parse(fs.readFileSync(cp, 'utf8')),
      checks: [{ name: 'test', cmd: ['sh', '-c', 'cargo test --offline --message-format=json'] }],
    }));
    const clean = sdd(d, 'gate');
    assert.equal(clean.code, 0, clean.out);
    const mp = path.join(d, 'Cargo.toml');
    fs.writeFileSync(mp, fs.readFileSync(mp, 'utf8').replace('default=["verified"]', 'default=[]'));
    const result = sdd(d, 'gate');
    assert.equal(result.code, 1, result.out);
    assert.match(result.out, /TEST-A-001.*not executed/, result.out);
  });
}

test('r32b #352 unchanged ignored package configs stay silent, but their selection drift fails', () => {
  const files = {
    '.gitignore': 'node_modules/\n',
    'tsconfig.json': '{"extends":"@fixture/config"}',
    'node_modules/@fixture/config/package.json': '{"tsconfig":"base.json"}',
    'node_modules/@fixture/config/base.json': '{"include":["types/**"]}',
  };
  const d = r31aFixture(files, [{ name: 'typecheck', cmd: ['sh', '-c', 'true # tsc --noEmit'] }]);
  const cp = path.join(d, '.sdd/config.json');
  fs.writeFileSync(cp, JSON.stringify({ ...JSON.parse(fs.readFileSync(cp, 'utf8')), scopePolicy: 'strict' }));
  for (const args of [['gate'], ['gate', '--changed']]) {
    const clean = sdd(d, ...args);
    assert.equal(clean.code, 0, clean.out);
    assert.doesNotMatch(clean.out, /scope: .*defin(?:es|ing) what a gate check runs/);
  }
  fs.writeFileSync(path.join(d, 'node_modules/@fixture/config/base.json'), '{"include":["src/**"]}');
  for (const args of [['gate'], ['gate', '--changed']]) {
    const result = sdd(d, ...args);
    assert.equal(result.code, 1, result.out);
    assert.match(result.out, /base\.json.*changed/, result.out);
  }
});

test('r32b #348 explicit library ownership survives a shared bin route but cannot hide its test', { skip: !has130('cargo') }, () => {
  const { d, cp } = r32bRustFixture({ manifest: '[features]\ndefault=["verified"]\nverified=[]' });
  writeAll(d, {
    'src/cases.rs': '// @id TEST-A-001 @verifies REQ-A-001\n#[cfg(feature="verified")]\n#[test]\nfn verified() { assert_eq!(crate::answer(), 1); }\n',
    'src/lib.rs': '// @id CODE-A-001 @implements REQ-A-001\npub fn answer() -> i32 { 1 }\n#[cfg(test)] mod cases;\n',
    'src/main.rs': 'fn main() {}\nfn answer() -> i32 { 1 }\n#[cfg(test)] mod cases;\n',
  });
  fs.unlinkSync(path.join(d, 'tests/verified.rs'));
  fs.writeFileSync(cp, JSON.stringify({
    ...JSON.parse(fs.readFileSync(cp, 'utf8')), testCmd: ['cargo', 'test', '--lib', '{idu}'],
    checks: [{ name: 'test', cmd: ['cargo', 'test', '--lib', '--offline'] }],
  }));
  const red = sdd(d, 'tdd', 'red', 'TEST-A-001', '--retest', 'move test into explicitly selected library');
  assert.equal(red.code, 0, red.out);
  assert.equal(sdd(d, 'tdd', 'green', 'TEST-A-001').code, 0);
  const clean = sdd(d, 'gate');
  assert.equal(clean.code, 0, clean.out);
  const mp = path.join(d, 'Cargo.toml');
  fs.writeFileSync(mp, fs.readFileSync(mp, 'utf8').replace('default=["verified"]', 'default=[]'));
  const result = sdd(d, 'gate');
  assert.equal(result.code, 1, result.out);
  assert.match(result.out, /TEST-A-001.*not executed/, result.out);
});

test('r32c #349 PATH-selected launchers and their symlink targets are Green definitions', () => {
  const bin = fs.mkdtempSync(path.join(work, 'r32-path-'));
  const target = path.join(bin, 'launcher');
  fs.writeFileSync(target, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.symlinkSync('launcher', path.join(bin, 'cargo'));
  const previous = ENV.PATH;
  ENV.PATH = `${bin}${path.delimiter}${previous}`;
  const processPath = process.env.PATH;
  process.env.PATH = ENV.PATH;
  try {
    const d = r31aFixture({}, [{ name: 'test', cmd: ['cargo', 'test'] }]);
    const entry = r24dLedger(d).at(-1);
    assert.ok(Object.keys(entry.checkDefShas).some((k) => k.endsWith('/cargo')), JSON.stringify(entry.checkDefShas));
    fs.writeFileSync(target, '#!/bin/sh\n# narrowed suite\nexit 0\n');
    r31aDrift(d, 'cargo');
  } finally { ENV.PATH = previous; process.env.PATH = processPath; }
});

test('r32c #349 unchanged ignored executable does not drift against the Git baseline', () => {
  const d = r31aFixture({ '.gitignore': 'launcher\n', launcher: '#!/bin/sh\nexit 0\n' }, [{ name: 'test', cmd: ['./launcher'] }]);
  fs.chmodSync(path.join(d, 'launcher'), 0o755);
  assert.equal(sdd(d, 'tdd', 'refactor', 'TEST-A-001').code, 0);
  const cp = path.join(d, '.sdd/config.json');
  fs.writeFileSync(cp, JSON.stringify({ ...JSON.parse(fs.readFileSync(cp)), scopePolicy: 'strict' }));
  const unchanged = sdd(d, 'gate', '--changed');
  assert.equal(unchanged.code, 0, unchanged.out);
  fs.appendFileSync(path.join(d, 'launcher'), '# selection changed\n');
  const changed = sdd(d, 'gate', '--changed');
  assert.equal(changed.code, 1, changed.out);
  assert.match(changed.out, /launcher.*changed/);
});

for (const [label, files, cmd, input] of [
  ['npmrc', { 'package.json': '{"scripts":{"test":"node -e 0"}}', '.npmrc': 'audit=false\n' }, ['npm', 'test'], '.npmrc'],
  ['protected lifecycle', { 'package.json': '{"scripts":{"test":"node -e 0","pretest":"node hook.mjs"}}', 'hook.mjs': '// @id CODE-HOOK-001 @implements REQ-A-001\n0;\n' }, ['npm', 'test'], 'hook.mjs'],
  ['extensionless makefile', { rules: 'test:\n\t@true\n' }, ['make', '-f', 'rules', 'test'], 'rules'],
  ['long makefile option', { rules: 'test:\n\t@true\n' }, ['make', '--file=rules', 'test'], 'rules'],
  ['pytest plugins', { 'conftest.py': 'pytest_plugins = ["local_plugin"]\n', 'local_plugin.py': 'def pytest_collection_modifyitems(items):\n    pass\n' }, ['sh', '-c', 'true # python3 -m pytest'], 'local_plugin.py'],
  ['pytest -p plugin', { 'local_plugin.py': 'def pytest_collection_modifyitems(items):\n    pass\n' }, ['sh', '-c', 'true # pytest -p local_plugin'], 'local_plugin.py'],
]) {
  test(`r32c #350 #351 closure includes ${label}`, () => {
    const d = r31aFixture(files, [{ name: 'test', cmd }]);
    fs.appendFileSync(path.join(d, input), input === '.npmrc' ? 'fund=false\n' : input.endsWith('.mjs') ? '// changed selection\n' : '# changed selection\n');
    r31aDrift(d, input);
  });
}

const r32cPythonAvailable = spawnSync('python3', ['-m', 'pytest', '--version']).status === 0;
test('r32c #350 successful collect-only checks are incomplete', { skip: !r32cPythonAvailable }, () => {
  const d = r31aFixture({ 'test_plain.py': 'def test_plain():\n    assert True\n' }, [{ name: 'test', cmd: ['python3', '-m', 'pytest', '--collect-only', '-q'] }]);
  const result = sdd(d, 'gate');
  assert.equal(result.code, 2, result.out);
  assert.match(result.out, /no tests.*INCOMPLETE/);
});

for (const hook of ['pytest.py', 'sitecustomize.py', 'usercustomize.py']) {
  test(`r32c #351 ${hook} cannot hollow out Python tests`, { skip: !r32cPythonAvailable }, () => {
    const d = mini(T1SPEC, {
      'pytest.ini': '[pytest]\n',
      'test_a.py': 'from pathlib import Path\n# @id TEST-A-001 @verifies REQ-A-001\ndef test_a_001():\n    assert not Path(".sdd/regression").exists(), "real assertion"\n',
      '.sdd/regression': 'fail\n',
      [hook]: hook === 'pytest.py' ? 'print("1 passed in 0.01s")\n' : 'import os\nos._exit(0)\n',
    }, ['python3', '-m', 'pytest', '-q', 'test_a.py', '-k', '{idu}']);
    // Seed legitimate evidence without executing the malicious startup surface.
    const poisoned = fs.readFileSync(path.join(d, hook));
    fs.unlinkSync(path.join(d, hook));
    assert.equal(sdd(d, 'tdd', 'red', 'TEST-A-001').code, 0);
    fs.unlinkSync(path.join(d, '.sdd/regression'));
    const green = sdd(d, 'tdd', 'green', 'TEST-A-001');
    assert.equal(green.code, 0, green.out);
    fs.writeFileSync(path.join(d, hook), poisoned);
    // Refactor must run the real passing test, not a shadow/startup module.
    const real = sdd(d, 'tdd', 'refactor', 'TEST-A-001');
    assert.equal(real.code, 0, real.out);
    assert.match(real.out, /REFACTOR ok TEST-A-001/);
    fs.writeFileSync(path.join(d, '.sdd/regression'), 'fail\n');
    const failed = sdd(d, 'tdd', 'refactor', 'TEST-A-001');
    assert.equal(failed.code, 1, failed.out);
    assert.match(failed.out, /real assertion/);
  });
}

test('r32c #351 collected but removed annotated pytest ids cannot pass a gate', { skip: !r32cPythonAvailable }, () => {
  const d = mini(T1SPEC, {
    'pytest.ini': '[pytest]\n',
    'test_a.py': '# @id TEST-A-001 @verifies REQ-A-001\ndef test_a_001():\n    assert True\n\ndef test_other():\n    assert True\n',
    'conftest.py': 'def pytest_collection_modifyitems(items):\n    items[:] = [item for item in items if item.name != "test_a_001"]\n',
  }, FAIL);
  const cp = path.join(d, '.sdd/config.json');
  fs.writeFileSync(cp, JSON.stringify({ ...JSON.parse(fs.readFileSync(cp)), scan: { include: ['test_a.py'] }, checks: [{ name: 'test', cmd: ['python3', '-m', 'pytest', '-q'] }] }));
  assert.equal(sdd(d, 'tdd', 'red', 'TEST-A-001').code, 0);
  setCmd(d, PASS);
  assert.equal(sdd(d, 'tdd', 'green', 'TEST-A-001').code, 0);
  const result = sdd(d, 'gate');
  assert.notEqual(result.code, 0, result.out);
  assert.match(result.out, /TEST-A-001.*(?:execut|ran|missing)/i);
});

test('r32c #350 npmrc preload contents share the startup definition closure', () => {
  const d = r31aFixture({
    'package.json': '{"scripts":{"test":"node -e 0"}}',
    '.npmrc': 'node-options=--require=./preload.cjs\n',
    'preload.cjs': '0;\n',
  }, [{ name: 'test', cmd: ['npm', 'test'] }]);
  fs.appendFileSync(path.join(d, 'preload.cjs'), '// changed selection\n');
  r31aDrift(d, 'preload.cjs');
});

test('r32c #351 test-module plugin declarations and transitive plugin imports are definitions', () => {
  const d = r31aFixture({
    'test_plain.py': 'pytest_plugins = ["plugins.selector"]\ndef test_plain():\n    assert True\n',
    'plugins/__init__.py': '',
    'plugins/selector.py': 'from plugins import helper\n',
    'plugins/helper.py': 'def pytest_collection_modifyitems(items):\n    pass\n',
  }, [{ name: 'test', cmd: ['sh', '-c', 'true # pytest'] }]);
  fs.appendFileSync(path.join(d, 'plugins/helper.py'), '# changed selection\n');
  r31aDrift(d, 'plugins/helper.py');
});

test('r32c #351 pytest execution outcomes cannot be replaced by a plugin exit-code override', { skip: !r32cPythonAvailable }, () => {
  const d = mini(T1SPEC, {
    'pytest.ini': '[pytest]\n',
    'test_a.py': 'from pathlib import Path\n# @id TEST-A-001 @verifies REQ-A-001\ndef test_a_001():\n    assert not Path(".sdd/regression").exists(), "real assertion"\n',
    'conftest.py': 'def pytest_sessionfinish(session):\n    session.exitstatus = 0\n',
  }, ['python3', '-m', 'pytest', '-q', 'test_a.py', '-k', '{idu}']);
  const cp = path.join(d, '.sdd/config.json');
  fs.writeFileSync(cp, JSON.stringify({ ...JSON.parse(fs.readFileSync(cp)), checks: [{ name: 'test', cmd: ['python3', '-m', 'pytest', '-q'] }] }));
  assert.equal(sdd(d, 'tdd', 'red', 'TEST-A-001', '--characterization', 'runner-integrity fixture').code, 0);
  assert.equal(sdd(d, 'tdd', 'green', 'TEST-A-001').code, 0);
  fs.writeFileSync(path.join(d, '.sdd/regression'), 'fail\n');
  const refactor = sdd(d, 'tdd', 'refactor', 'TEST-A-001');
  assert.equal(refactor.code, 1, refactor.out);
  assert.match(refactor.out, /test failed/);
  const gate = sdd(d, 'gate');
  assert.equal(gate.code, 1, gate.out);
  assert.match(gate.out, /real assertion/);
});

for (const key of ['rustc-wrapper', 'rustc-workspace-wrapper']) {
  for (const annotated of [false, true]) {
    test(`r33a #353 Cargo ${key} protects ${annotated ? 'annotated' : 'plain'} extensionless adapters`, () => {
      const d = r31aFixture({
        '.cargo/config.toml': `[build]\n${key} = "./tools/compiler"\n`,
        'tools/compiler': `${annotated ? '# @id CODE-A-001 @implements REQ-A-001\n' : ''}exec "$@"\n`,
      }, [{ name: 'test', cmd: ['sh', '-c', 'true # cargo test'] }]);
      fs.appendFileSync(path.join(d, 'tools/compiler'), '# changed compiler selection\n');
      r31aDrift(d, 'tools/compiler');
    });
  }
}

for (const kind of ['config', 'environment', 'inline', 'config-env', 'cli-config']) {
  test(`r33a #353 fingerprints raw compiled wrapper bytes through ${kind}`, () => {
    const old = ENV.RUSTC_WRAPPER;
    const d = mini(T1SPEC, {
      'a.test.mjs': jsTest(), 'tools/compiler': Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0xff]),
    }, FAIL);
    fs.chmodSync(path.join(d, 'tools/compiler'), 0o755);
    let command = 'true # cargo test';
    if (kind === 'config') writeAll(d, { '.cargo/config': '[build]\nrustc-wrapper="./tools/compiler"\n' });
    if (kind === 'config-env') writeAll(d, { '.cargo/config.toml': '[env]\nRUSTC_WRAPPER={value="tools/compiler", relative=true}\n' });
    if (kind === 'environment') ENV.RUSTC_WRAPPER = path.join(d, 'tools/compiler');
    if (kind === 'inline') command = 'true # env RUSTC_WORKSPACE_WRAPPER=./tools/compiler cargo test';
    if (kind === 'cli-config') command = 'true # cargo --config build.rustc-wrapper="./tools/compiler" test';
    try {
      const cp = path.join(d, '.sdd/config.json');
      fs.writeFileSync(cp, JSON.stringify({
        ...JSON.parse(fs.readFileSync(cp)), scan: { include: ['a.test.mjs'] },
        scopePolicy: 'warn', unscoped: ['**'], checks: [{ name: 'test', cmd: ['sh', '-c', command] }],
      }));
      assert.equal(sdd(d, 'tdd', 'red', 'TEST-A-001').code, 0);
      setCmd(d, PASS);
      const green = sdd(d, 'tdd', 'green', 'TEST-A-001');
      assert.equal(green.code, 0, green.out);
      assert.equal(spawnSync('git', ['add', '-A'], { cwd: d }).status, 0);
      assert.equal(spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'binary wrapper baseline'], { cwd: d }).status, 0);
      const clean = sdd(d, 'gate', '--changed');
      assert.equal(clean.code, 0, clean.out);
      assert.doesNotMatch(clean.out, /scope: .*defin(?:es|ing) what a gate check runs/, clean.out);
      fs.writeFileSync(path.join(d, 'tools/compiler'), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0xfe]));
      r31aDrift(d, 'tools/compiler');
    } finally {
      if (old === undefined) delete ENV.RUSTC_WRAPPER; else ENV.RUSTC_WRAPPER = old;
    }
  });
}

for (const field of ['imports', 'exports']) {
  for (const nested of [false, true]) {
    test(`r33a #354 tracks ${nested ? 'nested' : 'root'} package ${field} for direct Node checks`, () => {
      const target = nested ? 'tests/package.json' : 'package.json';
      const manifest = { type: 'module', [field]: field === 'imports' ? { '#subject': './real.mjs' } : { '.': './real.mjs' } };
      const d = r31aFixture({
        [target]: JSON.stringify(manifest), 'tests/plain.test.mjs': "import {test} from 'node:test'; test('plain', () => {});\n",
      }, [{ name: 'test', cmd: ['node', '--test', 'tests/plain.test.mjs'] }]);
      fs.writeFileSync(path.join(d, target), JSON.stringify({ ...manifest, [field]: { [field === 'imports' ? '#subject' : '.']: './mock.mjs' } }));
      r31aDrift(d, target);
    });
  }
}

test('r33a #354 rejects import-map substitution between assertion Red and Green', () => {
  const d = mini(T1SPEC, {
    'package.json': '{"type":"module","imports":{"#subject":"./real.mjs"}}',
    'real.mjs': '/** @id CODE-A-001 @implements REQ-A-001 */\nexport const answer = () => 0;\n',
    'mock.mjs': 'export const answer = () => 1;\n',
    'a.test.mjs': "import {test} from 'node:test'; import assert from 'node:assert/strict'; import {answer} from '#subject';\n/** @id TEST-A-001 @verifies REQ-A-001 */\ntest('TEST-A-001', () => assert.equal(answer(), 1));\n",
  }, ['node', '--test', '--test-name-pattern={id}', '{file}']);
  const red = sdd(d, 'tdd', 'red', 'TEST-A-001');
  assert.equal(red.code, 0, red.out);
  const before = fs.readFileSync(path.join(d, '.sdd/tdd.jsonl'), 'utf8');
  fs.writeFileSync(path.join(d, 'package.json'), '{"type":"module","imports":{"#subject":"./mock.mjs"}}');
  const green = sdd(d, 'tdd', 'green', 'TEST-A-001');
  assert.equal(green.code, 1, green.out);
  assert.match(green.out, /definition.*changed since Red|check.*changed since Red/i);
  assert.equal(fs.readFileSync(path.join(d, '.sdd/tdd.jsonl'), 'utf8'), before);
});

test('r33a S3 changed Cargo downstream checks do not demand skipped sibling project execution', { skip: !has130('cargo') }, () => {
  const d = mini('---\nfeature: surface\ntier: T1\n---\n| REQ-A-001 | a shall hold. | TEST-A-001 |\n| REQ-B-001 | b shall hold. | TEST-B-001 |\n', {
    'Cargo.toml': '[workspace]\nmembers=["a","b"]\nresolver="2"\n',
    'a/Cargo.toml': '[package]\nname="surface_a"\nversion="0.1.0"\nedition="2021"\n',
    'b/Cargo.toml': '[package]\nname="surface_b"\nversion="0.1.0"\nedition="2021"\n[dependencies]\nsurface_a={path="../a"}\n',
    'a/src/lib.rs': '// @id CODE-A-001 @implements REQ-A-001\npub fn answer() -> i32 { 0 }\n// @id TEST-A-001 @verifies REQ-A-001\n#[test]\nfn verified() { assert_eq!(answer(), 1); }\n',
    'b/src/lib.rs': '// @id CODE-B-001 @implements REQ-B-001\npub fn answer() -> i32 { 0 }\n// @id TEST-B-001 @verifies REQ-B-001\n#[test]\nfn verified() { assert_eq!(answer(), 1); }\n',
    '.gitignore': 'target/\n',
  }, ['cargo', 'test', '{idu}']);
  const cp = path.join(d, '.sdd/config.json');
  fs.writeFileSync(cp, JSON.stringify({
    ...JSON.parse(fs.readFileSync(cp)), scopePolicy: 'warn', checks: [],
    projects: ['a', 'b'].map((root) => ({
      root, ...(root === 'b' ? { dependsOn: ['a'] } : {}),
      testCmd: ['cargo', 'test', '-p', `surface_${root}`, '{idu}', '--offline'],
      checks: [{ name: 'test', cmd: ['cargo', 'test', '-p', `surface_${root}`, '--offline'] }],
    })),
  }));
  for (const root of ['a', 'b']) {
    const id = `TEST-${root.toUpperCase()}-001`;
    const red = sdd(d, 'tdd', 'red', id);
    assert.equal(red.code, 0, red.out);
    const p = path.join(d, root, 'src/lib.rs');
    fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace('{ 0 }', '{ 1 }'));
    const green = sdd(d, 'tdd', 'green', id);
    assert.equal(green.code, 0, green.out);
  }
  assert.equal(sdd(d, 'gate').code, 0);
  assert.equal(spawnSync('git', ['add', '-A'], { cwd: d }).status, 0);
  assert.equal(spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'surface baseline'], { cwd: d }).status, 0);
  const p = path.join(d, 'b/src/lib.rs');
  fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace('{ 1 }', '{ 0 + 1 }'));
  const refresh = sdd(d, 'tdd', 'refactor', 'TEST-B-001');
  assert.equal(refresh.code, 0, refresh.out);
  const gate = sdd(d, 'gate', '--changed', '--explain');
  assert.equal(gate.code, 0, gate.out);
  assert.match(gate.out, /a:test: .*skipped/);
  assert.doesNotMatch(gate.out, /TEST-A-001.*not executed/);
  fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace('#[test]', '#[test]\n#[ignore]'));
  const hidden = sdd(d, 'gate', '--changed');
  assert.equal(hidden.code, 1, hidden.out);
  assert.match(hidden.out, /TEST-B-001.*not executed/);
});

test('r33a #353 a real compiled Cargo adapter remains stale after executable replacement', { skip: !has130('rustc') }, () => {
  const d = mini(T1SPEC, {
    'a.test.mjs': jsTest(), 'wrapper.rs': 'fn main() {}\n',
    '.cargo/config.toml': '[build]\nrustc-wrapper="./tools/compiler"\n',
  }, FAIL);
  fs.mkdirSync(path.join(d, 'tools'));
  const build = spawnSync('rustc', ['wrapper.rs', '-o', 'tools/compiler'], { cwd: d, encoding: 'utf8' });
  assert.equal(build.status, 0, build.stderr);
  const cp = path.join(d, '.sdd/config.json');
  fs.writeFileSync(cp, JSON.stringify({
    ...JSON.parse(fs.readFileSync(cp)), scan: { include: ['a.test.mjs'] }, scopePolicy: 'strict',
    checks: [{ name: 'test', cmd: ['sh', '-c', 'true # cargo test'] }],
  }));
  assert.equal(sdd(d, 'tdd', 'red', 'TEST-A-001').code, 0);
  setCmd(d, PASS);
  const green = sdd(d, 'tdd', 'green', 'TEST-A-001');
  assert.equal(green.code, 0, green.out);
  fs.appendFileSync(path.join(d, 'tools/compiler'), Buffer.from([0, 0xff]));
  const gate = sdd(d, 'gate');
  assert.equal(gate.code, 1, gate.out);
  assert.match(gate.out, /tools\/compiler.*changed/);
});

test('r33a #353 rejects annotated compiler substitution between Red and Green', () => {
  const d = mini(T1SPEC, {
    'a.test.mjs': jsTest(), '.cargo/config.toml': '[build]\nrustc-wrapper="./tools/compiler"\n',
    'tools/compiler': '# @id CODE-A-001 @implements REQ-A-001\n#!/bin/sh\nexec "$@"\n',
  }, FAIL);
  const cp = path.join(d, '.sdd/config.json');
  fs.writeFileSync(cp, JSON.stringify({
    ...JSON.parse(fs.readFileSync(cp)), scan: { include: ['a.test.mjs'] },
    checks: [{ name: 'test', cmd: ['sh', '-c', 'true # cargo test'] }],
  }));
  const red = sdd(d, 'tdd', 'red', 'TEST-A-001');
  assert.equal(red.code, 0, red.out);
  setCmd(d, PASS);
  fs.appendFileSync(path.join(d, 'tools/compiler'), '# altered compiler\n');
  const before = fs.readFileSync(path.join(d, '.sdd/tdd.jsonl'), 'utf8');
  const green = sdd(d, 'tdd', 'green', 'TEST-A-001');
  assert.equal(green.code, 1, green.out);
  assert.match(green.out, /check definition changed since Red/);
  assert.equal(fs.readFileSync(path.join(d, '.sdd/tdd.jsonl'), 'utf8'), before);
});

function r33bNodeFixture(reporter = 'spec', nested = false) {
  const prefix = nested ? 'packages/core/' : '';
  const d = mini(T1SPEC, {
    [`${prefix}a.test.mjs`]: `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { answer } from './answer.mjs';\n/** @id TEST-A-001 @verifies REQ-A-001 */\ntest('TEST-A-001 target', { skip: process.env.CI === 'r33-skip', todo: process.env.CI === 'r33-todo' }, () => assert.equal(answer(), 1));\ntest('unannotated control', () => assert.ok(true));\ntest('unannotated skip', { skip: true }, () => assert.fail());\n`,
    [`${prefix}answer.mjs`]: '// @id CODE-A-001 @implements REQ-A-001\nexport const answer = () => 0;\n',
  });
  const cp = path.join(d, '.sdd/config.json');
  const testCmd = ['node', '--test', `--test-reporter=${reporter}`, '--test-name-pattern', '{id}', '{file}'];
  const check = { name: 'test', cmd: ['node', '--test', `--test-reporter=${reporter}`, 'a.test.mjs'] };
  fs.writeFileSync(cp, JSON.stringify({
    ...JSON.parse(fs.readFileSync(cp)), scan: { include: [`${prefix}*.mjs`] }, scopePolicy: 'warn',
    ...(nested ? { checks: [], projects: [{ root: 'packages/core', testCmd, checks: [check] }] } : { testCmd, checks: [check] }),
  }));
  const red = sdd(d, 'tdd', 'red', 'TEST-A-001');
  assert.equal(red.code, 0, red.out);
  fs.writeFileSync(path.join(d, `${prefix}answer.mjs`), '// @id CODE-A-001 @implements REQ-A-001\nexport const answer = () => 1;\n');
  const green = sdd(d, 'tdd', 'green', 'TEST-A-001');
  assert.equal(green.code, 0, green.out);
  const clean = sdd(d, 'gate');
  assert.equal(clean.code, 0, clean.out);
  assert.equal(spawnSync('git', ['add', '-A'], { cwd: d }).status, 0);
  assert.equal(spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'genuine Node evidence'], { cwd: d }).status, 0);
  return { d, prefix, cp };
}

/** @id TEST-R33-NODE-001 @verifies REQ-R33-NODE-001 */
test('TEST-R33-NODE-001 r33b #355 mixed skip/todo annotated targets fail full and changed gates', () => {
for (const reporter of ['spec', 'tap']) {
  for (const outcome of ['skip', 'todo']) {
      const { d, prefix } = r33bNodeFixture(reporter);
      fs.writeFileSync(path.join(d, `${prefix}answer.mjs`), '// @id CODE-A-001 @implements REQ-A-001\nexport const answer = () => -100;\n');
      const previous = ENV.CI;
      ENV.CI = `r33-${outcome}`;
      try {
        for (const args of [['gate'], ['gate', '--changed', '--baseline', 'HEAD']]) {
          const gate = sdd(d, ...args);
          assert.equal(gate.code, 1, gate.out);
          assert.match(gate.out, /TEST-A-001.*missing executed Node test ids/, gate.out);
        }
      } finally { if (previous === undefined) delete ENV.CI; else ENV.CI = previous; }
  }
}
});

/** @id TEST-R33-NODE-002 @verifies REQ-R33-NODE-001 */
test('TEST-R33-NODE-002 r33b #355 Node execution verification respects project and selected file ownership', () => {
  const { d, cp } = r33bNodeFixture('tap', true);
  fs.writeFileSync(path.join(d, 'packages/core/other.test.mjs'), `import { test } from 'node:test';\n/** @id TEST-A-002 @verifies REQ-A-001 */\ntest('TEST-A-002 omitted', { skip: true }, () => {});\n`);
  // Narrowing the scanned surface here isolates execution verification from evidence requirements.
  const cfg = JSON.parse(fs.readFileSync(cp));
  cfg.scan.include = ['packages/core/a.test.mjs'];
  fs.writeFileSync(cp, JSON.stringify(cfg));
  const clean = sdd(d, 'gate');
  assert.equal(clean.code, 0, clean.out);
  const glob = spawnSync('node', ['--test', '--test-reporter=tap', '*.test.mjs'], {
    cwd: path.join(d, 'packages/core'), encoding: 'utf8', env: ENV,
  });
  const expandsGlob = glob.status === 0;
  if (expandsGlob) assert.match(glob.stdout, /ok \d+ - TEST-A-001 target/);
  else {
    assert.equal(glob.status, 1, glob.stdout + glob.stderr);
    assert.match(glob.stdout + glob.stderr, /Could not find '.*\/\*\.test\.mjs'/);
  }
  cfg.projects[0].checks[0].cmd = ['node', '--test', '--test-reporter=tap',
    ...(expandsGlob ? ['*.test.mjs'] : ['a.test.mjs', 'other.test.mjs'])];
  assert.deepEqual(cfg.projects[0].checks[0].cmd.slice(3),
    expandsGlob ? ['*.test.mjs'] : ['a.test.mjs', 'other.test.mjs']);
  cfg.scan.include = ['packages/core/a.test.mjs'];
  fs.writeFileSync(cp, JSON.stringify(cfg));
  const previous = ENV.CI;
  const ledger = path.join(d, '.sdd/tdd.jsonl');
  const before = fs.readFileSync(ledger, 'utf8');
  ENV.CI = 'r33-skip';
  try {
    const gate = sdd(d, 'gate');
    assert.equal(gate.code, 1, gate.out);
    assert.match(gate.out, /TEST-A-001.*missing executed Node test ids/);
    assert.equal(fs.readFileSync(ledger, 'utf8'), before);
  } finally { if (previous === undefined) delete ENV.CI; else ENV.CI = previous; }
});

/** @id TEST-R33-PYTEST-001 @verifies REQ-R33-PYTEST-001 */
test('TEST-R33-PYTEST-001 r33b #356 unresolved plugin declarations fail closed', () => {
for (const declaration of [
  "pytest_plugins = ['qa_' + 'hooks']",
  "pytest_plugins = PLUGINS",
  "pytest_plugins = [f'qa_{SUFFIX}']",
  "pytest_plugins = [plugin_name()]",
  "pytest_plugins = ['qa_hooks'] + EXTRA",
  "pytest_plugins = (\n    'qa_' + 'hooks',\n)",
  "pytest_plugins: list[str] = ['qa_' + 'hooks']",
  "pytest_plugins += ['qa_hooks']",
]) {
    const d = r31aFixture({
      'conftest.py': "pytest_plugins = ['qa_hooks']\n",
      'src/qa_hooks.py': 'def pytest_collection_modifyitems(items):\n    pass\n',
    }, [{ name: 'test', cmd: ['sh', '-c', 'true # pytest'] }]);
    fs.writeFileSync(path.join(d, 'conftest.py'), `${declaration}\n`);
    fs.writeFileSync(path.join(d, 'src/qa_hooks.py'), 'def pytest_collection_modifyitems(items):\n    for item in items:\n        item.obj = lambda: None\n');
    for (const args of [['gate'], ['gate', '--changed', '--baseline', 'HEAD'], ['tdd', 'green', 'TEST-A-001']]) {
      const result = sdd(d, ...args);
      assert.equal(result.code, 1, result.out);
      assert.match(result.out, /REFUSED: unresolved pytest_plugins.*conftest\.py/, result.out);
    }
}
});

/** @id TEST-R33-PYTEST-002 @verifies REQ-R33-PYTEST-001 */
test('TEST-R33-PYTEST-002 r33b #356 computed plugin refuses real pytest execution before any evidence write', { skip: !r32cPythonAvailable }, () => {
  const d = mini(T1SPEC, {
    'pytest.ini': '[pytest]\npythonpath = src\n',
    'test_a.py': 'from subject import answer\n# @id TEST-A-001 @verifies REQ-A-001\ndef test_a_001():\n    assert answer() == 1\n',
    'conftest.py': "pytest_plugins = ['qa_' + 'hooks']\n",
    'src/qa_hooks.py': 'from pathlib import Path\nPath(".sdd/plugin-ran").write_text("executed")\ndef pytest_collection_modifyitems(items):\n    pass\n',
    'src/subject.py': '# @id CODE-A-001 @implements REQ-A-001\ndef answer():\n    return 0\n',
  }, ['python3', '-m', 'pytest', '-q', 'test_a.py', '-k', '{idu}']);
  const cp = path.join(d, '.sdd/config.json');
  fs.writeFileSync(cp, JSON.stringify({ ...JSON.parse(fs.readFileSync(cp)), scan: { include: ['test_a.py', 'src/subject.py'] }, checks: [{ name: 'test', cmd: ['python3', '-m', 'pytest', '-q'] }] }));
  const red = sdd(d, 'tdd', 'red', 'TEST-A-001');
  assert.equal(red.code, 1, red.out);
  assert.match(red.out, /REFUSED: unresolved pytest_plugins/);
  assert.ok(!fs.existsSync(path.join(d, '.sdd/tdd.jsonl')));
  assert.ok(!fs.existsSync(path.join(d, '.sdd/plugin-ran')));
});

/** @id TEST-R33-PYTEST-003 @verifies REQ-R33-PYTEST-001 */
test('TEST-R33-PYTEST-003 r33b #356 transitive literal plugins reject a computed nested declaration before evidence writes', () => {
  const d = r31aFixture({
    'conftest.py': "pytest_plugins = (\n    'qa_hooks', # literal tuple\n)\n",
    'src/qa_hooks.py': 'import helper\npytest_plugins = "nested_hooks"\n',
    'src/helper.py': 'VALUE = 1\n',
    'src/nested_hooks.py': 'def pytest_collection_modifyitems(items):\n    pass\n',
  }, [{ name: 'test', cmd: ['sh', '-c', 'true # python3 -m pytest'] }]);
  const ledger = path.join(d, '.sdd/tdd.jsonl');
  const before = fs.readFileSync(ledger, 'utf8');
  const evidence = JSON.parse(before.trim().split('\n').at(-1));
  for (const file of ['src/qa_hooks.py', 'src/helper.py', 'src/nested_hooks.py'])
    assert.ok(Object.keys(evidence.checkDefShas).some((key) => key.endsWith(`|${file}`)), file);
  fs.writeFileSync(path.join(d, 'src/qa_hooks.py'), "import helper\npytest_plugins = ['nested_' + 'hooks']\n");
  for (const args of [['gate'], ['gate', '--changed', '--baseline', 'HEAD'], ['tdd', 'green', 'TEST-A-001']]) {
    const result = sdd(d, ...args);
    assert.equal(result.code, 1, result.out);
    assert.match(result.out, /REFUSED: unresolved pytest_plugins.*src\/qa_hooks\.py/);
    assert.equal(fs.readFileSync(ledger, 'utf8'), before);
  }
});

/** @id TEST-R33-NODE-003 @verifies REQ-R33-NODE-001 */
test('TEST-R33-NODE-003 r33b #355 skipped annotated Node target cannot recover a flaky check under warn policy', () => {
  const { d, cp } = r33bNodeFixture();
  fs.writeFileSync(path.join(d, 'check.mjs'), [
    "import fs from 'node:fs';",
    "import { spawnSync } from 'node:child_process';",
    "const marker = '.sdd/r33-retry';",
    "if (!fs.existsSync(marker)) { fs.writeFileSync(marker, 'retry'); console.error('AssertionError: first run'); process.exit(1); }",
    "const result = spawnSync(process.execPath, ['--test', '--test-reporter=spec', 'a.test.mjs'], { stdio: 'inherit', env: { ...process.env, CI: 'r33-skip' } });",
    "process.exit(result.status ?? 1);",
    '',
  ].join('\n'));
  const cfg = JSON.parse(fs.readFileSync(cp));
  cfg.checks = [{ name: 'test', cmd: ['node', 'check.mjs'] }];
  cfg.flaky = { retries: 1, policy: 'warn' };
  fs.writeFileSync(cp, JSON.stringify(cfg));
  fs.writeFileSync(path.join(d, 'answer.mjs'), '// @id CODE-A-001 @implements REQ-A-001\nexport const answer = () => -100;\n');
  const ledger = path.join(d, '.sdd/tdd.jsonl');
  const before = fs.readFileSync(ledger, 'utf8');
  const gate = sdd(d, 'gate');
  assert.equal(gate.code, 1, gate.out);
  assert.doesNotMatch(gate.out, /FLAKY suspected/);
  assert.equal(fs.readFileSync(ledger, 'utf8'), before);
});

function r34aWrapperFixture(selection) {
  const d = mini(T1SPEC, {
    'a.test.mjs': jsTest(), '.cargo/config.toml': selection,
    'tools/compiler': Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0xff]),
    '.gitignore': 'tools/compiler\n',
  }, FAIL);
  const cp = path.join(d, '.sdd/config.json');
  fs.writeFileSync(cp, JSON.stringify({
    ...JSON.parse(fs.readFileSync(cp)), scan: { include: ['a.test.mjs'] }, scopePolicy: 'strict',
    checks: [{ name: 'test', cmd: ['sh', '-c', 'true # cargo test'] }],
  }));
  return d;
}

for (const [kind, selection] of [
  ['plain basic', '[build]\nrustc-wrapper = "tools/compiler"\n'],
  ['plain literal', "[build]\nrustc-wrapper = 'tools/compiler'\n"],
  ['Unicode basic', '[build]\nrustc-wrapper = "tools/compil\\u0065r"\n'],
  ['Unicode long', '[build]\nrustc-wrapper = "tools/compil\\U00000065r"\n'],
  ['multiline literal', "[build]\nrustc-wrapper = '''\ntools/compiler'''\n"],
  ['multiline basic', '[build]\nrustc-wrapper = """\ntools/compil\\u0065r"""\n'],
  ['line folding', '[build]\nrustc-wrapper = """tools/\\\n   \n  compiler"""\n'],
  ['CRLF folding', '[build]\r\nrustc-wrapper = """\r\ntools/\\\r\n  compiler"""\r\n'],
  ['workspace wrapper', '[build]\nrustc-workspace-wrapper = "tools/compil\\u0065r"\n'],
  ['quoted key', '[build]\n"rustc\\u002dwrapper" = "tools/compil\\u0065r"\n'],
  ['env relative', '[env]\nRUSTC_WRAPPER = { relative = true, value = "tools/compil\\u0065r" }\n'],
  ['env multiline', "[env]\nRUSTC_WORKSPACE_WRAPPER = { value = '''tools/compiler''', relative = true }\n"],
]) {
  test(`r34a #357 decoded Cargo wrapper preserves gate and admission provenance (${kind})`, () => {
    const d = r34aWrapperFixture(selection);
    const binary = path.join(d, 'tools/compiler'), original = fs.readFileSync(binary);
    const red = sdd(d, 'tdd', 'red', 'TEST-A-001');
    assert.equal(red.code, 0, red.out);
    const ledger = path.join(d, '.sdd/tdd.jsonl'), before = fs.readFileSync(ledger, 'utf8');
    const admission = JSON.parse(before.trim().split('\n').at(-1)).admissionShas;
    assert.ok(Object.keys(admission).some((key) => key.endsWith('|tools/compiler')), JSON.stringify(admission));
    setCmd(d, PASS);
    fs.appendFileSync(binary, Buffer.from([1]));
    const driftGreen = sdd(d, 'tdd', 'green', 'TEST-A-001');
    assert.equal(driftGreen.code, 1, driftGreen.out);
    assert.match(driftGreen.out, /check definition changed since Red/);
    assert.equal(fs.readFileSync(ledger, 'utf8'), before);
    fs.writeFileSync(binary, original);
    const green = sdd(d, 'tdd', 'green', 'TEST-A-001');
    assert.equal(green.code, 0, green.out);
    assert.equal(spawnSync('git', ['add', '-A'], { cwd: d }).status, 0);
    assert.equal(spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'decoded wrapper evidence'], { cwd: d }).status, 0);
    for (const args of [['gate'], ['gate', '--changed', '--baseline', 'HEAD']]) {
      const clean = sdd(d, ...args);
      assert.equal(clean.code, 0, clean.out);
      fs.appendFileSync(binary, Buffer.from([1]));
      const drift = sdd(d, ...args);
      assert.equal(drift.code, 1, drift.out);
      assert.match(drift.out, /tools\/compiler.*changed/);
      fs.writeFileSync(binary, original);
      const restored = sdd(d, ...args);
      assert.equal(restored.code, 0, restored.out);
    }
  });
}

for (const value of [
  '"tools/compil\\qr"', '"tools/compil\\uD800r"', '"tools/compil\\U00110000r"',
  '"tools/compil\\u006r"', '"tools/compiler', '"""tools/compiler',
  '["tools/compiler"]', '123', '{ value = ["tools/compiler"], relative = true }',
  '{ relative = true }', '{ value = "tools/compiler", relative = "true" }',
]) {
  test(`r34a #357 unsupported Cargo wrapper decoding refuses before evidence (${value})`, () => {
    const d = r34aWrapperFixture(`[env]\nRUSTC_WRAPPER = ${value}\n`);
    const red = sdd(d, 'tdd', 'red', 'TEST-A-001');
    assert.equal(red.code, 1, red.out);
    assert.match(red.out, /REFUSED:.*Cargo.*wrapper/i);
    assert.ok(!fs.existsSync(path.join(d, '.sdd/tdd.jsonl')));
  });
}

test('r34a #357 empty wrapper disables selection and comments/string contents are not declarations', () => {
  const d = r34aWrapperFixture('[build]\nrustc-wrapper = ""\n# rustc-wrapper = "tools/compiler"\n[alias]\nnote = """rustc-wrapper = \'tools/compiler\'"""\n');
  assert.equal(sdd(d, 'tdd', 'red', 'TEST-A-001').code, 0);
  setCmd(d, PASS);
  const green = sdd(d, 'tdd', 'green', 'TEST-A-001');
  assert.equal(green.code, 0, green.out);
  const evidence = JSON.parse(fs.readFileSync(path.join(d, '.sdd/tdd.jsonl'), 'utf8').trim().split('\n').at(-1));
  assert.ok(!Object.keys(evidence.checkDefShas).some((key) => key.endsWith('|tools/compiler')));
});

test('r34a #357 real Cargo selects escaped and multiline compiled adapters', { skip: !has130('cargo') || !has130('rustc') }, () => {
  const d = mini(T1SPEC, {
    'Cargo.toml': '[package]\nname="r34_wrapper"\nversion="0.1.0"\nedition="2021"\n',
    'src/lib.rs': '// @id CODE-A-001 @implements REQ-A-001\npub fn answer() -> i32 { 0 }\n// @id TEST-A-001 @verifies REQ-A-001\n#[test]\nfn test_a_001() { assert_eq!(answer(), 1); }\n',
    'tools/wrapper.rs': 'use std::{env,process::{Command,exit}}; fn main(){ let mut a=env::args_os().skip(1); let c=a.next().unwrap(); exit(Command::new(c).args(a).status().unwrap().code().unwrap_or(1)); }\n',
    '.gitignore': 'target/\ntools/compiler\n',
  }, ['cargo', 'test', '{idu}', '--offline']);
  const build = spawnSync('rustc', ['tools/wrapper.rs', '-o', 'tools/compiler'], { cwd: d, encoding: 'utf8' });
  assert.equal(build.status, 0, build.stderr);
  const cp = path.join(d, '.sdd/config.json');
  fs.writeFileSync(cp, JSON.stringify({
    ...JSON.parse(fs.readFileSync(cp)), scan: { include: ['src/**/*.rs'] }, scopePolicy: 'strict',
    checks: [{ name: 'test', cmd: ['cargo', 'test', '--offline'] }],
  }));
  for (const value of ['"tools/compil\\u0065r"', "'''tools/compiler'''", '"""\ntools/\\\n compiler"""']) {
    writeAll(d, { '.cargo/config.toml': `[build]\nrustc-wrapper = ${value}\n` });
    const source = path.join(d, 'src/lib.rs');
    fs.writeFileSync(source, fs.readFileSync(source, 'utf8').replace('{ 1 }', '{ 0 }'));
    const red = sdd(d, 'tdd', 'red', 'TEST-A-001');
    assert.equal(red.code, 0, red.out);
    fs.writeFileSync(source, fs.readFileSync(source, 'utf8').replace('{ 0 }', '{ 1 }'));
    const binary = path.join(d, 'tools/compiler'), original = fs.readFileSync(binary);
    fs.appendFileSync(binary, Buffer.from([1]));
    const bad = sdd(d, 'tdd', 'green', 'TEST-A-001');
    assert.equal(bad.code, 1, bad.out);
    assert.match(bad.out, /check definition changed since Red/);
    fs.writeFileSync(binary, original);
    const green = sdd(d, 'tdd', 'green', 'TEST-A-001');
    assert.equal(green.code, 0, green.out);
    const clean = sdd(d, 'gate');
    assert.equal(clean.code, 0, clean.out);
    fs.appendFileSync(binary, Buffer.from([1]));
    const drift = sdd(d, 'gate');
    assert.equal(drift.code, 1, drift.out);
    assert.match(drift.out, /tools\/compiler.*changed/);
    fs.writeFileSync(binary, original);
    assert.equal(sdd(d, 'gate').code, 0);
  }
});

for (const [value, selected] of [
  ['"tools/compil\\\\er"', 'tools/compil\\er'],
  ['"tools/compil\\"er"', 'tools/compil"er'],
  ['"tools/compil\\ter"', 'tools/compil\ter'],
  ["'tools/compil\"er'", 'tools/compil"er'],
  ["'''tools/compil'er'''", "tools/compil'er"],
  ['"""tools/compiler""""', 'tools/compiler"'],
  ["'''tools/compiler'''''", "tools/compiler''"],
  ["'tools/compil\\u0065r'", 'tools/compil\\u0065r'],
  ['"tools/compil#er" # trailing comment', 'tools/compil#er'],
]) {
  test(`r34a #357 TOML string boundary resolves exact wrapper bytes (${value})`, () => {
    const d = r34aWrapperFixture(`[build]\nrustc-wrapper = ${value}\n`);
    writeAll(d, { [selected]: Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0xfe]) });
    const red = sdd(d, 'tdd', 'red', 'TEST-A-001');
    assert.equal(red.code, 0, red.out);
    const admission = JSON.parse(fs.readFileSync(path.join(d, '.sdd/tdd.jsonl'), 'utf8').trim().split('\n').at(-1)).admissionShas;
    assert.ok(Object.keys(admission).some((key) => key.endsWith(`|${selected}`)), JSON.stringify(admission));
    setCmd(d, PASS);
    const binary = path.join(d, selected), original = fs.readFileSync(binary);
    fs.appendFileSync(binary, Buffer.from([1]));
    const drift = sdd(d, 'tdd', 'green', 'TEST-A-001');
    assert.equal(drift.code, 1, drift.out);
    assert.match(drift.out, /check definition changed since Red/);
    fs.writeFileSync(binary, original);
    const restored = sdd(d, 'tdd', 'green', 'TEST-A-001');
    assert.equal(restored.code, 0, restored.out);
  });
}

test('r34a #357 unsupported selection refuses Green and both gates without rewriting evidence', () => {
  const d = r34aWrapperFixture('[build]\nrustc-wrapper = "tools/compiler"\n');
  assert.equal(sdd(d, 'tdd', 'red', 'TEST-A-001').code, 0);
  setCmd(d, PASS);
  assert.equal(sdd(d, 'tdd', 'green', 'TEST-A-001').code, 0);
  assert.equal(spawnSync('git', ['add', '-A'], { cwd: d }).status, 0);
  assert.equal(spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'valid wrapper evidence'], { cwd: d }).status, 0);
  const ledger = path.join(d, '.sdd/tdd.jsonl'), before = fs.readFileSync(ledger, 'utf8');
  for (const selection of [
    '[build]\nrustc-wrapper = "tools/compil\\er"\n',
    '[env.RUSTC_WRAPPER]\nvalue = "tools/compiler"\n',
    '[env]\nRUSTC_WRAPPER.value = "tools/compiler"\n',
    '[build]\nrustc-wrapper = "tools/compiler" + "ignored"\n',
  ]) {
    fs.writeFileSync(path.join(d, '.cargo/config.toml'), selection);
    for (const args of [['gate'], ['gate', '--changed', '--baseline', 'HEAD'], ['tdd', 'green', 'TEST-A-001']]) {
      const rejected = sdd(d, ...args);
      assert.equal(rejected.code, 1, rejected.out);
      assert.match(rejected.out, /REFUSED:.*Cargo.*wrapper/i);
      assert.equal(fs.readFileSync(ledger, 'utf8'), before);
    }
  }
  fs.writeFileSync(path.join(d, '.cargo/config.toml'), '[build]\nrustc-wrapper = "tools/compiler"\n');
  const restored = sdd(d, 'gate');
  assert.equal(restored.code, 0, restored.out);
});

test('r34a #357 quote-stripped CLI escapes explicitly refuse rather than guess a wrapper', () => {
  const d = r34aWrapperFixture('[build]\nrustc-wrapper = ""\n');
  const cp = path.join(d, '.sdd/config.json'), cfg = JSON.parse(fs.readFileSync(cp));
  cfg.checks = [{ name: 'test', cmd: ['sh', '-c', 'true # cargo --config build.rustc-wrapper="tools/compil\\u0065r" test'] }];
  fs.writeFileSync(cp, JSON.stringify(cfg));
  const red = sdd(d, 'tdd', 'red', 'TEST-A-001');
  assert.equal(red.code, 1, red.out);
  assert.match(red.out, /REFUSED:.*Cargo.*wrapper --config escape/);
  assert.ok(!fs.existsSync(path.join(d, '.sdd/tdd.jsonl')));
});

for (const relative of [true, false]) {
  test(`r34a #357 decoded env wrapper preserves nested check base (relative=${relative})`, () => {
    const d = r34aWrapperFixture(`[env]\nRUSTC_WRAPPER = { value = "tools/compil\\u0065r", relative = ${relative}, force = true }\n`);
    writeAll(d, { 'child/tools/compiler': Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0xfe]) });
    const cp = path.join(d, '.sdd/config.json'), cfg = JSON.parse(fs.readFileSync(cp));
    cfg.checks[0].cwd = 'child';
    fs.writeFileSync(cp, JSON.stringify(cfg));
    const red = sdd(d, 'tdd', 'red', 'TEST-A-001');
    assert.equal(red.code, 0, red.out);
    const admission = JSON.parse(fs.readFileSync(path.join(d, '.sdd/tdd.jsonl'), 'utf8').trim().split('\n').at(-1)).admissionShas;
    const selected = relative ? 'tools/compiler' : 'child/tools/compiler';
    assert.ok(Object.keys(admission).some((key) => key.endsWith(`|${selected}`)), JSON.stringify(admission));
    setCmd(d, PASS);
    const binary = path.join(d, selected), original = fs.readFileSync(binary);
    fs.appendFileSync(binary, Buffer.from([1]));
    const drift = sdd(d, 'tdd', 'green', 'TEST-A-001');
    assert.equal(drift.code, 1, drift.out);
    assert.match(drift.out, /check definition changed since Red/);
    fs.writeFileSync(binary, original);
    const restored = sdd(d, 'tdd', 'green', 'TEST-A-001');
    assert.equal(restored.code, 0, restored.out);
  });
}

test('r34a #357 multiline CRLF content selects the LF-normalized literal filename', () => {
  const d = r34aWrapperFixture("[build]\r\nrustc-wrapper = '''\r\ntools/compil\r\ner'''\r\n");
  const selected = 'tools/compil\ner';
  writeAll(d, { [selected]: Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0xfe]) });
  const red = sdd(d, 'tdd', 'red', 'TEST-A-001');
  assert.equal(red.code, 0, red.out);
  const admission = JSON.parse(fs.readFileSync(path.join(d, '.sdd/tdd.jsonl'), 'utf8').trim().split('\n').at(-1)).admissionShas;
  assert.ok(Object.keys(admission).some((key) => key.endsWith(`|${selected}`)), JSON.stringify(admission));
  setCmd(d, PASS);
  const binary = path.join(d, selected), original = fs.readFileSync(binary);
  fs.appendFileSync(binary, Buffer.from([1]));
  const drift = sdd(d, 'tdd', 'green', 'TEST-A-001');
  assert.equal(drift.code, 1, drift.out);
  assert.match(drift.out, /check definition changed since Red/);
  fs.writeFileSync(binary, original);
  const restored = sdd(d, 'tdd', 'green', 'TEST-A-001');
  assert.equal(restored.code, 0, restored.out);
});

for (const value of ['"tools/compil\\u0000r"', '"tools/compil\\xr"', '"""tools/compiler""""""', '"tools/compil\ner"']) {
  test(`r34a #357 invalid path or string boundary explicitly refuses (${JSON.stringify(value)})`, () => {
    const d = r34aWrapperFixture(`[build]\nrustc-wrapper = ${value}\n`);
    const red = sdd(d, 'tdd', 'red', 'TEST-A-001');
    assert.equal(red.code, 1, red.out);
    assert.match(red.out, /REFUSED:.*Cargo.*wrapper/i);
    assert.ok(!fs.existsSync(path.join(d, '.sdd/tdd.jsonl')));
  });
}

// #358 PASS: real assertion Red; selected oracle drift cannot establish Green or
// either gate verdict; restoring the reference and fixing production passes.
// Runner-specific condition knowledge is not inferred from a wrapper's output.
function r34bConditionFixture({ target = { node: './oracle/node.mjs', default: './oracle/fallback.mjs' }, field = 'imports', requireMode = false, flags = [], name = true, wildcard = false, relative = false } = {}) {
  const spec = field === 'imports' ? (wildcard ? '#expected/value' : '#expected') : (wildcard ? 'r34-reference/value' : 'r34-reference');
  const testFile = requireMode ? 'a.test.cjs' : 'a.test.mjs';
  const pkg = { ...(name ? { name: 'r34-reference' } : {}), type: 'module', [field]: { [field === 'imports' ? (wildcard ? '#expected/*' : '#expected') : (wildcard ? './*' : '.')]: target } };
  const body = requireMode
    ? "const {test} = require('node:test'); const assert = require('node:assert/strict');\nconst {answer} = require('./answer.cjs');\n"
    : "import {test} from 'node:test'; import assert from 'node:assert/strict';\nimport {answer} from './answer.mjs';\n";
  const oracleImport = relative ? './oracle/node.mjs' : spec;
  const files = {
    'package.json': JSON.stringify(pkg),
    [testFile]: body + (requireMode ? `const {expected} = require('${oracleImport}');\n` : `import {expected} from '${oracleImport}';\n`)
      + "/** @id TEST-A-001 @verifies REQ-A-001 */\ntest('TEST-A-001 independent reference', () => assert.equal(answer(), expected()));\n",
    [requireMode ? 'answer.cjs' : 'answer.mjs']: '/** @id CODE-A-001 @implements REQ-A-001 */\n' + (requireMode ? 'exports.answer' : 'export const answer') + ' = () => 1;\n',
  };
  for (const dir of ['oracle', 'oracle/custom', 'oracle/fallback']) for (const ext of ['mjs', 'cjs', 'ts']) {
    const file = dir === 'oracle' ? `oracle/${ext === 'cjs' ? 'require' : ext === 'ts' ? 'typed' : 'node'}.${ext}` : `${dir}/value.${ext}`;
    files[file] = ext === 'cjs' ? 'exports.expected = () => 2;\n' : 'export const expected = () => 2;\n';
  }
  files['oracle/fallback.mjs'] = 'export const expected = () => 2;\n';
  const d = mini(T1SPEC, files, ['node', ...flags, '--test', '--test-reporter=spec', '--test-name-pattern={id}', '{file}']);
  const cp = path.join(d, '.sdd/config.json');
  fs.writeFileSync(cp, JSON.stringify({ ...JSON.parse(fs.readFileSync(cp)), scopePolicy: 'strict', checks: [{ name: 'test', cmd: ['node', ...flags, '--test', '--test-reporter=spec', testFile] }] }));
  return { d, testFile };
}

test('r34b #358 valid relative and conditional resolution controls before drift', () => {
  for (const relative of [true, false]) {
    const { d } = r34bConditionFixture({ relative });
    const red = sdd(d, 'tdd', 'red', 'TEST-A-001');
    assert.equal(red.code, 0, red.out);
    assert.match(red.out, /AssertionError|1 !== 2/);
    fs.writeFileSync(path.join(d, 'answer.mjs'), '/** @id CODE-A-001 @implements REQ-A-001 */\nexport const answer = () => 2;\n');
    const green = sdd(d, 'tdd', 'green', 'TEST-A-001');
    assert.equal(green.code, 0, green.out);
    assert.equal(spawnSync('git', ['add', '-A'], { cwd: d }).status, 0);
    assert.equal(spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'valid condition control'], { cwd: d }).status, 0);
    for (const args of [['gate'], ['gate', '--changed', '--baseline', 'HEAD']]) {
      const gate = sdd(d, ...args);
      assert.equal(gate.code, 0, gate.out);
    }
  }
});

const r34bSelections = [
  ['ordered node before default', {}, 'oracle/node.mjs'],
  ['ordered default before node', { target: { default: './oracle/fallback.mjs', node: './oracle/node.mjs' } }, 'oracle/fallback.mjs'],
  ['ordered node before import', { target: { node: './oracle/node.mjs', import: './oracle/fallback.mjs' } }, 'oracle/node.mjs'],
  ['nested node/import conditions', { field: 'exports', target: { node: { import: './oracle/node.mjs', require: './oracle/require.cjs' }, default: './oracle/fallback.mjs' } }, 'oracle/node.mjs'],
  ['CommonJS require conditions', { requireMode: true, field: 'exports', target: { import: './oracle/fallback.mjs', require: './oracle/require.cjs', default: './oracle/fallback.mjs' } }, 'oracle/require.cjs'],
  ['configured runtime conditions', { flags: ['--conditions=qa'], target: { qa: { node: './oracle/custom/value.mjs' }, default: './oracle/fallback.mjs' } }, 'oracle/custom/value.mjs'],
  ['configured short runtime conditions', { flags: ['-C', 'qa'], field: 'exports', target: { qa: './oracle/custom/value.mjs', default: './oracle/fallback.mjs' } }, 'oracle/custom/value.mjs'],
  ['conditional imports wildcard without package name', { name: false, wildcard: true, target: { node: './oracle/custom/*.mjs', default: './oracle/fallback/*.mjs' } }, 'oracle/custom/value.mjs'],
  ['conditional exports wildcard', { field: 'exports', wildcard: true, target: { node: './oracle/custom/*.mjs', default: './oracle/fallback/*.mjs' } }, 'oracle/custom/value.mjs'],
];
for (const [label, options, selected] of r34bSelections) {
  test(`r34b #358 ${label} protects the runtime-selected oracle`, () => {
    const { d, testFile } = r34bConditionFixture(options);
    // Independent runtime confirms ordering and real assertion failure, not setup Red.
    const runtime = spawnSync('node', [...options.flags ?? [], '--test', testFile], { cwd: d, encoding: 'utf8', env: ENV });
    assert.equal(runtime.status, 1, runtime.stdout + runtime.stderr);
    assert.match(runtime.stdout + runtime.stderr, /AssertionError|1 !== 2/);
    const red = sdd(d, 'tdd', 'red', 'TEST-A-001');
    assert.equal(red.code, 0, red.out);
    assert.match(red.out, /AssertionError|1 !== 2/);
    const ledger = path.join(d, '.sdd/tdd.jsonl'), before = fs.readFileSync(ledger, 'utf8');
    const original = fs.readFileSync(path.join(d, selected), 'utf8');
    fs.writeFileSync(path.join(d, selected), original.replace('=> 2', '=> 1'));
    const green = sdd(d, 'tdd', 'green', 'TEST-A-001');
    assert.equal(green.code, 1, `selected source ${selected} must reject Green:\n${green.out}`);
    assert.match(green.out, /oracle|changed since Red/i);
    assert.equal(fs.readFileSync(ledger, 'utf8'), before);
    fs.writeFileSync(path.join(d, selected), original);
    const production = options.requireMode ? 'answer.cjs' : 'answer.mjs';
    fs.writeFileSync(path.join(d, production), fs.readFileSync(path.join(d, production), 'utf8').replace('=> 1', '=> 2'));
    const restored = sdd(d, 'tdd', 'green', 'TEST-A-001');
    assert.equal(restored.code, 0, restored.out);
    const evidence = JSON.parse(fs.readFileSync(ledger, 'utf8').trim().split('\n').at(-1));
    assert.ok(evidence.protectedFiles.includes(selected), JSON.stringify(evidence.protectedFiles));
    assert.equal(spawnSync('git', ['add', '-A'], { cwd: d }).status, 0);
    assert.equal(spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'condition oracle baseline'], { cwd: d }).status, 0);
    for (const args of [['gate'], ['gate', '--changed', '--baseline', 'HEAD']]) {
      const valid = sdd(d, ...args);
      assert.equal(valid.code, 0, valid.out);
    }
    fs.writeFileSync(path.join(d, selected), original.replace('=> 2', '=> 3'));
    for (const args of [['gate'], ['gate', '--changed', '--baseline', 'HEAD']]) {
      const stale = sdd(d, ...args);
      assert.equal(stale.code, 1, stale.out);
      assert.match(stale.out, /oracle|changed|stale|test edited/i);
    }
    fs.writeFileSync(path.join(d, selected), original);
    const recheck = sdd(d, 'gate');
    assert.equal(recheck.code, 0, recheck.out);
  });
}

test('r34b #358 exact runtime suffix wins over a TypeScript sibling', () => {
  const { d } = r34bConditionFixture();
  fs.writeFileSync(path.join(d, 'oracle/node.ts'), 'export const expected = () => 99;\n');
  assert.equal(sdd(d, 'tdd', 'red', 'TEST-A-001').code, 0);
  const event = JSON.parse(fs.readFileSync(path.join(d, '.sdd/tdd.jsonl'), 'utf8').trim().split('\n').at(-1));
  assert.ok(event.protectedFiles?.includes('oracle/node.mjs'), JSON.stringify(event.protectedFiles));
});

test('r34b #358 uncertain branches widen to every local target, never fallback success', () => {
  const { d } = r34bConditionFixture({ target: { qa: './oracle/custom/value.mjs', node: './oracle/node.mjs', default: './oracle/fallback.mjs' } });
  assert.equal(sdd(d, 'tdd', 'red', 'TEST-A-001').code, 0);
  const event = JSON.parse(fs.readFileSync(path.join(d, '.sdd/tdd.jsonl'), 'utf8').trim().split('\n').at(-1));
  for (const target of ['oracle/custom/value.mjs', 'oracle/node.mjs', 'oracle/fallback.mjs'])
    assert.ok(event.protectedFiles?.includes(target), `conservative closure omitted ${target}: ${JSON.stringify(event.protectedFiles)}`);
});

test('r34b #358 unsupported nonlocal conditional target fails actionably before evidence', () => {
  const { d } = r34bConditionFixture({ target: { node: './oracle/node.mjs', qa: 'unmodeled-reference', default: './oracle/fallback.mjs' } });
  const red = sdd(d, 'tdd', 'red', 'TEST-A-001');
  assert.equal(red.code, 1, red.out);
  assert.match(red.out, /REFUSED: unresolved Node package target #expected.*package\.json.*local literal|explicit relative oracle imports/);
  assert.ok(!fs.existsSync(path.join(d, '.sdd/tdd.jsonl')));
});

test('r34b #358 TypeScript paths and emitted-source impact remain conservative', () => {
  const d = mini(T1SPEC, {
    'package.json': JSON.stringify({ name: 'r34-ts', type: 'module', exports: { '.': './dist/index.js', './*': './dist/*.js' } }),
    'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@r34/*': ['src/*'] } } }),
    'src/index.ts': 'export const expected = () => 2;\n',
    'src/value.ts': 'export const expected = () => 2;\n',
    'a.test.ts': "import 'r34-ts'; import 'r34-ts/value'; import '@r34/value';\n// @id TEST-A-001 @verifies REQ-A-001\n",
  }, FAIL);
  for (const source of ['src/index.ts', 'src/value.ts']) {
    const impact = sdd(d, 'impact', source, '--json');
    assert.equal(impact.code, 0, impact.out);
    assert.ok(JSON.parse(impact.out).reachedFiles.includes('a.test.ts'), impact.out);
  }
});

test('r34b #358 package imports stay inside the nearest package scope', () => {
  const d = mini(T1SPEC, {
    'package.json': JSON.stringify({ name: 'outer', imports: { '#expected': { node: './oracle/node.mjs', default: './oracle/fallback.mjs' } } }),
    'nested/package.json': JSON.stringify({ name: 'inner', type: 'module', imports: { '#expected': { node: './oracle/inner.mjs', default: './oracle/fallback.mjs' } } }),
    'oracle/node.mjs': 'export const expected = () => 2;\n',
    'oracle/fallback.mjs': 'export const expected = () => 2;\n',
    'nested/oracle/inner.mjs': 'export const expected = () => 2;\n',
    'nested/oracle/fallback.mjs': 'export const expected = () => 2;\n',
    'nested/a.test.mjs': "import '#expected';\n// @id TEST-A-001 @verifies REQ-A-001\n",
  }, FAIL);
  const red = sdd(d, 'tdd', 'red', 'TEST-A-001');
  assert.equal(red.code, 0, red.out);
  const event = JSON.parse(fs.readFileSync(path.join(d, '.sdd/tdd.jsonl'), 'utf8').trim().split('\n').at(-1));
  assert.ok(event.protectedFiles.includes('nested/oracle/inner.mjs'), JSON.stringify(event.protectedFiles));
  assert.ok(!event.protectedFiles.includes('oracle/node.mjs'), JSON.stringify(event.protectedFiles));
});

test('r34b #358 impact includes every nested conditional source rather than one fallback', () => {
  const { d } = r34bConditionFixture({ field: 'exports', target: { node: { import: './oracle/node.mjs', require: './oracle/require.cjs' }, qa: './oracle/custom/value.mjs', default: './oracle/fallback.mjs' } });
  for (const source of ['oracle/node.mjs', 'oracle/require.cjs', 'oracle/custom/value.mjs', 'oracle/fallback.mjs']) {
    const impact = sdd(d, 'impact', source, '--json');
    assert.equal(impact.code, 0, impact.out);
    assert.ok(JSON.parse(impact.out).reachedFiles.includes('a.test.mjs'), `missing conditional edge ${source}: ${impact.out}`);
  }
});

test('r34b #358 unmodeled wildcard suffix refuses instead of silently dropping the oracle', () => {
  const { d } = r34bConditionFixture();
  fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ name: 'r34-reference', type: 'module', imports: { '#expected/*.mjs': { node: './oracle/custom/*.mjs', default: './oracle/fallback/*.mjs' } } }));
  fs.writeFileSync(path.join(d, 'a.test.mjs'), fs.readFileSync(path.join(d, 'a.test.mjs'), 'utf8').replace("'#expected'", "'#expected/value.mjs'"));
  const runtime = spawnSync('node', ['--test', 'a.test.mjs'], { cwd: d, encoding: 'utf8', env: ENV });
  assert.equal(runtime.status, 1, runtime.stdout + runtime.stderr);
  assert.match(runtime.stdout + runtime.stderr, /AssertionError|1 !== 2/);
  const red = sdd(d, 'tdd', 'red', 'TEST-A-001');
  assert.equal(red.code, 1, red.out);
  assert.match(red.out, /REFUSED: unresolved Node package target #expected\/value\.mjs/);
  assert.ok(!fs.existsSync(path.join(d, '.sdd/tdd.jsonl')));
});

const r34cPluginFiles = (plugin = 'from .helper import EXPECTED\n') => ({
  'conftest.py': 'pytest_plugins = ("qa.plugin",)\n',
  'src/qa/__init__.py': '',
  'src/qa/plugin.py': plugin,
  'src/qa/helper.py': 'EXPECTED = 2\n',
});

/** @id TEST-R34-PYREL-001 @verifies REQ-CHECK-CLOSURE-001 */
test('TEST-R34-PYREL-001 r34c #359 Python plugin closure protects all declared relative forms', () => {
for (const [label, files, protectedFile] of [
  ['sibling helper', r34cPluginFiles(), 'src/qa/helper.py'],
  ['parenthesized submodule alias', r34cPluginFiles('from . import (\n    helper as oracle,\n)\n'), 'src/qa/helper.py'],
  ['parent package level', { ...r34cPluginFiles(), 'conftest.py': 'pytest_plugins = "qa.nested.plugin"\n', 'src/qa/nested/__init__.py': '', 'src/qa/nested/plugin.py': 'from ..helper import EXPECTED\n' }, 'src/qa/helper.py'],
  ['dotted relative package', { ...r34cPluginFiles('from .refs.oracle import EXPECTED\n'), 'src/qa/refs/__init__.py': '', 'src/qa/refs/oracle.py': 'EXPECTED = 2\n' }, 'src/qa/refs/__init__.py'],
  ['plugin package initializer', { ...r34cPluginFiles(), 'src/qa/plugin.py': undefined, 'src/qa/plugin/__init__.py': 'from .helper import EXPECTED\n', 'src/qa/plugin/helper.py': 'EXPECTED = 2\n' }, 'src/qa/plugin/helper.py'],
  ['transitive relative helper', { ...r34cPluginFiles(), 'src/qa/helper.py': 'from .refs import oracle\nEXPECTED = oracle.EXPECTED\n', 'src/qa/refs/__init__.py': '', 'src/qa/refs/oracle.py': 'EXPECTED = 2\n' }, 'src/qa/refs/oracle.py'],
  ['package initializer oracle', { ...r34cPluginFiles('from . import EXPECTED\n'), 'src/qa/__init__.py': 'from .helper import EXPECTED\n' }, 'src/qa/helper.py'],
  ['namespace package context', { ...r34cPluginFiles(), 'src/qa/__init__.py': undefined }, 'src/qa/helper.py'],
  ['absolute import control', r34cPluginFiles('from qa.helper import EXPECTED\n'), 'src/qa/helper.py'],
  ['parent initializer provenance', r34cPluginFiles(), 'src/qa/__init__.py'],
]) {
    const d = r31aFixture(Object.fromEntries(Object.entries(files).filter(([, text]) => text !== undefined)),
      [{ name: 'test', cmd: ['sh', '-c', 'true # python3 -m pytest'] }]);
    const ledger = path.join(d, '.sdd/tdd.jsonl');
    const before = fs.readFileSync(ledger, 'utf8');
    const evidence = JSON.parse(before.trim().split('\n').at(-1));
    assert.ok(Object.keys(evidence.checkDefShas).some((key) => key.endsWith(`|${protectedFile}`)), protectedFile);
    for (const args of [['gate'], ['gate', '--changed', '--baseline', 'HEAD']]) {
      const valid = sdd(d, ...args);
      assert.equal(valid.code, 0, valid.out);
    }
    fs.appendFileSync(path.join(d, protectedFile), '# oracle provenance changed\n');
    const green = sdd(d, 'tdd', 'green', 'TEST-A-001');
    assert.equal(green.code, 1, green.out);
    assert.match(green.out, /changed|drift|definition/i);
    assert.equal(fs.readFileSync(ledger, 'utf8'), before);
    r31aDrift(d, protectedFile);
}
});

/** @id TEST-R34-PYREL-002 @verifies REQ-CHECK-CLOSURE-001 */
test('TEST-R34-PYREL-002 r34c #359 protected Python inputs fail closed for unresolved relative forms', () => {
for (const [label, plugin, extra] of [
  ['missing relative helper', 'from .missing import EXPECTED\n', { 'src/other/missing.py': 'EXPECTED = 2\n', 'src/missing.py': 'EXPECTED = 2\n' }],
  ['missing imported submodule', 'from . import missing\n', {}],
  ['beyond top-level package', 'from ..helper import EXPECTED\n', { 'src/helper.py': 'EXPECTED = 2\n' }],
  ['ambiguous module and package', 'from .helper import EXPECTED\n', { 'src/qa/helper/__init__.py': 'EXPECTED = 2\n' }],
]) {
    const d = r31aFixture(r34cPluginFiles(), [{ name: 'test', cmd: ['sh', '-c', 'true # pytest'] }]);
    for (const [f, text] of Object.entries(extra)) {
      fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true });
      fs.writeFileSync(path.join(d, f), text);
    }
    fs.writeFileSync(path.join(d, 'src/qa/plugin.py'), plugin);
    const ledger = path.join(d, '.sdd/tdd.jsonl'), before = fs.readFileSync(ledger, 'utf8');
    for (const args of [['tdd', 'green', 'TEST-A-001'], ['gate'], ['gate', '--changed', '--baseline', 'HEAD']]) {
      const result = sdd(d, ...args);
      assert.equal(result.code, 1, result.out);
      assert.match(result.out, /REFUSED: unresolved Python (?:relative import|module)/, result.out);
      assert.equal(fs.readFileSync(ledger, 'utf8'), before);
    }
}
});

/** @id TEST-R34-PYREL-003 @verifies REQ-CHECK-CLOSURE-001 */
test('TEST-R34-PYREL-003 r34c #359 module attributes are not sibling submodules and package boundaries stay local', () => {
  const d = r31aFixture({
    ...r34cPluginFiles(),
    'src/qa/helper.py': 'EXPECTED, UNUSED = 2, 3\n',
    'src/qa/helper/EXPECTED.py': 'UNRELATED = 1\n',
    'src/other/__init__.py': '',
    'src/other/helper.py': 'EXPECTED = 100\n',
  }, [{ name: 'test', cmd: ['sh', '-c', 'true # pytest'] }]);
  const evidence = JSON.parse(fs.readFileSync(path.join(d, '.sdd/tdd.jsonl'), 'utf8').trim().split('\n').at(-1));
  const keys = Object.keys(evidence.checkDefShas);
  assert.ok(keys.some((key) => key.endsWith('|src/qa/helper.py')));
  assert.ok(!keys.some((key) => /src\/(?:other\/helper|qa\/helper\/EXPECTED)\.py$/.test(key)));
  fs.appendFileSync(path.join(d, 'src/other/helper.py'), '# unrelated\n');
  fs.appendFileSync(path.join(d, 'src/qa/helper/EXPECTED.py'), '# unrelated\n');
  for (const args of [['gate'], ['gate', '--changed', '--baseline', 'HEAD']]) {
    const result = sdd(d, ...args);
    assert.equal(result.code, 0, result.out);
  }
});

/** @id TEST-R34-PYREL-004 @verifies REQ-CHECK-CLOSURE-001 */
test('TEST-R34-PYREL-004 r34c #359 deleted relative helper cannot disappear from protected inputs', () => {
  const d = r31aFixture(r34cPluginFiles(), [{ name: 'test', cmd: ['sh', '-c', 'true # pytest'] }]);
  fs.unlinkSync(path.join(d, 'src/qa/helper.py'));
  for (const args of [['tdd', 'green', 'TEST-A-001'], ['gate'], ['gate', '--changed', '--baseline', 'HEAD']]) {
    const result = sdd(d, ...args);
    assert.equal(result.code, 1, result.out);
    assert.match(result.out, /REFUSED: unresolved Python relative import/);
  }
});

/** @id TEST-R34-PYREL-005 @verifies REQ-CHECK-CLOSURE-001 */
test('TEST-R34-PYREL-005 r34c #359 real relative-plugin oracle rejects wrong Green and gates and accepts restored answer', () => {
  assert.ok(r32cPythonAvailable, 'real pytest is required for the relative-plugin oracle control');
  const d = mini(T1SPEC, {
    ...r34cPluginFiles('import pytest\nfrom .helper import EXPECTED\n@pytest.fixture\ndef oracle():\n    return EXPECTED\n'),
    'pytest.ini': '[pytest]\npythonpath = src\n',
    'test_a.py': 'from subject import answer\n# @id TEST-A-001 @verifies REQ-A-001\ndef test_a_001(oracle):\n    assert answer() == oracle\n',
    'src/subject.py': '# @id CODE-A-001 @implements REQ-A-001\ndef answer():\n    return 1\n',
  }, ['python3', '-m', 'pytest', '-q', 'test_a.py', '-k', '{idu}']);
  const cp = path.join(d, '.sdd/config.json');
  fs.writeFileSync(cp, JSON.stringify({
    ...JSON.parse(fs.readFileSync(cp)), scan: { include: ['test_a.py', 'src/subject.py'] },
    scopePolicy: 'strict', checks: [{ name: 'test', cmd: ['python3', '-m', 'pytest', '-q'] }],
  }));
  const red = sdd(d, 'tdd', 'red', 'TEST-A-001');
  assert.equal(red.code, 0, red.out);
  assert.match(red.out, /assert 1 == 2/);
  const ledger = path.join(d, '.sdd/tdd.jsonl'), before = fs.readFileSync(ledger, 'utf8');
  r34IntegrationWritePython(path.join(d, 'src/qa/helper.py'), 'EXPECTED = 1\n');
  const wrong = sdd(d, 'tdd', 'green', 'TEST-A-001');
  assert.equal(wrong.code, 1, wrong.out);
  assert.match(wrong.out, /changed|drift|definition/i);
  assert.equal(fs.readFileSync(ledger, 'utf8'), before);
  r34IntegrationWritePython(path.join(d, 'src/qa/helper.py'), 'EXPECTED = 2\n');
  r34IntegrationWritePython(path.join(d, 'src/subject.py'), '# @id CODE-A-001 @implements REQ-A-001\ndef answer():\n    return 2\n');
  const green = sdd(d, 'tdd', 'green', 'TEST-A-001');
  assert.equal(green.code, 0, green.out);
  assert.equal(spawnSync('git', ['add', '-A'], { cwd: d }).status, 0);
  assert.equal(spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'valid oracle'], { cwd: d }).status, 0);
  for (const args of [['gate'], ['gate', '--changed', '--baseline', 'HEAD']]) {
    const valid = sdd(d, ...args);
    assert.equal(valid.code, 0, valid.out);
  }
  r34IntegrationWritePython(path.join(d, 'src/qa/helper.py'), 'EXPECTED = 1\n');
  r34IntegrationWritePython(path.join(d, 'src/subject.py'), '# @id CODE-A-001 @implements REQ-A-001\ndef answer():\n    return 1\n');
  for (const args of [['gate'], ['gate', '--changed', '--baseline', 'HEAD']]) {
    const drift = sdd(d, ...args);
    assert.equal(drift.code, 1, drift.out);
    assert.match(drift.out, /helper\.py.*changed|helper\.py.*defin|defin.*helper\.py/, drift.out);
  }
  r34IntegrationWritePython(path.join(d, 'src/qa/helper.py'), 'EXPECTED = 2\n');
  r34IntegrationWritePython(path.join(d, 'src/subject.py'), '# @id CODE-A-001 @implements REQ-A-001\ndef answer():\n    return 2\n');
  assert.equal(sdd(d, 'tdd', 'refactor', 'TEST-A-001').code, 0);
  const restored = sdd(d, 'gate');
  assert.equal(restored.code, 0, restored.out);
});

/** @id TEST-R34-PYREL-006 @verifies REQ-CHECK-CLOSURE-001 */
test('TEST-R34-PYREL-006 r34c #359 absolute local controls fail closed for unresolved forms', () => {
for (const [label, plugin, extra] of [
  ['missing absolute local module', 'from qa.missing import EXPECTED\n', {}],
  ['missing absolute package child', 'from qa import missing\n', {}],
  ['ambiguous literal plugin roots', 'from .helper import EXPECTED\n', { 'qa/__init__.py': '', 'qa/plugin.py': 'EXPECTED = 2\n' }],
]) {
    const d = r31aFixture(r34cPluginFiles(), [{ name: 'test', cmd: ['sh', '-c', 'true # pytest'] }]);
    fs.writeFileSync(path.join(d, 'src/qa/plugin.py'), plugin);
    for (const [f, text] of Object.entries(extra)) {
      fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true });
      fs.writeFileSync(path.join(d, f), text);
    }
    const ledger = path.join(d, '.sdd/tdd.jsonl'), before = fs.readFileSync(ledger, 'utf8');
    for (const args of [['tdd', 'green', 'TEST-A-001'], ['gate'], ['gate', '--changed', '--baseline', 'HEAD']]) {
      const result = sdd(d, ...args);
      assert.equal(result.code, 1, result.out);
      assert.match(result.out, /REFUSED: unresolved Python (?:module|relative import)/);
      assert.equal(fs.readFileSync(ledger, 'utf8'), before);
    }
}
});

/** @id TEST-R34-PYREL-007 @verifies REQ-CHECK-CLOSURE-001 */
test('TEST-R34-PYREL-007 r34c #359 namespace absolute imports and relative star imports retain helper provenance', () => {
  for (const plugin of ['from qa import helper as oracle\n', 'from .helper import *\n', 'from .helper import EXPECTED as oracle\n']) {
    const files = r34cPluginFiles(plugin);
    delete files['src/qa/__init__.py'];
    const d = r31aFixture(files, [{ name: 'test', cmd: ['sh', '-c', 'true # pytest'] }]);
    const evidence = JSON.parse(fs.readFileSync(path.join(d, '.sdd/tdd.jsonl'), 'utf8').trim().split('\n').at(-1));
    assert.ok(Object.keys(evidence.checkDefShas).some((key) => key.endsWith('|src/qa/helper.py')), plugin);
    const valid = sdd(d, 'gate');
    assert.equal(valid.code, 0, valid.out);
    fs.writeFileSync(path.join(d, 'src/qa/helper.py'), 'EXPECTED = 1\n');
    const green = sdd(d, 'tdd', 'green', 'TEST-A-001');
    assert.equal(green.code, 1, green.out);
    assert.match(green.out, /definition changed since Red/);
  }
});

/** @id TEST-R34-PYREL-008 @verifies REQ-CHECK-CLOSURE-001 */
test('TEST-R34-PYREL-008 r34c #359 deleted package initializer cannot silently become an unpinned namespace', () => {
  const d = r31aFixture(r34cPluginFiles(), [{ name: 'test', cmd: ['sh', '-c', 'true # pytest'] }]);
  fs.unlinkSync(path.join(d, 'src/qa/__init__.py'));
  const green = sdd(d, 'tdd', 'green', 'TEST-A-001');
  assert.equal(green.code, 1, green.out);
  assert.match(green.out, /__init__\.py/);
  r31aDrift(d, 'src/qa/__init__.py');
});

/** @id TEST-R34-PYREL-009 @verifies REQ-CHECK-CLOSURE-001 */
test('TEST-R34-PYREL-009 r34c #359 parent modules cannot masquerade as regular or namespace packages', () => {
  for (const namespace of [false, true]) {
    const files = r34cPluginFiles();
    if (namespace) delete files['src/qa/__init__.py'];
    const d = r31aFixture(files, [{ name: 'test', cmd: ['sh', '-c', 'true # pytest'] }]);
    fs.writeFileSync(path.join(d, 'src/qa.py'), 'EXPECTED = 1\n');
    for (const args of [['tdd', 'green', 'TEST-A-001'], ['gate'], ['gate', '--changed', '--baseline', 'HEAD']]) {
      const result = sdd(d, ...args);
      assert.equal(result.code, 1, result.out);
      assert.match(result.out, /REFUSED: unresolved Python module.*non-package parent/);
    }
  }
});

/** @id TEST-R34-PYREL-010 @verifies REQ-CHECK-CLOSURE-001 */
test('TEST-R34-PYREL-010 r34c #359 continued relative import statements protect their helper', () => {
  const d = r31aFixture(r34cPluginFiles('from .helper \\\n    import EXPECTED\n'),
    [{ name: 'test', cmd: ['sh', '-c', 'true # pytest'] }]);
  const evidence = JSON.parse(fs.readFileSync(path.join(d, '.sdd/tdd.jsonl'), 'utf8').trim().split('\n').at(-1));
  assert.ok(Object.keys(evidence.checkDefShas).some((key) => key.endsWith('|src/qa/helper.py')));
  const valid = sdd(d, 'gate');
  assert.equal(valid.code, 0, valid.out);
  fs.writeFileSync(path.join(d, 'src/qa/helper.py'), 'EXPECTED = 1\n');
  const green = sdd(d, 'tdd', 'green', 'TEST-A-001');
  assert.equal(green.code, 1, green.out);
});

function r34dPytestFixture(declaration = "pytest_plugins = ('qa_hooks',)") {
  assert.ok(r32cPythonAvailable, '#360 requires real pytest; missing pytest is not passing evidence');
  const d = mini(T1SPEC, {
    'pytest.ini': '[pytest]\npythonpath = src\n',
    'test_a.py': 'from subject import answer\n# @id TEST-A-001 @verifies REQ-A-001\ndef test_a_001():\n    assert answer() == 1\n',
    'conftest.py': `${declaration}\n`,
    'src/qa_hooks.py': 'def pytest_collection_modifyitems(items):\n    pass\n',
    'src/subject.py': '# @id CODE-A-001 @implements REQ-A-001\ndef answer():\n    return 0\n',
  }, ['python3', '-m', 'pytest', '-q', 'test_a.py', '-k', '{idu}']);
  const cp = path.join(d, '.sdd/config.json');
  fs.writeFileSync(cp, JSON.stringify({
    ...JSON.parse(fs.readFileSync(cp)), scan: { include: ['test_a.py', 'src/subject.py'] },
    checks: [{ name: 'test', cmd: ['python3', '-m', 'pytest', '-q'] }],
  }));
  return d;
}

/** @id TEST-R34-PYTEST-001 @verifies REQ-R33-PYTEST-001 */
test('TEST-R34-PYTEST-001 r34d #360 semicolon computed reassignment is refused before real assertion Red or evidence append', () => {
  const d = r34dPytestFixture("pytest_plugins = ('qa_hooks',); pytest_plugins = tuple(['qa_hooks'])");
  fs.appendFileSync(path.join(d, 'src/qa_hooks.py'), 'from pathlib import Path\nPath(".sdd/plugin-ran").write_text("executed")\n');
  const red = sdd(d, 'tdd', 'red', 'TEST-A-001');
  assert.equal(red.code, 1, red.out);
  assert.match(red.out, /REFUSED: unresolved pytest_plugins.*conftest\.py/);
  assert.ok(!fs.existsSync(path.join(d, '.sdd/tdd.jsonl')));
  assert.ok(!fs.existsSync(path.join(d, '.sdd/plugin-ran')));
});

/** @id TEST-R34-PYTEST-002 @verifies REQ-R33-PYTEST-001 */
test('TEST-R34-PYTEST-002 r34d #360 all statement admission rejects unresolved grammar', () => {
for (const declaration of [
  "pytest_plugins = ('qa_hooks',); pytest_plugins = tuple(['qa_hooks'])",
  "other = 1; pytest_plugins = PLUGINS",
  "pytest_plugins = ('qa_hooks',); pytest_plugins += ['qa_hooks']",
  "pytest_plugins = ('qa_hooks',); pytest_plugins *= 2",
  "pytest_plugins = ('qa_hooks',); pytest_plugins: list[str] = ['qa_' + 'hooks']",
  "pytest_plugins = ('qa_hooks',); \\\npytest_plugins = tuple(['qa_hooks'])",
  "pytest_plugins = \\\ntuple(['qa_hooks'])",
  "pytest_plugins = ('qa_hooks',); alias = pytest_plugins = ['qa_hooks']",
  "pytest_plugins = ('qa_hooks',); pytest_plugins[0] = 'other'",
  "pytest_plugins = ('qa_hooks',); pytest_plugins = ['qa_hooks'",
  "pytest_plugins = ('qa_hooks',); pytest_plugins = 'qa_hooks' \\\n+ EXTRA",
]) {
    const d = r31aFixture({
      'conftest.py': "pytest_plugins = ['qa_hooks']\n",
      'src/qa_hooks.py': 'def pytest_collection_modifyitems(items):\n    pass\n',
    }, [{ name: 'test', cmd: ['sh', '-c', 'true # pytest'] }]);
    fs.writeFileSync(path.join(d, 'conftest.py'), `${declaration}\n`);
    const ledger = path.join(d, '.sdd/tdd.jsonl'), before = fs.readFileSync(ledger, 'utf8');
    const cp = path.join(d, '.sdd/config.json'), cfg = JSON.parse(fs.readFileSync(cp));
    for (const scopePolicy of ['warn', 'strict']) {
      fs.writeFileSync(cp, JSON.stringify({ ...cfg, scopePolicy }));
      for (const args of [
        ['tdd', 'red', 'TEST-A-001'], ['tdd', 'green', 'TEST-A-001'], ['tdd', 'refactor', 'TEST-A-001'],
        ['gate'], ['gate', '--changed', '--baseline', 'HEAD'],
      ]) {
        const result = sdd(d, ...args);
        assert.equal(result.code, 1, result.out);
        assert.match(result.out, /REFUSED: unresolved pytest_plugins.*conftest\.py/, result.out);
        assert.equal(fs.readFileSync(ledger, 'utf8'), before);
      }
    }
}
});

/** @id TEST-R34-PYTEST-003 @verifies REQ-R33-PYTEST-001 */
test('TEST-R34-PYTEST-003 r34d #360 literal controls preserve real assertion Red Green and full changed gates', () => {
  for (const declaration of [
    "pytest_plugins = 'qa_hooks'; snapshot = pytest_plugins",
    "pytest_plugins = ['qa_hooks']",
    "pytest_plugins = (\n 'qa_hooks', # ; pytest_plugins = computed()\n)",
    "note = '; pytest_plugins = computed()'; pytest_plugins = ('qa_hooks',); pytest_plugins = ['qa_hooks']",
    'note = """\npytest_plugins = computed(); ignored\n"""\npytest_plugins = ["qa_hooks"]',
    "pytest_plugins: tuple[str, ...] = \\\n('qa_hooks',) # ; pytest_plugins += EXTRA",
    "other = 1; \\\npytest_plugins = [\n 'qa_hooks', # comment with ;\n]",
  ]) {
    const d = r34dPytestFixture(declaration);
    const red = sdd(d, 'tdd', 'red', 'TEST-A-001');
    assert.equal(red.code, 0, red.out);
    assert.match(red.out, /fails with: assert 0 == 1/);
    r34IntegrationWritePython(path.join(d, 'src/subject.py'), '# @id CODE-A-001 @implements REQ-A-001\ndef answer():\n    return 1\n');
    const green = sdd(d, 'tdd', 'green', 'TEST-A-001');
    assert.equal(green.code, 0, green.out);
    assert.equal(spawnSync('git', ['add', '-A'], { cwd: d }).status, 0);
    assert.equal(spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', '#360 literal control'], { cwd: d }).status, 0);
    for (const args of [['tdd', 'refactor', 'TEST-A-001'], ['gate'], ['gate', '--changed', '--baseline', 'HEAD']]) {
      const result = sdd(d, ...args);
      assert.equal(result.code, 0, result.out);
    }
    const evidence = fs.readFileSync(path.join(d, '.sdd/tdd.jsonl'), 'utf8');
    assert.match(evidence, /qa_hooks\.py/);
  }
});

/** @id TEST-R34-PYTEST-004 @verifies REQ-R33-PYTEST-001 */
test('TEST-R34-PYTEST-004 r34d #360 shared lexical discovery admits non-hook files and rejects later computed binding', () => {
  const d = r31aFixture({
    'src/settings.py': "other = 1; pytest_plugins = ['qa_hooks']\n",
    'src/qa_hooks.py': 'def pytest_collection_modifyitems(items):\n    pass\n',
  }, [{ name: 'test', cmd: ['sh', '-c', 'true # pytest'] }]);
  const ledger = path.join(d, '.sdd/tdd.jsonl'), before = fs.readFileSync(ledger, 'utf8');
  assert.match(before, /settings\.py/);
  assert.match(before, /qa_hooks\.py/);
  fs.appendFileSync(path.join(d, 'src/settings.py'), "other = 2; pytest_plugins = tuple(['qa_hooks'])\n");
  for (const args of [['tdd', 'green', 'TEST-A-001'], ['gate'], ['gate', '--changed', '--baseline', 'HEAD']]) {
    const result = sdd(d, ...args);
    assert.equal(result.code, 1, result.out);
    assert.match(result.out, /REFUSED: unresolved pytest_plugins.*src\/settings\.py/);
    assert.equal(fs.readFileSync(ledger, 'utf8'), before);
  }
});

// r34 #361: observable annotated execution, not reporter silence or an ID-bearing container.
function r34eNodeFixture(reporter = 'spec', parent = false) {
  const flags = reporter ? [`--test-reporter=${reporter}`] : [];
  const d = mini(T1SPEC, {
    'a.test.mjs': [
      "import test from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import fs from 'node:fs';",
      "import { answer } from './answer.mjs';",
      "const state = fs.existsSync('.sdd/outcome') ? fs.readFileSync('.sdd/outcome', 'utf8') : '';",
      "const retry = fs.existsSync('.sdd/retry-mode');",
      "const first = retry && !fs.existsSync('.sdd/attempt');",
      "if (retry) fs.writeFileSync('.sdd/attempt', 'ran');",
      ...(parent ? ["test('TEST-A-001 container', async (t) => {"] : []),
      '/** @id TEST-A-001 @verifies REQ-A-001 */',
      `${parent ? 'await t.test' : 'test'}('TEST-A-001 child', { skip: state === 'skip' && !first, todo: state === 'todo' && !first }, () => {`,
      "  assert.equal(answer(), 1);",
      "  if (first) assert.fail('native first attempt');",
      '});',
      ...(parent ? ['});'] : []),
      "test('unannotated control', () => assert.ok(true));",
      "test('optional unannotated skip', { skip: true }, () => assert.fail());",
      '',
    ].join('\n'),
    'answer.mjs': '// @id CODE-A-001 @implements REQ-A-001\nexport const answer = () => 0;\n',
  });
  const cp = path.join(d, '.sdd/config.json');
  const cfg = { ...JSON.parse(fs.readFileSync(cp)), scopePolicy: 'warn',
    scan: { include: ['a.test.mjs', 'answer.mjs'] },
    testCmd: ['node', '--test', ...flags, '--test-name-pattern', '{id}', '{file}'],
    checks: [{ name: 'test', cmd: ['node', '--test', ...flags, 'a.test.mjs'],
      changedCmd: ['node', '--test', ...flags, '{changedTests}'] }],
    flaky: { retries: 1, policy: 'warn' } };
  fs.writeFileSync(cp, JSON.stringify(cfg));
  const red = sdd(d, 'tdd', 'red', 'TEST-A-001');
  assert.equal(red.code, 0, red.out);
  fs.writeFileSync(path.join(d, 'answer.mjs'), '// @id CODE-A-001 @implements REQ-A-001\nexport const answer = () => 1;\n');
  const green = sdd(d, 'tdd', 'green', 'TEST-A-001');
  assert.equal(green.code, 0, green.out);
  assert.equal(spawnSync('git', ['add', '-A'], { cwd: d }).status, 0);
  assert.equal(spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'r34 native evidence'], { cwd: d }).status, 0);
  fs.appendFileSync(path.join(d, 'a.test.mjs'), '\n');
  return { d, cp, cfg, ledger: path.join(d, '.sdd/tdd.jsonl') };
}

/** @id TEST-R34-NODE-001 @verifies REQ-R34-NODE-001 */
test('TEST-R34-NODE-001 r34e #361 opaque native reporters cannot establish TDD or full/changed gate coverage', () => {
  const { d, cp, cfg, ledger } = r34eNodeFixture();
  const before = fs.readFileSync(ledger, 'utf8');
  cfg.testCmd[2] = '--test-reporter=dot';
  cfg.checks[0].cmd[2] = '--test-reporter=dot';
  cfg.checks[0].changedCmd[2] = '--test-reporter=dot';
  fs.writeFileSync(cp, JSON.stringify(cfg));
  fs.writeFileSync(path.join(d, '.sdd/outcome'), 'skip');
  for (const args of [
    ['tdd', 'green', 'TEST-A-001'], ['tdd', 'refactor', 'TEST-A-001'],
    ['tdd', 'red', 'TEST-A-001', '--characterization', 'silence is not execution'],
    ['gate'], ['gate', '--changed', '--baseline', 'HEAD'],
  ]) {
    const result = sdd(d, ...args);
    assert.notEqual(result.code, 0, `${args.join(' ')} accepted native dot evidence:\n${result.out}`);
    assert.match(result.out, /Node|no test matched|unobservable/, result.out);
    assert.equal(fs.readFileSync(ledger, 'utf8'), before);
  }
  fs.rmSync(path.join(d, '.sdd/outcome'));
  assert.notEqual(sdd(d, 'gate').code, 0, 'opaque passing output is still not coverage');
  cfg.checks[0].cmd.splice(2, 0, '--test-name-pattern', 'unannotated control');
  fs.writeFileSync(cp, JSON.stringify(cfg));
  assert.notEqual(sdd(d, 'gate').code, 0, 'explicit selection cannot authorize an unobservable reporter');
});

/** @id TEST-R34-NODE-002 @verifies REQ-R34-NODE-001 */
test('TEST-R34-NODE-002 r34e #361 annotated skip/todo children cannot borrow parents with any supported reporter', () => {
for (const reporter of ['spec', 'tap', null]) {
  for (const outcome of ['skip', 'todo']) {
      const { d, cp, cfg, ledger } = r34eNodeFixture(reporter, true);
      const before = fs.readFileSync(ledger, 'utf8');
      fs.writeFileSync(path.join(d, '.sdd/outcome'), outcome);
      // The parent's ID also matches the selector; only the annotated child's outcome counts.
      for (const sub of ['green', 'refactor']) {
        const result = sdd(d, 'tdd', sub, 'TEST-A-001');
        assert.equal(result.code, 1, `${sub} accepted an unannotated parent:\n${result.out}`);
        assert.match(result.out, /no test matched|skipped|todo/);
        assert.equal(fs.readFileSync(ledger, 'utf8'), before);
      }
      for (const args of [['gate'], ['gate', '--changed', '--baseline', 'HEAD']]) {
        const result = sdd(d, ...args);
        assert.equal(result.code, 1, result.out);
        assert.match(result.out, /TEST-A-001.*missing executed Node test ids/);
      }
      fs.rmSync(path.join(d, '.sdd/outcome'));
      for (const sub of ['green', 'refactor']) assert.equal(sdd(d, 'tdd', sub, 'TEST-A-001').code, 0);
      assert.equal(sdd(d, 'gate').code, 0);
      assert.equal(sdd(d, 'gate', '--changed', '--baseline', 'HEAD').code, 0);
      // Preserve reviewed explicit gate selection; omitted siblings do not widen the command.
      cfg.checks[0].cmd.splice(2, 0, '--test-name-pattern', 'unannotated control');
      fs.writeFileSync(cp, JSON.stringify(cfg));
      const selected = sdd(d, 'gate');
      assert.equal(selected.code, 0, selected.out);
      // TDD must still verify its child even when a literal skip selector was explicitly configured.
      cfg.testCmd.splice(2, 0, '--test-skip-pattern', 'child');
      fs.writeFileSync(cp, JSON.stringify(cfg));
      assert.equal(sdd(d, 'tdd', 'refactor', 'TEST-A-001').code, 1);
  }
}
});

/** @id TEST-R34-NODE-003 @verifies REQ-R34-NODE-001 */
test('TEST-R34-NODE-003 r34e #361 native flaky recovery requires observable passing annotated children', () => {
  for (const [reporter, parent, outcome, accepted] of [
    ['dot', false, 'skip', false], ['dot', false, '', false],
    ['spec', true, 'skip', false], ['tap', true, 'todo', false],
    ['spec', true, '', true], ['tap', false, '', true],
  ]) {
    const { d, cp, cfg, ledger } = r34eNodeFixture('spec', parent);
    cfg.checks[0].cmd[2] = `--test-reporter=${reporter}`;
    cfg.checks[0].changedCmd[2] = `--test-reporter=${reporter}`;
    fs.writeFileSync(cp, JSON.stringify(cfg));
    fs.writeFileSync(path.join(d, '.sdd/outcome'), outcome);
    fs.writeFileSync(path.join(d, '.sdd/retry-mode'), '');
    for (const args of [['gate'], ['gate', '--changed', '--baseline', 'HEAD']]) {
      fs.rmSync(path.join(d, '.sdd/attempt'), { force: true });
      const before = fs.readFileSync(ledger, 'utf8');
      const result = sdd(d, ...args);
      assert.equal(result.code, accepted ? 0 : 1, `${reporter}/${parent}/${outcome} ${args}:\n${result.out}`);
      if (accepted) {
        assert.match(result.out, /FLAKY suspected/);
        assert.equal(JSON.parse(fs.readFileSync(ledger, 'utf8').trim().split('\n').at(-1)).type, 'flaky');
        assert.equal(sdd(d, 'tdd', 'check').code, 0);
      } else {
        assert.doesNotMatch(result.out, /FLAKY suspected/);
        assert.equal(fs.readFileSync(ledger, 'utf8'), before);
      }
    }
  }
});

/** @id TEST-R34-NODE-004 @verifies REQ-R34-NODE-001 */
test('TEST-R34-NODE-004 r34e #361 parser binds literal titles and rejects ambiguous, missing and malformed evidence', () => {
  const d = mini(T1SPEC);
  const file = path.join(d, 'a.test.mjs');
  const source = fs.readFileSync(SDD, 'utf8');
  const start = source.indexOf('function nodeTestCommand(');
  const helpers = source.slice(start < 0 ? source.indexOf('function nodeTestRan(') : start, source.indexOf('// ---------- commands ----------'));
  const { nodeTestRan, nodeTestReport } = new Function('fs', 'path', 'ROOT', 'testBody', 'escapeRe', 'readJson',
    `${helpers}\nreturn { nodeTestRan, nodeTestReport: typeof nodeTestReport === 'function' ? nodeTestReport : null };`)(fs, path, d,
    () => fs.readFileSync(file, 'utf8').split('\n').slice(1),
    (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), () => null);
  fs.writeFileSync(file, "// @id TEST-A-001 @verifies REQ-A-001\ntest('TEST-A-001 child', () => {});\n");
  for (const row of ['✔ TEST-A-001 child (1ms)', '    ok 1 - TEST-A-001 child', '✔ TEST-A-001 child (0.001s)']) {
    assert.equal(nodeTestRan(row + '\n﹣ optional unannotated skip (1ms) # SKIP', 'TEST-A-001', 'a.test.mjs', true), true, row);
  }
  for (const row of [
    '✔ TEST-A-001 container (1ms)', 'ok 1 - TEST-A-001 container',
    '﹣ TEST-A-001 child (1ms) # SKIP', 'ok 1 - TEST-A-001 child # SKIP',
    '✔ TEST-A-001 child (1ms) # TODO', 'not ok 1 - TEST-A-001 child # TODO',
    'ok 1 - TEST-A-0011 child', '✔ a.test.mjs (1ms)', '',
  ]) assert.equal(nodeTestRan(row, 'TEST-A-001', 'a.test.mjs', true), false, row);
  assert.equal(nodeTestRan('✖ TEST-A-001 child (1ms)', 'TEST-A-001', 'a.test.mjs'), true);
  assert.equal(nodeTestRan('not ok 1 - TEST-A-001 child', 'TEST-A-001', 'a.test.mjs', true), false);
  for (const text of ['', '...', '# tests unknown', 'ℹ tests NaN'])
    assert.equal(nodeTestReport(text), false, text);
  for (const text of ['# tests 3', 'ℹ tests 3'])
    assert.equal(nodeTestReport(text), true, text);
  fs.writeFileSync(file, "// @id TEST-A-001 @verifies REQ-A-001\ntest(`TEST-A-001 ${kind}`, () => {});\n");
  assert.equal(nodeTestRan('✔ TEST-A-001 child (1ms)', 'TEST-A-001', 'a.test.mjs'), false);
  fs.writeFileSync(file, "// @id TEST-A-001 @verifies REQ-A-001\ntest('TEST-A-001 (2ms)', () => {});\n");
  assert.equal(nodeTestRan('✔ TEST-A-001 (2ms) (1ms)', 'TEST-A-001', 'a.test.mjs', true), true);
  fs.writeFileSync(file, "// @id TEST-A-001 @verifies REQ-A-001\ntest('TEST-A-001 https://oracle/\\u{2714}', () => {});\n");
  assert.equal(nodeTestRan('ok 1 - TEST-A-001 https://oracle/✔', 'TEST-A-001', 'a.test.mjs', true), true);
  fs.writeFileSync(file, '// @id TEST-A-001 @verifies REQ-A-001\nawait t.test("TEST-A-001 child", () => {});\ntest(\'TEST-A-001 child\', () => {});\n');
  assert.equal(nodeTestRan('✔ TEST-A-001 child (1ms)', 'TEST-A-001', 'a.test.mjs', true), false,
    'identical parent/child titles without observable ownership must fail closed');
});

/** @id TEST-R34-NODE-005 @verifies REQ-R34-NODE-001 */
test('TEST-R34-NODE-005 r34e #361 shell and package-script native dot reports cannot bypass coverage', () => {
  for (const shape of ['shell', 'package']) {
    const { d, cp, cfg, ledger } = r34eNodeFixture();
    const before = fs.readFileSync(ledger, 'utf8');
    fs.writeFileSync(path.join(d, '.sdd/outcome'), 'skip');
    if (shape === 'package') fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({
      scripts: { test: 'npm run native', native: 'node --test --test-reporter=dot a.test.mjs' } }));
    const cmd = shape === 'shell' ? ['sh', '-c', 'node --test --test-reporter=dot a.test.mjs'] : ['npm', 'test'];
    cfg.testCmd = cmd;
    cfg.checks = [{ name: 'test', cmd }];
    fs.writeFileSync(cp, JSON.stringify(cfg));
    for (const args of [['tdd', 'green', 'TEST-A-001'], ['gate'], ['gate', '--changed', '--baseline', 'HEAD']]) {
      const result = sdd(d, ...args);
      assert.equal(result.code, 1, `${shape} ${args}:\n${result.out}`);
      assert.match(result.out, /unobservable Node output/);
      assert.equal(fs.readFileSync(ledger, 'utf8'), before);
    }
    fs.rmSync(path.join(d, '.sdd/outcome'));
    if (shape === 'package') {
      const pkg = JSON.parse(fs.readFileSync(path.join(d, 'package.json')));
      pkg.scripts.native = pkg.scripts.native.replace('=dot', '=tap');
      fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify(pkg));
    } else {
      cfg.testCmd[2] = cfg.checks[0].cmd[2] = cfg.testCmd[2].replace('=dot', '=spec');
      fs.writeFileSync(cp, JSON.stringify(cfg));
    }
    const valid = sdd(d, 'gate');
    assert.equal(valid.code, 0, valid.out);
  }
});

function r34fFixture() {
  const d = mini(T1SPEC, {
    '.gitignore': 'node_modules/\n',
    'a.test.mjs': "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { answer } from './answer.mjs';\n// @id TEST-A-001 @verifies REQ-A-001\ntest('TEST-A-001', () => assert.equal(answer(), 1));\n",
    'answer.mjs': '// @id CODE-A-001 @implements REQ-A-001\nexport const answer = () => 0;\n',
  }, ['node', '--test', '--test-reporter=spec', '--test-name-pattern', '{id}', '{file}']);
  const cp = path.join(d, '.sdd/config.json');
  const cfg = JSON.parse(fs.readFileSync(cp));
  cfg.scan = { include: ['a.test.mjs', 'answer.mjs'] };
  cfg.scopePolicy = 'strict';
  cfg.timeoutMs = 5000;
  return { d, cp, cfg };
}
function r34fRun(d, ...args) {
  const start = performance.now();
  const result = spawnSync(process.execPath, [SDD, '--root', d, ...args], { encoding: 'utf8', env: ENV, timeout: 15000 });
  const ms = performance.now() - start;
  assert.equal(result.error, undefined, `15s feasibility budget exceeded (${ms.toFixed(1)}ms): ${result.error}\n${result.stdout}\n${result.stderr}`);
  return { code: result.status, out: result.stdout + result.stderr, ms };
}

/** @id TEST-R34-CLOSURE-001 @verifies REQ-R34-CLOSURE-001 */
test('TEST-R34-CLOSURE-001 r34f #362 structural budget avoids per-identifier PATH and file probes', () => {
  const { d, cp, cfg } = r34fFixture();
  fs.mkdirSync(path.join(d, 'tools'));
  const source = Array.from({ length: 150 }, (_, i) => `// identifier${i}\n`).join('').repeat(2500);
  assert.ok(Buffer.byteLength(source) > 5 * 1024 * 1024);
  fs.writeFileSync(path.join(d, 'tools/bundle.cjs'), source);
  cfg.checks = ['first', 'second'].map((name) => ({ name, cmd: ['node', 'tools/bundle.cjs'] }));
  fs.writeFileSync(cp, JSON.stringify(cfg));
  const measured = path.join(work, 'r34-counted.mjs');
  fs.writeFileSync(measured, fs.readFileSync(SDD, 'utf8').replace("import fs from 'node:fs';", [
    "import fs from 'node:fs';",
    'let r34Probes = 0;',
    "for (const name of ['readFileSync', 'statSync']) { const original = fs[name]; fs[name] = (...args) => { if (++r34Probes > 1000) process.exit(73); return original(...args); }; }",
    "process.on('exit', () => console.log('R34_PROBES=' + r34Probes));",
  ].join('\n')));
  const result = spawnSync(process.execPath, [measured, '--root', d, 'tdd', 'red', 'TEST-A-001'], { encoding: 'utf8', env: ENV, timeout: 15000 });
  const probes = Number(/R34_PROBES=(\d+)/.exec(result.stdout)?.[1]);
  assert.ok(probes <= 1000, `shared discovery must use <=1000 reads/stats, observed ${probes}`);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  console.log(`r34 structural reads/stats: ${probes}, ${Buffer.byteLength(source)} bytes shared by two checks`);
});

/** @id TEST-R34-CLOSURE-002 @verifies REQ-R34-CLOSURE-001 */
test('TEST-R34-CLOSURE-002 r34f #362 real installed TypeScript launcher reaches TDD and preserves provenance', () => {
  const { d, cp, cfg } = r34fFixture();
  const installed = process.env.SDD_R34_TYPESCRIPT ?? fileURLToPath(new URL('../../../../node_modules/typescript', import.meta.url));
  assert.ok(fs.existsSync(path.join(installed, 'bin/tsc')), `Missing compiler dependency: run npm ci at the repository root or set SDD_R34_TYPESCRIPT to an existing official installation (${installed})`);
  const compiler = path.join(d, 'node_modules/typescript');
  fs.cpSync(installed, compiler, { recursive: true });
  const pkg = JSON.parse(fs.readFileSync(path.join(compiler, 'package.json')));
  assert.equal(pkg.version, '5.9.3');
  const bundle = path.join(compiler, 'lib/_tsc.js');
  assert.ok(fs.statSync(bundle).size > 5 * 1024 * 1024);
  fs.writeFileSync(path.join(compiler, 'lib/r34-helper.cjs'), 'module.exports = true;\n');
  fs.appendFileSync(bundle, '\nrequire("./r34-helper.cjs");\n');
  fs.writeFileSync(path.join(d, 'tsconfig.json'), '{"compilerOptions":{"noEmit":true,"allowJs":true},"files":["answer.mjs"]}\n');
  cfg.checks = [{ name: 'types', cmd: ['node', 'node_modules/typescript/bin/tsc', '--noEmit'] }];
  fs.writeFileSync(cp, JSON.stringify(cfg));
  const red = r34fRun(d, 'tdd', 'red', 'TEST-A-001');
  assert.equal(red.code, 0, red.out);
  assert.match(red.out, /RED/);
  fs.writeFileSync(path.join(d, 'answer.mjs'), '// @id CODE-A-001 @implements REQ-A-001\nexport const answer = () => 1;\n');
  const green = r34fRun(d, 'tdd', 'green', 'TEST-A-001');
  assert.equal(green.code, 0, green.out);
  const ledger = path.join(d, '.sdd/tdd.jsonl');
  const evidence = JSON.parse(fs.readFileSync(ledger, 'utf8').trim().split('\n').at(-1));
  for (const file of ['bin/tsc', 'lib/tsc.js', 'lib/_tsc.js', 'lib/r34-helper.cjs'])
    assert.ok(Object.keys(evidence.checkDefShas).some((k) => k.endsWith(`|node_modules/typescript/${file}`)), file);
  assert.ok(Object.hasOwn(evidence.checkDefShas, 'resolution|node_modules/typescript/package.json'));
  const valid = r34fRun(d, 'gate');
  assert.equal(valid.code, 0, valid.out);
  const before = fs.readFileSync(ledger, 'utf8');
  try {
    fs.rmSync(ledger);
    const invalid = r34fRun(d, 'tdd', 'red', 'TEST-A-001');
    assert.equal(invalid.code, 1, invalid.out);
    assert.match(invalid.out, /test passed/);
    assert.ok(!fs.existsSync(ledger));
  } finally { fs.writeFileSync(ledger, before); }
  assert.equal(fs.readFileSync(ledger, 'utf8'), before);
  const controls = [];
  for (const file of ['lib/_tsc.js', 'lib/r34-helper.cjs', 'package.json']) {
    const target = path.join(compiler, file), original = fs.readFileSync(target);
    try {
      if (file === 'package.json') fs.writeFileSync(target, JSON.stringify({ ...pkg, type: 'module' }));
      else fs.appendFileSync(target, '\n// provenance mutation\n');
      const rejected = r34fRun(d, 'gate');
      assert.equal(rejected.code, 1, `${file}: ${rejected.out}`);
      assert.match(rejected.out, /defin|resolution|changed|FAIL/);
      assert.equal(fs.readFileSync(ledger, 'utf8'), before);
      controls.push(`${file} rejection=${rejected.ms.toFixed(1)}ms`);
    } finally { fs.writeFileSync(target, original); }
    const restored = r34fRun(d, 'gate');
    assert.equal(restored.code, 0, restored.out);
    controls.push(`${file} restored=${restored.ms.toFixed(1)}ms`);
  }
  console.log(`r34 TypeScript ${pkg.version}, ${fs.statSync(bundle).size} bytes: Red=${red.ms.toFixed(1)}ms Green=${green.ms.toFixed(1)}ms gate=${valid.ms.toFixed(1)}ms; ${controls.join('; ')}`);
});

/** @id TEST-R34-CLOSURE-003 @verifies REQ-R34-CLOSURE-001 */
test('TEST-R34-CLOSURE-003 r34f #362 oversized definition refuses explicitly without writing evidence', () => {
  const { d, cp, cfg } = r34fFixture();
  fs.mkdirSync(path.join(d, 'tools'));
  fs.writeFileSync(path.join(d, 'tools/oversized.cjs'), '// oversized definition\n' + ' '.repeat(17 * 1024 * 1024));
  cfg.checks = [{ name: 'types', cmd: ['node', 'tools/oversized.cjs'] }];
  fs.writeFileSync(cp, JSON.stringify(cfg));
  const result = r34fRun(d, 'tdd', 'red', 'TEST-A-001');
  assert.equal(result.code, 1, result.out);
  assert.match(result.out, /REFUSED: check-definition discovery budget.*tools\/oversized\.cjs/);
  assert.ok(!fs.existsSync(path.join(d, '.sdd/tdd.jsonl')));
});

/** @id TEST-R34-CLOSURE-004 @verifies REQ-R34-CLOSURE-001 */
test('TEST-R34-CLOSURE-004 r34f #362 token suffix and directory budgets refuse instead of silently truncating', () => {
  for (const [body, reason] of [
    ['x '.repeat(2000001), /2000000 tokens/],
    ['tsc fixture '.repeat(5000), /8000000 inspection steps/],
    [Array.from({ length: 5000 }, (_, i) => `missing-${i}/helper.cjs`).join('\n'), /4096 directories/],
  ]) {
    const { d, cp, cfg } = r34fFixture();
    fs.mkdirSync(path.join(d, 'tools'));
    fs.writeFileSync(path.join(d, 'tools/budget.cjs'), body);
    cfg.checks = [{ name: 'types', cmd: ['node', 'tools/budget.cjs'] }];
    fs.writeFileSync(cp, JSON.stringify(cfg));
    const result = r34fRun(d, 'tdd', 'red', 'TEST-A-001');
    assert.equal(result.code, 1, result.out);
    assert.match(result.out, /REFUSED: check-definition discovery budget/);
    assert.match(result.out, reason);
    assert.ok(!fs.existsSync(path.join(d, '.sdd/tdd.jsonl')));
  }
});

function r34IntegrationWritePython(file, text) {
  const before = fs.statSync(file);
  fs.writeFileSync(file, text);
  const next = Math.floor(before.mtimeMs / 1000) + 2;
  fs.utimesSync(file, next, next);
}

/** @id TEST-R34-INTEGRATION-001 @verifies REQ-R33-PYTEST-001 */
test('TEST-R34-INTEGRATION-001 r34 integration Python fixture rewrites cannot reuse same-size timestamp bytecode', () => {
  assert.ok(r32cPythonAvailable, 'real Python is required; missing runtime is not passing evidence');
  const d = r34dPytestFixture(), file = path.join(d, 'src/subject.py');
  fs.utimesSync(file, 1700000000, 1700000000);
  const readAnswer = () => spawnSync('python3', ['-I', '-c', "import sys; sys.path.insert(0, 'src'); import subject; print(subject.answer())"], { cwd: d, encoding: 'utf8', env: ENV });
  const initial = readAnswer();
  assert.equal(initial.status, 0, initial.stderr);
  assert.equal(initial.stdout.trim(), '0');
  assert.ok(fs.readdirSync(path.join(d, 'src/__pycache__')).some((f) => f.startsWith('subject.') && f.endsWith('.pyc')));
  const originalSize = fs.statSync(file).size;
  r34IntegrationWritePython(file, '# @id CODE-A-001 @implements REQ-A-001\ndef answer():\n    return 1\n');
  assert.equal(fs.statSync(file).size, originalSize, 'the edit must exercise the same-size bytecode cache key');
  const corrected = readAnswer();
  assert.equal(corrected.status, 0, corrected.stderr);
  assert.equal(corrected.stdout.trim(), '1', 'native Python must execute the corrected source, not cached answer=0');
});

/** @id TEST-R34-INTEGRATION-002 @verifies REQ-CHECK-CLOSURE-001 */
test('TEST-R34-INTEGRATION-002 r34 integration real relative-plugin restored control invalidates timestamp bytecode', () => {
  assert.ok(r32cPythonAvailable, 'real pytest is required for the restored relative-plugin control');
  const d = mini(T1SPEC, {
    ...r34cPluginFiles('import pytest\nfrom .helper import EXPECTED\n@pytest.fixture\ndef oracle():\n    return EXPECTED\n'),
    'pytest.ini': '[pytest]\npythonpath = src\n',
    'test_a.py': 'from subject import answer\n# @id TEST-A-001 @verifies REQ-A-001\ndef test_a_001(oracle):\n    assert answer() == oracle\n',
    'src/subject.py': '# @id CODE-A-001 @implements REQ-A-001\ndef answer():\n    return 1\n',
  }, ['python3', '-m', 'pytest', '-q', 'test_a.py', '-k', '{idu}']);
  const subject = path.join(d, 'src/subject.py');
  fs.utimesSync(subject, 1700000000, 1700000000);
  const red = sdd(d, 'tdd', 'red', 'TEST-A-001');
  assert.equal(red.code, 0, red.out);
  assert.match(red.out, /assert 1 == 2/);
  assert.ok(fs.readdirSync(path.join(d, 'src/__pycache__')).some((f) => f.startsWith('subject.') && f.endsWith('.pyc')));
  r34IntegrationWritePython(subject, '# @id CODE-A-001 @implements REQ-A-001\ndef answer():\n    return 2\n');
  const green = sdd(d, 'tdd', 'green', 'TEST-A-001');
  assert.equal(green.code, 0, green.out);
});

/** @id TEST-R34-INTEGRATION-003 @verifies REQ-R34-CLOSURE-001 */
test('TEST-R34-INTEGRATION-003 r34 integration Python namespace probes share the compiler source-discovery budget', () => {
  const { d, cp, cfg } = r34fFixture();
  fs.mkdirSync(path.join(d, 'tools'));
  fs.writeFileSync(path.join(d, 'tools/bundle.cjs'), '// import directory_candidate\n'.repeat(5000));
  cfg.checks = [{ name: 'types', cmd: ['node', 'tools/bundle.cjs'] }];
  fs.writeFileSync(cp, JSON.stringify(cfg));
  const measured = path.join(work, 'r34-integration-counted.mjs');
  fs.writeFileSync(measured, fs.readFileSync(SDD, 'utf8').replace("import fs from 'node:fs';", [
    "import fs from 'node:fs';",
    'let r34Probes = 0;',
    "for (const name of ['readFileSync', 'statSync']) { const original = fs[name]; fs[name] = (...args) => { if (++r34Probes > 1000) process.exit(73); return original(...args); }; }",
    "process.on('exit', () => console.log('R34_PROBES=' + r34Probes));",
  ].join('\n')));
  const result = spawnSync(process.execPath, [measured, '--root', d, 'tdd', 'red', 'TEST-A-001'], { encoding: 'utf8', env: ENV, timeout: 15000 });
  const probes = Number(/R34_PROBES=(\d+)/.exec(result.stdout)?.[1]);
  assert.ok(probes <= 1000, `shared Python namespace discovery must use <=1000 reads/stats, observed ${probes}`);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  console.log(`r34 integrated namespace reads/stats: ${probes}`);
});

const r35aRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
/** @id CODE-R36F-LAYOUT-001 @implements REQ-R36F-LAYOUT-001 */
const r35aWork = fs.mkdtempSync(path.join(r35aRoot, '.sdd-test-r35a-work-'));
after(() => fs.rmSync(r35aWork, { recursive: true, force: true }));
const r35aSkills = fs.readdirSync(path.join(r35aRoot, '.github/skills'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
const r35aSelected = ['lean-sdd-tdd', 'tech-writer'];
const r35aRun = (bin, cwd, args) => spawnSync(process.execPath, [bin, ...args], {
  cwd, env: ENV, encoding: 'utf8', timeout: 30000,
});

function r35aInitContract(bin, bundledSkills) {
  const fixture = fs.mkdtempSync(path.join(r35aWork, 'r35a-init-'));
  const cases = [
    ['plain', (target) => [target]],
    ['force after', (target) => [target, '--force']],
    ['force before', (target) => ['--force', target]],
    ['only after', (target) => [target, '--only', r35aSelected.join(',')], true],
    ['only before', (target) => ['--only', r35aSelected.join(','), target], true],
    ['both before', (target) => ['--force', '--only', r35aSelected.join(','), target], true],
    ['both after', (target) => [target, '--only', r35aSelected.join(','), '--force'], true],
  ];
  for (const kind of ['relative', 'absolute']) {
    for (const [name, args, selected] of cases) {
      const area = fs.mkdtempSync(path.join(fixture, 'case-'));
      const cwd = path.join(area, 'cwd');
      const target = path.join(area, 'target');
      fs.mkdirSync(cwd);
      fs.writeFileSync(path.join(cwd, 'sentinel'), 'cwd must stay untouched');
      const input = kind === 'relative' ? '../target' : target;
      const result = r35aRun(bin, cwd, ['init', ...args(input)]);
      const label = `${kind} ${name}`;
      assert.equal(result.status, 0, `${label}: ${result.stdout}${result.stderr}`);
      assert.ok(fs.existsSync(path.join(target, '.github/skills')), `${label}: explicit destination must contain skills`);
      assert.deepEqual(fs.readdirSync(cwd), ['sentinel'], `${label}: explicit init must not write to cwd`);
      assert.equal(fs.readFileSync(path.join(cwd, 'sentinel'), 'utf8'), 'cwd must stay untouched');
      assert.deepEqual(fs.readdirSync(area).sort(), ['cwd', 'target'], `${label}: no writes outside destination`);
      const expected = selected ? r35aSelected : r35aSkills;
      assert.deepEqual(fs.readdirSync(path.join(target, '.github/skills')).sort(), expected);
      for (const skill of expected) {
        assert.equal(fs.readFileSync(path.join(target, '.github/skills', skill, 'SKILL.md'), 'utf8'),
          fs.readFileSync(path.join(bundledSkills, skill, 'SKILL.md'), 'utf8'));
      }
    }
  }
  for (const args of [[], ['--force'], ['--only', r35aSelected.join(',')], ['--force', '--only', r35aSelected.join(',')]]) {
    const cwd = fs.mkdtempSync(path.join(fixture, 'default-'));
    const result = r35aRun(bin, cwd, ['init', ...args]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.deepEqual(fs.readdirSync(cwd), ['.github'], 'omitted destination installs only into isolated cwd');
    assert.deepEqual(fs.readdirSync(path.join(cwd, '.github/skills')).sort(),
      args.includes('--only') ? r35aSelected : r35aSkills);
  }
  for (const forceFirst of [false, true]) {
    const area = fs.mkdtempSync(path.join(fixture, 'overwrite-'));
    const cwd = path.join(area, 'cwd'), target = path.join(area, 'target');
    fs.mkdirSync(cwd);
    const initArgs = ['init', target, '--only', r35aSelected[0]];
    assert.equal(r35aRun(bin, cwd, initArgs).status, 0);
    const installed = path.join(target, '.github/skills', r35aSelected[0], 'SKILL.md');
    fs.writeFileSync(installed, 'local edit');
    const skipped = r35aRun(bin, cwd, initArgs);
    assert.equal(skipped.status, 0, skipped.stdout + skipped.stderr);
    assert.match(skipped.stdout, /skip lean-sdd-tdd/);
    assert.equal(fs.readFileSync(installed, 'utf8'), 'local edit', 'default init preserves existing skill');
    const forced = r35aRun(bin, cwd, forceFirst
      ? ['init', '--force', target, '--only', r35aSelected[0]] : [...initArgs, '--force']);
    assert.equal(forced.status, 0, forced.stdout + forced.stderr);
    assert.match(forced.stdout, /installed lean-sdd-tdd/);
    assert.equal(fs.readFileSync(installed, 'utf8'),
      fs.readFileSync(path.join(bundledSkills, r35aSelected[0], 'SKILL.md'), 'utf8'));
    assert.deepEqual(fs.readdirSync(cwd), [], 'skip/force must not write to cwd');
  }
  for (const placement of ['before', 'after', 'default']) {
    const area = fs.mkdtempSync(path.join(fixture, 'unknown-'));
    const cwd = path.join(area, 'cwd'), target = path.join(area, 'target');
    fs.mkdirSync(cwd);
    const only = ['--only', `${r35aSelected[0]},not-a-bundled-skill`];
    const args = placement === 'before' ? [...only, target] : placement === 'after' ? [target, ...only] : only;
    const result = r35aRun(bin, cwd, ['init', '--force', ...args]);
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.match(result.stderr, /unknown skill: not-a-bundled-skill/);
    assert.deepEqual(fs.readdirSync(cwd), [], 'unknown skill must not partially install valid selections');
    assert.deepEqual(fs.readdirSync(area), ['cwd'], 'unknown skill must not create destination');
  }
}

test('#363 r35a source init preserves explicit target/cwd invariants and existing options', () => {
  r35aInitContract(path.join(r35aRoot, 'bin/musubix6.mjs'), path.join(r35aRoot, '.github/skills'));
});

test('#363 r35a packed installation preserves bin version/list/init/sdd contracts', { timeout: 120000 }, () => {
  const fixture = fs.mkdtempSync(path.join(r35aWork, 'r35a-pack-'));
  const cache = path.join(fixture, 'cache'), packed = path.join(fixture, 'packed');
  fs.mkdirSync(packed);
  const npm = (cwd, args) => spawnSync('npm', [...args, '--cache', cache, '--offline', '--ignore-scripts'], {
    cwd, env: { ...ENV, TMPDIR: r35aWork }, encoding: 'utf8', timeout: 60000,
  });
  const pack = npm(r35aRoot, ['pack', '--json', '--pack-destination', packed]);
  assert.equal(pack.status, 0, pack.stdout + pack.stderr);
  const filenames = [];
  const collect = (value) => {
    if (!value || typeof value !== 'object') return;
    if (typeof value.filename === 'string') filenames.push(value.filename);
    Object.values(value).forEach(collect);
  };
  collect(JSON.parse(pack.stdout));
  assert.equal(filenames.length, 1, 'npm pack JSON must identify exactly one tarball (array or object shape)');
  assert.deepEqual(fs.readdirSync(packed), filenames);
  const tarball = path.join(packed, filenames[0]), extracted = path.join(fixture, 'extracted');
  fs.mkdirSync(extracted);
  const unpack = spawnSync('tar', ['-xzf', tarball, '-C', extracted], { encoding: 'utf8', timeout: 30000 });
  assert.equal(unpack.status, 0, unpack.stdout + unpack.stderr);
  const packageRoot = path.join(extracted, 'package');
  const installed = path.join(fixture, 'installed');
  fs.mkdirSync(installed);
  const install = npm(installed, ['install', '--prefix', installed, '--no-audit', '--no-fund', tarball]);
  assert.equal(install.status, 0, install.stdout + install.stderr);
  const bins = [path.join(packageRoot, 'bin/musubix6.mjs'), path.join(installed, 'node_modules/.bin/musubix6')];
  for (const bin of bins) {
    const cwd = fs.mkdtempSync(path.join(fixture, 'controls-'));
    const version = r35aRun(bin, cwd, ['--version']);
    assert.equal(version.status, 0, version.stdout + version.stderr);
    assert.equal(version.stdout.trim(), JSON.parse(fs.readFileSync(path.join(r35aRoot, 'package.json'), 'utf8')).version);
    const list = r35aRun(bin, cwd, ['list']);
    assert.equal(list.status, 0, list.stdout + list.stderr);
    assert.deepEqual(list.stdout.trim().split(/\r?\n/).sort(), r35aSkills);
    for (const args of [['gate', '--help'], ['not-a-command']]) {
      const direct = spawnSync(process.execPath, [path.join(packageRoot, '.github/skills/lean-sdd-tdd/scripts/sdd.mjs'), ...args],
        { cwd, env: ENV, encoding: 'utf8', timeout: 30000 });
      const forwarded = r35aRun(bin, cwd, ['sdd', ...args]);
      assert.equal(forwarded.status, args[0] === 'gate' ? 0 : 2);
      assert.equal(forwarded.status, direct.status);
      assert.equal(forwarded.stdout, direct.stdout, 'SDD arguments and output must be forwarded unchanged');
      assert.equal(forwarded.stderr, direct.stderr);
    }
    assert.deepEqual(fs.readdirSync(cwd), [], 'version/list/sdd controls must not write into cwd');
    r35aInitContract(bin, path.join(packageRoot, '.github/skills'));
  }
});

test('r35b #364 compiler fixture selection is checkout-relative and preserves explicit override', () => {
  const source = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8');
  const expression = /const installed = ([^\n]+);/.exec(source)?.[1];
  assert.ok(expression, 'the real compiler control must select an installation explicitly');
  const select = new Function('process', 'fileURLToPath', 'suiteUrl',
    `return ${expression.replaceAll('import.meta.url', 'suiteUrl')};`);
  for (const root of ['/portable checkout', '/another/checkout']) {
    const suiteUrl = new URL(`file://${root}/.github/skills/lean-sdd-tdd/scripts/sdd.test.mjs`);
    assert.equal(select({ env: {} }, fileURLToPath, suiteUrl), `${root}/node_modules/typescript`);
    assert.equal(select({ env: { SDD_R34_TYPESCRIPT: '/explicit/compiler' } }, fileURLToPath, suiteUrl), '/explicit/compiler');
    assert.equal(select({ env: { SDD_R34_TYPESCRIPT: '' } }, fileURLToPath, suiteUrl), '',
      'an invalid explicit override must not silently fall back to the default');
  }
});

test('r35b #364 TypeScript is exactly locked as a development-only dependency', () => {
  const root = fileURLToPath(new URL('../../../../', import.meta.url));
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json')));
  assert.equal(pkg.devDependencies?.typescript, '5.9.3');
  assert.equal(Object.keys(pkg.dependencies ?? {}).length, 0, 'runtime remains zero-dependency');
  assert.equal(Object.keys(pkg.optionalDependencies ?? {}).length, 0);
  assert.equal((pkg.bundledDependencies ?? pkg.bundleDependencies ?? []).length, 0);
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json')));
  assert.equal(lock.packages[''].devDependencies.typescript, '5.9.3');
  assert.deepEqual(lock.packages[''].devDependencies, pkg.devDependencies);
  for (const [name, entry] of Object.entries(lock.packages)) {
    if (name === '') continue;
    assert.equal(entry.dev, true, `${name} must remain development-only`);
  }
  const compiler = lock.packages['node_modules/typescript'];
  assert.equal(compiler.version, '5.9.3');
  assert.equal(compiler.dev, true);
  assert.match(compiler.resolved, /^https:\/\/registry\.npmjs\.org\/typescript\//);
  assert.match(compiler.integrity, /^sha512-/);
});

test('r35b #364 compiler regression requires a real installation and retains the 15s budget', () => {
  const source = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8');
  const start = source.indexOf("test('TEST-R34-CLOSURE-002 r34f #362 real installed TypeScript");
  const end = source.indexOf('/** @id TEST-R34-CLOSURE-003', start);
  const control = source.slice(start, end);
  assert.doesNotMatch(control, /skip:|t\.skip|catch\s*\(/);
  assert.match(control, /Missing compiler dependency:.*npm ci/);
  assert.match(control, /assert\.equal\(pkg\.version, '5\.9\.3'\)/);
  assert.match(control, /assert\.ok\(fs\.statSync\(bundle\)\.size > 5 \* 1024 \* 1024\)/);
  assert.match(control, /const valid = r34fRun\(d, 'gate'\)/);
  assert.match(control, /for \(const file of \['lib\/_tsc\.js', 'lib\/r34-helper\.cjs', 'package\.json'\]\)/);
  const runner = source.slice(source.indexOf('function r34fRun('), source.indexOf('/** @id TEST-R34-CLOSURE-001'));
  assert.match(runner, /timeout: 15000/);
  assert.match(runner, /assert\.equal\(result\.error, undefined/);
});

test('r35b #364 CI qualifies Node 20/22/24 without publication and retains failure evidence', () => {
  const root = fileURLToPath(new URL('../../../../', import.meta.url));
  const workflowPath = path.join(root, '.github/workflows/ci.yml');
  assert.ok(fs.existsSync(workflowPath), 'non-publishing matrix CI must be checked in');
  const ci = fs.readFileSync(workflowPath, 'utf8');
  assert.match(ci, /push:\s*\n\s+pull_request:\s*\n\s+workflow_dispatch:/);
  assert.match(ci, /permissions:\s*\n\s+contents: read/);
  assert.doesNotMatch(ci, /secrets\.|id-token:|contents: write|npm publish|(?<![\w-])environment:|pull_request_target/);
  assert.match(ci, /runs-on: ubuntu-latest/);
  assert.match(ci, /node: \[20, 22, 24\]/);
  assert.match(ci, /fail-fast: false/);
  assert.match(ci, /node-version: \$\{\{ matrix\.node \}\}/);
  assert.match(ci, /timeout-minutes: (?:[6-9]\d|1\d\d)/);
  assert.match(ci, /node --version/);
  assert.match(ci, /process\.versions\.node/);
  assert.match(ci, /EXPECTED_NODE/);
  assert.match(ci, /npm ci/);
  assert.match(ci, /python3 -m pip install.*pytest/);
  for (const tool of ['r-base-core', 'build-essential', 'cmake', 'maven', 'phpunit', 'composer'])
    assert.ok(ci.includes(tool), `native prerequisite: ${tool}`);
  for (const setup of ['setup-go', 'rust-toolchain', 'setup-java', 'setup-dotnet', 'setup-julia', 'setup-beam'])
    assert.ok(ci.includes(setup), `native prerequisite: ${setup}`);
  assert.match(ci, /100m npm test/);
  const command = JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).scripts.test;
  assert.match(command, /^node --test\b/);
  for (const suite of ['sdd', 'spec-context', 'source-discovery'])
    assert.ok(command.includes(`.github/skills/lean-sdd-tdd/scripts/${suite}.test.mjs`), `required suite: ${suite}`);
  assert.match(ci, /PIPESTATUS\[0\]/);
  assert.match(ci, /exit "\$status"/);
  assert.match(ci, /exit=%s/);
  assert.match(ci, /if: failure\(\)/);
  assert.match(ci, /uses: actions\/upload-artifact@v4/);
  assert.match(ci, /path: test-logs\//);
});

test('r35b #364 publish test job restores the portable compiler before running its suite', () => {
  const root = fileURLToPath(new URL('../../../../', import.meta.url));
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/publish.yml'), 'utf8');
  const testJob = workflow.slice(workflow.indexOf('  test:'), workflow.indexOf('\n  publish:'));
  assert.match(testJob, /npm ci/);
  assert.match(testJob, /run: npm test/);
  assert.ok(testJob.indexOf('npm ci') < testJob.indexOf('npm test'), 'restore before compiler regression');
  assert.doesNotMatch(testJob, /SDD_R34_TYPESCRIPT|secrets\.|npm publish/);
});

function r35aAdmissionSnapshot(root) {
  const entries = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(dir, entry.name);
      entries.push([path.relative(root, file), entry.isDirectory() ? null : fs.readFileSync(file, 'utf8')]);
      if (entry.isDirectory()) visit(file);
    }
  };
  visit(root);
  return entries;
}

function r35aAdmissionContract(bin, kind) {
  const invalid = kind === 'unknown'
    ? [['--bogus'], ['--froce'], ['--only=lean-sdd-tdd'], ['--force=yes'], ['--only', r35aSelected[0], '--bogus']]
    : [['--only'], ['--only', ''], ['--only', ',,'], ['--only', '--force'], ['--only', r35aSelected[0], '--only']];
  for (const options of invalid) {
    for (const destination of ['default', 'relative', 'absolute']) {
      for (const existing of [false, true]) {
        const area = fs.mkdtempSync(path.join(r35aWork, 'r35a-admission-'));
        const cwd = path.join(area, 'cwd'), target = path.join(area, 'target');
        fs.mkdirSync(cwd);
        fs.writeFileSync(path.join(cwd, 'sentinel'), 'cwd is unchanged');
        if (existing) {
          const skill = path.join(destination === 'default' ? cwd : target, '.github/skills', r35aSelected[0]);
          fs.mkdirSync(skill, { recursive: true });
          fs.writeFileSync(path.join(skill, 'SKILL.md'), 'existing skill must not be overwritten');
        }
        const before = r35aAdmissionSnapshot(area);
        const dir = destination === 'relative' ? '../target' : target;
        const args = ['init', '--force', ...(destination === 'default' ? [] : [dir]), ...options];
        const result = r35aRun(bin, cwd, args);
        const label = `${kind} ${JSON.stringify(args)} (${existing ? 'existing' : 'fresh'})`;
        assert.equal(result.status, 2, `${label}: invalid init must exit 2; ${result.stdout}${result.stderr}`);
        assert.deepEqual(r35aAdmissionSnapshot(area), before, `${label}: invalid init must not create or modify any files`);
        assert.equal(result.stdout, '', `${label}: invalid init must not report an installation`);
        assert.match(result.stderr, kind === 'unknown'
          ? /unknown (?:flag|option).*--.*(?:--force|--only)/i
          : /--only.*(?:requires|expected|missing|non.?empty).*(?:skill|a,b)/i,
        `${label}: stderr must identify the invalid argument and explain accepted input`);
      }
    }
  }
}

test('#363 r35a admission rejects unknown init flags without writes', () => {
  r35aAdmissionContract(path.join(r35aRoot, 'bin/musubix6.mjs'), 'unknown');
});

test('#363 r35a admission rejects missing or empty --only without writes', () => {
  r35aAdmissionContract(path.join(r35aRoot, 'bin/musubix6.mjs'), 'only');
});

test('#363 r35a admission packed extraction and installation reject invalid init without writes', { timeout: 120000 }, () => {
  const fixture = fs.mkdtempSync(path.join(r35aWork, 'r35a-admission-pack-'));
  const packed = path.join(fixture, 'packed'), cache = path.join(fixture, 'cache');
  fs.mkdirSync(packed);
  const npm = (cwd, args) => spawnSync('npm', [...args, '--cache', cache, '--offline', '--ignore-scripts'], {
    cwd, env: { ...ENV, TMPDIR: r35aWork }, encoding: 'utf8', timeout: 60000,
  });
  const pack = npm(r35aRoot, ['pack', '--json', '--pack-destination', packed]);
  assert.equal(pack.status, 0, pack.stdout + pack.stderr);
  const filenames = [];
  const collect = (value) => {
    if (!value || typeof value !== 'object') return;
    if (typeof value.filename === 'string') filenames.push(value.filename);
    Object.values(value).forEach(collect);
  };
  collect(JSON.parse(pack.stdout));
  assert.equal(filenames.length, 1, 'array or object npm pack JSON must identify one tarball');
  assert.deepEqual(fs.readdirSync(packed), filenames);
  const tarball = path.join(packed, filenames[0]), extracted = path.join(fixture, 'extracted');
  fs.mkdirSync(extracted);
  const unpack = spawnSync('tar', ['-xzf', tarball, '-C', extracted], { encoding: 'utf8', timeout: 30000 });
  assert.equal(unpack.status, 0, unpack.stdout + unpack.stderr);
  const installed = path.join(fixture, 'installed');
  fs.mkdirSync(installed);
  const install = npm(installed, ['install', '--prefix', installed, '--no-audit', '--no-fund', tarball]);
  assert.equal(install.status, 0, install.stdout + install.stderr);
  for (const bin of [path.join(extracted, 'package/bin/musubix6.mjs'), path.join(installed, 'node_modules/.bin/musubix6')]) {
    r35aAdmissionContract(bin, 'unknown');
    r35aAdmissionContract(bin, 'only');
  }
});

function r36aRedClassification(body, weak, disableHelpers) {
  const d = project();
  fs.writeFileSync(path.join(d, 'add.mjs'), "export const add = () => { throw new Error('not implemented: add'); };\n");
  fs.writeFileSync(path.join(d, 'add.test.mjs'), [
    "import { test } from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { add } from './add.mjs';",
    'function validateSum(value) { assert.equal(value, 3); }',
    '/** @id TEST-CALC-001 @verifies REQ-CALC-001 */',
    "test('TEST-CALC-001 adds', () => {",
    ...body,
    '});',
    '',
  ].join('\n'));
  const preload = path.join(d, 'without-iterator-helpers.cjs');
  fs.writeFileSync(preload, [
    "const assert = require('node:assert/strict');",
    "const iterator = ''.matchAll(/x/g);",
    'for (let p = Object.getPrototypeOf(iterator); p; p = Object.getPrototypeOf(p)) {',
    "  for (const name of ['map', 'filter', 'flatMap', 'reduce', 'toArray', 'some', 'every', 'find', 'forEach', 'take', 'drop']) {",
    '    if (Object.hasOwn(p, name)) delete p[name];',
    '  }',
    '}',
    'assert.equal(iterator.map, undefined);',
    "assert.equal(typeof [].map, 'function');",
    '',
  ].join('\n'));
  const approved = sdd(d, 'approve', 'record', 'calc', '--by', 'tester');
  assert.equal(approved.code, 0, approved.out);
  const r = spawnSync(process.execPath, [
    ...(disableHelpers ? ['--require', preload] : []),
    SDD, '--root', d, 'tdd', 'red', 'TEST-CALC-001',
  ], { encoding: 'utf8', env: ENV });
  const out = r.stdout + r.stderr;
  assert.equal(r.status, 0, out);
  assert.match(out, /RED.*TEST-CALC-001/);
  assert.match(out, /not implemented: add/);
  assert.doesNotMatch(out, /TypeError|load\/compile error/);
  if (weak) assert.match(out, /\[weak\].*setup call "add"/);
  else assert.doesNotMatch(out, /\[weak\]/);
  const reds = testEvidence(d).filter((e) => e.type === 'red' && e.test === 'TEST-CALC-001');
  assert.equal(reds.length, 1, out);
  assert.equal(!!reds[0].weak, weak, JSON.stringify(reds[0]));
}

/** @id TEST-NODE20-001 @verifies REQ-NODE20-001 */
test('#365 TEST-NODE20-001 iterator-free setup Red retains weakness', () => {
  for (const disabled of [true, false]) {
    r36aRedClassification(['  const seed = add(0, 0);', '  assert.equal(add(1, 2), 3 + seed);'], true, disabled);
  }
});

/** @id TEST-NODE20-002 @verifies REQ-NODE20-001 */
test('#365 TEST-NODE20-002 iterator-free validation-helper Red stays strong', () => {
  for (const disabled of [true, false]) {
    r36aRedClassification(['  validateSum(add(1, 2));'], false, disabled);
  }
});

// Issue #366: the same admission contract must hold for native TAP and spec.
function r36bFixture(reporter, body, subject = '(a, b) => a + b', extra = '') {
  const d = project();
  impl(d, subject);
  sdd(d, 'init');
  fs.writeFileSync(path.join(d, 'add.test.mjs'), [
    "import { test } from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { add } from './add.mjs';",
    extra,
    '/** @id TEST-CALC-001 @verifies REQ-CALC-001 */',
    `test('TEST-CALC-001 target', () => { ${body} });`,
  ].join('\n'));
  setCmd(d, ['node', '--test', `--test-reporter=${reporter}`, 'add.test.mjs']);
  sdd(d, 'approve', 'record', 'calc', '--by', 'tester');
  return d;
}

/** @id TEST-R36B-LOAD-001 @verifies REQ-R36B-LOAD-001 */
test('#366 TEST-R36B-LOAD-001 native module stub is weak but in-body stub is strong', () => {
  for (const reporter of ['tap', 'spec']) {
    const subject = '() => { throw new Error("not implemented"); }';
    const d = r36bFixture(reporter, 'assert.equal(fixture, 3);', subject, 'const fixture = add(1, 2);');
    const red = sdd(d, 'tdd', 'red', 'TEST-CALC-001');
    assert.equal(red.code, 0, red.out);
    assert.match(red.out, /\[weak\]/, red.out);
    assert.match(red.out, /before any test body ran/, red.out);
    assert.equal(lastRed(d).weak, true);
    const control = r36bFixture(reporter, 'assert.equal(add(1, 2), 3);', subject);
    const strong = sdd(control, 'tdd', 'red', 'TEST-CALC-001');
    assert.equal(strong.code, 0, strong.out);
    assert.doesNotMatch(strong.out, /\[weak\]|before any test body ran/, strong.out);
    assert.equal(!!lastRed(control).weak, false);
  }
});

/** @id TEST-R36B-SYNTAX-001 @verifies REQ-R36B-SYNTAX-001 */
test('#366 TEST-R36B-SYNTAX-001 native marked syntax is rejected even with weak', () => {
  for (const reporter of ['tap', 'spec']) {
    const d = r36bFixture(reporter, 'assert.equal(add(1, 2), 3);');
    fs.writeFileSync(path.join(d, 'add.mjs'), 'export const MAX = ; // SDD-TODO(stub): type unknown\n');
    for (const flags of [[], ['--weak']]) {
      const red = sdd(d, 'tdd', 'red', 'TEST-CALC-001', ...flags);
      assert.equal(red.code, 1, red.out);
      assert.match(red.out, /SDD-TODO\(stub\) element MAX.*fill MAX by hand/, red.out);
      assert.equal(testEvidence(d).length, 0);
    }
    fs.writeFileSync(path.join(d, 'add.mjs'), 'export const MAX = ;\n');
    const rejected = sdd(d, 'tdd', 'red', 'TEST-CALC-001');
    assert.equal(rejected.code, 1, rejected.out);
    assert.match(rejected.out, /load\/compile error/, rejected.out);
    assert.equal(testEvidence(d).length, 0);
    const weak = sdd(d, 'tdd', 'red', 'TEST-CALC-001', '--weak');
    assert.equal(weak.code, 0, weak.out);
    assert.equal(lastRed(d).weak, true);
  }
});

/** @id TEST-R36B-ASSERT-001 @verifies REQ-R36B-ASSERT-001 */
test('#366 TEST-R36B-ASSERT-001 native owned assertion outranks embedded child stderr', () => {
  for (const reporter of ['tap', 'spec']) {
    const d = r36bFixture(reporter, "assert.equal(1, 0, 'Cannot find module child\\nSyntaxError: embedded child stderr');");
    const red = sdd(d, 'tdd', 'red', 'TEST-CALC-001');
    assert.equal(red.code, 0, red.out);
    assert.doesNotMatch(red.out, /\[weak\]|load\/compile error/, red.out);
    assert.equal(!!lastRed(d).weak, false);
  }
});

test('#366 native diagnostic message and sibling cannot impersonate owned assertion metadata', () => {
  for (const reporter of ['tap', 'spec']) {
    for (const extra of ['', "\ntest('TEST-CALC-0011 sibling', () => assert.equal(1, 0));"]) {
      const d = r36bFixture(reporter, "throw new SyntaxError(\"invalid input\\nname: 'AssertionError'\\ncode: 'ERR_ASSERTION'\");", undefined, extra);
      const red = sdd(d, 'tdd', 'red', 'TEST-CALC-001');
      assert.equal(red.code, 1, red.out);
      assert.match(red.out, /load\/compile error/, red.out);
      assert.equal(testEvidence(d).length, 0);
    }
  }
});

test('#366 native failure parser requires exact title, location and diagnostic-key ownership', () => {
  const d = path.join(work, 'r36b-parser');
  fs.mkdirSync(d);
  const file = 'TEST-CALC-001.test.mjs';
  fs.writeFileSync(path.join(d, file), "test('TEST-CALC-001 target', () => {});\n");
  const source = fs.readFileSync(SDD, 'utf8');
  const helpers = source.slice(source.indexOf('function nodeTestCommand('), source.indexOf('// ---------- commands ----------'));
  const { nodeFailureContext } = new Function('fs', 'path', 'ROOT', 'testBody', 'escapeRe', 'readJson', 'isLoadErr',
    `${helpers}\nreturn { nodeFailureContext };`)(fs, path, d,
    () => fs.readFileSync(path.join(d, file), 'utf8').split('\n'),
    (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), () => null,
    (text, assertion) => /SyntaxError:|Cannot find module/.test(text) && !assertion);
  const parse = (report) => nodeFailureContext(report, 'TEST-CALC-001', file);
  for (const title of [file, path.join(d, file)]) {
    assert.equal(parse(`TAP version 13\nnot ok 1 - ${title}\n# tests 1`).fileFailed, true, title);
    assert.equal(parse(`✖ ${title} (1ms)\nℹ tests 1`).fileFailed, true, title);
  }
  const report = (title = 'TEST-CALC-001 target', location = path.join(d, file), keys = "  code: 'ERR_ASSERTION'\n  name: 'AssertionError'") =>
    `TAP version 13\nnot ok 1 - ${title}\n  ---\n  location: '${location}:1:1'\n  error: |-\n    Cannot find module child\n${keys}\n  ...\n# tests 1`;
  assert.equal(parse(report()).loadError, false, 'owned typed assertion wins');
  for (const text of [
    report('TEST-CALC-0011 sibling'),
    report('TEST-CALC-001 target', path.join(d, 'sibling.test.mjs')),
    report(undefined, undefined, "    code: 'ERR_ASSERTION'\n    name: 'AssertionError'"),
    report(undefined, undefined, "  code: 'ERR_OTHER'\n  name: 'AssertionError'"),
    report('TEST-CALC-001 target # TODO'),
    report('TEST-CALC-001 target # SKIP'),
    report(undefined, undefined, "  code: 'ERR_OTHER'\n  name: 'SyntaxError'") + '\n' + report('TEST-CALC-0011 sibling'),
  ]) assert.equal(parse(text).loadError, true, text);
  assert.equal(parse('TAP version 13\n# SyntaxError: invalid source\nnot ok 1 - ' + file + '\n# tests 1').loadError, true);
  assert.equal(parse('TAP version 13\nnot ok 1 - sibling.test.mjs\n# tests 1').fileFailed, false);
  assert.equal(parse('TAP version 13\nnot ok 1 - ' + file + '\nok 2 - TEST-CALC-001 target\n# tests 2').fileFailed, false);
  fs.appendFileSync(path.join(d, file), "test('TEST-CALC-001 target', () => {});\n");
  assert.equal(parse(report()).loadError, true, 'duplicate registrations cannot supply assertion ownership');
});

test('#366 native spec exception ownership excludes AssertionError text embedded in SyntaxError', () => {
  const d = r36bFixture('spec', "throw new SyntaxError('invalid input\\nAssertionError: child stderr');");
  const red = sdd(d, 'tdd', 'red', 'TEST-CALC-001');
  assert.equal(red.code, 1, red.out);
  assert.match(red.out, /load\/compile error/, red.out);
  assert.equal(testEvidence(d).length, 0);
});

/** @id TEST-R36C-CLOSURE-001 @verifies REQ-R36C-CLOSURE-001 */
test('TEST-R36C-CLOSURE-001 r36c #367 absent basenames avoid normalization without losing existing helpers', () => {
  const { d, cp, cfg } = r34fFixture();
  fs.mkdirSync(path.join(d, 'tools'));
  fs.writeFileSync(path.join(d, 'tools/bundle.cjs'), Array.from({ length: 4000 }, (_, i) => `// r36ordinary${i}\n`).join(''));
  fs.writeFileSync(path.join(d, 'r36ordinary0'), '#!/bin/sh\n# root helper\n');
  fs.writeFileSync(path.join(d, 'tools/r36ordinary1'), '#!/bin/sh\n# source-relative helper\n');
  cfg.checks = [{ name: 'types', cmd: ['node', 'tools/bundle.cjs'] }];
  fs.writeFileSync(cp, JSON.stringify(cfg));
  const measured = path.join(work, 'r36c-counted.mjs');
  fs.writeFileSync(measured, fs.readFileSync(SDD, 'utf8').replace("import path from 'node:path';", [
    "import path from 'node:path';",
    'let r36Resolutions = 0;',
    'const r36Resolve = path.resolve;',
    "path.resolve = (...args) => { if (args.some((arg) => /^r36ordinary\\d+$/.test(String(arg)))) r36Resolutions++; return r36Resolve(...args); };",
    "process.on('exit', () => console.log('R36_RESOLUTIONS=' + r36Resolutions));",
  ].join('\n')).replace('return defs;\n}', "console.log('R36_FILES=' + JSON.stringify([...defs.keys()])); return defs;\n}"));
  const result = spawnSync(process.execPath, [measured, '--root', d, 'tdd', 'red', 'TEST-A-001'], { encoding: 'utf8', env: ENV, timeout: 15000 });
  assert.equal(result.error, undefined, String(result.error));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const resolutions = Number(/R36_RESOLUTIONS=(\d+)/.exec(result.stdout)?.[1]);
  assert.ok(resolutions <= 16, `absent basenames must not trigger normalization; observed ${resolutions}`);
  const definitions = JSON.parse(/R36_FILES=(.+)/.exec(result.stdout)?.[1] ?? '[]');
  for (const file of ['r36ordinary0', 'tools/r36ordinary1', 'tools/bundle.cjs'])
    assert.ok(definitions.some((key) => key.endsWith(`|${file}`)), `missing helper ${file}`);
  console.log(`r36 candidate path resolutions=${resolutions} for 4000 basenames; root/source helpers preserved`);
});

/** @id TEST-R36C-CLOSURE-002 @verifies REQ-R36C-CLOSURE-001 */
test('TEST-R36C-CLOSURE-002 r36c #367 repeated executable identifiers share fresh closure fingerprints', () => {
  const { d, cp, cfg } = r34fFixture();
  fs.mkdirSync(path.join(d, 'tools'));
  fs.writeFileSync(path.join(d, 'tools/bundle.cjs'), '// node\n'.repeat(5000));
  cfg.checks = ['first', 'second'].map((name) => ({ name, cmd: ['node', 'tools/bundle.cjs'] }));
  fs.writeFileSync(cp, JSON.stringify(cfg));
  const measured = path.join(work, 'r36c-executables.mjs');
  fs.writeFileSync(measured, fs.readFileSync(SDD, 'utf8').replace("import fs from 'node:fs';", [
    "import fs from 'node:fs';",
    'let r36ExecutableProbes = 0;',
    "for (const name of ['realpathSync', 'statSync']) { const original = fs[name]; fs[name] = (...args) => { if (args[0] === process.execPath) r36ExecutableProbes++; return original(...args); }; }",
    "process.on('exit', () => console.log('R36_EXECUTABLE_PROBES=' + r36ExecutableProbes));",
  ].join('\n')).replace('return defs;\n}', "console.log('R36_FILES=' + JSON.stringify([...defs.keys()])); return defs;\n}"));
  const result = spawnSync(process.execPath, [measured, '--root', d, 'tdd', 'red', 'TEST-A-001'], { encoding: 'utf8', env: ENV, timeout: 15000 });
  assert.equal(result.error, undefined, String(result.error));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const probes = Number(/R36_EXECUTABLE_PROBES=(\d+)/.exec(result.stdout)?.[1]);
  assert.ok(probes <= 16, `executable fingerprint work must be shared within a closure; observed ${probes}`);
  const definitions = JSON.parse(/R36_FILES=(.+)/.exec(result.stdout)?.[1] ?? '[]');
  assert.ok(definitions.some((key) => key.startsWith('executable:node|')), 'missing real interpreter fingerprint');
  for (const check of ['first', 'second'])
    assert.ok(definitions.includes(`${check}|tools/bundle.cjs`), `missing ${check} compiler closure`);
  console.log(`r36 executable probes=${probes} for 5000 node identifiers shared by two checks`);
});

/** @id TEST-R36D-OWN-001 @verifies REQ-R36D-OWN-001 */
test('#368 TEST-R36D-OWN-001 original native ownership fixture passes on the actual runtime', () => {
  const result = spawnSync(process.execPath, [
    '--test', '--test-reporter=tap',
    '--test-name-pattern=^TEST-R33-NODE-002 ', fileURLToPath(import.meta.url),
  ], { cwd: process.cwd(), encoding: 'utf8', env: ENV });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, `${process.execPath}\n${output}`);
  assert.match(output, /^ok \d+ - TEST-R33-NODE-002 r33b /m);
  assert.match(output, /# pass 1\b/);
  assert.match(output, /# fail 0\b/);
});

/** @id TEST-R36D-OWN-002 @verifies REQ-R36D-OWN-001 */
test('#368 TEST-R36D-OWN-002 explicit project files preserve positive and missing-ID controls', () => {
  const { d, cp } = r33bNodeFixture('tap', true);
  fs.writeFileSync(path.join(d, 'packages/core/other.test.mjs'), "import { test } from 'node:test';\n/** @id TEST-A-002 @verifies REQ-A-001 */\ntest('TEST-A-002 omitted', { skip: true }, () => {});\n");
  const cfg = JSON.parse(fs.readFileSync(cp));
  cfg.scan.include = ['packages/core/a.test.mjs'];
  cfg.projects[0].checks[0].cmd = ['node', '--test', '--test-reporter=tap', 'a.test.mjs', 'other.test.mjs'];
  fs.writeFileSync(cp, JSON.stringify(cfg));
  const ledger = path.join(d, '.sdd/tdd.jsonl');
  const before = fs.readFileSync(ledger, 'utf8');
  const previous = ENV.CI;
  try {
    for (const outcome of ['r33-skip', 'r33-run']) {
      ENV.CI = outcome;
      for (const args of [['gate'], ['gate', '--changed', '--baseline', 'HEAD']]) {
        const gate = sdd(d, ...args);
        assert.equal(gate.code, outcome === 'r33-skip' ? 1 : 0, gate.out);
        if (outcome === 'r33-skip') assert.match(gate.out, /TEST-A-001.*missing executed Node test ids/, gate.out);
        else {
          assert.match(gate.out, /SDD GATE PASS/, gate.out);
          assert.doesNotMatch(gate.out, /missing executed Node test ids/, gate.out);
        }
        assert.equal(fs.readFileSync(ledger, 'utf8'), before);
      }
    }
  } finally { if (previous === undefined) delete ENV.CI; else ENV.CI = previous; }
});

function r36eLoadCase(reporter, importSource, files, flags = []) {
  const d = r36bFixture(reporter, 'assert.equal(add(1, 2), 3);');
  fs.writeFileSync(path.join(d, 'package.json'), '{"type":"module"}');
  for (const [file, source] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(d, file)), { recursive: true });
    fs.writeFileSync(path.join(d, file), source);
  }
  const original = fs.readFileSync(path.join(d, 'add.test.mjs'), 'utf8');
  const failing = `${importSource}\n${original}`;
  setCmd(d, ['node', ...flags, '--test', `--test-reporter=${reporter}`, 'add.test.mjs']);
  return { d, original, failing };
}

function r36eRejectLoad(fixture, code) {
  const { d, original, failing } = fixture;
  const file = path.join(d, 'add.test.mjs'), ledger = path.join(d, '.sdd/tdd.jsonl');
  // Both a nonexistent ledger and an already valid chain must remain untouched.
  for (const seeded of [false, true]) {
    if (seeded) {
      fs.writeFileSync(file, original.replace('assert.equal(add(1, 2), 3)', 'assert.equal(add(1, 2), 0)'));
      const seed = sdd(d, 'tdd', 'red', 'TEST-CALC-001');
      assert.equal(seed.code, 0, seed.out);
      assert.equal(!!lastRed(d).weak, false);
    }
    fs.writeFileSync(file, failing);
    const before = fs.existsSync(ledger) ? fs.readFileSync(ledger) : null;
    const native = spawnSync('node', [
      ...JSON.parse(fs.readFileSync(path.join(d, '.sdd/config.json'))).testCmd.slice(1),
    ], { cwd: d, encoding: 'utf8', env: ENV });
    const output = native.stdout + native.stderr;
    assert.equal(native.status, 1, output);
    assert.match(output, new RegExp(`\\b${code}\\b`), output);
    const rejected = sdd(d, 'tdd', 'red', 'TEST-CALC-001');
    assert.equal(rejected.code, 1, `${code}\n${rejected.out}`);
    assert.match(rejected.out, /load\/compile error/, rejected.out);
    if (before) assert.deepEqual(fs.readFileSync(ledger), before);
    else assert.equal(fs.existsSync(ledger), false);
  }
  const weak = sdd(d, 'tdd', 'red', 'TEST-CALC-001', '--weak');
  assert.equal(weak.code, 0, weak.out);
  assert.equal(lastRed(d).weak, true);
  console.log(`r36e ${code}: absent/existing ledger preserved; explicit --weak accepted`);
}

/** @id TEST-R36E-LOAD-001 @verifies REQ-R36E-LOAD-001 */
test('#369 TEST-R36E-LOAD-001 real unsupported native TS rejects default Red', () => {
  const capable = !!process.features.typescript;
  const flags = capable ? ['--no-experimental-strip-types'] : [];
  const child = spawnSync('node', [...flags, '-p', 'JSON.stringify([process.version, process.execPath, !!process.features.typescript])'],
    { encoding: 'utf8', env: ENV });
  assert.equal(child.status, 0, child.stdout + child.stderr);
  const runtime = JSON.parse(child.stdout);
  assert.equal(runtime[0], process.version);
  assert.equal(fs.realpathSync(runtime[1]), fs.realpathSync(process.execPath));
  assert.equal(runtime[2], false, 'flag must actually disable native TypeScript');
  console.log(`r36e actual child runtime=${JSON.stringify(runtime)} flags=${JSON.stringify(flags)}`);
  for (const reporter of ['tap', 'spec']) {
    r36eRejectLoad(r36eLoadCase(reporter, "import { answer } from './subject.ts';",
      { 'subject.ts': 'export const answer: number = 0;\n' }, flags), 'ERR_UNKNOWN_FILE_EXTENSION');
    for (const extension of capable ? ['mjs', 'ts'] : ['mjs']) {
      const d = r36bFixture(reporter, 'assert.equal(answer, 1);');
      fs.writeFileSync(path.join(d, 'package.json'), '{"type":"module"}');
      fs.writeFileSync(path.join(d, `subject.${extension}`), `export const answer${extension === 'ts' ? ': number' : ''} = 0;\n`);
      const file = path.join(d, 'add.test.mjs');
      fs.writeFileSync(file, `import { answer } from './subject.${extension}';\n` + fs.readFileSync(file, 'utf8'));
      const red = sdd(d, 'tdd', 'red', 'TEST-CALC-001');
      assert.equal(red.code, 0, red.out);
      assert.equal(!!lastRed(d).weak, false);
      console.log(`r36e ${reporter} native ${extension} genuine assertion strong Red`);
    }
  }
});

/** @id TEST-R36E-FORMAT-001 @verifies REQ-R36E-LOAD-001 */
test('#369 TEST-R36E-FORMAT-001 native loader error family preserves explicit policy', () => {
  const cases = [
    ['ERR_UNKNOWN_FILE_EXTENSION', "import './subject.unknown';", { 'subject.unknown': 'export const answer = 0;\n' }],
    ['ERR_UNKNOWN_MODULE_FORMAT', "import 'data:text/plain,export default 0';", {}],
    ['ERR_UNSUPPORTED_ESM_URL_SCHEME', "import 'https://example.invalid/subject.mjs';", {}],
    ['ERR_UNSUPPORTED_DIR_IMPORT', "import './subject';", { 'subject/index.mjs': 'export default 0;\n' }],
    ['ERR_UNSUPPORTED_RESOLVE_REQUEST', "import 'data:text/javascript,import%20%22./subject.mjs%22';", {}],
  ];
  if (process.features.typescript) cases.push(
    ['ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING', "import './node_modules/subject/index.ts';",
      { 'node_modules/subject/index.ts': 'export const answer: number = 0;\n' }],
    ['ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX', "import './subject.ts';", { 'subject.ts': 'export enum Answer { Zero }\n' }],
  );
  for (const reporter of ['tap', 'spec']) for (const [code, source, files] of cases)
    r36eRejectLoad(r36eLoadCase(reporter, source, files), code);
});

/** @id TEST-R36E-ASSERT-001 @verifies REQ-R36E-LOAD-001 */
test('#369 TEST-R36E-ASSERT-001 owned assertions outrank embedded native-loader stderr', () => {
  for (const reporter of ['tap', 'spec']) for (const body of [
    "throw new TypeError('ordinary implementation failure');",
    "assert.equal(1, 0, 'TypeError [ERR_UNKNOWN_FILE_EXTENSION]: child stderr\\nERR_UNKNOWN_MODULE_FORMAT\\nERR_UNSUPPORTED_ESM_URL_SCHEME\\nERR_UNSUPPORTED_DIR_IMPORT\\nERR_UNSUPPORTED_RESOLVE_REQUEST\\nERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING\\nERR_UNSUPPORTED_TYPESCRIPT_SYNTAX');",
  ]) {
    const d = r36bFixture(reporter, body);
    const red = sdd(d, 'tdd', 'red', 'TEST-CALC-001');
    assert.equal(red.code, 0, red.out);
    assert.equal(!!lastRed(d).weak, false);
  }
});

/** @id TEST-R36E-FRAMING-001 @verifies REQ-R36E-LOAD-001 */
test('#369 TEST-R36E-FRAMING-001 ordinary Error and wrapper preserve original Red policy', () => {
  const messages = [
    "throw new Error('child ERR_UNKNOWN_FILE_EXTENSION ERR_UNKNOWN_MODULE_FORMAT ERR_UNSUPPORTED_ESM_URL_SCHEME ERR_UNSUPPORTED_DIR_IMPORT ERR_UNSUPPORTED_RESOLVE_REQUEST ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING');",
    "throw new Error('child stderr\\nError [ERR_UNSUPPORTED_DIR_IMPORT]: copied diagnostic');",
  ];
  for (const reporter of ['tap', 'spec']) for (const moduleLevel of [false, true]) {
    for (const failure of [...messages, moduleLevel
      ? "try { await import('./subject'); } catch (error) { throw new Error('wrapper ' + error.code, { cause: error }); }"
      : "return import('./subject').catch(error => { throw new Error('wrapper ' + error.code, { cause: error }); });"]) {
      const d = r36bFixture(reporter, moduleLevel ? 'assert.equal(add(1, 2), 3);' : failure,
        '(a, b) => a + b', moduleLevel ? failure : '');
      fs.mkdirSync(path.join(d, 'subject'));
      fs.writeFileSync(path.join(d, 'subject/index.mjs'), 'export default 0;\n');
      const red = sdd(d, 'tdd', 'red', 'TEST-CALC-001');
      assert.equal(red.code, 0, red.out);
      assert.equal(!!lastRed(d).weak, moduleLevel, red.out);
      if (moduleLevel) assert.match(red.out, /\[weak\]/, red.out);
      else assert.doesNotMatch(red.out, /\[weak\]|load\/compile error/, red.out);
    }
  }
});

/** @id TEST-R36E-OWNED-001 @verifies REQ-R36E-LOAD-001 */
test('#369 TEST-R36E-OWNED-001 owned native loader metadata is not child message text', () => {
  const cases = [
    ['ERR_UNKNOWN_FILE_EXTENSION', './subject.unknown', { 'subject.unknown': 'export default 0;\n' }],
    ['ERR_UNKNOWN_MODULE_FORMAT', 'data:text/plain,export default 0', {}],
    ['ERR_UNSUPPORTED_ESM_URL_SCHEME', 'https://example.invalid/subject.mjs', {}],
    ['ERR_UNSUPPORTED_DIR_IMPORT', './subject', { 'subject/index.mjs': 'export default 0;\n' }],
    ['ERR_UNSUPPORTED_RESOLVE_REQUEST', 'data:text/javascript,import%20%22./subject.mjs%22', {}],
  ];
  if (process.features.typescript) cases.push(
    ['ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING', './node_modules/subject/index.ts',
      { 'node_modules/subject/index.ts': 'export const answer: number = 0;\n' }],
  );
  for (const reporter of ['tap', 'spec']) for (const [code, specifier, files] of cases) {
    const fixture = r36eLoadCase(reporter, '', files);
    fixture.failing = fixture.original.replace('assert.equal(add(1, 2), 3);', `return import(${JSON.stringify(specifier)});`);
    r36eRejectLoad(fixture, code);
  }
});

/** @id TEST-R36F-LAYOUT-001 @verifies REQ-R36F-LAYOUT-001 */
test('#370 TEST-R36F-LAYOUT-001 r35a fixtures stay outside distributed payload from either cwd', () => {
  const suite = fileURLToPath(import.meta.url);
  const probe = fs.mkdtempSync(path.join(r35aRoot, '.sdd-r36f-probe-'));
  const hook = path.join(probe, 'observe.mjs');
  fs.writeFileSync(hook, [
    "import fs from 'node:fs';",
    "import path from 'node:path';",
    'const create = fs.mkdtempSync;',
    'fs.mkdtempSync = (prefix, ...args) => {',
    '  const directory = create(prefix, ...args);',
    "  if (/^r35a-(?:init|pack|admission|admission-pack)-$/.test(path.basename(String(prefix)))) {",
    "    console.log('R36F_FIXTURE=' + JSON.stringify(fs.realpathSync(directory)));",
    "    throw new Error('R36F_STOP_BEFORE_NATIVE_WORK');",
    '  }',
    '  return directory;',
    '};',
  ].join('\n'));
  const payloads = JSON.parse(fs.readFileSync(path.join(r35aRoot, 'package.json'))).files
    .map((entry) => fs.realpathSync(path.join(r35aRoot, entry)));
  const controls = [
    '#363 r35a source init preserves explicit target/cwd invariants and existing options',
    '#363 r35a packed installation preserves bin version/list/init/sdd contracts',
    '#363 r35a admission rejects unknown init flags without writes',
    '#363 r35a admission packed extraction and installation reject invalid init without writes',
  ];
  try {
    for (const cwd of [r35aRoot, path.dirname(suite)]) for (const title of controls) {
      const pattern = '^' + title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$';
      const result = spawnSync(process.execPath, [
        '--import', hook, '--test', '--test-reporter=tap', `--test-name-pattern=${pattern}`, suite,
      ], { cwd, env: ENV, encoding: 'utf8', timeout: 60000 });
      const output = result.stdout + result.stderr;
      assert.equal(result.error, undefined, output);
      assert.equal(result.status, 1, output);
      assert.match(output, /R36F_STOP_BEFORE_NATIVE_WORK/, output);
      const observations = [...output.matchAll(/R36F_FIXTURE=("[^\r\n]+")/g)];
      assert.equal(observations.length, 1, output);
      const directory = JSON.parse(observations[0][1]);
      for (const payload of payloads) {
        const relative = path.relative(payload, directory);
        const inside = relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
        assert.equal(inside, false, `${title} from ${cwd}: fixture ${directory} must stay outside distributed payload ${payload}`);
      }
      console.log(`r36f ${process.version} ${process.execPath}: ${title} from ${cwd} => ${directory}`);
    }
  } finally { fs.rmSync(probe, { recursive: true, force: true }); }
});

/** @id TEST-R36H-PYTEST-001 @verifies REQ-R36H-PYTEST-001 */
test('#371 TEST-R36H-PYTEST-001 hosted provisioning runs actual pytest with user-site disabled', () => {
  const root = fileURLToPath(new URL('../../../../', import.meta.url));
  const area = fs.mkdtempSync(path.join(work, 'r36h-pytest-'));
  const wheels = path.join(area, 'wheels');
  fs.mkdirSync(wheels);
  const wheelResult = spawnSync('python3', ['-c', `
import importlib.metadata as md, importlib.util, pathlib, sys, zipfile
for name in ("pytest", "iniconfig", "packaging", "pluggy", "pygments"):
    dist = md.distribution(name)
    stem = dist.metadata["Name"].replace("-", "_") + "-" + dist.version
    wheel = pathlib.Path(sys.argv[1]) / (stem + "-py3-none-any.whl")
    with zipfile.ZipFile(wheel, "w", zipfile.ZIP_DEFLATED) as output:
        for module in (("pytest", "_pytest", "py") if name == "pytest" else (name,)):
            origin = pathlib.Path(importlib.util.find_spec(module).origin)
            if origin.name != "__init__.py":
                output.write(origin, module + ".py")
            else:
                for file in origin.parent.rglob("*"):
                    if file.is_file() and "__pycache__" not in file.parts:
                        output.write(file, str(pathlib.Path(module) / file.relative_to(origin.parent)))
        output.writestr(stem + ".dist-info/METADATA", dist.read_text("METADATA") or dist.read_text("PKG-INFO"))
        output.writestr(stem + ".dist-info/WHEEL", "Wheel-Version: 1.0\\nRoot-Is-Purelib: true\\nTag: py3-none-any\\n")
        output.writestr(stem + ".dist-info/RECORD", "")
`, wheels], { encoding: 'utf8' });
  assert.equal(wheelResult.status, 0, `Missing declared pytest prerequisite:\n${wheelResult.stdout}${wheelResult.stderr}`);
  for (const workflow of ['ci.yml', 'publish.yml']) {
    const source = fs.readFileSync(path.join(root, '.github/workflows', workflow), 'utf8');
    const step = source.match(/      - name: Provision isolated pytest\n        run: \|\n((?:          .*\n)+)/);
    assert.ok(step, `${workflow}: pytest must have an independently executable provisioning step`);
    const runnerTemp = path.join(area, workflow);
    fs.mkdirSync(runnerTemp);
    const githubPath = path.join(runnerTemp, 'github-path');
    fs.writeFileSync(githubPath, '');
    const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', step[1].replace(/^          /gm, '')], {
      encoding: 'utf8', cwd: root,
      env: { ...ENV, RUNNER_TEMP: runnerTemp, GITHUB_PATH: githubPath, PIP_NO_INDEX: '1', PIP_FIND_LINKS: wheels },
    });
    assert.equal(result.status, 0, `${workflow}: ${result.stdout}${result.stderr}`);
    const exported = fs.readFileSync(githubPath, 'utf8').trim().split('\n');
    assert.deepEqual(exported, [path.join(runnerTemp, 'sdd-pytest', 'bin')], `${workflow}: persist the selected interpreter for subsequent steps`);
    const nativeEnv = { ...ENV, PATH: exported.join(path.delimiter) + path.delimiter + ENV.PATH, PYTHONNOUSERSITE: '1', PYTHONSAFEPATH: '1' };
    const identity = spawnSync('python3', ['-c', 'import sys,site,pytest; assert sys.prefix != sys.base_prefix; assert not site.ENABLE_USER_SITE; print(sys.executable); print(pytest.__file__)'], { encoding: 'utf8', env: nativeEnv });
    assert.equal(identity.status, 0, `${workflow}: ${identity.stdout}${identity.stderr}`);
    assert.ok(identity.stdout.includes(path.join(runnerTemp, 'sdd-pytest')), identity.stdout);
    const testFile = path.join(runnerTemp, 'test_native.py');
    fs.writeFileSync(testFile, 'def test_native():\n    assert 1 == 0, "r36h native assertion"\n');
    const run = () => spawnSync('python3', ['-m', 'pytest', '-q', testFile], { cwd: runnerTemp, encoding: 'utf8', env: nativeEnv });
    const red = run();
    assert.equal(red.status, 1, `${red.stdout}${red.stderr}`);
    assert.match(red.stdout + red.stderr, /r36h native assertion/);
    fs.writeFileSync(testFile, 'def test_native():\n    assert 1 == 1\n');
    const green = run();
    assert.equal(green.status, 0, `${green.stdout}${green.stderr}`);
    assert.match(green.stdout, /1 passed/);
  }
});

const r36iNative = (extension) => {
  const result = spawnSync('which', [extension === 'c' ? 'cc' : 'c++'], { encoding: 'utf8', env: ENV });
  assert.equal(result.status, 0, 'C/C++ native compiler is required for #373 oracle controls');
  return result.stdout.trim();
};
const r36iFixture = (extension, missing, invalid = false) => {
  const file = `tests/t.${extension}`;
  const source = '// @id TEST-A-001 @verifies REQ-A-001\n'
    + (missing ? '#include "missing.h"\n' : '')
    + (invalid ? '#error r36g_native_invalid\n' : '')
    + 'int main(void) { return 0; }\n';
  const d = mk130({ [file]: source });
  return { d, file, source, native: r36iNative(extension) };
};
const r36iCompile = (fixture) => spawnSync(fixture.native, ['-fsyntax-only', path.join(fixture.d, fixture.file)], {
  cwd: fixture.d, encoding: 'utf8', timeout: 20000, env: { ...ENV, LC_ALL: 'C' },
});
const r36iCompiler = (fixture, body) => {
  const executable = path.join(fixture.d, 'tools', 'compiler.mjs');
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  if (body !== null) fs.writeFileSync(executable, `#!${process.execPath}\n${body}\n`, { mode: 0o755 });
  writeAll(fixture.d, { 'compile_commands.json': JSON.stringify([{
    directory: fixture.d, file: fixture.file, arguments: [executable, '-c', fixture.file],
  }]) });
  return executable;
};
const r36iStub = (fixture) => {
  const result = spawnSync('node', [SDD, '--root', fixture.d, 'tdd', 'stub', 'TEST-A-001'], {
    encoding: 'utf8', timeout: 20000, env: ENV,
  });
  assert.equal(result.error, undefined, String(result.error));
  assert.equal(result.signal, null, 'stub CLI must return an ordinary verdict');
  return { code: result.status, out: (result.stdout ?? '') + (result.stderr ?? '') };
};
const r36iReject = (result, diagnostic) => {
  assert.equal(result.code, 1, result.out);
  assert.match(result.out, /does not compile|could not fully stub/, result.out);
  assert.doesNotMatch(result.out, /\(throwing, compile-checked\)|\(compile-checked\)/, result.out);
  assert.match(result.out, diagnostic, result.out);
};

/** @id TEST-R36I-EXIT-001 @verifies REQ-R36I-001 */
test('#373 TEST-R36I-EXIT-001 native-valid C/C++ cannot verify silent failed compilers', () => {
  for (const extension of ['c', 'cpp']) for (const missing of [false, true]) {
    const fixture = r36iFixture(extension, missing);
    if (missing) writeAll(fixture.d, { 'tests/missing.h': '' });
    const native = r36iCompile(fixture);
    assert.equal(native.status, 0, native.stderr);
    assert.equal(native.signal, null);
    assert.equal(native.error, undefined);
    if (missing) fs.rmSync(path.join(fixture.d, 'tests/missing.h'));
    const compiler = r36iCompiler(fixture, 'process.exit(101);');
    const controlled = spawnSync(compiler, [], { encoding: 'utf8', timeout: 20000, env: ENV });
    assert.equal(controlled.status, 101);
    assert.equal(controlled.stdout + controlled.stderr, '');
    r36iReject(r36iStub(fixture), /101/);
  }
});

/** @id TEST-R36I-INVALID-001 @verifies REQ-R36I-001 */
test('#373 TEST-R36I-INVALID-001 exact native-invalid fixture never becomes verified with silent exit101', () => {
  for (const extension of ['c', 'cpp']) {
    const fixture = r36iFixture(extension, true, true);
    writeAll(fixture.d, { 'tests/missing.h': '#pragma once\n#include <stdio.h>\n#include <stdlib.h>\n\n' });
    const native = r36iCompile(fixture);
    assert.equal(native.status, 1, native.stderr);
    assert.match(native.stderr, /#error r36g_native_invalid/);
    fs.rmSync(path.join(fixture.d, 'tests/missing.h'));
    r36iCompiler(fixture, 'process.exit(101);');
    const result = r36iStub(fixture);
    const after = r36iCompile(fixture);
    assert.equal(after.status, 1, after.stderr);
    assert.match(after.stderr, /#error r36g_native_invalid/);
    r36iReject(result, /101/);
  }
});

/** @id TEST-R36I-BOUNDARY-001 @verifies REQ-R36I-001 */
test('#373 TEST-R36I-BOUNDARY-001 failed terminal/unparseable/startup/signal/output-budget outcomes are explicit', () => {
  for (const extension of ['c', 'cpp']) for (const missing of [false, true]) for (const [body, diagnostic] of [
    ["process.stderr.write('\\x1b[31m\\x1b[0m'); process.exit(101);", /101/],
    ["process.stderr.write('opaque compiler refusal'); process.exit(101);", /101|opaque compiler refusal/],
    ["process.kill(process.pid, 'SIGTERM');", /SIGTERM/],
    [null, /ENOENT/],
    ["process.stdout.write(Buffer.alloc(2 * 1024 * 1024, 120));", /ENOBUFS/],
  ]) {
    const fixture = r36iFixture(extension, missing);
    r36iCompiler(fixture, body);
    r36iReject(r36iStub(fixture), diagnostic);
  }
});

/** @id TEST-R36I-DIAGNOSTIC-001 @verifies REQ-R36I-002 */
test('#373 TEST-R36I-DIAGNOSTIC-001 zero exit cannot erase plain or SGR-decorated compiler errors', () => {
  for (const extension of ['c', 'cpp']) for (const missing of [false, true]) for (const text of [
    'tests/t:1: error: controlled syntax rejection\n',
    'tests/t:1: er\x1b[31mror\x1b[0m: controlled syntax rejection\n',
  ]) {
    const fixture = r36iFixture(extension, missing);
    r36iCompiler(fixture, `process.stderr.write(${JSON.stringify(text)}); process.exit(0);`);
    r36iReject(r36iStub(fixture), /error: controlled syntax rejection/);
  }
});

/** @id TEST-R36I-NATIVE-001 @verifies REQ-R36I-003 */
test('#373 TEST-R36I-NATIVE-001 real native C/C++ valid and invalid no-op controls retain verdicts', () => {
  for (const extension of ['c', 'cpp']) for (const invalid of [false, true]) {
    const fixture = r36iFixture(extension, false, invalid);
    const native = r36iCompile(fixture);
    assert.equal(native.status, invalid ? 1 : 0, native.stderr);
    const result = r36iStub(fixture);
    if (invalid) r36iReject(result, /r36g_native_invalid/);
    else {
      assert.equal(result.code, 0, result.out);
      assert.match(result.out, /\(compile-checked\)/);
    }
  }
});

/** @id TEST-R36I-PARSE-001 @verifies REQ-R36I-003 */
test('#373 TEST-R36I-PARSE-001 native diagnostics still generate valid throwing C/C++ function stubs', () => {
  for (const extension of ['c', 'cpp']) {
    const fixture = r36iFixture(extension, true);
    fs.writeFileSync(path.join(fixture.d, fixture.file), fixture.source.replace('return 0;', 'return answer(2);'));
    const initial = r36iCompile(fixture);
    assert.equal(initial.status, 1, initial.stderr);
    const result = r36iStub(fixture);
    assert.equal(result.code, 0, result.out);
    assert.match(result.out, /stubbed \(throwing, compile-checked\)/);
    assert.match(rd130(fixture.d, 'tests/missing.h'), /not implemented: answer/);
    const generated = r36iCompile(fixture);
    assert.equal(generated.status, 0, generated.stderr);
    assert.equal(generated.signal, null);
    assert.equal(generated.error, undefined);
  }
});

/** @id TEST-R36I-REASON-001 @verifies REQ-R36I-001 */
test('#373 TEST-R36I-REASON-001 process reasons precede supplementary parsed compiler errors', () => {
  const text = 'tests/t:1: error: controlled syntax rejection\n';
  for (const extension of ['c', 'cpp']) for (const [body, reason] of [
    [`process.stdout.write(${JSON.stringify(text)} + 'x'.repeat(2 * 1024 * 1024));`, /error ENOBUFS.*error: controlled syntax rejection/],
    [`process.stderr.write(${JSON.stringify(text)}); process.kill(process.pid, 'SIGTERM');`, /signal SIGTERM.*error: controlled syntax rejection/],
    [`process.stderr.write(${JSON.stringify(text)}); process.exit(101);`, /exit status 101.*error: controlled syntax rejection/],
  ]) {
    const fixture = r36iFixture(extension, false);
    r36iCompiler(fixture, body);
    r36iReject(r36iStub(fixture), reason);
  }
});

/** @id TEST-R36I-PARSE-COLOR-001 @verifies REQ-R36I-002 */
test('#373 TEST-R36I-PARSE-COLOR-001 colored actual native missing-function names are parsed into valid stubs', () => {
  for (const extension of ['c', 'cpp']) {
    const fixture = r36iFixture(extension, true);
    fs.writeFileSync(path.join(fixture.d, fixture.file), r36kMissingFunctionSource(fixture.source, extension));
    writeAll(fixture.d, { 'tests/missing.h': '' });
    const native = r36iCompile(fixture);
    assert.equal(native.status, 1, native.stderr);
    assert.match(native.stderr, /answer/);
    const compiler = r36iCompiler(fixture, [
      "import { spawnSync } from 'node:child_process';",
      `const r = spawnSync(${JSON.stringify(fixture.native)}, process.argv.slice(2), { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } });`,
      "process.stdout.write((r.stdout ?? '').replaceAll('answer', 'an\\x1b[31mswer\\x1b[0m'));",
      "process.stderr.write((r.stderr ?? '').replaceAll('answer', 'an\\x1b[31mswer\\x1b[0m'));",
      'process.exit(r.status ?? 1);',
    ].join('\n'));
    const colored = spawnSync(compiler, ['-fsyntax-only', path.join(fixture.d, fixture.file)], {
      cwd: fixture.d, encoding: 'utf8', timeout: 20000, env: ENV,
    });
    assert.equal(colored.status, 1, colored.stderr);
    assert.match(colored.stderr, /an\x1b\[31mswer\x1b\[0m/);
    assert.doesNotMatch(colored.stderr, /ReferenceError|SyntaxError/);
    fs.rmSync(path.join(fixture.d, 'tests/missing.h'));
    const result = r36iStub(fixture);
    assert.equal(result.code, 0, result.out);
    assert.match(result.out, /stubbed \(throwing, compile-checked\)/);
    assert.match(rd130(fixture.d, 'tests/missing.h'), /not implemented: answer/);
    const generated = r36iCompile(fixture);
    assert.equal(generated.status, 0, generated.stderr);
    assert.equal(generated.signal, null);
    assert.equal(generated.error, undefined);
  }
});

const r36gRunStub = (d, id, env = {}, preload = null) => {
  const r = spawnSync(process.execPath, [...(preload ? ['--import', preload] : []), SDD, '--root', d, 'tdd', 'stub', id],
    { encoding: 'utf8', env: { ...ENV, ...env } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  return r.stdout + r.stderr;
};
const r36gFixture = (name, files) => mk130({
  'Cargo.toml': `[package]\nname = "${name}"\nversion = "0.1.0"\nedition = "2021"\n`,
  ...files,
});

/** @id TEST-R36G-001 @verifies REQ-R36G-001 */
test('#372 TEST-R36G-001 native Cargo and rustc witness colored Rust verdicts and generation scope', () => {
  for (const tool of ['cargo', 'rustc']) {
    const version = spawnSync(tool, ['--version'], { encoding: 'utf8' });
    assert.equal(version.status, 0, `${tool} prerequisite required: ${version.stderr}`);
  }
  const cases = [
    ['inline', 's130', 'TEST-A-001', true, { 'tests/t.rs': '// @id TEST-A-001 @verifies REQ-A-001\n#[test]\nfn t10() {\n    let p = s130::geo::Point { x: 1, y: 2 };\n    assert_eq!(p.x, 1);\n}\n' }],
    ['sibling', 's130', 'TEST-A-002', false, { 'tests/t.rs': 'use s130::util::double;\n// @id TEST-A-001 @verifies REQ-A-001\n#[test]\nfn t9() { assert_eq!(double(2), 4); }\n// @id TEST-A-002 @verifies REQ-A-001\n#[test]\nfn t10() {\n    let p = s130::geo::Point { x: 1, y: 2 };\n    assert_eq!(p.x, 1);\n}\n' }],
    ['bool', 's280', 'TEST-A-001', true, { 'tests/t.rs': 'use s280::ops::is_ok;\n// @id TEST-A-001 @verifies REQ-A-001\n#[test]\nfn t1() { assert!(is_ok(3)); }\n' }],
    ['cfg', 's280', 'TEST-A-001', true, { 'src/lib.rs': 'pub mod ops;\n', 'src/ops.rs': '#[cfg(test)]\nmod tests {\n    pub fn double(x: i64) -> i64 { x }\n}\n', 'tests/t.rs': 'use s280::ops::double;\n// @id TEST-A-001 @verifies REQ-A-001\n#[test]\nfn t1() { assert_eq!(double(2), 4); }\n' }],
    ['macro', 's280', 'TEST-A-001', false, { 'tests/t.rs': '// @id TEST-A-001 @verifies REQ-A-001\n#[test]\nfn t1() { let v = entries![1, 2]; assert_eq!(v.len(), 2); }\n' }],
  ];
  const violations = [];
  for (const [kind, name, id, valid, files] of cases) for (const color of ['never', 'always']) {
    const d = r36gFixture(name, files);
    const source = rd130(d, 'tests/t.rs');
    const out = r36gRunStub(d, id, { CARGO_TERM_COLOR: color });
    const cargo = spawnSync('cargo', ['test', '--no-run', '--offline', '--test', 't', '--color', color],
      { cwd: d, encoding: 'utf8', env: { ...ENV, CARGO_TERM_COLOR: color } });
    assert.equal(cargo.status === 0, valid, `${kind}/${color}: independent Cargo\n${cargo.stderr}`);
    const lib = path.join(d, `lib${name}.rlib`);
    const args = ['--edition=2021', '--test', 'tests/t.rs', '-o', path.join(d, 'r36g-tests')];
    if (fs.existsSync(path.join(d, 'src/lib.rs'))) {
      const compiled = spawnSync('rustc', ['--edition=2021', '--crate-name', name, '--crate-type', 'lib', 'src/lib.rs', '-o', lib],
        { cwd: d, encoding: 'utf8' });
      assert.equal(compiled.status, 0, compiled.stderr);
      args.push('--extern', `${name}=${lib}`);
    }
    const rustc = spawnSync('rustc', args, { cwd: d, encoding: 'utf8' });
    assert.equal(rustc.status === 0, valid, `${kind}/${color}: independent rustc\n${rustc.stderr}`);
    assert.equal(rd130(d, 'tests/t.rs'), source, 'requested and sibling tests stay byte-identical');
    if (kind === 'sibling') assert.ok(!fs.existsSync(path.join(d, 'src/util.rs')), 'unrequested import is not stubbed');
    if (kind === 'bool') assert.match(rd130(d, 'src/ops.rs'), /pub fn is_ok<A0>\(_a0: A0\) -> bool/);
    if (kind === 'cfg') assert.match(rd130(d, 'src/ops.rs'), /^pub fn double/m);
    if (valid ? !/\(throwing, compile-checked\)/.test(out) : /\bcompile-checked\b/.test(out)) violations.push(`${kind}/${color}: ${out.trim()}`);
    if (kind === 'macro' && !/macro entries! is not stubbed/.test(out)) violations.push(`${kind}/${color}: missing macro guidance: ${out.trim()}`);
  }
  assert.deepEqual(violations, [], 'native compile verdicts and macro guidance must agree with both independent tools');
});

/** @id TEST-R36G-002 @verifies REQ-R36G-002 */
test('#372 TEST-R36G-002 Cargo process failures cannot become successful compile witnesses', () => {
  const cases = [
    ['empty101', 'process.exit(101);', /Cargo.*exit.*101/i],
    ['terminal101', 'console.error("error: could not compile `s130`"); process.exit(101);', /error: could not compile/],
    ['opaque101', 'console.error("opaque diagnostic"); process.exit(101);', /Cargo.*exit.*101/i],
    ['signal', 'process.kill(process.pid, "SIGTERM");', /Cargo.*signal.*SIGTERM/i],
    ['missing', null, /Cargo.*ENOENT/i],
    ['buffer', 'process.stdout.write("x".repeat(2 * 1024 * 1024));', /Cargo.*ENOBUFS/i],
    ['timeout', 'process.exit(0);', /Cargo.*ETIMEDOUT/i],
    ['zeroError', 'console.error("\\x1b[31merror[E0432]\\x1b[0m: unresolved import `s130::util`"); process.exit(0);', /error\[E0432\]/],
    ['zeroMacro', 'console.error("\\x1b[31merror\\x1b[0m: cannot find macro `entries` in this scope"); process.exit(0);', /macro entries! is not stubbed/],
    ['valid', 'process.exit(0);', /\(throwing, compile-checked\)/],
  ];
  const violations = [];
  for (const [kind, body, diagnostic] of cases) {
    const d = r36gFixture('s130', { 'tests/t.rs': '// @id TEST-A-001 @verifies REQ-A-001\n#[test]\nfn t() { let p = s130::geo::Point { x: 1, y: 2 }; assert_eq!(p.x, 1); }\n' });
    const bin = path.join(d, 'bin');
    fs.mkdirSync(bin);
    fs.symlinkSync(process.execPath, path.join(bin, 'node'));
    if (body !== null) fs.writeFileSync(path.join(bin, 'cargo'), `#!${process.execPath}\n${body}\n`, { mode: 0o755 });
    let preload = null;
    if (kind === 'timeout') {
      preload = path.join(d, 'timeout.mjs');
      fs.writeFileSync(preload, 'import cp from "node:child_process"; import { syncBuiltinESMExports } from "node:module";\nconst original = cp.spawnSync;\ncp.spawnSync = (cmd, ...args) => cmd === "cargo" ? { stdout: "", stderr: "", status: null, signal: "SIGTERM", error: Object.assign(new Error("spawnSync cargo ETIMEDOUT"), { code: "ETIMEDOUT" }) } : original(cmd, ...args);\nsyncBuiltinESMExports();\n');
    }
    const out = r36gRunStub(d, 'TEST-A-001', { PATH: bin, CARGO_TERM_COLOR: 'never' }, preload);
    if (!diagnostic.test(out)) violations.push(`${kind}: expected ${diagnostic}, got ${out.trim()}`);
    if (kind !== 'valid' && /\bcompile-checked\b/.test(out)) violations.push(`${kind}: false compile-checked`);
  }
  assert.deepEqual(violations, [], 'completion metadata and normalized diagnostics are mandatory compile witnesses');
});

/** @id TEST-R36I-LEGACY-001 @verifies REQ-R36I-003 */
test('#373 TEST-R36I-LEGACY-001 legacy string probing remains raw with identical native spawn options', async () => {
  const { runInNewContext } = await import('node:vm');
  const source = fs.readFileSync(SDD, 'utf8');
  const start = source.includes('const probeOutcome =') ? source.indexOf('const probeOutcome =') : source.indexOf('const probe =');
  const block = source.slice(start, source.indexOf('\n\nfunction stubGo', start));
  const calls = [];
  const error = Object.assign(new Error('controlled startup failure'), { code: 'ENOENT' });
  const result = { stdout: '\x1b[31mraw stdout\x1b[0m\n', stderr: 'raw stderr\n', status: null, signal: 'SIGTERM', error };
  const env = { PATH: ENV.PATH, LC_ALL: 'not-C', KEEP: 'sentinel' };
  const api = runInNewContext(`${block}\n({ probe, outcome: typeof probeOutcome === 'function' ? probeOutcome : null });`, {
    process: { env }, spawnSync: (cmd, args, options) => { calls.push({ cmd, args, options }); return result; },
  });
  assert.equal(api.probe('compiler', ['--flag'], '/owned/cwd'), result.stdout + result.stderr);
  if (api.outcome) {
    const outcome = api.outcome('compiler', ['--flag'], '/owned/cwd');
    assert.equal(outcome.text, result.stdout + result.stderr);
    assert.equal(outcome.status, result.status);
    assert.equal(outcome.signal, result.signal);
    assert.equal(outcome.error, error);
  }
  for (const call of calls) {
    assert.equal(call.cmd, 'compiler');
    assert.deepEqual(call.args, ['--flag']);
    assert.equal(call.options.cwd, '/owned/cwd');
    assert.equal(call.options.encoding, 'utf8');
    assert.equal(call.options.timeout, 120000);
    assert.equal(call.options.env.PATH, env.PATH);
    assert.equal(call.options.env.KEEP, env.KEEP);
    assert.equal(call.options.env.LC_ALL, 'C');
  }
  assert.equal(env.LC_ALL, 'not-C', 'probe must not mutate the inherited environment');
});

let r36jSequence = 0;
const r36jArgs = ['test', '-count=1', '-gcflags=-e', '-run', '^$', '.'];
const r36jFixture = (missing = true, invalid = false) => {
  const lookup = spawnSync('which', ['go'], { encoding: 'utf8', env: ENV });
  assert.equal(lookup.status, 0, 'native Go is mandatory for the #374 oracle');
  const d = path.join(work, `r36j-${++r36jSequence}`);
  fs.mkdirSync(path.join(d, '.sdd/specs'), { recursive: true });
  fs.writeFileSync(path.join(d, '.sdd/specs/a.md'), '---\nfeature: a\ntier: T1\n---\n| REQ-A-001 | When called, the system shall return. | TEST-A-001 |\n');
  fs.writeFileSync(path.join(d, 'go.mod'), 'module r36j_go_oracle\n\ngo 1.20\n');
  fs.writeFileSync(path.join(d, 't_test.go'), 'package p\nimport "testing"\n'
    + (invalid ? 'var _ int = "r36i_native_invalid"\n' : '')
    + '// @id TEST-A-001 @verifies REQ-A-001\n'
    + `func TestT(t *testing.T) { t.Fatal(${missing ? 'Missing()' : '0'}) }\n`);
  const fixture = { d, native: lookup.stdout.trim() };
  spawnSync('git', ['init', '-q'], { cwd: d, env: ENV });
  return fixture;
};
const r36jCompile = (fixture) => {
  const r = spawnSync(fixture.native, r36jArgs, {
    cwd: fixture.d, encoding: 'utf8', timeout: 20000, env: { ...ENV, LC_ALL: 'C' },
  });
  assert.equal(r.error, undefined, String(r.error));
  assert.equal(r.signal, null, 'native Go must finish normally');
  return { ...r, text: (r.stdout ?? '') + (r.stderr ?? '') };
};
const r36jControlled = (fixture, body, color = false) => {
  const bin = path.join(fixture.d, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'package.json'), '{"type":"module"}\n');
  const file = path.join(bin, 'go');
  const count = path.join(bin, 'calls');
  fs.writeFileSync(file, `#!${process.execPath}\nimport fs from 'node:fs';\nimport { spawnSync } from 'node:child_process';\n`
    + `const count=${JSON.stringify(count)}; const n=fs.existsSync(count)?Number(fs.readFileSync(count,'utf8')):0; fs.writeFileSync(count,String(n+1));\n`
    + `if(n===0${color ? '||true' : ''}) { const r=spawnSync(${JSON.stringify(fixture.native)},process.argv.slice(2),{cwd:process.cwd(),encoding:'utf8',env:process.env});\n`
    + (color ? 'const decorate=(s)=>s.replace(/Missing/g,"Mis\\x1b[31msing\\x1b[0m"); process.stdout.write(decorate(r.stdout??"")); process.stderr.write(decorate(r.stderr??""));\n' : 'process.stdout.write(r.stdout??""); process.stderr.write(r.stderr??"");\n')
    + `process.exit(r.status??99); }\n${body}\n`, { mode: 0o755 });
  return { bin, file, count };
};
const r36jStub = (fixture, control = null, outcome = null) => {
  const args = [];
  if (outcome) {
    const preload = path.join(fixture.d, 'outcome.mjs');
    fs.writeFileSync(preload, 'import cp from "node:child_process"; import { syncBuiltinESMExports } from "node:module";\n'
      + 'const original=cp.spawnSync; let n=0;\n'
      + `cp.spawnSync=(cmd,...args)=>cmd==="go"&&++n>1?(${outcome}):original(cmd,...args); syncBuiltinESMExports();\n`);
    args.push('--import', preload);
  }
  args.push(SDD, '--root', fixture.d, 'tdd', 'stub', 'TEST-A-001');
  const r = spawnSync(process.execPath, args, {
    cwd: fixture.d, encoding: 'utf8', timeout: 20000,
    env: { ...ENV, ...(control ? { PATH: control.onlyBin ? control.bin : `${control.bin}:${ENV.PATH}` } : {}) },
  });
  assert.equal(r.error, undefined, String(r.error));
  assert.equal(r.signal, null, 'stub CLI must return an ordinary verdict');
  return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
};
const r36jReject = (r, reason) => {
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /does not compile|could not fully stub/, r.out);
  assert.doesNotMatch(r.out, /\(throwing, compile-checked\)|\(compile-checked\)/, r.out);
  assert.match(r.out, reason, r.out);
};

/** @id TEST-R36J-EXIT-001 @verifies REQ-R36J-001 */
test('#374 TEST-R36J-EXIT-001 silent unsuccessful Go processes never verify generated or native-valid no-op fixtures', () => {
  for (const missing of [true, false]) {
    const fixture = r36jFixture(missing);
    const before = r36jCompile(fixture);
    assert.equal(before.status, missing ? 1 : 0, before.text);
    if (missing) assert.match(before.text, /undefined: Missing/);
    const control = r36jControlled(fixture, 'process.exit(101);');
    const result = r36jStub(fixture, control);
    assert.ok(Number(fs.readFileSync(control.count, 'utf8')) >= 2, 'final compiler must actually execute');
    r36jReject(result, /Go.*exit status 101/);
  }
});

/** @id TEST-R36J-INVALID-001 @verifies REQ-R36J-001 REQ-R36J-003 */
test('#374 TEST-R36J-INVALID-001 exact independently native-invalid fixture stays invalid despite silent final101', () => {
  const fixture = r36jFixture(true, true);
  const before = r36jCompile(fixture);
  assert.equal(before.status, 1, before.text);
  assert.match(before.text, /r36i_native_invalid/);
  assert.match(before.text, /undefined: Missing/);
  const control = r36jControlled(fixture, 'process.exit(101);');
  const result = r36jStub(fixture, control);
  assert.match(fs.readFileSync(path.join(fixture.d, 't.go'), 'utf8'), /func Missing\(\) any/);
  const after = r36jCompile(fixture);
  assert.equal(after.status, 1, after.text);
  assert.match(after.text, /r36i_native_invalid/);
  const actual = spawnSync(control.file, r36jArgs, { cwd: fixture.d, encoding: 'utf8', env: ENV });
  assert.equal(actual.status, 101);
  assert.equal(actual.stdout + actual.stderr, '');
  r36jReject(result, /Go.*exit status 101/);
});

/** @id TEST-R36J-BOUNDARY-001 @verifies REQ-R36J-001 */
test('#374 TEST-R36J-BOUNDARY-001 real opaque terminal-only signal missing-command and output-overflow outcomes fail closed', () => {
  const cases = [
    ['process.stderr.write("\\x1b[31m\\x1b[0m"); process.exit(101);', /Go.*exit status 101/],
    ['process.stderr.write("opaque Go failure"); process.exit(101);', /Go.*exit status 101/],
    ['process.kill(process.pid,"SIGTERM");', /Go.*signal SIGTERM/],
    ['fs.unlinkSync(process.argv[1]); process.exit(101);', /Go.*error ENOENT/],
    ['process.stdout.write("x\\n".repeat(1024*1024));', /Go.*error ENOBUFS/],
  ];
  for (const [body, reason] of cases) {
    const fixture = r36jFixture();
    const control = r36jControlled(fixture, body);
    if (body.includes('unlinkSync')) control.onlyBin = true;
    r36jReject(r36jStub(fixture, control), reason);
  }
});

/** @id TEST-R36J-MALFORMED-001 @verifies REQ-R36J-001 */
test('#374 TEST-R36J-MALFORMED-001 deterministic unavailable timeout and inconsistent success outcomes are rejected', () => {
  const cases = [
    ['{stdout:"",stderr:"",status:null,signal:null}', /Go.*status unavailable/],
    ['{stdout:"",stderr:"",signal:null}', /Go.*status unavailable/],
    ['{stdout:"",stderr:"",status:0,signal:"SIGTERM"}', /Go.*signal SIGTERM/],
    ['{stdout:"",stderr:"",status:0,signal:null,error:{code:"ENOENT"}}', /Go.*error ENOENT/],
    ['{stdout:"",stderr:"",status:null,signal:"SIGTERM",error:{code:"ETIMEDOUT"}}', /Go.*error ETIMEDOUT/],
  ];
  for (const [outcome, reason] of cases) r36jReject(r36jStub(r36jFixture(), null, outcome), reason);
});

/** @id TEST-R36J-REASON-001 @verifies REQ-R36J-001 */
test('#374 TEST-R36J-REASON-001 process reason priority dominates supplementary Go file diagnostics', () => {
  const cases = [
    ['{status:101,signal:"SIGTERM",error:{code:"ENOBUFS"}}', /Go.*error ENOBUFS; .*controlled rejection/],
    ['{status:101,signal:"SIGTERM"}', /Go.*signal SIGTERM; .*controlled rejection/],
    ['{status:null,signal:null}', /Go.*status unavailable; .*controlled rejection/],
    ['{status:101,signal:null}', /Go.*exit status 101; .*controlled rejection/],
  ];
  for (const [fields, reason] of cases) {
    const outcome = `{stdout:"",stderr:"t_test.go:5:36: controlled rejection\\n",...${fields}}`;
    r36jReject(r36jStub(r36jFixture(), null, outcome), reason);
  }
});

/** @id TEST-R36J-DIAGNOSTIC-001 @verifies REQ-R36J-002 */
test('#374 TEST-R36J-DIAGNOSTIC-001 zero exit cannot erase plain or internally SGR-split Go compiler diagnostics', () => {
  for (const text of ['t_test.go:5:36: controlled rejection\n', 't_test.g\x1b[31mo\x1b[0m:5:36: controlled rejection\n']) {
    const fixture = r36jFixture();
    const control = r36jControlled(fixture, `process.stderr.write(${JSON.stringify(text)}); process.exit(0);`);
    r36jReject(r36jStub(fixture, control), /t_test\.go:5:36: controlled rejection/);
  }
});

/** @id TEST-R36J-NATIVE-001 @verifies REQ-R36J-003 */
test('#374 TEST-R36J-NATIVE-001 independent native Go witnesses valid throwing generation and inferred return type', () => {
  const valid = r36jFixture(false);
  assert.equal(r36jCompile(valid).status, 0);
  const fixture = r36jFixture();
  const before = r36jCompile(fixture);
  assert.equal(before.status, 1, before.text);
  assert.match(before.text, /undefined: Missing/);
  const result = r36jStub(fixture);
  assert.equal(result.code, 0, result.out);
  assert.match(result.out, /stubbed \(throwing, compile-checked\)/, result.out);
  assert.match(fs.readFileSync(path.join(fixture.d, 't.go'), 'utf8'), /func Missing\(\) any[\s\S]*panic\("not implemented: Missing"\)/);
  const after = r36jCompile(fixture);
  assert.equal(after.status, 0, after.text);
});

/** @id TEST-R36J-COLOR-001 @verifies REQ-R36J-002 */
test('#374 TEST-R36J-COLOR-001 colored actual native missing-symbol diagnostics retain independently valid inference', () => {
  const fixture = r36jFixture();
  const control = r36jControlled(fixture, '', true);
  const witness = spawnSync(control.file, r36jArgs, { cwd: fixture.d, encoding: 'utf8', env: ENV });
  assert.equal(witness.status, 1, witness.stdout + witness.stderr);
  assert.match(witness.stderr, /undefined: Mis\x1b\[31msing\x1b\[0m/);
  fs.rmSync(control.count);
  const result = r36jStub(fixture, control);
  assert.equal(result.code, 0, result.out);
  assert.match(result.out, /stubbed \(throwing, compile-checked\)/, result.out);
  assert.match(fs.readFileSync(path.join(fixture.d, 't.go'), 'utf8'), /func Missing\(\) any/);
  const after = r36jCompile(fixture);
  assert.equal(after.status, 0, after.text);
});

// A bare C call is only a warning on GCC <=13; an undeclared address is invalid on both defaults.
const r36kMissingFunctionSource = (source, extension) => source.replace('return 0;', extension === 'c' ? '(void)sizeof(&answer); return answer(2);' : 'return answer(2);');

/** @id TEST-R36K-PORTABILITY-001 @verifies REQ-R36K-001 */
test('#375 TEST-R36K-PORTABILITY-001 missing-function fixture is natively invalid independently of implicit-call severity', () => {
  for (const [extension, severity] of [['c', 'warning'], ['c', 'error'], ['cpp', 'default']]) {
    const fixture = r36iFixture(extension, true);
    const compile = () => spawnSync(fixture.native, [
      '-fsyntax-only',
      ...(severity === 'default' ? [] : [`-W${severity === 'warning' ? 'no-error' : 'error'}=implicit-function-declaration`]),
      path.join(fixture.d, fixture.file),
    ], { cwd: fixture.d, encoding: 'utf8', timeout: 20000, env: { ...ENV, LC_ALL: 'C' } });
    const source = r36kMissingFunctionSource(fixture.source, extension);
    fs.writeFileSync(path.join(fixture.d, fixture.file), source);
    writeAll(fixture.d, { 'tests/missing.h': '' });
    const missing = compile();
    assert.equal(missing.status, 1, missing.stderr);
    assert.equal(missing.signal, null);
    assert.equal(missing.error, undefined);
    assert.match(missing.stderr, /answer.*(?:undeclared|not declared)|undeclared identifier.*answer/);
    assert.match(missing.stderr, /implicit declaration of function 'answer'|'answer' was not declared in this scope|use of undeclared identifier 'answer'|call to undeclared function 'answer'/);
    if (extension === 'c') assert.match(missing.stderr, new RegExp(`${severity}: (?:implicit declaration of function|call to undeclared function) 'answer'`));
    writeAll(fixture.d, { 'tests/missing.h': 'static int answer(int value) { return value; }\n' });
    const valid = compile();
    assert.equal(valid.status, 0, valid.stderr);
    assert.equal(valid.signal, null);
    assert.equal(valid.error, undefined);
    fs.writeFileSync(path.join(fixture.d, fixture.file), '#error r36k_native_invalid\n' + source);
    const invalid = compile();
    assert.equal(invalid.status, 1, invalid.stderr);
    assert.match(invalid.stderr, /r36k_native_invalid/);
    assert.equal(invalid.signal, null);
    assert.equal(invalid.error, undefined);
  }
});

/** @id TEST-R36H2-CWD-001 @verifies REQ-R36H2-CWD-001 */
test('#371 TEST-R36H2-CWD-001 native pytest fixture contains cache from a foreign suite cwd', () => {
  const foreign = fs.mkdtempSync(path.join(work, 'r36h2-foreign-'));
  const suite = fileURLToPath(import.meta.url);
  const result = spawnSync(process.execPath, [
    '--test', '--test-reporter=tap',
    '--test-name-pattern=^#371 TEST-R36H-PYTEST-001 hosted provisioning runs actual pytest with user-site disabled$',
    suite,
  ], { cwd: foreign, env: ENV, encoding: 'utf8', timeout: 60000, maxBuffer: 8e6 });
  const output = result.stdout + result.stderr;
  assert.equal(result.error, undefined, output);
  assert.equal(result.status, 0, output);
  assert.match(output, /ok \d+ - \\?#371 TEST-R36H-PYTEST-001 hosted provisioning runs actual pytest with user-site disabled/, output);
  assert.deepEqual(fs.readdirSync(foreign), [], 'native pytest must not leak .pytest_cache outside owned runnerTemp');
});
