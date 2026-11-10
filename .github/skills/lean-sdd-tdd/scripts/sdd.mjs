#!/usr/bin/env node
// Lean SDD/TDD evidence tool. Zero dependencies, Node >= 20.
// Commands: init | approve prepare|record | guard | tdd red|green|refactor|check | trace | gate | status
import { createHash } from 'node:crypto';
import { isUtf8 } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { builtinModules } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BOOL = new Set(['allow-setup-red', 'allow-config-weaken', 'missing-module', 'baseline', 'weak', 'changed', 'json', 'no-run', 'verbose', 'help', 'stale', 'report', 'explain']);
function parseArgs(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      if (k === 'baseline' && argv.includes('gate') && i + 1 < argv.length && !argv[i + 1].startsWith('--')) flags[k] = argv[++i];
      else if (BOOL.has(k) || i + 1 >= argv.length || argv[i + 1].startsWith('--')) flags[k] = true;
      else flags[k] = argv[++i];
    } else pos.push(a);
  }
  return { pos, flags };
}

const { pos, flags } = parseArgs(process.argv.slice(2));
const ROOT = path.resolve(typeof flags.root === 'string' ? flags.root : process.cwd());
const SDD = path.join(ROOT, '.sdd');
const SPECS = path.join(SDD, 'specs');
const CONFIG = path.join(SDD, 'config.json');
const APPROVALS = path.join(SDD, 'approvals.json');
const PREPARE_SHOWN = path.join(SDD, 'prepare-shown.json');
const LEDGER = path.join(SDD, 'tdd.jsonl');
const RETIRED_REQS = path.join(SDD, 'retired-reqs.json');
const planningCommand = ['plan', 'context', 'gate'].includes(pos[0]);
let planningModules = [];
if (planningCommand) {
  try {
    planningModules = await Promise.all([import('./implementation-plan.mjs'),
      import('./implementation-plan-evidence.mjs'), import('./implementation-plan-cli.mjs')]);
  } catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  }
}
const [planningModel = {}, planningEvidence = {}, planningCli = {}] = planningModules;
const { PlanningError, loadImplementationPlan } = planningModel;
const { evaluateImplementationPlan } = planningEvidence;
const { readPlanningConfiguration, planningRefusal, planningTaskScope,
  publicPlanningResult, emitPlanningResult, runPlanningCommand } = planningCli;

const sha = (b) => createHash('sha256').update(b).digest('hex');
const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');
const readJson = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } };
const writeJson = (p, v) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(v, null, 2) + '\n'); };
const fileSha = (p) => sha(fs.readFileSync(path.resolve(ROOT, p)));
// BOM and CRLF are not content: lock hashes ignore them (#72); older locks hold the raw hash, which is still accepted
const artifactSha = (p) => sha(fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n'));
// Evidence is keyed to the test's own @id region (+ the preamble before the first @id: imports/helpers), so editing one test does not invalidate its siblings (#38).
// Brace-language tests also protect shared oracles, excluding annotated implementation; their unsafe legacy hashes no longer match.
// trim: drop trailing blank/col-0 closer lines (a describe's `});`) so appending a new test after the last one keeps its evidence.
// norm: hash import statements by module only, so adding a name to an import list does not stale sibling tests (#55). trim=false/norm=false are the legacy hashes.
const normImports = (t) => t
  .replace(/\bimport\s+(?:type\s+)?[\w$*{}\s,]*?\s*from\s*(['"][^'"]+['"])\s*;?/g, 'import from $1')
  .replace(/^from\s+(\S+)\s+import\s*(?:\([^)]*\)|.*)$/gm, 'from $1');
// opt-in `.sdd/config.json` preambleGranularity "symbol" (#300): the shared preamble is split into declarations (import/use/include/other statements: any change stales every test)
// and named top-level helper/fixture blocks (function/class/const/def/fn/struct…): a change stales only tests whose own body (transitively through helpers) names that helper.
// symbolOff lets a ledger recorded before the option was enabled keep matching its old whole-preamble hash.
let symbolOff = false;
const symbolMode = () => !symbolOff && readJson(CONFIG, null)?.preambleGranularity === 'symbol';
const SYMBOL_HELPER = /^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?(?:pub(?:\([^)]*\))?\s+)?(?:unsafe\s+)?(?:abstract\s+)?(?:function\*?|class|const|let|var|type|interface|enum|def|fn|struct|trait|static)\s+(?:<[^>]*>\s*)?([A-Za-z_$][\w$]*)|^impl(?:<[^>]*>)?\s+(?:[\w:]+(?:<[^>]*>)?\s+for\s+)?([A-Za-z_]\w*)|^([A-Za-z_]\w*)\s*(?::[^=\n]+)?=(?!=)/;
function symbolPreamble(pre, mineBody, extraBodies = []) {
  const chunks = [];
  let pending = [], cur = null;
  for (const l of pre.split('\n')) {
    const prefix = /^(?:\/\/|#(?!include|import|define)|\/\*|\*|@\w|#\[)/.test(l);
    if (!l.trim()) { (cur ?? { lines: pending }).lines.push(l); continue; }
    if (/^\s/.test(l) || /^[)\]}]/.test(l) || (cur && cur.open && !prefix && /^(?:else|catch|finally)\b/.test(l))) { (cur ?? { lines: pending }).lines.push(l); continue; }
    if (prefix) { if (cur) { chunks.push(cur); cur = null; } pending.push(l); continue; }
    if (cur) chunks.push(cur);
    cur = { lines: [...pending, l], first: l }; pending = [];
    cur.open = true;
  }
  if (cur) chunks.push(cur);
  const decl = [...(cur ? [] : pending)], helpers = [];
  for (const c of chunks) {
    const m = SYMBOL_HELPER.exec(c.first.trim());
    const isImport = /=\s*(?:await\s+)?require\(|^import\b/.test(c.first);
    const name = !isImport && m && (m[1] ?? m[2] ?? m[3]);
    if (name) helpers.push({ name, body: c.lines.join('\n').trim() }); else decl.push(c.lines.join('\n'));
  }
  const chosen = new Set();
  let calls = mineBody + '\n' + extraBodies.join('\n');
  for (;;) {
    const next = helpers.filter((h) => !chosen.has(h) && new RegExp(`(?<![\\w$])${h.name.replace(/\$/g, '\\$')}(?![\\w$])`).test(calls));
    if (!next.length) break;
    for (const h of next) { chosen.add(h); calls += '\n' + h.body; }
  }
  return decl.join('\n').split('\n').filter((l) => l.trim()).join('\n').trim() + '\u0001' + helpers.filter((h) => chosen.has(h)).map((h) => h.body).join('\u0000');
}
const pythonScopes = new Map();
function pythonScope(txt) {
  if (pythonScopes.has(txt)) return pythonScopes.get(txt);
  const parser = `import ast,json,re,sys
src=sys.stdin.read()
ls=src.splitlines()
tree=ast.parse(src)
ranges=[]
for n in ast.walk(tree):
    if not isinstance(n,(ast.FunctionDef,ast.AsyncFunctionDef)): continue
    start=min([n.lineno]+[d.lineno for d in n.decorator_list])-1
    while start>0 and (not ls[start-1].strip() or ls[start-1].lstrip().startswith("#")):
        start-=1
    ids=re.findall(r"@id\\s+(TEST-[A-Z0-9-]+)", "\\n".join(ls[start:n.end_lineno]))
    if ids or n.name.startswith("test"):
        ranges.append(dict(start=start,end=n.end_lineno,ids=ids))
print(json.dumps(ranges))
`;
  const r = spawnSync('python3', ['-c', parser], { input: txt, encoding: 'utf8', timeout: 10000, maxBuffer: 8 * 1024 * 1024 });
  let ranges = null;
  try { if (r.status === 0) ranges = JSON.parse(r.stdout); } catch {}
  pythonScopes.set(txt, ranges);
  return ranges;
}
function pythonTestSha(txt, id) {
  const ranges = pythonScope(txt);
  const mine = ranges?.find((r) => r.ids.includes(id));
  if (!mine) return sha(txt);
  const ls = txt.split('\n');
  const shared = ls.filter((_, i) => !ranges.some((r) => i >= r.start && i < r.end)).join('\n').trim();
  const own = ls.slice(mine.start, mine.end).join('\n').trim();
  if (symbolMode()) return sha(symbolPreamble(shared, own) + '\u0000' + own);
  return sha(shared + '\u0000' + own);
}
const BRACE_TEST = /\.(rs|java|php|cs|c|cc|cpp|cxx)$/;
const maskBraces = (txt, rust = false) => txt.replace(rust ? /\/\*[\s\S]*?\*\/|\/\/[^\n]*|\b(?:br|r)(#+)"[\s\S]*?"\1|\b(?:br|r)"[\s\S]*?"|"(?:\\[\s\S]|[^"\\])*"|'(?:\\.|[^'\\\n])'/g : /\/\*[\s\S]*?\*\/|\/\/[^\n]*|(?<!\w)(?:u8|u|U|L)?R"([^()\\\s]{0,16})\([\s\S]*?\)\1"|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'/g, (s) => s.replace(/[^\n]/g, ' '));
function sharedOutside(txt, ranges, start = 0) {
  let shared = '', cursor = start;
  for (const r of [...ranges].sort((a, b) => a.start - b.start)) {
    if (r.end <= cursor) continue;
    shared += txt.slice(cursor, Math.max(cursor, r.start));
    cursor = r.end;
  }
  return (shared + txt.slice(cursor)).split('\n').filter((l) => l.trim()).join('\n').trim();
}
function protectedHelpers(mine, helpers, shared, insensitive = false) {
  return reachableHelpers(mine, helpers, shared, insensitive).map((r) => r.body.trim()).join('\u0000');
}
function reachableHelpers(mine, helpers, shared, insensitive = false) {
  const selected = new Set();
  let calls = mine.body + '\n' + shared;
  for (;;) {
    const next = helpers.filter((r) => !selected.has(r) && (r.implicit && ownerApplies(mine, r) || new RegExp(`\\b${r.name}\\b`, insensitive ? 'i' : '').test(calls)));
    if (!next.length) break;
    for (const r of next) { selected.add(r); calls += '\n' + r.body; }
  }
  function ownerApplies(mine, helper) {
    if (!helper.owner || !mine.owner || mine.owner === helper.owner || mine.owner.startsWith(helper.owner + '$') || mine.owner.startsWith(helper.owner + '+')) return true;
    const seen = new Set();
    const inherited = (owner) => {
      if (seen.has(owner)) return false;
      seen.add(owner);
      for (const t of sourceTypes().filter((t) => t.ext === path.extname(mine.file) && (t.fq === owner || owner.endsWith('$' + t.name) || owner.endsWith('+' + t.name)))) {
        const declaration = new RegExp(`\\b(?:class|record)\\s+${t.name}(?:<[^>]+>)?\\s*(?:extends|:)\\s*([\\w.\\\\]+)`).exec(t.text);
        if (!declaration) continue;
        for (const f of localTypeFiles(path.join(ROOT, t.file), t.text, declaration[1])) {
          for (const base of sourceTypes().filter((b) => path.join(ROOT, b.file) === f && b.name === declaration[1].split(/[.\\]/).at(-1))) if (base.fq === helper.owner || inherited(base.fq)) return true;
        }
      }
      return false;
    };
    return inherited(mine.owner);
  }
  return [...selected].sort((a, b) => a.start - b.start);
}
function maskAttributes(masked) {
  for (const m of [...masked.matchAll(/^[ \t]*(?:#\[|\[(?=[A-Za-z_]))/gm)].reverse()) {
    let end = m.index + m[0].length, depth = 1;
    for (; end < masked.length && depth; end++) {
      if (masked[end] === '[') depth++;
      else if (masked[end] === ']') depth--;
    }
    masked = masked.slice(0, m.index) + masked.slice(m.index, end).replace(/[^\n]/g, ' ') + masked.slice(end);
  }
  return masked;
}
function phpImports(txt, kind = '') {
  const aliases = new Map();
  const masked = maskBraces(txt);
  // `use Trait;` inside a class body is not an import (#222)
  const bodyDepths = [], stack = [];
  for (const t of masked.matchAll(/\bnamespace\s*[\w\\]*\s*\{|[{}]/g)) {
    if (t[0] === '}') stack.pop(); else stack.push(t[0] === '{');
    bodyDepths.push([t.index, stack.filter(Boolean).length]);
  }
  const insideBody = (index) => (bodyDepths.filter(([at]) => at < index).at(-1)?.[1] ?? 0) > 0;
  for (const m of masked.matchAll(/\buse\s+([^;]+);/gi)) {
    if (insideBody(m.index)) continue;
    const group = /^([^{}]+)\{([^{}]+)\}$/.exec(m[1].trim());
    const prefix = /^(?:(function|const)\s+)?(.*)$/i.exec((group?.[1] ?? '').trim());
    for (const item of (group?.[2] ?? m[1]).split(',')) {
      const use = /^\s*(?:(function|const)\s+)?(\\?[\w\\]+)(?:\s+as\s+(\w+))?\s*$/i.exec(item);
      if (use && (use[1]?.toLowerCase() ?? prefix[1]?.toLowerCase() ?? '') === kind) aliases.set(use[3] ?? use[2].split('\\').at(-1), (prefix[2] + use[2]).replace(/^\\/, ''));
    }
  }
  return aliases;
}
let localTypes;
function sourceTypes() {
  return localTypes ??= workspaceFiles().filter((f) => /\.(java|php|cs)$/.test(f)).flatMap((file) => {
    const text = fs.readFileSync(path.join(ROOT, file), 'utf8'), ext = path.extname(file);
    const ns = ext === '.java' ? /\bpackage\s+([\w.]+)\s*;/.exec(text)?.[1] : /\bnamespace\s+([\w.\\]+)/.exec(text)?.[1];
    return [...text.matchAll(/\b(?:class|interface|trait|record|struct|enum)\s+(\w+)/g)].map((m) => {
      const scope = qualifiedTestScope(file, text, m.index);
      const namespace = ext === '.php' ? ns ?? '' : [ns].filter(Boolean).join('.');
      const nested = scope && scope !== namespace;
      const fq = [scope || namespace, m[1]].filter(Boolean).join(ext === '.php' ? '\\' : nested ? ext === '.java' ? '$' : '+' : '.');
      return { file, text, ext, ns: ns ?? '', name: m[1], fq };
    });
  });
}
function localTypeFiles(file, text, name) {
  const ext = path.extname(file), separator = ext === '.php' ? '\\' : '.';
  let ns = ext === '.java' ? /\bpackage\s+([\w.]+)\s*;/.exec(text)?.[1] : /\bnamespace\s+([\w.\\]+)/.exec(text)?.[1];
  const aliases = ext === '.php' ? phpImports(text) : new Map([...text.matchAll(ext === '.java' ? /\bimport\s+(?!static\b)([\w.]+)\s*;/g : /\busing\s+(\w+)\s*=\s*(?:global::)?([\w.]+)\s*;/g)].map((m) => ext === '.java' ? [m[1].split('.').at(-1), m[1]] : [m[1], m[2]]));
  const names = new Set([aliases.get(name) ?? [ns, name].filter(Boolean).join(separator), name.replace(/^\\|^global::/, '')]);
  for (const t of sourceTypes()) if (t.file === rel(file) && t.name === name) names.add(t.fq);
  if (ext !== '.php') for (const m of text.matchAll(ext === '.java' ? /\bimport\s+([\w.]+)\.\*\s*;/g : /\busing\s+([\w.]+)\s*;/g)) names.add(m[1] + '.' + name);
  let matches = sourceTypes().filter((t) => t.ext === ext && names.has(t.fq));
  if (!matches.length && !ns && !aliases.has(name)) matches = sourceTypes().filter((t) => t.ext === ext && t.name === name);
  if (ext === '.cs') {
    const graph = dotnetGraph(ROOT), owners = graph.ownersOf(rel(file));
    if (owners.length) matches = matches.filter((t) => graph.ownersOf(t.file).some((o) => owners.some((owner) => graph.deps(owner.file).has(o.file))));
  }
  return [...new Set(matches.map((t) => path.join(ROOT, t.file)))];
}
function lifecycleAttribute(body, txt, p) {
  if (/\.php$/.test(p)) return phpLifecycle(body, txt);
  const cs = /\.cs$/.test(p);
  const builtins = cs ? /^(?:TestInitialize|TestCleanup|ClassInitialize|ClassCleanup|AssemblyInitialize|AssemblyCleanup|SetUp|TearDown|OneTimeSetUp|OneTimeTearDown)$/ : /^(?:BeforeEach|BeforeAll|AfterEach|AfterAll|Before|After)$/;
  const aliases = cs ? new Map([...txt.matchAll(/\busing\s+(\w+)\s*=\s*(?:global::)?([\w.]+)\s*;/g)].map((m) => [m[1], m[2]])) : new Map();
  const names = cs ? [...body.matchAll(/\[([\s\S]*?)\]/g)].flatMap((m) => [...m[1].matchAll(/(?:^|,)\s*((?:global::)?[\w.]+)/g)].map((n) => n[1])) : [...body.matchAll(/@([\w.]+)/g)].map((m) => m[1]);
  const seen = new Set();
  const lifecycle = (name) => {
    name = (aliases.get(name) ?? name).split('.').at(-1).replace(cs ? /Attribute$/ : /$^/, '');
    if (builtins.test(name)) return true;
    if (cs || seen.has(name)) return false;
    seen.add(name);
    const definitions = sourceTypes().filter((t) => t.ext === '.java' && t.name === name && new RegExp(`@interface\\s+${name}\\b`).test(t.text));
    if (!definitions.length) return !/^(?:Override|SuppressWarnings|SafeVarargs|Deprecated|Test|ParameterizedTest|RepeatedTest|TestFactory|TestTemplate|Nested|Order|DisplayName|Timeout|Disabled|Tag|ExtendWith|TestInstance|Retention|Target|Documented|Inherited)$/.test(name);
    return definitions.some((t) => {
      const at = t.text.search(new RegExp(`@interface\\s+${name}\\b`));
      const pre = t.text.slice(Math.max(t.text.lastIndexOf('}', at) + 1, t.text.lastIndexOf(';', at) + 1), at);
      return [...pre.matchAll(/@([\w.]+)/g)].some((m) => lifecycle(m[1]));
    });
  };
  return names.some(lifecycle);
}
function braceFunctions(txt, p) {
  let masked = maskBraces(txt, /\.rs$/.test(p));
  const blank = (s) => s.replace(/[^\n]/g, ' ');
  if (/\.java$/.test(p)) masked = masked.replace(/@[\w.]+(?:\([^)]*\))?/g, blank);
  if (/\.(?:php|cs)$/.test(p)) masked = maskAttributes(masked);
  const ls = txt.split('\n'), offsets = [];
  let offset = 0;
  for (const l of ls) { offsets.push(offset); offset += l.length + 1; }
  const ranges = [];
  const decl = /^\s*(?:(?:pub(?:\([^)]*\))?|public|private|protected|static|final|async|virtual|override|inline|unsafe|extern|abstract|sealed|partial)\s+)*(?:fn\s+|function\s+|[A-Za-z_][\w:<>\[\],.?*& \t]*\s+)([A-Za-z_]\w*)\s*\([^;{}]*\)\s*(?::\s*[\w\\?]+|->\s*[^{};\n]+|throws\s+[^{};\n]+)?\s*(\{|=>)/gm;
  const heads = [...masked.matchAll(decl)];
  if (/\.(?:c|cc|cpp|cxx)$/.test(p)) {
    // top-level `TEST(suite, name) {` style macros declare a function: give each its own region (#220/#223)
    const depthAt = (index) => { let depth = 0; for (let i = 0; i < index; i++) { if (masked[i] === '{') depth++; else if (masked[i] === '}') depth--; } return depth; };
    for (const m of masked.matchAll(/^[ \t]*([A-Z][A-Z0-9_]*)[ \t]*\(([^()]*)\)\s*(\{)/gm)) {
      if (/^(?:IF|FOR|WHILE|SWITCH|RETURN|ELSE)$/.test(m[1]) || depthAt(m.index)) continue;
      const names = [...m[2].matchAll(/[A-Za-z_]\w*/g)].map((n) => n[0]);
      heads.push(Object.assign([m[0], names.at(-1) ?? m[1], m[3]], { index: m.index }));
    }
    heads.sort((a, b) => a.index - b.index);
  }
  for (const m of heads) {
    const open = m.index + m[0].length - m[2].length;
    let end = open, depth = 0;
    if (m[2] === '=>') { end = masked.indexOf(';', open); if (end < 0) return null; end++; }
    else {
      for (; end < masked.length; end++) { if (masked[end] === '{') depth++; else if (masked[end] === '}' && --depth === 0) { end++; break; } }
      if (depth) return null;
    }
    let line = offsets.findLastIndex((o) => o <= m.index + m[0].search(/\S/));
    while (line > 0 && offsets[line - 1] >= (ranges.at(-1)?.end ?? 0) && (!masked.slice(offsets[line - 1], offsets[line] - 1).trim() || /^\s*(\/\/|\/\*|\*|#\[|@\w|\[)/.test(ls[line - 1]))) line--;
    const start = offsets[line];
    const body = txt.slice(start, end);
    const implicit = /\.(?:java|cs|php)$/.test(p) && (lifecycleAttribute(body, txt, p) || (/\.cs$/.test(p) && /^(?:Dispose|DisposeAsync|InitializeAsync)$/.test(m[1])) || (/\.php$/.test(p) && /^(?:setUp|tearDown|setUpBeforeClass|tearDownAfterClass|assertPreConditions|assertPostConditions)$/i.test(m[1])));
    const namedTest = /^test_/.test(m[1]) && (!/\.php$/.test(p) || !/\b(?:private|protected)\s+(?:static\s+)?function\b/.test(body));
    ranges.push({ start, end, name: m[1], body, implicit, file: p, owner: /\.(?:java|cs|php)$/.test(p) ? qualifiedTestScope(p, txt, open) : '', test: /@id\s+TEST-|#\[test\]|@(?:[\w.]+\.)?(?:Test|ParameterizedTest|RepeatedTest|TestFactory|TestTemplate)\b|\[(?:Fact|Theory|Test|TestCase|TestMethod|DataRow)\b/.test(body) || namedTest, code: /@id\s+CODE-/.test(body) });
  }
  return ranges;
}
function phpLifecycle(body, txt) {
  const aliases = new Map([...phpImports(txt)].map(([a, b]) => [a.toLowerCase(), b]));
  const lifecycle = /^(?:Before|After|BeforeClass|AfterClass|PreCondition|PostCondition)$/i;
  return [...body.matchAll(/#\[([^\]]*)\]/g)].some((attr) => [...attr[1].matchAll(/(?:^|,)\s*(\\?[\w\\]+)/g)].some((m) => lifecycle.test((aliases.get(m[1].toLowerCase()) ?? m[1]).split('\\').at(-1))));
}
// Protect shared oracles without including sibling tests or annotated implementation (#166/#170).
// evidence recorded before #236 hashed registration macros and comments as shared code
let cLegacy = false;
// the `///` block holding a doc test's `@id`: its own oracle, so editing the documented implementation keeps the Red valid (#287)
function rustDocBlock(txt, id) {
  const ls = txt.split('\n'), at = ls.findIndex((l) => new RegExp(`^\\s*//[/!].*@id\\s+${id}(?![\\w-])`).test(l));
  if (at < 0) return null;
  let a = at, b = at;
  while (a > 0 && /^\s*\/\/[/!]/.test(ls[a - 1])) a--;
  while (b + 1 < ls.length && /^\s*\/\/[/!]/.test(ls[b + 1])) b++;
  const block = ls.slice(a, b + 1).join('\n');
  // a `/// @id` above `#[test] fn` is an ordinary test: only a fenced doc block is a doc test
  return /^\s*\/\/[/!]\s*(?:```|~~~)/m.test(block) ? block : null;
}
function braceTestSha(txt, id, p) {
  const ranges = braceFunctions(txt, p);
  if (!ranges) return sha(txt);
  const mine = ranges.find((r) => new RegExp(`@id\\s+${id}\\b`).test(r.body));
  const docBlock = /\.rs$/.test(p) ? rustDocBlock(txt, id) : null;
  if (docBlock) return sha('rust-doctest\u0000' + docBlock);
  if (!mine) return sha(txt);
  const inline = /\.rs$/.test(p) ? rustTestRegion(txt) : -1;
  const helpers = ranges.filter((r) => !r.test && !r.code && (inline < 0 || r.start > inline));
  // file-scope registration macros (`REG(fn);`, `CASE(suite, fn);`) belong to the function they name, not to every sibling (#236)
  const regs = !cLegacy && /\.(?:c|cc|cpp|cxx)$/.test(p) ? cRegistrations(txt, ranges) : [];
  let shared = sharedOutside(txt, [...ranges, ...regs], inline >= 0 ? inline : 0);
  // comments outside every function (a trailing note) are not an oracle in C/C++ (#236)
  if (!cLegacy && /\.(?:c|cc|cpp|cxx)$/.test(p)) shared = shared.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'/g, (c) => (c[0] === '/' ? '' : c)).split('\n').filter((l) => l.trim()).join('\n').trim();
  const own = regs.filter((r) => r.target === mine.name).map((r) => r.body.trim()).join('\u0000');
  return sha((symbolMode() && /\.rs$/.test(p) ? symbolPreamble(shared, mine.body, reachableHelpers(mine, helpers, shared).map((r) => r.body)) : shared) + '\u0000' + mine.body.trim() + '\u0000' + protectedHelpers(mine, helpers, shared, /\.php$/.test(p)) + (own ? '\u0000' + own : ''));
}
function cRegistrations(txt, ranges) {
  const names = new Set(ranges.map((r) => r.name));
  const masked = maskBraces(txt);
  const found = [];
  for (const m of masked.matchAll(/^[ \t]*[A-Z][A-Z0-9_]*[ \t]*\(([^()\n]*)\)[ \t]*;?[ \t]*$/gm)) {
    const target = [...m[1].matchAll(/[A-Za-z_]\w*/g)].map((x) => x[0]).reverse().find((n) => names.has(n));
    if (!target || ranges.some((r) => r.start <= m.index && m.index < r.end)) continue;
    found.push({ start: m.index, end: m.index + m[0].length, target, body: txt.slice(m.index, m.index + m[0].length) });
  }
  return found;
}
function rustTestRegion(text) {
  return maskBraces(text, true).search(/#\s*\[\s*cfg\s*\(\s*test\s*\)\s*\]/);
}
let localCargo;
function cargoSources() {
  if (localCargo) return localCargo;
  const packages = workspaceFiles().filter((f) => /(?:^|\/)Cargo\.toml$/.test(f)).map((file) => {
    const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const dir = path.dirname(file);
    const sections = [...text.matchAll(/^\s*\[([^\]\n]+)\][^\n]*\n([\s\S]*?)(?=^\s*\[|$(?![\s\S]))/gm)].map((m) => ({ name: m[1], body: m[2] }));
    const pkg = sections.find((s) => s.name === 'package')?.body ?? '';
    const lib = sections.find((s) => s.name === 'lib')?.body ?? '';
    const value = (body, key) => new RegExp(`\\b${key}\\s*=\\s*"([^"]+)"`).exec(body)?.[1];
    return { file, dir, sections, name: value(pkg, 'name'), lib: path.normalize(path.join(dir, value(lib, 'path') ?? 'src/lib.rs')), libName: value(lib, 'name'), bindings: new Map() };
  });
  const declarations = (pkg, workspace = false) => pkg.sections.flatMap((s) => {
    const head = workspace ? 'workspace\\.dependencies' : '(?:(?:target\\.[^.]+)\\.)?(?:dependencies|dev-dependencies|build-dependencies)';
    const table = new RegExp(`^${head}(?:\\.([\\w-]+))?$`).exec(s.name);
    if (!table) return [];
    if (table[1]) return [[table[1], s.body]];
    return [...s.body.matchAll(/^\s*([\w-]+)(?:\.workspace)?\s*=\s*(\{[^}]*\}|[^\n#]+)/gm)].map((m) => [m[1], m[0].includes('.workspace') ? `workspace=${m[2]}` : m[2]]);
  });
  for (const pkg of packages) {
    const workspace = packages.filter((p) => p.sections.some((s) => s.name === 'workspace') && (p.dir === '.' || pkg.dir === p.dir || pkg.dir.startsWith(p.dir + path.sep))).sort((a, b) => b.dir.length - a.dir.length)[0];
    const inherited = new Map(workspace ? declarations(workspace, true) : []);
    for (const [alias, localFields] of declarations(pkg)) {
      const inherits = /\bworkspace\s*=\s*true\b/.test(localFields);
      const fields = inherits ? inherited.get(alias) : localFields;
      if (!fields) continue;
      const p = /\bpath\s*=\s*"([^"]+)"/.exec(fields)?.[1];
      const name = /\bpackage\s*=\s*"([^"]+)"/.exec(fields)?.[1];
      const target = p ? packages.find((q) => q.dir === path.normalize(path.join(inherits ? workspace.dir : pkg.dir, p))) : packages.find((q) => q.name === (name ?? alias));
      if (target) pkg.bindings.set(alias.replace(/-/g, '_'), target);
    }
  }
  return localCargo = packages;
}
function rustCrateDependencies(file, text) {
  const owner = cargoSources().filter((p) => p.name && (p.dir === '.' || rel(file).startsWith(p.dir + '/'))).sort((a, b) => b.dir.length - a.dir.length)[0];
  if (!owner) return [];
  const names = new Set([...maskBraces(text, true).matchAll(/\b(?:r#)?(\w+)\s*::|\bextern\s+crate\s+(\w+)/g)].map((m) => m[1] ?? m[2]));
  return [...owner.bindings].filter(([name]) => names.has(name)).map(([, target]) => path.join(ROOT, target.lib));
}
function rustLocalModules(file, txt, entry = file) {
  const mask = maskBraces(txt, true), scope = [], paths = [];
  for (const m of mask.matchAll(/\bmod\s+((?:r#)?\w+)\s*([;{])|[{}]/g)) {
    if (m[1] && m[2] === '{') { scope.push(m[1]); continue; }
    if (m[0] === '{') { scope.push(null); continue; }
    if (m[0] === '}') { scope.pop(); continue; }
    const parents = scope.filter(Boolean);
    const base = path.basename(file) === 'mod.rs' || file === entry ? path.dirname(file) : file.slice(0, -3);
    const home = path.join(base, ...parents.map((n) => n.replace(/^r#/, '')));
    const attribute = /#\[path\s*=\s*(r#*"[\s\S]*?"#*|"(?:\\.|[^"\\])*")\](?:\s*#\[[^\]]*\])*\s*(?:pub(?:\([^)]*\))?\s+)?$/.exec(txt.slice(0, m.index))?.[1];
    const override = attribute ? rustIncludeValue(attribute, file) : null;
    if (attribute && override === null) throw new Error(`REFUSED: unresolved Rust path oracle in ${rel(file)}`);
    const name = m[1].replace(/^r#/, '');
    const candidates = override !== null ? [path.resolve(parents.length ? home : path.dirname(file), override)] : [path.join(home, name + '.rs'), path.join(home, name, 'mod.rs')];
    paths.push({ file: candidates.find((p) => fs.existsSync(p)) ?? candidates[0], mods: [...parents, m[1]] });
  }
  return paths;
}
function rustIncludeValue(expression, file) {
  const e = expression.trim().replace(/,\s*$/, '');
  const raw = /^r(#+)?"([\s\S]*)"\1$/.exec(e);
  if (raw) return raw[2];
  if (/^"(?:\\.|[^"\\])*"$/.test(e)) {
    try {
      const decoded = e.replace(/\\u\{([0-9a-fA-F_]+)\}|\\x([0-9a-fA-F]{2})/g, (_, unicode, byte) => JSON.stringify(String.fromCodePoint(parseInt((unicode ?? byte).replaceAll('_', ''), 16))).slice(1, -1));
      return JSON.parse(decoded);
    } catch { return null; }
  }
  const concat = /^concat!\s*\(([\s\S]*)\)$/.exec(e);
  if (concat) {
    const mask = maskBraces(concat[1], true), parts = [];
    let depth = 0, start = 0;
    for (let i = 0; i < mask.length; i++) {
      if (mask[i] === '(') depth++;
      else if (mask[i] === ')') depth--;
      else if (mask[i] === ',' && !depth) { parts.push(concat[1].slice(start, i)); start = i + 1; }
    }
    parts.push(concat[1].slice(start));
    const values = parts.filter((p) => p.trim()).map((p) => rustIncludeValue(p, file));
    return values.every((v) => v !== null) ? values.join('') : null;
  }
  const env = /^env!\s*\(\s*"CARGO_MANIFEST_DIR"\s*\)$/.test(e);
  if (env) {
    for (let d = path.dirname(file); d.startsWith(ROOT); d = path.dirname(d)) {
      if (fs.existsSync(path.join(d, 'Cargo.toml'))) return d;
      if (d === ROOT) break;
    }
  }
  return null;
}
function expressionArguments(text) {
  const masked = maskBraces(text), parts = [];
  let depth = 0, start = 0;
  for (let i = 0; i < masked.length; i++) {
    if ('([{'.includes(masked[i])) depth++;
    else if (')]}'.includes(masked[i])) depth--;
    else if (masked[i] === ',' && !depth) { parts.push(text.slice(start, i).trim()); start = i + 1; }
  }
  parts.push(text.slice(start).trim());
  return parts.filter(Boolean);
}
function juliaIncludeValue(expression, file) {
  const e = expression.trim();
  if (e === '@__DIR__') return path.dirname(file);
  if (/^"(?:\\.|[^"\\])*"$/.test(e)) { try { return JSON.parse(e); } catch { return null; } }
  const joined = /^(?:Base\.)?joinpath\s*\(([\s\S]*)\)$/.exec(e);
  if (!joined) return null;
  const values = expressionArguments(joined[1]).map((p) => juliaIncludeValue(p, file));
  return values.length && values.every((v) => v !== null) ? path.join(...values) : null;
}
function cCompilerInputs(file) {
  const includes = [], forced = [], macros = new Map();
  for (let home = path.dirname(file); home.startsWith(ROOT); home = path.dirname(home)) {
    for (const db of ['compile_commands.json', 'build/compile_commands.json']) {
      for (const entry of readJson(path.join(home, db), [])) {
        const dir = path.resolve(home, entry.directory ?? '.');
        if (path.resolve(dir, entry.file ?? '') !== file) continue;
        const args = entry.arguments ?? (entry.command ?? '').match(/"(?:\\.|[^"\\])*"|'[^']*'|[^\s]+/g)?.map((s) => s.replace(/^(['"])([\s\S]*)\1$/, '$2')) ?? [];
        for (let i = 0; i < args.length; i++) {
          const a = args[i];
          if (/^(?:-I|-iquote|-isystem)$/.test(a)) includes.push(path.resolve(dir, args[++i] ?? ''));
          else if (a.startsWith('-I')) includes.push(path.resolve(dir, a.slice(2)));
          else if (/^(?:-include|-imacros|\/FI)$/.test(a)) forced.push({ dir, value: args[++i] ?? '' });
          else if (/^-include|-imacros/.test(a)) forced.push({ dir, value: a.replace(/^-(?:include|imacros)/, '') });
          else if (a.startsWith('/FI')) forced.push({ dir, value: a.slice(3) });
          else if (a === '-D' || a.startsWith('-D')) {
            const value = a === '-D' ? args[++i] : a.slice(2), eq = value?.indexOf('=');
            if (eq > 0) macros.set(value.slice(0, eq), value.slice(eq + 1).replace(/\\"/g, '"'));
          }
        }
      }
    }
    if (home === ROOT) break;
  }
  return { includes, forced: forced.flatMap(({ dir, value }) => {
    const local = path.resolve(dir, value);
    if (fs.existsSync(local)) return [local];
    const matches = includes.map((d) => path.resolve(d, value)).filter((f) => fs.existsSync(f));
    return matches.length ? matches : [local];
  }), macros };
}
function javaModuleRoot(file) {
  // the owning module (surefire's cwd) wins over a configured reactor root (#238)
  for (let dir = path.dirname(file); dir.startsWith(ROOT); dir = path.dirname(dir)) {
    if (['pom.xml', 'build.gradle', 'build.gradle.kts'].some((f) => fs.existsSync(path.join(dir, f)))) return dir;
    if (dir === ROOT) break;
  }
  const configured = projectFor(rel(file));
  return configured ? path.resolve(ROOT, configured.root) : ROOT;
}
// Test-support files are oracles; production files (annotated CODE-, or outside test-like locations) are not (#181, #214, #219, #224).
const testSupportPath = (f) => /(^|\/)(?:tests?|__tests__|specs?|fixtures?|__fixtures__|__mocks__|testdata|test-data|testthat|e2e|support|helpers?|oracles?)\//i.test(rel(f)) || /(?:^|[/.-])(?:test|spec|helper|fixture|oracle|setup|mock)s?[^/]*$/i.test(rel(f));
// a conftest that only defines plain (non-autouse) fixtures the test never names cannot change the test's outcome
function conftestUnused(conftest, testText) {
  let c = '';
  try { c = fs.readFileSync(conftest, 'utf8'); } catch { return false; }
  if (/\bautouse\b|\bpytest_\w+|^\s*(?:from|import)\s+\S*conftest\b/m.test(c) || /\bconftest\b/.test(testText)) return false;
  const names = [...c.matchAll(/^[ \t]*@(?:pytest\.)?fixture\b[^\n]*\n(?:[ \t]*@[^\n]*\n)*[ \t]*(?:async\s+)?def\s+(\w+)/gm)].map((m) => m[1]);
  const aliased = [...c.matchAll(/\bname\s*=\s*['"](\w+)['"]/g)].map((m) => m[1]);
  const all = [...names, ...aliased];
  if (!all.length) return false;
  return !all.some((n) => new RegExp(`\\b${n}\\b`).test(testText));
}
function pythonConftests(file, text = '') {
  const found = [];
  for (let dir = path.dirname(file); dir.startsWith(ROOT); dir = path.dirname(dir)) {
    const conftest = path.join(dir, 'conftest.py');
    if (conftest !== file && fs.existsSync(conftest) && !(text && conftestUnused(conftest, text))) found.push(conftest);
    if (dir === ROOT) break;
  }
  return found;
}
function scriptOracleImports(file, text, all = false) {
  const found = [], exts = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.json', '/index.ts', '/index.js', '/index.mjs'];
  const specs = [...text.matchAll(/\b(?:import|export)\b[^'";]*?\bfrom\s*(['"])([^'"]+)\1|\bimport\s*(['"])([^'"]+)\3|\b(?:require|import)\s*\(\s*(['"`])([^'"`$]+)\5\s*\)/g)].map((m) => m[2] ?? m[4] ?? m[6]);
  let aliases, files;
  for (const spec of specs) {
    if (!/^\.{1,2}\//.test(spec)) {
      if (spec.startsWith('node:')) continue;
      files ??= new Set(workspaceFiles());
      aliases ??= aliasMap(files);
      for (const target of aliasSources(aliases, files, spec, rel(file))) {
        const hit = path.join(ROOT, target);
        let code = false;
        try { code = fs.readFileSync(hit, 'utf8').includes('@id CODE-'); } catch {}
        if (all || (!code && (testSupportPath(hit) || /\.(?:json|csv|txt|ya?ml)$/i.test(hit)))) found.push(hit);
      }
      continue;
    }
    const base = path.resolve(path.dirname(file), spec);
    const hit = exts.map((e) => base + e).concat(spec.endsWith('.js') ? [base.replace(/\.js$/, '.ts'), base.replace(/\.js$/, '.tsx')] : []).find((f) => { try { return fs.statSync(f).isFile(); } catch { return false; } });
    if (!hit) continue;
    let code = true;
    try { code = !/\.json$/i.test(hit) && fs.readFileSync(hit, 'utf8').includes('@id CODE-'); } catch {}
    if (all || (!code && (testSupportPath(hit) || /\.(?:json|csv|txt|ya?ml)$/i.test(hit)))) found.push(hit);
  }
  return found;
}
function rOracleImports(file, text) {
  const found = [], dir = path.dirname(file);
  const add = (f) => { try { if (fs.statSync(f).isFile()) found.push(f); } catch {} };
  for (const m of text.matchAll(/\b(source|sys\.source|test_path|read\.csv2?|read\.delim|read\.table|readRDS|readLines|scan|load|fread|read_csv|read_tsv|read_delim|read_rds|read_excel|read_json|fromJSON|file)\s*\(\s*(?:file\s*=\s*)?(['"])([^'"]+)\2/g)) {
    const target = path.resolve(dir, m[3]);
    const rootTarget = path.resolve(ROOT, m[3]);
    for (const f of new Set([target, rootTarget])) {
      if (!/^source|^sys\.source/.test(m[1]) || testSupportPath(f)) add(f);
    }
  }
  if (rel(file).startsWith('tests/') || /(^|\/)testthat\//.test(rel(file))) for (const f of fs.readdirSync(dir)) if (/^(?:helper|setup)[-_].*\.[Rr]$/.test(f)) add(path.join(dir, f));
  return found.filter((f) => f !== file);
}
function localSourceDependencies(file, text, rootFile = false, cFamily = false, compilerContext = null) {
  const next = [], ext = path.extname(file);
  if (ext === '.py') return rootFile ? pythonConftests(file, text) : [];
  if (/^\.(?:[cm]?[jt]s|[jt]sx)$/.test(ext)) return scriptOracleImports(file, text);
  if (/^\.r$/i.test(ext)) return rOracleImports(file, text);
  const suffix = (name) => workspaceFiles().filter((f) => f === name || f.endsWith('/' + name)).map((f) => path.join(ROOT, f));
  if (ext === '.rs') {
    const inline = rootFile ? rustTestRegion(text) : -1;
    const input = inline >= 0 ? ' '.repeat(inline) + text.slice(inline) : text;
    const entry = /(?:^|\/)(?:lib|main|mod)\.rs$|(?:^|\/)(?:tests|benches|examples)\/[^/]+\.rs$/.test(rel(file)) ? file : '';
    next.push(...rustLocalModules(file, input, entry).map((m) => m.file));
    next.push(...rustCrateDependencies(file, input));
    const mask = maskBraces(input, true);
    for (const m of mask.matchAll(/\binclude(?:_str|_bytes)?!\s*\(/g)) {
      const start = m.index + m[0].length;
      let end = start, depth = 1;
      for (; end < mask.length && depth; end++) { if (mask[end] === '(') depth++; else if (mask[end] === ')') depth--; }
      const expr = input.slice(start, end - 1);
      // OUT_DIR files are generated by build.rs: depend on the build script instead
      if (/\benv!\s*\(\s*"OUT_DIR"\s*\)/.test(expr)) {
        for (let d = path.dirname(file); d.startsWith(ROOT); d = path.dirname(d)) {
          if (fs.existsSync(path.join(d, 'Cargo.toml'))) { if (fs.existsSync(path.join(d, 'build.rs'))) next.push(path.join(d, 'build.rs')); break; }
          if (d === ROOT) break;
        }
        continue;
      }
      const value = rustIncludeValue(expr, file);
      if (value === null) throw new Error(`REFUSED: unresolved Rust include oracle in ${rel(file)} — use a local literal/concat!(env!("CARGO_MANIFEST_DIR"), ...) path`);
      next.push(path.resolve(path.dirname(file), value));
    }
  } else if (cFamily || /\.(?:c|h|cc|cpp|cxx|hpp|hh|inc|inl|tpp)$/.test(ext)) {
    const compiler = compilerContext ?? cCompilerInputs(file), macros = compiler.macros;
    for (const m of text.matchAll(/^\s*#\s*define\s+(\w+)[ \t]+([^\n]+)/gm)) macros.set(m[1], m[2].trim());
    if (rootFile || !compilerContext) next.push(...compiler.forced);
    for (const m of text.matchAll(/^\s*#\s*include\s+([^\n]+)/gm)) {
      let value = m[1].replace(/\/\/.*$|\/\*[\s\S]*?\*\//g, '').trim();
      const seen = new Set();
      while (/^\w+$/.test(value) && macros.has(value) && !seen.has(value)) { seen.add(value); value = macros.get(value); }
      const literal = /^([<"])([^>"]+)[>"]$/.exec(value);
      if (!literal) throw new Error(`REFUSED: unresolved C/C++ include oracle in ${rel(file)} — use a literal or object-like literal macro`);
      const local = path.resolve(path.dirname(file), literal[2]);
      const matches = [...compiler.includes.map((d) => path.resolve(d, literal[2])).filter((f) => fs.existsSync(f)), ...suffix(literal[2])];
      next.push(...(literal[1] === '"' && fs.existsSync(local) ? [local] : matches.length ? matches : literal[1] === '"' ? [local] : []));
    }
  } else if (ext === '.exs' || ext === '.ex') {
    // ExUnit oracles: test/test_helper.exs and test/support/** of the owning mix project, plus Code.require_file/import_file 
    if (/^(?:.*\/)?test\//.test(rel(file))) {
      const base = rel(file).slice(0, rel(file).indexOf('test/') + 5);
      for (const f of workspaceFiles()) if (f.startsWith(base) && (f === base + 'test_helper.exs' || /^support\//.test(f.slice(base.length)) && /\.exs?$/.test(f))) next.push(path.join(ROOT, f));
    }
    for (const x of text.matchAll(/\bCode\.(?:require_file|eval_file)\(\s*"([^"]+)"(?:\s*,\s*__DIR__)?/g)) next.push(path.resolve(path.dirname(file), x[1]));
    for (const x of text.matchAll(/\bimport_file\(\s*"([^"]+)"/g)) next.push(path.resolve(path.dirname(file), x[1]));
  } else if (ext === '.jl') {
    const mask = maskBraces(text);
    for (const m of mask.matchAll(/\b(?:(Base|Core)\.)?include\s*\(/g)) {
      const start = m.index + m[0].length;
      let end = start, depth = 1;
      for (; end < mask.length && depth; end++) { if (mask[end] === '(') depth++; else if (mask[end] === ')') depth--; }
      const args = expressionArguments(text.slice(start, end - 1));
      const value = juliaIncludeValue(args[m[1] || args.length === 2 ? 1 : 0] ?? '', file);
      if (value === null) throw new Error(`REFUSED: unresolved Julia include oracle in ${rel(file)} — use literal/joinpath(@__DIR__, ...) inputs`);
      next.push(path.resolve(path.dirname(file), value));
    }
  } else if (['.java', '.php', '.cs'].includes(ext)) {
    if (ext === '.php') for (const m of text.matchAll(/\b(?:require|include)(?:_once)?\s*\(?\s*(?:__DIR__\s*\.\s*)?['"]([^'"]+)['"]/g)) next.push(path.resolve(path.dirname(file), m[1].replace(/^\//, '')));
    const references = new Set();
    if (ext === '.java') {
      for (const m of text.matchAll(/\b(?:extends|implements)\s+([\w., ]+)/g)) for (const n of m[1].split(',')) references.add(n.trim().split(/\s/)[0]);
      for (const m of text.matchAll(/\bimport\s+(?:static\s+)?([\w.]+)\s*;/g)) {
        const parts = m[1].split('.');
        references.add(parts.at(-1));
        references.add(parts.slice(0, -1).join('.'));
      }
      for (const m of text.matchAll(/@([\w.]+)/g)) references.add(m[1]);
      for (const m of text.matchAll(/\b[A-Z]\w*\b/g)) references.add(m[0]);
      for (const m of text.matchAll(/@(?:[\w.]+\.)?MethodSource\s*\(([\s\S]*?)\)/g)) for (const value of m[1].matchAll(/"([\w.$]+)#[\w$]+"/g)) references.add(value[1]);
      if (rootFile) for (const type of sourceTypes().filter((t) => t.file === rel(file) && new RegExp(`\\binterface\\s+${escapeRe(t.name)}\\b`).test(maskBraces(t.text)) && braceFunctions(text, rel(file))?.some((r) => r.test && r.owner === t.fq))) {
        const owner = javaExecutionOwner(type.fq);
        if (owner !== type.fq) next.push(...sourceTypes().filter((t) => t.fq === owner).map((t) => path.join(ROOT, t.file)));
      }
      for (const m of text.matchAll(/@(?:[\w.]+\.)?CsvFileSource\s*\(([\s\S]*?)\)/g)) {
        for (const binding of m[1].matchAll(/\b(resources|files)\s*=\s*(\{[^}]*\}|"(?:\\.|[^"\\])*"|[^,]+)/g)) {
          const values = expressionArguments(binding[2].replace(/^\{|\}$/g, ''));
          for (const expression of values) {
            let value;
            try { value = JSON.parse(expression); } catch { throw new Error(`REFUSED: unresolved Java CSV oracle in ${rel(file)}`); }
            if (typeof value !== 'string') throw new Error(`REFUSED: unresolved Java CSV oracle in ${rel(file)}`);
            const matches = binding[1] === 'resources' ? suffix(value.replace(/^\//, '')).filter((f) => /(?:^|\/)resources\//.test(rel(f))) : [path.resolve(javaModuleRoot(file), value)];
            if (binding[1] === 'files' && !fs.existsSync(matches[0])) throw new Error(`REFUSED: Java CSV oracle ${value} in ${rel(file)} resolves to ${rel(matches[0])}, which does not exist (files= is relative to the Maven/Gradle module)`);
            next.push(...(matches.length ? matches : [path.resolve(ROOT, 'src/test/resources', value.replace(/^\//, ''))]));
          }
        }
      }
    } else if (ext === '.php') {
      for (const m of text.matchAll(/\b(?:extends|implements)\s+([\\\w]+)/g)) references.add(m[1]);
      for (const [n] of phpImports(text)) references.add(n);
      for (const m of text.matchAll(/^[ \t]+use\s+([\\\w][\\\w, \t]*?)\s*[;{]/gm)) for (const n of m[1].split(',')) references.add(n.trim());
      for (const m of maskBraces(text).matchAll(/(?<![\w\\])(\\?[\w\\]+)(?=\s*::)|\bnew\s+(\\?[\w\\]+)/g)) references.add(m[1] ?? m[2]);
      const functions = new Set(phpImports(text, 'function').values());
      if (functions.size) for (const f of workspaceFiles().filter((f) => f.endsWith('.php'))) {
        const body = maskBraces(fs.readFileSync(path.join(ROOT, f), 'utf8'));
        const namespace = /\bnamespace\s+([\w\\]+)/.exec(body)?.[1] ?? '';
        if ([...body.matchAll(/\bfunction\s+&?\s*(\w+)\s*\(/g)].some((m) => functions.has([namespace, m[1]].filter(Boolean).join('\\')))) next.push(path.join(ROOT, f));
      }
    } else {
      for (const m of text.matchAll(/\b(?:class|record|struct)\s+\w+(?:<[^>]*>)?\s*:\s*([^{\n]+)/g)) for (const n of m[1].split(',')) references.add(n.trim().split(/[<\s]/)[0]);
      for (const m of text.matchAll(/\b(?:[A-Z]\w*)\b/g)) references.add(m[0]);
      for (const m of maskBraces(text).matchAll(/\busing\s+(\w+)\s*=/g)) references.add(m[1]);
      const namespace = /\bnamespace\s+([\w.]+)/.exec(text)?.[1] ?? '';
      const collections = new Set([...text.matchAll(/\[(?:[\w.]+\.)?Collection(?:Attribute)?\s*\(\s*"([^"]+)"/g)].map((m) => m[1]));
      const owners = dotnetGraph(ROOT).ownersOf(rel(file));
      for (const candidate of new Map(sourceTypes().filter((t) => t.ext === '.cs').map((t) => [t.file, t])).values()) {
        if (owners.length && !dotnetGraph(ROOT).ownersOf(candidate.file).some((o) => owners.some((owner) => owner.file === o.file))) continue;
        const setup = /\[(?:[\w.]+\.)?SetUpFixture(?:Attribute)?\b/.test(candidate.text) && (!candidate.ns || namespace === candidate.ns || namespace.startsWith(candidate.ns + '.'));
        const collection = [...candidate.text.matchAll(/\[(?:[\w.]+\.)?CollectionDefinition(?:Attribute)?\s*\(\s*"([^"]+)"/g)].some((m) => collections.has(m[1]));
        const assembly = [...candidate.text.matchAll(/\[([^\]]+)\]/g)].some((m) => [...m[1].matchAll(/(?:^|,)\s*((?:global::)?[\w.]+)/g)].some((a) => {
          const aliases = new Map([...candidate.text.matchAll(/\busing\s+(\w+)\s*=\s*(?:global::)?([\w.]+)\s*;/g)].map((u) => [u[1], u[2]]));
          return /^(?:AssemblyInitialize|AssemblyCleanup)(?:Attribute)?$/.test((aliases.get(a[1]) ?? a[1]).split('.').at(-1));
        }));
        if (setup || collection || assembly) next.push(path.join(ROOT, candidate.file));
      }
    }
    for (const name of references) next.push(...localTypeFiles(file, text, name));
  }
  return [...new Set(next)];
}
// Local test-support dependencies are conservative oracles; annotated production is not (#181).
let oracleDependencyFiles = [];
let producedShas = {};
let oracleDependencyShas = {};
// a sibling file that holds its own annotated tests (partial test class, shared test module): only its non-test content is an oracle, so adding a test there does not stale this one (#229)
function siblingTestSha(file, text, raw) {
  if (!BRACE_TEST.test(file) || !/@id\s+TEST-/.test(text)) return sha(raw);
  const ranges = braceFunctions(text, file);
  if (!ranges) return sha(raw);
  const tests = ranges.filter((r) => /@id\s+TEST-/.test(r.body));
  return tests.length ? sha('tests-excluded\u0000' + sharedOutside(text, tests)) : sha(raw);
}
// a C/C++ header under include/ src/ lib/ (outside any test/fixture/data directory) is implementation, not oracle, unless it says `@oracle` (#236)
function productionHeader(file, text) {
  if (!/\.(?:h|hh|hpp|hxx|inl|ipp|tpp)$/i.test(file) || /@oracle\b/.test(text) || /@id\s+TEST-/.test(text)) return false;
  const segs = rel(file).split('/').slice(0, -1);
  const testLike = (d) => /^(?:tests?|spec|specs|fixtures?|testdata|test_data|support|vectors?|data|oracles?|mocks?|testing|testutil)$/i.test(d) || /^test_|_tests?$/i.test(d);
  return segs.some((d) => /^(?:include|src|lib|inc)$/i.test(d)) && !segs.some(testLike);
}
function externalOracleSha(p, hash) {
  oracleDependencyFiles = [];
  oracleDependencyShas = {};
  if (!/\.(?:rs|c|cc|cpp|cxx|java|php|cs|jl|py|exs?|[cm]?[jt]s|[jt]sx|[rR])$/.test(p)) return hash;
  const root = path.join(ROOT, p), seen = new Set([root]), deps = new Map();
  const compiler = /\.(?:c|cc|cpp|cxx)$/.test(p) ? cCompilerInputs(root) : null;
  const visit = (file, rootFile = false) => {
    let text, raw;
    try { raw = fs.readFileSync(file); text = raw.toString('utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n'); }
    catch { if (!rootFile) deps.set(rel(file), 'missing'); return; }
    if (!rootFile && /@id\s+CODE-/.test(text) && !/@id\s+TEST-/.test(text)) return;
    if (!rootFile && compiler && productionHeader(file, text)) return;
    if (!rootFile) deps.set(rel(file), siblingTestSha(file, text, raw));
    const next = localSourceDependencies(file, text, rootFile, !!compiler, compiler);
    for (const dep of next) {
      if (!dep.startsWith(ROOT + path.sep) || seen.has(dep)) continue;
      seen.add(dep);
      visit(dep);
    }
  };
  visit(root, true);
  // runtime data the test reads (`// @data vectors/crc16.csv` in the test or an oracle file, or `oracleData` in config) is part of the oracle (#238)
  const dataSpecs = new Set(Array.isArray((readJson(CONFIG, null) ?? {}).oracleData) ? readJson(CONFIG, null).oracleData.map((x) => [x, ROOT]) : []);
  const own = [root, ...[...deps.keys()].map((f) => path.join(ROOT, f))];
  for (const f of own) {
    let text = '';
    try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
    for (const m of text.matchAll(/@data\s+([^\s*]+(?:\s*,\s*[^\s*,]+)*)/g)) for (const x of m[1].split(',')) dataSpecs.add([x.trim(), path.dirname(f)]);
  }
  // config `artifacts` ({"contract/x.json": ["test/a.test.mjs"]}) consumed by the test or one of its oracle files are part of the oracle (#264)
  const ownAbs = new Set(own);
  const deliverables = new Set([].concat((readJson(CONFIG, null) ?? {}).deliverables ?? []).map((x) => normDep(x)));
  for (const [a, users] of Object.entries((readJson(CONFIG, null) ?? {}).artifacts ?? {})) if (!deliverables.has(normDep(a)) && [].concat(users).some((u) => ownAbs.has(path.join(ROOT, normDep(u))))) dataSpecs.add([a, ROOT]);
  const dataHash = (abs) => {
    const st = fs.statSync(abs);
    if (!st.isDirectory()) return sha(fs.readFileSync(abs));
    const parts = [];
    const walkData = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) { if (/^(?:\.git|node_modules)$/.test(e.name)) continue; const q = path.join(d, e.name); if (e.isDirectory()) walkData(q); else parts.push(rel(q) + '\u0000' + sha(fs.readFileSync(q))); } };
    walkData(abs);
    return sha(parts.join('\u0000'));
  };
  for (const [spec, base] of dataSpecs) {
    const cands = [path.resolve(base, spec), path.resolve(ROOT, spec)];
    const abs = cands.find((c) => c.startsWith(ROOT) && fs.existsSync(c)) ?? cands.find((c) => c.startsWith(ROOT));
    if (!abs) continue;
    try { deps.set(rel(abs), fs.existsSync(abs) ? 'data:' + dataHash(abs) : 'missing'); } catch { deps.set(rel(abs), 'missing'); }
  }
  // config `generated` (paths/globs): build outputs the test reads are not oracle dependencies (#293)
  const generated = [].concat((readJson(CONFIG, null) ?? {}).generated ?? []).map((g) => globRe(normDep(g)));
  if (generated.length) for (const f of [...deps.keys()]) if (generated.some((re) => re.test(f))) deps.delete(f);
  // config `artifactProducers` ({"contract/golden.json": "llcli golden"}): a generated artifact (and a producer given as a file) may be regenerated between Red and Green; its sha is recorded, not locked (r26d)
  producedShas = {};
  for (const [a, prod] of Object.entries(readJson(CONFIG, null)?.artifactProducers ?? {})) for (const f of [normDep(a), ...(typeof prod === 'string' && !/\s/.test(prod) ? [normDep(prod)] : [])]) if (deps.has(f)) { producedShas[f] = deps.get(f); deps.delete(f); }
  oracleDependencyFiles = [...deps.keys()].sort();
  oracleDependencyShas = Object.fromEntries(deps);
  return deps.size ? sha(hash + '\u0000' + [...deps].sort(([a], [b]) => a.localeCompare(b)).map(([f, h]) => f + '\u0000' + h).join('\u0000')) : hash;
}
function juliaRanges(txt) {
  const masked = txt.replace(/#[^\n]*|"""[\s\S]*?"""|"(?:\\[\s\S]|[^"\\])*"|'(?:\\(?:u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|x[0-9a-fA-F]{2}|.)|[^'\\\n])'|(?<![:\w]):(?:begin|end|if|for|while|let|try|struct|module|baremodule|macro|quote|do|function)\b/g, (s) => s.replace(/[^\n]/g, ' '));
  const ranges = [];
  for (const a of txt.matchAll(/^[ \t]*#.*@id\s+((?:TEST|CODE)-[A-Z0-9-]+)[^\n]*\n/gm)) {
    const start = a.index, from = start + a[0].length;
    let depth = 0, end = from, found = false, brackets = 0;
    for (const m of masked.slice(from).matchAll(/\b(?:function|begin|if|for|while|let|try|struct|module|baremodule|macro|quote|do|end)\b|[()[\]]/g)) {
      if (/^[([]$/.test(m[0])) { brackets++; continue; }
      if (/^[)\]]$/.test(m[0])) { brackets--; continue; }
      if (brackets) continue;
      if (m[0] === 'end') depth--;
      else { depth++; found = true; }
      if (found && depth === 0) { end = from + m.index + m[0].length; break; }
    }
    if (!found || end === from) return null;
    ranges.push({ start, end, id: a[1], body: txt.slice(start, end) });
  }
  return ranges;
}
function juliaTestSha(txt, id) {
  const ranges = juliaRanges(txt);
  if (!ranges) return sha(txt);
  const mine = ranges.find((r) => r.id === id);
  if (!mine) return sha(txt);
  return sha(sharedOutside(txt, ranges) + '\u0000' + mine.body.trim());
}
// legacy=true: pre-#66 behaviour (no Python docstring scoping, whole-file @implements check)
// cut (any test, not only the last: a helper or a new describe between tests is not part of the previous test, #144): the region stops where its own top-level construct ends (blank line or pure closer, then a non-closer line at the test's indent), so appended tests/comments/main() do not stale it (#73)
// inl: a Rust file with a #[cfg(test)] module holds code next to its tests, so only the test's region counts even before @implements exists (#80)
// eolNorm: BOM/CRLF are not content, so converting a test file's line endings does not stale its evidence (#102); ledgers recorded with raw hashes still match
let eolNorm = false;
const testShaVariant = (p, id, trim, norm = false, legacy = false, cut = true, inl = true) => {
  const raw = fs.readFileSync(path.join(ROOT, p), 'utf8');
  const txt0 = eolNorm ? raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n') : raw;
  const txt = stripCodeAnn ? txt0.replace(CODE_ANN_LINE, '') : txt0;
  if (/\.py$/.test(p)) return pythonTestSha(txt, id);
  if (BRACE_TEST.test(p)) return braceTestSha(txt, id, p);
  if (/\.jl$/.test(p)) return juliaTestSha(txt, id);
  const ls = txt.split('\n');
  // Python docstring-style `"""@id ..."""`: the `def` line and decorators before the docstring belong to that test (#66)
  const begin = (i) => {
    if (legacy) return i;
    let k = -1;
    if (i >= 1 && /^\s*(async\s+)?def\s/.test(ls[i - 1])) k = i - 1;
    else if (i >= 2 && /^\s*[rbuRBU]{0,2}("""|\'\'\')\s*$/.test(ls[i - 1]) && /^\s*(async\s+)?def\s/.test(ls[i - 2])) k = i - 2;
    if (k < 0) return i;
    while (k > 0 && /^\s*@\w/.test(ls[k - 1])) k--;
    return k;
  };
  const starts = ls.map((l, i) => (/@id\s/.test(l) ? i : -1)).filter((i) => i >= 0);
  const at = ls.findIndex((l) => new RegExp(`@id\\s+${id}\\b`).test(l));
  if (at < 0) return sha(txt);
  const start = begin(at);
  const nx = starts.find((i) => i > at);
  let end = nx === undefined ? ls.length : Math.max(begin(nx), at + 1);
  if (cut) {
    const ind = (l) => l.length - l.trimStart().length;
    const ref = ind(ls[start]);
    for (let i = start + 1; i < end; i++) {
      const l = ls[i];
      if (!l.trim() || ind(l) > ref || /^\s*[})\]]/.test(l)) continue;
      if (/\.exs?$/.test(p) && ind(l) < ref && /^\s*end\b/.test(l)) { end = Math.max(i, at + 1); break; }
      const prev = ls[i - 1];
      if (!prev.trim() || /^[})\];,\s]*$/.test(prev)) { end = Math.max(i, at + 1); break; }
    }
  }
  let rl = ls.slice(start, end);
  if (trim) while (rl.length > 1 && /^[})\];,\s]*$/.test(rl.at(-1)) && !/^\s+\S/.test(rl.at(-1))) rl.pop();
  const region = rl.join('\n');
  if (legacy ? /@implements\b/.test(txt) : /@id\s+CODE-/.test(txt) || (inl && /\.rs$/.test(p) && /#\[cfg\(test\)\]/.test(txt))) return sha(region);
  const pre0 = ls.slice(0, begin(starts[0])).join('\n');
  const pre = symbolMode() && /\.(?:[cm]?[jt]sx?)$/.test(p) ? symbolPreamble(pre0, region) : pre0;
  return sha((norm ? normImports(pre) : pre) + '\u0000' + region);
};
const testOwnSha = (p, id) => { eolNorm = true; try { return testShaVariant(p, id, true, true); } finally { eolNorm = false; } };
const testSha = (p, id) => { eolNorm = true; try { return externalOracleSha(p, testShaVariant(p, id, true, true)); } finally { eolNorm = false; } };
const shaMatchesBase = (recorded, p, id) => /\.(?:py|jl)$/.test(p) || BRACE_TEST.test(p) ? recorded === testSha(p, id) || (/\.(?:c|cc|cpp|cxx)$/.test(p) && (() => { cLegacy = true; try { return recorded === testSha(p, id); } finally { cLegacy = false; } })()) : shaMatchesRaw(recorded, p, id) || (() => { eolNorm = true; try { return shaMatchesRaw(recorded, p, id); } finally { eolNorm = false; } })();
// a comment-only `@id CODE-… @implements …` line added to a test file is not a test edit (#300): retry with those lines dropped
let stripCodeAnn = false;
const CODE_ANN_LINE = /^[ \t]*(?:\/\/|#|--|;|%|\/?\*)+.*@id\s+CODE-.*(?:\r?\n|$)/gm;
const shaMatches = (recorded, p, id) => shaMatchesBase(recorded, p, id) || (symbolMode() && (() => { symbolOff = true; try { return shaMatchesBase(recorded, p, id); } finally { symbolOff = false; } })()) || (() => { try { if (!CODE_ANN_LINE.test(fs.readFileSync(path.join(ROOT, p), 'utf8'))) return false; } catch { return false; } finally { CODE_ANN_LINE.lastIndex = 0; } stripCodeAnn = true; try { return shaMatchesBase(recorded, p, id) || (symbolMode() && (() => { symbolOff = true; try { return shaMatchesBase(recorded, p, id); } finally { symbolOff = false; } })()); } finally { stripCodeAnn = false; } })();
const shaMatchesRaw = (recorded, p, id) => [true, false].some((cut) => [true, false].some((inl) => recorded === testShaVariant(p, id, true, true, false, cut, inl) || recorded === testShaVariant(p, id, true, false, false, cut, inl) || recorded === testShaVariant(p, id, false, false, false, cut, inl) || recorded === testShaVariant(p, id, true, true, true, cut, inl) || recorded === testShaVariant(p, id, true, false, true, cut, inl) || recorded === testShaVariant(p, id, false, false, true, cut, inl))) ||
  recorded === testSha(p, id) || recorded === testShaVariant(p, id, true) || recorded === testShaVariant(p, id, false) || recorded === testShaVariant(p, id, true, true, true) || recorded === testShaVariant(p, id, true, false, true) || recorded === testShaVariant(p, id, false, false, true) || recorded === sha(fs.readFileSync(path.join(ROOT, p)));
const out = (s = '') => process.stdout.write(s + '\n');
// npm's trailing `npm error …` / `npm notice …` boilerplate would push the real failure out of the window (#75)
// failure lines first (FAIL/assert/error/panic), then the last lines — the failing test is rarely in the last few lines of make/cargo output (#86)
const failTail = (s, n = 8) => { const ls = s.trimEnd().split('\n'); const hit = ls.filter((l) => /\bFAIL(ED)?\b|assert|\berror\b|panic|not ok|✗|✖/i.test(l)).slice(0, 6); const last = ls.slice(-Math.max(2, n - hit.length)); return [...new Set([...hit, ...last])].join('\n'); };
// the assertion itself for C/ctest (`CHECK failed`), xUnit (`Assert.X() Failure`, `Exception : msg`), JUnit/Maven (`expected: <a> but was: <b>`) and Julia (`Test Failed` + `Expression:`) (#125)
const REASON_KEY = /\bCHECK\w* failed|\bASSERT\w* failed|[Aa]ssertion\b.*\bfailed|Assert\.\w+\(\) Failure|^\s*Expected:|^\s*Expected is\b|expected: ?<.*but was|\b[A-Z]\w*Exception\s+:\s*\S|^Expression:/;
const specificReason = (rl) => {
  // Go: the panic text is the reason, not the `--- FAIL:` line (#142)
  const gp = rl.find((l) => /^panic: \S/.test(l));
  if (gp && rl.some((l) => /^--- FAIL:/.test(l))) return gp;
  if (rl.some((l) => /^--- FAIL:/.test(l))) {
    const assertion = rl.map((l) => /^\S+_test\.go:\d+:\s*(.+)/.exec(l)?.[1]).find(Boolean);
    if (assertion) return assertion;
  }
  // PHPUnit: first message line below `There was 1 failure:` / `1) Class::test` (#143)
  const pu = rl.findIndex((l) => /^There w(?:as|ere) \d+ failures?:/.test(l));
  if (pu >= 0) { const m = rl.slice(pu + 1, pu + 8).findIndex((l) => /^\d+\) /.test(l)); const win = m >= 0 ? rl.slice(pu + 2 + m, pu + 6 + m).filter((l) => l && !/^(-|\+|@@)/.test(l) && !/^(?:[A-Za-z]:)?[^\s:]+\.php:\d+$/.test(l)) : []; const msg = win.find((l) => !/^Failed asserting/.test(l)) ?? win[0]; if (msg) return msg; }
  const i = rl.findIndex((l) => /^Test Failed at\b/.test(l));
  if (i >= 0) return rl.slice(i + 1, i + 4).find((l) => /^Expression:/.test(l)) ?? rl[i];
  return rl.find((l) => REASON_KEY.test(l) && !/^\d+\s*\|/.test(l));
};
// rejected Red/Green: assertion lines first (Maven/ctest/dotnet boilerplate would push them out of a plain tail), then a short tail
const rejectTail = (text) => {
  const ls = text.replace(/\x1b\[[0-9;]*m/g, '').trimEnd().split('\n');
  const keep = [];
  ls.forEach((l, i) => { if (/^Test Failed at\b/.test(l)) keep.push(i, i + 1, i + 2); else if (/panicked at /.test(l)) keep.push(i, i + 1, i + 2, i + 3); else if (REASON_KEY.test(l) && !/^\d+\s*\|/.test(l)) keep.push(i); });
  if (!keep.length) return tail(text, 12);
  const hit = [...new Set(keep)].filter((i) => i < ls.length).slice(0, 8).map((i) => ls[i].trimEnd());
  return [...new Set([...hit, ...tail(text, 4).split('\n')])].join('\n');
};
const tail = (s, n = 15) => { const ls = s.trimEnd().split('\n'); const real = ls.filter((l) => !/^npm (notice|error|warn)\b/.test(l)); return (real.length ? real : ls).slice(-n).join('\n'); };

// ---------- scanning ----------
const EXT = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|cs|kt|rb|sh|c|h|cc|cpp|cxx|hpp|hh|R|r|jl|php|ex|exs)$/;
const SKIP = /(^|\/)(node_modules|\.git|\.sdd|dist|build|coverage|target|\.venv|venv|\.mastra|\.next|\.nuxt|\.turbo|\.output)\//;
const globRe = (g) => new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*$/, '\u0001').replace(/\*\*\/?/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\u0000/g, '(?:.*/)?').replace(/\u0001/g, '.*') + '$');
function scanFilter(files) {
  const sc = (readJson(CONFIG, null) ?? {}).scan ?? {};
  const inc = (sc.include ?? []).map(globRe);
  const exc = (sc.exclude ?? []).map(globRe);
  return files.filter((f) => (!inc.length || inc.some((r) => r.test(f))) && !exc.some((r) => r.test(f)));
}
// bin/ and obj/ next to a .NET project file are build output (generated .cs, copied sources): never scanned, even without a .gitignore (#137)
function dotnetOutputFilter(files) {
  const pd = new Set(files.filter((f) => /\.(cs|fs|vb)proj$/.test(f)).map((f) => path.posix.dirname(f)));
  if (!pd.size) return files;
  return files.filter((f) => { for (let d = path.posix.dirname(f); ; d = path.posix.dirname(d)) { if (pd.has(d) && /^(bin|obj)\//.test(d === '.' ? f : f.slice(d.length + 1))) return false; if (d === '.' || d === '/') return true; } });
}
function workspaceFiles(base = ROOT) {
  const r = spawnSync('git', ['ls-files', '-co', '--exclude-standard'], { cwd: base, encoding: 'utf8', maxBuffer: 64e6 });
  let files;
  // tracked files deleted from the working tree but not staged are still listed by git (#228)
  if (r.status === 0) files = r.stdout.split('\n').filter((f) => f && fs.existsSync(path.join(base, f)));
  else {
    files = [];
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        const f = path.relative(base, p).split(path.sep).join('/');
        if (SKIP.test(f + '/') || /(^|\/)vendor\//.test(f + '/')) continue;
        if (e.isDirectory()) walk(p); else if (e.isFile()) files.push(f);
      }
    };
    walk(base);
  }
  files = [...new Set(files)]; // an unmerged path is listed once per index stage
  return dotnetOutputFilter(files);
}
/** @id CODE-SCAN-001 @implements REQ-SCAN-001 REQ-SCAN-002 REQ-SCAN-003 */
function listFiles() {
  const configured = (readJson(CONFIG, null)?.scan ?? {}).maxFileBytes;
  const maxFileBytes = configured === undefined ? 16 * 1024 * 1024 : configured;
  if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes <= 0) throw new Error('REFUSED: source scan: scan.maxFileBytes must be a positive safe integer');
  const files = scanFilter(workspaceFiles()).filter((f) => EXT.test(f) && !SKIP.test(f) && fs.existsSync(path.join(ROOT, f)));
  for (const file of files) {
    const size = fs.statSync(path.join(ROOT, file)).size;
    if (size > maxFileBytes) throw new Error(`REFUSED: source scan: ${file} is ${size} bytes, exceeding scan.maxFileBytes=${maxFileBytes}; explicitly configure the limit or review scan filters`);
  }
  return files;
}

const ID_RE = /[A-Z][A-Z0-9]+(?:-[A-Z0-9]+)+/g;
const COMMENT_LEAD = /^\s*(\*|\/\/|#|\/\*|--|;)/;
// marks lines that start inside a multi-line JS/TS template literal (embedded fixtures)
const REGEX_KW = /(?:^|[^\w$.])(return|typeof|case|in|of|delete|void|throw|new|else|do|yield|await)$/;
// a '/' starts a regex literal when the previous token cannot end an expression
function regexAllowed(l, k) {
  const before = l.slice(0, k).trimEnd();
  if (!before) return true;
  const c = before.at(-1);
  if (/[(,=:[!&|?{};+\-*%<>~^]/.test(c)) return true;
  return REGEX_KW.test(before);
}
// end index of a single-line regex literal starting at k, or -1 (then treat '/' as division)
function regexEnd(l, k) {
  let cls = false;
  for (let j = k + 1; j < l.length; j++) {
    const c = l[j];
    if (c === '\\') j++;
    else if (c === '[') cls = true;
    else if (c === ']') cls = false;
    else if (c === '/' && !cls) return j;
  }
  return -1;
}
function templateLines(lines, f) {
  const flags = new Array(lines.length).fill(false);
  if (!/\.[cm]?[jt]sx?$/.test(f)) return flags;
  // tiny tokenizer: code / // / /* */ / '..' / ".." / `..${ code }..`
  let mode = 'code';
  const tpl = []; // brace depth at which each open ${ started
  let depth = 0;
  for (let i = 0; i < lines.length; i++) {
    flags[i] = mode === 'tpl';
    const l = lines[i];
    for (let k = 0; k < l.length; k++) {
      const c = l[k];
      const n = l[k + 1];
      if (mode === 'code') {
        if (c === '/' && n === '/') break;
        if (c === '/' && n === '*') { mode = 'block'; k++; }
        else if (c === '/' && regexAllowed(l, k)) {
          const e = regexEnd(l, k);
          if (e > 0) k = e;
        } else if (c === "'" || c === '"') {
          for (k++; k < l.length && l[k] !== c; k++) if (l[k] === '\\') k++;
        } else if (c === '`') mode = 'tpl';
        else if (c === '{') depth++;
        else if (c === '}') { if (tpl.length && tpl.at(-1) === depth) { tpl.pop(); mode = 'tpl'; } else depth = Math.max(0, depth - 1); }
      } else if (mode === 'block') {
        if (c === '*' && n === '/') { mode = 'code'; k++; }
      } else if (mode === 'tpl') {
        if (c === '\\') k++;
        else if (c === '`') mode = 'code';
        else if (c === '$' && n === '{') { tpl.push(depth); mode = 'code'; k++; }
      }
    }
  }
  // desync (unterminated template/comment at EOF): do not hide anything
  if (mode !== 'code') return new Array(lines.length).fill(false);
  return flags;
}
// true for lines that start a triple-quoted string or sit inside one
function pyDocLines(lines) {
  const flags = new Array(lines.length).fill(false);
  let open = null;
  lines.forEach((l, i) => {
    flags[i] = open !== null || /^\s*[rRbBuU]{0,2}("""|''')/.test(l);
    for (const m of l.matchAll(/"""|'''/g)) open = open === null ? m[0] : open === m[0] ? null : open;
  });
  return flags;
}
function scanEntities(files) {
  const ents = new Map();
  const dups = [];
  for (const f of files) {
    const lines = fs.readFileSync(path.join(ROOT, f), 'utf8').split('\n');
    const inTpl = templateLines(lines, f);
    // Python: annotations in docstrings (a line starting a triple-quoted string, or inside one) count as comments
    const doc = f.endsWith('.py') ? pyDocLines(lines) : null;
    const lead = (i) => COMMENT_LEAD.test(lines[i]) || !!doc?.[i];
    for (let i = 0; i < lines.length; i++) {
      if (inTpl[i] || !lead(i)) continue;
      const m = /@id\s+([A-Z][A-Z0-9]+(?:-[A-Z0-9]+)+)/.exec(lines[i]);
      if (!m) continue;
      const suffix = /^[a-z][\w-]*/.exec(lines[i].slice(m.index + m[0].length));
      if (suffix) { dups.push(`INVALID:${m[1]}${suffix[0]}`); continue; }
      let block = lines[i];
      for (let j = i + 1; j < Math.min(lines.length, i + 9); j++) {
        if (!lead(j) || /@id\s/.test(lines[j])) break;
        block += '\n' + lines[j];
      }
      const refs = { implements: [], verifies: [], design: [] };
      for (const t of block.matchAll(/@(implements|verifies|design)\s+([^@\n]*)/g)) {
        refs[t[1]].push(...(t[2].match(ID_RE) ?? []));
      }
      const id = m[1];
      const ent = { id, kind: id.split('-')[0], path: f, line: i + 1, refs };
      if (ents.has(id)) dups.push(`${id} (${ents.get(id).path}:${ents.get(id).line} & ${f}:${i + 1})`);
      else ents.set(id, ent);
    }
  }
  return { ents, dups };
}

// CRLF, trailing `# comment`, and quotes are tolerated so tier/approval can never silently degrade (#59)
function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text.replace(/^\uFEFF/, ''));
  const fm = {};
  if (m) for (const l of m[1].split(/\r\n|\r|\n/)) { const kv = /^(\w+):\s*(.*)$/.exec(l); if (kv) fm[kv[1]] = kv[2].replace(/\s+#.*$/, '').trim().replace(/^(["'])(.*)\1$/, '$2').trim(); }
  return fm;
}
// `deferred` / `test-only` count only as a delimited marker ((deferred), [deferred], `deferred`, own cell), never as a word in the prose (#58)
const hasMarker = (l, w) => new RegExp(`(?:^|[(\\[\`*|<])\\s*${w}\\s*(?:$|[)\\]\`*|>])`, 'i').test(l);
function loadSpecs() {
  const specs = [];
  if (!fs.existsSync(SPECS)) return specs;
  for (const f of fs.readdirSync(SPECS).filter((x) => x.endsWith('.md')).sort()) {
    const p = `.sdd/specs/${f}`;
    const text = fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/^\uFEFF/, '');
    if (/^<{7}( |$)/m.test(text) && /^>{7}( |$)/m.test(text)) { out(`SPEC CONFLICT: ${p} has git merge conflict markers — resolve them first`); process.exit(2); }
    const fm = parseFrontmatter(text);
    const reqs = [];
    const lines = text.split(/\r\n|\r|\n/);
    lines.forEach((raw, i) => {
      // full-width digits/letters/brackets are matched as their ASCII forms; hashes still use the raw text (#78)
      const l = raw.normalize('NFKC');
      const m = /^([\s|#>*-]*)\*{0,2}(REQ-[A-Z0-9]+(?:-[A-Z0-9]+)*)/.exec(l);
      if (!m) return;
      const marked = /[|#>*-]/.test(m[1]);
      // a list bullet citing an already-defined REQ (e.g. under Assumptions) is a reference, not a second definition (#276)
      if (!m[1].includes('|') && reqs.some((q) => q.id === m[2] && q.table)) return;
      // a bare line starting with an id is prose (e.g. "REQ-X-2 was spiked") unless the id is followed by a delimiter (#65)
      if (!marked && !/^\s*REQ-[A-Z0-9-]+\s*(?:[:：|(]|\*\*)/.test(l)) return;
      let body = raw;
      // continuation lines of a list/prose requirement belong to its wording (#65)
      if (!m[1].includes('|')) for (let j = i + 1; j < lines.length && /^\s+\S/.test(lines[j]) && !/^\s*(?:[|#>*-]|REQ-)/.test(lines[j]); j++) body += ' ' + lines[j];
      reqs.push({ id: m[2], table: m[1].includes('|'), srcs: [...l.matchAll(/\[src:\s*([^\]\s:]+):(\d+)(?:-(\d+))?([^\]]*)\]/g)].map((x) => [x[1], +x[2], x[3] ? +x[3] : undefined, /`([^`]+)`/.exec(x[4])?.[1]]), line: i + 1, tests: m[1].includes('|') ? [...new Set(l.match(/\bTEST-[A-Z0-9]+(?:-[A-Z0-9]+)*/g) ?? [])] : [], sha: sha(body.normalize('NFKC').replace(/\[src:[^\]]*\]/g, '').replace(/\s+/g, ' ').trim()), rawSha: sha(body.replace(/\s+/g, ' ').trim()), srcSha: sha(body.normalize('NFKC').replace(/\s+/g, ' ').trim()), deferred: hasMarker(body.normalize('NFKC'), 'deferred'), testOnly: hasMarker(body.normalize('NFKC'), 'test-only') || hasMarker(body.normalize('NFKC'), 'characterization'), characMarker: hasMarker(body.normalize('NFKC'), 'characterization') && !hasMarker(body.normalize('NFKC'), 'test-only') });
    });
    const extra = fm.artifacts ? fm.artifacts.split(',').map((s) => s.trim()).filter(Boolean) : [];
    const tl = lines;
    const di = tl.findIndex((l) => /^#{1,4}\s*(?:\d+[.)]?\s*)?(Design|設計)\b/i.test(l));
    let designLines = 0;
    if (di >= 0) for (const l of tl.slice(di + 1)) { if (/^#{1,4}\s/.test(l)) break; if (l.trim()) designLines += Math.max(1, l.split(/(?<=[。！？；])|(?<=[.!?;])\s+/).filter((x) => x.trim().length >= 8).length); }
    specs.push({ path: p, feature: fm.feature || f.replace(/\.md$/, ''), tier: (fm.tier || 'T1').toUpperCase(), approval: (fm.approval || 'auto').toLowerCase(), reqs, designLines, artifacts: [p, ...extra],
      dependsOn: fm.dependsOn ? fm.dependsOn.split(',').map(value => value.trim()) : [] });
  }
  return specs;
}

// T2 specs and `approval: human` specs (any tier) need a lock (#63)
// the lock remembers the tier/approval it was granted under: loosening either (T2->T1, dropping `approval: human`) stays locked until a human re-approves (#71)
const lockDrift = (s) => {
  const a = readJson(APPROVALS, {})[s.feature];
  if (!a) return null;
  if (a.tier === 'T2' && s.tier !== 'T2') return `tier ${s.tier} (was locked as T2)`;
  if (a.requireHuman && s.approval !== 'human') return 'approval: human removed';
  return null;
};
const needsLock = (s) => s.tier === 'T2' || s.approval === 'human' || !!lockDrift(s);
// a T2 spec must carry a Design section (components, state/policy tables, key decisions) before it can be locked
function designProblem(s) {
  return s.tier === 'T2' && s.designLines < 2 ? `${s.path}: T2 spec needs a "## Design" section (≥2 non-blank lines — each sentence counts as a line; components, data flow, state/policy tables, key decisions)` : null;
}

// ---------- approval ----------
// The first human-approved implementation refreshes `code`; it is not a new spec approval.
const approvalSha = (a) => sha(JSON.stringify([a.by, a.kind, a.review, a.reviewSha, a.at, a.tier, a.requireHuman, Object.entries(a.artifacts ?? {}).sort(([x], [y]) => x < y ? -1 : x > y ? 1 : 0)]));
/** @id CODE-R30C-001 @implements REQ-R30C-001 */
function approvalProvenance(feature, a) {
  const entries = readLedger();
  if (verifyChain(entries)) return false;
  const events = entries.filter((e) => e.type === 'approval' && e.feature === feature);
  if (events.length) return events.some((e) => e.approvalSha === approvalSha(a));
  // Pre-event locks remain valid only while unchanged from committed history.
  const committed = spawnSync('git', ['show', 'HEAD:./.sdd/approvals.json'], { cwd: ROOT, encoding: 'utf8' });
  if (committed.status !== 0) return false;
  const history = spawnSync('git', ['show', 'HEAD:./.sdd/tdd.jsonl'], { cwd: ROOT, encoding: 'utf8' });
  if (history.status === 0) {
    try { if (history.stdout.split('\n').filter(Boolean).some((l) => { const e = JSON.parse(l); return e.type === 'approval' && e.feature === feature; })) return false; } catch { return false; }
  }
  try { const old = JSON.parse(committed.stdout)[feature]; return !!old && approvalSha(old) === approvalSha(a); } catch { return false; }
}
function approvalState(spec) {
  const a = readJson(APPROVALS, {})[spec.feature];
  if (!a) return 'missing';
  if (lockDrift(spec)) return 'stale';
  for (const p of spec.artifacts) {
    if (!fs.existsSync(path.join(ROOT, p)) || ![fileSha(p), artifactSha(p)].includes(a.artifacts?.[p])) return 'stale';
  }
  // the cited review file is part of the lock: deleted or edited after record => stale (#122)
  if (a.kind === 'ai' && a.review && a.reviewSha && (!fs.existsSync(path.resolve(ROOT, a.review)) || fileSha(a.review) !== a.reviewSha)) return 'stale';
  if (!approvalProvenance(spec.feature, a)) return 'invalid provenance (run approve record after review)';
  return 'ok';
}

// ---------- ledger ----------
function readLedger() {
  if (!fs.existsSync(LEDGER)) return [];
  const ls = fs.readFileSync(LEDGER, 'utf8').split('\n').filter(Boolean);
  if (ls.some((l) => /^(<{7}|={7}|>{7})/.test(l))) { out(`LEDGER CONFLICT: ${rel(LEDGER)} has git merge conflict markers. Run: tdd merge-ledger (keeps both branches' evidence, re-chains the ledger)`); process.exit(2); }
  return ls.map((l, i) => {
    let e;
    try { e = JSON.parse(l); } catch { out(`LEDGER CORRUPT: ${rel(LEDGER)} line ${i + 1} is not valid JSON`); process.exit(2); }
    if (!e || typeof e !== 'object' || Array.isArray(e)) { out(`LEDGER CORRUPT: ${rel(LEDGER)} line ${i + 1} must be an event object`); process.exit(2); }
    return e;
  });
}
const entryHash = (e) => { const { hash, ...rest } = e; return sha(JSON.stringify(rest)); };
function ledgerEventProblem(e) {
  const text = (v) => typeof v === 'string' && v.trim().length > 0;
  const digest = (v) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
  if (!e || typeof e !== 'object' || Array.isArray(e)) return 'event must be an object';
  if (e.v !== 1) return 'unsupported or missing version';
  if (!text(e.at) || !Number.isFinite(Date.parse(e.at))) return 'invalid or missing timestamp';
  if (['red', 'green', 'refactor'].includes(e.type)) {
    for (const f of ['test', 'req', 'file']) if (!text(e[f])) return `invalid or missing ${f}`;
    for (const f of ['fileSha', 'cmdSha']) if (!digest(e[f])) return `invalid or missing ${f}`;
    if (!Number.isSafeInteger(e.exit) || e.exit < 0) return 'exit must be a nonnegative integer';
    if (!Number.isFinite(e.ms) || e.ms < 0) return 'ms must be a nonnegative number';
    if (e.type !== 'red' && e.exit !== 0) return `${e.type} requires exit 0`;
    if (e.type === 'red' && e.exit === 0 && !text(e.characterization) && !text(e.retest)) return 'passing Red requires an explicit characterization or retest';
    if (e.characterization !== undefined && (!text(e.characterization) || e.type !== 'red' || e.exit !== 0)) return 'invalid characterization outcome';
    if (e.retest !== undefined && (!text(e.retest) || e.type !== 'red')) return 'invalid retest';
    if (e.runnerExit !== undefined && (!Number.isSafeInteger(e.runnerExit) || e.runnerExit < 0)) return 'invalid runnerExit';
  } else if (e.type === 'approval') {
    if (!text(e.feature) || !digest(e.approvalSha)) return 'approval requires feature and approvalSha';
  } else if (e.type === 'flaky') {
    if (!text(e.check) || !Number.isSafeInteger(e.retry) || e.retry < 1 || !Number.isSafeInteger(e.retries) || e.retry > e.retries) return 'invalid flaky retry';
    if (!['warn', 'fail'].includes(e.policy) || e.outcome !== (e.policy === 'warn' ? 'accepted' : 'fail')) return 'invalid flaky policy/outcome';
  } else if (e.type === 'scope-waiver') {
    if (![e.globs, e.files].every((v) => Array.isArray(v) && v.every(text))) return 'scope waiver requires globs and files';
  } else return 'unknown event type';
  return null;
}
function verifyChain(entries) {
  let prev = '';
  let at = -Infinity;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e && typeof e === 'object' && !Array.isArray(e) && (e.prev !== prev || e.hash !== entryHash(e))) return `broken at seq ${e.seq ?? i + 1}`;
    const problem = ledgerEventProblem(e);
    if (problem) return `invalid event at seq ${e?.seq ?? i + 1}: ${problem}`;
    if (e.seq !== i + 1) return `invalid sequence at seq ${e.seq}: expected ${i + 1}`;
    const time = Date.parse(e.at);
    if (time < at) return `invalid timestamp at seq ${e.seq}: time goes backwards`;
    prev = e.hash;
    at = time;
  }
  return null;
}
// exclusive lock so concurrent tdd runs cannot fork the hash chain (#109)
function withLedgerLock(fn) {
  fs.mkdirSync(SDD, { recursive: true });
  const lock = path.join(SDD, 'tdd.lock');
  const t0 = Date.now();
  for (;;) {
    try { fs.mkdirSync(lock); break; } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 15000) { fs.rmdirSync(lock); continue; } } catch { continue; }
      if (Date.now() - t0 > 30000) { out(`ledger lock ${path.relative(ROOT, lock)} held >30s by another tdd run; remove it if stale`); process.exit(2); }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  try { return fn(); } finally { try { fs.rmdirSync(lock); } catch {} }
}
function appendLedger(e) {
  withLedgerLock(() => appendLedgerLocked(e));
}
function appendLedgerLocked(e) {
  const entries = readLedger();
  const full = { v: 1, seq: entries.length + 1, ...e, at: new Date().toISOString(), prev: entries.at(-1)?.hash ?? '' };
  full.hash = entryHash(full);
  const problem = verifyChain([...entries, full]) ?? ledgerRegression();
  if (problem) { out(`LEDGER FAIL: ${problem}`); process.exit(1); }
  fs.mkdirSync(SDD, { recursive: true });
  fs.appendFileSync(LEDGER, JSON.stringify(full) + '\n');
}
// every baseline ledger entry must survive (ignoring seq/prev/hash, which merge-ledger re-chains); a removed or rewritten one is tampering (#328)
function ledgerRegression(bref = 'HEAD') {
  const git = (args) => spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64e6, timeout: 60000, env: { ...process.env, LC_ALL: 'C' } });
  const failed = (r) => r.error || r.signal || r.status !== 0;
  const unreadable = (r) => `cannot read baseline ledger of ${bref}: ${r.error?.code || r.signal || r.stderr?.trim() || `git exited ${r.status}`}`;
  const sh = git(['show', `${bref}:./.sdd/tdd.jsonl`]);
  // A failed/truncated capture is not an absent ledger. Only a successful tree
  // lookup, a non-repository, or a verified unborn HEAD can establish absence.
  if (sh.error || sh.signal) return unreadable(sh);
  if (sh.status !== 0) {
    const tree = git(['ls-tree', '-z', bref, '--', './.sdd/tdd.jsonl']);
    if (!failed(tree)) return tree.stdout === '' ? null : unreadable(sh);
    if (tree.error || tree.signal) return unreadable(tree);
    const repo = git(['rev-parse', '--is-inside-work-tree']);
    if (!repo.error && !repo.signal && repo.status === 128 && /not a git repository/.test(repo.stderr)) return null;
    if (failed(repo)) return unreadable(repo);
    if (bref === 'HEAD') {
      const branch = git(['symbolic-ref', '-q', 'HEAD']);
      if (!failed(branch)) {
        const ref = git(['show-ref', '--verify', '--quiet', branch.stdout.trim()]);
        if (!ref.error && !ref.signal && ref.status === 1) return null;
        if (ref.error || ref.signal) return unreadable(ref);
      }
    }
    return unreadable(tree);
  }
  const key = (l) => { try { const { seq, prev, hash, ...r } = JSON.parse(l); return JSON.stringify(r); } catch { return l; } };
  let current;
  try { current = fs.readFileSync(LEDGER, 'utf8'); } catch (err) {
    if (err.code !== 'ENOENT') return `cannot read current ledger ${rel(LEDGER)}: ${err.code || err.message}`;
    current = '';
  }
  const cur = new Set(current.split('\n').filter(Boolean).map(key));
  const lost = sh.stdout.split('\n').filter(Boolean).map(key).filter((k) => !cur.has(k));
  return lost.length ? `${lost.length} ledger entr${lost.length === 1 ? 'y' : 'ies'} of ${bref} removed or modified in ${rel(LEDGER)} (truncation/rewrite; only appends or tdd merge-ledger are allowed)` : null;
}
let REQ_SHA = null;
// current hash of a REQ's spec line; entries recorded before this field existed have no reqSha and are not checked
function reqShaOf(id) {
  if (!REQ_SHA) { REQ_SHA = new Map(); for (const sp of loadSpecs()) for (const r of sp.reqs) REQ_SHA.set(r.id, { sha: r.sha, raw: r.rawSha, src: r.srcSha }); }
  return REQ_SHA.get(id)?.sha;
}
// ledgers written before NFKC hashing carry the raw-text hash (#83)
const reqShaSame = (id, rsha) => { const c = REQ_SHA?.get(id); return !c || c.sha === rsha || c.raw === rsha || c.src === rsha; };
// names the oracle dependency files whose content differs from what a ledger entry recorded (#236, #239)
function changedOracleDeps(entry, p, id) {
  if (!entry) return [];
  try { testSha(p, id); } catch { return []; }
  const now = oracleDependencyShas, was = entry.oracleShas ?? {};
  return [...new Set([...Object.keys(was), ...Object.keys(now)])].filter((f) => was[f] !== now[f]).sort();
}
// opt-in `artifactStaleness`: config `artifacts` files the test file names (path or basename) are hashed into Green/Refactor evidence (#309)
// artifactGranularity "test": only the test's own lines plus the file's shared preamble (text before the first @id) count as readers (#312)
// a declared artifact whose configured consumer a test reaches through imports (transitively) is also a dependency of that test (#321)
function importClosure(p) {
  const seen = new Set([path.join(ROOT, p)]), queue = [...seen];
  while (queue.length && seen.size < 500) {
    const f = queue.shift();
    let text; try { text = fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n'); } catch { continue; }
    let next = []; try { next = /^\.(?:[cm]?[jt]s|[jt]sx)$/.test(path.extname(f)) ? scriptOracleImports(f, text, true) : localSourceDependencies(f, text, f === path.join(ROOT, p)); } catch { continue; }
    for (const d of next) if (d.startsWith(ROOT + path.sep) && !seen.has(d)) { seen.add(d); queue.push(d); }
  }
  return new Set([...seen].map(rel));
}
let artifactsShapeWarned = false;
function artifactShasFor(p, id) {
  const cfg = readJson(CONFIG, null) ?? {};
  if (cfg.artifactStaleness !== true || !cfg.artifacts || typeof cfg.artifacts !== 'object') return undefined;
  if (Array.isArray(cfg.artifacts)) {
    if (!artifactsShapeWarned) { artifactsShapeWarned = true; process.stdout.write('! config `artifacts` must be an object {"contract/x.json": ["src/consumer.ts"]}, not an array; treating each entry as an artifact without consumers\n'); }
    cfg.artifacts = Object.fromEntries(cfg.artifacts.filter((x) => typeof x === 'string').map((x) => [x, []]));
  }
  let text = '';
  try { text = fs.readFileSync(path.join(ROOT, p), 'utf8'); } catch { return undefined; }
  if (cfg.artifactGranularity === 'test' && id) {
    const ls = text.replace(/\r\n/g, '\n').split('\n');
    const at = ls.findIndex((l) => new RegExp(`@id\\s+${id}\\b`).test(l));
    if (at >= 0) {
      let end = ls.findIndex((l, i) => i > at && /@id\s+TEST-/.test(l)); if (end < 0) end = ls.length;
      const first = ls.findIndex((l) => /@id\s+TEST-/.test(l));
      text = [...ls.slice(0, first), ...ls.slice(at, end)].join('\n');
    }
  }
  const out = {};
  let reach;
  for (const [a, users] of Object.entries(cfg.artifacts)) {
    const n = normDep(a), abs = path.join(ROOT, n);
    if (!text.includes(n) && !text.includes(path.basename(n))) {
      reach ??= importClosure(p);
      if (![].concat(users).some((u) => reach.has(normDep(u)))) continue;
    }
    try { out[n] = fs.statSync(abs).isDirectory() ? 'dir' : fileSha(n); } catch { out[n] = 'missing'; }
  }
  return Object.keys(out).length ? out : undefined;
}
function changedArtifacts(entry) {
  const was = entry?.artifactShas;
  if (!was) return [];
  return Object.keys(was).filter((n) => { let now; try { now = fs.statSync(path.join(ROOT, n)).isDirectory() ? 'dir' : fileSha(n); } catch { now = 'missing'; } return now !== was[n]; }).sort();
}
// a support file that replaced an annotated stub without keeping its `@id CODE-` marker becomes part of the oracle (#265)
const unannotatedHint = (names) => { const bad = names.filter((f) => { try { return !/@id\s+CODE-/.test(fs.readFileSync(path.join(ROOT, f), 'utf8')); } catch { return false; } }); return bad.length ? `; if ${bad.slice(0, 3).join(', ')} is production code, annotate it \`@id CODE-... @implements REQ-...\`` : ''; };
const oracleNote = (names) => names.length ? ` — oracle dependency changed: ${names.slice(0, 4).join(', ')}${names.length > 4 ? `, … +${names.length - 4}` : ''}` : '';
// the test's own lines (its @id line up to the next @id): lets the stale hint tell a shared-file edit from an edit of the test itself (#300)
function testRegionSha(p, id) {
  try {
    const ls = fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n').split('\n');
    const at = ls.findIndex((l) => new RegExp(`@id\\s+${id}\\b`).test(l));
    if (at < 0) return undefined;
    let end = ls.findIndex((l, i) => i > at && /@id\s/.test(l)); if (end < 0) end = ls.length;
    return sha(ls.slice(at, end).filter((l) => !/@id\s+CODE-/.test(l)).join('\n').trim());
  } catch { return undefined; }
}
const evidenceLedgerProblems = new WeakMap();
function evidenceStatus(testId, testPath, entries) {
  // Evidence checks share an immutable ledger snapshot; hash it once, not once per test.
  if (!evidenceLedgerProblems.has(entries)) evidenceLedgerProblems.set(entries, verifyChain(entries));
  const problem = evidenceLedgerProblems.get(entries);
  if (problem) return { ok: false, why: `invalid ledger: ${problem}` };
  const es = entries.filter((e) => e.test === testId);
  // reverting to content that already has Green/Refactor evidence recovers it, even after a later refactor recorded against moved setup (#274)
  const gs = es.filter((e) => e.type === 'green');
  const g = gs.filter((e) => shaMatches(e.fileSha, testPath, testId)).at(-1) ?? gs.at(-1);
  if (!g) return { ok: false, why: 'no Green recorded' };
  const r = es.filter((e) => e.type === 'red' && e.seq < g.seq && e.fileSha === g.fileSha).at(-1);
  if (!r) return { ok: false, why: 'no Red preceding Green with same test hash' };
  const ge = es.filter((e) => e.type === 'green' || e.type === 'refactor');
  const last = ge.filter((e) => shaMatches(e.fileSha, testPath, testId)).at(-1) ?? ge.at(-1);
  if (!shaMatches(last.fileSha, testPath, testId)) return { ok: false, why: `test changed since last Green/Refactor${oracleNote(changedOracleDeps(last, testPath, testId))} (if the spec changes the expected output, update the test and re-record: tdd red ${testId} --retest "<reason>", then tdd green; otherwise revert the test)`.replace(/^(.*?) \(if the spec.*$/, (m, a) => last.regSha && last.regSha === testRegionSha(testPath, testId) ? `${a} but its own lines did not (shared test-file content moved): re-run tdd refactor ${testId}${last.req && loadSpecs().some((x) => x.tier === 'T1' && x.reqs.some((q) => q.id === last.req)) ? ' --wording "<why>"' : ''} (a --retest needs the test expectation itself to change)` : m) };
  // every verified REQ is hash-tracked (reqShas); older entries carry only the first one
  for (const [rid, rsha] of Object.entries(last.reqShas ?? { [last.req]: last.reqSha })) {
    if (rsha && reqShaOf(rid) && !reqShaSame(rid, rsha)) return { ok: false, why: `${rid} changed in the spec since last Green/Refactor: re-verify with tdd refactor (wording only) or tdd red/green (behaviour changed)` };
  }
  const stale = changedArtifacts(last);
  if (stale.length) return { ok: false, why: `artifact ${stale.join(', ')} changed since last Green/Refactor: re-verify with tdd refactor ${testId} (data change keeps behaviour; the evidence line still lists it as "refactor-recorded, no new Red") or tdd red ${testId} --retest "<reason>" then tdd green (clears that evidence note too)` };
  return { ok: true, weak: !!r.weak, suspect: !!r.suspect, charac: !!r.characterization, retest: !!r.retest, retestSuperseded: !!(r.retest && r.priorStrongRed), blessed: !!last.moved };
}

// ---------- config / commands ----------
// multi-project: a subproject without a match must not fail the build; print a per-task total so zero-match detection works
const GRADLE_INIT = 'allprojects { tasks.withType(Test).configureEach { filter.failOnNoMatchingTests = false; afterTest { d, r -> println("SDD-TEST " + d.className + " " + d.name + " " + r.resultType) }; afterSuite { d, r -> if (!d.parent) println("Tests run: " + r.testCount + ", Failures: " + r.failedTestCount + ", Skipped: " + r.skippedTestCount) } } }';
const R_TEST = 'testthat::test_file(commandArgs(TRUE)[1], reporter = "summary", stop_on_failure = TRUE)';
// Pkg.test() needs a package registry even for stdlib test deps: offline it is an infra error, so fall back to running test/runtests.jl directly (#132)
const JULIA_TEST = 'out=$(julia --project=. -e "using Pkg; Pkg.test()" 2>&1); r=$?; if [ $r -eq 0 ]; then printf "%s\\n" "$out"; exit 0; fi; if [ -f test/runtests.jl ] && printf "%s" "$out" | grep -qiE "to be registered|registry|could not resolve host|failed to (fetch|clone)|network|offline"; then echo "sdd: INFRA: Pkg.test() failed to resolve packages (no registry/network) — falling back to julia --project=. test/runtests.jl"; julia --project=. test/runtests.jl; exit $?; fi; printf "%s\\n" "$out"; exit $r';
const JULIA_VERBOSE = `import Test
function sdd_verbose(ex)
    ex isa Expr || return ex
    standard(a, name) = a === name || (a isa GlobalRef && a.mod === Test && a.name === name) || (a isa Expr && a.head === :. && length(a.args) == 2 && a.args[1] isa Symbol && isdefined(Main, a.args[1]) && getfield(Main, a.args[1]) === Test && a.args[2] isa QuoteNode && a.args[2].value === name)
    if ex.head === :macrocall && standard(ex.args[1], Symbol("@testset"))
        compatible(a) = a isa AbstractString || standard(a, :DefaultTestSet) || (a isa Expr && a.head in (:(=), :string))
        if all(compatible, ex.args[3:end-1])
            filter!(a -> !(a isa Expr && a.head === :(=) && a.args[1] === :verbose), ex.args)
            insert!(ex.args, 3, Expr(:(=), :verbose, true))
        end
    end
    ex.args = map(sdd_verbose, ex.args)
    ex
end
Base.include(sdd_verbose, Main, abspath(ARGS[1]))`;
// `dotnet test` takes one project: run each affected test project in turn and fail if any fails (#135)
const DOTNET_CHANGED = 'r=0; for p in "$@"; do dotnet test "$p" --nologo || r=1; done; exit $r';
function detectConfig(base = ROOT) {
  const pkg = readJson(path.join(base, 'package.json'), null);
  const has = (f) => fs.existsSync(path.join(base, f));
  const pyTests = () => ['.', 'tests', 'test'].some((d) => { try { return fs.readdirSync(path.join(base, d)).some((f) => /^test_\w*\.py$|^\w+_test\.py$/.test(f)); } catch { return false; } });
  const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
  let testCmd;
  const gradle = (has('build.gradle') || has('build.gradle.kts') || has('settings.gradle') || has('settings.gradle.kts')) ? (has('gradlew') ? './gradlew' : 'gradle') : null;
  const dotnet = fs.existsSync(base) && fs.readdirSync(base).some((f) => /\.(csproj|sln|slnx)$/.test(f));
  const phpunit = has('vendor/bin/phpunit') ? 'vendor/bin/phpunit' : 'phpunit';
  let phpHistory = '--do-not-cache-result';
  if (has('composer.json') || has('phpunit.xml') || has('phpunit.xml.dist')) {
    const version = spawnSync(phpunit, ['--version'], { cwd: base, encoding: 'utf8', timeout: 10000 });
    const numbers = /PHPUnit\s+(\d+)\.(\d+)/i.exec(version.stdout ?? '');
    if (numbers && (+numbers[1] > 13 || (+numbers[1] === 13 && +numbers[2] >= 4))) phpHistory = '--do-not-record-test-run-history';
  }
  // configure once, keep the build log quiet unless it fails (cmake --build re-configures when CMakeLists change)
  const CMAKE_RUN = '[ -f build/CMakeCache.txt ] || cmake -S . -B build -Wno-dev >/dev/null || exit 1; cmake --build build >build/.sdd-build.log 2>&1 || { cat build/.sdd-build.log; exit 1; }; ctest --test-dir build --output-on-failure';
  if (has('node_modules/.bin/vitest')) deps.vitest ??= '*';
  if (has('node_modules/.bin/jest')) deps.jest ??= '*';
  if (deps.vitest) testCmd = ['npx', 'vitest', 'run', '{file}', '-t', '{id}(?![0-9A-Za-z])'];
  else if (deps.jest) testCmd = ['npx', 'jest', '{file}', '-t', '{id}(?![0-9A-Za-z])'];
  else if (has('pyproject.toml') || has('pytest.ini') || has('requirements.txt') || has('conftest.py') || has('tests/conftest.py') || pyTests()) testCmd = ['python3', '-m', 'pytest', '-q', '{file}', '-k', '{idu}'];
  else if (has('go.mod')) testCmd = ['go', 'test', './...', '-run', '{IDU}(_|$)'];
  else if (has('Cargo.toml')) testCmd = ['cargo', 'test', '{idu}'];
  else if (has('mix.exs')) testCmd = ['mix', 'test', '{file}'];
  else if (has('pom.xml')) testCmd = ['mvn', '-B', '-ntp', 'test', '-Dtest=*#*{idu}', '-Dsurefire.failIfNoSpecifiedTests=false'];
  else if (gradle) testCmd = ['sh', '-c', `mkdir -p .sdd && f=".sdd/gradle-$$.gradle" && printf '%s\\n' '${GRADLE_INIT}' > "$f" && ${gradle} -I "$f" cleanTest test --tests "*$0" --console=plain; r=$?; rm -f "$f"; exit $r`, '{idu}'];
  else if (has('CMakeLists.txt')) testCmd = ['sh', '-c', CMAKE_RUN + ' -R "$0"', '{idu}'];
  else if (has('composer.json') || has('phpunit.xml') || has('phpunit.xml.dist')) testCmd = [phpunit, phpHistory, '--filter', '{idu}', '{file}'];
  else if (has('DESCRIPTION')) testCmd = ['Rscript', '-e', R_TEST, '{file}'];
  else if (has('Project.toml')) testCmd = ['julia', '--project=.', '{file}'];
  else if (dotnet) testCmd = ['dotnet', 'test', '--nologo', '--filter', 'FullyQualifiedName~{idu}'];
  else if (has('Makefile')) testCmd = ['make', 'test', 'TEST={idu}'];
  else testCmd = ['node', '--test', '--test-name-pattern', '{id}(?![0-9A-Za-z])', '{file}'];
  const checks = [];
  const pm = has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : 'npm';
  const related = deps.vitest ? ['npx', 'vitest', 'related', '--run', '{changedFiles}'] : deps.jest ? ['npx', 'jest', '--findRelatedTests', '{changedFiles}'] : undefined;
  if (!pkg) {
    if (testCmd[0] === 'python3') checks.push({ name: 'test', cmd: ['python3', '-m', 'pytest', '-q'] });
    else if (has('go.mod')) checks.push({ name: 'test', cmd: ['go', 'test', './...'], changedCmd: ['go', 'test', '{changedGoPkgs}'] });
    else if (has('Cargo.toml')) checks.push({ name: 'test', cmd: ['cargo', 'test'], changedCmd: ['cargo', 'test', '{changedCargoPkgs}'] });
    else if (has('pom.xml')) checks.push({ name: 'test', cmd: ['mvn', '-B', '-ntp', 'test'], changedCmd: ['mvn', '-B', '-ntp', 'test', '-pl', '{changedModulesCsv}', '-am', '-DfailIfNoTests=false'] });
    else if (gradle) checks.push({ name: 'test', cmd: ['sh', '-c', `mkdir -p .sdd && f=".sdd/gradle-$$.gradle" && printf '%s\\n' '${GRADLE_INIT}' > "$f" && ${gradle} -I "$f" cleanTest test --console=plain; r=$?; rm -f "$f"; exit $r`], changedCmd: ['sh', '-c', `mkdir -p .sdd && f=".sdd/gradle-$$.gradle" && printf '%s\\n' '${GRADLE_INIT}' > "$f" && ${gradle} -I "$f" --console=plain "$@"; r=$?; rm -f "$f"; exit $r`, 'sdd', '{changedGradleTasks}'] });
    else if (has('CMakeLists.txt')) checks.push({ name: 'test', cmd: ['sh', '-c', CMAKE_RUN], changedCmd: ['sh', '-c', CMAKE_RUN + ' -R "$0"', '{changedCtestRegex}'] });
    else if (testCmd[0] === phpunit) checks.push({ name: 'test', cmd: [phpunit, phpHistory] });
    else if (dotnet) checks.push({ name: 'test', cmd: ['dotnet', 'test', '--nologo'], changedCmd: ['sh', '-c', DOTNET_CHANGED, 'sdd', '{changedTestProjects}'] });
    else if (has('Makefile')) checks.push({ name: 'test', cmd: ['make', 'test'] });
    else if (has('DESCRIPTION')) checks.push({ name: 'test', cmd: ['Rscript', '-e', 'testthat::test_dir("tests/testthat", reporter = "summary", stop_on_failure = TRUE)'] });
    else if (has('Project.toml')) checks.push({ name: 'test', cmd: ['sh', '-c', JULIA_TEST] });
    else if (has('mix.exs')) checks.push({ name: 'test', cmd: ['mix', 'test'] });
  }
  for (const s of ['typecheck', 'lint', 'test']) if (pkg?.scripts?.[s]) checks.push({ name: s, cmd: [pm, 'run', s], ...(s === 'test' && related ? { changedCmd: related, hubFallbackCmd: ['npx', deps.vitest ? 'vitest' : 'jest', ...(deps.vitest ? ['run'] : []), '{changedTests}', '{directTests}'] } : {}) });
  const prepare = pkg?.scripts?.build ? { cmd: [pm, 'run', 'build'], outputs: has('dist') ? ['dist'] : [], timeoutMs: 1800000 } : undefined;
  return { schemaVersion: 1, testCmd, ...(prepare ? { prepare } : {}), checks, timeoutMs: 120000 };
}
const loadConfig = () => readJson(CONFIG, null) ?? detectConfig();
const MANIFESTS = /(^|\/)(package\.json|pyproject\.toml|requirements\.txt|pytest\.ini|go\.mod|Cargo\.toml|pom\.xml|build\.gradle(\.kts)?|settings\.gradle(\.kts)?|CMakeLists\.txt|composer\.json|phpunit\.xml(\.dist)?|DESCRIPTION|Project\.toml|mix\.exs|Makefile|[^/]+\.(csproj|sln|slnx))$/;
// polyglot monorepo: nested manifests become projects with their own cwd/testCmd/checks
const ECO = [[/package\.json$/, 'js'], [/(pyproject\.toml|requirements\.txt|pytest\.ini)$/, 'py'], [/go\.mod$/, 'go'], [/Cargo\.toml$/, 'rust'], [/(pom\.xml|\.gradle(\.kts)?)$/, 'jvm'], [/CMakeLists\.txt$/, 'cpp'], [/(composer\.json|phpunit\.xml(\.dist)?)$/, 'php'], [/DESCRIPTION$/, 'r'], [/Project\.toml$/, 'julia'], [/mix\.exs$/, 'elixir'], [/Makefile$/, 'make'], [/\.(csproj|sln|slnx)$/, 'dotnet']];
const ecoOf = (f) => ECO.find(([re]) => re.test(f))?.[1];
// only csproj files that can run tests (Microsoft.NET.Test.Sdk / IsTestProject) become projects; class libraries are covered by the test projects that reference them (#132)
const isTestCsproj = (f) => { try { return /Microsoft\.NET\.Test\.Sdk|<IsTestProject>\s*true/i.test(fs.readFileSync(path.join(ROOT, f), 'utf8')); } catch { return false; } };
// Go runners cannot cross nested module boundaries, unlike root-managed workspaces.
function detectProjects(skipEco = new Set()) {
  const dirs = new Set();
  const all = workspaceFiles();
  for (const f of all) if (MANIFESTS.test(f) && f.includes('/') && (ecoOf(f) === 'go' || !skipEco.has(ecoOf(f))) && !/(^|\/)(node_modules|vendor|target|build)\//.test(f) && !(/\.csproj$/.test(f) && !isTestCsproj(f))) dirs.add(path.posix.dirname(f));
  const roots = [...dirs].sort().filter((d, i, a) => fs.existsSync(path.join(ROOT, d, 'go.mod')) || !a.slice(0, i).some((p) => d.startsWith(p + '/')));
  // Go modules that require/replace a sibling module depend on it: a change there must run the dependent's tests under gate --changed (#74)
  const gomod = (r) => { try { return fs.readFileSync(path.join(ROOT, r, 'go.mod'), 'utf8'); } catch { return ''; } };
  const modName = new Map(roots.map((r) => [/^module\s+(\S+)/m.exec(gomod(r))?.[1], r]).filter(([m]) => m));
  const goDeps = (r) => [...new Set([...gomod(r).matchAll(/^\s*(?:require\s+)?([\w.\/-]+)\s+v[\w.+-]+/gm)].map((m) => modName.get(m[1])).concat([...gomod(r).matchAll(/=>\s*(\.[^\s]*)/g)].map((m) => path.posix.normalize(path.posix.join(r, m[1])))).filter((d) => d && d !== r && roots.includes(d)))];
  // a test project depends on the projects it references (transitively) and on shared build files above it (#135)
  const dn = roots.some((r) => dirs.has(r) && all.some((f) => f.startsWith(r + '/') && /\.csproj$/.test(f))) ? dotnetGraph(ROOT) : null;
  const dnDeps = (root) => {
    if (!dn) return [];
    const mine = [...dn.projs.values()].filter((q) => q.dir === root);
    const refs = [...new Set(mine.flatMap((q) => [...dn.deps(q.file)]).map((f) => dn.projs.get(f).dir))].filter((d) => d !== root && d !== '.' && !d.startsWith(root + '/'));
    const props = mine.length ? dn.props.filter((x) => path.posix.dirname(x) === '.' || root.startsWith(path.posix.dirname(x) + '/')) : [];
    return [...refs, ...props];
  };
  return roots.map((root) => { const c = detectConfig(path.join(ROOT, root)); const deps = [...new Set([...goDeps(root), ...dnDeps(root)])]; return { root, ...(deps.length ? { dependsOn: deps } : {}), testCmd: c.testCmd, checks: c.checks.map(({ name, cmd, changedCmd, hubFallbackCmd }) => ({ name, cmd, ...(changedCmd ? { changedCmd } : {}), ...(hubFallbackCmd ? { hubFallbackCmd } : {}) })) }; });
}
function projectFor(p) {
  const ps = (loadConfig().projects ?? []).filter((x) => p === x.root || p.startsWith(x.root.replace(/\/$/, '') + '/'));
  return ps.sort((a, b) => b.root.length - a.root.length)[0] ?? null;
}

// `dotnet test` builds on every call. Within one sdd process (batch `tdd red A B C`, several checks) a second call on the same target gets --no-build only when the previous call built cleanly and no tracked file changed since (#137)
const dotnetBuilt = new Map();
// Inherit runtime settings and literal application inputs; runner overrides must be explicit in the reviewed command (#341).
const RUNNER_ENV_ALLOWLIST = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TMP', 'TEMP', 'TZ',
  'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'LC_COLLATE', 'LC_MESSAGES', 'LC_NUMERIC', 'LC_TIME', 'LC_MONETARY',
  'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
  'APPDATA', 'LOCALAPPDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMDATA',
  'JAVA_HOME', 'JDK_HOME', 'DOTNET_ROOT', 'DOTNET_ROOT_X64', 'DOTNET_ROOT_X86', 'DOTNET_CLI_HOME',
  'RUSTUP_HOME', 'CARGO_HOME', 'CI', 'TERM', 'NO_COLOR', 'FORCE_COLOR',
];
const WINDOWS_SDK_ENV = ['INCLUDE', 'LIB', 'LIBPATH'];
function runnerEnvValue(name) {
  const key = Object.keys(process.env).sort().find((key) => key.toUpperCase() === name);
  return key === undefined ? undefined : process.env[key];
}
function runnerCommandName(token) {
  const name = path.basename(token);
  return process.platform === 'win32' ? name.toLowerCase().replace(/\.cmd$/, '') : name;
}
/** @id CODE-WINRUN-003 @implements REQ-WINRUN-003 */
function runnerSdkDefinitions() {
  return process.platform !== 'win32' ? [] : WINDOWS_SDK_ENV.map((name) => [
    `environment:msvc|${name}`,
    { sha: sha(JSON.stringify(['sdd-msvc-env-v1', name, runnerEnvValue(name) ?? null])),
      label: `Windows SDK environment ${name} (changed)` },
  ]);
}
/** @id CODE-WINRUN-001 @implements REQ-WINRUN-001 */
function resolveExecutable(exe, cwd = ROOT) {
  if (!exe) return null;
  const windows = process.platform === 'win32';
  const search = windows ? runnerEnvValue('PATH') : process.env.PATH;
  const extensions = windows ? [...new Set((runnerEnvValue('PATHEXT') ?? '.COM;.EXE;.BAT;.CMD')
    .split(';').map((value) => value.trim().toLowerCase()).filter((value) => /^\.(?:com|exe|bat|cmd)$/.test(value)))] : [''];
  const suffixes = !windows || /^\.(?:com|exe|bat|cmd)$/i.test(path.extname(exe))
    || path.resolve(cwd, exe) === process.execPath ? [''] : path.extname(exe) ? [] : extensions;
  const candidates = /[/\\]/.test(exe) ? [path.resolve(cwd, exe)]
    : (search ?? '').split(path.delimiter).map((d) => path.resolve(cwd, d || '.', exe));
  for (const base of candidates) for (const extension of suffixes) {
    const p = base + extension;
    try { const s = fs.statSync(p); if (s.isFile() && (process.platform === 'win32' || (s.mode & 0o111))) return p; } catch {}
  }
  return null;
}
/** @id CODE-WINRUN-002 @implements REQ-WINRUN-002 */
function runnerCommand(argv, cwd = ROOT, resolve = resolveExecutable) {
  const selected = resolve(argv[0], cwd);
  if (process.platform === 'win32' && !selected) throw new Error(`Windows executable not found: ${argv[0]}`);
  if (process.platform !== 'win32' || !/\.(?:cmd|bat)$/i.test(selected ?? argv[0] ?? '')) {
    return { file: selected ?? argv[0], args: argv.slice(1) };
  }
  if (!selected) throw new Error(`Windows batch launcher not found: ${argv[0]}`);
  const name = /^(npm|npx)\.cmd$/i.exec(path.basename(selected))?.[1].toLowerCase();
  if (!name) throw new Error(`unsupported Windows batch launcher: ${selected}; use an explicit native executable or Node script`);
  const shim = fs.realpathSync(selected);
  const script = path.join(path.dirname(shim), 'node_modules/npm/bin', `${name}-cli.js`);
  let regular = false;
  try { regular = fs.statSync(script).isFile(); }
  catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error; }
  if (!regular) throw new Error(`Windows ${name} launcher requires the standard npm entry point: ${script}`);
  return { file: process.execPath, args: [script, ...argv.slice(1)], shim: selected, script };
}
const executableHashes = new Map();
function executableHash(p) {
  const s = fs.statSync(p), stamp = `${fs.realpathSync(p)}:${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}:${s.mode}`;
  const old = executableHashes.get(p);
  if (old?.stamp === stamp) return old.sha;
  const digest = fileSha(p);
  executableHashes.set(p, { stamp, sha: digest });
  return digest;
}
/** @id CODE-WINRUN-004 @implements REQ-WINRUN-004 */
function runnerEnv(cmd = [], cwd = '.') {
  const windows = process.platform === 'win32';
  const allowed = new Set([...RUNNER_ENV_ALLOWLIST, ...(windows ? WINDOWS_SDK_ENV : [])]);
  const blocked = /^(?:PYTEST_.*|PYTHONPATH|NPM_CONFIG_.*|NODE_OPTIONS|NODE_TEST_CONTEXT|GOFLAGS|RUSTFLAGS|RUSTDOCFLAGS|CARGO_.*(?:RUSTFLAGS|RUNNER)|JAVA_TOOL_OPTIONS|JDK_JAVA_OPTIONS|MAVEN_OPTS|GRADLE_OPTS|RUBYOPT|PERL5OPT)$|_(?:SELECTOR|FILTER|OPTIONS|FLAGS|OPTS|PLUGINS?)$/i;
  const inspect = (text) => {
    const patterns = [
      /\bprocess\.env\.([A-Za-z_]\w*)/g,
      /\b(?:process\.env|os\.environ|ENV)\s*\[\s*['"]([A-Za-z_]\w*)['"]\s*\]/g,
      /\b(?:os\.(?:Getenv|LookupEnv|getenv)|os\.environ\.get)\s*\(\s*['"]([A-Za-z_]\w*)['"]/g,
      /\$(?:\{([A-Za-z_]\w*)\}|([A-Za-z_]\w*))/g,
    ];
    for (const re of patterns) for (const m of text.matchAll(re)) {
      const name = m[1] ?? m[2];
      if (!blocked.test(name)) allowed.add(name.toUpperCase());
    }
  };
  // Literal application inputs are declared by the reviewed program; runner overrides remain blocked.
  for (const arg of cmd) inspect(String(arg));
  const base = path.resolve(ROOT, cwd);
  for (const f of listFiles()) if (path.resolve(ROOT, f).startsWith(base + path.sep)) {
    try { inspect(fs.readFileSync(path.join(ROOT, f), 'utf8')); } catch { /* unreadable application source */ }
  }
  const exe = cmd[0];
  if (exe) for (const p of /[/\\]/.test(exe) ? [path.resolve(base, exe)] : (process.env.PATH ?? '').split(path.delimiter).map((d) => path.join(d, exe))) {
    let fd;
    try {
      if (!(fs.statSync(p).mode & 0o111)) continue;
      fd = fs.openSync(p, 'r');
      const prefix = Buffer.alloc(2);
      fs.readSync(fd, prefix, 0, 2, 0);
      if (prefix.toString() === '#!') inspect(fs.readFileSync(p, 'utf8'));
      break;
    } catch { /* try the next executable location */ }
    finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  return { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.has(key.toUpperCase())
      && !(windows && WINDOWS_SDK_ENV.includes(key.toUpperCase())))),
    ...(windows ? Object.fromEntries(WINDOWS_SDK_ENV.flatMap((name) => {
      const value = runnerEnvValue(name);
      return value === undefined ? [] : [[name, value]];
    })) : {}),
    PYTHONSAFEPATH: '1', PYTHONNOUSERSITE: '1' };
}
function runnerEnvRecord(cmd = []) {
  const inherited = Object.keys(runnerEnv(cmd)).sort(), allowed = new Set(inherited.map((k) => k.toUpperCase()));
  return { allowlist: [...RUNNER_ENV_ALLOWLIST, ...(process.platform === 'win32' ? WINDOWS_SDK_ENV : [])],
    inherited, removed: Object.keys(process.env).filter((key) => !allowed.has(key.toUpperCase())).sort() };
}
function dotnetStamp(abs) {
  const r = spawnSync('git', ['ls-files', '-co', '--exclude-standard'], { cwd: abs, encoding: 'utf8', maxBuffer: 64e6 });
  if (r.status !== 0) return null;
  return dotnetOutputFilter(r.stdout.split('\n').filter((f) => f && !f.startsWith('.sdd/'))).map((f) => { try { const st = fs.statSync(path.join(abs, f)); return `${f}:${st.mtimeMs}:${st.size}`; } catch { return f; } }).join('|');
}
function run(cmd, timeoutMs, cwd = '.') {
  const isDotnetTest = cmd[0] === 'dotnet' && cmd[1] === 'test' && !cmd.some((a) => /^--no-(build|restore)$/.test(a));
  if (!isDotnetTest) return run1(cmd, timeoutMs, cwd);
  const abs = path.resolve(ROOT, cwd);
  const fi = cmd.indexOf('--filter');
  const key = abs + '\0' + (fi < 0 ? cmd : cmd.filter((_, i) => i !== fi && i !== fi + 1)).join('\0');
  const stamp = dotnetStamp(abs);
  const prev = dotnetBuilt.get(key);
  if (stamp && prev === stamp) {
    const r = run1([cmd[0], cmd[1], '--no-build', ...cmd.slice(2)], timeoutMs, cwd);
    if (r.exit === 0 || !/was not found|does not exist|NETSDK1004|assets file|not been built/i.test(r.text)) return r;
  }
  const r = run1(cmd, timeoutMs, cwd);
  if (stamp && !/\berror (CS|MSB|NETSDK|NU)\d+|Build FAILED|Restore failed/i.test(r.text) && !r.timedOut) dotnetBuilt.set(key, stamp); else dotnetBuilt.delete(key);
  return r;
}
function run1(cmd, timeoutMs, cwd = '.', maxBuffer = 64e6) {
  const t0 = Date.now();
  const pytest = pytestArgs(cmd);
  const safeCmd = pytest ? isolatedPytest(cmd, pytest, cwd) : cmd;
  // PHPUnit/Pest runaway tests can outlive a killed sdd (the group is detached, so nothing signals it): a watchdog in the group kills it once this process is gone (#237)
  const guarded = process.platform !== 'win32' && /phpunit|\bpest\b/.test(cmd.join(' '));
  const argv = guarded ? ['sh', '-c', 'G=$$; P=$1; shift; ( while kill -0 "$P" 2>/dev/null && kill -0 "$G" 2>/dev/null; do sleep 1; done; kill -0 "$P" 2>/dev/null || kill -s KILL -- "-$G" 2>/dev/null ) </dev/null >/dev/null 2>&1 & exec "$@"', 'sdd-watchdog', String(process.pid), ...safeCmd] : safeCmd;
  let launch;
  try { launch = runnerCommand(argv, path.resolve(ROOT, cwd)); }
  catch (error) { return { exit: 127, signal: null, text: `runner setup error: ${error.message}`, ms: Date.now() - t0, timedOut: false, pytestResults: null, error: error.message }; }
  const r = spawnSync(launch.file, launch.args, { cwd: path.resolve(ROOT, cwd), env: runnerEnv(cmd, cwd),
    shell: false, windowsVerbatimArguments: false, encoding: 'utf8', timeout: timeoutMs, maxBuffer, detached: true });
  const timedOut = r.error?.code === 'ETIMEDOUT';
  // spawnSync's timeout signals only the launcher (cargo, npm, mvn); the detached group also holds the hung test binary (#225)
  if ((timedOut || r.error?.code === 'ENOBUFS') && r.pid) { try { process.kill(-r.pid, 'SIGKILL'); } catch { /* group already gone */ } }
  const text = (r.stdout ?? '') + (r.stderr ?? '') + (timedOut ? `test timed out after ${timeoutMs} ms (hung test? the whole process group was killed)` : r.error ? String(r.error.message) : '');
  const pytestResults = pytest ? [...text.matchAll(/^SDD-PYTEST (\{[^\n]+\})$/gm)].flatMap((m) => { try { const r = JSON.parse(m[1]); return typeof r.nodeid === 'string' && /^(passed|failed|skipped)$/.test(r.outcome) ? [r] : []; } catch { return []; } }) : null;
  return { exit: r.status ?? (r.error ? 127 : 1), signal: r.signal, text, ms: Date.now() - t0, timedOut, pytestResults,
    error: r.error?.message ?? null };
}
function pytestArgs(cmd) {
  const exe = path.basename(cmd[0] ?? '');
  if (exe === 'pytest' || /^pytest-[\d.]+$/.test(exe)) return cmd.slice(1);
  const m = cmd.indexOf('-m');
  return /^python[\d.]*$/.test(exe) && m > 0 && cmd[m + 1] === 'pytest' ? cmd.slice(m + 2) : null;
}
function isolatedPytest(cmd, args, cwd) {
  let python = cmd[0];
  if (!/^python[\d.]*$/.test(path.basename(python))) {
    try {
      const first = fs.readFileSync(resolveExecutable(python, path.resolve(ROOT, cwd ?? '.')), 'utf8').split('\n')[0];
      python = /^#!\s*(\S*python[\d.]*)\s*$/.exec(first)?.[1] ?? 'python3';
    } catch { python = 'python3'; }
  }
  // -S prevents .pth and customization execution; add package directories without running site.main().
  // Import pytest before exposing the workspace, so a local pytest.py cannot replace the runner.
  const bootstrap = `import sys, os, sysconfig, site, json
prefix = os.path.dirname(os.path.dirname(sys.executable))
venv = [sysconfig.get_path(k, vars={"base": prefix, "platbase": prefix}) for k in ("purelib", "platlib")] if os.path.isfile(os.path.join(prefix, "pyvenv.cfg")) else []
for p in dict.fromkeys([*venv, sysconfig.get_path("purelib"), sysconfig.get_path("platlib"), site.getusersitepackages(), *site.getsitepackages()]):
    if p and p not in sys.path: sys.path.append(p)
import pytest
sys.path.insert(0, os.getcwd())
class Evidence:
    def pytest_runtest_logreport(self, report):
        if report.when == "call" or report.failed:
            print("\\nSDD-PYTEST " + json.dumps({"nodeid": report.nodeid, "outcome": report.outcome, "phase": report.when}), flush=True)
raise SystemExit(pytest.main(sys.argv[1:], plugins=[Evidence()]))
`;
  return [python, '-I', '-S', '-c', bootstrap, ...args];
}
// Scope placeholders for changedCmd. An empty result means "cannot scope" and the caller falls back to the full check.
function cmdOut(cmd, cwd) {
  const launch = runnerCommand(cmd, cwd);
  const r = spawnSync(launch.file, launch.args, { cwd, env: runnerEnv(cmd, cwd), shell: false,
    windowsVerbatimArguments: false, encoding: 'utf8', timeout: 60000, maxBuffer: 64e6 });
  return r.status === 0 ? r.stdout : null;
}
function nearestDir(abs, rel, marker) {
  let d = path.posix.dirname(rel);
  for (;;) {
    if (marker(path.join(abs, d))) return d;
    if (d === '.' || d === '') return null;
    d = path.posix.dirname(d);
  }
}
// changed Maven modules + their dependents + every upstream module those need: `-am -amd` alone leaves a dependent's other upstream modules outside the reactor (diamond), so they cannot be resolved without `install` (#133)
function mavenClosure(abs, base) {
  const r = spawnSync('git', ['ls-files', '-co', '--exclude-standard', '*pom.xml'], { cwd: abs, encoding: 'utf8' });
  if (r.status !== 0) return null;
  const mods = [];
  for (const p of r.stdout.split('\n').filter((x) => /(^|\/)pom\.xml$/.test(x) && !/(^|\/)(target|node_modules)\//.test(x))) {
    let xml; try { xml = fs.readFileSync(path.join(abs, p), 'utf8').replace(/<!--[\s\S]*?-->/g, ''); } catch { continue; }
    const parent = /<parent>[\s\S]*?<artifactId>([^<]+)<\/artifactId>/.exec(xml)?.[1];
    const noParent = xml.replace(/<parent>[\s\S]*?<\/parent>/, '');
    const self = /<artifactId>([^<]+)<\/artifactId>/.exec(noParent.replace(/<(dependencies|build|dependencyManagement|profiles|reporting|plugins)>[\s\S]*?<\/\1>/g, ''))?.[1];
    if (!self) continue;
    mods.push({ dir: path.posix.dirname(p), self, deps: new Set([...(parent ? [parent] : []), ...[...noParent.matchAll(/<dependency>[\s\S]*?<artifactId>([^<]+)<\/artifactId>/g)].map((m) => m[1])]) });
  }
  const byDir = new Map(mods.map((m) => [m.dir, m]));
  if (!base.every((d) => byDir.has(d))) return null;
  const grow = (start, next) => { const seen = new Set(start); const q = [...start]; while (q.length) for (const n of next(q.shift())) if (!seen.has(n)) { seen.add(n); q.push(n); } return seen; };
  const dependents = grow(base.map((d) => byDir.get(d).self), (n) => mods.filter((m) => m.deps.has(n)).map((m) => m.self));
  const all = grow([...dependents], (n) => [...(mods.find((m) => m.self === n)?.deps ?? [])].filter((x) => mods.some((m) => m.self === x)));
  return mods.filter((m) => all.has(m.self) && m.dir !== '.').map((m) => m.dir).sort();
}
// .NET project graph: ProjectReference edges (csproj + Directory.Build.props), solution (.sln/.slnx) membership, and which projects can run tests (#135)
function dotnetGraph(abs) {
  const files = workspaceFiles(abs);
  const read = (f) => { try { return fs.readFileSync(path.join(abs, f), 'utf8').replace(/<!--[\s\S]*?-->/g, ''); } catch { return ''; } };
  const norm = (f, p) => path.posix.normalize(path.posix.join(path.posix.dirname(f), p.replace(/\\/g, '/')));
  const refsOf = (f) => [...read(f).matchAll(/<ProjectReference\s[^>]*?\bInclude\s*=\s*"([^"]+)"/gi)].map((m) => norm(f, m[1]));
  const projs = new Map();
  for (const f of files.filter((x) => /\.(cs|fs|vb)proj$/.test(x))) projs.set(f, { file: f, dir: path.posix.dirname(f), refs: new Set(refsOf(f)), test: /Microsoft\.NET\.Test\.Sdk|<IsTestProject>\s*true/i.test(read(f)) });
  const under = (d, f) => d === '.' || f.startsWith(d + '/');
  const props = files.filter((x) => /(^|\/)Directory\.(Build|Packages)\.(props|targets)$/.test(x));
  for (const pf of props) for (const q of projs.values()) if (under(path.posix.dirname(pf), q.file)) refsOf(pf).forEach((x) => q.refs.add(x));
  for (const q of projs.values()) q.refs = new Set([...q.refs].filter((x) => projs.has(x) && x !== q.file));
  const sols = new Map();
  for (const f of files.filter((x) => /\.(sln|slnx)$/.test(x))) {
    const t = read(f);
    const m = f.endsWith('x') ? [...t.matchAll(/<Project\s[^>]*?\bPath\s*=\s*"([^"]+)"/g)].map((x) => x[1]) : [...t.matchAll(/^Project\([^)]*\)\s*=\s*"[^"]*",\s*"([^"]+)"/gm)].map((x) => x[1]);
    sols.set(f, new Set(m.map((x) => norm(f, x)).filter((x) => projs.has(x))));
  }
  const ownersOf = (f) => { for (let d = path.posix.dirname(f); ; d = path.posix.dirname(d)) { const o = [...projs.values()].filter((q) => q.dir === d); if (o.length) return o; if (d === '.' || d === '/') return []; } };
  const closure = (start, next) => { const seen = new Set(start); const q = [...start]; while (q.length) for (const n of next(q.shift())) if (!seen.has(n)) { seen.add(n); q.push(n); } return seen; };
  const deps = (file) => closure([file], (x) => projs.get(x)?.refs ?? []);
  const dependents = (starts) => closure(starts, (x) => [...projs.values()].filter((q) => q.refs.has(x)).map((q) => q.file));
  return { files, projs, props, sols, ownersOf, deps, dependents };
}
const DOTNET_GLOBAL = /(^|\/)(Directory\.(Build|Packages)\.(props|targets)|global\.json|nuget\.config)$|\.(sln|slnx)$/i;
const SCOPE_TOKENS = {
  // changed test projects + test projects that (transitively) reference a changed project; solution/shared build files cannot be scoped (#135)
  '{changedTestProjects}': (rel, abs) => {
    if (rel.some((f) => DOTNET_GLOBAL.test(f))) return [];
    const g = dotnetGraph(abs);
    if (!g) return [];
    const base = new Set();
    for (const f of rel) { if (g.projs.has(f)) base.add(f); else g.ownersOf(f).forEach((o) => base.add(o.file)); }
    if (!base.size) return [];
    return [...g.dependents([...base])].filter((x) => g.projs.get(x)?.test).sort();
  },
  '{changedModulesCsv}': (rel, abs) => {
    const base = [...new Set(rel.map((f) => nearestDir(abs, f, (d) => fs.existsSync(path.join(d, 'pom.xml')))).filter((d) => d && d !== '.'))];
    if (!base.length) return [];
    return (mavenClosure(abs, base) ?? base).join(',');
  },
  '{changedGoPkgs}': (rel, abs) => {
    // go.mod/go.sum edits widen the scope to everything — except in a repo without commits, where every file (go.mod included) is merely untracked (#133)
    const hasHead = spawnSync('git', ['rev-parse', '--verify', '-q', 'HEAD'], { cwd: abs }).status === 0;
    if (hasHead && rel.some((f) => /(^|\/)go\.(mod|sum|work)$/.test(f))) return [];
    const goFiles = rel.filter((f) => f.endsWith('.go'));
    if (!goFiles.length) return [];
    const out = cmdOut(['go', 'list', '-f', '{{.Dir}}|{{.ImportPath}}|{{join .Deps " "}}', './...'], abs);
    if (!out) return [];
    const pkgs = out.trim().split('\n').map((l) => { const [dir, imp, deps] = l.split('|'); return { dir, imp, deps: new Set((deps ?? '').split(' ')) }; });
    const dirs = new Set(goFiles.map((f) => path.resolve(abs, path.posix.dirname(f))));
    const changed = pkgs.filter((p) => dirs.has(path.resolve(p.dir)));
    if (!changed.length) return [];
    return pkgs.filter((p) => changed.some((c) => c.imp === p.imp || p.deps.has(c.imp))).map((p) => p.imp);
  },
  '{changedCargoPkgs}': (rel, abs) => {
    if (rel.some((f) => /(^|\/)Cargo\.(toml|lock)$/.test(f))) return [];
    const out = cmdOut(['cargo', 'metadata', '--no-deps', '--format-version', '1', '--offline'], abs);
    if (!out) return [];
    const pkgs = JSON.parse(out).packages.map((p) => ({ name: p.name, dir: path.dirname(p.manifest_path), deps: p.dependencies.map((d) => d.name) }));
    const hit = new Set();
    for (const f of rel) {
      const full = path.resolve(abs, f);
      const owner = pkgs.filter((p) => full.startsWith(p.dir + path.sep)).sort((a, b) => b.dir.length - a.dir.length)[0];
      if (!owner) return [];
      hit.add(owner.name);
    }
    for (let grew = true; grew;) { grew = false; for (const p of pkgs) if (!hit.has(p.name) && p.deps.some((d) => hit.has(d))) { hit.add(p.name); grew = true; } }
    return [...hit].flatMap((n) => ['-p', n]);
  },
  '{changedGradleTasks}': (rel, abs) => {
    if (rel.some((f) => !f.includes('/') && /^(settings|build)\.gradle(\.kts)?$|^gradle\.properties$/.test(f) || /(^|\/)libs\.versions\.toml$/.test(f))) return [];
    const isMod = (x) => fs.existsSync(path.join(x, 'build.gradle')) || fs.existsSync(path.join(x, 'build.gradle.kts'));
    const mods = new Map();
    const walk = (dir, relDir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!e.isDirectory() || /^(build|node_modules|\.git|\.gradle|\.sdd|out)$/.test(e.name)) continue;
        const r = relDir ? `${relDir}/${e.name}` : e.name;
        if (isMod(path.join(dir, e.name))) mods.set(r, new Set());
        walk(path.join(dir, e.name), r);
      }
    };
    walk(abs, '');
    // dependents are derived from project(':x') references; Gradle's own buildDependents misses them when the dependent is evaluated later
    for (const [m, deps] of mods) for (const f of ['build.gradle', 'build.gradle.kts']) {
      const fp = path.join(abs, m, f);
      if (fs.existsSync(fp)) for (const x of fs.readFileSync(fp, 'utf8').matchAll(/project\(\s*(?:path\s*[:=]\s*)?['"]:?([^'"]+)['"]/g)) deps.add(x[1].split(':').join('/'));
    }
    const hit = new Set();
    for (const f of rel) {
      const d = nearestDir(abs, f, isMod);
      if (!d || d === '.') return [];
      hit.add(d);
    }
    for (let grew = true; grew;) { grew = false; for (const [m, deps] of mods) if (!hit.has(m) && [...deps].some((d) => hit.has(d))) { hit.add(m); grew = true; } }
    return [...hit].flatMap((m) => { const t = ':' + m.split('/').join(':'); return [`${t}:cleanTest`, `${t}:test`]; });
  },
  '{changedCtestRegex}': (rel) => {
    const stems = rel.filter((f) => /(^|\/)(test_?[^/]*|[^/]*_?tests?)\.(c|cc|cpp|cxx)$/i.test(f)).flatMap((f) => { const b = path.posix.basename(f).replace(/\.[^.]+$/, ''); return [b, b.replace(/^test_?|_?tests?$/gi, '')]; }).filter(Boolean);
    // non-test source changes may affect any test: run them all
    if (rel.some((f) => /\.(c|cc|cpp|cxx|h|hh|hpp|hxx)$/i.test(f) && !/(^|\/)(test_?[^/]*|[^/]*_?tests?)\.(c|cc|cpp|cxx)$/i.test(f)) || rel.some((f) => /CMakeLists\.txt$|\.cmake$/.test(f))) return [];
    return stems.length ? [[...new Set(stems)].map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')] : [];
  },
};
const LOAD_ERR = /(cannot find (module|package)|modulenotfounderror|importerror|^\s*(?:e\s+|uncaught\s+)?(?:\w+\.)*syntaxerror\b(?:\s+\[ERR_[A-Z0-9_]+\])?\s*(?::|$)|^error: unexpected [^\n]* in "|error in parse\(|unable to load shared object|error in (?:dyn\.load|loadnamespace|library)\(|cannot resolve|no such file|undefined reference|could not compile|error\[e\d+\]|failed to resolve import|failed to load url|\[build failed\]|^[^\s:]+:\d+(?::\d+)?: (?:fatal )?error\b|cannot find symbol|ld returned \d+ exit status|\[setup failed\]|failed opening required|class \"[^\"]+\" not found|call to undefined (function|method)|php parse error|cannot redeclare|cannot declare class|could not find function|there is no package called|what went wrong:\s*\n(?!execution failed for task '[^']*test')|error (cs|msb|nu)\d+|error ts\d+|tserror|unable to compile typescript|transform failed with \d+ error|test suite failed to run|non-parseable pom|the build could not read|compilation failure|fatal error compiling|release version \d+ not supported|mojoexecutionexception|could not resolve dependencies|dependencies? .{0,80}could not be resolved|cannot open the connection|undefvarerror|loaderror: (systemerror|parseerror)|error collecting |interrupted: \d+ errors? during collection|^error: loaderror: (?!some tests did not pass)|^\*\* \((?:CompileError|SyntaxError|TokenMissingError|Mix)\)|is undefined \(module [\w.]+ is not available\)|^# [^\n]*\n[^\n]*:\d+:\d+: (undefined|cannot|missing))/im;
// a genuine runtime assertion/panic outranks an incidental LOAD_ERR substring such as "No such file" in the failure text (#252)
const RUNTIME_FAIL = /^thread '[^']*'(?: \(\d+\))? panicked at |^\s*assertion [`'"]?(?:left|[^\n]*)[`'"]? failed\b/m;
// classify by exception type: an AssertionError whose message embeds subprocess stderr is an assertion, not a load error (#282);
// ENOENT / FileNotFoundError on a declared, not-yet-created deliverable is a valid Red too
const ASSERT_EXC = /^\s*(?:E\s+)?(?:[\w.]+\.)?AssertionError\b/m;
function missingDeliverable(text) {
  if (!/ENOENT|FileNotFoundError|no such file/i.test(text)) return false;
  const norm = (x) => path.posix.normalize(String(x).replace(/\\/g, '/')).replace(/^\.\//, '');
  return [].concat((readJson(CONFIG, null) ?? {}).deliverables ?? []).map(norm).some((d) => d && text.replace(/\\/g, '/').includes(d) && !fs.existsSync(path.join(ROOT, d)));
}
// a compile error located in a generated `SDD-TODO(stub)` placeholder (design 3.2): never a Red, the type must be filled by hand
/** @id CODE-RSTUB-004 @implements REQ-RSTUB-004 */
const stubTodoHit = (text) => {
  for (const file of workspaceFiles().filter((f) => /\.(?:rs|py|[cm]?[jt]sx?)$/.test(f))) {
    let lines;
    try { lines = fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n'); } catch { continue; }
    const rust = file.endsWith('.rs'), esc = file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    for (let i = 0; i < lines.length; i++) {
      if (!/SDD-TODO\(stub\)/.test(lines[i])) continue;
      if (!rust) {
        const el = /^\s*(?:export\s+)?(?:(?:const|let|var)\s+)?([\w$]+)\s*(?::[^=]+)?=/.exec(lines[i])?.[1];
        if (el && new RegExp(`${esc}:${i + 1}(?!\\d)|${esc}\\(${i + 1},|${esc}", line ${i + 1}\\b`).test(text.replace(/\\/g, '/'))) return `error in the SDD-TODO(stub) element ${el} (${file}:${i + 1}): the stub could not infer its type/value, so this is not a Red — fill ${el} by hand, then re-run tdd red`;
        continue;
      }
      const el = /\b(?:const|static|fn|struct|enum)\s+(\w+)/.exec(lines[i])?.[1];
      if (el && (text.includes(`${file}:${i + 1}:`) || new RegExp(`error[^\\n]*\\b${el}\\b|-->[^\\n]*\\n[^]*?\\b${el}\\b`).test(text))) return `compile error in the SDD-TODO(stub) element ${el} (${file}:${i + 1}): the stub could not infer its type, so this is not a Red — fill the type of ${el} by hand, then re-run tdd red`;
    }
  }
  return null;
};
/** @id CODE-R36E-LOAD-001 @implements REQ-R36E-LOAD-001 */
const NATIVE_LOAD_ERR = /^\s*(?:Type|Range)?Error \[ERR_(?:UNKNOWN_(?:FILE_EXTENSION|MODULE_FORMAT)|UNSUPPORTED_(?:ESM_URL_SCHEME|DIR_IMPORT|RESOLVE_REQUEST|NODE_MODULES_TYPE_STRIPPING))\]:/m;
const isLoadErr = (text, assertion = ASSERT_EXC.test(text), nativeLoad = NATIVE_LOAD_ERR.test(text)) => (LOAD_ERR.test(text) || nativeLoad) && !RUNTIME_FAIL.test(text) && !assertion && !missingDeliverable(text);
// a repo without any commit has no baseline for `--changed` (#150)
function hasCommit() { return spawnSync('git', ['rev-parse', '--verify', '-q', 'HEAD'], { cwd: ROOT, stdio: 'ignore' }).status === 0; }

// fully-qualified names (`Ns\Cls`) of every class/interface/enum/trait the project declares (#150: namespace-aware, not by short name)
function phpProjectFqcns() {
  const set = new Set();
  for (const f of gitFiles('*.php').filter((x) => !/(^|\/)vendor\//.test(x))) {
    let t = '';
    try { t = fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch { continue; }
    const ns = /^\s*namespace\s+([\w\\]+)\s*[;{]/m.exec(t)?.[1];
    for (const m of t.matchAll(/^\s*(?:(?:final|abstract|readonly)\s+)*(?:class|interface|enum|trait)\s+(\w+)/gm)) set.add(ns ? `${ns}\\${m[1]}` : m[1]);
  }
  return set;
}
// a missing *relative* import that the test file itself references = declared new module
function declaredMissingModule(text, testPath) {
  const src = fs.readFileSync(path.join(ROOT, testPath), 'utf8');
  if (/\.py$/.test(testPath)) {
    const missing = /ModuleNotFoundError:\s*No module named ['"]([\w.]+)['"]/.exec(text)?.[1];
    if (!missing) return false;
    const imports = [...src.matchAll(/^\s*from\s+([\w.]+)\s+import\b|^\s*import\s+([^\n#]+)/gm)].flatMap((m) => m[1] ? [m[1]] : m[2].split(',').map((s) => s.trim().split(/\s+as\s+/)[0]));
    if (!imports.some((m) => m === missing || m.startsWith(missing + '.'))) return false;
    const base = path.resolve(ROOT, projectFor(testPath)?.root ?? '.');
    const dirs = [base, path.join(base, 'src'), path.dirname(path.join(ROOT, testPath))];
    return !dirs.some((d) => fs.existsSync(path.join(d, ...missing.split('.')) + '.py') || fs.existsSync(path.join(d, ...missing.split('.'), '__init__.py')));
  }
  // PHPUnit: `Class "Ns\\Cls" not found` for a class the test itself imports/uses and no project file declares yet (#117)
  const pm = /Class\s+"([\\\w]+)"\s+not found/.exec(text);
  if (pm && /\.php$/.test(testPath)) {
    const short = pm[1].split('\\').pop();
    const fq = pm[1].replace(/^\\/, '');
    const fqs = phpProjectFqcns();
    const declared = fq.includes('\\') ? fqs.has(fq) : [...fqs].some((x) => x === short || x.endsWith('\\' + short));
    return !declared && (src.includes(fq) || new RegExp(`\\b${short}\\b`).test(src));
  }
  const m = /(?:cannot find (?:module|package)|failed to resolve import|err_module_not_found)[^\n]*?['"`]((?:\.{1,2}\/|\/)[^'"`]+)['"`]/i.exec(text);
  if (!m) return false;
  const dir = path.resolve(ROOT, path.dirname(testPath));
  const abs = path.resolve(dir, m[1]);
  const spec = m[1].startsWith('.') ? m[1] : './' + path.relative(dir, abs).split(path.sep).join('/');
  const bare = spec.replace(/\.[cm]?[jt]sx?$/, '');
  return (src.includes(spec) || src.includes(bare)) && !fs.existsSync(abs);
}
// multi-module builds print a zero-test line for modules without a match; only all-zero counts
// Go: a package line with a duration but no `[no tests to run]`, or a `--- PASS/FAIL` line, means a test ran (#74)
/** @id CODE-NODE-SUMMARY-001 @implements REQ-NODE-SUMMARY-001 */
const RAN_TESTS = /tests run: [1-9]\d*,|(?:Passed|Failed)!\s+-\s+Failed:\s*\d+,\s*Passed:\s*\d+,\s*Skipped:\s*\d+,\s*Total:\s*[1-9]|^\s*--- (?:PASS|FAIL): |^(?:ok|FAIL)\s+\S+\s+(?:[\d.]+s|\(cached\))(?:(?!\[no tests)[^\n])*$|ran [1-9]\d* tests?\b|[1-9]\d* tests? (completed|successful|passed)|^ok \d+ |^[1-9]\d* (?:doc)?tests?, \d+ failures?|^(?:# |ℹ )(?:pass|fail) [1-9]\d*[ \t]*$/im;
// vitest/jest summary that lists no passed test (everything skipped by -t) means nothing ran (#62)
const NO_PASSED = /^\s*Tests:?\s+(?![^\n]*\d+ (?:passed|failed))[^\n]*\d+ (?:skipped|todo)|^(?:# |ℹ )pass 0\b[^\n]*\n(?:(?:# |ℹ )(?:fail|cancelled|skipped) 0\b[^\n]*\n)*(?:# |ℹ )(?:skipped|todo) [1-9]/im;
const ZERO_TESTS = /(no tests? (found|ran|collected)|(?:# |ℹ )tests 0\b|ran 0 tests|collected 0 items|0 tests? (ran|found|passed)\b|no test files found|no tests were found|no tests to run|tests run: 0,|no tests executed|no test matches|all tests have been excluded)/i;

function pytestNoExecution(text) {
  let skipped = 0, executed = 0;
  const plain = text.replace(/\x1b\[[0-9;]*m/g, '');
  // -qq hides the summary; progress still distinguishes skipped/xfail from executed tests.
  for (const m of plain.matchAll(/^\s*([.sxFEX]+)\s+\[\s*\d+%\]\s*$/gm)) {
    skipped += (m[1].match(/[sx]/g) ?? []).length;
    executed += (m[1].match(/[.FEX]/g) ?? []).length;
  }
  for (const m of plain.matchAll(/^\s*(?:=+\s*)?((?:\d+\s+(?:passed|failed|skipped|xfailed|xpassed|deselected|errors?|warnings?)(?:,\s*)?)+)\s+in\s+[\d.]+s\b[^\n]*$/gim)) {
    for (const count of m[1].matchAll(/(\d+)\s+(\w+)/g)) {
      if (/^(skipped|xfailed)$/i.test(count[2])) skipped += Number(count[1]);
      if (/^(passed|failed|xpassed|errors?)$/i.test(count[2])) executed += Number(count[1]);
    }
  }
  return skipped > 0 && executed === 0;
}

function nodeTestCommand(cmd, cwd = '.', seen = new Set()) {
  if (cmd.includes('--test') && cmd.some((a) => /^node(?:js|\.exe)?$/.test(path.basename(a)))) return true;
  if (cmd.some((a) => /(?:^|[\s;&|])(?:[^\s]*[/\\])?node(?:js|\.exe)?\s+[^;&|\n]*?--test(?:\s|$)/.test(a))) return true;
  const at = cmd.findIndex((a) => /^(?:npm|pnpm|yarn|bun)(?:\.cmd)?$/.test(path.basename(a)));
  if (at < 0) return false;
  const action = cmd[at + 1], name = /^(?:run|run-script)$/.test(action ?? '') ? cmd[at + 2] : action === 't' ? 'test' : action;
  const pkg = path.resolve(ROOT, cwd, 'package.json'), key = `${pkg}|${name}`;
  if (seen.has(key)) return false;
  seen.add(key);
  const script = readJson(pkg, null)?.scripts?.[name];
  return typeof script === 'string' && nodeTestCommand(script.trim().split(/\s+/), cwd, seen);
}
const nodeTestReport = (text) => /^\s*(?:ℹ |# )tests \d+\b/m.test(text);
const NODE_REGISTRATION = /(?:[$\w]+\s*\.\s*)*[$\w]+\s*\(\s*(["'`])((?:\\[\s\S]|(?!\1)[^\\])*)\1/;
function nodeLiteralTitle(registration) {
  if (!registration || (registration[1] === '`' && registration[2].includes('${'))) return null;
  try {
    return registration[2].replace(/\\(?:u\{([0-9a-f]+)\}|u([0-9a-f]{4})|x([0-9a-f]{2})|([\s\S]))/gi, (_, cp, unicode, byte, char) =>
      cp || unicode || byte ? String.fromCodePoint(parseInt(cp ?? unicode ?? byte, 16))
        : ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', 0: '\0', '\n': '' }[char] ?? char));
  } catch { return null; }
}
/** @id CODE-R34-NODE-001 @implements REQ-R34-NODE-001 REQ-R33-NODE-001 */
function nodeTestRan(text, id, testPath, passing = false) {
  const token = new RegExp(`${escapeRe(id)}(?![\\w-])`, 'i');
  // Bind the report to the literal registration following @id, never an ID-bearing parent.
  const body = testBody(testPath, id).join('\n').replace(/^(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\n]*)*/, '');
  const registration = new RegExp(`^(?:await\\s+)?${NODE_REGISTRATION.source}`).exec(body);
  const name = nodeLiteralTitle(registration);
  if (!name || !token.test(name) || name === path.basename(testPath) || path.resolve(ROOT, name) === path.resolve(ROOT, testPath)) return false;
  const source = fs.readFileSync(path.join(ROOT, testPath), 'utf8');
  const call = (r) => r[0].slice(0, r[0].indexOf('(')).replace(/^await\s+|\s+/g, '');
  if ([...source.matchAll(new RegExp(NODE_REGISTRATION.source, 'g'))].filter((r) =>
    (call(r) === call(registration) || /(?:^|\.)(?:test|it|describe)(?:\.(?:only|skip|todo))?$/.test(call(r)))
      && nodeLiteralTitle(r) === name).length !== 1) return false;
  const rows = text.split('\n').flatMap((line) => {
    const m = /^\s*([✔✖﹣]\s+|(?:not )?ok\s+\d+\s+-\s+)(.+)$/.exec(line);
    if (!m) return [];
    const title = m[2].replace(/\s+#\s*(TODO|SKIP)\b.*$/i, '').replace(/\s+\([\d.]+(?:ms|s|µs)\)$/, '').trim();
    return title === name ? [{ skipped: /^﹣/.test(m[1]) || /#\s*(TODO|SKIP)\b/i.test(m[2]), passed: /^(?:✔|ok)/.test(m[1]) }] : [];
  });
  // Duplicate titles with skipped outcomes are ambiguous, not substitute evidence.
  return rows.length > 0 && rows.every((r) => !r.skipped && (!passing || r.passed));
}

/** @id CODE-R36B-001 @implements REQ-R36B-LOAD-001 REQ-R36B-SYNTAX-001 REQ-R36B-ASSERT-001 */
function nodeFailureContext(text, id, testPath, cwd = '.') {
  const tap = /^TAP version 13$/m.test(text);
  const lines = text.split('\n'), rows = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)([✔✖﹣]\s+|(?:not )?ok\s+\d+\s+-\s+)(.+)$/.exec(lines[i]);
    if (!m) continue;
    rows.push({ i, indent: m[1], failed: /^(?:✖|not ok)/.test(m[2]),
      skipped: /^﹣/.test(m[2]) || /#\s*(TODO|SKIP)\b/i.test(m[3]),
      title: m[3].replace(/\s+#\s*(TODO|SKIP)\b.*$/i, '').replace(/\s+\([\d.]+(?:ms|s|µs)\)$/, '').trim() });
  }
  const ownsLocation = (s) => {
    const file = s.replace(/^['"]|['"]$/g, '').replace(/:\d+(?::\d+)?$/, '');
    return path.resolve(ROOT, cwd, file) === path.resolve(ROOT, testPath);
  };
  const tops = rows.filter((r) => !r.indent && r.title !== 'failing tests:');
  const fileFailed = !nodeTestRan(text, id, testPath) && tops.length > 0 && tops.every((r) =>
    r.failed && !r.skipped && (r.title === path.basename(testPath) || path.resolve(ROOT, cwd, r.title) === path.resolve(ROOT, testPath)));
  const body = testBody(testPath, id).join('\n').replace(/^(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\n]*)*/, '');
  const name = nodeLiteralTitle(new RegExp(`^(?:await\\s+)?${NODE_REGISTRATION.source}`).exec(body));
  let assertion = false, syntax = false, nativeLoad = false;
  if (nodeTestRan(text, id, testPath)) for (const row of rows.filter((r) => r.failed && !r.skipped && r.title === name)) {
    if (tap) {
      const indent = row.indent + '  ';
      if (lines[row.i + 1] !== indent + '---') continue;
      const end = lines.indexOf(indent + '...', row.i + 2);
      if (end < 0) continue;
      // Multiline message/stack values are deeper than diagnostic keys.
      const fields = new Map(lines.slice(row.i + 2, end).flatMap((line) => {
        const m = new RegExp(`^${indent}(location|name|code): (.+)$`).exec(line);
        return m ? [[m[1], m[2].replace(/^['"]|['"]$/g, '')]] : [];
      }));
      if (!ownsLocation(fields.get('location') ?? '')) continue;
      assertion ||= fields.get('name') === 'AssertionError' && fields.get('code') === 'ERR_ASSERTION';
      syntax ||= fields.get('name') === 'SyntaxError';
      nativeLoad ||= isLoadErr(`Error [${fields.get('code')}]:`, false);
    } else {
      const location = /^test at (.+)$/.exec(lines[row.i - 1] ?? '')?.[1];
      if (!location || !ownsLocation(location)) continue;
      assertion ||= /^\s+AssertionError\b/.test(lines[row.i + 1] ?? '');
      syntax ||= /^\s+SyntaxError\b/.test(lines[row.i + 1] ?? '');
      nativeLoad ||= isLoadErr(lines[row.i + 1] ?? '', false);
    }
  }
  // Node TAP prefixes process stderr with "# "; never strip arbitrary reporter output.
  const diagnosticText = (syntax ? 'SyntaxError: native owned exception\n' : '') + (tap ? text.replace(/^# ?/gm, '') : text);
  // A failed file exposes process stderr, not owned diagnostic fields; only its primary error header counts.
  if (fileFailed) nativeLoad = isLoadErr(/^(?:Type|Range)?Error(?: \[[^\]\n]+\])?:[^\n]*/m.exec(diagnosticText)?.[0] ?? '', false);
  return { fileFailed, loadError: isLoadErr(diagnosticText, assertion, nativeLoad) };
}

// ---------- commands ----------
function cmdInit() {
  const cfg = detectConfig();
  const rootManifests = fs.readdirSync(ROOT).filter((f) => MANIFESTS.test(f));
  const projects = detectProjects(new Set(rootManifests.map(ecoOf)));
  if (projects.length) { cfg.projects = projects; if (!rootManifests.length) cfg.checks = []; }
  const kept = fs.existsSync(CONFIG);
  if (!kept) writeJson(CONFIG, { ...cfg, scopePolicy: 'strict' });
  const shown = kept ? { ...cfg, ...readJson(CONFIG, {}) } : cfg;
  fs.mkdirSync(SPECS, { recursive: true });
  if (cfg.projects?.length) out(`${rootManifests.length ? 'root + ' : ''}projects: ${cfg.projects.map((p) => `${p.root} (${p.testCmd.slice(0, 2).join(' ')})`).join(', ')} — each test runs in its project directory`);
  else if (cfg.testCmd[0] === 'node' && !fs.existsSync(path.join(ROOT, 'package.json'))) out('WARNING: stack not recognised (no package.json/pytest.ini/pyproject.toml/requirements.txt/conftest.py/tests/test_*.py/go.mod/Cargo.toml/pom.xml/gradle/CMakeLists.txt; to use pytest add one of those and re-run init after deleting .sdd/config.json) — testCmd is a Node fallback. Set testCmd in .sdd/config.json to a runner that filters by test name, e.g. ["sh","run_tests.sh","{idu}"] (see SKILL.md "Other stacks").');
  out(`init ok: ${rel(CONFIG)}${kept ? ' (existing config kept — delete it to re-detect)' : ''} (testCmd: ${cfg.projects?.length && !rootManifests.length ? 'per project' : (shown.testCmd ?? []).join(' ')}; checks: ${(shown.checks ?? []).map((c) => c.name).join(',') || (cfg.projects?.length ? 'per project' : 'none')})`);
  out('next: write .sdd/specs/<feature>.md (see references/spec-template.md)');
}

// Review file schema: header lines `spec: sha256:<hash>`, `verdict: pass`, `open: <n>`; findings carry an explicit status.
// unresolved statuses (#138): anything but Closed/Resolved/Fixed counts as open
const OPEN_WORD = '(?:open|pending|reopened|re-opened|unresolved|todo|wip|in[ -]progress|blocked)';
const isOpenLine = (l) => /^\s*[-*]\s*\[ \]/.test(l) || new RegExp(`\\b(state|status)\\s*[:=]\\s*\\**${OPEN_WORD}\\b`, 'i').test(l) || new RegExp(`\\*\\*${OPEN_WORD}\\*\\*`, 'i').test(l) || new RegExp(`^\\s*[-*]\\s+${OPEN_WORD}\\b`, 'i').test(l) || (l.includes('|') ? l.split('|').some((c) => new RegExp(`^\\s*\\**${OPEN_WORD}\\b`, 'i').test(c)) : new RegExp(`^\\s*${OPEN_WORD}\\s*$`, 'i').test(l));
function reviewProblems(text, specHash) {
  const probs = [];
  const lines = text.split('\n');
  const open = lines.filter(isOpenLine);
  const verdict = /^\s*verdict\s*[:=]\s*(\w+)/im.exec(text)?.[1]?.toLowerCase();
  const declared = /^\s*open\s*[:=]\s*(\d+)\s*$/im.exec(text)?.[1];
  if (!verdict) probs.push('missing `verdict: pass|fail` line');
  else if (verdict !== 'pass') probs.push(`verdict is "${verdict}", not pass`);
  if (declared === undefined) probs.push('missing `open: <n>` line');
  else if (Number(declared) !== open.length) probs.push(`open: ${declared} does not match ${open.length} Open finding line(s) found`);
  if (open.length) { probs.push(`${open.length} Open finding(s):`); open.slice(0, 5).forEach((l) => probs.push(`  ${l.trim()}`)); }
  const specLines = lines.filter((l) => /^\s*spec(?:\s*[:=]|\s+)/i.test(l));
  const cited = specLines.length === 1 ? /^\s*spec(?:\s*[:=]\s*|\s+)(?:sha256:)?([0-9a-f]{12,64})(?:…|\.\.\.)?\s*$/i.exec(specLines[0])?.[1]?.toLowerCase() : null;
  if (!cited || !specHash.startsWith(cited)) probs.push(`must reference the spec hash in one matching header (spec: sha256:${specHash.slice(0, 12)}…)`);
  return probs;
}
function cmdReview() {
  const [sub, a0] = pos.slice(1);
  // `review template <feature>` and `review template --feature <f>`; `review check <file> --feature <f>` or `review check <file> <feature>` (#246)
  const featArg = typeof flags.feature === 'string' ? flags.feature : null;
  const a = sub === 'template' ? (featArg ?? a0) : a0;
  if (sub === 'template') {
    const spec = loadSpecs().find((x) => x.feature === a);
    if (!a || !spec) { out(`${a ? `unknown feature "${a}"` : 'feature required'}: review template <feature> | --feature <feature> (known: ${loadSpecs().map((x) => x.feature).join(', ') || 'none'})`); return 2; }
    out(`<!-- save as .sdd/review-${spec.feature}.md (one file per feature; a shared review.md goes stale when the next feature changes it) -->\nspec: sha256:${spec ? fileSha(spec.path) : '<spec sha256>'}\nverdict: pending\nopen: 0\n\n## Findings\n| ID | Severity | Where | Status |\n|----|----------|-------|--------|\n(add one row per finding with Status Open or Closed, then set verdict: pass|fail)`);
    return 0;
  }
  if (sub === 'check') {
    // `review check <feature>` infers .sdd/review-<feature>.md
    const lone = pos[3] == null && !featArg && a && !fs.existsSync(path.resolve(ROOT, a)) && loadSpecs().some((x) => x.feature === a) ? a : null;
    const file = lone ? `.sdd/review-${lone}.md` : a;
    const cf = featArg ?? pos[3] ?? lone ?? (file && /^review-(.+)\.md$/.test(path.basename(file)) ? path.basename(file).replace(/^review-(.+)\.md$/, '$1') : null);
    if (!file || !cf) { out('usage: review check <file> --feature <feature> | review check <file> <feature> | review check <feature> (reads .sdd/review-<feature>.md)'); return 2; }
    const spec = loadSpecs().find((x) => x.feature === cf);
    if (!spec) { out(`unknown feature "${cf}" (known: ${loadSpecs().map((x) => x.feature).join(', ') || 'none'})`); return 2; }
    if (!fs.existsSync(path.resolve(ROOT, file)) || !fs.statSync(path.resolve(ROOT, file)).isFile()) { out(`review file not found: ${file}`); return 2; }
    const probs = reviewProblems(fs.readFileSync(path.resolve(ROOT, file), 'utf8'), fileSha(spec.path));
    out(probs.length ? `REVIEW INVALID: ${file}\n${probs.map((x) => '  ' + x).join('\n')}` : `REVIEW OK: ${file}`);
    return probs.length ? 1 : 0;
  }
  out('usage: review template <feature|--feature f> | review check <file> --feature <feature|feature>');
  return 2;
}
function isHumanApprover(by) {
  return !!by && !/^ai\s*:/i.test(by) && !/^(bot|agent|copilot|assistant|claude|gpt|human|user|ai|me|test)$/i.test(by);
}
function cmdApprove() {
  const sub = pos[1];
  const specs = loadSpecs();
  const feature = pos[2];
  if (sub && !['prepare', 'record', 'retire'].includes(sub) && !feature && specs.some((s) => s.feature === sub)) { out(`unknown approve subcommand "${sub}" — "${sub}" is a feature. usage: approve prepare ${sub} | approve record ${sub} --by <name>`); return 2; }
  if (sub === 'retire' && /^REQ-/.test(feature ?? '')) {
    if (specs.some((s) => s.reqs.some((q) => q.id === feature))) { out(`REFUSED: ${feature} still exists in a spec; retire only applies to removed REQs`); return 1; }
    const by = typeof flags.by === 'string' ? flags.by.normalize('NFKC').replace(/[\u200b-\u200f\u2060\ufeff\u202a-\u202e\u2066-\u2069\u00ad]/g, '').trim() : '';
    if (!isHumanApprover(by)) { out('REFUSED: retiring a REQ needs a human approver: approve retire <REQ-ID> --by <human name>'); return 1; }
    writeJson(RETIRED_REQS, { ...readJson(RETIRED_REQS, {}), [feature]: { by, at: new Date().toISOString() } });
    out(`retired ${feature} by ${by}`);
    return 0;
  }
  if (sub === 'retire') {
    const all = readJson(APPROVALS, {});
    if (!all[feature]) { out(`no lock for "${feature ?? ''}"`); return 2; }
    if (specs.some((s) => s.feature === feature)) { out(`REFUSED: spec ${feature} still exists; retire only applies to removed specs`); return 1; }
    const by = typeof flags.by === 'string' ? flags.by.normalize('NFKC').replace(/[\u200b-\u200f\u2060\ufeff\u202a-\u202e\u2066-\u2069\u00ad]/g, '').trim() : '';
    if (!isHumanApprover(by)) { out('REFUSED: retiring a locked spec needs a human approver: approve retire <feature> --by <human name>'); return 1; }
    delete all[feature];
    writeJson(APPROVALS, all);
    out(`retired lock ${feature} by ${by}`);
    return 0;
  }
  const spec = specs.find((s) => s.feature === feature);
  if (!spec) { out(`unknown feature "${feature ?? ''}". known: ${specs.map((s) => s.feature).join(', ') || 'none'}`); return 2; }
  if (sub === 'prepare') {
    writeJson(PREPARE_SHOWN, { ...readJson(PREPARE_SHOWN, {}), [spec.feature]: artifactSha(spec.path) });
    out(`feature ${spec.feature} (${spec.tier}) — state: ${needsLock(spec) ? approvalState(spec) : 'no approval lock for T1 (the tests are the guard)'}`);
    for (const p of spec.artifacts) out(`  ${p}  sha256:${fileSha(p)}`);
    out(`requirements: ${spec.reqs.map((r) => r.id).join(', ')}`);
    if (!needsLock(spec)) return 0;
    out(spec.approval === 'human'
      ? 'approval: human — show these exact paths/hashes/residual risks to the human, then: approve record <feature> --by <name>'
      : 'approval: auto — after independent AI review passes: approve record <feature> --by ai:<reviewer> --review <.sdd/review.md|summary> (no human needed; review file must have 0 Open findings and cite the spec sha256 prefix)');
    return 0;
  }
  if (sub === 'record') {
    if (typeof flags.by !== 'string') { out('--by <name> required (ai:<reviewer> for auto specs, human name for approval: human)'); return 2; }
    flags.by = flags.by.normalize('NFKC').replace(/[\u200b-\u200f\u2060\ufeff\u202a-\u202e\u2066-\u2069\u00ad]/g, '').trim().replace(/^ai\s*:\s*/i, (m) => m.replace(/\s/g, ''));
    if (!flags.by || /^ai$/i.test(flags.by)) { out('REFUSED: --by needs a non-empty approver name (ai:<reviewer> for AI, a human name otherwise)'); return 2; }
    const isAi = /^ai:/i.test(flags.by);
    const drift = lockDrift(spec);
    if (drift && isAi) { out(`REFUSED: ${spec.feature} was locked under a stricter policy (${drift}); loosening it needs a human approver`); return 1; }
    if (spec.approval === 'human' && isAi) { out(`REFUSED: ${spec.feature} requires a human approver (approval: human)`); return 1; }
    const dp = designProblem(spec);
    if (dp) { out(`REFUSED: ${dp}`); return 1; }
    const review = typeof flags.review === 'string' ? flags.review.trim() : '';
    if (isAi && (/^ai:\s*(self)?$/i.test(flags.by) || !review)) { out(`REFUSED: ai approver needs a named reviewer (not ai:self) and --review <path-or-summary>, e.g. approve record ${spec.feature} --by ai:<reviewer> --review .sdd/review-${spec.feature}.md (template: review template ${spec.feature})`); return 1; }
    if (flags.review !== undefined && !review) { out('REFUSED: --review needs a non-empty <path-or-summary> (omit the flag to record no review)'); return 1; }
    const reviewPath = path.resolve(ROOT, review);
    const reviewIsFile = !!review && fs.existsSync(reviewPath) && fs.statSync(reviewPath).isFile();
    if (!isAi && !reviewIsFile && review && (path.isAbsolute(review) || /^\.{1,2}[/\\]/.test(review) || /[/\\].*\.(?:md|markdown|txt)$/i.test(review) || /^[^\s]+\.(md|markdown|txt)$/i.test(review))) { out(`REFUSED: --review ${review} looks like a file path but does not exist`); return 1; }
    if (isAi && !reviewIsFile && (path.isAbsolute(review) || /^\.{1,2}[/\\]/.test(review) || /[/\\].*\.(?:md|markdown|txt)$/i.test(review) || /^[^\s]+\.(md|markdown|txt)$/i.test(review))) { out(`REFUSED: --review ${review} looks like a file path but does not exist (a free-text summary must contain spaces)`); return 1; }
    if (isAi && !reviewIsFile && loadConfig().requireReviewFile) { out('REFUSED: config requireReviewFile — --review must be a file (e.g. .sdd/review.md)'); return 1; }
    if (isAi && reviewIsFile) {
      const probs = reviewProblems(fs.readFileSync(reviewPath, 'utf8'), fileSha(spec.path));
      if (probs.length) { out(`REFUSED: ${review} is not an acceptable review file`); probs.slice(0, 6).forEach((x) => out(`  ${x}`)); out('  see: review template <feature>'); return 1; }
    }
    if (spec.approval === 'human') {
      if (!isHumanApprover(flags.by)) { out(`REFUSED: "${flags.by}" is not a person's name; approval: human needs the approving human's own name`); return 1; }
      const prep = readJson(PREPARE_SHOWN, {})[spec.feature];
      if (prep !== artifactSha(spec.path)) { out(`REFUSED: no matching \`approve prepare ${spec.feature}\` for the current spec — run it, show the human the exact paths/hashes, then record (after any spec/design edit, prepare again)`); return 1; }
    }
    const recorded = withLedgerLock(() => {
      const problem = verifyChain(readLedger()) || ledgerRegression();
      if (problem) { out(`REFUSED: approval provenance ledger: ${problem}`); return false; }
      const all = readJson(APPROVALS, {});
      all[spec.feature] = { by: flags.by, kind: isAi ? 'ai' : 'human', review: review || undefined, reviewSha: reviewIsFile ? fileSha(review) : undefined, at: new Date().toISOString(), artifacts: Object.fromEntries(spec.artifacts.map((p) => [p, artifactSha(p)])), tier: spec.tier, requireHuman: spec.approval === 'human', code: spec.approval === 'human' ? implFileShas(spec) : undefined };
      appendLedgerLocked({ type: 'approval', feature: spec.feature, approvalSha: approvalSha(all[spec.feature]) });
      writeJson(APPROVALS, all);
      return true;
    });
    if (!recorded) return 1;
    out(needsLock(spec) ? `locked ${spec.feature} by ${flags.by}: ${spec.artifacts.join(', ')}` : `recorded ${spec.feature} by ${flags.by}: ${spec.artifacts.join(', ')} — note: ${spec.tier} specs without approval: human are NOT lock-enforced (only T2 / approval: human are verified by gate)`);
    return 0;
  }
  out('usage: approve prepare|record <feature> [--by name]');
  return 2;
}

// files carrying @implements for a spec's REQs: for human-approved features their later edits are surfaced (#88)
function featureGreen(spec) {
  const entries = readLedger();
  const { ents } = scanEntities(listFiles());
  return spec.reqs.filter((q) => !q.deferred && !q.testOnly).every((q) => [...ents.values()].some((e) => e.kind === 'TEST' && e.refs.verifies.includes(q.id) && entries.some((x) => x.test === e.id && x.type === 'green')));
}

// Per-@implements-block hash (#287): the annotated function/block region (brace- or indent-delimited); whole-file hash when it cannot be delimited.
function implRegionSha(c) {
  let txt;
  try { txt = fs.readFileSync(path.join(ROOT, c.path), 'utf8'); } catch { return null; }
  const ls = txt.replace(/\r\n/g, '\n').split('\n');
  let i = c.line - 1;
  while (i < ls.length && COMMENT_LEAD.test(ls[i])) i++;
  const whole = 'f:' + sha(txt);
  if (i >= ls.length || !ls[i].trim()) return whole;
  let end = -1;
  if (/\.(?:py|rb)$/.test(c.path)) {
    const ind = (l) => /^\s*/.exec(l)[0].length, base = ind(ls[i]);
    end = i + 1;
    for (let j = i + 1; j < ls.length; j++) { if (!ls[j].trim()) continue; if (ind(ls[j]) <= base && !/^\s*(?:end\b|[)\]}])/.test(ls[j])) break; end = j + 1; }
  } else {
    let depth = 0, opened = false;
    for (let j = i; j < ls.length && end < 0; j++) {
      for (const ch of ls[j].replace(/\/\/.*$|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '')) {
        if (ch === '{') { depth++; opened = true; } else if (ch === '}') depth--;
        if (opened && depth <= 0) { end = j + 1; break; }
      }
      if (!opened && j - i > 2) break;
    }
  }
  if (end <= i) return whole;
  let body = ls.slice(c.line - 1, end);
  // symbol granularity: Rust `impl .. X` blocks of the annotated type are its behaviour too
  const tn = symbolMode() && /\.rs$/.test(c.path) ? /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum)\s+(\w+)/.exec(ls[i])?.[1] : null;
  if (tn) {
    const hdr = new RegExp(`^\\s*impl\\b[^{]*\\b${tn}\\b\\s*(?:<[^{]*>)?\\s*(?:where\\b[^{]*)?\\{`);
    for (let j = end; j < ls.length; j++) {
      if (!hdr.test(ls[j]) || /^\s*impl\b[^{]*\bfor\b/.test(ls[j]) && !new RegExp(`\\bfor\\s+(?:&\\s*)?${tn}\\b`).test(ls[j])) continue;
      let d = 0, k = j;
      for (; k < ls.length; k++) { for (const ch of ls[k].replace(/\/\/.*$|"(?:\\.|[^"\\])*"/g, '')) d += ch === '{' ? 1 : ch === '}' ? -1 : 0; if (d <= 0) break; }
      body = body.concat(ls.slice(j, k + 1));
      j = k;
    }
  }
  const nested = /@id\s+CODE-/;
  // nested annotations inside the block are comment-only lines, not outer behaviour (#309); unchanged hash when there are none
  return 'b:' + sha((body.some((l, k) => k >= i - c.line + 1 && nested.test(l) && COMMENT_LEAD.test(l)) ? body.filter((l, k) => k < i - c.line + 1 || !(nested.test(l) && COMMENT_LEAD.test(l))) : body).join('\n'));
}

function implFileShas(spec) {
  const ids = new Set(spec.reqs.map((r) => r.id));
  const { ents } = scanEntities(listFiles());
  const files = new Set([...ents.values()].filter((e) => e.kind === 'CODE' && e.refs.implements.some((r) => ids.has(r))).map((e) => e.path));
  return Object.fromEntries([...files].sort().map((f) => [f, fileSha(f)]));
}

function cmdGuard() {
  const specs = loadSpecs().filter((s) => !pos[1] || s.feature === pos[1]);
  if (!specs.length) { out('GUARD FAIL: no spec found in .sdd/specs'); return 1; }
  let bad = 0;
  for (const s of specs) {
    const st = needsLock(s) ? approvalState(s) : 'n/a';
    const dp = designProblem(s);
    if (dp) { out(`GUARD FAIL ${s.feature} (T2): ${dp}`); bad++; }
    if (st !== 'ok' && st !== 'n/a') { out(`GUARD FAIL ${s.feature} (T2): approval ${st}`); bad++; }
  }
  const { ents, dups } = scanEntities(listFiles());
  const orphans = traceCheck(ents, dups, loadSpecs()).errors.filter((e) => /references unknown REQ-/.test(e));
  for (const o of orphans.slice(0, 10)) { out(`GUARD FAIL: ${o}`); bad++; }
  if (!bad) out(`GUARD OK (${specs.length} spec${specs.length > 1 ? 's' : ''})`);
  return bad ? 1 : 0;
}

// ---- typed languages: infer arity, arg and return types from the call sites in the test
const LIT = '("(?:[^"\\\\]|\\\\.)*"|-?\\d+\\.\\d+|-?\\d+|true|false)';
const litType = (t) => /^-?\d+[lL]$/.test(t) ? 'long' : /^-?\d+$/.test(t) ? 'int' : /^-?\d+\.\d+$/.test(t) ? 'float' : /^"/.test(t) ? 'str' : /^(true|false)$/.test(t) ? 'bool' : /^&/.test(t) ? 'ptr' : null;
function callInfo(src, name) {
  const re = new RegExp(`(?<![\\w.])${name}\\s*(?:::\\s*<[^;(){}]*?>)?\\s*\\(`, 'g');
  const m = re.exec(src);
  if (!m) return { args: [], ret: null, multi: false };
  let i = re.lastIndex, depth = 1, cur = '';
  const args = [];
  for (; i < src.length && depth; i++) {
    const c = src[i];
    // string / char literals are opaque: `"a, b"` is one argument (#149)
    if (c === '"' || (c === "'" && /^'(?:\\.|[^'\\])'/.test(src.slice(i, i + 4)))) {
      let j = i + 1;
      while (j < src.length && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
      if (src[j] === c) { cur += src.slice(i, j + 1); i = j; continue; }
    }
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) { depth--; if (!depth) break; }
    if (c === ',' && depth === 1) { args.push(cur.trim()); cur = ''; } else cur += c;
  }
  if (cur.trim()) args.push(cur.trim());
  const after = src.slice(i + 1, i + 80), before = src.slice(Math.max(0, m.index - 60), m.index);
  const lit = new RegExp(`^\\s*(?:==|!=|,)\\s*${LIT}`).exec(after)?.[1] ?? new RegExp(`${LIT}\\s*(?:==|!=|,)\\s*$`).exec(before)?.[1];
  // `== Some((0, 0))` => Option<(i64, i64)> (#87)
  const some = new RegExp(`^\\s*(?:==|!=|,)\\s*Some\\(\\s*(?:\\(\\s*${LIT}(?:\\s*,\\s*${LIT})+\\s*\\)|${LIT})\\s*\\)`).exec(after) ?? (/^\s*(?:==|!=|,)\s*None\b/.test(after) ? ['None'] : null);
  const RT = { int: 'i64', float: 'f64', str: 'String', bool: 'bool' };
  const optInner = some && (/^\s*(?:==|!=|,)\s*Some\(\s*\(/.test(after) ? `(${[...some[0].slice(some[0].indexOf('(', some[0].indexOf('Some(') + 5)).matchAll(new RegExp(LIT, 'g'))].map((x) => RT[litType(x[1])] ?? 'i64').join(', ')})` : RT[litType(/Some\(\s*(\S+?)\s*\)/.exec(some[0])?.[1] ?? '0')] ?? 'i64');
  const ret = optInner ? `opt:${optInner}` : /^\s*\.(is_err|is_ok|unwrap_err|unwrap|expect|expect_err)\(/.test(after) || /^\s*(?:==|!=|,)\s*(?:Err|Ok)\(/.test(after) || /\b(?:Err|Ok)\(\s*$/.test(before) ? 'result' : lit ? litType(lit) : /\bassert!\(\s*!?\s*$/.test(before) && /^\s*(?:[,)])/.test(after) ? 'bool' : null;
  // `_, err := New().Record(..)`: the tuple belongs to the chained method, not to this call (#113)
  return { args: args.map(litType), raws: args, ret, multi: /,\s*\w+\s*:?=\s*$/.test(before) && !/^\s*\./.test(after), chained: /^\s*\./.test(after), argc: args.length };
}
/** @id CODE-R36I-001 @implements REQ-R36I-001 REQ-R36I-002 */
const probeOutcome = (cmd, args, cwd) => {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: 120000, env: { ...process.env, LC_ALL: 'C' } });
  return { text: (r.stdout ?? '') + (r.stderr ?? ''), status: r.status, signal: r.signal, error: r.error };
};
const probe = (cmd, args, cwd) => probeOutcome(cmd, args, cwd).text;

function stubGo(testPath, src, dir, add, made) {
  /** @id CODE-R36J-001 @implements REQ-R36J-001 REQ-R36J-002 */
  const goTest = () => {
    const r = probeOutcome('go', ['test', '-count=1', '-gcflags=-e', '-run', '^$', '.'], dir);
    return { ...r, text: r.text.replace(/\x1b\[[0-9;]*m/g, '') };
  };
  const pkg = /^package\s+(\w+)/m.exec(src)?.[1]?.replace(/_test$/, '') ?? 'main';
  const T = { int: 'int', float: 'float64', str: 'string', bool: 'bool' };
  const params = (c) => Array.from({ length: c.args.length }, (_, i) => `a${i}`).join(', ') + (c.args.length ? ' any' : '');
  // `a, ok, err := X(...)` fixes the number of results (#76)
  // functions whose first result must be a struct (field/method access on the result), and bare New() constructors (#84)
  const retTypes = new Map();
  const capPkg = pkg.charAt(0).toUpperCase() + pkg.slice(1);
  const first = (c, name) => retTypes.get(name) ?? T[c.ret] ?? 'any';
  const retOf = (c, name) => {
    const lhs = name && new RegExp(`((?:[\\w.]+\\s*,\\s*)+[\\w.]+)\\s*:?=\\s*(?:[\\w.]+\\.)?${name}\\(`).exec(src)?.[1].split(',').map((x) => x.trim());
    if (lhs && c.multi) return `(${lhs.map((x, i) => (/^err\w*$/i.test(x) && i === lhs.length - 1 ? 'error' : i === 0 ? first(c, name) : /^(ok|found|has|exists)$/i.test(x) ? 'bool' : 'any')).join(', ')})`;
    if (name && !c.chained && new RegExp(`errors\\.(?:Is|As)\\(\\s*(?:[\\w.]+\\.)?${name}\\(|\\berr\\s*:?=\\s*(?:[\\w.]+\\.)?${name}\\(`).test(src)) return 'error';
    let r = first(c, name);
    // `x := f(..)` followed by len(x) / range x / x[i] needs a slice-like result (#113)
    const sv = name && new RegExp(`\\b(\\w+)\\s*:?=\\s*(?:[\\w.]+\\.)?${name}\\(`).exec(src)?.[1];
    if (r === 'any' && sv && new RegExp(`\\blen\\(\\s*${sv}\\s*\\)|\\brange\\s+${sv}\\b|\\b${sv}\\[`).test(src)) r = '[]any';
    return c.multi ? `(${r}, error)` : r;
  };
  // `cannot use pkg.F(..) (value of interface type any) as *pkg.T value`: the test fixes F's result type (#215)
  const typedResults = (out, strip, typeSet) => {
    let grew = false;
    for (const m of out.matchAll(/cannot use (?:[\w.]+\.)?(\w+)\(.*?\) \(value of (?:interface )?type any\) as (\S+) value/g)) {
      const t = strip(m[2]);
      if (retTypes.get(m[1]) === t || !/^[\w*\[\]]+$/.test(t)) continue;
      retTypes.set(m[1], t);
      for (const n of t.match(/\b[A-Z]\w*\b/g) ?? []) if (!typeSet.has(n)) typeSet.set(n, new Set());
      grew = true;
    }
    return grew;
  };
  // the compile errors cover the whole test file: whether a member is a method is decided from every test in it, not only the requested one (#215)
  const fullSrc = (() => { try { return fs.readFileSync(path.join(ROOT, testPath), 'utf8'); } catch { return src; } })();
  const calledAnywhere = (member) => new RegExp(`\\.${member}\\s*\\(`).test(fullSrc);
  const funcs = new Set();
  // constructors (`New`, `NewX`) return a zero value so setup never panics: the Red then comes from the behaviour under test (#129)
  const fbody = (f, r) => {
    const m = /^\(?\*(\w+)(, error)?\)?$/.exec(r);
    return /^New/.test(f) && m ? `return &${m[1]}{}${m[2] ? ', nil' : ''}` : `panic("not implemented: ${f}")`;
  };
  const errs = new Set();
  const consts = new Set();
  const types = new Map();
  const methods = new Map();
  const base = path.basename(testPath).replace(/_test\.go$/, '');
  let target = path.join(dir, base + '.go');
  for (let n = 1; fs.existsSync(target); n++) target = path.join(dir, `${base}_stub${n > 1 ? n : ''}.go`);
  const render = () => {
    const parts = [];
    for (const [t, fields] of types) parts.push(`type ${t} struct {\n${[...fields].filter((f) => !methods.get(t)?.has(f)).map((f) => `\t${f} any\n`).join('')}}\n`);
    for (const f of funcs) { const c = callInfo(src, f); const ctor = /^New([A-Z]\w*)$/.exec(f)?.[1]; const r = ctor ? (c.multi ? `(*${ctor}, error)` : `*${ctor}`) : retOf(c, f); parts.push(`func ${f}(${params(c)}) ${r} {\n\t${fbody(f, r)}\n}\n`); }
    for (const [t, ms] of methods) for (const m of ms) { const c = callInfo(src.replace(new RegExp(`\\b\\w+\\([^()]*\\)\\.${m}\\(`, 'g'), `${m}(`).replace(new RegExp(`[\\w.]+\\.${m}\\(`, 'g'), `${m}(`), m); parts.push(`func (*${t}) ${m}(${params(c)}) ${retOf(c, m)} {\n\tpanic("not implemented: ${t}.${m}")\n}\n`); }
    for (const e of errs) parts.unshift(`var ${e} = errors.New("${e}")\n`);
    for (const k of consts) parts.unshift(`const ${k} = 0\n`);
    return `package ${pkg}\n\n${errs.size ? 'import "errors"\n\n' : ''}${parts.join('\n')}`;
  };
  // external test package (`package x_test`): stub the qualified symbols of the imported project packages (#113)
  // when it imports project packages, the stub lives there: the in-package pass below must not render over it (#129)
  let extDone = false;
  if (/^package\s+\w+_test\b/m.test(src)) {
    let gr = dir;
    while (gr !== path.dirname(gr) && !fs.existsSync(path.join(gr, 'go.mod'))) gr = path.dirname(gr);
    const mod = fs.existsSync(path.join(gr, 'go.mod')) ? /^module\s+(\S+)/m.exec(fs.readFileSync(path.join(gr, 'go.mod'), 'utf8'))?.[1] : null;
    const exts = [];
    if (mod) for (const m of src.matchAll(/^\s*(?:import\s+)?(?:(\w+)\s+)?"([^"\n]+)"/gm)) {
      if (m[2] !== mod && !m[2].startsWith(mod + '/')) continue;
      const idir = path.join(gr, m[2].slice(mod.length).replace(/^\//, ''));
      const last = m[2].split('/').pop();
      const sources = fs.existsSync(idir) ? fs.readdirSync(idir).filter((f) => /\.go$/.test(f) && !/_test\.go$/.test(f)) : [];
      const hasGo = sources.length > 0;
      const packageName = sources.map((f) => /^\s*package\s+(\w+)/m.exec(fs.readFileSync(path.join(idir, f), 'utf8'))?.[1]).find(Boolean) ?? last;
      const alias = m[1] ?? packageName;
      let file = path.join(idir, hasGo ? `${last}_stub.go` : `${last}.go`);
      for (let n = 2; fs.existsSync(file); n++) file = path.join(idir, `${last}_stub${n}.go`);
      exts.push({ alias, idir, last, packageName, importPath: m[2], hasGo, file, funcs: new Set(), types: new Map(), consts: new Set(), errs: new Set(), methods: new Map() });
    }
    extDone = exts.length > 0;
    for (const e of exts) {
      const q = (x) => x.replace(new RegExp(`\\b${e.alias}\\.`, 'g'), '');
      const qualifier = `(?:${e.alias}|${e.packageName}|"${e.importPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}")`;
      const render = () => {
        const parts = [];
        for (const [t, fields] of e.types) parts.push(`type ${t} struct {\n${[...fields].filter((f) => !e.methods.get(t)?.has(f)).map((f) => `\t${f} any\n`).join('')}}\n`);
        for (const f of e.funcs) { const c = callInfo(q(src), f); const ctor = /^New([A-Z]\w*)$/.exec(f)?.[1]; const r = ctor ? (c.multi ? `(*${ctor}, error)` : `*${ctor}`) : retOf(c, f); parts.push(`func ${f}(${params(c)}) ${r} {\n\t${fbody(f, r)}\n}\n`); }
        for (const [t, ms] of e.methods) for (const m of ms) { const c = callInfo(q(src).replace(new RegExp(`\\b\\w+\\([^()]*\\)\\.${m}\\(`, 'g'), `${m}(`).replace(new RegExp(`[\\w.]+\\.${m}\\(`, 'g'), `${m}(`), m); parts.push(`func (*${t}) ${m}(${params(c)}) ${retOf(c, m)} {\n\tpanic("not implemented: ${t}.${m}")\n}\n`); }
        for (const x of e.errs) parts.unshift(`var ${x} = errors.New("${x}")\n`);
        for (const k of e.consts) parts.unshift(`const ${k} = 0\n`);
        return `package ${e.packageName}\n\n${e.errs.size ? 'import "errors"\n\n' : ''}${parts.join('\n')}`;
      };
      if (!e.hasGo) { fs.mkdirSync(e.idir, { recursive: true }); fs.writeFileSync(e.file, `package ${e.packageName}\n`); }
      for (let pass = 0; pass < 5; pass++) {
        const out = goTest().text;
        let grew = false;
        for (const m of out.matchAll(new RegExp(`undefined: ${e.alias}\\.(\\w+)`, 'g'))) {
          const n = m[1];
          if (!new RegExp(`\\b${e.alias}\\.${n}\\b`).test(src)) continue;
          const isCall = new RegExp(`${e.alias}\\.${n}\\s*\\(`).test(src);
          const isType = !isCall && /^[A-Z]/.test(n) && new RegExp(`${e.alias}\\.${n}\\s*\\{|[*\\]]${e.alias}\\.${n}\\b|\\bvar\\s+\\w+\\s+\\*?${e.alias}\\.${n}\\b`).test(src);
          if (/^Err[A-Z]/.test(n) && !isCall) { if (e.errs.has(n)) continue; e.errs.add(n); }
          else if (isCall) {
            if (e.funcs.has(n)) continue;
            e.funcs.add(n);
            const ct = /^New([A-Z]\w*)$/.exec(n)?.[1];
            if (ct && !e.types.has(ct)) e.types.set(ct, new Set());
            // the type the test names (`*pkg.Store`) wins over a package-derived one (#148)
            if (n === 'New') { const named = new RegExp(`\\*${e.alias}\\.([A-Z]\\w*)\\b`).exec(src)?.[1]; const bt = named ?? e.last.charAt(0).toUpperCase() + e.last.slice(1); retTypes.set(n, `*${bt}`); if (!e.types.has(bt)) e.types.set(bt, new Set()); }
          }
          else if (isType) { if (e.types.has(n)) continue; e.types.set(n, new Set()); }
          else { if (e.consts.has(n)) continue; e.consts.add(n); }
          grew = true;
        }
        for (const m of out.matchAll(new RegExp(`(\\S+)\\.(\\w+) undefined \\(type \\*?${qualifier}\\.(\\w+) has no field or method`, 'g'))) {
          const [, recv, member, t] = m;
          if (!new RegExp(`\\.${member}\\b`).test(src)) continue;
          if (new RegExp(`${recv.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.${member}\\s*\\(`).test(src) || calledAnywhere(member)) { if (!e.methods.has(t)) e.methods.set(t, new Set()); if (e.methods.get(t).has(member)) continue; e.methods.get(t).add(member); }
          else { if (!e.types.has(t) || e.types.get(t).has(member)) continue; e.types.get(t).add(member); }
          grew = true;
        }
        for (const m of out.matchAll(new RegExp(`unknown field (\\w+) in struct literal of type ${qualifier}\\.(\\w+)`, 'g'))) {
          if (e.types.has(m[2]) && !e.types.get(m[2]).has(m[1])) { e.types.get(m[2]).add(m[1]); grew = true; }
        }
        if (typedResults(out, (x) => x.replace(new RegExp(`\\b${e.alias}\\.`, 'g'), ''), e.types)) grew = true;
        if (!grew) break;
        fs.writeFileSync(e.file, render());
      }
      if (e.funcs.size || e.types.size || e.consts.size || e.errs.size || e.methods.size) made.push(rel(e.file));
      else if (!e.hasGo) fs.rmSync(e.file, { force: true });
    }
  }
  // each pass reveals the next layer: undefined names, then methods/fields of the types just created (#69)
  for (let pass = 0; pass < 6 && !extDone; pass++) {
    const out = goTest().text;
    let grew = false;
    for (const m of out.matchAll(/undefined: (\w+)/g)) {
      const n = m[1];
      if (!new RegExp(`\\b${n}\\b`).test(src)) continue;
      const isType = /^[A-Z]/.test(n) && (new RegExp(`\\b${n}\\s*\\{|[*\\]]${n}\\b|\\bvar\\s+\\w+\\s+${n}\\b|\\b\\w+\\s+\\*?${n}\\s*[,)]`).test(src)) && !new RegExp(`(?<![\\w.])${n}\\s*\\(`).test(src);
      const isCall = new RegExp(`(?<![\\w.])${n}\\s*\\(`).test(src);
      if (/^Err[A-Z]/.test(n) && !isCall) { if (errs.has(n)) continue; errs.add(n); grew = true; continue; }
      if (/^[A-Z]/.test(n) && !isType && !isCall && !/^New/.test(n)) { if (consts.has(n)) continue; consts.add(n); grew = true; continue; }
      if (isType ? types.has(n) : funcs.has(n)) continue;
      if (n === 'New' && isCall && !isType) {
        // a helper parameter `e *Engine` names the real type (#148)
        const named = [...src.matchAll(/[(,]\s*\w+\s+\*([A-Z]\w*)\b/g)].map((x) => x[1]).find((x) => !/^T$/.test(x)) ?? capPkg;
        funcs.add(n); retTypes.set(n, `*${named}`); if (!types.has(named)) types.set(named, new Set()); grew = true; continue;
      }
      if (isType) types.set(n, new Set()); else { funcs.add(n); const ct = /^New([A-Z]\w*)$/.exec(n)?.[1]; if (ct && !types.has(ct)) types.set(ct, new Set()); }
      grew = true;
    }
    for (const m of [...out.matchAll(/(\S+)\.(\w+) undefined \(type \*?(\w+) has no field or method \w+\)/g)].map((x) => Object.assign([x[0], x[2], x[3]], { recv: x[1] }))) {
      const [, member, t] = m;
      if (t === 'any' || !new RegExp(`\\.${member}\\b`).test(src)) continue;
      const isCall = new RegExp(`\\.${member}\\s*\\(`).test(src) && !(m.recv && !new RegExp(`${m.recv.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.${member}\\s*\\(`).test(src)) || calledAnywhere(member);
      if (isCall) { if (!methods.has(t)) methods.set(t, new Set()); if (methods.get(t).has(member)) continue; methods.get(t).add(member); }
      else { if (!types.has(t)) continue; if (types.get(t).has(member)) continue; types.get(t).add(member); }
      grew = true;
    }
    for (const m of out.matchAll(/(\w+)\.(\w+) undefined \(type any has no field or method \w+\)/g)) {
      const [, v, member] = m;
      const as = [...src.matchAll(/((?:\w+\s*,\s*)*\w+)\s*:?=\s*(?:[\w.]+\.)?(\w+)\(/g)].find((x) => x[1].split(',').map((y) => y.trim())[0] === v);
      // `for _, it := range items` with `items := F(..)`: F returns a slice of a struct (#296)
      const rg = !as && new RegExp(`\\bfor\\s+(?:\\w+\\s*,\\s*)?${v}\\s*:=\\s*range\\s+(\\w+)(?![\\w.(])`).exec(src)?.[1];
      const rc = !as && !rg && new RegExp(`\\bfor\\s+(?:\\w+\\s*,\\s*)?${v}\\s*:=\\s*range\\s+(?:[\\w.]+\\.)?(\\w+)\\(`).exec(src)?.[1];
      const src2 = rc ? [null, null, rc] : rg && [...src.matchAll(/((?:\w+\s*,\s*)*\w+)\s*:?=\s*(?:[\w.]+\.)?(\w+)\(/g)].find((x) => x[1].split(',').map((y) => y.trim())[0] === rg);
      if (src2 && (!retTypes.has(src2[2]) || retTypes.get(src2[2]) === '[]any')) {
        const en = `${src2[2]}Item`;
        retTypes.set(src2[2], `[]${en}`);
        types.set(en, new Set());
        grew = true;
        continue;
      }
      if (!as || retTypes.has(as[2])) continue;
      const tn = `${as[2]}Result`;
      retTypes.set(as[2], tn);
      types.set(tn, new Set());
      funcs.add(as[2]);
      grew = true;
    }
    for (const m of out.matchAll(/unknown field (\w+) in struct literal of type (\w+)/g)) {
      if (types.has(m[2]) && !types.get(m[2]).has(m[1])) { types.get(m[2]).add(m[1]); grew = true; }
    }
    if (typedResults(out, (x) => x, types)) grew = true;
    for (const m of out.matchAll(/cannot range over (?:[\w.]+\.)?(\w+)\(.*?\) \(value of (?:interface )?type any\)/g)) {
      if (retTypes.has(m[1])) continue;
      retTypes.set(m[1], '[]any');
      grew = true;
    }
    // an `any` result the test uses arithmetically / passes to a typed parameter takes that scalar type (#296)
    const SCALAR = { int: 'int', float: 'float64', string: 'string', rune: 'rune', bool: 'bool' };
    for (const m of out.matchAll(/invalid operation: (\w+) [^\s]+ [^\n]*?\(mismatched types any and (?:untyped )?(\w+)\)|cannot use (\w+) \(variable of (?:interface )?type any\) as (int|float64|string|bool) value/g)) {
      const v = m[1] ?? m[3], t = m[1] ? SCALAR[m[2]] : m[4];
      const as = t && [...src.matchAll(/((?:\w+\s*,\s*)*\w+)\s*:?=\s*(?:[\w.]+\.)?(\w+)\(/g)].find((x) => x[1].split(',').map((y) => y.trim())[0] === v);
      if (!as || retTypes.has(as[2])) continue;
      retTypes.set(as[2], t);
      grew = true;
    }
    if (!grew) break;
    fs.writeFileSync(target, render());
  }
  if (!extDone && fs.existsSync(target)) made.push(rel(target));
  // compile-check what was written: an honest verdict instead of an assumed "Red-safe" (#129)
  /** @id CODE-R36J-002 @implements REQ-R36J-001 REQ-R36J-002 */
  const after = goTest();
  const err = /^(?:vet: )?\S+\.go:\d+:\d+: .*$/m.exec(after.text);
  if (after.status === 0 && !after.signal && !after.error && !err) return Object.assign([...new Set(made)], { verified: 'ok' });
  const reason = after.error ? `Go compile check failed with error ${after.error.code ?? after.error.message}`
    : after.signal ? `Go compile check terminated by signal ${after.signal}`
      : after.status == null ? 'Go compile check failed: status unavailable'
        : after.status !== 0 ? `Go compile check failed with exit status ${after.status}`
          : null;
  return Object.assign([...new Set(made)], {
    verified: 'fail',
    verifyError: (reason ? `${reason}${err ? `; ${err[0]}` : ''}` : err[0]).slice(0, 160),
  });
}

function stubRust(testPath, src, dir, made) {
  const root = (() => { let d = dir; while (d !== path.dirname(d)) { if (fs.existsSync(path.join(d, 'Cargo.toml'))) return d; d = path.dirname(d); } return null; })();
  if (root && !/(^|\/)tests\//.test(testPath) && /#\[cfg\(test\)\]/.test(src)) made.notes = ['this test is inline in the subject file (#[cfg(test)]): it can only use items of its own crate, so there is nothing to generate — write the code under test by hand'];
  if (!root || !/(^|\/)tests\//.test(testPath)) return made;
  /** @id CODE-R36G-001 @implements REQ-R36G-001 REQ-R36G-002 */
  const cargoTest = () => {
    const r = probeOutcome('cargo', ['test', '--no-run', '--offline', '--test', path.basename(testPath, '.rs')], root);
    // Cargo can color piped diagnostics; every Rust consumer needs the same plain text.
    return { ...r, text: r.text.replace(/\x1b\[[0-9;]*m/g, '') };
  };
  const ownLib = path.join(root, 'src/lib.rs');
  const probeFile = !fs.existsSync(ownLib);
  if (probeFile) { fs.mkdirSync(path.dirname(ownLib), { recursive: true }); fs.writeFileSync(ownLib, ''); }
  const T = { int: 'i64', float: 'f64', str: 'String', bool: 'bool', result: 'Result<i64, String>' };
  const unknownMarker = ' // SDD-TODO(stub): type unknown — write the real type by hand';
  // `use k::m::{Real as Alias}`: the body is analysed under the real name (#268)
  const aliases = new Map([...src.matchAll(/^\s*use\s[^;]*;/gm)].flatMap((u) => [...u[0].matchAll(/\b(\w+)\s+as\s+(\w+)/g)].filter((a) => a[1] !== 'self' && a[2] !== '_').map((a) => [a[2], a[1]])));
  if (aliases.size) src = src.replace(new RegExp(`^\\s*use\\s[^;]*;|\\b(${[...aliases.keys()].join('|')})\\b`, 'gm'), (m, a) => a ? aliases.get(a) : m);
  // `let v = f(..); assert_eq!(v, "lit")`: the literal compared through the bound variable types the return (#268)
  const viaVar = (callPat) => { const lv = new RegExp(`\\blet\\s+(?:mut\\s+)?(\\w+)\\s*(?::[^=]+)?=\\s*&?${callPat}\\s*\\(`).exec(src)?.[1]; if (!lv) return null; const lit = new RegExp(`assert(?:_eq|_ne)?!\\(\\s*${lv}\\s*,\\s*${LIT}\\s*[,)]|assert(?:_eq|_ne)?!\\(\\s*${LIT}\\s*,\\s*${lv}\\s*[,)]|\\b${lv}\\s*==\\s*${LIT}`).exec(src); const l = lit && (lit[1] ?? lit[2] ?? lit[3]); return l ? litType(l) : null; };
  // #288: usage-driven helpers (all scoped to the requested test's source)
  const takeExpr = (s) => { let d = 0, i = 0; for (; i < s.length; i++) { const c = s[i]; if (c === '"') { i++; while (i < s.length && s[i] !== '"') i += s[i] === '\\' ? 2 : 1; } else if ('([{'.includes(c)) d++; else if (')]}'.includes(c)) { if (!d) break; d--; } else if ((c === ',' || c === ';') && !d) break; } return s.slice(0, i).trim(); };
  const tyRef = (n, crate_) => { const e = typePath.get(n); return e ? `${e.crate === crate_ ? 'crate' : e.crate}${e.mods}::${n}` : null; };
  // index of the bracket closing the one at `at` (strings are opaque), -1 when unbalanced
  const matchEnd = (s, at) => { const ms = maskBraces(s, true); let d = 0; for (let i = at; i < ms.length; i++) { if ('([{'.includes(ms[i])) d++; else if (')]}'.includes(ms[i]) && !--d) return i; } return -1; };
  // top-level comma split of `a, (b, c), "d,e"`
  const splitTop = (s) => { const ms = maskBraces(s, true), out = []; let d = 0, cur = 0; for (let i = 0; i < ms.length; i++) { if ('([{'.includes(ms[i])) d++; else if (')]}'.includes(ms[i])) d--; else if (ms[i] === ',' && !d) { out.push(s.slice(cur, i).trim()); cur = i + 1; } } if (s.slice(cur).trim()) out.push(s.slice(cur).trim()); return out; };
  // type of an expression the test compares a call with; `top` = the call's own type (a str literal is a `String`), otherwise nested in Option/Result/Vec (`&'static str`)
  const exprType = (e, crate_, top = true) => {
    e = e.trim();
    let m;
    if (e === '()') return '()';
    if (new RegExp(`^${LIT}$`).test(e)) return { int: 'i64', float: 'f64', bool: 'bool', str: top ? 'String' : "&'static str" }[litType(e)] ?? null;
    if (/^String::from\(|\.to_string\(\)$|\.to_owned\(\)$/.test(e)) return 'String';
    if ((m = /^Some\(([^]*)\)$/.exec(e))) { const x = m[1].trim(); return x.startsWith('&') ? `Option<&'static ${exprType(x.slice(1), crate_, false) ?? 'i64'}>` : `Option<${exprType(x, crate_, false) ?? 'i64'}>`; }
    if ((m = /^Ok\(([^]*)\)$/.exec(e))) return `Result<${exprType(m[1], crate_, false) ?? 'i64'}, String>`;
    if ((m = /^Err\(([^]*)\)$/.exec(e))) return `Result<i64, ${exprType(m[1], crate_, false) ?? 'String'}>`;
    if ((m = /^vec!\s*\[([^]*)\]$/.exec(e))) return `Vec<${(takeExpr(m[1]) && exprType(takeExpr(m[1]), crate_, false)) || 'i64'}>`;
    if ((m = /^([A-Z]\w*)\s*\{/.exec(e)) && /\}$/.test(e)) return tyRef(m[1], crate_) ?? m[1];
    if ((m = /^([A-Z]\w*)\s*(?:::|[({]|$)/.exec(e))) return tyRef(m[1], crate_);
    if (e === 'None') return 'Option<i64>';
    if (/^'(?:\\.|[^'\\])'$/.test(e)) return 'char';
    if ((m = /^-?\d[\d_]*(?:\.\d+)?(u8|u16|u32|u64|u128|usize|i8|i16|i32|i64|i128|isize|f32|f64)$/.exec(e))) return m[1];
    if (e.startsWith('(') && e.endsWith(')') && matchEnd(e, 0) === e.length - 1) { const parts = splitTop(e.slice(1, -1)); return parts.length > 1 || /,\s*$/.test(e.slice(1, -1)) ? `(${parts.map((x) => exprType(x, crate_, false) ?? 'i64').join(', ')}${parts.length === 1 ? ',' : ''})` : exprType(parts[0] ?? '', crate_, top); }
    if (e.startsWith('[') && e.endsWith(']') && matchEnd(e, 0) === e.length - 1) { const inner = e.slice(1, -1), rep = /^([^;]*);\s*([^;]+)$/.exec(inner); if (rep) return `[${exprType(rep[1], crate_, false) ?? 'i64'}; ${rep[2].trim()}]`; const parts = splitTop(inner); return `[${(parts[0] && exprType(parts[0], crate_, false)) || 'i64'}; ${parts.length}]`; }
    return null;
  };
  // return type of the first call matching callPat, from what follows/precedes it: `.len()`, `[idx]`, comparisons and assert_eq! against Some/Ok/Err/enum values
  /** @id CODE-RSTUB-005 @implements REQ-RSTUB-005 */
  const rustRet = (callPat, crate_) => {
    const ms = maskBraces(srcNoUse, true);
    for (const m of ms.matchAll(new RegExp(`${callPat}\\s*(?:::\\s*<[^;(){}]*?>)?\\s*\\(`, 'g'))) {
      let i = m.index + m[0].length, depth = 1;
      for (; i < ms.length && depth; i++) depth += ms[i] === '(' ? 1 : ms[i] === ')' ? -1 : 0;
      const after = srcNoUse.slice(i, i + 300), before = srcNoUse.slice(Math.max(0, m.index - 100), m.index);
      const asrt = /\bassert(?:_eq|_ne)?!\(\s*[\w.:]*$/.test(before);
      const ann = /\blet\s+(?:mut\s+)?\w+\s*:\s*([^=;]+?)\s*=\s*&?[\w.:]*$/.exec(before)?.[1];
      if (ann && !/\b_\b|\bimpl\b/.test(ann)) return ann;
      const bound = /\blet\s+(?:mut\s+)?(\w+)\s*=\s*$/.exec(before)?.[1];
      const alias = bound && new RegExp(`^\\s*;\\s*let\\s+(?:mut\\s+)?\\w+\\s*:\\s*(Result\\s*<\\s*bool\\s*,[^=;]+>)\\s*=\\s*${bound}\\s*;`).exec(maskBraces(after, true))?.[1];
      if (alias && !/\b_\b|\bimpl\b/.test(alias)) return alias.trim();
      const rhs = (a) => { const x = /^\s*(?:==|!=)\s*/.exec(a) ?? (asrt ? /^\s*,\s*/.exec(a) : null); return x ? takeExpr(a.slice(x[0].length)) : null; };
      let x;
      if (/^\s*\.\s*(?:len|count|is_empty)\s*\(\s*\)/.test(after)) return 'Vec<i64>';
      if (/^\s*\.\s*(?:is_some|is_none)\s*\(\s*\)/.test(after)) return 'Option<i64>';
      if ((x = new RegExp(`^\\s*\\[\\s*("(?:[^"\\\\]|\\\\.)*"|\\d+)\\s*\\]`).exec(after))) { const v = (rhs(after.slice(x[0].length)) && exprType(rhs(after.slice(x[0].length)), crate_)) || 'i64'; return x[1].startsWith('"') ? `std::collections::HashMap<String, ${v}>` : `Vec<${v}>`; }
      if ((x = new RegExp(`^\\s*[<>]=?\\s*${LIT}`).exec(after))) return litType(x[1]) === 'float' ? 'f64' : 'i64';
      const r = rhs(after) && exprType(rhs(after), crate_);
      if (r) return r;
      if ((x = /\bassert(?:_eq|_ne)!\(\s*([^]*?)\s*,\s*$/.exec(before))) { const b = exprType(x[1], crate_); if (b) return b; }
    }
    return null;
  };
  // explicit generic arguments the test writes for a type (`Log<A, 'a>`, `Log::<A>::new`) or fn turbofish (`f::<A>(..)`)
  const genericArgs = (n, turbofishOnly = false) => {
    const ms = maskBraces(srcNoUse, true);
    const m = new RegExp(turbofishOnly ? `\\b${n}\\s*::\\s*<` : `\\b${n}\\s*::\\s*<|(?<=[:&<,(]\\s*|->\\s*|\\bmut\\s+)\\b${n}\\s*<`).exec(ms);
    if (!m) return null;
    const args = [];
    let depth = 1, cur = m.index + m[0].length, i = cur;
    for (; i < ms.length && depth; i++) {
      if (ms[i] === '<') depth++;
      else if (ms[i] === '>' && ms[i - 1] !== '-') depth--;
      else if (ms[i] === ',' && depth === 1) { args.push(srcNoUse.slice(cur, i).trim()); cur = i + 1; }
    }
    if (depth || i > m.index + 400) return null;
    args.push(srcNoUse.slice(cur, i - 1).trim());
    return args.every(Boolean) ? args : null;
  };
  const genNames = (args) => { const nt = args.filter((a) => !a.startsWith("'")).length; let t = 0; return args.map((a) => a.startsWith("'") ? (/^'(?:_|static)$/.test(a) ? "'a" : a) : nt === 1 ? 'T' : `T${t++}`); };
  // parameter types a generic placeholder cannot infer: empty collections / `None` arguments take their element type from another call or a default
  const argTypes = (pat) => {
    const ms = maskBraces(srcNoUse, true), calls = [];
    for (const m of ms.matchAll(new RegExp(`${pat}\\s*(?:::\\s*<[^;(){}]*?>)?\\s*\\(`, 'g'))) {
      const open = m.index + m[0].length - 1, end = matchEnd(srcNoUse, open);
      if (end > 0) calls.push(splitTop(srcNoUse.slice(open + 1, end)));
    }
    const width = Math.max(0, ...calls.map((c) => c.length));
    return Array.from({ length: width }, (_, i) => {
      const raws = calls.map((c) => c[i]).filter(Boolean);
      const elemOf = (re) => { const o = raws.find((r) => re.test(r)); return o ? exprType(re.exec(o)[1].split(',')[0], ownPkg, false) : null; };
      const empty = raws.find((r) => /^&\s*(?:mut\s+)?(?:\[\s*\]|vec!\s*\[\s*\]|Vec::new\(\s*\))$|^(?:vec!\s*\[\s*\]|Vec::new\(\s*\))$|^None$/.test(r));
      if (!empty) return null;
      if (empty === 'None') return `Option<${elemOf(/^Some\(([^]*)\)$/) ?? 'i64'}>`;
      const el = elemOf(/^&?\s*(?:mut\s+)?(?:vec!)?\s*\[\s*([^\]\s][^]*)\]$/) ?? 'u8';
      return /^&/.test(empty) ? (/vec!|Vec/.test(empty) ? `&Vec<${el}>` : `&[${el}]`) : `Vec<${el}>`;
    });
  };
  // `impl Trait for X { type A = ..; const C: T = ..; fn m(..) -> R { .. } }` in the test => the trait declaration (None when the test neither implements nor `dyn`s it)
  const ufcsImpls = [];
  const traitStub = (n) => {
    const ms = maskBraces(srcNoUse, true);
    const items = [];
    let gn = [], found = false;
    for (const im of ms.matchAll(new RegExp(`\\bimpl\\s*(?:<[^>{]*>\\s*)?(?:[\\w:]+::)?${n}\\s*(?:<([^{]*?)>)?\\s+for\\s+[^{;]+\\{`, 'g'))) {
      found = true;
      if (im[1]) gn = genNames(im[1].split(',').map((a) => a.trim()).filter(Boolean));
      let depth = 1, k = im.index + im[0].length;
      for (; k < ms.length && depth; k++) depth += ms[k] === '{' ? 1 : ms[k] === '}' ? -1 : 0;
      const start = im.index + im[0].length, body = srcNoUse.slice(start, k - 1), mb = ms.slice(start, k - 1);
      const dep = []; let d = 0;
      for (let q = 0; q < mb.length; q++) { dep[q] = d; if (mb[q] === '{') d++; else if (mb[q] === '}') d--; }
      for (const f of mb.matchAll(/\bfn\s+(\w+)\s*(<[^>]*>)?\s*\(([^)]*)\)\s*(->[^{;]*)?\s*(where[^{;]*)?\{/g)) if (!dep[f.index] && !items.some((x) => x.startsWith(`fn ${f[1]}`))) items.push(`fn ${f[1]}${f[2] ?? ''}(${body.slice(f.index + f[0].indexOf('(') + 1, f.index + f[0].indexOf('(') + 1 + f[3].length).replace(/\bmut\s+(?=\w+\s*:)/g, '')})${f[4] ? ' ' + body.slice(f.index + f[0].indexOf('->'), f.index + f[0].indexOf('->') + f[4].length).trim() : ''};`);
      for (const f of mb.matchAll(/\btype\s+(\w+)\s*=/g)) if (!dep[f.index] && !items.includes(`type ${f[1]};`)) items.push(`type ${f[1]};`);
      for (const f of mb.matchAll(/\bconst\s+(\w+)\s*:\s*([^=;]+)=/g)) if (!dep[f.index]) items.push(`const ${f[1]}: ${body.slice(f.index + f[0].indexOf(':') + 1, f.index + f[0].indexOf(':') + 1 + f[2].length).trim()};`);
    }
    const bound = new RegExp(`\\bdyn\\s+${n}\\b|\\bimpl\\s+(?:\\w+\\s*\\+\\s*)*${n}\\b(?!\\s*(?:for\\b|\\{|<))|<[^<>;{}]*\\b\\w+\\s*:\\s*(?:[\\w:?']+\\s*\\+\\s*)*${n}\\b|\\bwhere\\b[^{;]*:\\s*(?:[\\w:?']+\\s*\\+\\s*)*${n}\\b|\\+\\s*${n}\\b`).test(ms);
    // UFCS: `<T as N>::f(&x)` / `N::f(&x)` call trait methods; `ufcsImpls` records which type needs `impl N for T`
    const ufcs = [];
    const hasCtor = new RegExp(`(?<![\\w:])${n}\\s*\\{|(?<![\\w:])${n}\\s*::\\s*(?:[A-Z]\\w*|[a-z_]\\w*\\s*\\(\\s*(?!&|\\))[^)])`).test(ms);
    for (const m of ms.matchAll(new RegExp(`<\\s*([A-Z][\\w:]*)(?:<[^>]*>)?\\s+as\\s+(?:[\\w:]+::)?${n}\\s*>\\s*::\\s*([a-z_]\\w*)\\s*\\(`, 'g'))) ufcs.push({ ty: m[1].split('::').pop(), f: m[2], pat: `<\\s*${m[1]}(?:<[^>]*>)?\\s+as\\s+(?:[\\w:]+::)?${n}\\s*>\\s*::\\s*${m[2]}` });
    if (!hasCtor) for (const m of ms.matchAll(new RegExp(`(?<![\\w:<])${n}\\s*::\\s*(?!new\\b)([a-z_]\\w*)\\s*\\(\\s*&`, 'g'))) ufcs.push({ ty: null, f: m[1], pat: `${n}\\s*::\\s*${m[1]}` });
    // `<T as N>::Assoc`: N is a trait with an associated type
    for (const m of ms.matchAll(new RegExp(`<\\s*([A-Z]\\w*)(?:<[^>]*>)?\\s+as\\s+(?:[\\w:]+::)?${n}\\s*>\\s*::\\s*([A-Z]\\w*)`, 'g'))) {
      found = true;
      if (!items.includes(`type ${m[2]};`)) items.push(`type ${m[2]};`);
      ufcsImpls.push({ trait: n, ty: m[1], item: `    type ${m[2]} = i64;\n` });
    }
    const resolved = [];
    for (const u of ufcs) {
      if (items.some((x) => x.startsWith(`fn ${u.f}`))) continue;
      const c = callInfo(srcNoUse, u.pat), isSelf = /^&/.test(c.raws[0] ?? ''), rest = c.args.slice(isSelf ? 1 : 0);
      const arg0 = (c.raws[0] ?? '').replace(/^&\s*(?:mut\s+)?/, '');
      const ty = u.ty ?? (/^[A-Z]/.test(arg0) ? /^[A-Z]\w*/.exec(arg0)[0] : new RegExp(`\\blet\\s+(?:mut\\s+)?${arg0.replace(/\W/g, '')}\\s*(?::[^=]+)?=\\s*&?([A-Z]\\w*)`).exec(srcNoUse)?.[1]);
      // `Name::f(&x)` is a trait call only when x is visibly a value of another type: `Type::of(&bytes)` is an associated fn
      if (!u.ty && (!ty || ty === n)) continue;
      resolved.push(u);
      const ret = rustRet(`(?<![\\w.])${u.pat}`, ownPkg) ?? (c.ret?.startsWith('opt:') ? `Option<${c.ret.slice(4)}>` : T[c.ret] ?? 'i64');
      const g = rest.map((_, i) => `A${i}`);
      const sigStr = `fn ${u.f}${g.length ? `<${g.join(', ')}>` : ''}(${[isSelf ? (/^&\s*mut\b/.test(c.raws[0]) ? '&mut self' : '&self') : '', ...g.map((t, i) => `_a${i}: ${t}`)].filter(Boolean).join(', ')}) -> ${ret}`;
      items.push(sigStr + ';');
      if (ty && /^[A-Z]/.test(ty)) ufcsImpls.push({ trait: n, ty, item: `    ${sigStr} {\n        unimplemented!("${ty}::${u.f}")\n    }\n` });
    }
    // methods the test calls on a parameter bounded by the trait (`s: &dyn N`, `s: &mut S` with `S: N`, `s: impl N`)
    const recv = [];
    const generics = [...ms.matchAll(new RegExp(`\\b(\\w+)\\s*:\\s*(?:[\\w:?']+\\s*\\+\\s*)*${n}\\b(?!\\s*(?:for\\b|\\{))`, 'g'))].map((m) => m[1]);
    for (const m of ms.matchAll(new RegExp(`\\b(\\w+)\\s*:\\s*(&\\s*(?:mut\\s+)?)?(?:dyn\\s+|impl\\s+)(?:[\\w:?']+\\s*\\+\\s*)*${n}\\b`, 'g'))) recv.push({ p: m[1], mut: /mut/.test(m[2] ?? ''), at: m.index });
    for (const g of generics) for (const m of ms.matchAll(new RegExp(`\\b(\\w+)\\s*:\\s*(&\\s*(?:mut\\s+)?)?${g}\\b(?!\\s*[:=>+,]\\s*[A-Z])`, 'g'))) if (m[1] !== g) recv.push({ p: m[1], mut: /mut/.test(m[2] ?? ''), at: m.index });
    for (const { p: rp, mut, at } of recv) {
      // the calls count only inside the fn that declares the parameter
      const bodyOpen = ms.indexOf('{', at), bodyEnd = bodyOpen < 0 ? -1 : matchEnd(srcNoUse, bodyOpen);
      if (bodyEnd < 0) continue;
      for (const k of new Set([...ms.slice(bodyOpen, bodyEnd).matchAll(new RegExp(`(?<![\\w.])${rp}\\s*\\.\\s*([a-z_]\\w*)\\s*\\(`, 'g'))].map((m) => m[1]))) {
        if (items.some((x) => x.startsWith(`fn ${k}`)) || /^(?:clone|to_string|into|as_ref|borrow|unwrap|iter)$/.test(k)) continue;
        const pat = `${rp}\\s*\\.\\s*${k}`, c = callInfo(srcNoUse, pat), lt = c.raws.map((r) => exprType(r, ownPkg, false)?.replace(/&'static str/g, '&str')), g = c.args.map((_, i) => `A${i}`).filter((_, i) => !lt[i]);
        // the call is the tail expression of a fn with a declared return type
        const tail = [...ms.matchAll(/->\s*([^{;]+?)\s*(?:where[^{;]*)?\{/g)].find((fm) => { const open = fm.index + fm[0].length - 1, end = matchEnd(srcNoUse, open); return end > 0 && new RegExp(`(?:^|[;{])\\s*${pat}\\s*\\([^;]*\\)\\s*$`).test(ms.slice(open + 1, end)); })?.[1];
        const ret = tail?.trim() ?? rustRet(`(?<![\\w.])${pat}`, ownPkg) ?? (c.ret?.startsWith('opt:') ? `Option<${c.ret.slice(4)}>` : T[c.ret] ?? '()');
        items.push(`fn ${k}${g.length ? `<${g.join(', ')}>` : ''}(${[mut ? '&mut self' : '&self', ...c.args.map((_, i) => `_a${i}: ${lt[i] ?? `A${i}`}`)].join(', ')}) -> ${ret};`);
      }
    }
    if (!found && !bound && !resolved.length) return null;
    return `pub trait ${n}${gn.length ? `<${gn.join(', ')}>` : ''} {\n${items.sort((a, b) => /^type/.test(b) - /^type/.test(a)).map((i) => `    ${i}\n`).join('')}}\n`;
  };
  // builder chains `Type::builder().a(1).b(2).build()`: every link but the last returns Self by value (the last keeps its inferred type)
  const chainsOf = (n) => {
    const ms = maskBraces(srcNoUse, true), all = new Set(), mids = new Set();
    const builtin = /^(?:unwrap\w*|expect\w*|is_\w+|clone|to_string|into|as_\w+|len|iter|collect|ok|err|map\w*|matches|contains|starts_with|ends_with|trim\w*|lines|chars|bytes|split\w*|to_uppercase|to_lowercase)$/;
    const skip = (i) => { let d = 1; for (i++; i < ms.length && d; i++) d += ms[i] === '(' ? 1 : ms[i] === ')' ? -1 : 0; return i; };
    for (const m of ms.matchAll(new RegExp(`(?<![\\w:])${n}(?:::<[^;(){}]*?>)?::[a-z_]\\w*\\s*\\(`, 'g'))) {
      let i = skip(m.index + m[0].length - 1);
      const links = [];
      for (let x; (x = /^\s*\.\s*([a-z_]\w*)\s*(?:::\s*<[^;(){}]*?>)?\s*\(/.exec(ms.slice(i))) && !builtin.test(x[1]);) { links.push(x[1]); i = skip(i + x[0].length - 1); }
      const bound = /\blet\s+(?:mut\s+)?(\w+)\s*(?::[^=]+)?=\s*$/.exec(srcNoUse.slice(Math.max(0, m.index - 80), m.index))?.[1];
      const continued = bound && [...ms.matchAll(new RegExp(`(?<![\\w.])${bound}\\s*\\.\\s*([a-z_]\\w*)\\s*\\(`, 'g'))].some(m => !builtin.test(m[1]));
      links.forEach((k) => all.add(k));
      links.slice(0, continued ? undefined : -1).forEach((k) => mids.add(k));
    }
    return { all: [...all], mids };
  };
  // capitalised names are types: `Name::Variant` => enum, otherwise a unit struct (never a function)
  // associated fns `Type::new(..)` and instance methods `v.m(..)` on `let v = Type::new(..)` (#103)
  /** @id CODE-RSTUB-002 @implements REQ-RSTUB-002 REQ-RSTUB-007 */
  const rustImpl = (n, gn = null, crate_ = ownPkg, only = null) => {
    const tf = '(?:::<[^;(){}]*?>)?';
    // `T::default()` is provided by derive(Default) on our own non-generic stubs
    const assoc = only ? only.assoc : [...new Set([...src.matchAll(new RegExp(`(?<![\\w:])${n}${tf}::([a-z_]\\w*)\\s*\\(`, 'g'))].map((m) => m[1]))].filter((k) => k !== 'default' || gn);
    // variables bound to an `N` value: `= N::f(..)`, `= N { .. }` or annotated `: N<..>`
    // a value returned by an associated fn that is not `Self` (a String, a number, ..) is not a `N`: its methods are not N's
    const nonSelf = (k) => { const pat = `(?<![\\w.])${n}(?:::\\s*<[^;(){}]*?>)?::${k}`, r = rustRet(pat, crate_), c = callInfo(src.replace(/\b\w+\./g, ''), `${n}(?:::\\s*<[^;(){}]*?>)?\\s*::\\s*${k}`); return !!(r && !new RegExp(`^(?:Option<|Result<)?${n}\\b`).test(r)) || !!(c.ret && c.ret !== 'result' && !c.ret.startsWith('opt:') && T[c.ret]) || (!c.chained && !!viaVar(pat)); };
    const varK = new Map([...src.matchAll(new RegExp(`\\blet\\s+(?:mut\\s+)?(\\w+)\\s*(?::[^=]+)?=\\s*${n}${tf}::([a-z_]\\w*)\\s*\\(`, 'g'))].map((m) => [m[1], m[2]]));
    const vars = [...new Set([...src.matchAll(new RegExp(`\\blet\\s+(?:mut\\s+)?(\\w+)\\s*(?::[^=]+)?=\\s*${n}${tf}::[a-z_]\\w*\\s*\\(|\\blet\\s+(?:mut\\s+)?(\\w+)\\s*=\\s*${n}\\s*\\{|\\blet\\s+(?:mut\\s+)?(\\w+)\\s*:\\s*&?(?:mut\\s+)?${n}\\b|\\blet\\s+(?:mut\\s+)?(\\w+)\\s*=\\s*${n}\\s*::\\s*[A-Z][a-z]\\w*\\b(?!\\s*::)`, 'g'))].map((m) => m[1] ?? m[2] ?? m[3] ?? m[4]))].filter((v) => !varK.has(v) || only || !nonSelf(varK.get(v)));
    const chain = chainsOf(n);
    const inst = only ? only.inst : [...new Set([...vars.flatMap((v) => [...src.matchAll(new RegExp(`(?<![\\w.])${v}\\s*\\.\\s*([a-z_]\\w*)\\s*\\(`, 'g'))].map((m) => m[1])), ...chain.all])].filter((k) => !assoc.includes(k) && !/^(?:clone|eq|ne)$/.test(k));
    // methods called only on `let mut v` bindings take `&mut self` (#114)
    const mutVars = new Set([...src.matchAll(/\blet\s+mut\s+(\w+)/g)].map((m) => m[1]).filter((v) => vars.includes(v)));
    const needsMut = (k) => { const cs = vars.filter((v) => new RegExp(`(?<![\\w.])${v}\\s*\\.\\s*${k}\\s*\\(`).test(src)); return cs.length > 0 && cs.every((v) => mutVars.has(v)) && cs.some((v) => new RegExp(`^\\s*${v}\\s*\\.\\s*${k}\\s*\\(`, 'm').test(src) || (new RegExp(`^\\s*assert\\w*!\\(\\s*${v}\\s*\\.\\s*${k}\\s*\\(`, 'm').test(src) && !new RegExp(`^\\s*${v}\\s*\\.\\s*\\w+\\s*\\(`, 'm').test(src))); };
    if (!assoc.length && !inst.length) return '';
    const gen = (c) => c.args.map((_, i) => `A${i}`);
    const mk = gn ? 'Self(std::marker::PhantomData)' : 'Self';
    const sig = (k, self) => {
      const memberPat = `(?:${vars.map(v => `(?<![\\w.])${v}\\s*\\.\\s*${k}`).concat(`(?<![\\w.])${n}${tf}::[a-z_]\\w*\\s*\\([^;{}]*?\\)(?:\\s*\\.\\s*[a-z_]\\w*\\s*\\([^;{}]*?\\))*\\s*\\.\\s*${k}`).join('|')})`;
      const memberCall = self ? callInfo(srcNoUse, memberPat) : null;
      const callPat = self ? memberPat : `(?<![\\w.])${n}(?:::\\s*<[^;(){}]*?>)?\\s*::\\s*${k}`;
      // Compiler-guided additions without a known receiver remain explicitly guessed.
      const repair = self && only && memberCall.argc === undefined;
      const c = repair ? callInfo(src.replace(/\b\w+\./g, ''), k) : self ? memberCall : callInfo(srcNoUse, callPat);
      const pty = argTypes(repair ? `(?<=[\\w)\\]]\\s*)\\.\\s*${k}` : callPat), g = gen(c).filter((_, i) => !pty[i]), mid = self && chain.mids.has(k);
      const assocRet = !self && !mid && !c.chained && c.ret !== 'result' ? rustRet(callPat, crate_) : null;
      const memberRet = self ? rustRet(memberPat, crate_) ?? (memberCall.ret?.startsWith('opt:') ? `Option<${memberCall.ret.slice(4)}>` : T[memberCall.ret ?? viaVar(memberPat)]) : null;
      const ret = mid ? 'Self' : (assocRet && !new RegExp(`^${n}\\b`).test(assocRet) ? assocRet : null) ?? (!self && !mid && !c.chained && c.ret && c.ret !== 'result' && T[c.ret] ? T[c.ret] : null) ?? (self ? memberRet ?? 'i64' : c.ret === 'result' ? 'Result<Self, String>' : ((c.chained ? null : T[viaVar(`(?<![\\w.])${n}(?:::\\s*<[^;(){}]*?>)?::${k}`)]) ?? 'Self'));
      const guessed = !!only || (self && !mid && !memberRet);
      note(`${n}::${k}`, guessed ? 'guessed' : 'inferred', { evidence: evidenceLine(k, self ? memberPat : `(?<![\\w.])${n}${tf}::${k}`) });
      return `    pub fn ${k}${g.length ? `<${g.join(', ')}>` : ''}(${[self ? (mid ? 'self' : needsMut(k) ? '&mut self' : '&self') : '', ...c.args.map((_, i) => `_a${i}: ${pty[i] ?? `A${i}`}`)].filter(Boolean).join(', ')}) -> ${ret} {${guessed ? unknownMarker : ''}\n        ${!self && /^(new|default|with_\w+|from_\w+|create|empty)$/.test(k) ? (c.ret === 'result' ? `Ok(${mk})` : mk) : `unimplemented!("${n}::${k}")`}\n    }\n`;
    };
    return `\nimpl${gn ? `<${gn.join(', ')}>` : ''} ${n}${gn ? `<${gn.join(', ')}>` : ''} {\n${[...assoc.map((k) => sig(k, false)), ...inst.map((k) => sig(k, true))].join('\n')}}\n`;
  };
  // struct literals `N { x: 1, inner: M { .. } }` (nested ones included): field name -> type, from every literal of N
  const literalFields = (n, crate_) => {
    const ms = maskBraces(srcNoUse, true), fields = new Map();
    for (const m of ms.matchAll(new RegExp(`(?<!\\w)${n}\\s*\\{(?=\\s*[a-z_]\\w*\\s*:(?!:))`, 'g'))) {
      const open = m.index + m[0].length - 1, end = matchEnd(srcNoUse, open);
      if (end < 0) continue;
      for (const f of splitTop(srcNoUse.slice(open + 1, end))) {
        const fm = /^([a-z_]\w*)\s*:\s*([^]*)$/.exec(f);
        if (fm && !fields.has(fm[1])) fields.set(fm[1], exprType(fm[2], crate_, false)?.replace(/^&'static str$/, 'String') ?? 'i64');
      }
    }
    return [...fields];
  };
  // the `pub fn` blocks of a generated impl
  const fnBlocks = (impl) => [...impl.matchAll(/^    pub fn (\w+)[^\n]*\{(?: \/\/ SDD-TODO\(stub\):[^\n]*)?\n(?:        [^\n]*\n)+    \}\n/gm)];
  // appends fn blocks to the inherent impl of `x` in `t` (generic impls included); `create` adds `impl<..> x<..> {}` when the type has none
  const addToImpl = (t, x, blocks, create) => {
    if (!blocks.length) return t;
    const at = new RegExp(`^impl(?:<[^>{]*>)?\\s+${x}(?:<[^>{]*>)?\\s*\\{`, 'm').exec(t);
    if (!at) {
      const def = create && new RegExp(`\\b(?:struct|enum)\\s+${x}\\s*(?:<([^>{(;]*)>)?`).exec(t);
      if (!def) return t;
      const ps = def[1] ? splitTop(def[1]) : [];
      const head = ps.length ? `<${ps.map((q) => q.replace(/\s*=[^]*$/, '')).join(', ')}>` : '', use = ps.length ? `<${ps.map((q) => /^('?\w+)/.exec(q)?.[1]).join(', ')}>` : '';
      return t.replace(/\n*$/, '\n') + `\nimpl${head} ${x}${use} {\n${blocks.join('\n')}}\n`;
    }
    const m_ = maskBraces(t, true);
    let depth = 0, k = at.index + at[0].length - 1;
    for (; k < m_.length; k++) { if (m_[k] === '{') depth++; else if (m_[k] === '}' && !--depth) break; }
    return t.slice(0, k).replace(/\n*$/, '\n\n') + blocks.join('\n') + t.slice(k);
  };
  // `impl Trait for Type {..}` for UFCS-called trait methods, once the type is defined in the text that is written
  const implsFor = (text) => { const done = new Set(); return ufcsImpls.filter((u) => new RegExp(`\\b(?:struct|enum)\\s+${u.ty}\\b`).test(text) && !new RegExp(`\\bimpl(?:<[^>]*>)?\\s+${u.trait}\\s+for\\s+${u.ty}\\b`).test(text)).filter((u) => !done.has(u.trait + u.ty) && done.add(u.trait + u.ty)).map((u) => `\nimpl ${u.trait} for ${u.ty} {\n${ufcsImpls.filter((x) => x.trait === u.trait && x.ty === u.ty).map((x) => x.item).join('\n')}}\n`).join(''); };
  const typeStub = (n, crate_ = ownPkg) => {
    const vs = [...new Set([...src.matchAll(new RegExp(`\\b${n}::([A-Z]\\w*)`, 'g'))].map((m) => m[1]).filter((v) => !/^[A-Z][A-Z0-9_]+$/.test(v)))];
    if (vs.length) {
      const fty = (e) => /^-?\d+\.\d*/.test(e) ? 'f64' : /^-?\d+$/.test(e) ? 'i64' : /^&?"/.test(e) || /String::from|\.to_string\(|\.to_owned\(|\.into\(\)/.test(e) ? 'String' : /^(true|false)$/.test(e) ? 'bool' : /^vec!/.test(e) ? 'Vec<i64>' : 'i64';
      // `N::V(a, b)` => tuple variant, `N::V { x: 1 }` => struct variant, typed from the values (#268)
      const shape = (v) => {
        const ft = (e) => exprType(e, crate_, false)?.replace(/&'static str/g, 'String') ?? fty(e);
        const t = new RegExp(`\\b${n}::${v}\\s*\\(`).test(srcNoUse) ? callInfo(srcNoUse, `${n}::${v}`) : null;
        if (t) return t.raws.length ? `(${t.raws.map((r) => ft(r)).join(', ')})` : '';
        const open = new RegExp(`\\b${n}::${v}\\s*\\{`).exec(srcNoUse);
        const end = open ? matchEnd(srcNoUse, open.index + open[0].length - 1) : -1;
        const fs_ = end > 0 ? splitTop(srcNoUse.slice(open.index + open[0].length, end)).map((f) => /^([a-z_]\w*)\s*(?::\s*([^]*?))?\s*$/.exec(f)).filter(Boolean).map((m) => `${m[1]}: ${m[2] ? ft(m[2]) : 'i64'}`) : [];
        return fs_.length ? ` { ${fs_.join(', ')} }` : '';
      };
      const shapes = vs.map(shape);
      return `#[derive(Debug, Clone, ${shapes.every((x) => !x) ? 'Copy, PartialEq, Eq' : 'PartialEq'})]\npub enum ${n} {\n${vs.map((v, i) => `    ${v}${shapes[i]},\n`).join('')}}\n${rustImpl(n, null, crate_)}`;
    }
    // struct literal `N { x: 1, y: "a" }` => named fields typed from the values (#130)
    const fields = literalFields(n, crate_);
    const ga = fields.length ? null : genericArgs(n), gn = ga && genNames(ga);
    return fields.length ? `#[derive(Debug, Clone, Default, PartialEq)]\npub struct ${n} {\n${fields.map(([f, t]) => `    pub ${f}: ${t},\n`).join('')}}\n${rustImpl(n, null, crate_)}` : gn ? `#[derive(Debug, Clone, PartialEq)]\npub struct ${n}<${gn.join(', ')}>(pub std::marker::PhantomData<(${gn.map((x) => x.startsWith("'") ? `&${x} ()` : x).join(', ')},)>);\n${rustImpl(n, gn, crate_)}` : `#[derive(Debug, Clone, Default, PartialEq)]\npub struct ${n};\n${rustImpl(n, null, crate_)}`;
  };
  /** @id CODE-RSTUB-006 @implements REQ-RSTUB-006 */
  const boolLoopType = (n, crate_) => {
    const ms = maskBraces(srcNoUse, true);
    const loops = [...ms.matchAll(new RegExp(`\\bfor\\s+(\\(([^)]*)\\)|\\w+)\\s+in\\s+&?${n}\\b\\s*\\{`, 'g'))];
    let type = null;
    for (const loop of loops) {
      const open = loop.index + loop[0].length - 1, end = matchEnd(srcNoUse, open);
      if (end < 0) return null;
      const body = srcNoUse.slice(open + 1, end), masked = ms.slice(open + 1, end);
      const bindings = loop[2] ? splitTop(loop[2]) : [loop[1]];
      if (!bindings.length || bindings.some(v => !/^[a-zA-Z]\w*$/.test(v))) return null;
      for (const v of bindings) {
        if (new RegExp(`\\b(?:let|for)\\s+[^;={}]*\\b${v}\\b|\\|[^|\\n]*\\b${v}\\b`).test(masked)) return null;
        const types = [];
        for (const m of masked.matchAll(new RegExp(`\\bassert_(?:eq|ne)!\\(\\s*\\*\\s*${v}\\s*,\\s*|\\*\\s*${v}\\s*(?:==|!=)\\s*`, 'g'))) {
          types.push(exprType(takeExpr(body.slice(m.index + m[0].length)), crate_, false));
        }
        for (const m of masked.matchAll(new RegExp(`\\bassert_(?:eq|ne)!\\(\\s*([^,()]*)\\s*,\\s*\\*\\s*${v}\\s*[,)]`, 'g'))) {
          const start = m.index + m[0].indexOf('(') + 1;
          types.push(exprType(body.slice(start, masked.indexOf(',', start)), crate_, false));
        }
        for (const m of masked.matchAll(new RegExp(`([^;(){}]*?)\\s*(?:==|!=)\\s*\\*\\s*${v}\\b`, 'g'))) {
          types.push(exprType(body.slice(m.index, m.index + m[1].length), crate_, false));
        }
        if (!types.length || types.some(t => t !== 'bool')) return null;
      }
      const current = loop[2] ? `(${bindings.map(() => 'bool').join(', ')}${bindings.length === 1 ? ',' : ''})` : 'bool';
      if (type && type !== current) return null;
      type = current;
    }
    return type;
  };
  // const / static tables: the type comes from what the test compares or iterates them with (tuples, Option, slices), else i64
  const constStub = (n, crate_) => {
    const str = new RegExp(`\\b${n}\\s*(?:\\.\\s*(?:len|chars|as_str|is_empty)\\b|[!=]=\\s*"|,\\s*")`).test(srcNoUse);
    const dflt = (ty) => ty === '&str' || ty === "&'static str" ? '""' : ty === 'f64' || ty === 'f32' ? '0.0' : ty === 'bool' ? 'false' : ty === 'char' ? "'\\0'" : ty === 'String' ? 'String::new()' : /^Option</.test(ty) ? 'None' : /^Vec</.test(ty) ? 'Vec::new()' : /^&\[/.test(ty) ? '&[]' : /^\(/.test(ty) ? `(${splitTop(ty.slice(1, -1).replace(/,\s*$/, '')).map(dflt).join(', ')}${splitTop(ty.slice(1, -1).replace(/,\s*$/, '')).length === 1 ? ',' : ''})` : /^\[/.test(ty) ? `[${dflt(/^\[(.*);/.exec(ty)[1])}; ${/;\s*(\w+)\]$/.exec(ty)[1]}]` : /^[iu](?:8|16|32|64|128|size)$/.test(ty) ? '0' : null;
    const fit = (ty, wrap) => { const t = ty?.replace(/&'static str/g, '&str'); const v = t && dflt(t); return v === null || v == null ? null : `pub const ${n}: ${wrap ? `&[${t}]` : t} = ${wrap ? '&[]' : v};\n`; };
    const cmp = new RegExp(`\\b${n}\\s*(?:==|!=)\\s*([^;{}]*?)\\s*[);{]|assert(?:_eq|_ne)?!\\(\\s*${n}\\s*,\\s*`).exec(srcNoUse);
    const rhs = (after) => takeExpr(after);
    const direct = (() => { const m = new RegExp(`assert(?:_eq|_ne)?!\\(\\s*${n}\\s*,\\s*`).exec(srcNoUse); const e = m ? rhs(srcNoUse.slice(m.index + m[0].length)) : cmp?.[1]; const mm = new RegExp(`assert(?:_eq|_ne)?!\\(\\s*([^;]*?),\\s*${n}\\s*[,)]`).exec(srcNoUse); return (e && exprType(e, crate_, false)) || (mm && exprType(takeExpr(mm[1]), crate_, false)) || null; })();
    const idx = (() => { const m = new RegExp(`\\b${n}\\s*\\[[^\\]]*\\]\\s*(?:==|!=)\\s*`).exec(srcNoUse) ?? new RegExp(`assert(?:_eq|_ne)?!\\(\\s*${n}\\s*\\[[^\\]]*\\]\\s*,\\s*`).exec(srcNoUse); return m ? exprType(takeExpr(srcNoUse.slice(m.index + m[0].length)), crate_, false) : null; })();
    const loop = new RegExp(`\\bfor\\s+(\\(([^)]*)\\)|\\w+)\\s+in\\s+&?${n}\\b`).exec(srcNoUse);
    if (str) return `pub const ${n}: &str = "";\n`;
    if (idx) return fit(idx, true);
    if (loop) {
      const supported = boolLoopType(n, crate_);
      if (supported) return fit(supported, true);
      return fit(loop[2] ? `(${loop[2].split(',').map(() => 'i64').join(', ')}${loop[2].split(',').length === 1 ? ',' : ''})` : 'i64', true).replace(/;\n$/, `;${unknownMarker}\n`);
    }
    if (direct) return fit(direct);
    // a float literal beside the const (`EPSILON / 2.0`, `assert_eq!(EPSILON, 1e-5)`) makes it f64 (#310)
    const FL = '-?(?:\\d+\\.\\d+(?:[eE][+-]?\\d+)?|\\d+[eE][+-]?\\d+)(?:_?f(?:32|64))?\\b|-?\\d+_?f(?:32|64)\\b';
    if (new RegExp(`\\b${n}\\s*(?:[-+*/<>]=?|[=!]=)\\s*(?:${FL})|(?:${FL})\\s*(?:[-+*/<>]=?|[=!]=)\\s*${n}\\b|assert(?:_eq|_ne)?!\\(\\s*${n}\\s*,\\s*(?:${FL})|assert(?:_eq|_ne)?!\\(\\s*(?:${FL})\\s*,\\s*${n}\\b`).test(srcNoUse)) return fit('f64');
    if (new RegExp(`\\b${n}\\s*\\.\\s*(?:len|iter|is_empty)\\b|\\b${n}\\s*\\[`).test(srcNoUse)) return `pub const ${n}: &[i64] = &[];\n`;
    // last resort, the type is literally written in the test: `let x: f64 = LIMIT;` / `LIMIT as f64`
    const lit = new RegExp(`\\blet\\s+(?:mut\\s+)?\\w+\\s*:\\s*([^=;]+?)\\s*=\\s*${n}\\s*;`).exec(srcNoUse)?.[1] ?? new RegExp(`\\b${n}\\s+as\\s+([iuf](?:8|16|32|64|128|size))\\b`).exec(srcNoUse)?.[1];
    return lit ? fit(lit.trim()) : null;
  };
  // `tdd stub --report`: confidence (shown | inferred | guessed) and the first test line that mentions the element (design 3.2)
  const report = [];
  const evidenceLine = (n, pat = null) => {
    let full = src; try { full = fs.readFileSync(path.join(ROOT, testPath), 'utf8'); } catch { /* scoped source only */ }
    if (pat) {
      const match = new RegExp(pat).exec(maskBraces(full, true));
      if (match) return `${testPath}:${full.slice(0, match.index + match[0].length - n.length).split('\n').length}`;
    }
    const at = full.split('\n').findIndex((l) => !/^\s*use\s/.test(l) && new RegExp(`\\b${n.split('::').at(-1)}\\b`).test(l));
    return at < 0 ? testPath : `${testPath}:${at + 1}`;
  };
  const note = (element, confidence, extra = {}) => { if (!report.some((r) => r.element === element)) report.push({ element, confidence, evidence: evidenceLine(element), ...extra }); };
  const reEsc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const noteFn = (n, rr, supported) => {
    if (rr && new RegExp(`\\blet\\s+(?:mut\\s+)?\\w+\\s*:\\s*${reEsc(rr)}\\s*=\\s*&?[\\w.:]*(?<![\\w.])${n}\\s*(?:::\\s*<[^;(){}]*?>)?\\s*\\(`).test(srcNoUse)) return note(n, 'shown');
    if (!supported) return note(n, 'guessed');
    note(n, 'inferred');
  };
  // a const typed in the test itself: `let x: f64 = LIMIT;` or `LIMIT as f64`, and the emitted type is that type
  const shownConst = (n, cs) => {
    const ty = new RegExp(`\\blet\\s+(?:mut\\s+)?\\w+\\s*:\\s*([^=;]+?)\\s*=\\s*&?${n}\\s*;`).exec(srcNoUse)?.[1] ?? new RegExp(`\\b${n}\\s+as\\s+([iuf](?:8|16|32|64|128|size))\\b`).exec(srcNoUse)?.[1];
    return !!ty && cs.startsWith(`pub const ${n}: ${ty.trim()} =`);
  };
  /** @id CODE-RSTUB-003 @implements REQ-RSTUB-003 */
  const itemStub = (n, crate_ = ownPkg) => {
    if (/^[A-Z][A-Z0-9_]+$/.test(n)) {
      const cs = constStub(n, crate_);
      note(n, cs && !cs.includes('SDD-TODO(stub)') ? (shownConst(n, cs) ? 'shown' : 'inferred') : 'guessed');
      // no evidence for the type: a wrong concrete type would give a misleading Red, so the placeholder fails to compile at this element
      return cs ?? `pub const ${n}: () = (); // SDD-TODO(stub): type unknown — write the real type and value by hand\n`;
    }
    return itemStub0(n, crate_);
  };
  /** @id CODE-RSTUB-001 @implements REQ-RSTUB-001 */
  const itemStub0 = (n, crate_ = ownPkg) => { if (/^[A-Z]/.test(n)) { const ts = traitStub(n) ?? typeStub(n, crate_); if (ts) note(n, 'inferred'); return ts; } const c = callInfo(src, n); c.ret ??= viaVar(`(?<![\\w.])(?:\\w+::)*${n}`); const ga = genericArgs(n, true)?.filter((a) => !a.startsWith("'")), pty = ga ? [] : argTypes(`(?<![\\w.])(?:\\w+::)*${n}`), g = ga ? genNames(ga) : c.args.map((_, i) => `A${i}`).filter((_, i) => !pty[i]); const rr = rustRet(`(?<![\\w.])(?:\\w+::)*${n}`, crate_); const supported = rr ?? (c.ret?.startsWith('opt:') ? `Option<${c.ret.slice(4)}>` : T[c.ret]); const ret = supported ?? 'i64'; noteFn(n, rr, supported); return `pub fn ${n}${g.length ? `<${g.join(', ')}>` : ''}(${c.args.map((_, i) => `_a${i}: ${ga ? 'impl Sized' : pty[i] ?? `A${i}`}`).join(', ')}) -> ${ret} {${supported ? '' : unknownMarker}\n    unimplemented!("${n}")\n}\n`; };
  // `use <crate>::a::b::{X, f};` => missing modules `a`, `a/b` (declared in the parent) holding the imported items (#69). Existing modules are never touched.
  const pkgName = (toml) => /\[package\][^[]*?^\s*name\s*=\s*"([^"]+)"/ms.exec(fs.readFileSync(toml, 'utf8'))?.[1]?.replace(/-/g, '_');
  // every workspace member crate by name, so `use other_crate::a::X` is stubbed in that crate (#76)
  const crates = new Map();
  for (const f of workspaceFiles().filter((f) => /(?:^|\/)Cargo\.toml$/.test(f))) { const n = pkgName(path.join(ROOT, f)); if (n) crates.set(n, path.resolve(ROOT, path.dirname(f))); }
  // a workspace member without any target makes cargo refuse to load the workspace: give it an empty lib (#304)
  for (const croot of crates.values()) {
    const tomlText = fs.readFileSync(path.join(croot, 'Cargo.toml'), 'utf8');
    if (['src/lib.rs', 'src/main.rs', 'src/bin', 'tests', 'examples', 'benches', 'build.rs'].some((x) => fs.existsSync(path.join(croot, x))) || /^\s*\[(?:lib|\[bin\])/m.test(tomlText)) continue;
    fs.mkdirSync(path.join(croot, 'src'), { recursive: true });
    fs.writeFileSync(path.join(croot, 'src/lib.rs'), '');
    made.push(rel(path.join(croot, 'src/lib.rs')));
  }
  const ownPkg = pkgName(path.join(root, 'Cargo.toml'));
  // where each imported project type lives, so a return type can name it (#288)
  const typePath = new Map();
  for (const m of src.matchAll(/^\s*use\s+(\w+)((?:::[a-z_]\w*)*)::(\{[^}]*\}|[A-Z]\w*)\s*;/gm)) {
    if (!crates.has(m[1])) continue;
    for (const x of (m[3].startsWith('{') ? m[3].slice(1, -1).split(',') : [m[3]]).map((y) => y.trim().split(/\s+as\s+/)[0])) if (/^[A-Z]\w*$/.test(x)) typePath.set(x, { crate: m[1], mods: m[2] });
  }
  const modNames = new Set();
  let preOut;
  const freshMods = new Set();
  let srcNoUse = src.replace(/^\s*use\s[^;]*;/gm, '');
  // the whole test file (other tests included): names imported for another test still have to exist for the file to compile (#304)
  const fullNoUse = (() => { let full = src; try { full = fs.readFileSync(path.join(ROOT, testPath), 'utf8'); } catch { /* scoped source only */ } if (aliases.size) full = full.replace(new RegExp(`^\\s*use\\s[^;]*;|\\b(${[...aliases.keys()].join('|')})\\b`, 'gm'), (m, a) => a ? aliases.get(a) : m); return full.replace(/^\s*use\s[^;]*;/gm, ''); })();
  // runs `fn` with the other tests visible: only for names the requested test never mentions
  const inFull = (fn) => { const [a, b] = [src, srcNoUse]; src = fullNoUse; srcNoUse = fullNoUse; try { return fn(); } finally { src = a; srcNoUse = b; } };
  const stubItem = (n, crate_) => new RegExp(`\\b${n}\\b`).test(srcNoUse) ? itemStub(n, crate_) : inFull(() => itemStub(n, crate_));
  // inline paths `krate::geo::Point { .. }` / `krate::util::f(..)` count as imports of that item (#130)
  const inline = [...srcNoUse.matchAll(/(?<![\w:])(\w+)((?:::[a-z_]\w*)+)::([A-Za-z_]\w*)/g)].filter((m) => crates.has(m[1])).map((m) => `use ${m[1]}${m[2]}::${m[3]};`).join('\n');
  // `use krate::ops;` + `ops::f(..)` => `use krate::ops::f;`: ops is a module (#268)
  const modUse = [...src.matchAll(/^\s*use\s+(\w+)::([a-z_]\w*)\s*;/gm)].filter((m) => crates.has(m[1])).flatMap((m) => [...new Set([...srcNoUse.matchAll(new RegExp(`(?<![\\w:])${m[2]}::([A-Za-z_]\\w*)`, 'g'))].map((x) => x[1]))].map((x) => `use ${m[1]}::${m[2]}::${x};`)).join('\n');
  for (const m of (src + '\n' + inline + '\n' + modUse).matchAll(/^\s*use\s+(\w+)((?:::[a-z_]\w*)+)::(\{[^}]*\}|\w+)\s*;/gm)) {
    const croot = crates.get(m[1]);
    if (!croot) continue;
    preOut ??= cargoTest().text;
    const items = (m[3].startsWith('{') ? m[3].slice(1, -1).split(',') : [m[3]]).map((x) => x.trim().split(/\s+as\s+/)[0]).filter((x) => /^[A-Za-z_]\w*$/.test(x) && x !== 'self' && new RegExp(`\\b${x}\\b`).test(srcNoUse));
    if (!items.length) continue;
    const lib = path.join(croot, 'src/lib.rs');
    if (!fs.existsSync(lib)) { fs.mkdirSync(path.dirname(lib), { recursive: true }); fs.writeFileSync(lib, ''); made.push(rel(lib)); }
    const segs = m[2].split('::').filter(Boolean);
    segs.forEach((x) => modNames.add(x));
    let parent = lib;
    let created = false;
    let last = lib;
    for (let i = 0; i < segs.length; i++) {
      const f = path.join(croot, 'src', ...segs.slice(0, i + 1)) + '.rs';
      const mf = path.join(croot, 'src', ...segs.slice(0, i + 1), 'mod.rs');
      created = false;
      if (!fs.existsSync(f) && !fs.existsSync(mf)) {
        fs.mkdirSync(path.dirname(f), { recursive: true });
        fs.writeFileSync(f, '');
        const prev = fs.readFileSync(parent, 'utf8');
        if (!new RegExp(`\\bmod\\s+${segs[i]}\\b`).test(prev)) fs.writeFileSync(parent, prev + (prev && !prev.endsWith('\n') ? '\n' : '') + `pub mod ${segs[i]};\n`);
        made.push(rel(parent), rel(f));
        created = true;
      }
      parent = fs.existsSync(f) ? f : mf;
      last = parent;
    }
    if (created) { const t_ = items.map((x) => itemStub(x, m[1])).join('\n'); fs.writeFileSync(last, t_ + implsFor(t_)); freshMods.add(last); }
    else {
      // missing items are appended to an existing module; items it already defines or re-exports are left alone
      const text = fs.readFileSync(last, 'utf8');
      // items inside an inline #[cfg(test)] module do not exist in non-test builds
      const nonTest = (() => { let t = text, at; while ((at = /#\[cfg\(test\)\]\s*(?:pub\s+)?mod\s+\w+\s*\{/.exec(t))) { const m_ = maskBraces(t, true); let depth = 0, k = at.index + at[0].length - 1; for (; k < m_.length; k++) { if (m_[k] === '{') depth++; else if (m_[k] === '}' && !--depth) break; } t = t.slice(0, at.index) + t.slice(k + 1); } return t; })();
      // a module that include!s a file or invokes macros may define the type itself: only what cargo reports missing is added
      const opaque = /\binclude!\s*\(|^\s*(?!(?:macro_rules|unimplemented|todo|panic|assert\w*|debug_assert\w*|unreachable|vec|println|format)\b)\w+!\s*[({[]/m.test(nonTest);
      const miss = items.filter((x) => !new RegExp(`\\b(?:struct|enum|fn|const|static|type|trait|use|mod)\\s+(?:[\\w:{},\\s]*\\b)?${x}\\b`).test(nonTest) && (!opaque || new RegExp(`\`${x}\``).test(preOut)));
      // methods a later test needs are added to the existing inherent `impl Type {` (#268)
      const grown = items.filter((x) => /^[A-Z]/.test(x) && !miss.includes(x)).reduce((t, x) => {
        const hasDefault = new RegExp(`derive\\([^)]*\\bDefault\\b[^)]*\\)\\]\\s*(?:pub\\s+)?(?:struct|enum)\\s+${x}\\b|\\bimpl\\s+Default\\s+for\\s+${x}\\b`).test(t);
        const add_ = fnBlocks(rustImpl(x)).filter((f) => !new RegExp(`\\bfn\\s+${f[1]}\\b`).test(t) && !(f[1] === 'default' && hasDefault)).map((f) => f[0]);
        return addToImpl(t, x, add_, false);
      }, text);
      if (grown !== text) { fs.writeFileSync(last, grown); if (!freshMods.has(last)) made.push(rel(last)); }
      if (miss.length) { const add_ = miss.map((x) => itemStub(x, m[1])).join('\n'); fs.appendFileSync(last, (text && !text.endsWith('\n') ? '\n' : '') + (text ? '\n' : '') + add_ + implsFor(text + add_)); if (!freshMods.has(last)) made.push(rel(last)); }
    }
  }
  // `macro_rules!` macros the test imports from a project crate (root-level `use krate::name;`, `krate::name!`, `#[macro_use] extern crate`) get an exported throwing stub (#288)
  const stdMacros = new Set(['assert', 'assert_eq', 'assert_ne', 'debug_assert', 'debug_assert_eq', 'debug_assert_ne', 'vec', 'println', 'print', 'eprintln', 'eprint', 'format', 'format_args', 'panic', 'write', 'writeln', 'matches', 'unreachable', 'unimplemented', 'todo', 'include', 'include_str', 'include_bytes', 'concat', 'stringify', 'env', 'option_env', 'cfg', 'line', 'file', 'column', 'module_path', 'dbg', 'compile_error', 'thread_local', 'macro_rules']);
  const macroNames = new Set();
  const macroUse = /#\[macro_use\]\s*extern\s+crate\s+(\w+)/.exec(src)?.[1];
  for (const m of maskBraces(srcNoUse, true).matchAll(/(?<![\w!])(?:(\w+)::)?(\w+)!\s*[[({]/g)) {
    const name = m[2];
    if (stdMacros.has(name) || macroNames.has(name) || new RegExp(`\\bmacro_rules!\\s*${name}\\b`).test(src)) continue;
    const imp = new RegExp(`^\\s*use\\s+(\\w+)::(?:\\{[^}]*\\b${name}\\b[^}]*\\}|${name})\\s*;`, 'm').exec(src)?.[1];
    const krate = [m[1], imp, macroUse].find((k) => k && crates.has(k));
    if (!krate) continue;
    macroNames.add(name);
    const lib = path.join(crates.get(krate), 'src/lib.rs');
    fs.mkdirSync(path.dirname(lib), { recursive: true });
    const text = fs.existsSync(lib) ? fs.readFileSync(lib, 'utf8') : '';
    if (new RegExp(`\\bmacro_rules!\\s*${name}\\b`).test(text)) continue;
    fs.writeFileSync(lib, text + (text && !text.endsWith('\n') ? '\n' : '') + (text ? '\n' : '') + `#[macro_export]\nmacro_rules! ${name} {\n    ($($t:tt)*) => {\n        unimplemented!("${name}!")\n    };\n}\n`);
    made.push(rel(lib));
  }
  let result = cargoTest();
  let out = result.text;
  // variants the test uses that an existing enum lacks are added to it (#290)
  const variantNotes = [];
  const missingVariants = [...new Map([...out.matchAll(/no variant[^`\n]*named `(\w+)` found for enum `(?:\w+::)*(\w+)`/g)].map((m) => [m[2] + '::' + m[1], m])).values()];
  if (missingVariants.length) {
    const srcFiles = (d) => fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? srcFiles(path.join(d, e.name)) : e.name.endsWith('.rs') ? [path.join(d, e.name)] : []) : [];
    const files = [...new Set([root, ...crates.values()])].flatMap((c) => srcFiles(path.join(c, 'src')));
    for (const [, v, e] of missingVariants) {
      const at = files.map((f) => ({ f, text: fs.readFileSync(f, 'utf8') })).map((x) => ({ ...x, m: new RegExp(`\\benum\\s+${e}\\s*\\{`).exec(x.text) })).find((x) => x.m);
      if (!at) { variantNotes.push(`variant ${e}::${v} not added: enum ${e} is not defined in the project sources — add it by hand`); continue; }
      // associated consts / fns of an existing enum are impl items, never variants
      if (/^[A-Z][A-Z0-9_]+$/.test(v) || /^[a-z_]/.test(v)) {
        const item = /^[a-z_]/.test(v) ? new RegExp(`^    pub fn ${v}[^\\n]*\\{\\n(?:        [^\\n]*\\n)+    \\}\\n`, 'm').exec(rustImpl(e))?.[0] : `    pub const ${v}: i64 = 0;\n`;
        if (!item || new RegExp(`\\b(?:fn|const)\\s+${v}\\b`).test(at.text)) { variantNotes.push(`${e}::${v} is an associated item, not a variant: add it by hand`); continue; }
        fs.writeFileSync(at.f, at.text.replace(/\n*$/, '\n') + `\nimpl ${e} {\n${item}}\n`);
        made.push(rel(at.f));
        variantNotes.push(`added associated item ${e}::${v} to ${rel(at.f)}`);
        continue;
      }
      const line = new RegExp(`^    ${v}\\b[^\\n]*,\\n`, 'm').exec(typeStub(e))?.[0];
      const mm = maskBraces(at.text, true);
      let depth = 0, k = at.m.index + at.m[0].length - 1;
      for (; k < mm.length; k++) { if (mm[k] === '{') depth++; else if (mm[k] === '}' && !--depth) break; }
      if (!line || k >= mm.length || new RegExp(`\\b${v}\\b`).test(at.text.slice(at.m.index, k))) { variantNotes.push(`variant ${e}::${v} not added: add it to enum ${e} by hand`); continue; }
      fs.writeFileSync(at.f, at.text.slice(0, k).replace(/\n*$/, '\n') + line + at.text.slice(k));
      made.push(rel(at.f));
      variantNotes.push(`added variant ${e}::${v} to ${rel(at.f)}`);
    }
    result = cargoTest();
    out = result.text;
  }
  // methods / associated fns the test calls on a type that already exists are added to its impl, found from cargo's E0599 (#298)
  const growMembers = () => {
    for (let round = 0; round < 4; round++) {
      const want = new Map();
      for (const m of out.matchAll(/no (method|associated function or constant|function or associated item) named `(\w+)` found for (?:struct|enum) `(?:\w+::)*(\w+)/g)) {
        const e = want.get(m[3]) ?? { assoc: new Set(), inst: new Set() };
        e[m[1] === 'method' ? 'inst' : 'assoc'].add(m[2]);
        want.set(m[3], e);
      }
      let wrote = false;
      for (const [t, { assoc, inst }] of want) {
        const srcFiles = (d) => fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? srcFiles(path.join(d, e.name)) : e.name.endsWith('.rs') ? [path.join(d, e.name)] : []) : [];
        const files = [...new Set([root, ...crates.values()])].flatMap((c) => srcFiles(path.join(c, 'src')));
        const at = files.map((f) => ({ f, text: fs.readFileSync(f, 'utf8') })).find((x) => new RegExp(`\\b(?:struct|enum)\\s+${t}\\b`).test(x.text));
        if (!at) continue;
        const owner = [...crates].find(([, r]) => at.f.startsWith(r + path.sep))?.[0] ?? ownPkg;
        const blocks = fnBlocks(rustImpl(t, null, owner, { assoc: [...assoc], inst: [...inst] })).filter((f) => !new RegExp(`\\bfn\\s+${f[1]}\\b`).test(at.text)).map((f) => f[0]);
        const next = addToImpl(at.text, t, blocks, true);
        if (next === at.text) continue;
        fs.writeFileSync(at.f, next);
        made.push(rel(at.f));
        wrote = true;
      }
      if (!wrote) return;
      result = cargoTest();
      out = result.text;
    }
  };
  growMembers();
  const names = [...new Set([...out.matchAll(/cannot find function `(\w+)`|unresolved import `[\w:]+::(\w+)`|no `(\w+)` in the root|cannot find struct, variant or union type `(\w+)`/g)].map((m) => m[1] ?? m[2] ?? m[3] ?? m[4]))].filter((n) => !modNames.has(n) && !macroNames.has(n) && new RegExp(`\\b${n}\\b`).test(fullNoUse));
  // compile-check what was written: an honest verdict instead of an assumed "Red-safe" (#130)
  /** @id CODE-R36G-002 @implements REQ-R36G-001 REQ-R36G-002 */
  const verified = () => {
    const witness = made.length || names.length ? cargoTest() : result;
    const after = witness.text;
    const err = /^error(?:\[\w+\])?: .*$/m.exec(after);
    if (witness.status === 0 && !witness.signal && !witness.error && !err) return { verified: 'ok' };
    // constructs the generator cannot stub: say which ones
    const notes = [];
    for (const m of new Set([...after.matchAll(/cannot find macro `(\w+)`/g)].map((x) => x[1]))) notes.push(`macro ${m}! is not stubbed (macro_rules! cannot be generated): define it by hand`);
    if (/cannot find trait `\w+`|not all trait items implemented|E0046|E0405/.test(after)) notes.push('trait impls / associated types are not stubbed: write the trait and its impl by hand');
    if (/E0107|E0392|type annotations needed|E0282|lifetime|generic argument/.test(after)) notes.push('generic parameters / lifetimes are not stubbed: adjust the stub signatures by hand');
    if (/mismatched types|E0308/.test(after)) notes.push('a stub return type does not match how the test uses it (Option/Result/bool/collections): fix the stub signature by hand');
    const failure = witness.error ? `Cargo compile check could not run: ${witness.error.code ?? witness.error.message}`
      : witness.signal ? `Cargo compile check terminated by signal ${witness.signal}`
        : err?.[0] ?? `Cargo compile check failed with exit status ${witness.status ?? 'unknown'} (no recognizable compiler diagnostic)`;
    return { verified: 'fail', verifyError: failure.slice(0, 160), notes };
  };
  const withNotes = (r) => { if (/\bmacro_rules!/.test(fullNoUse)) variantNotes.push('macro_rules! in the test file: macros are not stubbed, the rest is stubbed as far as it compiles — finish by hand'); if (/^\s*use\s+(?:crate|\w+)::(?:\w+::)*\*\s*;/m.test(src + '\n' + fullNoUse) || /^\s*use\s[^;]*\*\s*;/m.test(src)) variantNotes.push('wildcard `use ...::*` in the test: names are stubbed from compiler errors only (partial stubs) — check them by hand'); if (report.length) r.report = report; if (variantNotes.length) r.notes = [...(r.notes ?? []), ...variantNotes]; return r; };
  if (!names.length) { if (probeFile && !made.length) fs.rmSync(ownLib); return withNotes(Object.assign([...new Set(made)], verified())); }
  const prev = fs.readFileSync(ownLib, 'utf8');
  // names the library already defines are not appended again, and an unchanged lib.rs is never reported as stubbed (#290)
  const fresh = names.filter((n) => !new RegExp(`\\b(?:struct|enum|fn|const|static|type|trait)\\s+${n}\\b`).test(prev));
  const body0 = fresh.map((x) => stubItem(x)).join('\n'), body = body0 + implsFor(prev + body0);
  if (body.trim()) { fs.writeFileSync(ownLib, prev + (prev && !prev.endsWith('\n\n') ? '\n' : '') + body); made.push(rel(ownLib)); }
  else if (probeFile && !made.length) fs.rmSync(ownLib);
  return withNotes(Object.assign([...new Set(made)], verified()));
}

function stubJava(testPath, src, dir, add, made) {
  const pkg = /^package\s+([\w.]+);/m.exec(src)?.[1];
  // generated classes carry a marker so a later `tdd stub` can extend them; real code is never touched (#149)
  const JMARK = '// sdd-stub: throwing stub generated by `tdd stub` — replace with the real implementation\n';
  const plainAdd = add;
  add = (abs, body) => {
    if (!fs.existsSync(abs)) return plainAdd(abs, JMARK + body);
    const cur = fs.readFileSync(abs, 'utf8');
    if (!cur.startsWith('// sdd-stub')) return;
    const fresh = [...body.matchAll(/^    public [^\n]*\{\n(?:        [^\n]*\n)+    \}\n/gm)].map((m) => m[0]).filter((m) => !cur.includes(m.split('\n')[0]));
    if (!fresh.length) return;
    fs.writeFileSync(abs, cur.slice(0, cur.lastIndexOf('}')).replace(/\n*$/, '\n\n') + fresh.join('\n') + '}\n');
    made.push(rel(abs));
  };
  const imports = [...src.matchAll(/^import\s+(static\s+)?([\w.]+)\.(\w+)\s*;/gm)].map((m) => ({ st: !!m[1], p: m[2], n: m[3] }));
  // classes imported from the project's own package (same first two segments as the test) are project code to stub, not libraries (#130)
  const projPkg = (p) => pkg && p.split('.').slice(0, 2).join('.') === pkg.split('.').slice(0, 2).join('.');
  const pkgOf = new Map(imports.filter((i) => !i.st && /^[A-Z]/.test(i.n) && projPkg(i.p)).map((i) => [i.n, i.p]));
  const imported = new Set(imports.filter((i) => !pkgOf.has(i.n)).map((i) => i.n));
  // upper-case fields declared in the test (`static final Path CONTRACT = ..`) are not classes
  const local = new Set([...[...src.matchAll(/\b(?:class|interface|enum|record)\s+(\w+)/g)].map((m) => m[1]), ...[...src.matchAll(/\b[\w<>\[\],.]+\s+([A-Z][A-Z0-9_]*)\s*=/g)].map((m) => m[1])]);
  const javaFiles = new Map(listFiles().filter((f) => /\.java$/.test(f)).map((f) => {
    const text = fs.readFileSync(path.join(ROOT, f), 'utf8');
    const p = /^package\s+([\w.]+);/m.exec(text)?.[1];
    return [[p, path.basename(f, '.java')].filter(Boolean).join('.'), { file: f, text }];
  }));
  const projectWild = [...src.matchAll(/\bimport\s+([\w.]+)\.\*\s*;/g)].map((m) => m[1]);
  for (const m of src.matchAll(/\b[A-Z]\w*\b/g)) {
    const n = m[0];
    if (pkgOf.has(n) || imported.has(n) || local.has(n) || javaFiles.has([pkg, n].filter(Boolean).join('.'))) continue;
    const matches = projectWild.filter((p) => javaFiles.has(p + '.' + n));
    if (matches.length === 1) pkgOf.set(n, matches[0]);
    else if (matches.length > 1) { imported.add(n); (made.notes ??= []).push(`${n}: ambiguous project wildcard imports — not shadowed by a stub`); }
  }
  const fqOf = (n) => [pkgOf.get(n) ?? pkg, n].filter(Boolean).join('.');
  const known = { has: (n) => { const f = javaFiles.get(fqOf(n)); return f && !f.text.startsWith('// sdd-stub'); } };
  const JDK = /^(System|Math|String|Integer|Long|Double|Boolean|Character|Objects|Arrays|List|Map|Set|Collections|Optional|Thread|Assertions?|Assert|Files|Paths|Path|Instant|Duration|LocalDate|LocalDateTime|StringBuilder|Stream|Collectors|Pattern|UUID|BigDecimal|BigInteger)$/;
  // names that a java.*/javax.* wildcard import (or java.lang) already provides must never be stubbed into the project (#115)
  const wild = [...src.matchAll(/^import\s+((?:java|javax)[\w.]*)\.\*\s*;/gm)].map((m) => m[1]).concat('java.lang');
  const jdkCache = new Map();
  const isJdk = (n) => JDK.test(n) || (jdkCache.has(n) ? jdkCache.get(n) : (jdkCache.set(n, wild.some((p) => spawnSync('javap', [`${p}.${n}`], { stdio: 'ignore' }).status === 0)), jdkCache.get(n)));
  const byClass = new Map();
  for (const m of src.matchAll(/(?<![\w.])([A-Z]\w*)\.([a-z]\w*)\s*\(/g)) {
    if (imported.has(m[1]) || local.has(m[1]) || known.has(m[1]) || isJdk(m[1])) continue;
    byClass.set(m[1], [...(byClass.get(m[1]) ?? []), m[2]]);
  }
  // `new X(...)` needs a constructible class too (#76)
  const ctors = new Set();
  for (const m of src.matchAll(/\bnew\s+([A-Z]\w*)\s*\(/g)) {
    if (imported.has(m[1]) || local.has(m[1]) || known.has(m[1]) || isJdk(m[1]) || /^(Exception|RuntimeException|IllegalArgumentException|IllegalStateException|ArrayList|HashMap|HashSet|LinkedList|Object|Random|Scanner)$/.test(m[1])) continue;
    ctors.add(m[1]);
    if (!byClass.has(m[1])) byClass.set(m[1], []);
  }
  const rootRel = rel(dir);
  const mainDir = /src\/test\/java/.test(rootRel + '/') ? path.resolve(ROOT, rootRel.replace('src/test/java', 'src/main/java')) : /(^|\/)test$/.test(rootRel) ? path.resolve(dir, '../src') : dir;
  const T = { int: 'int', long: 'long', float: 'double', str: 'String', bool: 'boolean' };
  // `Cls.UPPER` (no call) => enum constant; a class used only that way becomes an enum (#76)
  const consts = new Map();
  for (const m of src.matchAll(/(?<![\w.])([A-Z]\w*)\.([A-Z][A-Z0-9_]*)\b(?!\s*\()/g)) {
    if (imported.has(m[1]) || local.has(m[1]) || known.has(m[1]) || isJdk(m[1])) continue;
    consts.set(m[1], [...new Set([...(consts.get(m[1]) ?? []), m[2]])]);
    if (!byClass.has(m[1])) byClass.set(m[1], []);
  }
  // `Outer.Inner` (Inner not a constant) is a nested type of the stubbed Outer: an enum when `Outer.Inner.K` is used, else a static class (#309)
  const nested = new Map();
  for (const m of src.matchAll(/(?<![\w.])([A-Z]\w*)\.([A-Z]\w*[a-z]\w*)\b(?!\s*\()/g)) {
    const [, o, i] = m;
    if (imported.has(o) || local.has(o) || known.has(o) || isJdk(o) || local.has(i) || /(Exception|Error)$/.test(i)) continue;
    if (!byClass.has(o)) byClass.set(o, []);
    const ks = [...new Set([...src.matchAll(new RegExp(`\\b${o}\\.${i}\\.([A-Z][A-Z0-9_]*)\\b(?!\\s*\\()`, 'g'))].map((x) => x[1]))];
    nested.set(o, { ...(nested.get(o) ?? {}), [i]: ks });
  }
  // exceptions used in assertThrows / catch / expected= / `new X(..)` / `X.class` become RuntimeException subclasses (#130)
  const excs = new Set();
  for (const m of src.matchAll(/\b(?:assertThrows|assertThatThrownBy|expected\s*=|catch\s*\(|new|extends)\s*\(?\s*([A-Z]\w*(?:Exception|Error))\b|\b([A-Z]\w*(?:Exception|Error))\.class\b/g)) {
    const n = m[1] ?? m[2];
    if (imported.has(n) || local.has(n) || known.has(n) || isJdk(n) || /^(Exception|Error|Throwable|RuntimeException|AssertionError|\w*(IllegalArgument|IllegalState|NullPointer|UnsupportedOperation|IndexOutOfBounds|Arithmetic|Number|ClassCast|IO|FileNotFound|Timeout|NoSuchElement|Interrupted|CloneNotSupported|Security|Illegal)\w*)$/.test(n)) continue;
    excs.add(n);
    byClass.delete(n);
  }
  // `Type v = <call>` / `Type v = new ..` where Type is a project class nobody defined: it must exist for the stub to compile
  const javaRoot = pkg && mainDir.endsWith(path.join(...pkg.split('.'))) ? mainDir.slice(0, mainDir.length - path.join(...pkg.split('.')).length - 1) : mainDir;
  const fileOf = (cls) => pkgOf.has(cls) ? path.join(javaRoot, ...pkgOf.get(cls).split('.'), cls + '.java') : path.join(mainDir, cls + '.java');
  const pkgLine = (cls) => { const p = pkgOf.get(cls) ?? pkg; return p ? `package ${p};\n\n` : ''; };
  for (const n of excs) add(fileOf(n), `${pkgLine(n)}public class ${n} extends RuntimeException {\n    public ${n}() {\n        super();\n    }\n\n    public ${n}(String message) {\n        super(message);\n    }\n}\n`);
  // return type of a call: declared type (`T v = ..m(`), enum constant it is compared with, a static factory returns its own class, else a literal it is compared with (never when the call is chained)
  // only when the call is the whole initializer: `T v = x.m(..);` not `T v = x.m(..).n()`
  const allDecl = (n, st, cls) => {
    const re = new RegExp(`\\b(int|long|double|boolean|String|[A-Z]\\w*(?:<[^;=()]*>)?)\\s+\\w+\\s*=\\s*(?:\\([\\w<>]+\\)\\s*)?${st ? `${cls}\\.` : '(?:[\\w.()"]*\\.)?'}${n}\\s*\\(`, 'g');
    for (let m; (m = re.exec(src));) { let depth = 1, k = re.lastIndex; for (; k < src.length && depth; k++) { if (src[k] === '(') depth++; else if (src[k] === ')') depth--; } if (!/^\s*\./.test(src.slice(k))) return m[1]; }
    return undefined;
  };
  const enumCmp = (n) => new RegExp(`assert(?:Equals|Same)\\(\\s*([A-Z]\\w*)\\.[A-Z][A-Z0-9_]*\\s*,\\s*[\\w.()",\\s]*?\\.${n}\\s*\\(`).exec(src)?.[1];
  const chain = (n) => new RegExp(`\\.${n}\\s*\\((?:[^()]|\\((?:[^()]|\\([^()]*\\))*\\))*\\)\\s*\\.\\s*([a-z]\\w*)\\s*\\(`).exec(src)?.[1];
  const arities = (n, text, st) => { const re = new RegExp(`(?<![\\w${st ? '.' : ''}])${n}\\s*\\(`, 'g'); const seen = new Map(); let m; while ((m = re.exec(text))) { const c = callInfo(text.slice(Math.max(0, m.index - 60)), n); if (!seen.has(c.args.length)) seen.set(c.args.length, c); else if (!seen.get(c.args.length).ret && c.ret) seen.set(c.args.length, c); } return [...seen.values()]; };
  // same-arity calls whose declared result types differ (`int a = c.f(1); String b = c.f("x")`) need typed overloads, not one Object signature (#309)
  const typedOverloads = (n, text, st) => {
    const re = new RegExp(`(?<![\\w${st ? '.' : ''}])${n}\\s*\\(`, 'g'), byAr = new Map(); let m;
    while ((m = re.exec(text))) {
      const decl = /\b(int|long|double|boolean|String)\s+\w+\s*=\s*(?:[\w.()"]*\.)?$/.exec(text.slice(Math.max(0, m.index - 80), m.index))?.[1];
      const c = callInfo(text.slice(m.index), n), key = c.args.join(',') + '>' + decl;
      if (!decl || c.chained) continue;
      byAr.set(c.args.length, [...(byAr.get(c.args.length) ?? []), { c, decl, key }]);
    }
    return [...byAr.values()].filter((v) => new Set(v.map((x) => x.decl)).size > 1).map((v) => [v[0].c.args.length, [...new Map(v.map((x) => [x.key, x])).values()]]);
  };
  const chainClasses = new Map();
  const retOf = (cls, n, c, isStatic, text) => {
    const d = allDecl(n, isStatic, cls);
    if (d && !/^var$/.test(d)) return d;
    const e = enumCmp(n);
    if (e) return e;
    const ch = chain(n);
    if (ch && !(isStatic && !/^(size|isEmpty|stream|iterator|forEach)$/.test(ch) && /^(of|create|from|zero|empty|parse|valueOf|none|one|default\w*|new\w*|with\w*|unit)$/.test(n))) { const rc = n[0].toUpperCase() + n.slice(1) + 'Result'; chainClasses.set(rc, [...new Set([...(chainClasses.get(rc) ?? []), ch])]); return rc; }
    if (isStatic && /^(of|create|from|zero|empty|parse|valueOf|none|one|default\w*|new\w*|with\w*|unit)$/.test(n) && !c.ret) return cls;
    return c.ret && !c.chained ? (T[c.ret] ?? 'int') : 'int';
  };
  const sigs = (cls, n, text, isStatic) => { const ty = new Map(typedOverloads(n, text, isStatic)); return arities(n, text, isStatic).flatMap((c) => ty.has(c.args.length) ? ty.get(c.args.length).map(({ c: v, decl }) => ({ ...v, decl })) : [c]).map((c) => c.decl ? `    public ${isStatic ? 'static ' : ''}${c.decl} ${n}(${c.args.map((t, i) => `${T[t] ?? 'Object'} a${i}`).join(', ')}) {\n        throw new UnsupportedOperationException("not implemented: ${isStatic ? '' : cls + '.'}${n}");\n    }\n` : `    public ${isStatic ? 'static ' : ''}${retOf(cls, n, c, isStatic, text)} ${n}(${c.args.map((_, i) => `Object a${i}`).join(', ')}) {\n        throw new UnsupportedOperationException("not implemented: ${isStatic ? '' : cls + '.'}${n}");\n    }\n`).join('\n'); };
  // receivers: `new Cls(..).m(`, variables built from Cls, variables declared `Cls v`, and `Cls.factory(..).m(`
  const instOf = (cls) => {
    const ms = new Set(methodsOf(src, cls));
    // a variable name reused for another type in a later block belongs to the nearest preceding declaration (#296)
    const declRe = /\b([A-Z]\w*(?:<[^;=()]*>)?|int|long|double|boolean|String|var)\s+([a-z]\w*)\s*(?:=|;|,|\)|:)/g;
    const decls = [...src.matchAll(declRe)].map((m) => ({ t: m[1].replace(/<.*/, ''), v: m[2], at: m.index }));
    for (const d of decls) {
      if (d.t !== cls) continue;
      for (const m of src.matchAll(new RegExp(`(?<![\\w.])${d.v}\\s*\\.\\s*([a-z]\\w*)\\s*\\(`, 'g'))) {
        const owner = decls.filter((o) => o.v === d.v && o.at < m.index).pop();
        if (owner === d) ms.add(m[1]);
      }
    }
    for (const m of src.matchAll(new RegExp(`\\b${cls}\\.[a-z]\\w*\\s*\\((?:[^()]|\\([^()]*\\))*\\)\\s*\\.\\s*([a-z]\\w*)\\s*\\(`, 'g'))) ms.add(m[1]);
    return [...ms].filter((k) => !/^(equals|hashCode|toString|getClass|compareTo|assert\w*)$/.test(k));
  };
  for (const m of src.matchAll(/\b([A-Z]\w*)\s+\w+\s*=\s*(?:new\s+\1\s*\(|\1\.[a-z]\w*\s*\()|\b([A-Z]\w*)\s+\w+\s*=\s*[\w.]+\.[a-z]\w*\s*\(/g)) {
    const c = m[1] ?? m[2];
    if (c && !byClass.has(c) && !excs.has(c) && !imported.has(c) && !local.has(c) && !known.has(c) && !isJdk(c) && !/^(Object|Exception|Throwable)$/.test(c)) byClass.set(c, []);
  }
  // `for (Item i : xs)` names a project class too (#296)
  for (const m of src.matchAll(/\bfor\s*\(\s*(?:final\s+)?([A-Z]\w*)\s+\w+\s*:/g)) {
    const c = m[1];
    if (!byClass.has(c) && !excs.has(c) && !imported.has(c) && !local.has(c) && !known.has(c) && !isJdk(c) && !/^(Object|Exception|Throwable|Integer|Long|Double|String|Boolean|Character)$/.test(c)) byClass.set(c, []);
  }
  // element types of declared generic results (`List<Token> ts = ..`) must exist too (#149)
  for (const m of src.matchAll(/\b(?:List|Set|Optional|Collection|Iterable|Stream|Deque|Queue)<([A-Z]\w*)>\s+\w+\s*=\s*[\w.]+\.[a-z]\w*\s*\(/g)) {
    const c = m[1];
    if (!byClass.has(c) && !excs.has(c) && !imported.has(c) && !local.has(c) && !known.has(c) && !isJdk(c) && !/^(Object|Exception|Throwable|Integer|Long|Double|String|Boolean|Character)$/.test(c)) byClass.set(c, []);
  }
  for (const cls of new Set([...src.matchAll(/(?<![\w.])([A-Z]\w*)\.[a-z]\w*\s*\(/g)].map((m) => m[1]))) {
    const f = javaFiles.get(fqOf(cls))?.file;
    if (!f || local.has(cls)) continue;
    const text = fs.readFileSync(path.join(ROOT, f), 'utf8');
    if (text.startsWith('// sdd-stub')) continue;
    const miss = [...new Set([...src.matchAll(new RegExp(`(?<![\\w.])${cls}\\.([a-z]\\w*)\\s*\\(`, 'g'))].map((m) => m[1]))].filter((n) => !new RegExp(`\\b${n}\\s*\\(`).test(text));
    if (miss.length) (made.realMissing ??= []).push(`${miss.join(', ')} in ${f}`);
  }
  for (const [cls, ms] of byClass) {
    if (consts.has(cls) && !ms.length && !ctors.has(cls)) { add(fileOf(cls), `${pkgLine(cls)}public enum ${cls} {\n    ${consts.get(cls).join(', ')}\n}\n`); continue; }
    const cc = consts.get(cls)?.map((k) => `    public static final int ${k} = 0;\n`).join('') ?? '';
    const ctorSrc = ctors.has(cls) ? callInfo(src.replace(new RegExp(`\\bnew\\s+${cls}\\s*\\(`, 'g'), `${cls}(`), cls) : null;
    const ctorDecl = ctorSrc ? `    public ${cls}(${ctorSrc.args.map((t, i) => `${T[t] ?? 'Object'} a${i}`).join(', ')}) {${throwCtor() ? `\n        throw new UnsupportedOperationException("not implemented: ${cls}");\n    ` : ''}}\n` : '';
    const body = [...new Set(ms)].map((n) => sigs(cls, n, src.replace(new RegExp(`\\b${cls}\\.`, 'g'), ''), true)).join('\n');
    const inst = instOf(cls).filter((n) => !ms.includes(n)).map((n) => sigs(cls, n, src.replace(/\b\w+\./g, '').replace(/\)\s*\.\s*/g, ') '), false)).join('\n');
    const all = [body, inst].filter(Boolean).join('\n');
    const nest = Object.entries(nested.get(cls) ?? {}).map(([i, ks]) => ks.length ? `    public enum ${i} { ${ks.join(', ')} }\n` : `    public static class ${i} {}\n`).join('');
    add(fileOf(cls), `${pkgLine(cls)}${/<|\bList\b|\bMap\b/.test(all) ? 'import java.util.*;\n\n' : ''}public class ${cls} {\n${cc}${ctorDecl}${nest}${(cc || ctorDecl || nest) && all ? '\n' : ''}${all}}\n`);
  }
  // `foo().bar()` results get their own class so the chain compiles
  // a chained result that is iterated/streamed (`.stream()`, `.get(0)`, `.size()`) is a list so the chain compiles (#149)
  const COLL = /^(get|stream|size|isEmpty|contains|iterator|forEach|add|first|last)$/;
  for (const [rc, ms] of chainClasses) add(path.join(mainDir, rc + '.java'), `${pkg ? `package ${pkg};\n\n` : ''}${ms.some((k) => COLL.test(k)) ? 'import java.util.*;\n\n' : ''}public class ${rc}${ms.some((k) => COLL.test(k)) ? ' extends ArrayList<Object>' : ''} {\n${ms.filter((k) => !COLL.test(k)).map((k) => sigs(rc, k, src.replace(/\b\w+\./g, '').replace(/\)\s*\.\s*/g, ') '), false)).join('\n')}}\n`);
  return made;
}

function stubC(testPath, src, dir, add, made) {
  const cpp = /\.(cc|cpp|cxx)$/.test(testPath);
  // in a `projects` monorepo the C project root (nearest CMakeLists/compile_commands) holds include/ and build/ (#248)
  let projRoot = ROOT;
  for (let d = dir; d.startsWith(ROOT); d = path.dirname(d)) {
    if (['CMakeLists.txt', 'compile_commands.json', 'build/compile_commands.json'].some((f) => fs.existsSync(path.join(d, f)))) { projRoot = d; break; }
    if (d === ROOT) break;
  }
  const roots = [...new Set([projRoot, ROOT])];
  const missing = [...src.matchAll(/#include\s+"([^"]+)"/g)].map((m) => m[1]).filter((h) => !fs.existsSync(path.resolve(dir, h)) && !roots.some((b) => ['', 'include', 'src'].some((x) => fs.existsSync(path.resolve(b, x, h)))));
  const cc = cpp ? 'c++' : 'cc';
  const incs = [dir, ...roots.flatMap((b) => [...['include', 'src'].map((d) => path.join(b, d)), b])].flatMap((d) => ['-I', d]);
  let standard = [];
  for (let d = dir; d.startsWith(ROOT); d = path.dirname(d)) {
    try {
      const cmake = fs.readFileSync(path.join(d, 'CMakeLists.txt'), 'utf8');
      const levels = [...cmake.matchAll(cpp ? /CMAKE_CXX_STANDARD\s+(\d+)|cxx_std_(\d+)/g : /CMAKE_C_STANDARD\s+(\d+)|c_std_(\d+)/g)].map((m) => +(m[1] ?? m[2]));
      if (levels.length) { standard = [`-std=${cpp ? 'c++' : 'c'}${Math.max(...levels)}`]; break; }
    } catch {}
    if (d === ROOT) break;
  }
  let compile = { cc, args: [...standard, ...incs], cwd: dir };
  for (const home of new Set([dir, projRoot, path.join(projRoot, 'build'), ROOT, path.join(ROOT, 'build')])) {
    const commands = readJson(path.join(home, 'compile_commands.json'), []);
    const entry = commands.find((e) => path.resolve(e.directory ?? home, e.file ?? '') === path.resolve(ROOT, testPath));
    if (!entry) continue;
    const args = entry.arguments ?? entry.command?.match(/(?:[^\s"'\\]|\\.|"(?:\\.|[^"\\])*"|'[^']*')+/g)?.map((a) => a.replace(/^(['"])([\s\S]*)\1$/, '$2'));
    if (!args?.length) continue;
    const cwd = path.resolve(home, entry.directory ?? '.');
    const options = [];
    for (let i = 1; i < args.length; i++) {
      if (['-o', '-MF', '-MT', '-MQ'].includes(args[i])) { i++; continue; }
      if (['-c', '-MD', '-MMD'].includes(args[i]) || path.resolve(cwd, args[i]) === path.resolve(ROOT, testPath)) continue;
      options.push(args[i]);
    }
    compile = { cc: args[0], args: options, cwd };
    break;
  }
  // compile-check the result: an honest verdict instead of an assumed "Red-safe" (#130)
  /** @id CODE-R36I-002 @implements REQ-R36I-001 REQ-R36I-002 */
  const syntax = () => {
    const r = probeOutcome(compile.cc, ['-fsyntax-only', ...compile.args, path.join(ROOT, testPath)], compile.cwd);
    return { ...r, text: r.text.replace(/\x1b\[[0-9;]*m/g, '') };
  };
  const verified = () => {
    const r = syntax();
    const e = /^[^\n]*\berror:.*$/m.exec(r.text);
    if (r.status === 0 && !r.signal && !r.error && !e) return { verified: 'ok' };
    const diagnostic = e?.[0].replace(ROOT + '/', '').slice(0, 160);
    const reason = r.error ? `C/C++ compile check failed with error ${r.error.code ?? r.error.message}`
      : r.signal ? `C/C++ compile check terminated by signal ${r.signal}`
        : r.status == null ? 'C/C++ compile check failed: status unavailable'
          : r.status !== 0 ? `C/C++ compile check failed with exit status ${r.status}`
            : null;
    return { verified: 'fail', verifyError: reason ? `${reason}${diagnostic ? `; ${diagnostic}` : ''}` : diagnostic };
  };
  if (!missing.length) return Object.assign(made, verified());
  for (const h of missing) { fs.mkdirSync(path.dirname(path.resolve(dir, h)), { recursive: true }); fs.writeFileSync(path.resolve(dir, h), ''); }
  const out = syntax().text;
  // anything an already-present project header declares must not be redeclared (#96)
  const present = gitFiles('*.h').concat(gitFiles('*.hpp')).map((f) => { try { return fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch { return ''; } }).join('\n');
  const declared = (n) => new RegExp(`\\b${n}\\s*\\(`).test(present);
  // C++ classes the test constructs (`lsm::BloomFilter f(1000, 0.01); f.add("a");`) become throwing class stubs, not functions (#149)
  const cppCls = new Map();
  const cppVars = new Set();
  if (cpp) {
    const lit = { int: 'int', float: 'double', str: 'std::string', bool: 'bool' };
    // `using cq::mem::Arena;` places the unqualified `Arena` in `cq::mem` (#221)
    const usingOf = new Map([...src.matchAll(/^\s*using\s+((?:[A-Za-z_]\w*::)+)([A-Z]\w*)\s*;/gm)].filter((m) => !/^std::/.test(m[1])).map((m) => [m[2], m[1]]));
    const nsOf = (ns, c) => ns || usingOf.get(c) || '';
    const get = (ns, c) => { const k = ns + c; if (!cppCls.has(k)) cppCls.set(k, { ns: ns.replace(/::$/, ''), c, ms: new Map() }); return cppCls.get(k); };
    const present0 = gitFiles('*.h').concat(gitFiles('*.hpp')).map((f) => { try { return fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch { return ''; } }).join('\n');
    for (const m of src.matchAll(/(?<![\w:<])((?:[a-z_]\w*::)*)([A-Z]\w*)\s+(\w+)\s*(?:\([^;]*\)|\{[^;]*\})?\s*;/g)) {
      if (/^std::/.test(m[1]) || /^(?:return|delete|new|throw|case)$/.test(m[2]) || new RegExp(`\\b(?:class|struct)\\s+${m[2]}\\b`).test(present0)) continue;
      m[1] = nsOf(m[1], m[2]);
      get(m[1], m[2]);
      cppVars.add(m[3]);
      const mine = [...src.matchAll(new RegExp(`(?<![\\w.>])${m[3]}\\s*\\.\\s*(\\w+)\\s*\\(`, 'g'))];
      for (const u of mine) { const c = callInfo(src.replace(new RegExp(`(?<![\\w.>])${m[3]}\\s*\\.\\s*`, 'g'), ''), u[1]); get(m[1], m[2]).ms.set(u[1], { ret: lit[c.ret] ?? 'int', st: false }); }
    }
    for (const m of src.matchAll(/(?<![\w:<])((?:[a-z_]\w*::)*)([A-Z]\w*)::([a-z_]\w*)\s*\(/g)) {
      m[1] = nsOf(m[1], m[2]);
      if (!cppCls.has(m[1] + m[2])) continue;
      const o = get(m[1], m[2]);
      if (!o.ms.has(m[3])) o.ms.set(m[3], { ret: new RegExp(`\\b${m[2]}\\s+\\w+\\s*=\\s*(?:[\\w:]*::)?${m[2]}::${m[3]}\\s*\\(`).test(src) ? m[2] : 'int', st: true });
    }
  }
  const cppBody = [...cppCls.values()].map((o) => `${o.ns ? `namespace ${o.ns.replace(/::/g, ' { namespace ')} {\n` : ''}class ${o.c} {\npublic:\n    ${o.c}() = default;\n    ${o.c}(const ${o.c}&) = default;\n    template <class A0, class... A>\n    explicit ${o.c}(A0&&, A&&...) {}\n${[...o.ms].map(([k, v]) => `    template <class... A>\n    ${v.st ? 'static ' : ''}${v.ret} ${k}(A&&...) { throw std::logic_error("not implemented: ${o.c}::${k}"); }\n`).join('')}};\n${o.ns ? '}'.repeat(o.ns.split('::').length) + '\n' : ''}`).join('\n');
  const names = [...new Set([...out.matchAll(/implicit declaration of function '(\w+)'|'(\w+)' was not declared in this scope|use of undeclared identifier '(\w+)'|call to undeclared function '(\w+)'/g)].map((m) => m[1] ?? m[2] ?? m[3] ?? m[4]))].filter((n) => !declared(n) && !cppVars.has(n) && new RegExp(`(?<![\\w.>])${n}\\s*\\(`).test(src));
  const T = { int: 'int', float: 'double', str: 'const char *', bool: 'int' };
  // `arena_t *a = ...; f(a)` => the parameter is `arena_t *` (#87)
  const declaredPtr = (expr) => { const v = /^&?([A-Za-z_]\w*)$/.exec(expr ?? '')?.[1]; const m = v && new RegExp(`\\b((?:const\\s+)?(?:struct\\s+)?[A-Za-z_]\\w*)\\s*(\\*+)\\s*${v}\\b`).exec(src); return m && !/^(return|else|sizeof)$/.test(m[1]) ? `${m[1]} ${m[2]}` : null; };
  // unknown `foo_t` types become opaque structs so pointer use compiles
  const SYS = /^(size_t|ssize_t|ptrdiff_t|intptr_t|uintptr_t|u?int\d+_t|u?intmax_t|time_t|clock_t|off_t|wchar_t|FILE|va_list|bool|sig_atomic_t|pid_t|mode_t|jmp_buf|div_t|fpos_t|pthread_\w+)$/;
  const opaque = [...new Set([...src.matchAll(/\b([a-z_][a-z0-9_]*_t)\b/g)].map((m) => m[1]))].filter((t) => !SYS.test(t) && !new RegExp(`\\b${t}\\b`).test(present) && !new RegExp(`typedef[^;{]*\\b${t}\\b|\\b(?:struct|enum|union)\\s+\\w*\\s*\\{[^}]*\\}\\s*${t}\\b`).test(src));
  // an opaque type whose fields the test reads (`e->vlen`, `v.x`) needs a complete struct (#130)
  const fieldsOf = (t) => { const vs = [...src.matchAll(new RegExp(`\\b${t}\\s*(\\*+\\s*)?(\\w+)\\s*[=;,)\\[]`, 'g'))].map((m) => [m[2], !!m[1]]); return [...new Set(vs.flatMap(([v, ptr]) => [...src.matchAll(new RegExp(`(?<![\\w.>])${v}\\s*${ptr ? '->' : '\\.'}\\s*(\\w+)`, 'g'))].map((m) => m[1])))]; };
  const body0 = opaque.map((t) => { const fs2 = fieldsOf(t); return fs2.length ? `typedef struct ${t.replace(/_t$/, '')} {\n${fs2.map((f) => `    long ${f};\n`).join('')}} ${t};\n` : `typedef struct ${t.replace(/_t$/, '')} ${t};\n`; }).join('') + (opaque.length ? '\n' : '');
  const SCALAR = /^(?:const\s+)?(?:unsigned\s+|signed\s+)?(?:int|long|short|char|float|double|size_t|ssize_t|u?int\d+_t|\w+_t)$/;
  // pointer/array/scalar argument types from casts, `&x`, declarations and arrays (#130)
  const argType = (raw, t) => {
    if (T[t]) return T[t];
    const r = (raw ?? '').trim();
    const cast = /^\(\s*((?:const\s+)?(?:struct\s+)?[A-Za-z_]\w*(?:\s*\*)*)\s*\)\s*[\w&"(*-]/.exec(r)?.[1];
    if (cast) return cast.replace(/\s*\*/g, ' *').replace(/\s+/g, ' ').replace(/ \*( \*)/g, ' *$1');
    const addr = /^&\s*(\w+)/.exec(r)?.[1];
    if (addr) { const d = new RegExp(`\\b((?:const\\s+)?(?:struct\\s+)?[A-Za-z_]\\w*)\\s+${addr}\\b\\s*[=;,\\[]`).exec(src)?.[1]; return d && !/^(return|else)$/.test(d) ? `${d} *` : 'void *'; }
    const v = /^[A-Za-z_]\w*$/.exec(r)?.[0];
    if (v) {
      const arr = new RegExp(`\\b((?:const\\s+)?[A-Za-z_]\\w*)\\s+${v}\\s*\\[`).exec(src)?.[1];
      if (arr && !/^(return|else)$/.test(arr)) return `${arr} *`;
      const sc = new RegExp(`\\b((?:const\\s+)?(?:unsigned\\s+)?[A-Za-z_]\\w*)\\s+${v}\\s*[=;,)]`).exec(src)?.[1];
      if (sc && SCALAR.test(sc)) return sc;
    }
    return declaredPtr(raw);
  };
  const body = body0 + (cppBody ? cppBody + '\n' : '') + names.map((n) => {
    const c = callInfo(src, n), pt = new RegExp(`\\b((?:const\\s+)?(?:struct\\s+)?[A-Za-z_]\\w*)\\s*\\*\\s*\\w+\\s*=\\s*${n}\\s*\\(`).exec(src)?.[1], r = pt && !cpp ? (opaque.includes(pt) ? `${pt} *` : 'void *') : T[c.ret] ?? 'int';
    if (cpp) return `template <class... A>\ninline ${r} ${n}(A&&...) {\n    throw std::logic_error("not implemented: ${n}");\n}\n`;
    const ps = c.args.map((t, i) => `${t === 'ptr' ? 'void *' : argType(c.raws?.[i], t) ?? 'int'} a${i}`).join(', ') || 'void';
    const unused = c.args.map((_, i) => `    (void)a${i};\n`).join('');
    return `static inline ${r} ${n}(${ps}) {\n${unused}    fprintf(stderr, "not implemented: ${n}\\n");\n    abort();\n}\n`;
  }).join('\n');
  const head = cpp ? '#pragma once\n#include <stdexcept>\n#include <string>\n\n' : '#pragma once\n#include <stdio.h>\n#include <stdlib.h>\n\n';
  // a missing header belongs next to the production code (include/ or src/), not in tests/ where it would shadow it (#76)
  const home = roots.flatMap((b) => ['include', 'src'].map((d) => path.join(b, d))).find((d) => fs.existsSync(d) && !path.resolve(dir).startsWith(d));
  for (const h of missing) { fs.rmSync(path.resolve(dir, h)); add(home ? path.join(home, h) : path.resolve(dir, h), head + body); }
  return Object.assign(made, verified());
}

// php / julia / R: stub the file the test loads (require/include/source) with throwing functions for the unknown calls
function stubScript(lang, src, dir, add, made) {
  // Julia `include(joinpath(@__DIR__, "..", "src", "Q.jl"))` resolves like the literal relative path (#240)
  if (lang === 'jl') src = src.replace(/\binclude\(\s*(?:Base\.)?joinpath\(\s*@__DIR__\s*,\s*((?:"[^"\n]*"\s*,?\s*)+)\)\s*\)/g, (m, parts) => `include("${[...parts.matchAll(/"([^"\n]*)"/g)].map((x) => x[1]).join('/')}")`);
  const loadRe = { php: /(?:require|include)(?:_once)?\s*\(?\s*(?:__DIR__\s*\.\s*)?['"]([^'"]+\.php)['"]/g, jl: /\binclude\(\s*"([^"]+\.jl)"/g, r: /\bsource\(\s*"([^"]+\.[Rr])"/g }[lang];
  const code = src.split('\n').filter((l) => !/^\s*(#|\/\/|\*|\/\*)/.test(l)).join('\n');
  const defined = new Set([...code.matchAll(/\bfunction\s+&?([A-Za-z_]\w*!?)|^\s*([A-Za-z_]\w*)\s*<-\s*function|^\s*([A-Za-z_]\w*!?)\(.*\)\s*=(?!=)/gm)].map((m) => m[1] ?? m[2] ?? m[3]));
  // names the test defines itself (`const f(x) = ..`, `f = x -> ..`, `f, g = pair`, structs) and names already provided by included files that exist are never stubbed (#131)
  if (lang === 'jl') {
    for (const m of code.matchAll(/^\s*(?:const\s+|local\s+|global\s+)?(?:mutable\s+)?struct\s+(\w+)|^\s*(?:const\s+|local\s+|global\s+)(\w+)\s*\(/gm)) defined.add(m[1] ?? m[2]);
    for (const m of code.matchAll(/^\s*(?:(?:const|local|global)\s+)?([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s*=(?![=>])/gm)) m[1].split(',').forEach((x) => defined.add(x.trim()));
  }
  const existingLoads = [...src.matchAll(loadRe)].map((m) => path.resolve(dir, m[1].replace(/^\/+/, ''))).filter((abs) => fs.existsSync(abs));
  const visitedLoads = new Set();
  const existingDefinitions = (abs) => {
    if (visitedLoads.has(abs)) return;
    visitedLoads.add(abs);
    const t = fs.readFileSync(abs, 'utf8');
    for (const m of t.matchAll(/\bfunction\s+&?([A-Za-z_]\w*!?)|^\s*([A-Za-z_]\w*!?)\s*(?:<-\s*function|\(.*\)\s*=(?!=))|\b(?:struct|macro|abstract\s+type)\s+(\w+)/gm)) defined.add(m[1] ?? m[2] ?? m[3]);
    if (lang === 'jl') for (const m of t.matchAll(loadRe)) {
      const next = path.resolve(path.dirname(abs), m[1]);
      if (next.startsWith(ROOT + path.sep) && fs.existsSync(next) && fs.statSync(next).isFile()) existingDefinitions(next);
    }
  };
  for (const abs of existingLoads) existingDefinitions(abs);
  // testthat autoloads helper-*.R / setup-*.R before the test: what they define must not be shadowed by a stub (#224)
  if (lang === 'r') for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) if (/^(?:helper|setup)[^/]*\.[Rr]$/i.test(f)) { existingDefinitions(path.join(dir, f)); for (const m of fs.readFileSync(path.join(dir, f), 'utf8').matchAll(/^\s*([A-Za-z_]\w*)\s*=\s*function\b/gm)) defined.add(m[1]); }
  // Julia mutating functions end in `!` (`next!(r)`) (#151)
  const called = [...new Set([...code.matchAll(/(?<![\w$@.>:\\])([A-Za-z_]\w*(?:!(?=\())?)\s*\(/g)].map((m) => m[1]))].filter((n) => !defined.has(n) && !/^(function|if|for|while|switch|catch|elseif|foreach|array|isset|empty|use|using|test_that|testset|require|require_once|include|include_once|source|library|describe|it|context|fn|match|list|new|echo|print|return|exit|die|unset|isset|empty|eval|declare|static|function|assert|try|throw)$/.test(n) && !/^(expect_|test|assert)/.test(n));
  // exception types the Julia test expects: `@test_throws X` => `struct X <: Exception end`
  const excNames = lang === 'jl' ? [...new Set([...code.matchAll(/@test_throws\s+(?:\w+\.)?([A-Z]\w*)/g)].map((m) => m[1]))].filter((n) => !defined.has(n)) : [];
  const juliaImports = code.split('\n').filter((l) => /^\s*(using|import)\s+[^.]/.test(l));
  const probe = { php: ['php', ['-r', 'foreach (array_slice($argv, 1) as $n) if (!function_exists($n)) echo $n, "\n";', '--', ...called]], jl: ['julia', ['--project=' + ROOT, '-e', `${juliaImports.map((l) => `try; ${l}; catch; end`).join('\n')}\nfor n in ARGS; (isdefined(Main, Symbol(n)) || isdefined(Base, Symbol(n))) || println(n); end`, ...called, ...excNames]], r: ['Rscript', ['-e', 'for (n in commandArgs(TRUE)) if (!exists(n)) cat(n, "\n", sep = "")', ...called]] }[lang];
  let unknown = [...called, ...excNames];
  if (unknown.length) { const r = spawnSync(probe[0], probe[1], { encoding: 'utf8', timeout: 60000 }); if (r.status === 0) unknown = r.stdout.split('\n').filter(Boolean); }
  const fn = { php: (n) => `if (!function_exists('${n}')) {\n    function ${n}(...$args) {\n        throw new \\LogicException('not implemented: ${n}');\n    }\n}\n`, jl: (n) => `${n}(args...; kwargs...) = error("not implemented: ${n}")\n`, r: (n) => `${n} <- function(...) stop("not implemented: ${n}")\n` }[lang];
  // PHP classes used as Class::method( / new Class( get a class with throwing static methods (#87)
  const phpClasses = new Map();
  const exc = new Set();
  let psrDone = false;
  // instance methods called on `$v = new C(..)`, `$this->v = new C(..)` and `(new C(..))->m()` receivers (#131)
  const phpInst = (c) => {
    const ms = new Set();
    for (const m of code.matchAll(new RegExp(`(\\$this\\s*->\\s*\\w+|\\$\\w+)\\s*=\\s*new\\s+\\\\?${c}\\b`, 'g'))) for (const k of code.matchAll(new RegExp(`${m[1].replace(/\$/g, '\\$').replace(/\s*->\s*/, '\\s*->\\s*')}\\s*->\\s*(\\w+)\\s*\\(`, 'g'))) ms.add(k[1]);
    for (const k of code.matchAll(new RegExp(`new\\s+\\\\?${c}\\s*\\([^()]*\\)\\s*\\)?\\s*->\\s*(\\w+)\\s*\\(`, 'g'))) ms.add(k[1]);
    return [...ms].filter((k) => !/^(assert\w*|expect\w*|__\w+)$/.test(k));
  };
  const phpConsts = new Map(), phpEnums = new Set(), phpEnumInst = new Map();
  const classBody = (c, ms) => phpEnums.has(c) ? `enum ${c}: string\n{\n${[...[...(phpConsts.get(c) ?? [])].map((k) => `    case ${k} = '${k}';\n`), ...[...ms].map((n) => `\n    public static function ${n}(...$args)\n    {\n        throw new \\LogicException('not implemented: ${c}::${n}');\n    }\n`), ...[...(phpEnumInst.get(c) ?? [])].filter((n) => !ms.has(n)).map((n) => `\n    public function ${n}(...$args)\n    {\n        throw new \\LogicException('not implemented: ${c}->${n}');\n    }\n`)].join('')}}\n` : exc.has(c) ? `class ${c} extends \\Exception\n{\n}\n` : `class ${c}\n{\n${[...[...(phpConsts.get(c) ?? [])].map((k) => `    public const ${k} = '${k}';\n`), ...[...ms].map((n) => `    public static function ${n}(...$args)\n    {\n        throw new \\LogicException('not implemented: ${c}::${n}');\n    }\n`), ...phpInst(c).filter((n) => !ms.has(n)).map((n) => `    public function ${n}(...$args)\n    {\n        throw new \\LogicException('not implemented: ${c}->${n}');\n    }\n`)].join('\n')}}\n`;
  if (lang === 'php') {
    for (const m of code.matchAll(/(?<![\w$\\])([A-Z]\w*)::([A-Za-z_]\w*)\s*\(/g)) phpClasses.set(m[1], new Set([...(phpClasses.get(m[1]) ?? []), m[2]]));
    for (const m of code.matchAll(/\bnew\s+([A-Z]\w*)/g)) if (!phpClasses.has(m[1])) phpClasses.set(m[1], new Set());
    // `Cls::CONST` / `Enum::CASE->value` reference a class too: constants become `const`s, enum-style use (`->value`/`->name`) an enum (#150)
    // a CamelCase `Cls::Case`, or any `Cls::NAME->member`, is an enum case; `->method(` on it is an instance method of the enum (#222)
    for (const m of code.matchAll(/(?<![\w$\\])([A-Z]\w*)::([A-Za-z_]\w*)\b(?!\s*\()(\s*->\s*(\w+)(\s*\()?)?/g)) {
      const caseLike = /^[A-Z]\w*$/.test(m[2]) && /[a-z]/.test(m[2]);
      if (m[2] === 'class' || !(m[3] || caseLike || /^[A-Z][A-Z0-9_]*$/.test(m[2]))) continue;
      if (!phpClasses.has(m[1])) phpClasses.set(m[1], new Set());
      phpConsts.set(m[1], new Set([...(phpConsts.get(m[1]) ?? []), m[2]]));
      if (m[3] || caseLike) phpEnums.add(m[1]);
      if (m[5] && !/^(value|name)$/.test(m[4])) phpEnumInst.set(m[1], new Set([...(phpEnumInst.get(m[1]) ?? []), m[4]]));
    }
    for (const c of [...phpClasses.keys()]) if (new RegExp(`\\b(?:class|interface|enum)\\s+${c}\\b`).test(code) || /^(self|static|parent|DateTime\w*|Exception|\w*Exception|Closure|ArrayObject|ArrayIterator|stdClass|Throwable|Error|Generator|SplStack|SplQueue|SplObjectStorage|JsonException|DateInterval|DateTimeZone)$/.test(c)) phpClasses.delete(c);
    for (const m of code.matchAll(/expectException\(\s*\\?([A-Z]\w*)::class/g)) { exc.add(m[1]); if (!phpClasses.has(m[1])) phpClasses.set(m[1], new Set()); }
    // `catch (X $e)` / `throw new X` / `class Y extends X`: X is an exception (#131)
    for (const m of code.matchAll(/\bcatch\s*\(\s*([\\\w|\s]+?)\s*\$/g)) for (const x of m[1].split('|')) { const n = x.trim().replace(/^\\/, ''); if (/^[A-Z]\w*$/.test(n)) { exc.add(n); if (!phpClasses.has(n)) phpClasses.set(n, new Set()); } }
    for (const m of code.matchAll(/\bthrow\s+new\s+\\?([A-Z]\w*)/g)) { exc.add(m[1]); if (!phpClasses.has(m[1])) phpClasses.set(m[1], new Set()); }
    // classes already defined in the project, or built into PHP, are never stubbed (#95)
    const projFq = phpProjectFqcns();
    // `use Ns\Cls;` binds the short name to a FQCN: a same-named class in another namespace is not this one (#150)
    const imported = phpImports(code);
    const names = [...phpClasses.keys()];
    const bi = names.length ? spawnSync('php', ['-r', 'foreach (array_slice($argv, 1) as $n) if (class_exists($n, false) || interface_exists($n, false)) echo $n, "\n";', '--', ...names], { encoding: 'utf8' }) : null;
    const builtin = new Set(bi?.status === 0 ? bi.stdout.split('\n').filter(Boolean) : []);
    for (const c of names) if (imported.has(c) ? projFq.has(imported.get(c)) : builtin.has(c) || [...projFq].some((x) => x === c || x.endsWith('\\' + c))) phpClasses.delete(c);
    unknown = unknown.filter((n) => !phpClasses.has(n) && !new RegExp(`\\bnew\\s+${n}\\b`).test(code));
    // `use Ns\\Cls;` classes become PSR-4 files (composer.json autoload mapping, else first namespace segment => src/) with a `namespace` line (#117)
    const psr4 = [];
    try {
      const cj = JSON.parse(fs.readFileSync(path.join(ROOT, 'composer.json'), 'utf8'));
      for (const sec of [cj.autoload, cj['autoload-dev']]) for (const [k, v] of Object.entries(sec?.['psr-4'] ?? {})) psr4.push([k, [].concat(v)[0]]);
      const paths = Object.values(cj.repositories ?? {}).filter((r) => r.type === 'path' && typeof r.url === 'string').map((r) => path.resolve(ROOT, r.url).split(path.sep).join('/'));
      for (const manifest of workspaceFiles().filter((f) => /\/composer\.json$/.test(f))) {
        const dir = path.posix.dirname(manifest);
        if (!paths.some((p) => new RegExp('^' + escapeRe(p).replace(/\\\*/g, '[^/]*').replace(/\\\?/g, '[^/]') + '$').test(path.resolve(ROOT, dir).split(path.sep).join('/')))) continue;
        try {
          const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, manifest), 'utf8'));
          for (const [k, v] of Object.entries(pkg.autoload?.['psr-4'] ?? {})) {
            const dest = [].concat(v)[0];
            if (typeof dest === 'string') psr4.push([k, path.posix.join(dir, dest)]);
          }
        } catch {}
      }
    } catch {}
    if (fs.existsSync(path.join(ROOT, 'vendor/autoload.php'))) {
      const r = spawnSync('php', ['-r', '$loader = require "vendor/autoload.php"; echo json_encode($loader->getPrefixesPsr4());'], { cwd: ROOT, encoding: 'utf8', timeout: 10000 });
      try { if (r.status === 0) for (const [k, v] of Object.entries(JSON.parse(r.stdout))) if (v[0]) psr4.unshift([k, v[0]]); } catch {}
    }
    psr4.sort((a, b) => b[0].length - a[0].length);
    for (const [local, fq] of imported) {
      const cls = fq.split('\\').pop(), ns = fq.slice(0, -cls.length - 1);
      if (!phpClasses.has(local) || /^(PHPUnit|Mockery|Prophecy|Pest)\\/.test(ns + '\\')) continue;
      // vendor / already autoloadable classes are never stubbed (#131)
      if (fs.existsSync(path.join(ROOT, 'vendor/autoload.php')) && spawnSync('php', ['-r', 'require "vendor/autoload.php"; exit(class_exists($argv[1]) || interface_exists($argv[1]) || trait_exists($argv[1]) ? 0 : 1);', '--', `${ns}\\${cls}`], { cwd: ROOT, stdio: 'ignore' }).status === 0) { phpClasses.delete(local); continue; }
      if (projFq.has(`${ns}\\${cls}`)) continue;
      const hit = psr4.find(([k]) => (ns + '\\').startsWith(k));
      const rest = hit ? (ns + '\\').slice(hit[0].length).split('\\').filter(Boolean) : ns.split('\\').slice(1);
      let home = hit ? path.resolve(ROOT, hit[1]) : path.join(ROOT, 'src');
      let existing = home;
      while (!fs.existsSync(existing) && path.dirname(existing) !== existing) existing = path.dirname(existing);
      home = path.resolve(fs.realpathSync(existing), path.relative(existing, home));
      const fileAbs = path.join(home, ...rest, cls + '.php');
      if (!fileAbs.startsWith(ROOT + path.sep) || /(^|\/)vendor\//.test(rel(fileAbs))) { (made.notes ??= []).push(`${ns}\\${cls}: PSR-4 destination is outside project source — not stubbed`); phpClasses.delete(local); continue; }
      const body = classBody(local, phpClasses.get(local) ?? new Set()).replace(new RegExp(`^(class|enum) ${local}\\b`, 'm'), `$1 ${cls}`);
      add(fileAbs, `<?php\n\nnamespace ${ns};\n\n${body}`);
      phpClasses.delete(local);
      psrDone = true;
    }
    // `use function Ns\f` / `use const Ns\C`: throwing namespaced functions and placeholder consts live in <PSR-4 root>/functions.php, registered under composer.json autoload.files (#222)
    const nsSyms = new Map();
    for (const [kind, fq] of [...[...phpImports(code, 'function').values()].map((q) => ['function', q]), ...[...phpImports(code, 'const').values()].map((q) => ['const', q])]) {
      const name = fq.split('\\').pop(), ns = fq.slice(0, -name.length - 1);
      if (!ns) continue;
      const defined = gitFiles('*.php').some((f) => { try { const t = fs.readFileSync(path.join(ROOT, f), 'utf8'); return new RegExp(`^\\s*namespace\\s+${escapeRe(ns)}\\s*[;{]`, 'm').test(t) && new RegExp(kind === 'function' ? `\\bfunction\\s+&?${name}\\s*\\(` : `\\bconst\\s+${name}\\b`).test(t); } catch { return false; } });
      if (defined) continue;
      if (!nsSyms.has(ns)) nsSyms.set(ns, { fns: [], consts: [] });
      nsSyms.get(ns)[kind === 'function' ? 'fns' : 'consts'].push(name);
    }
    for (const [ns, { fns, consts }] of nsSyms) {
      const hit = psr4.find(([k]) => (ns + '\\').startsWith(k));
      const rest = hit ? (ns + '\\').slice(hit[0].length).split('\\').filter(Boolean) : ns.split('\\').slice(1);
      const fileAbs = path.join(hit ? path.resolve(ROOT, hit[1]) : path.join(ROOT, 'src'), ...rest, 'functions.php');
      if (!fileAbs.startsWith(ROOT + path.sep) || /(^|\/)vendor\//.test(rel(fileAbs))) { (made.notes ??= []).push(`${ns}: function/const destination is outside project source — not stubbed`); continue; }
      const defs = [...fns.map((n) => `function ${n}(...$args)\n{\n    throw new \\LogicException('not implemented: ${n}');\n}\n`), ...consts.map((n) => `const ${n} = 0;\n`)].join('\n');
      if (fs.existsSync(fileAbs)) {
        const cur = fs.readFileSync(fileAbs, 'utf8');
        const lack = (n, isFn) => !new RegExp(isFn ? `\\bfunction\\s+&?${n}\\s*\\(` : `\\bconst\\s+${n}\\b`).test(cur);
        const add2 = [...fns.filter((n) => lack(n, true)).map((n) => `function ${n}(...$args)\n{\n    throw new \\LogicException('not implemented: ${n}');\n}\n`), ...consts.filter((n) => lack(n, false)).map((n) => `const ${n} = 0;\n`)].join('\n');
        if (add2 && new RegExp(`^\\s*namespace\\s+${escapeRe(ns)}\\s*;`, 'm').test(cur)) { fs.appendFileSync(fileAbs, `${cur.endsWith('\n') ? '' : '\n'}\n${add2}`); made.push(rel(fileAbs)); }
        else if (add2) (made.realMissing ??= []).push(`${[...fns, ...consts].join(', ')} in ${rel(fileAbs)}`);
      } else add(fileAbs, `<?php\n\nnamespace ${ns};\n\n${defs}`);
      if (!fs.existsSync(fileAbs)) continue;
      try {
        const cjPath = path.join(ROOT, 'composer.json'), raw = fs.readFileSync(cjPath, 'utf8'), cj = JSON.parse(raw);
        const relFile = rel(fileAbs);
        if (!(cj.autoload?.files ?? []).includes(relFile)) {
          cj.autoload = { ...(cj.autoload ?? {}), files: [...(cj.autoload?.files ?? []), relFile] };
          fs.writeFileSync(cjPath, JSON.stringify(cj, null, /^\n?( +)"/m.exec(raw)?.[1].length ?? 0) + '\n');
          (made.notes ??= []).push(`${relFile} registered under composer.json autoload.files — run \`composer dump-autoload\` if vendor/ already exists`);
        }
      } catch { (made.notes ??= []).push(`${rel(fileAbs)}: add it to composer.json "autoload.files" so the functions load`); }
    }
    unknown = unknown.filter((n) => ![...nsSyms.values()].some((x) => x.fns.includes(n)) && !phpImports(code, 'function').has(n));
  }
  const loads = [...src.matchAll(loadRe)].map((m) => path.resolve(dir, m[1].replace(/^\/+/, ''))).filter((abs) => !fs.existsSync(abs));
  const used = new Set();
  for (const abs of loads) {
    const stem = path.basename(abs).replace(/\.php$/, '');
    const mine = lang === 'php' ? [...phpClasses].filter(([c]) => c.toLowerCase() === stem.toLowerCase() || (loads[0] === abs && !loads.some((o) => path.basename(o, '.php').toLowerCase() === c.toLowerCase()))).filter(([c]) => !used.has(c)) : [];
    mine.forEach(([c]) => used.add(c));
    const fns = abs === loads[0] ? unknown.filter((n) => !excNames.includes(n)).map(fn) : [];
    if (lang === 'jl') {
      // `using .Mod` / `import .Mod` needs the included file to define `module Mod` exporting the stubs (#131)
      const usingNames = [...code.matchAll(/^\s*(?:using|import)\s+([^\n;]+)/gm)].flatMap((m) => [...m[1].split(':')[0].matchAll(/(?:^|,)\s*\.+(\w+)/g)].map((n) => n[1]));
      const stemOf = (f) => path.basename(f).replace(/\.jl$/, '').toLowerCase();
      const others = new Set([...src.matchAll(loadRe)].map((m) => stemOf(m[1])).filter((s) => s !== stemOf(abs)));
      // the module of a missing include: the `using .X` named like the file, else the Nth `using` that no other include claims (#151)
      const mod = usingNames.find((u) => u.toLowerCase() === stemOf(abs)) ?? usingNames.filter((u) => !others.has(u.toLowerCase()))[Math.max(0, loads.indexOf(abs))];
      const excs = abs === loads[0] ? excNames.filter((n) => unknown.includes(n)).map((n) => `struct ${n} <: Exception end\n`) : [];
      const exp = [...unknown.filter((n) => abs === loads[0] && !excNames.includes(n)), ...excNames.filter((n) => abs === loads[0] && unknown.includes(n))];
      add(abs, mod ? `module ${mod}\n\n${exp.length ? `export ${exp.join(', ')}\n\n` : ''}${[...excs, ...fns].join('\n')}\nend # module ${mod}\n` : [...excs, ...fns].join('\n'));
      continue;
    }
    add(abs, (lang === 'php' ? '<?php\n\n' : '') + [...mine.map(([c, ms]) => classBody(c, ms)), ...fns].join('\n'));
  }
  // every include already exists: missing names are appended to a stub-only module (inside its `module`, exported), real code is never edited (#151)
  if (lang === 'jl' && !loads.length && existingLoads.length && (unknown.length)) {
    const stubOnly = existingLoads.filter((f) => { const t = fs.readFileSync(f, 'utf8'); return /not implemented/.test(t) && !t.split('\n').some((l) => /^\s*(?:function\s|[A-Za-z_]\w*!?\(.*\)\s*=(?!=))/.test(l) && !/not implemented/.test(l)); });
    const target = stubOnly[0];
    if (target) {
      let t = fs.readFileSync(target, 'utf8');
      const names = unknown.filter((n) => !excNames.includes(n)), excs = unknown.filter((n) => excNames.includes(n));
      const body = [...excs.map((n) => `struct ${n} <: Exception end\n`), ...names.map(fn)].join('\n');
      const mm = /^module\s+(\w+)\s*\n/m.exec(t);
      if (mm) {
        t = t.replace(/^(?:end\s*(?:#[^\n]*)?\s*)$(?![\s\S]*^end\b)/m, (e) => `${body}\n${e}`);
        const ex = /^export\s+([^\n]*)$/m.exec(t);
        t = ex ? t.replace(ex[0], `${ex[0]}, ${unknown.join(', ')}`) : t.replace(mm[0], `${mm[0]}\nexport ${unknown.join(', ')}\n`);
      } else t += (t.endsWith('\n') ? '\n' : '\n\n') + body;
      fs.writeFileSync(target, t); made.push(rel(target));
    } else if (existingLoads.length) (made.realMissing ??= []).push(`${unknown.join(', ')} in ${existingLoads.map(rel).join(', ')}`);
  }
  // R: every `source()`d file exists, so the missing functions are appended to a stub-only one (#224)
  if (lang === 'r' && !loads.length && existingLoads.length && unknown.length) {
    const target = existingLoads.find((f) => { const t = fs.readFileSync(f, 'utf8'); return /not implemented/.test(t) && !t.split('\n').some((l) => /<-\s*function\b|=\s*function\b/.test(l) && !/not implemented/.test(l)); });
    if (target) {
      const t = fs.readFileSync(target, 'utf8');
      fs.appendFileSync(target, `${t.endsWith('\n') ? '\n' : '\n\n'}${unknown.map(fn).join('\n')}`);
      made.push(rel(target));
    } else (made.realMissing ??= []).push(`${unknown.join(', ')} in ${existingLoads.map(rel).join(', ')}`);
  }
  return made;
}

// methods the test calls on instances of a stubbed class: `new C().m(`, `C().m(`, `v = new C(); v.m(` (#97)
function methodsOf(src, cls, strict = false) {
  // `new Foo<T>(..)` is `new Foo(..)` (#151)
  src = src.replace(/\b(new\s+[\w$]+)\s*<[^<>()]*(?:<[^<>()]*>[^<>()]*)*>\s*\(/g, '$1(');
  const out = new Set();
  const skip = /^(assert\w*|then|catch|toString|valueOf|constructor|call|bind)$/;
  for (const m of src.matchAll(new RegExp(`(?:new\\s+)?\\b${cls}\\s*\\([^()]*\\)\\s*\\.\\s*([A-Za-z_$][\\w$]*)\\s*\\(`, 'g'))) out.add(m[1]);
  const directCtor = (text, start) => {
    let depth = 1, i = start, quote = '';
    for (; i < text.length && depth; i++) {
      const c = text[i];
      if (quote) { if (c === '\\') i++; else if (c === quote) quote = ''; }
      else if (/['"`]/.test(c)) quote = c;
      else if (c === '(') depth++;
      else if (c === ')') depth--;
    }
    return depth === 0 && !/^\s*\)*\s*(?:\?\.|\.|\[)/.test(text.slice(i));
  };
  const vars = [...src.matchAll(new RegExp(`\\b([A-Za-z_$][\\w$]*)\\s*(?::[^=\\n]+)?=\\s*(?:await\\s+)?(?:new\\s+)?${cls}\\s*\\(`, 'g'))].filter((m) => directCtor(src, m.index + m[0].length)).map((m) => m[1]);
  // objects built inside a helper (`const { s } = setup()`, `c, j = setup()`, `setup().s.m(`): methods called on whatever the helper returns (#112)
  const lines = src.split('\n');
  const DEF = /^\s*(?:export\s+)?(?:async\s+)?(?:function\s+(\w+)|def\s+(\w+)|(?:const|let)\s+(\w+)\s*=\s*(?:async\s*)?\()/;
  const defs = lines.map((l, i) => ({ i, n: DEF.exec(l) })).filter((d) => d.n).map((d) => ({ i: d.i, name: d.n[1] ?? d.n[2] ?? d.n[3] }));
  // strict (existing real classes): a helper counts only when it returns `new Cls(..)` itself, and its body ends at the next test block
  const retRe = new RegExp(`(?:=>|\\breturn)\\s*[\\[({\\s]*(?:[\\w$]+\\s*:\\s*)?(?:await\\s+)?new\\s+${cls}\\b`);
  const ret = { test: (l) => retRe.test(l) && [...l.matchAll(new RegExp(`\\bnew\\s+${cls}\\s*\\(`, 'g'))].some((m) => directCtor(l, m.index + m[0].length)) && ![...l.matchAll(/\bnew\s+([\w$]+)/g)].some((x) => x[1] !== cls) };
  const bodyEnd = (k) => { let e = k + 1 < defs.length ? defs[k + 1].i : lines.length; for (let j = defs[k].i + 1; j < e; j++) if (/^\s*(?:\/\*\*|\/\/\s*@id|(?:test|it|describe)\s*[(.])/.test(lines[j])) { e = j; break; } return e; };
  const helpers = defs.filter((d, k) => lines.slice(d.i, bodyEnd(k)).some((l) => strict ? ret.test(l) : [...l.matchAll(new RegExp(`\\b${cls}\\s*\\(`, 'g'))].some((m) => directCtor(l, m.index + m[0].length)))).map((d) => d.name).filter((n) => !/^test/i.test(n));
  for (const h of helpers) {
    // `return Eng(log), log` + `eng, log = make()`: only the tuple slot that holds the class instance is the SUT variable (#131)
    let sutIdx = -1, slots = 0, sutKeys = null;
    const hd = defs.find((d) => d.name === h);
    if (hd) {
      const di = defs.indexOf(hd), hl = lines.slice(hd.i, di + 1 < defs.length ? defs[di + 1].i : lines.length);
      // `return { b: new Box(..), out }` + `const { b, out } = mk()`: only the keys holding the class instance are SUT variables (#151)
      const ho = /(?:\breturn|=>)\s*\(?\s*\{/.exec(hl.join('\n'));
      if (ho) {
        const t = hl.join('\n').slice(ho.index + ho[0].length);
        const ents = []; let depth = 1, cur = '';
        for (const ch of t) { if ('([{'.includes(ch)) depth++; else if (')]}'.includes(ch)) { depth--; if (!depth) break; } if (ch === ',' && depth === 1) { ents.push(cur.trim()); cur = ''; } else cur += ch; }
        if (cur.trim()) ents.push(cur.trim());
        const ctorVars = new Set([...hl.join('\n').matchAll(new RegExp(`\\b([\\w$]+)\\s*(?::[^=\\n]+)?=\\s*(?:await\\s+)?(?:new\\s+)?${cls}\\s*\\(`, 'g'))].map((x) => x[1]));
        const keys = ents.map((e) => { const kv = /^([\w$]+)\s*:\s*([\s\S]*)$/.exec(e); return kv ? { k: kv[1], v: kv[2] } : /^[\w$]+$/.test(e) ? { k: e, v: e } : null; }).filter(Boolean);
        if (keys.length > 1) sutKeys = keys.filter((x) => new RegExp(`\\b${cls}\\s*\\(`).test(x.v) || ctorVars.has(x.v)).map((x) => x.k);
      }
      const ret = hl.map((l) => /^\s*return\s+(.+?)\s*;?\s*$/.exec(l)?.[1]).filter(Boolean).pop();
      if (ret && !ret.startsWith('{')) {
        const els = []; let depth = 0, cur = '';
        for (const ch of ret.replace(/^[\[(]/, '').replace(/[\])]$/, '')) { if ('([{'.includes(ch)) depth++; else if (')]}'.includes(ch)) depth--; if (ch === ',' && !depth) { els.push(cur.trim()); cur = ''; } else cur += ch; }
        els.push(cur.trim());
        const ctorVars = new Set([...hl.join('\n').matchAll(new RegExp(`\\b([\\w$]+)\\s*(?::[^=\\n]+)?=\\s*(?:await\\s+)?(?:new\\s+)?${cls}\\s*\\(`, 'g'))].map((x) => x[1]));
        sutIdx = els.length > 1 ? els.findIndex((e) => new RegExp(`\\b${cls}\\s*\\(`).test(e) || ctorVars.has(e)) : -1;
        slots = els.length;
        // the helper returns an instance of a different class: its methods are not this class's (#147)
        if (els.length === 1) { const e = els[0], hs = hl.join('\n'); const c = /^([A-Z][\w$]*)\s*\(/.exec(e)?.[1] ?? (/^[\w$]+$/.test(e) ? new RegExp(`\\b${e}\\s*(?::[^=\\n]+)?=\\s*(?:await\\s+)?(?:new\\s+)?([A-Z][\\w$]*)\\s*\\(`).exec(hs)?.[1] : undefined); if (c && c !== cls) continue; }
      }
    }
    // a pytest fixture `@pytest.fixture def agg(): return Agg()` is the instance itself inside tests that take `agg` as a parameter
    if (new RegExp(`@(?:pytest\\.)?fixture[^\\n]*\\n\\s*def\\s+${h}\\b`).test(src)) for (const m of src.matchAll(new RegExp(`(?<![\\w$.])${h}\\s*\\.\\s*([A-Za-z_]\\w*)\\s*\\(`, 'g'))) out.add(m[1]);
    for (const m of src.matchAll(new RegExp(`\\b${h}\\s*\\([^()]*\\)\\s*(?:\\.\\s*[A-Za-z_$][\\w$]*\\s*)?\\.\\s*([A-Za-z_$][\\w$]*)\\s*\\(`, 'g'))) out.add(m[1]);
    for (const m of src.matchAll(new RegExp(`^\\s*(?:(?:const|let|var)\\s+)?[\\[{(]?\\s*([\\w$]+(?:\\s*[,:]\\s*[\\w$]+)*)\\s*[\\]})]?\\s*(?::[^=\\n]+)?=\\s*(?:await\\s+)?${h}\\s*\\(`, 'gm'))) { const lhs = m[0].split('=')[0]; if (sutKeys?.length && /\{/.test(lhs)) { for (const e of lhs.replace(/^[^{]*\{/, '').replace(/\}[^}]*$/, '').split(',')) { const kv = /^\s*([\w$]+)\s*(?::\s*([\w$]+))?\s*$/.exec(e); if (kv && sutKeys.includes(kv[1])) vars.push(kv[2] ?? kv[1]); } continue; } const names = m[1].split(/\s*[,:]\s*/).filter((x) => x && x !== '_'); vars.push(...(sutIdx >= 0 && names.length === slots && !/[{:]/.test(lhs) ? [names[sutIdx]] : names)); }
  }
  // a variable rebound to another class (`s = Counter()` ... `s = Sub()`) belongs to the class of its latest preceding construction (#147)
  for (const v of new Set(vars)) {
    const ve = v.replace(/\$/g, '\\$');
    const binds = [...src.matchAll(new RegExp(`(?<![\\w$.])${ve}\\s*(?::[^=\\n]+)?=(?!=)\\s*(?:await\\s+)?(?:new\\s+)?([A-Z][\\w$]*)\\s*\\(`, 'g'))].map((x) => ({ at: x.index, c: x[1] }));
    for (const m of src.matchAll(new RegExp(`(?<![\\w$.])${ve}\\s*\\.\\s*([A-Za-z_$][\\w$]*)\\s*\\(`, 'g'))) {
      const prev = binds.filter((b) => b.at < m.index).pop();
      if (!prev || prev.c === cls) out.add(m[1]);
    }
  }
  return [...out].filter((n) => !skip.test(n));
}

// C#: `dotnet build` diagnostics (CS0246/CS0103/CS0234/CS0117/CS1061) in the requested test are the source of truth; throwing stubs are added until nothing in scope fails to compile (#136)
const CS_MARK = '// sdd-stub: throwing stub generated by `tdd stub` — replace with the real implementation';
function stubCs(testPath, src, id, made) {
  const abs = path.resolve(ROOT, testPath);
  const g = dotnetGraph(ROOT);
  const testProj = g?.ownersOf(testPath)?.[0];
  if (!g || !testProj) return made;
  if (spawnSync('dotnet', ['--version'], { stdio: 'ignore' }).status !== 0) { (made.notes ??= []).push('dotnet SDK not found: nothing was generated or compile-checked'); return made; }
  const lines = src.split('\n');
  const ids = lines.map((l, i) => (/@id\s/.test(l) ? i : -1)).filter((i) => i >= 0);
  const start = ids.find((i) => new RegExp(`@id\\s+${id}\\b`).test(lines[i])) ?? -1;
  const first = ids[0] ?? lines.length;
  const next = ids.find((i) => i > start) ?? lines.length;
  const inScope = (i) => start < 0 || i < first || (i >= start && i < next);
  const text = start < 0 ? src : lines.filter((_, i) => inScope(i)).join('\n');
  const ENV2 = { ...process.env, DOTNET_CLI_UI_LANGUAGE: 'en', VSLANG: '1033', DOTNET_NOLOGO: '1', DOTNET_CLI_TELEMETRY_OPTOUT: '1' };
  const build = () => {
    const r = spawnSync('dotnet', ['build', path.join(ROOT, testProj.file), '--nologo', '-v', 'q', '-clp:NoSummary'], { cwd: ROOT, encoding: 'utf8', timeout: 300000, maxBuffer: 64e6, env: ENV2 });
    const outp = (r.stdout ?? '') + (r.stderr ?? '') + (r.error ? String(r.error.message) : '');
    const diags = new Map();
    for (const m of outp.matchAll(/^(.+?)\((\d+),(\d+)(?:,\d+,\d+)?\):\s+error\s+([A-Z]+\d+):\s*(.*?)(?:\s+\[[^\]]+\])?\s*$/gm)) {
      const d = { file: rel(path.resolve(ROOT, m[1])), line: +m[2], col: +m[3], code: m[4], msg: m[5] };
      diags.set(`${d.file}:${d.line}:${d.col}:${d.code}`, d);
    }
    const infra = /error (NU\d+|NETSDK\d+)|Unable to load the service index|could not be resolved|dotnet: command not found/i.test(outp);
    return { ok: r.status === 0, diags: [...diags.values()], infra, raw: outp };
  };
  const q = (m) => [...m.matchAll(/'([^']+)'/g)].map((x) => x[1]);
  const usingNs = (l) => /^\s*(?:global\s+)?using\s+(?:static\s+)?([\w.]+)\s*;/.exec(l)?.[1];
  const ownNs = /^\s*namespace\s+([\w.]+)/m.exec(src)?.[1];
  const usings = [...src.matchAll(/^\s*using\s+(?:static\s+)?([\w.]+)\s*;/gm)].map((m) => m[1]);
  // `global using X;` in another file of the test project (GlobalUsings.cs) applies to this test too (#218)
  const globalLines = new Map();
  for (const f of gitFiles('*.cs')) { try {
    if (f === testPath || !g.ownersOf(f)?.some((o) => o.file === testProj.file)) continue;
    const ls = fs.readFileSync(path.join(ROOT, f), 'utf8').split('\n');
    if (ls.some((l) => /^\s*global\s+using\s+(?:static\s+)?[\w.]+\s*;/.test(l))) { globalLines.set(f, ls); for (const l of ls) { const m = /^\s*global\s+using\s+(?:static\s+)?([\w.]+)\s*;/.exec(l); if (m) usings.push(m[1]); } }
  } catch {} }
  const refProjs = [...g.deps(testProj.file)].filter((f) => f !== testProj.file).map((f) => g.projs.get(f)).filter((p) => !p.test);
  const pname = (p) => path.posix.basename(p.file).replace(/\.\w+proj$/, '');
  const ours = new Set();
  const typeFile = new Map();
  const findType = (n) => {
    if (typeFile.has(n)) return typeFile.get(n);
    const visible = g.deps(testProj.file);
    const namespaces = new Set([ownNs, ...usings, ...unresolved, pickNs(n, [...unresolved])].filter(Boolean));
    for (const f of gitFiles('*.cs')) { try {
      if (!g.ownersOf(f).some((o) => visible.has(o.file))) continue;
      const c = fs.readFileSync(path.join(ROOT, f), 'utf8'), ns = /^\s*namespace\s+([\w.]+)/m.exec(c)?.[1];
      if (ns && !namespaces.has(ns)) continue;
      if (new RegExp(`\\b(?:class|record|struct|interface|enum)\\s+${n}\\b`).test(c)) { const r = { file: f, marked: c.includes(CS_MARK) }; typeFile.set(n, r); return r; }
    } catch {}
    }
    return null;
  };
  const esc = (n) => n.replace(/[$]/g, '\\$&');
  const FACTORY = /^(Of|Create|From\w*|Parse|TryParse|New\w*|Zero|One|Empty|Default|Make\w*|Unit)$/;
  const lit = (a) => { a = a.trim(); return /^-?\d+$/.test(a) ? 'int' : /^-?\d*\.\d+m$|^-?\d+m$/i.test(a) ? 'decimal' : /^-?\d*\.\d+d?$/.test(a) ? 'double' : /^"(?:[^"\\]|\\.)*"$/.test(a) ? 'string' : /^(true|false)$/.test(a) ? 'bool' : 'dynamic'; };
  const callArgs = (t, n) => { const m = new RegExp(`\\bnew\\s+${esc(n)}\\s*\\(`).exec(t); if (!m) return null; let d = 1, k = m.index + m[0].length, cur = '', parts = []; for (; k < t.length && d; k++) { const ch = t[k]; if (ch === '(' || ch === '[' || ch === '{') d++; else if (ch === ')' || ch === ']' || ch === '}') { d--; if (!d) break; } if (ch === ',' && d === 1) { parts.push(cur); cur = ''; } else cur += ch; } if (cur.trim()) parts.push(cur); return parts; };
  const thr = (n) => `throw new System.NotImplementedException("${n}")`;
  const memberOf = (T, kind, name, o) => {
    const ret = o.ret ?? (/Async$/.test(name) ? 'System.Threading.Tasks.Task<dynamic>' : 'dynamic');
    if (kind === 'interface') return o.method ? `    ${ret} ${name}(params dynamic[] _args);` : `    ${ret} ${name} { get; set; }`;
    if (o.method) return `    public ${o.stat ? 'static ' : ''}${ret} ${name}(params dynamic[] _args) => ${thr(`${T}.${name}`)};`;
    return `    public ${o.stat ? 'static ' : ''}${ret} ${name} ${o.set ? `{ get => ${thr(`${T}.${name}`)}; set { } }` : `=> ${thr(`${T}.${name}`)};`}`;
  };
  const decl = (n, kind, body, extra) => kind === 'enum' ? `public enum ${n}\n{\n${body}\n}\n` : kind === 'exception' ? `public class ${n} : System.Exception\n{\n    public ${n}() { }\n    public ${n}(string message) : base(message) { }\n    public ${n}(string message, System.Exception inner) : base(message, inner) { }\n}\n` : kind === 'record' ? `public record ${n}(${extra});\n` : kind === 'static' ? `public static class ${n}\n{\n${body}\n}\n` : kind === 'interface' ? `public interface ${n}\n{\n${body}\n}\n` : `public class ${n}\n{\n    public ${n}(params dynamic[] _args) { }\n${body}\n}\n`;
  const projFor = (ns, n) => {
    const hit = refProjs.filter((p) => ns && (ns === pname(p) || ns.startsWith(pname(p) + '.'))).sort((a, b) => pname(b).length - pname(a).length)[0];
    if (hit) return hit;
    if (refProjs.length === 1) return refProjs[0];
    const rel1 = refProjs.find((p) => { const l = pname(p).split('.').pop(); return l && (n.includes(l) || l.includes(n)); });
    if (rel1) return rel1;
    (made.notes ??= []).push(`${n}: no referenced project matches namespace ${ns ?? '(none)'} — placed in the test project ${testProj.file}, move it to the project that should own it`);
    return testProj;
  };
  const unresolved = new Set();
  const pickNs = (n, cand) => {
    const l = (s) => s.split('.').pop();
    // a `using` of a parent namespace of a referenced project (`using ParserKit;` + ParserKit.Core), and the namespace that names the test's own project, beat the test's namespace (#150)
    const tpn = pname(testProj);
    const own = tpn.replace(/\.(?:Unit|Integration)?Tests?$/, '');
    const byProj = cand.filter((c) => own === c || own.startsWith(c + '.')).sort((a, b) => b.length - a.length)[0];
    const parentUse = usings.find((u) => refProjs.some((p) => pname(p) === u || pname(p).startsWith(u + '.')));
    const referencedUse = usings.find((u) => g.files.some((f) => f.endsWith('.cs') && g.ownersOf(f).some((o) => refProjs.some((p) => p.file === o.file)) && new RegExp(`\\bnamespace\\s+${escapeRe(u)}(?:[.;\\s{]|$)`).test(fs.readFileSync(path.join(ROOT, f), 'utf8'))));
    const projectUses = usings.filter((u) => !/^(?:System|Microsoft|Xunit|NUnit|Moq|FluentAssertions)(?:\.|$)/.test(u));
    return cand.find((c) => n.includes(l(c)) || l(c).includes(n)) ?? byProj ?? cand[0] ?? usings.find((u) => refProjs.some((p) => u === pname(p) || u.startsWith(pname(p) + '.'))) ?? parentUse ?? referencedUse ?? (refProjs.length === 1 && projectUses.length === 1 ? projectUses[0] : undefined) ?? ownNs?.replace(/\.(?:Unit|Integration)?Tests?$/, '');
  };
  const classify = (n) => {
    if (/Exception$/.test(n) || new RegExp(`(?:Throws|ThrowsAsync|ThrowsException|ThrowsExceptionAsync|Catch)\\s*<\\s*${esc(n)}\\b|catch\\s*\\(\\s*${esc(n)}\\b`).test(text)) return 'exception';
    if (/^I[A-Z]/.test(n)) return 'interface';
    const calls = [...text.matchAll(new RegExp(`(?<![\\w.])${esc(n)}\\.([A-Z]\\w*)\\s*\\(`, 'g'))].map((m) => m[1]);
    const props = [...text.matchAll(new RegExp(`(?<![\\w.])${esc(n)}\\.([A-Z]\\w*)\\b(?!\\s*[(<])`, 'g'))].map((m) => m[1]);
    const inst = new RegExp(`\\bnew\\s+${esc(n)}\\b|\\b${esc(n)}\\??\\s+[A-Za-z_]\\w*\\s*[=;,)(]|<\\s*${esc(n)}\\s*>|:\\s*${esc(n)}\\b|\\b(?:is|as)\\s+${esc(n)}\\b|typeof\\s*\\(\\s*${esc(n)}\\s*\\)`).test(text);
    // `case T.X:` / `(int)T.X` need a real constant, so T is an enum even when it is also used as a declared type (#296)
    const constUse = new RegExp(`\\bcase\\s+${esc(n)}\\.[A-Z]\\w*\\s*(?::|=>|when\\b)|\\(\\s*(?:int|long|byte)\\s*\\)\\s*${esc(n)}\\.[A-Z]`).test(text);
    if (!calls.length && props.length && (!inst || constUse)) return 'enum';
    const named = callArgs(text, n)?.map((a) => /^\s*([A-Za-z_]\w*)\s*:/.exec(a)?.[1]);
    if (named?.length && named.every(Boolean)) return 'record';
    return inst ? 'class' : 'static';
  };
  const statics = (n, kind) => {
    const out = [];
    const seen = new Set();
    for (const m of text.matchAll(new RegExp(`(?<![\\w.])${esc(n)}\\.([A-Z]\\w*)\\s*(\\()?`, 'g'))) {
      if (seen.has(m[1])) continue; seen.add(m[1]);
      if (kind === 'enum') { out.push(`    ${m[1]},`); continue; }
      const own = FACTORY.test(m[1]) && kind !== 'static' ? n : undefined;
      out.push(memberOf(n, kind, m[1], { stat: true, method: !!m[2], ret: own }));
    }
    return out.join('\n');
  };
  const createType = (n, nsCand) => {
    const kind = classify(n);
    const ns = pickNs(n, nsCand);
    const proj = projFor(ns, n);
    const extra = kind === 'record' ? callArgs(text, n).map((a) => { const m = /^\s*([A-Za-z_]\w*)\s*:\s*([\s\S]*)$/.exec(a); return `${lit(m[2])} ${m[1][0].toUpperCase() + m[1].slice(1)}`; }).join(', ') : '';
    const body = statics(n, kind === 'record' ? 'class' : kind);
    const file = path.join(ROOT, proj.dir, `${n}.cs`);
    if (fs.existsSync(file)) return false;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${CS_MARK}\n${ns ? `namespace ${ns};\n\n` : ''}${decl(n, kind, body, extra)}`);
    made.push(rel(file)); ours.add(rel(file)); typeFile.set(n, { file: rel(file), marked: true });
    return true;
  };
  const addMember = (n, member, o) => {
    const t = findType(n);
    if (!t) return false;
    const f = path.join(ROOT, t.file);
    let c = fs.readFileSync(f, 'utf8');
    const miss = (s) => { const a = (made.realMissing ??= []); if (!a.includes(s)) a.push(s); return false; };
    if (!c.includes(CS_MARK)) return miss(`${n}.${member} in ${t.file}`);
    if (o.op ? c.includes(member) : new RegExp(`\\b${esc(member)}\\b`).test(c.replace(CS_MARK, ''))) return false;
    // our own exception stubs take members too (`ex.Line`); records stay fixed (#150)
    const kind = /\binterface\s/.test(c) ? 'interface' : /\benum\s/.test(c) ? 'enum' : /\brecord\s/.test(c) ? null : 'class';
    if (!kind) return miss(`${n}.${member} in ${t.file} (record stubs are fixed)`);
    const line = kind === 'enum' ? `    ${member},` : o.op ? `    public static ${n} ${member}(${n} a, ${n} b) => ${thr(`${n}.${member}`)};` : memberOf(n, kind, member, o);
    c = c.replace(/\n}\s*$/, `\n${line}\n}\n`);
    fs.writeFileSync(f, c);
    if (!made.includes(t.file)) made.push(t.file);
    return true;
  };
  let res = build();
  const pre = res.diags.length;
  const handled = new Set();
  for (let round = 0; round < 8 && !res.ok; round++) {
    if (res.infra && !res.diags.some((d) => /^CS/.test(d.code))) { (made.notes ??= []).push(`dotnet build could not run (restore/infra): ${(res.raw.split('\n').find((l) => /error/.test(l)) ?? '').trim().slice(0, 160)} — nothing was compile-checked`); return made; }
    const mine = res.diags.filter((d) => ((d.file === testPath && inScope(d.line - 1)) || (globalLines.has(d.file) && usingNs(globalLines.get(d.file)[d.line - 1] ?? ''))) && /^CS/.test(d.code));
    if (!mine.length) break;
    const cand = [];
    const missingTypes = new Map();
    const members = [];
    for (const d of mine) {
      const l = (d.file === testPath ? lines : globalLines.get(d.file) ?? [])[d.line - 1] ?? '';
      const un = usingNs(l);
      const n = q(d.msg)[0];
      if (un && /^CS(0246|0234|0400)$/.test(d.code)) { unresolved.add(un); if (!cand.includes(un)) cand.push(un); continue; }
      if (d.code === 'CS0246' || d.code === 'CS0103') {
        if (!n || /[<>]/.test(n)) { (made.notes ??= []).push(`${d.code} ${n ?? ''}: not stubbed (generic or unparseable)`); continue; }
        if (/^[A-Z]/.test(n) && (d.code === 'CS0246' || new RegExp(`\\b${esc(n)}\\s*\\.`).test(l.slice(Math.max(0, d.col - 1), d.col + n.length + 1)) || new RegExp(`\\bnew\\s+${esc(n)}\\b|\\b(?:is|as)\\s+${esc(n)}\\b|<\\s*${esc(n)}\\s*>|typeof\\s*\\(\\s*${esc(n)}\\s*\\)`).test(l))) missingTypes.set(n, true);
        else (made.notes ??= []).push(`${d.code} '${n}' in ${testPath}:${d.line}: not stubbed (a local name or helper, not a type)`);
        continue;
      }
      // CS1501 (`No overload for method 'Append' takes 4 arguments`) is what Roslyn reports instead of CS1061 when the name collides with a LINQ extension method: the receiver type is taken from the line (#150)
      if (d.code === 'CS1501') {
        const mname = q(d.msg)[0];
        const at = mname ? l.indexOf(mname, Math.max(0, d.col - 1)) : -1;
        const recv = at > 0 ? /([A-Za-z_]\w*|\))\s*\.\s*$/.exec(l.slice(0, at))?.[1] : undefined;
        let T;
        if (recv === ')') { const mm = [...l.slice(0, at).matchAll(/\bnew\s+([A-Z]\w*)\s*\(/g)].pop(); T = mm?.[1]; }
        else if (recv && /^[A-Z]/.test(recv)) T = recv;
        else if (recv) T = new RegExp(`\\b(?:([A-Z]\\w*)\\s+${esc(recv)}\\s*[=;,)]|${esc(recv)}\\s*=\\s*new\\s+([A-Z]\\w*))`).exec(text)?.slice(1).find(Boolean);
        if (T && findType(T)) members.push({ T, mname, method: true, stat: !!recv && /^[A-Z]/.test(recv) && recv === T });
        else (made.notes ??= []).push(`${d.code} at ${testPath}:${d.line}: ${d.msg.slice(0, 100)} — receiver type unknown, not stubbed`);
        continue;
      }
      if (d.code === 'CS1061' || d.code === 'CS0117') {
        const [T, mname] = q(d.msg);
        const at = l.indexOf(mname, Math.max(0, d.col - 1));
        const after = at >= 0 ? l.slice(at + mname.length) : '';
        members.push({ T, mname, method: /^\s*\(/.test(after), set: /^\s*=[^=]/.test(after), stat: d.code === 'CS0117' });
        continue;
      }
      // Assert.Throws(() => x.M()) with a dynamic M binds to the obsolete Func<Task> overload: such a stub method returns object instead
      if (d.code === 'CS0619') { const lm = /=>\s*(?:[\w.]+\.)?(\w+)\s*\(/.exec(l); if (lm) members.push({ fix: lm[1] }); continue; }
      if (d.code === 'CS0019') {
        const [op, T1] = q(d.msg);
        if (op && T1 && /^[-+*\/%]$/.test(op)) members.push({ T: T1, mname: `operator ${op}`, op: true, stat: true });
        continue;
      }
      (made.notes ??= []).push(`${d.code} at ${testPath}:${d.line}: ${d.msg.slice(0, 100)} — not stubbed`);
    }
    let progress = false;
    const nsAssigned = new Set();
    for (const n of missingTypes.keys()) { if (!findType(n)) { const before = made.length; createType(n, cand); progress ||= made.length > before; } }
    for (const n of missingTypes.keys()) { const t = findType(n); if (t) nsAssigned.add(/^\s*namespace\s+([\w.]+)/m.exec(fs.readFileSync(path.join(ROOT, t.file), 'utf8'))?.[1]); }
    // a `using` of a namespace nothing was placed in still has to resolve
    for (const un of cand) if (!nsAssigned.has(un)) {
      const p = projFor(un, un.split('.').pop());
      const file = path.join(ROOT, p.dir, `Namespace.${un}.cs`);
      if (!fs.existsSync(file)) { fs.writeFileSync(file, `${CS_MARK}\nnamespace ${un};\n\ninternal static class SddNamespaceMarker { }\n`); made.push(rel(file)); ours.add(rel(file)); progress = true; }
    }
    for (const m of members.filter((x) => x.fix)) for (const f of gitFiles('*.cs')) { try { const c = fs.readFileSync(path.join(ROOT, f), 'utf8'); const c2 = c.includes(CS_MARK) ? c.replace(new RegExp(`\\bdynamic(\\s+${esc(m.fix)}\\s*\\()`, 'g'), 'object$1') : c; if (c2 !== c) { fs.writeFileSync(path.join(ROOT, f), c2); progress = true; } } catch {} }
    for (const m of members.filter((x) => !x.fix)) if (addMember(m.T, m.mname, { op: m.op, method: m.method, set: m.set, stat: m.stat, ret: FACTORY.test(m.mname) && m.stat ? m.T : undefined })) progress = true;
    if (!progress) break;
    res = build();
  }
  // a namespace marker is only needed while no type lives in that namespace
  for (const f of [...ours].filter((x) => /(^|\/)Namespace\.[\w.]+\.cs$/.test(x))) {
    const ns = /^namespace\s+([\w.]+);/m.exec(fs.readFileSync(path.join(ROOT, f), 'utf8'))?.[1];
    if ([...ours].some((o) => o !== f && new RegExp(`^namespace\\s+${ns.replace(/\./g, '\\.')};`, 'm').test(fs.readFileSync(path.join(ROOT, o), 'utf8')))) { fs.rmSync(path.join(ROOT, f)); made.splice(made.indexOf(f), 1); ours.delete(f); }
  }
  if (!made.length && res.ok) return made;
  const inS = res.diags.filter((d) => d.file === testPath && inScope(d.line - 1));
  const outS = res.diags.filter((d) => !(d.file === testPath && inScope(d.line - 1)));
  const show = (d) => `${d.file}:${d.line} ${d.code} ${d.msg}`.slice(0, 160);
  if (res.ok) made.verified = 'ok';
  else if (!inS.length && outS.length && !res.infra) { made.verified = 'partial'; made.verifyError = `${outS.length} compile error(s) remain outside ${id} (first: ${show(outS[0])})`; }
  else { made.verified = 'fail'; made.verifyError = show(inS[0] ?? outS[0] ?? { file: testPath, line: 0, code: 'CS', msg: res.raw.slice(0, 120) }); }
  made.pre = pre;
  return made;
}

// ExUnit: modules the test aliases/imports/uses/requires or calls as `Mod.fun(..)` and no project file defines become lib/<snake>.ex with throwing defs
const EX_STD = /^(?:Kernel|Enum|Stream|String|Map|MapSet|List|Keyword|Tuple|Integer|Float|Atom|File|Path|IO|Code|Module|Process|Task|Agent|GenServer|Supervisor|Application|Registry|DateTime|Date|Time|NaiveDateTime|Calendar|Regex|Range|Access|Agent|Base|Bitwise|Macro|System|Node|URI|Version|Exception|Protocol|Behaviour|Inspect|Collectable|Enumerable|ExUnit|Mix|Logger|Jason|Ecto|Plug|Phoenix|Mox|Stream|Port|Record|Function|Config|StringIO|Erlang|EEx|IEx|Hex|Poison|Req|Finch|Mint|Telemetry|Gettext|JSON|Duration|OptionParser)(?:\.|$)|^[a-z]/;
function stubEx(testPath, scoped, add, made) {
  let root = path.resolve(ROOT, path.dirname(testPath));
  while (!fs.existsSync(path.join(root, 'mix.exs')) && root !== ROOT && root !== path.dirname(root)) root = path.dirname(root);
  const code = scoped.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  const full = new Map();
  const mods = new Set();
  const resolve = (n) => (full.get(n.split('.')[0]) ? full.get(n.split('.')[0]) + n.slice(n.split('.')[0].length) : n);
  for (const m of code.matchAll(/\balias\s+([A-Z][\w.]*)\.\{([^}]*)\}/g)) for (const x of m[2].split(',')) { const k = x.trim().split('.'); full.set(k.at(-1), `${m[1]}.${x.trim()}`); mods.add(`${m[1]}.${x.trim()}`); }
  for (const m of code.matchAll(/\balias\s+([A-Z][\w.]*)(?![\w]|\.\{)(?:\s*,\s*as:\s*([A-Z]\w*))?/g)) { full.set(m[2] ?? m[1].split('.').at(-1), m[1]); mods.add(m[1]); }
  const imported = [], needed = new Set(), used = new Set();
  for (const m of code.matchAll(/\b(?:import|use|require)\s+([A-Z][\w.]*)/g)) { mods.add(resolve(m[1])); needed.add(resolve(m[1])); if (m[0].startsWith('import')) imported.push(resolve(m[1])); if (m[0].startsWith('use')) used.add(resolve(m[1])); }
  const defs = new Map();
  const arityAt = (i) => {
    let depth = 0, n = 0, any = false, q = '', kw = false, itemStart = true;
    for (; i < code.length; i++) {
      const c = code[i];
      if (!depth && !q && itemStart && !/\s/.test(c)) { kw = /^[a-z_]\w*:\s/.test(code.slice(i)); itemStart = false; }
      if (q) { if (c === '\\') i++; else if (c === q) q = ''; continue; }
      if (c === '"' || c === "'") { q = c; any = true; continue; }
      if (/[([{]/.test(c)) { depth++; any = true; continue; }
      if (/[)\]}]/.test(c)) { if (!depth) return any ? n + 1 : 0; depth--; continue; }
      if (c === ',' && !depth) { if (!(kw && /^\s*[a-z_]\w*:\s/.test(code.slice(i + 1)))) n++; itemStart = true; }
      else if (!/\s/.test(c)) any = true;
    }
    return any ? n + 1 : 0;
  };
  const addDef = (mod, f, arity) => { mods.add(mod); if (!defs.has(mod)) defs.set(mod, new Map()); const d = defs.get(mod); d.set(`${f}/${arity}`, { f, arity }); };
  for (const m of code.matchAll(/(?<![\w.:])([A-Z]\w*(?:\.[A-Z]\w*)*)\.([a-z_]\w*[!?]?)\(/g)) { needed.add(resolve(m[1])); addDef(resolve(m[1]), m[2], arityAt(m.index + m[0].length) + (/\|>\s*$/.test(code.slice(0, m.index)) ? 1 : 0)); }
  // `%Mod{k: ..}` patterns/literals need `Mod` to define a struct with those keys (#257)
  const structs = new Map();
  for (const m of code.matchAll(/%([A-Z][\w.]*)\{/g)) {
    const mod = resolve(m[1]);
    mods.add(mod);
    const keys = structs.get(mod) ?? new Set();
    for (let i = m.index + m[0].length, depth = 1, itemStart = true, q = ''; i < code.length && depth > 0; i++) {
      const c = code[i];
      if (q) { if (c === '\\') i++; else if (c === q) q = ''; continue; }
      if (c === '"' || c === "'") q = c;
      else if (/[([{]/.test(c)) depth++;
      else if (/[)\]}]/.test(c)) depth--;
      else if (depth === 1 && c === ',') itemStart = true;
      else if (depth === 1 && itemStart && !/\s/.test(c)) { itemStart = false; const k = /^([a-z_]\w*):(?!:)/.exec(code.slice(i)); if (k) keys.add(k[1]); }
    }
    structs.set(mod, keys);
  }
  // `start_supervised!({Mod, opts})` needs Mod.child_spec/1 (via `use GenServer`) and start_link/1
  const supervised = new Set([...code.matchAll(/\bstart_supervised!?\(\s*\{?\s*([A-Z][\w.]*)/g)].map((m) => resolve(m[1])));
  for (const m of supervised) mods.add(m);
  const local = new Set([...code.matchAll(/\bdef(?:p|macro)?\s+([a-z_]\w*[!?]?)/g)].map((m) => m[1]));
  const RESERVED = /^(?:assert|refute|assert_\w+|refute_\w+|test|describe|setup|setup_all|on_exit|doctest|def|defp|defmodule|defmacro|if|unless|case|cond|with|for|fn|raise|reraise|throw|catch|rescue|try|receive|quote|unquote|import|alias|use|require|elem|length|hd|tl|is_\w+|inspect|to_string|spawn\w*|send|self|apply|put_elem|abs|div|rem|round|trunc|max|min|not|and|or|struct|sigil_\w|tag|capture_\w+|start_supervised!?|stop_supervised!?|flunk|raise)$/;
  for (const mod of imported) for (const m of code.matchAll(/(?<![\w.:@&])([a-z_]\w*[!?]?)\(/g)) if (!RESERVED.test(m[1]) && !local.has(m[1])) addDef(mod, m[1], arityAt(m.index + m[0].length));
  // modules defined in the project (lib/**, test/support/**) are never stubbed
  const defined = new Map();
  const walk = (d) => { for (const e of fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : []) { const p = path.join(d, e.name); if (e.isDirectory()) { if (!/^(?:_build|deps|\.git|node_modules)$/.test(e.name)) walk(p); } else if (/\.exs?$/.test(e.name) && p !== path.join(ROOT, testPath)) for (const m of fs.readFileSync(p, 'utf8').matchAll(/\bdefmodule\s+([A-Z][\w.]*)/g)) defined.set(m[1], p); } };
  walk(root);
  // modules of `path:` dependencies in mix.exs live in the dependency, never in a stub here (#257)
  if (fs.existsSync(path.join(root, 'mix.exs'))) for (const m of fs.readFileSync(path.join(root, 'mix.exs'), 'utf8').matchAll(/\bpath:\s*"([^"]+)"/g)) { const dep = path.resolve(root, m[1]); if (dep !== root && fs.existsSync(dep)) walk(dep); }
  // umbrella: modules owned by a sibling app are defined too
  for (let up = path.dirname(root); up.startsWith(ROOT) && up !== root; up = path.dirname(up)) {
    const mx = path.join(up, 'mix.exs');
    if (fs.existsSync(mx) && /apps_path/.test(fs.readFileSync(mx, 'utf8'))) { walk(path.join(up, 'apps')); break; }
    if (up === ROOT) break;
  }
  const inTest = new Set([...fs.readFileSync(path.join(ROOT, testPath), 'utf8').matchAll(/\bdefmodule\s+([A-Z][\w.]*)/g)].map((m) => m[1]));
  const unresolved = [], usingImport = new Set();
  for (const mod of mods) {
    if (EX_STD.test(mod) || inTest.has(mod) || [...full].some(([k, v]) => v === mod && inTest.has(k))) continue;
    const want = [...(defs.get(mod)?.values() ?? [])];
    // `use Mod` calls Mod.__using__/1, so the module needs that macro to compile (#214)
    if (used.has(mod)) want.push({ f: '__using__', arity: 1, macro: true });
    // paren-less DSL calls the test makes after `use Mod` (`rule :a do .. end`) are macros of that module, which defines them and `import`s itself (#309)
    if (used.has(mod) && !defined.has(mod)) {
      const dsl = new Map();
      for (const m of code.matchAll(/^[ \t]*([a-z_]\w*[!?]?)[ \t]+(?=[:"'\w@%{\[])(.*?)(?:[ \t]+(do))?[ \t]*$/gm)) {
        const [, f, rest, blk] = m;
        if (RESERVED.test(f) || local.has(f) || /^(?:end|else|do|after|rescue|catch|flunk|when|in|and|or|not|nil|true|false|pipe|then)$/.test(f) || /^\s*(?:=|\|>|<-)/.test(rest) || dsl.has(f)) continue;
        let depth = 0, q = '', n = rest.trim() ? 1 : 0;
        for (let i = 0; i < rest.length; i++) { const c = rest[i]; if (q) { if (c === '\\') i++; else if (c === q) q = ''; } else if (c === '"' || c === "'") q = c; else if ('([{'.includes(c)) depth++; else if (')]}'.includes(c)) depth--; else if (c === ',' && !depth) n++; }
        dsl.set(f, n + (blk ? 1 : 0));
      }
      for (const [f, arity] of dsl) want.push({ f, arity, macro: true, dsl: true });
      if (dsl.size) usingImport.add(mod);
    }
    if (!want.length && !needed.has(mod) && !supervised.has(mod) && !defined.has(mod) && !structs.has(mod)) continue;
    const fields = structs.get(mod);
    if (supervised.has(mod) && !want.some((d) => d.f === 'start_link')) want.push({ f: 'start_link', arity: 1 });
    const structDef = fields ? `  defstruct [${[...fields].map((k) => `:${k}`).join(', ')}]\n` : '';
    const stubOf = ({ f, arity, macro, dsl }) => !macro && fields && f === 'new' ? `  def new(${Array.from({ length: arity }, (_, i) => `_a${i + 1}`).join(', ')}), do: %__MODULE__{}\n` : macro ? (dsl ? `  defmacro ${f}(${Array.from({ length: arity }, (_, i) => `_a${i + 1}`).join(', ')}) do\n    quote do\n      raise "not implemented: ${f}"\n    end\n  end\n` : `  defmacro ${f}(_opts) do\n    quote do\n${usingImport.has(mod) ? `      import ${mod}\n` : ''}    end\n  end\n`) : `  def ${f}(${Array.from({ length: arity }, (_, i) => `_a${i + 1}`).join(', ')}), do: raise("not implemented: ${f}")\n`;
    if (defined.has(mod)) {
      const file = defined.get(mod), text = fs.readFileSync(file, 'utf8');
      const have = new Set([...text.matchAll(/\b(?:def|defp|defmacro|defdelegate)\s+([a-z_]\w*[!?]?)/g)].map((m) => m[1]));
      const isStub = (/not implemented: /.test(text) || (/@id CODE-\S*-STUB-/.test(text) && !/\bdef(?!struct)/.test(text))) && /\bend\s*$/.test(text);
      // a stub-only module also needs every arity the test calls (#257)
      const haveAr = new Set([...text.matchAll(/\bdef\s+([a-z_]\w*[!?]?)(?:\(([^)]*)\))?/g)].map((m) => `${m[1]}/${m[2]?.trim() ? m[2].split(',').length : 0}`));
      const missing = want.filter((d) => isStub && !/\\\\/.test(text) && !d.macro ? !haveAr.has(`${d.f}/${d.arity}`) : !have.has(d.f));
      const needStruct = structDef && !/\bdefstruct\b/.test(text);
      // grow the defstruct field list of a stub when a later test uses more keys
      const cur = /\bdefstruct\s+\[([^\]]*)\]/.exec(text);
      const grow = isStub && fields && cur ? [...fields].filter((k) => !new RegExp(`:${k}\\b`).test(cur[1])) : [];
      if (!missing.length && !(needStruct && isStub) && !grow.length) continue;
      if (isStub) { let withStruct = needStruct ? text.replace(/(\bdefmodule\s+[A-Z][\w.]*\s+do\n)/, `$1${structDef}`) : text;
        if (grow.length) withStruct = withStruct.replace(cur[0], `defstruct [${[cur[1].trim(), ...grow.map((k) => `:${k}`)].filter(Boolean).join(', ')}]`); fs.writeFileSync(file, withStruct.replace(/\bend\s*$/, `\n${missing.map(stubOf).join('')}end\n`)); made.push(rel(file)); }
      else unresolved.push(`${missing.map((d) => d.f).join(', ')} in ${rel(file)}`);
      continue;
    }
    const file = path.join(root, 'lib', ...mod.split('.').map((p) => p.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase())) + '.ex';
    if (fs.existsSync(file)) { unresolved.push(`${mod} in ${rel(file)}`); continue; }
    add(file, `defmodule ${mod} do\n${supervised.has(mod) ? '  use GenServer\n' : ''}${structDef}${want.map(stubOf).join('')}end\n`);
  }
  return Object.assign([...new Set(made)], { realMissing: unresolved.length ? unresolved : undefined });
}
// opt-in (`.sdd/config.json` stubThrowingConstructors): JS/TS and Java class stubs throw from the constructor; default constructors stay non-throwing (#309)
const throwCtor = () => !!(readJson(CONFIG, null) ?? {}).stubThrowingConstructors;
function stubFor(testPath, id) {
  const src = fs.readFileSync(path.join(ROOT, testPath), 'utf8');
  const ids = [].concat(id ?? []);
  // the requested test only: shared preamble (before the first @id) + that test's own body (#130)
  const scoped = (() => { if (!ids.length) return src; const ls = src.split('\n'); const first = ls.findIndex((l) => /@id\s/.test(l)); const body = ids.flatMap((x) => testBody(testPath, x)); return first < 0 || !body.length ? src : ls.slice(0, first).concat(body).join('\n'); })();
  const dir = path.resolve(ROOT, path.dirname(testPath));
  const made = [];
  const add = (abs, body) => { if (fs.existsSync(abs)) return; fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, body); made.push(rel(abs)); };
  // `tdd stub --report` rows for Python/TS elements: a pure-guess element also carries an SDD-TODO(stub) marker (design 3.2)
  const report = [];
  const note = (element, confidence) => {
    if (report.some((r) => r.element === element)) return;
    const at = src.split('\n').findIndex((l) => !/^\s*(?:from|import)\s/.test(l) && new RegExp(`(?<![\\w$])${element.replace(/\$/g, '\\$')}\\b`).test(l));
    report.push({ element, confidence, evidence: at < 0 ? testPath : `${testPath}:${at + 1}` });
  };
  const names = (clause) => {
    const typeOnly = /^type\s+[{*\w$]/.test(clause);
    const c = clause.replace(/^type\s+(?=[{*\w$])/, '');
    const ns = /^\*\s+as\s+([\w$]+)$/.exec(c)?.[1] ?? null;
    const ents = /\{([^}]*)\}/.exec(c)?.[1].split(',').map((x) => x.trim()).filter(Boolean) ?? [];
    const types = ents.filter((x) => typeOnly || /^type\s/.test(x)).map((x) => x.replace(/^type\s+/, '').split(/\s+as\s+/)[0]);
    const named = typeOnly ? [] : ents.filter((x) => !/^type\s/.test(x)).map((x) => x.split(/\s+as\s+/)[0]);
    const def = typeOnly || ns ? undefined : /^\s*([A-Za-z_$][\w$]*)\s*(,|$)/.exec(c)?.[1];
    return { named, def, ns, types };
  };
  // `import * as ns` => the `ns.x` members the test uses, seen as plain names (#128)
  const prep = (clause) => {
    const { named, def, ns, types } = names(clause);
    const e = ns?.replace(/\$/g, '\\$');
    const S = ns ? scoped.replace(new RegExp(`(?<![\\w$./'"\`-])${e}\\.(?=[A-Za-z_$])`, 'g'), '') : scoped;
    const members = ns ? [...new Set([...scoped.matchAll(new RegExp(`(?<![\\w$./'"\`-])${e}\\.([A-Za-z_$][\\w$]*)`, 'g'))].map((m) => m[1]))] : [];
    return { named: [...new Set([...named, ...members])], def, types, S };
  };
  // static methods the test calls on an imported class: `Foo.create(` (#128)
  const staticsOf = (S, n) => [...new Set([...S.matchAll(new RegExp(`(?<![\\w$.])${n.replace(/\$/g, '\\$')}\\s*\\.\\s*([A-Za-z_$][\\w$]*)\\s*\\(`, 'g'))].map((m) => m[1]))].filter((k) => !/^(then|catch|toString|valueOf|call|apply|bind|constructor)$/.test(k));
  // `mapError(404)` without `new`/`instanceof`/`extends` is a function even when its name ends in Error
  const calledAsFn = (S, n) => new RegExp(`(?<!new\\s+)(?<![\\w$.])${n.replace(/\$/g, '\\$')}\\s*\\(`).test(S) && !new RegExp(`\\b(?:new|extends|instanceof)\\s+${n.replace(/\$/g, '\\$')}\\b`).test(S);
  const isError = (S, n) => {
    if ((/(Error|Exception)$/.test(n) && !calledAsFn(S, n)) || new RegExp(`\\b(?:toThrow|toThrowError)\\(\\s*${n}\\s*\\)`).test(S)) return true;
    for (const m of S.matchAll(/\b(?:throws|rejects)\s*\(/g)) {
      let depth = 1, quote = '';
      for (let i = m.index + m[0].length; i < S.length && depth; i++) {
        const c = S[i];
        if (quote) { if (c === '\\') i++; else if (c === quote) quote = ''; }
        else if (/['"`]/.test(c)) quote = c;
        else if ('([{'.includes(c)) depth++;
        else if (')]}'.includes(c)) depth--;
        else if (c === ',' && depth === 1) {
          if (new RegExp(`^\\s*${n}\\s*[,)]`).test(S.slice(i + 1))) return true;
          break;
        }
      }
    }
    return false;
  };
  const isCls = (S, n) => isError(S, n) || new RegExp(`\\bnew\\s+${n}\\b|\\bextends\\s+${n}\\b|\\binstanceof\\s+${n}\\b|\\btoBeInstanceOf\\(\\s*${n}\\s*\\)`).test(S) || (/^[A-Z]/.test(n) && !/^[A-Z0-9_]+$/.test(n) && staticsOf(S, n).length > 0);
  const mth = (n, k, stat) => `\n  ${stat ? 'static ' : ''}${k}(..._args${ts ? ': any[]): any' : ')'} {\n    throw new Error('not implemented: ${n}.${k}');\n  }\n`;
  // a name the test never calls is a value (`CONFIG.max`, `initialState`): any use fails deliberately instead of reading `undefined`
  const valueStub = (n) => `export const ${n}${ts ? ': any' : ''} = new Proxy(function () {}, {\n  get(_t${ts ? ': any' : ''}, p${ts ? ': any' : ''}) { if (typeof p === 'string' && p !== 'then') throw new Error(\`not implemented: ${n}.\${p}\`); },\n  apply() { throw new Error('not implemented: ${n}'); },\n});\n`;
  // the generic base (`AppError`) of an error the test asserts instanceof on the same subject, from the same module (#309)
  const errSubjects = (S, n) => new Set([...S.matchAll(new RegExp(`expect\\(([^()]+)\\)\\.toBeInstanceOf\\(\\s*${n}\\s*\\)|([\\w$.]+)\\s+instanceof\\s+${n}\\b`, 'g'))].map((m) => (m[1] ?? m[2]).trim()));
  const GENERIC = /^(|App|Base|Domain|Api|Http|Custom|Service|Core|Sdk|Application|Client|Server|Db|Database|Generic)$/;
  const errParent = (S, n, peers) => {
    const stem = (x) => x.replace(/(Error|Exception)$/, ''), mine = errSubjects(S, n);
    return peers.find((p) => p !== n && isError(S, p) && [...errSubjects(S, p)].some((x) => mine.has(x)) && stem(p).length < stem(n).length && (GENERIC.test(stem(p)) || stem(n).endsWith(stem(p))));
  };
  const errFirst = (S, names) => names.slice().sort((a, b) => { const depth = (x) => { let d = 0; for (let p = errParent(S, x, names); p && d < 9; p = errParent(S, p, names)) d++; return d; }; return depth(a) - depth(b); });
  const exportOf = (n, S, dflt, peers = []) => {
    const fnBody = ts ? `(..._args: any[]): any {\n  throw new Error('not implemented: ${n}');\n}\n` : `() {\n  throw new Error('not implemented: ${n}');\n}\n`;
    // error types (`FooError`, `toThrow(Foo)`, `instanceof`-checked names ending in Error/Exception) extend Error so `new Foo()` and `instanceof` behave (#151)
    if (isError(S, n)) return `export ${dflt ? 'default ' : ''}class ${n} extends ${errParent(S, n, peers) ?? 'Error'} {\n  constructor(..._args${ts ? ': any[]' : ''}) {\n    super(typeof _args[0] === 'string' ? _args[0] : undefined);\n    this.name = '${n}';\n  }\n${[...staticsOf(S, n).map((k) => mth(n, k, true)), ...methodsOf(S, n).map((k) => mth(n, k))].join('')}}\n`;
    if (isCls(S, n)) note(n, 'inferred');
    if (isCls(S, n)) return `export ${dflt ? 'default ' : ''}class ${n} {\n  constructor(..._args${ts ? ': any[]' : ''}) {${throwCtor() ? `\n    throw new Error('not implemented: ${n}');\n  ` : ''}}\n${[...staticsOf(S, n).map((k) => mth(n, k, true)), ...methodsOf(S, n).map((k) => mth(n, k))].join('')}}\n`;
    if (dflt) return `export default function ${n}${fnBody}`;
    if (new RegExp(`(?<![\\w$.])${n.replace(/\$/g, '\\$')}\\s*\\(`).test(S)) { note(n, 'guessed', { unmarked: ts ? 'signature is (...args: any[]) => any' : 'arguments and return value are not inferred' }); return `export function ${n}${fnBody}`; }
    const plainConst = /^[A-Z][A-Z0-9_]+$/.test(n) && !new RegExp(`(?<![\\w$.])${n}\\s*[.\\[]`).test(S);
    // a type the test itself shows (`const x: number = LIMIT`) replaces `any`
    const tsTy = ts && plainConst ? new RegExp(`:\\s*(number|string|boolean)\\s*=\\s*${n}\\s*;`).exec(S)?.[1] ?? null : null;
    if (plainConst) note(n, tsTy ? 'inferred' : 'guessed');
    if (tsTy) return `export const ${n}: ${tsTy} = undefined as never; // SDD-TODO(stub): type taken from the test, value unknown — write the real value by hand\n`;
    return plainConst ? `export const ${n}${ts ? ': any' : ''} = undefined; // SDD-TODO(stub): type unknown — write the real value by hand\n` : valueStub(n);
  };
  if (/\.py$/.test(testPath)) {
    // class stubs must construct: a throwing __init__ in a fixture/setup makes every test a weak Red
    // imports inside conftest.py fixtures the test can use count too (#288)
    const conftestText = pythonConftests(path.join(ROOT, testPath), scoped).map((f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } }).join('\n');
    const scan = scoped + '\n' + conftestText;
    const checked = { rel: 0, abs: 0, conftest: [...conftestText.matchAll(/^\s*from\s+\.*[\w.]+\s+import\s/gm)].length };
    if (/\bsubprocess\.(?:run|Popen|check_output|check_call|call)\s*\(|\bos\.system\s*\(/.test(scoped)) (made.notes ??= []).push(`${id ?? testPath} runs a subprocess (e.g. \`node cli.ts\`): the subject is an external program, which stubs cannot generate; create it by hand or leave it missing — \`tdd red\` accepts a genuine non-zero exit/assertion failure without --weak`);
    for (const m of scan.matchAll(/^\s*from\s+(\.*[\w.]+)\s+import\s+(\([^)]*\)|[^\n#]+)/gm)) {
      const mod = m[1];
      checked[mod.startsWith('.') ? 'rel' : 'abs']++;
      // stdlib / installed packages must not be shadowed by a stub (probe with cwd removed from sys.path so project dirs do not count; user site and PYTHONPATH do)
      if (!mod.startsWith('.') && spawnSync('python3', ['-c', 'import importlib.util,sys;sys.path=[p for p in sys.path if p not in ("",".")];sys.exit(0 if importlib.util.find_spec(sys.argv[1].split(".")[0]) else 1)', mod], { cwd: os.tmpdir() }).status === 0) continue;
      const proot = path.resolve(ROOT, projectFor(testPath)?.root ?? '.');
      const top = mod.replace(/^\.+/, '').split('.')[0];
      const has = (b) => fs.existsSync(path.join(b, top)) || fs.existsSync(path.join(b, top + '.py'));
      // src layout: put new modules under src/ when the package already lives there (or src/ is the only package root) (#68)
      const srcLayout = !has(proot) && (has(path.join(proot, 'src')) || (fs.existsSync(path.join(proot, 'src')) && fs.readdirSync(path.join(proot, 'src')).some((x) => fs.existsSync(path.join(proot, 'src', x, '__init__.py')))));
      // pytest `pythonpath = src` (pytest.ini / pyproject / setup.cfg / tox.ini) names the package root even when that directory does not exist yet (#131)
      const ppDirs = (() => { for (const f of ['pytest.ini', 'pyproject.toml', 'setup.cfg', 'tox.ini']) { try { const m = /^\s*pythonpath\s*=\s*(\[[^\]]*\]|[^\n]*(?:\n[ \t]+[^\n]+)*)/m.exec(fs.readFileSync(path.join(proot, f), 'utf8')); const d = m && [...m[1].matchAll(/[\w./-]+/g)].map((x) => x[0]).filter((x) => x !== '.'); if (d?.length) return d; } catch {} } return []; })();
      const ppDir = ppDirs[0] ?? null;
      // a package that already lives on any configured pythonpath entry (`../core/src`) is real code: never shadowed by a stub (#279)
      const ppHit = mod.startsWith('.') ? null : ppDirs.map((d) => path.resolve(proot, d)).find((d) => has(d));
      // a helper module that already sits next to the test file is importable as-is (#291)
      if (!mod.startsWith('.') && dir !== proot && has(dir)) continue;
      // config `artifacts` ({"py/tools/x.py": ["py/tests/test_x.py"]}) names where a module the test imports lives (#305)
      const modRel = mod.replace(/^\.+/, '').split('.').join('/') + '.py';
      const cfgArt = mod.startsWith('.') ? {} : loadConfig().artifacts ?? {};
      const mapped = Object.keys(cfgArt).find((a) => (normDep(a) === modRel || normDep(a).endsWith('/' + modRel)) && [].concat(cfgArt[a]).some((u) => normDep(u) === testPath));
      const base = mod.startsWith('.') ? dir : ppHit ?? (ppDir && !has(proot) ? path.join(proot, ppDir) : srcLayout ? path.join(proot, 'src') : proot);
      const abs = mapped ? path.join(ROOT, normDep(mapped)) : path.join(base, ...mod.replace(/^\.+/, '').split('.')) + '.py';
      // `from pkg import x` where pkg/ is a namespace package: never create pkg.py next to it
      const nsDir = abs.replace(/\.py$/, '');
      const isNsDir = fs.existsSync(nsDir) && fs.statSync(nsDir).isDirectory() && !fs.existsSync(path.join(nsDir, '__init__.py'));
      const bindings = m[2].replace(/#[^\n]*/g, '').replace(/[()]/g, '').split(',').map((x) => x.trim().split(/\s+as\s+/)).filter(([n]) => n);
      const ns = bindings.map(([n]) => n);
      const localOf = (n) => bindings.find(([name]) => name === n)?.[1] ?? n;
      // pytest.raises(X) / assertRaises(X) / except X => an Exception subclass, else the Red is "must derive from BaseException"
      const isExc = (n) => new RegExp(`(raises|assertRaises|assertRaisesRegex)\\(\\s*${n}\\b|\\bexcept\\s+\\(?\\s*${n}\\b`).test(src);
      // ALL_CAPS names that are never called are constants, not classes (#112)
      const isConst = (n) => /^[A-Z][A-Z0-9_]+$/.test(n) && !new RegExp(`\\b${n}\\s*\\(`).test(scoped);
      // a name used only as an annotation (never called, no attribute access) is a typing.Protocol (#288)
      const isProto = (n) => /^[A-Z]/.test(n) && !isExc(n) && !isConst(n) && new RegExp(`(?:(?<!['"]\\s*):|->|\\[|\\|)\\s*${n}\\b`).test(scan) && !new RegExp(`(?<![\\w.])${n}\\s*[(.]|\\bisinstance\\([^)]*\\b${n}\\b|\\(\\s*${n}\\s*[,)]\\s*:?`).test(scan.replace(new RegExp(`^\\s*from[^\\n]*\\bimport[^\\n]*`, 'gm'), ''));
      const stubOf = (n) => isProto(n) ? `class ${n}(Protocol):\n${methodsOf(scoped, n).map((k) => `    def ${k}(self, *a, **k): ...\n`).join('') || '    ...\n'}` : isExc(n) ? `class ${n}(Exception):\n    pass\n` : isConst(n) ? `${n} = ${new RegExp(`parametrize\\([^\\n]*\\b${n}\\b|\\bin\\s+${n}\\b|\\b${n}\\s*\\[`).test(scoped) ? (note(n, 'inferred'), '[]') : (note(n, 'guessed'), 'None  # SDD-TODO(stub): type unknown — write the real value by hand')}\n` : /^[A-Z]/.test(n) ? `class ${n}:\n    def __init__(self, *a, **k):\n        pass\n${new RegExp(`\\bwith\\s[^\\n]*\\b${n}\\s*\\(`).test(scan) ? '\n    def __enter__(self, *a, **k):\n        return self\n\n    def __exit__(self, *a, **k):\n        return False\n' : ''}${methodsOf(scoped, n).map((k) => `\n    def ${k}(self, *a, **k):\n        raise NotImplementedError("${k}")\n`).join('')}` : `def ${n}(*a, **k):\n    raise NotImplementedError("${n}")\n`;
      // `from pkg import mod` used only as `mod.f(...)` is a submodule: stub pkg/mod.py, never `def mod` in the package (#291)
      const isSub = (n) => !mod.startsWith('.') && /^[a-z_]\w*$/.test(n) && new RegExp(`\\b${localOf(n)}\\.\\w`).test(scoped) && !new RegExp(`(?<![\\w.])${localOf(n)}\\s*\\(`).test(scoped);
      const subBody = (n) => [...new Set([...scoped.matchAll(new RegExp(`\\b${localOf(n)}\\.([A-Za-z_]\\w*)\\s*\\(`, 'g'))].map((x) => x[1]))].map((f) => `def ${f}(*a, **k):\n    raise NotImplementedError("${f}")\n`).join('\n\n') || 'pass\n';
      // a namespace dir (no __init__.py) satisfies only the submodules it holds; any other imported name needs an __init__.py that defines it (#214)
      if (isNsDir) {
        const miss = ns.filter((n) => !fs.existsSync(path.join(nsDir, n + '.py')) && !fs.existsSync(path.join(nsDir, n)));
        for (const n of miss.filter(isSub)) add(path.join(nsDir, n + '.py'), subBody(n));
        const other = miss.filter((n) => !isSub(n));
        if (other.length) add(path.join(nsDir, '__init__.py'), other.map(stubOf).join('\n\n'));
        continue;
      }
      // `from pkg.sql import x` plus `from pkg.sql.ast import y`: pkg.sql must be a package, never sql.py next to sql/ (#214)
      const asPkg = !mod.startsWith('.') && [...scoped.matchAll(/^\s*from\s+([\w.]+)\s+import\b/gm)].some((x) => x[1].startsWith(mod + '.'));
      const absOut = asPkg ? path.join(nsDir, '__init__.py') : abs;
      const existing = fs.existsSync(absOut) ? absOut : fs.existsSync(abs.replace(/\.py$/, '/__init__.py')) ? abs.replace(/\.py$/, '/__init__.py') : null;
      if (existing) {
        // a module that still holds only stubs gets the newly imported names; real code is never touched
        const cur = fs.readFileSync(existing, 'utf8');
        const rest = cur.replace(/^# @id CODE-\S+-STUB-\d+ @implements [^\n]*\n/, '').replace(/^class \w+(\(Exception\))?:\n(?:    def __init__\(self, \*a, \*\*k\):\n        pass\n|    pass\n)(?:\n    def \w+\(self, \*a, \*\*k\):\n        (?:raise NotImplementedError\("\w+"\)|return (?:self|False))\n)*/gm, '').replace(/^def \w+\(\*a, \*\*k\):\n    raise NotImplementedError\("\w+"\)\n/gm, '');
        // names a module re-exports (`from .core import Clock`, `import x as Clock`) are importable, never stubbed over (#214)
        const reExported = new Set();
        for (const im of cur.matchAll(/^(?:from\s+\S+\s+import\s+(\([^)]*\)|[^\n]+)|import\s+([^\n]+))/gm)) for (const b of (im[1] ?? im[2]).replace(/#[^\n]*/g, '').replace(/[()]/g, '').split(',')) { const parts = b.trim().split(/\s+as\s+/); const nm = parts[1] ?? parts[0]; if (nm && nm !== '*') reExported.add(nm.split('.')[0]); }
        let missing = ns.filter((n) => !reExported.has(n) && !new RegExp(`^(class|def)\\s+${n}\\b|^${n}\\s*=`, 'm').test(cur));
        // `from pkg import mod` used as `mod.f(...)` is a submodule: create pkg/mod.py and leave __init__.py alone (#112)
        if (/__init__\.py$/.test(existing)) {
          const sub = missing.filter((n) => /^[a-z_]\w*$/.test(n) && new RegExp(`\\b${localOf(n)}\\.\\w`).test(scoped) && !new RegExp(`(?<![\\w.])${localOf(n)}\\s*\\(`).test(scoped));
          for (const n of sub) {
            const fns = [...new Set([...scoped.matchAll(new RegExp(`\\b${localOf(n)}\\.([A-Za-z_]\\w*)\\s*\\(`, 'g'))].map((x) => x[1]))];
            add(path.join(path.dirname(existing), n + '.py'), fns.map((f) => `def ${f}(*a, **k):\n    raise NotImplementedError("${f}")\n`).join('\n\n') || 'pass\n');
          }
          missing = missing.filter((n) => !sub.includes(n));
        }
        // a stub-only class the test now calls more methods on gets them appended inside the class (#279)
        let grown = cur;
        for (const n of ns) {
          const cm = new RegExp(`^class ${n}:\\n    def __init__\\(self, \\*a, \\*\\*k\\):\\n        pass\\n(?:\\n    def \\w+\\(self, \\*a, \\*\\*k\\):\\n        (?:raise NotImplementedError\\("\\w+"\\)|return (?:self|False))\\n)*`, 'm').exec(grown);
          const add2 = cm ? methodsOf(scoped, n).filter((k) => !new RegExp(`def ${k}\\(`).test(cm[0])) : [];
          if (add2.length) grown = grown.replace(cm[0], cm[0] + add2.map((k) => `\n    def ${k}(self, *a, **k):\n        raise NotImplementedError("${k}")\n`).join(''));
        }
        if (grown !== cur) { fs.writeFileSync(existing, grown); made.push(rel(existing)); }
        if (missing.length && !rest.trim()) { fs.appendFileSync(existing, (cur.endsWith('\n') ? '\n\n' : '\n\n\n') + missing.map(stubOf).join('\n\n')); made.push(rel(existing)); }
        else if (missing.length) (made.realMissing ??= []).push(`${missing.join(', ')} in ${rel(existing)}`);
        continue;
      }
      const subs = ns.filter(isSub);
      if (subs.length && !fs.existsSync(abs)) {
        for (const n of subs) add(path.join(nsDir, n + '.py'), subBody(n));
        const other = ns.filter((n) => !subs.includes(n));
        if (other.length) add(path.join(nsDir, '__init__.py'), other.map(stubOf).join('\n\n'));
        continue;
      }
      add(absOut, (ns.some(isProto) ? 'from typing import Protocol\n\n\n' : '') + ns.map(stubOf).join('\n\n'));
    }
    return Object.assign([...new Set(made)], { realMissing: made.realMissing, notes: made.notes, checked, report });
  }
  if (/_test\.go$/.test(testPath)) return stubGo(testPath, scoped, dir, add, made);
  if (/\.rs$/.test(testPath)) return stubRust(testPath, scoped, dir, made);
  if (/\.java$/.test(testPath)) return stubJava(testPath, scoped, dir, add, made);
  if (/\.cs$/.test(testPath)) return stubCs(testPath, src, id, made);
  if (/\.(c|cc|cpp|cxx)$/.test(testPath)) return stubC(testPath, scoped, dir, add, made);
  if (/\.exs$/.test(testPath)) return stubEx(testPath, scoped, add, made);
  const lang = /\.php$/.test(testPath) ? 'php' : /\.jl$/.test(testPath) ? 'jl' : /\.[Rr]$/.test(testPath) ? 'r' : null;
  if (lang) return stubScript(lang, scoped, dir, add, made);
  const testTs = /\.[cm]?tsx?$/.test(testPath);
  let ts = testTs;
  const newBody = (clause) => {
    const { named, def, types, S } = prep(clause);
    let body = errFirst(S, named).map((n) => exportOf(n, S, false, named)).join('\n');
    if (ts && types.length) body += (body ? '\n' : '') + types.map((n) => `export type ${n} = any;\n`).join('\n');
    if (def) body += (body ? '\n' : '') + exportOf(def, S, true);
    return body || 'export {};\n';
  };
  // the module exists but lacks a name the test imports (or a method of a class it already has): add throwing stubs, never touch existing lines (#112)
  const jsExisting = (file, clause) => {
    const { named, def, types, S } = prep(clause);
    let cur = fs.readFileSync(file, 'utf8');
    // names a barrel already re-exports (`export * from './x'`, `export { a } from './x'`) are real, never stubbed over (#151)
    const barrel = (f, seen = new Set()) => {
      if (seen.has(f)) return '';
      seen.add(f);
      let t = '';
      for (const m of fs.readFileSync(f, 'utf8').matchAll(/export\s+(?:\*(?:\s+as\s+\w+)?|(?:type\s+)?\{[^}]*\})\s+from\s+['"](\.{1,2}\/[^'"]+)['"]/g)) {
        const b = path.resolve(path.dirname(f), m[1]), st = b.replace(/\.[cm]?[jt]sx?$/, '');
        const hit = ['', '.ts', '.tsx', '.js', '.mjs', '.cjs', '.jsx', '/index.ts', '/index.js'].flatMap((e) => [b + e, st + e]).find((x) => fs.existsSync(x) && fs.statSync(x).isFile());
        if (hit) t += '\n' + fs.readFileSync(hit, 'utf8') + barrel(hit, seen);
      }
      return t;
    };
    const via = barrel(file);
    const has = (n) => new RegExp(`\\b(?:function|class|const|let|var|enum|interface|type)\\s+${n}\\b|\\bexport\\s*\\{[^}]*\\b${n}\\b|\\bas\\s+${n}\\b`).test(cur + via);
    const add2 = named.filter((x) => !has(x)).map((n) => exportOf(n, S));
    if (ts) for (const n of types.filter((x) => !has(x))) add2.push(`export type ${n} = any;\n`);
    let changed = false;
    // an earlier value stub (`export const X: any = undefined;` / Proxy) of a name the test now constructs becomes a class (#257)
    for (const n of named) {
      const val = new RegExp(`^export const ${n}(?:: any)? = (?:undefined;(?: \\/\\/ SDD-TODO\\(stub\\)[^\\n]*)?|new Proxy\\(function \\(\\) \\{\\}, \\{[\\s\\S]*?\\n\\}\\);)\\n`, 'm');
      if (isCls(S, n) && val.test(cur)) { cur = cur.replace(val, () => exportOf(n, S)); changed = true; }
    }
    for (const n of [...named, def].filter((x) => x && has(x))) {
      const cm = new RegExp(`\\bclass\\s+${n}\\b[^{]*\\{`).exec(cur);
      if (!cm) continue;
      let depth = 1, i = cm.index + cm[0].length;
      for (; i < cur.length && depth > 0; i++) { if (cur[i] === '{') depth++; else if (cur[i] === '}') depth--; }
      const body = cur.slice(cm.index + cm[0].length, i - 1);
      // only methods whose receiver is provably this class (`new X().m(`, `v = new X(); v.m(`, `X.m(`) go into real code (#128)
      const miss = methodsOf(S, n, true).filter((k) => !new RegExp(`(?:^|\\s)(?:async\\s+|static\\s+|get\\s+|set\\s+)*${k}\\s*\\(|\\b${k}\\s*[=:]`).test(body));
      const missStatic = staticsOf(S, n).filter((k) => !new RegExp(`\\bstatic\\s+(?:async\\s+)?${k}\\b`).test(body));
      if (!miss.length && !missStatic.length) continue;
      // a receiver variable also bound to a non-class value (`s = 'x'` and `s = new C()`) is no evidence of the class: skip, report ambiguous (#330)
      const rhsOther = (v) => [...S.matchAll(new RegExp(`(?:\\b(?:const|let|var)\\s+|^\\s*)${v.replace(/\$/g, '\\$')}\\s*(?::[^=\\n]+)?=(?!=)\\s*([^\\n]*)`, 'gm'))].some((x) => new RegExp(`^(?:['"\`\\d\\[{-]|new\\s+(?!${n}\\b))`).test(x[1]));
      const ambiguous = (k) => { const rc = new Set([...S.matchAll(new RegExp(`(?<![\\w$.])([A-Za-z_$][\\w$]*)\\.${k}\\s*\\(`, 'g'))].map((x) => x[1])); return rc.size > 0 && [...rc].every(rhsOther); };
      const amb = miss.filter(ambiguous);
      for (const k of amb) { note(`${n}.${k}`, 'ambiguous'); (made.notes ??= []).push(`${n}.${k}: receiver is also bound to another type in the test — not added to ${rel(file)}, add it by hand if it belongs to ${n}`); }
      const miss2 = miss.filter((k) => !amb.includes(k));
      if (!miss2.length && !missStatic.length) continue;
      const mark = (k, m) => { note(`${n}.${k}`, 'guessed'); return m.replace(/\{\n/, '{ // SDD-TODO(stub): member added to an existing type from the test — implement it or remove it\n'); };
      const ins = [...missStatic.map((k) => mark(k, mth(n, k, true))), ...miss2.map((k) => mark(k, mth(n, k)))].join('');
      cur = cur.slice(0, i - 1) + ins + cur.slice(i - 1);
      changed = true;
    }
    if (add2.length) { cur += (cur.endsWith('\n') ? '\n' : '\n\n') + add2.join('\n'); changed = true; }
    if (changed) { fs.writeFileSync(file, cur); made.push(rel(file)); }
  };
  // static `import … from './x'` (multi-line clauses too) and dynamic `(const {a} | x) = await import('./x')`, also in .cjs tests (#76, #128)
  // bare package specifiers that a workspace package.json name or tsconfig path resolves to a source file are stubbed in that entry file (#128)
  const pkgEntry = (spec) => {
    const hit = aliasMap(new Set(gitFiles('*')), true).find(([name, , isDir]) => name === spec && !isDir);
    return hit ? path.join(ROOT, hit[1]) : null;
  };
  const imps = [...scoped.matchAll(/import\s+([^'";]*?)\s+from\s+['"]([^'"\n]+)['"]/g)].map((m) => ({ 1: m[1].replace(/\s+/g, ' ').trim(), 2: m[2] }));
  // dynamic `import('<relative or package>')`: a bound namespace identifier means its members are used (#219)
  for (const m of scoped.matchAll(/(?:(?:const|let|var)\s+(\{[^}]*\}|[\w$]+)\s*=\s*)?await\s+import\(\s*['"]([^'"\n]+)['"]\s*\)/g)) imps.push({ 1: m[1] ? (m[1].startsWith('{') ? m[1].replace(/\s*:\s*[\w$]+/g, '') : `* as ${m[1]}`) : '', 2: m[2] });
  // CommonJS `require('<relative or package>')` gets a `module.exports` stub (#219)
  // `createRequire(import.meta.url)` bindings (`const req = createRequire(..)`) and the inline `createRequire(..)('./x.cjs')` load CommonJS from ESM/TS tests (#305)
  const reqNames = ['require', ...[...scoped.matchAll(/(?:const|let|var)\s+([\w$]+)\s*=\s*(?:module\.)?createRequire\(/g)].map((m) => m[1].replace(/\$/g, '\\$'))].join('|');
  for (const m of scoped.matchAll(new RegExp(`(?:(?:const|let|var)\\s+(\\{[^}]*\\}|[\\w$]+)\\s*=\\s*)?(?:(?<![\\w$.])(?:${reqNames})|createRequire\\([^)]*\\))\\(\\s*['"]([^'"\\n]+)['"]\\s*\\)`, 'g'))) imps.push({ 1: m[1] ? (m[1].startsWith('{') ? m[1].replace(/\s*:\s*[\w$]+/g, '') : `* as ${m[1]}`) : '', 2: m[2], cjs: true });
  const toCjs = (b) => { const ex = []; const out = b.replace(/^export\s+(?:default\s+)?(class|function|const)\s+([\w$]+)/gm, (x, k, n) => { ex.push(n); return `${k} ${n}`; }); return `${out}\nmodule.exports = { ${ex.join(', ')} };\n`; };
  // an existing CommonJS module that lacks a required name: append throwing stubs plus `module.exports.x = x` lines, never touching existing code (#219)
  const cjsExisting = (file, clause) => {
    const { named, S } = prep(clause);
    const cur = fs.readFileSync(file, 'utf8');
    const miss = named.filter((n) => !new RegExp(`\\b(?:function|class|const|let|var)\\s+${n}\\b|\\bexports\\.${n}\\b|\\bmodule\\.exports\\s*=\\s*\\{[^}]*\\b${n}\\b|\\b${n}\\s*:`).test(cur));
    if (!miss.length) return;
    const body = miss.map((n) => `${exportOf(n, S).replace(/^export\s+(?:default\s+)?/gm, '')}module.exports.${n} = ${n};\n`).join('\n');
    fs.writeFileSync(file, cur + (cur.endsWith('\n') ? '\n' : '\n\n') + body);
    made.push(rel(file));
  };
  for (const m of imps) {
    ts = testTs && !m.cjs;
    const spec = m[2];
    const body = (c) => (m.cjs ? toCjs(newBody(c)) : newBody(c));
    if (!/^\.{1,2}\//.test(spec)) {
      if (/^(node:|data:|https?:)/.test(spec) || builtinModules.includes(spec)) continue;
      const entry = pkgEntry(spec);
      if (entry) { ts = /\.[cm]?tsx?$/.test(entry) && !m.cjs; if (fs.existsSync(entry)) { if (!m.cjs) jsExisting(entry, m[1]); } else add(entry, body(m[1])); continue; }
      const pkgName = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
      let up = dir, installed = false;
      for (;; up = path.dirname(up)) { if (fs.existsSync(path.join(up, 'node_modules', pkgName))) { installed = true; break; } if (up === path.dirname(up)) break; }
      if (!installed) (made.warnings ??= []).push(`${spec} (package import: no workspace package or tsconfig path resolves it)`);
      continue;
    }
    const abs = path.resolve(dir, spec);
    const exts = ['', '.ts', '.tsx', '.js', '.mjs', '.cjs', '.jsx', '/index.ts', '/index.js'];
    const stem = abs.replace(/\.[cm]?[jt]sx?$/, '');
    const found = exts.map((e) => (fs.existsSync(abs + e) && fs.statSync(abs + e).isFile() ? abs + e : fs.existsSync(stem + e) && fs.statSync(stem + e).isFile() ? stem + e : null)).find(Boolean);
    if (found) { if (m.cjs) cjsExisting(found, m[1]); else jsExisting(found, m[1]); continue; }
    const target = /\.[cm]?[jt]sx?$/.test(abs) ? (ts ? stem + '.ts' : abs) : abs + (ts ? '.ts' : '.js');
    add(target, body(m[1]));
  }
  made.report = report;
  return made;
}

// body of the test annotated with `@id <id>` (up to the next @id), as lines
// ExUnit: the last test of a module ends at its own `end`, not at EOF (helpers `defp` after it are outside the test)
function exClamp(ls, start, end) {
  const t = ls.findIndex((l, i) => i > start && i < end && /^\s*test\s+"/.test(l));
  if (t < 0) return end;
  const ind = /^\s*/.exec(ls[t])[0].length;
  for (let i = t + 1; i < end; i++) if (/^\s*end\b/.test(ls[i]) && /^\s*/.exec(ls[i])[0].length === ind) return i + 1;
  return end;
}
// `assert.throws(fn)` / `pytest.raises(Exception)` without a matcher is satisfied by the stub's own "not implemented" error (#283)
function vacuousThrows(testPath, id) {
  const body = testBody(testPath, id).join('\n');
  if (/\b(?:pytest\.raises|assertRaises|assert_raises)\(\s*(?:Exception|BaseException|RuntimeError|NotImplementedError)\s*\)/.test(body)) return true;
  for (const m of body.matchAll(/\bassert\.(?:throws|rejects)\(/g)) {
    let depth = 1, commas = 0;
    for (let i = m.index + m[0].length; i < body.length && depth > 0; i++) {
      const c = body[i];
      if ('([{'.includes(c)) depth++; else if (')]}'.includes(c)) depth--; else if (c === ',' && depth === 1) commas++;
    }
    if (!commas) return true;
  }
  return false;
}
// the TypeError names a function defined in the test file itself (signature mismatch in the test's own helper), so no implementation is involved (#283)
function ownHelperTypeError(text, testPath) {
  const m = /TypeError: (?:[\w.]+\.)?(\w+)\(\) (?:got an unexpected keyword argument|got multiple values for argument|missing \d+ required (?:positional|keyword-only) arguments?|takes \d+ positional arguments? but)/.exec(text);
  return m && new RegExp(`^\\s*(?:async\\s+)?def\\s+${m[1]}\\s*\\(`, 'm').test(fs.readFileSync(path.join(ROOT, testPath), 'utf8')) ? m[1] : null;
}
function testBody(testPath, id) {
  const ls = fs.readFileSync(path.join(ROOT, testPath), 'utf8').split('\n');
  if (/\.py$/.test(testPath)) {
    const range = pythonScope(ls.join('\n'))?.find((r) => r.ids.includes(id));
    if (range) return ls.slice(range.start, range.end);
  }
  const start = ls.findIndex((l) => new RegExp(`@id\\s+${id}\\b`).test(l));
  if (start < 0) return [];
  let end = ls.findIndex((l, i) => i > start && /@id\s/.test(l));
  if (end < 0) end = ls.length;
  if (/\.exs$/.test(testPath)) end = exClamp(ls, start, end);
  return ls.slice(start, end);
}
const ASSERT_LINE = /(expect\s*\(|\b(?:Assert|CollectionAssert|StringAssert|FileAssert)\.\w+|\.Should\(|\bASSERT\w*\s*\(|\bCHECK\w*\s*\(|\bEXPECT\w*\s*\(|\bassert|\brefute|raises|toThrow|\.should|assertEquals|@test(?:_throws)?\b|expect_|\bif\b.*[!=]=|t\.(Error|Fatal))/;
// lines that belong to an assertion, including the continuation lines of a multi-line `assert_eq!(` / `expect(` call (#89)
function markAsserts(lines, extra = null) {
  const A = extra ? new RegExp(`${ASSERT_LINE.source}|${extra.source}`) : ASSERT_LINE;
  const flags = lines.map(() => false);
  for (let i = 0; i < lines.length; i++) {
    if (!A.test(lines[i])) continue;
    flags[i] = true;
    const from = lines[i].search(A);
    let depth = 0;
    for (let j = i, first = true; j < lines.length; j++, first = false) {
      const seg = first ? lines[j].slice(from) : lines[j];
      for (const c of seg) { if (c === '(') depth++; else if (c === ')') depth--; }
      if (!first) flags[j] = true;
      if (depth <= 0 || j - i > 12) break;
    }
  }
  return flags;
}
// Red caused by a stub called from setup (not from the asserted behaviour) is not evidence for the REQ
function setupOrigin(line, testPath, id, text = '') {
  // a missing method on a constructor-only stub (`x.m is not a function`, `has no attribute 'm'`) is a setup failure too (#75)
  const m = /not implemented:?\s*(?:in\s+)?(?:[\w$]+(?:::|\.|->))*([\w$]+)|NotImplementedError:?\s*\(?["']?([\w$]+)|unimplemented!?\(?\s*"?([\w$]+)|\.([\w$]+) is not a function|has no attribute '([\w$]+)'|'(?:[\w$]+\.)*([\w$]+)' object does not support the (?:async\w* )?context manager protocol/i.exec(line ?? '');
  let x = m?.[1] ?? m?.[2] ?? m?.[3] ?? m?.[4] ?? m?.[5] ?? m?.[6];
  if (x && /^(in|at|yet|for|by|on|here|the|a|an|from|and|is|to|of|error|exception)$/i.test(x)) x = undefined;
  const named = !!x; // name taken from the message; stack/panic-location derived names may be absent from the test
  // Go: a `panic: <msg>` stub; the first non-runtime frame is the stubbed function (#142)
  if (!x && /^panic: /m.test(text) && /^goroutine \d+/m.test(text)) {
    const gi = text.search(/^goroutine \d+/m);
    x = text.slice(gi).split('\n').slice(1).map((l) => /^(?:[\w.\/-]+)\.(?:\([^)]*\)\.)?([A-Za-z_]\w*)\(/.exec(l)).find((f) => f && !/^(panic|Fatal|Fatalf|Errorf|Skip)$/.test(f[1]) && !/^(?:runtime|testing)\./.test(f.input))?.[1];
  }
  // Rust: `unimplemented!()` / `todo!()` without a message: the panic location points into the stub fn (#142)
  if (!x && /not implemented|not yet implemented/i.test(`${line ?? ''}\n${text}`)) {
    const pl = /panicked at ([^\s:]+):(\d+)/.exec(text);
    if (pl) {
      const rel = pl[1];
      const cands = [path.resolve(ROOT, rel), ...(() => { const o = []; let dd = path.resolve(ROOT, path.dirname(testPath)); for (let k = 0; k < 4; k++) { o.push(path.resolve(dd, rel)); dd = path.dirname(dd); } return o; })()];
      const f = cands.find((c) => fs.existsSync(c) && fs.statSync(c).isFile());
      if (f) { const src = fs.readFileSync(f, 'utf8').split('\n'); for (let k = Number(pl[2]) - 1; k >= 0; k--) { const fm = /\bfn\s+([\w$]+)/.exec(src[k] ?? ''); if (fm) { x = fm[1]; break; } } }
    }
  }
  const typeInit = /TypeInitializationException/.test(`${line ?? ''}\n${text}`);
  // .NET: `NotImplementedException` carries no member name; use `NotImplementedException : Ns.Type.Member` or the first stack frame `at Ns.Type.Member(` (#124)
  if (!x && /NotImplementedException|method or operation is not implemented/i.test(`${line ?? ''}\n${text}`)) {
    const named = /NotImplementedException\s*:\s*(?:[\w$]+\.)*([\w$]+)\s*$/m.exec(text);
    const frame = /^\s*at\s+(?:[\w$<>`+]+\.)*([\w$<>`]+)\(/m.exec(text);
    x = (named?.[1] && !/^(The|A)$/.test(named[1]) ? named[1] : frame?.[1])?.replace(/[<>`]/g, '');
  }
  // C#: a static field initializer / type initializer that calls a stub fails before any test body runs (#142)
  if (typeInit) return x ?? 'static initializer';
  // ExUnit `setup`/`setup_all`/CaseTemplate failure (frame `__ex_unit_setup_N`) and pytest fixture error are setup whatever the exception is
  const exSetup = /__ex_unit_setup/.test(text), pySetup = /ERROR at setup of/.test(text);
  if (!x && exSetup) x = /function (?:[\w.]+\.)?([\w!?]+)\/\d+ is undefined/.exec(text)?.[1] ?? /^\s*(?:[\w.]+\.)?([a-z_][\w!?]*)\(/m.exec(text.slice(text.indexOf('stacktrace:') + 1))?.[1] ?? 'setup';
  if (!x && pySetup) x = /^\S+\.py:\d+: in (\w+)/m.exec(text)?.[1] ?? 'fixture';
  // a module-level `NAME = None` stub called by the test (`TypeError: 'NoneType' object is not callable`) is a stubbed setup call (#283)
  if (!x && /TypeError: 'NoneType' object is not callable/.test(text)) {
    const callees = [...(/^>\s+(.*)$/m.exec(text)?.[1] ?? '').matchAll(/(?<![\w$.])([A-Za-z_]\w*)\s*\(/g)].map((m) => m[1]);
    const pyFiles = spawnSync('git', ['ls-files', '-co', '--exclude-standard', '*.py'], { cwd: ROOT, encoding: 'utf8' }).stdout.split('\n').filter((f) => f && f !== testPath);
    const srcs = pyFiles.slice(0, 400).map((f) => { try { return fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch { return ''; } });
    x = callees.find((n) => srcs.some((c) => new RegExp(`^${n}\\s*=\\s*None\\s*$`, 'm').test(c)));
  }
  if (!x) return null;
  if (exSetup || pySetup) return x;
  const all = fs.readFileSync(path.join(ROOT, testPath), 'utf8').split('\n');
  // Rust `use m::{encode as delta_encode}`: the alias is the same subject (#263)
  const names = [x, ...[...all.join('\n').matchAll(new RegExp(`(?<![\\w$])${x.replace(/[$]/g, '\\$&')}\\s+as\\s+([\\w$]+)`, 'g'))].map((m) => m[1])];
  const re = new RegExp(`(?<![\\w$])(?:${names.map((n) => n.replace(/[$]/g, '\\$&')).join('|')})(?![\\w$])`);
  const start = all.findIndex((l) => new RegExp(`@id\\s+${id}\\b`).test(l));
  let end = all.findIndex((l, i) => i > start && /@id\s/.test(l));
  if (end < 0) end = all.length;
  if (/\.exs$/.test(testPath)) end = exClamp(all, start, end);
  // assertion helpers: functions of the test file that assert, or named check*/verify*/…; a call to one is an assertion line
  const helperNames = [...new Set(all.flatMap((l, i) => {
    const d = /^\s*(?:pub\s+)?(?:async\s+)?(?:fn|def|function|func)\s+(\w+)/.exec(l);
    if (!d || (i >= start && i < end) || /^test/i.test(d[1])) return [];
    const nx = all.findIndex((q, k) => k > i && (/@id\s/.test(q) || /^\s*(?:pub\s+)?(?:async\s+)?(?:fn|def|function|func)\s/.test(q)));
    return ASSERT_LINE.test(all.slice(i + 1, nx < 0 ? all.length : nx).join('\n')) ? [d[1]] : [];
  })), ...[...all.join('\n').matchAll(/\b((?:check|verify|ensure|validate)\w*)\s*\(/gi)].map((m) => m[1])];
  const helperExtra = helperNames.length ? new RegExp(`(?<![\\w$.])(?:${helperNames.join('|')})\\s*\\(`) : null;
  const mark = (ls) => markAsserts(ls, helperExtra);
  const inA = new Array(start).fill(false).concat(mark(all.slice(start, end)));
  // a bare `eng.run()` statement is the act only when the assertions inspect state rather than call other code (otherwise a stubbed call before them is setup)
  const isBareAct = (l) => {
    if (!/^\s*(?:await\s+)?(?:\(new\s+[\w\\]+\(.*?\)\)|(?:[\w$.]|->)+)(?:::[\w$]+|->[\w$]+)*\s*\(.*\)\s*;?\s*$/.test(l)) return false;
    const bl = testBody(testPath, id), bf = mark(bl);
    const own = /(?:\b(?:(?:Assert|CollectionAssert|StringAssert)\.\w+|assert\w*|expect\w*|ASSERT\w*|EXPECT\w*|CHECK\w*|len|sorted|list|set|tuple|dict|str|sum|vec|toBe\w*|toEqual|toHaveLength|toContain|equal|deepEqual|deepStrictEqual|strictEqual|eq|ne|raises)!?|@test)\s*\(/g;
    return !bl.filter((_, i) => bf[i]).some((a) => /[\w$]\s*\(/.test(a.replace(own, '')));
  };
  // `const r = sut(...)` followed by assertions on r is the act under test, not setup
  const assertedResult = (hitLines) => {
    const WRAP = '(?:(?:list|len|sorted|set|tuple|dict|str|int|float|sum|bool|String|Number|JSON\\.stringify|Object\\.\\w+|Array\\.from)\\(\\s*)*';
    // single, tuple-unpacked (`a, b = f()` / `let (a, b) = f()`) and Go `:=` targets (#110)
    // a bare `fill(x, out)` / `c.push(v)` statement acts on its arguments and receiver: asserting them asserts the call (out-parameter, mutator-then-query)
    const bareStmt = (l) => /^\s*(?:await\s+)?(?:\(new\s+[\w\\]+\(.*?\)\))?(?:[\w$.]|->|::)+\s*\(.*\)\s*;?\s*$/.test(l) && !/^\s*(?:if|for|while|with|return|assert\w*|expect\w*)\b/.test(l);
    const KW = /^(?:None|True|False|self|this|null|nil|true|false|undefined|mut|ref)$/;
    const stateVars = hitLines.filter(bareStmt).flatMap((l) => [...(/\(([^()]*)\)/.exec(l)?.[1] ?? '').matchAll(/(?<![\w$.])[A-Za-z_$][\w$]*(?![\w$(])/g)].map((m) => m[0]).concat(/^\s*(?:await\s+)?([A-Za-z_$][\w$]*)(?:\.|->)/.exec(l)?.[1] ?? []).filter((v) => !KW.test(v)));
    const recvVars = hitLines.filter(bareStmt).flatMap((l) => /^\s*(?:await\s+)?([A-Za-z_$][\w$]*)(?:\.|->)/.exec(l)?.[1] ?? []).filter((v) => !KW.test(v));
    let vars = hitLines.flatMap((l) => { const m = /^\s*(?:(?:const|let|var)\s+(?:mut\s+)?|(?:final\s+)?(?:[A-Z][\w.<>\[\],?]*|int|long|double|float|boolean|char|byte|short)\s+)?[\[{(]?\s*([A-Za-z_$][\w$]*(?:\s*,\s*(?:mut\s+)?[A-Za-z_$][\w$]*)*)\s*[\])}]?\s*(?::(?!=)[^=]+)?:?=(?!=)/.exec(l) ; return m ? m[1].split(/\s*,\s*(?:mut\s+)?/).filter((v) => v !== '_') : []; });
    // `with X(..) as c:` binds the context manager; only its plain use (not `c.m(..)`) asserts it
    const withVars = hitLines.flatMap((l) => { const m = /\bwith\s+.*\bas\s+([A-Za-z_]\w*)\s*:/.exec(l); return m ? [m[1]] : []; });
    const bl = testBody(testPath, id), bf = mark(bl);
    const body = bl.filter((_, i) => bf[i]);
    const esc = (v) => v.replace(/[$]/g, '\\$&');
    const subject = (v) => new RegExp(`(?:expect\\(\\s*(?:await\\s+)?|(?:Assert|CollectionAssert|StringAssert)\\.\\w+\\(\\s*|assert\\w*!?(?:\\.\\w+)?\\(\\s*|\\b(?:assert|refute)\\s+(?:not\\s+)?)${WRAP}&?${esc(v)}(?![\\w$])`);
    // the variable anywhere in an assertion as a plain value (chained comparison, tuple, non-leading argument, `v.attr`, `[...v]`, `helper(v)`), but not as a call receiver (#142)
    const plainRe = (v) => new RegExp(`(?<![\\w$])(?<![\\w$)\\]]\\.)${esc(v)}(?![\\w$])(?!\\s*\\()(?!\\.[\\w$]+\\s*\\()`);
    const ASSERT_KW = /(?:\b(?:(?:Assert|CollectionAssert|StringAssert)\.\w+|assert\w*|expect\w*|ASSERT\w*|EXPECT\w*|CHECK\w*|toBe\w*|toEqual|equal|deepEqual|deepStrictEqual|strictEqual|eq|ne)!?)\s*\(/g;
    // an assertion that also calls unrelated code (`assert add(1, 2) == 3 + seed`) does not make `seed` the asserted result
    // an assertion that feeds the variable into another module call (`Log.entries(l)`) inspects that call; the variable is its input, i.e. setup (#263)
    const feeds = (v, l) => new RegExp(`(?<![\\w$])[A-Z][\\w$]*(?:\\.[\\w$]+)*\\.[a-z_][\\w$]*[!?]?\\([^()]*(?<![\\w$])${esc(v)}(?![\\w$])`).test(l);
    const plain = (v) => ({ test: (l) => plainRe(v).test(l) && !feeds(v, l) && ![...l.replace(ASSERT_KW, '(').matchAll(/[\w$]\s*\(([^()]*)\)/g)].some((c) => !plainRe(v).test(c[1]) && !new RegExp(`(?<![\\w$])${esc(v)}(?![\\w$])`).test(c[1])) });
    // a variable computed from the act result (`got = [t for t in toks ...]`, `x = obj(r)`) that is asserted makes the act the asserted subject (#142)
    for (let k = 0; k < 2; k++) {
      const derived = bl.filter((_, i) => !bf[i]).flatMap((l) => { const m = /^\s*(?:(?:const|let|var)\s+)?([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=(?!=)(.*)$/.exec(l); return m && vars.some((v) => plainRe(v).test(m[2])) ? [m[1]] : []; })
        // `const [a, b] = r` / `const { a, b: c } = r` destructure the stored result; `r.forEach((x) => ...)` binds its elements
        .concat(bl.flatMap((l) => { const m = /^\s*(?:const|let|var)\s+[\[{]([^\]}=]*)[\]}]\s*=(?!=)(.*)$/.exec(l); return m && vars.some((v) => plainRe(v).test(m[2])) ? m[1].split(',').map((n) => /([A-Za-z_$][\w$]*)\s*$/.exec(n.replace(/=.*$/, ''))?.[1]).filter(Boolean) : []; }))
        .concat(bl.flatMap((l) => vars.flatMap((v) => { const m = new RegExp(`(?<![\\w$])${esc(v)}\\.\\w+\\(\\s*(?:async\\s*)?\\(?\\s*([A-Za-z_$][\\w$]*(?:\\s*,\\s*[A-Za-z_$][\\w$]*)*)\\s*\\)?\\s*=>`).exec(l); return m ? m[1].split(/\s*,\s*/) : []; })))
        // `for p in &s.polygons` / `for (const p of s.items)` / `for x in r:` bind the elements of the stored result (r25d)
        .concat(bl.flatMap((l) => { const m = /^\s*for\s+(?:await\s+)?\(?\s*(?:(?:const|let|var)\s+)?(?:mut\s+)?([A-Za-z_$][\w$]*)\s+(?:of|in)\s+(.*?)\)?\s*(?:\{|:)?\s*$/.exec(l); return m && vars.some((v) => plainRe(v).test(m[2])) ? [m[1]] : []; }));
      vars = [...new Set([...vars, ...derived])];
    }
    vars = [...new Set([...vars, ...stateVars])];
    const goIf = (v) => new RegExp(`\\bif\\b[^{]*?(?<![\\w$.])${v.replace(/[$]/g, '\\$&')}(?![\\w$])`);
    // the stored result (or an argument the call filled) is the receiver of an asserted expression (`s.get()`, `out.getvalue()`, `r.lines()`): the call is the act whatever it is named (r25d)
    const recvAsserted = (v) => new RegExp(`(?<![\\w$.])${esc(v)}(?:\\.|\\[)`);
    return vars.some((v) => body.some((l) => subject(v).test(l) || goIf(v).test(l) || plain(v).test(l) || (recvAsserted(v).test(l) && !feeds(v, l)))) || recvVars.some((v) => body.some((l) => new RegExp(`(?<![\\w$.])${esc(v)}(?:\\.|->)[\\w$]+\\s*\\(`).test(l))) || withVars.some((v) => body.some((l) => plain(v).test(l)));
  };
  // `save(p, x)` then `got = load(p); assert got == x`: a bare stub call that shares an argument with the call whose bound result is asserted is the act (#283)
  const pairedAct = (hitLines) => {
    const bl = testBody(testPath, id), bf = mark(bl);
    return hitLines.filter(isBareAct).some((h) => {
      const args = [...((/\(([^()]*)\)/.exec(h)?.[1] ?? '').match(/(?<![\w$.])[A-Za-z_$][\w$]*/g) ?? []), ...(/^\s*(?:await\s+)?([A-Za-z_$][\w$]*)(?:\.|->)/.exec(h)?.[1] ?? [])];
      return bl.some((l, i) => !bf[i] && !re.test(l) && /[\w$]\s*\(/.test(l) && args.some((a) => new RegExp(`(?<![\\w$.])${a.replace(/[$]/g, '\\$&')}(?![\\w$])`).test(l)) && assertedResult([l]));
    });
  };
  // the stub called in an `if`/`for`/`while` condition decides the test outcome: it is the act, not setup (#263)
  const condAct = (l) => /^\s*(?:\}\s*else\s+)?(?:if|for|while)\b[^{]*/.test(l) && re.test(l.replace(/^\s*(?:\}\s*else\s+)?(?:if|for|while)\b/, ''));
  // the stub is hit inside a helper defined outside the test: the test's calls to that helper are setup unless its result is asserted (#106)
  let helperAsserted = false;
  const helperVerdict = () => {
    const DEF = /^\s*(?:pub\s+)?(?:async\s+)?(?:fn|defp?|function|func)\s+(\w+)|^\s*(?:const|let)\s+(\w+)\s*=\s*(?:async\s*)?\(/;
    const defs = all.map((l, i) => ({ i, n: DEF.exec(l) })).filter((d) => d.n).map((d) => ({ i: d.i, name: d.n[1] ?? d.n[2] }));
    const bodyOf = (d, k) => all.slice(d.i, k + 1 < defs.length ? defs[k + 1].i : all.length);
    const outside = defs.filter((d) => (d.i < start || d.i >= end) && !/^test/i.test(d.name));
    const helpers = outside.filter((d) => bodyOf(d, defs.indexOf(d)).some((l) => re.test(l))).map((d) => d.name);
    // helpers that reach the stub only through other helpers (`check_same` -> `inl` -> stub) are setup/act wrappers too (#244)
    for (let grew = true; grew;) {
      grew = false;
      for (const d of outside) if (!helpers.includes(d.name) && bodyOf(d, defs.indexOf(d)).some((l) => helpers.some((h) => new RegExp(`(?<![\\w$])${h}\\s*\\(`).test(l)))) { helpers.push(d.name); grew = true; }
    }
    const bl = testBody(testPath, id), bf = mark(bl);
    for (const h of helpers) {
      const hre = new RegExp(`(?<![\\w$])${h}\\s*\\(`);
      const calls = bl.filter((l, i) => hre.test(l) && !DEF.test(l));
      if (!calls.length) continue;
      // `assert_eq!(cost(&p(), 1), 2)`: the helper only feeds another call, its own value is not asserted
      // an outer call that is itself an assertion helper of the test file (`near(got(1))`) asserts the value (r26d)
      const feeding = (l) => { const m = new RegExp(`(?<![\\w$])([\\w$]+)(?:::[\\w$]+|\\.[\\w$]+)*!?\\([^()]*(?<![\\w$])${h}\\s*\\(`).exec(l.replace(/^\s*(?:\w+!|assert\w*)\(/, '')); return !!m && !helperNames.includes(m[1]); };
      if (bl.some((l, i) => bf[i] && hre.test(l) && !feeding(l))) { helperAsserted = true; return null; }
      if (assertedResult(calls)) { helperAsserted = true; return null; }
      return x;
    }
    return null;
  };
  const base = path.basename(testPath).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const sites = [...new Set([...text.matchAll(new RegExp(`${base}:(?:line )?(\\d+)`, 'g'))].map((f) => Number(f[1]) - 1))].filter((i) => i >= start && i < end);
  if (sites.length) {
    const hit = sites.filter((i) => re.test(all[i])).map((i) => ({ l: all[i], i }));
    // a call inside `with pytest.raises(...)` / assertRaises / assertThrows on the preceding line is the asserted behaviour
    if (hit.some(({ i }) => /raises|assertRaises|assertThrows|assert_raises/.test(all[i - 1] ?? ''))) return null;
    if (!mark(all.slice(start, end)).some(Boolean)) return null;
    if (!hit.length) return helperVerdict();
    if (hit.some(({ i }) => inA[i])) return null;
    // `match f(..).unwrap() { .. }` / `match Regex::new(..) { .. }`: the scrutinee is the behaviour under test (#110)
    if (hit.some(({ l }) => /^\s*(?:match|switch)\b/.test(l))) return null;
    // Go `if err := sut(..); err != nil {` tests the call it initializes (#245)
    if (hit.some(({ l }) => /^\s*if\s+[\w\s,]+:?=[^;]*;/.test(l))) return null;
    if (hit.some(({ l }) => condAct(l))) return null;
    const firstAssert = inA.findIndex((v, i) => v && i >= start);
    const prevStmt = (() => { for (let k = firstAssert - 1; k > start; k--) if (all[k].trim() && !/^\s*(\/\/|#)/.test(all[k])) return k; return -1; })();
    if (hit.some(({ i, l }) => i === prevStmt && /\.(unwrap|expect)\s*\(/.test(l))) return null;
    if (hit.some(({ i, l }) => i === prevStmt && isBareAct(l))) return null; // bare act statement (#124)
    return assertedResult(hit.map(({ l }) => l)) || pairedAct(hit.map(({ l }) => l)) ? null : x;
  }
  const bl = testBody(testPath, id), bf = mark(bl);
  const asserts = bl.filter((_, i) => bf[i]);
  if (!asserts.length) return null;
  if (bl.some((l, i) => !bf[i] && condAct(l))) return null;
  if (asserts.some((l) => re.test(l))) return null;
  const viaHelper = helperVerdict();
  if (viaHelper) return viaHelper;
  if (helperAsserted) return null; // the helper's result is the asserted subject (#124)
  // `step(..).unwrap();` as the last statement before the first assertion is the act under test (#106)
  const firstA = bf.findIndex(Boolean);
  const lastStmt = bl.slice(0, firstA).map((l, i) => ({ l, i })).filter(({ l }) => l.trim() && !/^\s*(\/\/|#)/.test(l)).at(-1);
  if (lastStmt && re.test(lastStmt.l) && /\.(unwrap|expect)\s*\(/.test(lastStmt.l)) return null;
  // a bare call statement (`eng.run()`, `run_with_retry(..)`) directly before the first assertion is the act, its side effect is asserted (#124)
  if (lastStmt && re.test(lastStmt.l) && isBareAct(lastStmt.l)) return null;
  const stubLines = bl.filter((l, i) => re.test(l) && !bf[i]);
  // trait/operator methods are reached through sugar (`.parse()`, `a | b`, `.to_string()`, `{}`), never by name in the test (#299)
  const sugar = /^(?:from_str|from|into|try_from|try_into|to_string|fmt|eq|ne|cmp|partial_cmp|hash|clone|default|deref|index|neg|not|add|sub|mul|div|rem|bitor|bitand|bitxor|shl|shr|next|drop|as_ref|borrow|__\w+__)$/.test(x);
  // a stub the test never names (default trait method / SUT internals delegating to it) is reached through the asserted call itself
  return (!stubLines.length && !(named && !sugar && /is not a function|has no attribute/.test(line ?? ''))) || assertedResult(stubLines) || pairedAct(stubLines) ? null : x;
}

function goTestTarget(testPath, id) {
  const src = fs.readFileSync(path.join(ROOT, testPath), 'utf8');
  const at = new RegExp(`@id\\s+${id}\\b`).exec(src);
  if (!at) return null;
  const clean = src.replace(/"(?:\\.|[^"\\])*"|`[^`]*`|'(?:\\.|[^'\\])*'|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (s) => s.replace(/[^\n]/g, ' '));
  const close = (open) => {
    let depth = 1;
    for (let i = open + 1; i < clean.length; i++) {
      if (clean[i] === '{') depth++;
      if (clean[i] === '}' && --depth === 0) return i;
    }
    return clean.length;
  };
  const adjacent = (start) => start >= at.index && !clean.slice(at.index, start).trim();
  const funcs = [...clean.matchAll(/^func\s+((?:Test|Fuzz|Benchmark|Example)\w*)\s*\([^)]*\)\s*\{/gm)].map((m) => ({ name: m[1], start: m.index, open: m.index + m[0].length - 1 }));
  const fn = funcs.find((f) => adjacent(f.start)) ?? funcs.find((f) => f.open < at.index && close(f.open) > at.index);
  if (!fn) return null;
  const runs = [...src.matchAll(/\b\w+\.Run\s*\(\s*("(?:\\.|[^"\\])*"|`[^`]*`|[^,{}]+)\s*,\s*func\s*\([^)]*\)\s*\{/g)].filter((m) => clean.slice(m.index, m.index + 1).trim()).map((m) => {
    let name = null;
    try { name = m[1].startsWith('`') ? m[1].slice(1, -1) : JSON.parse(m[1]); } catch {}
    const open = m.index + m[0].length - 1;
    return { name: typeof name === 'string' ? name.replace(/\s/g, '_') : null, start: m.index, open, end: close(open) };
  }).filter((r) => r.start > fn.open && r.end < close(fn.open));
  const direct = runs.find((r) => adjacent(r.start));
  const containers = runs.filter((r) => r.open < at.index && r.end > at.index);
  if (direct) containers.push(direct);
  containers.sort((a, b) => a.open - b.open);
  if (containers.some((r) => r.name === null)) return null;
  const parts = [fn.name, ...containers.map((r) => r.name)];
  return { name: parts.join('/'), pattern: parts.flatMap((n) => n.split('/')).map((n) => '^' + n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$').join('/') };
}
// positive custom tags of a `//go:build` constraint; GOOS/GOARCH/toolchain tags are provided by the toolchain itself
function goBuildTags(src) {
  const line = /^\/\/go:build\s+(.+)$/m.exec(src.split(/^package\s/m)[0])?.[1];
  if (!line) return [];
  const known = /^(linux|darwin|windows|freebsd|openbsd|netbsd|solaris|android|ios|js|wasip1|plan9|aix|dragonfly|illumos|unix|cgo|amd64|arm64|arm|386|riscv64|ppc64|ppc64le|s390x|wasm|mips\w*|gc|gccgo|race|msan|asan|ignore|go1\.\d+)$/;
  const tags = [];
  for (const m of line.matchAll(/(!?)\s*([A-Za-z_][\w.]*)/g)) if (!m[1] && !known.test(m[2]) && !tags.includes(m[2])) tags.push(m[2]);
  return tags;
}
function goResult(text, target) {
  let result = null, lastRun = null;
  for (const line of text.split('\n')) {
    const run = /^=== (?:RUN|CONT)\s+(\S+)/.exec(line);
    if (run) lastRun = run[1];
    const m = /^\s*--- (PASS|FAIL|SKIP):\s+(\S+)/.exec(line);
    if (m?.[2] === target) result = m[1].toLowerCase();
    // a passing benchmark prints `BenchmarkX-8  1  123 ns/op` and no `--- PASS` row (#215)
    const b = /^(Benchmark\w*?)(?:-\d+)?\s+\d+\s+[\d.]+\s+ns\/op/.exec(line);
    if (b?.[1] === target && result !== 'fail') result = 'pass';
    if (line.startsWith('{')) {
      try { const e = JSON.parse(line); if (e.Test === target && /^(pass|fail|skip)$/.test(e.Action)) result = e.Action; if (e.Test && /^(run|cont)$/.test(e.Action)) lastRun = e.Test; } catch {}
    }
  }
  // an unrecovered panic (e.g. in a goroutine) kills the test binary before any `--- FAIL`: the test that was running failed
  if (!result && lastRun === target && /(?:^|"Output":")panic: /m.test(text) && /(?:^|\n|")FAIL\s/.test(text)) result = 'fail';
  return result;
}
function goOutput(text) {
  return text.split('\n').map((line) => {
    if (!line.startsWith('{')) return line + '\n';
    try { const e = JSON.parse(line); return typeof e.Output === 'string' ? e.Output : ''; } catch { return line + '\n'; }
  }).join('');
}

// name used for {idu}: the lowercase ID when the file contains it, else the name of the test declared right below `@id` (camelCase / @DisplayName styles)
// ExUnit: the `test ".."` after `# @id`, named `test <describe> <name>` in reports, plus its line for `mix test file:LINE`
function exTest(testPath, id) {
  const ls = fs.readFileSync(path.join(ROOT, testPath), 'utf8').split('\n');
  const at = ls.findIndex((l) => new RegExp(`@id\\s+${id}\\b`).test(l));
  if (at < 0) return null;
  let desc = null, descIndent = -1;
  for (let i = 0; i < ls.length; i++) {
    const indent = /^\s*/.exec(ls[i])[0].length;
    const d = /^\s*describe\s+"((?:[^"\\]|\\.)*)"/.exec(ls[i]);
    if (d) { desc = d[1]; descIndent = indent; }
    else if (desc !== null && /^\s*end\b/.test(ls[i]) && indent === descIndent) desc = null;
    if (i <= at) continue;
    if (/@id\s/.test(ls[i])) return null;
    const t = /^\s*test\s+"((?:[^"\\]|\\.)*)"/.exec(ls[i]);
    if (t) return { name: desc !== null ? `test ${desc} ${t[1]}` : `test ${t[1]}`, line: i + 1 };
  }
  return null;
}
function testName(testPath, id) {
  if (/\.exs$/.test(testPath)) { const ex = exTest(testPath, id); if (ex) return ex.name; }
  const idu = id.toLowerCase().replaceAll('-', '_');
  const text = fs.readFileSync(path.join(ROOT, testPath), 'utf8');
  if (/_test\.go$/.test(testPath)) {
    const target = goTestTarget(testPath, id);
    if (target) return target.name;
    const name = /^func\s+((?:Test|Fuzz|Benchmark|Example)\w*)\s*\(/m.exec(testBody(testPath, id).join('\n'))?.[1];
    if (name) return name;
  }
  if (/\.py$/.test(testPath)) {
    const body = testBody(testPath, id).join('\n');
    const name = /^\s*(?:async\s+)?def\s+(\w+)\s*\(/m.exec(body)?.[1];
    if (name) return name;
  }
  if (BRACE_TEST.test(testPath)) {
    const body = testBody(testPath, id).join('\n').replace(/^\s*(?:#\[[^\n]*\]|@\w+(?:\([^\n]*\))?|\[[^\n]*\])\s*/gm, '');
    // `TEST(name) {`, `TEST(suite, name) {`, `DEFINE_X(name, ...)` and Rust `case!(name, ...)` invocations below the annotation name the test (#217/#220/#223)
    const first = body.split('\n').find((l) => l.trim() && !/^\s*(?:\/\/|\/\*|\*|#\[|@|\[)/.test(l)) ?? '';
    const call = /^\s*([A-Za-z_]\w*)\s*(!?)\s*\(\s*([A-Za-z_]\w*)\s*(?:,\s*([A-Za-z_]\w*))?/.exec(first);
    if (call && (call[2] || (/\.(?:c|cc|cpp|cxx)$/.test(testPath) && /^[A-Z][A-Z0-9_]*$/.test(call[1]))) && !/^(?:if|for|while|switch|return|assert\w*)$/i.test(call[1])) return /^(?:TEST|TEST_F|TEST_P|TYPED_TEST|TYPED_TEST_P|SCENARIO)$/.test(call[1]) && call[4] ? call[4] : call[3];
    const name = /\b(?:fn|function)\s+(\w+)\s*\(|^\s*(?:[\w:<>\[\].?*&]+\s+)+(\w+)\s*\(/m.exec(body);
    if (name) return name[1] ?? name[2];
  }
  // keep the case used in the file: NUnit/xUnit FullyQualifiedName~ is case-sensitive (#141)
  const cased = new RegExp(`(?<![0-9A-Za-z_])${idu}(?![0-9A-Za-z_])`, 'i').exec(text)?.[0] ?? new RegExp(idu, 'i').exec(text)?.[0];
  if (cased) return cased;
  const ls = text.split('\n');
  const at = ls.findIndex((l) => new RegExp(`@id\\s+${id}\\b`).test(l));
  for (const l of ls.slice(at + 1, at + 8)) {
    // C# attributes ([Test], [TestCase(1, 2)], [TestMethod], [DataRow(..)], [Fact]) are not the test name (#137)
    const d = l.replace(/^\s*(@\w+(\([^)]*\))?\s*)+/, '').replace(/^\s*(\[(?:[^\[\]"]|"(?:[^"\\]|\\.)*")*\]\s*)+/, '');
    if (!d.trim() || /^\s*(\/\/|\*|\/\*)/.test(d)) continue;
    const m = /(\w+)\s*\(/.exec(d);
    if (m && !/^(if|for|while|switch|return)$/.test(m[1])) return m[1];
  }
  return idu;
}

// merging two branches that both appended to the ledger: union of both sides (deduped), ordered by time, re-chained (#79)
function mergeLedger() {
  if (!fs.existsSync(LEDGER)) { out('no ledger'); return 2; }
  const seen = new Set();
  const es = [];
  // the leading run of intact, correctly chained lines is kept byte-identical (#213)
  const kept = [];
  let prefixOpen = true;
  let prev = '';
  let at = -Infinity;
  for (const l of fs.readFileSync(LEDGER, 'utf8').split('\n')) {
    if (!l.trim() || /^(<{7}|={7}|>{7})/.test(l)) { if (l.trim()) prefixOpen = false; continue; }
    let e;
    try { e = JSON.parse(l); } catch { out(`LEDGER CORRUPT: cannot parse line: ${l.slice(0, 80)}`); return 2; }
    const problem = ledgerEventProblem(e);
    if (problem) { out(`LEDGER FAIL: invalid event at seq ${e?.seq ?? es.length + kept.length + 1}: ${problem}`); return 1; }
    const { seq, prev: pv, hash, ...rest } = e;
    const k = JSON.stringify(rest);
    if (prefixOpen && pv === prev && seq === kept.length + 1 && hash === entryHash(e) && Date.parse(e.at) >= at) { kept.push(l); seen.add(k); prev = hash; at = Date.parse(e.at); continue; }
    prefixOpen = false;
    if (seen.has(k)) continue;
    seen.add(k);
    es.push(rest);
  }
  // An older branch event can precede the intact prefix; preserve only its chronologically safe part.
  const earliest = es.reduce((min, e) => Math.min(min, Date.parse(e.at)), Infinity);
  const moved = [];
  while (kept.length && Date.parse(JSON.parse(kept.at(-1)).at) > earliest) {
    const { seq, prev: pv, hash, ...rest } = JSON.parse(kept.pop());
    moved.push(rest);
  }
  prev = kept.length ? JSON.parse(kept.at(-1)).hash : '';
  const tail = [...moved.reverse(), ...es].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const outLines = [...kept, ...tail.map((e, i) => { const full = { v: 1, seq: kept.length + i + 1, ...e, prev }; delete full.hash; full.hash = entryHash(full); prev = full.hash; return JSON.stringify(full); })];
  const problem = verifyChain(outLines.map((l) => JSON.parse(l)));
  if (problem) { out(`LEDGER FAIL: ${problem}`); return 1; }
  fs.writeFileSync(LEDGER, outLines.join('\n') + '\n');
  out(`ledger merged: ${outLines.length} entries (${kept.length} unchanged, ${tail.length} re-chained; review with git diff; tdd check)`);
  return 0;
}

// Julia runs the whole file: read the "Test Summary:" table to see whether the target testset itself failed
function juliaSummaryRows(plain) {
  let cols = null;
  const rows = [];
  for (const line of plain.split('\n')) {
    if (/Test Summary:/.test(line)) { cols = [...(line.split('|')[1] ?? '').matchAll(/\b(Pass|Fail|Error|Broken|Total|Time)\b/g)]; continue; }
    if (!cols || !line.includes('|')) continue;
    const [name, rest] = line.split('|'), values = rest.trim().split(/\s+/);
    if (!name.trim() || !/\d/.test(rest)) continue;
    const counts = {};
    cols.forEach((m, k) => { counts[m[1]] = values.length === cols.length ? +values[k] || 0 : +rest.slice(k ? cols[k - 1].index + cols[k - 1][0].length : 0, m.index + m[0].length).trim() || 0; });
    rows.push({ name: name.trim(), bad: (counts.Fail ?? 0) + (counts.Error ?? 0) > 0, executed: (counts.Pass ?? 0) + (counts.Fail ?? 0) + (counts.Error ?? 0), pass: counts.Pass ?? 0 });
  }
  return cols ? rows : null;
}
const juliaFailedSets = (plain) => (juliaSummaryRows(plain) ?? []).filter((r) => r.bad).map((r) => r.name);
function juliaSiblingFail(plain, id) {
  const rows = juliaSummaryRows(plain);
  if (!rows) return null;
  const mine = rows.filter((r) => new RegExp(`(?<![\\w-])${id}(?![\\w-])`, 'i').test(r.name));
  // another top-level testset failed first and aborted the file: this testset never ran (#143)
  if (!mine.length) return 'notrun';
  if (!mine.some((r) => r.executed)) return 'skip';
  return !mine.some((r) => r.bad) && rows.some((r) => r.bad) ? 'sibling' : null;
}
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function juliaFailureOutput(plain, id, testPath) {
  const lines = plain.split('\n'), boundary = new RegExp(`(?<![\\w-])${escapeRe(id)}(?![\\w-])`, 'i');
  const txt = fs.readFileSync(path.join(ROOT, testPath), 'utf8');
  const range = juliaRanges(txt)?.find((r) => r.id === id);
  const start = range ? txt.slice(0, range.start).split('\n').length : 0;
  const end = range ? txt.slice(0, range.end).split('\n').length : 0;
  const blocks = [];
  let found = false;
  for (const line of lines) {
    if (/^(?:.+?: )?(?:Test Failed|Error During Test) at\b/.test(line)) {
      found = true;
      const loc = / at (.*?):(\d+)(?::\d+)?\s*$/.exec(line);
      const ownLocation = loc && path.resolve(ROOT, loc[1]) === path.resolve(ROOT, testPath) && +loc[2] >= start && +loc[2] <= end;
      blocks.push({ selected: boundary.test(line.split(/: (?:Test Failed|Error During Test) at/)[0]) || !!ownLocation, lines: [line] });
    }
    else if (/Test Summary:|^ERROR: LoadError:/.test(line)) blocks.push({ selected: false, lines: [] });
    else blocks.at(-1)?.lines.push(line);
  }
  // macro-generated @test reports the macro definition's line: the stack frame at the call site is inside this test (#223)
  const inRange = (loc) => { const m = /^\s*@ (.+?):(\d+)\s*$/.exec(loc); return !!m && path.resolve(ROOT, m[1].replace(/^~(?=\/)/, os.homedir())) === path.resolve(ROOT, testPath) && +m[2] >= start && +m[2] <= end; };
  for (const b of blocks) if (!b.selected && b.lines.length && range && b.lines.some(inRange)) b.selected = true;
  const picked = blocks.filter((b) => b.selected).flatMap((b) => b.lines);
  return found ? picked.join('\n') : null;
}
function juliaScriptIndex(cmd) {
  const values = new Set(['-J', '--sysimage', '-L', '--load', '-H', '--machine-file', '-C', '--cpu-target', '-t', '--threads', '-p', '--procs', '-O', '--optimize', '--compile', '--startup-file', '--history-file', '--color', '--depwarn', '--check-bounds', '--banner']);
  for (let i = 1; i < cmd.length; i++) {
    if (/^(?:-e|-E|--eval|--print)(?:=|$)/.test(cmd[i])) return -1;
    if (cmd[i] === '--') return i + 1;
    if (values.has(cmd[i])) { i++; continue; }
    if (!cmd[i].startsWith('-')) return i;
  }
  return -1;
}
let rustRunnerSelection = null;
function rustIncludedSources(file, text) {
  const mask = maskBraces(text, true), scope = [], includes = [];
  for (const m of mask.matchAll(/\bmod\s+((?:r#)?\w+)\s*\{|[{}]|\binclude!\s*\(/g)) {
    if (m[1]) scope.push(m[1]);
    else if (m[0] === '{') scope.push(null);
    else if (m[0] === '}') scope.pop();
    else {
      const start = m.index + m[0].length;
      let end = start, depth = 1;
      for (; end < mask.length && depth; end++) { if (mask[end] === '(') depth++; else if (mask[end] === ')') depth--; }
      const expr = text.slice(start, end - 1);
      // include!(concat!(env!("OUT_DIR"), ...)) is a build.rs artifact: not owned source, so it is skipped
      if (/\benv!\s*\(\s*"OUT_DIR"\s*\)/.test(expr)) continue;
      const value = rustIncludeValue(expr, file);
      if (value === null) throw new Error(`REFUSED: unresolved Rust include ownership in ${rel(file)} — use a literal/concat!(env!("CARGO_MANIFEST_DIR"), ...) path or env!("OUT_DIR")`);
      includes.push({ file: path.resolve(path.dirname(file), value), mods: scope.filter(Boolean) });
    }
  }
  return includes;
}
function rustTarget(testPath, cwd = ROOT) {
  const abs = path.resolve(ROOT, testPath);
  let dir = path.dirname(abs), manifest;
  while (dir.startsWith(ROOT)) {
    if (fs.existsSync(path.join(dir, 'Cargo.toml'))) { manifest = path.join(dir, 'Cargo.toml'); break; }
    if (dir === ROOT) break;
    dir = path.dirname(dir);
  }
  if (!manifest) return null;
  let metadata;
  try { metadata = JSON.parse(cmdOut(['cargo', 'metadata', '--no-deps', '--format-version', '1', '--offline', '--manifest-path', manifest], cwd)); } catch { return null; }
  const routes = metadata.packages.filter((pkg) => !rustRunnerSelection?.package || pkg.name === rustRunnerSelection.package).flatMap((pkg) => pkg.targets.filter((t) => t.test !== false && !t.kind.includes('custom-build') && (!rustRunnerSelection?.kind || (rustRunnerSelection.kind === '--lib' ? t.kind.some((k) => /lib/.test(k)) : t.kind.includes(rustRunnerSelection.kind.slice(2)) && t.name === rustRunnerSelection.name))).flatMap((t) => {
    const entry = path.resolve(t.src_path);
    const find = (file, mods, visited = new Set()) => {
      if (file === abs) return [mods];
      if (visited.has(file) || !fs.existsSync(file)) return [];
      const seen = new Set([...visited, file]), found = [];
      const text = fs.readFileSync(file, 'utf8');
      for (const next of [...rustLocalModules(file, text, entry), ...rustIncludedSources(file, text)]) {
        found.push(...find(next.file, [...mods, ...next.mods], seen));
      }
      return found;
    };
    return find(entry, []).map((mods) => ({ package: pkg.name, dir: path.dirname(pkg.manifest_path), target: t.name, kind: t.kind, entry, mods }));
  }));
  const candidates = [...new Map(routes.map((c) => [JSON.stringify([c.package, c.entry, c.target, c.kind, c.mods]), c])).values()];
  if (candidates.length > 1) throw new Error(`REFUSED: Rust test ownership is ambiguous for ${testPath}; configure --lib/--bin/--test/--example explicitly`);
  if (!candidates.length) throw new Error(`REFUSED: no owning Cargo target resolved for ${testPath}; check include/module paths and the configured package/target`);
  return candidates.length === 1 ? candidates[0] : null;
}
// `/// @id TEST-.. @verifies REQ-..` in the doc comment above a ``` fence marks a Rust doc test: run it by its exact `cargo test --doc` name (#287)
let rustDocName = null;
function rustDocTest(testPath, id, cmd, cwd) {
  const ls = fs.readFileSync(path.join(ROOT, testPath), 'utf8').split('\n');
  const at = ls.findIndex((l) => new RegExp(`^\\s*//[/!].*@id\\s+${id}(?![\\w-])`).test(l));
  if (at < 0) return null;
  let fence = -1;
  for (let i = at; i < ls.length && /^\s*\/\/[/!]/.test(ls[i]); i++) if (/^\s*\/\/[/!]\s*(?:```|~~~)/.test(ls[i])) { fence = i; break; }
  if (fence < 0) return null;
  const owner = rustTarget(testPath, cwd);
  const pkg = cmd.findIndex((a) => /^(?:-p|--package)$/.test(a));
  const base = ['cargo', 'test', '--doc', ...(pkg >= 0 ? cmd.slice(pkg, pkg + 2) : owner ? ['-p', owner.package] : [])];
  const listed = cmdOut([...base, '--', '--list'], cwd).split('\n').map((l) => /^(.+ \(line (\d+)\)): test$/.exec(l)).filter((m) => m && +m[2] === fence + 1 && testPath.endsWith(m[1].split(' - ')[0].replace(/^\.\//, '')));
  if (listed.length !== 1) throw new Error(`REFUSED: cannot resolve the doc test of ${id} (${listed.length} candidates for line ${fence + 1} of ${testPath})`);
  return [...base, '--', listed[0][1]];
}
function qualifiedTestName(testPath, id, rust = false) {
  const name = testName(testPath, id);
  const text = fs.readFileSync(path.join(ROOT, testPath), 'utf8');
  const at = text.search(new RegExp(`@id\\s+${id}(?![\\w-])`));
  const scope = qualifiedTestScope(testPath, text, at, rust);
  return [/\.java$/.test(testPath) ? javaExecutionOwner(scope) : scope, name].filter(Boolean).join(rust ? '::' : '.');
}
// PHPUnit cannot run tests declared in an abstract class or trait: find the concrete test classes that inherit them (#222)
let phpOwnerOverride = null;
function phpConcreteOwners(testPath, owner) {
  const short = owner.split('\\').pop();
  const classes = [];
  for (const f of gitFiles('*.php')) {
    let text = '';
    try { text = fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch { continue; }
    const code = maskBraces(text);
    const ns = /^\s*namespace\s+([\w\\]+)\s*[;{]/m.exec(text)?.[1];
    for (const m of code.matchAll(/^\s*((?:(?:final|abstract|readonly)\s+)*)(class|trait)\s+(\w+)(?:\s+extends\s+\\?([\w\\]+))?[^{]*\{/gm)) {
      const start = m.index + m[0].length;
      const body = text.slice(start, matchingBrace(code, start - 1));
      const traits = [...body.matchAll(/^\s*use\s+([\w\\,\s]+?)\s*[;{]/gm)].flatMap((u) => u[1].split(',').map((x) => x.trim().split('\\').pop()));
      classes.push({ file: f, name: m[3], fq: ns ? `${ns}\\${m[3]}` : m[3], abstract: /abstract/.test(m[1]) || m[2] === 'trait', parent: m[4]?.split('\\').pop() ?? null, traits });
    }
  }
  const inherits = (c, seen = new Set()) => {
    if (seen.has(c)) return false;
    seen.add(c);
    if (c.name === short) return true;
    return [c.parent, ...c.traits].filter(Boolean).some((n) => classes.filter((x) => x.name === n).some((x) => inherits(x, seen)));
  };
  return classes.filter((c) => !c.abstract && c.name !== short && inherits(c));
}
function matchingBrace(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) { if (text[i] === '{') depth++; else if (text[i] === '}' && !--depth) return i; }
  return text.length;
}
function javaExecutionOwner(scope) {
  const types = sourceTypes().filter((t) => t.ext === '.java');
  const declaration = types.find((t) => t.fq === scope);
  if (!declaration || !new RegExp(`\\b(?:interface|abstract\\s+class)\\s+${escapeRe(declaration.name)}\\b`).test(maskBraces(declaration.text))) return scope;
  const inherits = (type, seen = new Set()) => {
    if (type.fq === scope) return true;
    if (seen.has(type.fq)) return false;
    seen.add(type.fq);
    const parents = new RegExp(`\\b(?:class|interface|record)\\s+${escapeRe(type.name)}(?:\\s*<[^>]*>)?\\s+(?:extends|implements)\\s+([^\\{]+)`).exec(maskBraces(type.text))?.[1] ?? '';
    return [...parents.replace(/\bimplements\b/g, ',').matchAll(/[\w.$]+/g)].some((m) => {
      const files = localTypeFiles(path.join(ROOT, type.file), type.text, m[0]);
      return types.filter((t) => files.includes(path.join(ROOT, t.file)) && (t.name === m[0].split('.').at(-1) || t.fq === m[0])).some((t) => inherits(t, new Set(seen)));
    });
  };
  const owners = [...new Set(types.filter((t) => {
    const text = maskBraces(t.text);
    return new RegExp(`\\b(?:class|record)\\s+${escapeRe(t.name)}\\b`).test(text) && !new RegExp(`\\babstract\\s+class\\s+${escapeRe(t.name)}\\b`).test(text) && inherits(t);
  }).map((t) => t.fq))];
  if (owners.length !== 1) throw new Error(`REFUSED: Java test ownership is ${owners.length ? 'ambiguous' : 'unresolved'} for ${scope}; declare the annotated test in a concrete test class or wrapper`);
  return owners[0];
}
function qualifiedTestScope(testPath, text, at, rust = false, rustMods = null) {
  const pre = maskBraces(text.slice(0, at), rust);
  const stack = [];
  const re = rust ? /\bmod\s+((?:r#)?\w+)\s*\{|([{}])/g : /\b(namespace|class|interface|trait|record(?:\s+(?:class|struct))?)\s+([\w.\\]+)[^{;]*([{;])|([{}])/g;
  let fileNs = '';
  for (const m of pre.matchAll(re)) {
    if (rust) { if (m[1]) stack.push(m[1]); else if (m[2] === '{') stack.push(null); else stack.pop(); }
    else if (m[1]) { if (m[3] === ';') fileNs = m[2]; else stack.push({ kind: m[1], name: m[2] }); }
    else if (m[4] === '{') stack.push(null);
    else stack.pop();
  }
  const pkg = /\.java$/.test(testPath) ? /^package\s+([\w.]+);/m.exec(text)?.[1] : '';
  const mods = rust ? rustMods ?? rustTarget(testPath)?.mods ?? [] : [];
  if (rust) return [...mods, ...stack.filter(Boolean)].join('::');
  const namespaces = stack.filter((s) => s?.kind === 'namespace').map((s) => s.name);
  const classes = stack.filter((s) => s && s.kind !== 'namespace').map((s) => s.name);
  if (/\.php$/.test(testPath)) return [fileNs, ...namespaces, classes.at(-1)].filter(Boolean).join('\\');
  return [pkg, fileNs, ...namespaces, classes.join(/\.java$/.test(testPath) ? '$' : '+')].filter(Boolean).join('.');
}
function ctestRows(plain) {
  const starts = [...plain.matchAll(/^\s*\d+\/\d+ Test\s+#\d+:\s+(.+?)\s+\.{2,}([^\n]*)/gm)];
  return starts.map((m, i) => ({ name: m[1], status: m[2], block: plain.slice(m.index, starts[i + 1]?.index ?? plain.length) }));
}
function ambiguousJavaMethod(testPath, id) {
  const txt = fs.readFileSync(path.join(ROOT, testPath), 'utf8'), name = testName(testPath, id);
  const cls = qualifiedTestScope(testPath, txt, txt.search(new RegExp(`@id\\s+${id}\\b`)));
  const masked = maskBraces(txt).replace(/@[\w.]+(?:\([^)]*\))?/g, (s) => s.replace(/[^\n]/g, ' '));
  const decl = new RegExp(`\\b[\\w.<>\\[\\]?]+\\s+${escapeRe(name)}\\s*\\([^{};]*\\)\\s*(?:throws\\s+[^{};]+)?\\s*\\{`, 'g');
  return [...masked.matchAll(decl)].filter((m) => qualifiedTestScope(testPath, txt, m.index) === cls).length > 1;
}
function javaCaseMatches(caseName, testPath, id) {
  const name = testName(testPath, id);
  const noArgs = new RegExp(`\\b${escapeRe(name)}\\s*\\(\\s*\\)`).test(testBody(testPath, id).join('\n'));
  return caseName === name || caseName?.startsWith(name + '[') || (noArgs ? new RegExp(`^${escapeRe(name)}\\(\\)(?:\\[|$)`).test(caseName ?? '') : caseName?.startsWith(name + '('));
}
function dotnetResult(file, testPath, id, exactSelection = false) {
  if (!file || !fs.existsSync(file)) return null;
  const text = fs.readFileSync(file, 'utf8'), methods = new Map();
  const attr = (t, key) => new RegExp(`\\b${key}="([^"]*)"`).exec(t)?.[1]?.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  for (const m of text.matchAll(/<UnitTest\b([^>]*)>([\s\S]*?)<\/UnitTest>/g)) {
    const method = /<TestMethod\b([^>]*)/.exec(m[2])?.[1];
    if (method) methods.set(attr(m[1], 'id'), { cls: attr(method, 'className'), name: attr(method, 'name') });
  }
  const name = testName(testPath, id), cls = qualifiedTestName(testPath, id).slice(0, -name.length - 1);
  const normalize = (s) => s?.replace(/<[^<>]*(?:<[^<>]*>[^<>]*)*>|\[[\s\S]*\]|`\d+/g, '').split(',')[0];
  const rows = [...text.matchAll(/<UnitTestResult\b([^>]*)/g)].filter((m) => {
    const method = methods.get(attr(m[1], 'testId'));
    return (method?.name === name || method?.name?.startsWith(name + '(') || exactSelection) && normalize(method?.cls) === cls;
  }).map((m) => attr(m[1], 'outcome'));
  return !rows.length ? 'notrun' : rows.includes('Failed') ? 'fail' : rows.includes('Passed') ? 'pass' : 'skip';
}
function targetVerdict(plain, testPath, id, selectedName = null, requireJavaResult = false, exactDotnetSelection = false) {
  const name = testName(testPath, id), exact = escapeRe(name);
  if (/\.exs$/.test(testPath)) {
    // `mix test file:LINE` runs one test: `N tests, F failures[, S skipped][, X excluded]`; excluded/skipped tests did not run
    const sum = [...plain.matchAll(/^(\d+) (?:doc)?tests?, (\d+) failures?(?:, (\d+) invalid)?(?:, (\d+) skipped)?(?:, (\d+) excluded)?(?:, (\d+) skipped)?/gm)].at(-1);
    if (sum) {
      const [n, failed, , sk1, ex, sk2] = [+sum[1], +sum[2], 0, +(sum[4] ?? 0), +(sum[5] ?? 0), +(sum[6] ?? 0)];
      if (failed > 0) return 'fail';
      if (n - ex - sk1 - sk2 > 0) return 'pass';
      return sk1 + sk2 > 0 ? 'skip' : 'notrun';
    }
  }
  if (/\.jl$/.test(testPath)) {
    const rows = juliaSummaryRows(plain);
    if (rows) {
      const mine = rows.filter((r) => new RegExp(`(?<![\\w-])${escapeRe(id)}(?![\\w-])`, 'i').test(r.name));
      return !mine.length ? 'notrun' : mine.some((r) => r.bad) ? 'fail' : mine.some((r) => r.pass) ? 'pass' : 'skip';
    }
  }
  if (rustDocName && /\.rs$/.test(testPath)) {
    const rows = [...plain.matchAll(/^test (.+?) \.\.\. (ok|FAILED|ignored)/gm)].filter((m) => m[1] === rustDocName);
    return !rows.length ? 'notrun' : rows.some((m) => m[2] === 'FAILED') ? 'fail' : rows.some((m) => m[2] === 'ok') ? 'pass' : 'skip';
  }
  if (/\.rs$/.test(testPath) && (/^test \S+ \.\.\. /m.test(plain) || /running \d+ tests|test result:/.test(plain))) {
    const full = qualifiedTestName(testPath, id, true);
    const owner = rustTarget(testPath);
    let belongs = true;
    const rows = [];
    for (const line of plain.split('\n')) {
      const header = /^\s*Running\s+(.+?)\s+\(/.exec(line);
      if (header) {
        const entry = header[1].replace(/\\/g, '/');
        belongs = owner ? entry === rel(owner.entry) || entry === path.relative(owner.dir, owner.entry).split(path.sep).join('/') : entry === testPath || entry.endsWith('/' + testPath);
      }
      const m = /^test (\S+)(?: - should panic)? \.\.\. (ok|FAILED|ignored)/.exec(line);
      if (belongs && m && (m[1] === full || (full === name && m[1].endsWith('::' + name)))) rows.push(m);
    }
    return !rows.length ? 'notrun' : rows.some((m) => m[2] === 'FAILED') ? 'fail' : rows.some((m) => m[2] === 'ok') ? 'pass' : 'skip';
  }
  if (/^\s*\d+\/\d+ Test\s+#\d+:/m.test(plain)) {
    const rows = ctestRows(plain).filter((r) => r.name === (selectedName ?? name) || r.name === id);
    return !rows.length ? 'notrun' : rows.some((r) => /Failed|Exception/.test(r.status)) ? 'fail' : rows.some((r) => /\bPassed\b/.test(r.status)) ? 'pass' : 'skip';
  }
  if (/\.php$/.test(testPath) && /There w(?:as|ere) \d+ (?:PHPUnit )?(?:failure|error)s?:/.test(plain)) {
    const declaring = qualifiedTestName(testPath, id).slice(0, -name.length - 1);
    const owner = phpOwnerOverride?.length ? `(?:${phpOwnerOverride.map(escapeRe).join('|')})` : declaring ? escapeRe(declaring) : '';
    if (new RegExp(`^\\d+\\) ${owner || '[^\\n]+'}::${exact}(?=[#@]|\\s+with data set|\\s*$)`, 'm').test(plain)) return 'fail';
    return owner && !new RegExp(`^\\d+\\) ${owner}::`, 'm').test(plain) ? 'notrun' : 'pass';
  }
  if (/\.java$/.test(testPath)) {
    const full = qualifiedTestName(testPath, id), cls = full.slice(0, -name.length - 1);
    const rows = [...plain.matchAll(/^SDD-TEST (\S+) (.+?) (SUCCESS|FAILURE|SKIPPED)$/gm)].filter((m) => m[1] === cls && javaCaseMatches(m[2], testPath, id));
    if (rows.length) return rows.some((m) => m[3] === 'FAILURE') ? 'fail' : rows.some((m) => m[3] === 'SUCCESS') ? 'pass' : 'skip';
    const xmlRows = [];
    const dirs = [path.join(ROOT, 'target/surefire-reports'), path.join(ROOT, 'build/test-results/test'), ...workspaceFiles().filter((f) => /\/(?:pom.xml|build.gradle(?:.kts)?)$/.test(f)).flatMap((f) => [path.join(ROOT, path.dirname(f), 'target/surefire-reports'), path.join(ROOT, path.dirname(f), 'build/test-results/test')])];
    for (const dir of new Set(dirs)) {
      if (!fs.existsSync(dir)) continue;
      for (const f of fs.readdirSync(dir).filter((f) => /\.xml$/.test(f))) {
        const text = fs.readFileSync(path.join(dir, f), 'utf8');
        for (const m of text.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
          const attrs = Object.fromEntries([...m[1].matchAll(/(\w+)="([^"]*)"/g)].map((a) => [a[1], a[2]]));
          if (attrs.classname === cls && javaCaseMatches(attrs.name, testPath, id)) xmlRows.push(/<(failure|error)\b/.test(m[2] ?? '') ? 'fail' : /<skipped\b/.test(m[2] ?? '') ? 'skip' : 'pass');
        }
      }
    }
    if (xmlRows.length) return xmlRows.includes('fail') ? 'fail' : xmlRows.includes('pass') ? 'pass' : 'skip';
    if (/^SDD-TEST /m.test(plain) || (requireJavaResult && !LOAD_ERR.test(plain))) return 'notrun';
  }
  if (/\.cs$/.test(testPath) && /^\s*(Passed|Failed|Skipped)\s+\S+/m.test(plain)) {
    const full = qualifiedTestName(testPath, id);
    const body = testBody(testPath, id).join('\n').split(/\b(?:public|private|protected)\s+(?:async\s+)?(?:void|Task)\b/)[0];
    const custom = [...body.matchAll(/\b(?:TestName|DisplayName)\s*=\s*"((?:\\.|[^"\\])*)"/g)].map((m) => m[1]);
    const rows = [...plain.matchAll(/^\s*(Passed|Failed|Skipped)\s+(.+?)(?:\s+\[[^\n]*\]|\s*$)/gm)].filter((m) => exactDotnetSelection || m[2] === name || m[2] === full || m[2].startsWith(name + '(') || m[2].startsWith(full + '(') || custom.includes(m[2]) || (full === name && m[2].endsWith('.' + name)));
    return !rows.length ? 'notrun' : rows.some((m) => m[1] === 'Failed') ? 'fail' : rows.some((m) => m[1] === 'Passed') ? 'pass' : 'skip';
  }
  return null;
}
function noExecution(plain) {
  const cargo = [...plain.matchAll(/test result: \w+\.\s*(\d+) passed;\s*(\d+) failed;/g)];
  if (cargo.length) return cargo.every((m) => +m[1] + +m[2] === 0);
  const dotnet = [...plain.matchAll(/(?:Passed|Failed|Skipped)!\s*-\s*Failed:\s*(\d+),\s*Passed:\s*(\d+),(?:\s*Skipped:\s*\d+,)?\s*Total:\s*\d+/g)];
  if (dotnet.length) return dotnet.every((m) => +m[1] + +m[2] === 0);
  if (/^Total tests:\s*\d+/m.test(plain) && !/^\s*(Passed|Failed):\s*[1-9]|\b(?:Passed|Failed)\s+\S+/m.test(plain)) return true;
  if (/running 0 tests/.test(plain) && !/running [1-9]\d* tests|^test \S+ \.\.\. (ok|FAILED)/m.test(plain)) return true;
  if (ZERO_TESTS.test(plain) && !RAN_TESTS.test(plain)) return true;
  const junit = [...plain.matchAll(/Tests run:\s*(\d+), Failures:\s*(\d+),(?: Errors:\s*(\d+),)? Skipped:\s*(\d+)/g)];
  if (junit.length && junit.every((m) => +m[1] === +m[4] && +m[2] === 0 && +(m[3] ?? 0) === 0)) return true;
  if (!junit.length && /^> Task \S*(?:test|Test)\s+(?:NO-SOURCE|SKIPPED)\b/m.test(plain) && !RAN_TESTS.test(plain)) return true;
  const ctest = [...plain.matchAll(/^\s*\d+\/\d+ Test\s+#\d+:[^\n]*(Passed|\*\*\*Failed|\*\*\*Exception|\*\*\*Skipped|\*\*\*Not Run)/gm)];
  if (ctest.length && ctest.every((m) => /Skipped|Not Run/.test(m[1]))) return true;
  const julia = juliaSummaryRows(plain);
  if (julia?.length && julia.every((r) => !r.executed)) return true;
  const php = [...plain.matchAll(/Tests:\s*(\d+), Assertions:\s*(\d+)([^\n]*)/g)];
  if (php.length && php.every((m) => +m[2] === 0 && !/(Errors|Failures):\s*[1-9]/.test(m[3]))) return true;
  return /did not perform any assertions|Passed:\s*0,[^\n]*Skipped:\s*[1-9]/i.test(plain);
}

// REQs whose verifying tests all have valid Red→Green evidence
function greenReqs(ents) {
  const entries = readLedger(), out = new Set(), all = new Map();
  for (const e of ents.values()) if (e.kind === 'TEST') for (const r of e.refs.verifies) all.set(r, [...(all.get(r) ?? []), e]);
  for (const [r, ts] of all) if (ts.every((e) => evidenceStatus(e.id, e.path, entries).ok)) out.add(r);
  return out;
}

function sharedImplStale(t, ents, entries) {
  const mine = new Set(t.refs.verifies);
  const implFiles = [...ents.values()].filter((e) => e.kind === 'CODE' && e.refs.implements.some((r) => mine.has(r))).map((e) => e.path);
  const mtime = (f) => { try { return fs.statSync(path.join(ROOT, f)).mtimeMs; } catch { return 0; } };
  return [...ents.values()].filter((e) => {
    if (e.kind !== 'TEST' || e.id === t.id) return false;
    const last = entries.filter((x) => x.test === e.id && (x.type === 'green' || x.type === 'refactor')).at(-1);
    const shared = [...ents.values()].filter((c) => c.kind === 'CODE' && implFiles.includes(c.path) && c.refs.implements.some((r) => e.refs.verifies.includes(r)));
    return last && shared.some((c) => (last.implBlocks ? last.implBlocks[`${c.path}:${c.id}`] !== implRegionSha(c) : mtime(c.path) > Date.parse(last.at)));
  });
}

function cmdTdd() {
  const sub = pos[1];
  if (sub === 'merge-ledger') return mergeLedger();
  const files = listFiles();
  const { ents, dups } = scanEntities(files);
  if (sub === 'check') {
    const entries = readLedger();
    const bad = verifyChain(entries) ?? ledgerRegression();
    out(bad ? `LEDGER FAIL: ${bad}` : `LEDGER OK (${entries.length} entries)`);
    return bad ? 1 : 0;
  }
  if (sub === 'stub') {
    // `--all TEST-X`: the parser binds the ID to --all as its value
    if (typeof flags.all === 'string') { pos.splice(2, 0, flags.all); flags.all = true; }
    const t = ents.get(pos[2]);
    if (!t || t.kind !== 'TEST') { out(`${pos[2] ?? '(no ID)'} not found as "@id TEST-..." annotation in source — usage: tdd stub <TEST-ID> [<TEST-ID>... | --all]`); return 2; }
    // several IDs (or --all: every test of that file) are stubbed in one run (#304)
    const group = flags.all ? [...ents.values()].filter((e) => e.kind === 'TEST' && e.path === t.path) : pos.slice(2).map((x) => ents.get(x));
    const bad = group.find((e) => !e || e.kind !== 'TEST' || e.path !== t.path);
    if (bad !== undefined) { const x = pos.slice(2).find((y) => !ents.get(y) || ents.get(y).kind !== 'TEST' || ents.get(y).path !== t.path) ?? pos[2]; out(!ents.get(x) || ents.get(x).kind !== 'TEST' ? `${x} is not a TEST (no "@id TEST-..." annotation found)` : `${x} is in ${ents.get(x).path}, not ${t.path}: tdd stub takes IDs of one test file — run it once per file`); return 2; }
    if (!group.includes(t)) group.unshift(t);
    const allSpecs = loadSpecs();
    t.refs = { ...t.refs, verifies: [...new Set(group.flatMap((e) => e.refs.verifies))] };
    const unknownReq = allSpecs.length ? t.refs.verifies.filter((r) => !allSpecs.some((sp) => sp.reqs.some((q) => q.id === r))) : [];
    if (unknownReq.length) { out(`REFUSED: ${t.id} verifies ${unknownReq.join(', ')} which no spec defines — write the spec first`); return 1; }
    const stubSpec = allSpecs.find((sp) => sp.reqs.some((q) => q.id === t.refs.verifies[0]));
    if (stubSpec && needsLock(stubSpec) && approvalState(stubSpec) !== 'ok') out(`! ${stubSpec.tier} feature ${stubSpec.feature} approval is ${approvalState(stubSpec)}: stubbing is allowed, but tdd red will REFUSE until the spec is approved (approve prepare/record ${stubSpec.feature})`);
    const priorFiles = new Set(workspaceFiles());
    const before = new Map(workspaceFiles().map((f) => [f, (() => { try { return fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch { return null; } })()]));
    const made = stubFor(t.path, group.map((e) => e.id));
    // a stub run that edits a file already annotated for a Green REQ says so (#330)
    const greens = greenReqs(ents);
    for (const f of [...new Set(made)]) {
      if (!priorFiles.has(f) || before.get(f) === fs.readFileSync(path.join(ROOT, f), 'utf8')) continue;
      const g = [...ents.values()].filter((e) => e.path === f).flatMap((e) => e.refs.implements).filter((r) => greens.has(r) && !t.refs.verifies.includes(r));
      if (g.length) (made.notes ??= []).push(`${f} was modified but already implements Green ${[...new Set(g)].join(', ')} (another feature): review the diff, SDD-TODO(stub) members must be implemented or removed`);
    }
    let annotationIndex = 0;
    for (const file of [...new Set(made)]) {
      if (priorFiles.has(file) || !/\.(?:java|php|cs|jl|rs|py|exs?|[cm]?[jt]sx?)$/.test(file)) continue;
      const abs = path.join(ROOT, file), text = fs.readFileSync(abs, 'utf8');
      if (/@id\s+(?:CODE|TEST)-/.test(text)) continue;
      let codeId;
      do { codeId = t.id.replace(/^TEST-/, 'CODE-') + '-STUB-' + String(++annotationIndex).padStart(3, '0'); } while (ents.has(codeId));
      const annotation = `${/\.(?:jl|exs?|py)$/.test(file) ? '#' : '//'} @id ${codeId} @implements ${t.refs.verifies.join(' ')}\n`;
      const first = text.indexOf('\n') + 1;
      const offset = text.startsWith('<?php') || text.startsWith('// sdd-stub') || (file.endsWith('.jl') && /^module\s/.test(text)) ? first : 0;
      fs.writeFileSync(abs, text.slice(0, offset) + annotation + text.slice(offset));
    }
    const scripted = /\.(?:[cm]?[jt]sx?|py)$/.test(t.path);
    if (made.length && made.verified === 'partial') out(`stubbed (throwing; NOT compile-checked — the project build still fails): ${made.join(', ')}`);
    else if (made.length) out(made.verified === 'ok' ? `stubbed (throwing, compile-checked): ${made.join(', ')} — now run: tdd red ${t.id}` : made.verified === 'fail' ? `stubbed (throwing): ${made.join(', ')} — ! the test still does not compile: ${made.verifyError}\n! could not fully stub ${t.id}: finish the stub by hand (types, struct fields, methods), then run: tdd red ${t.id}` : `stubbed (throwing; compile NOT verified${scripted ? '' : ' — no checker for this language'}): ${made.join(', ')} — now run: tdd red ${t.id}; if it reports a load/compile error, finish the stub by hand`);
    else if (made.verified === 'partial') out(`nothing was stubbed for ${t.id}: it has no compile errors of its own — NOT compile-checked`);
    else if (made.verified === 'fail') out(`nothing could be stubbed for ${t.id}: the test does not compile (${made.verifyError}) — write the missing code by hand`);
    else out(scripted ? (made.checked ? `nothing to stub in ${t.path}: checked ${made.checked.rel + made.checked.abs} from-import(s) (${made.checked.rel} relative, ${made.checked.abs} absolute${made.checked.conftest ? `, ${made.checked.conftest} in conftest.py` : ''}); each resolves to an installed/existing module or is not a missing project module. Plain \`import x\` lines and non-Python subjects are not checked` : `no missing relative imports in ${t.path}`) : made.verified === 'ok' ? `nothing to stub for ${t.id} in ${t.path} (compile-checked)` : `nothing to stub for ${t.id} in ${t.path} (nothing new to generate: referenced code is already stubbed/defined, or the generator does not cover this construct); run tdd red, and if the test does not compile write the missing code by hand`);
    if (made.verified === 'partial') out(`! ${made.verifyError} — the requested test has no compile errors of its own; stub or implement the other tests (\`tdd stub <their ID>\`) before running the project's tests`);
    for (const n of [...new Set(made.notes ?? [])]) out(`! ${n}`);
    for (const r of made.report ?? []) if (r.confidence === 'guessed') out(r.unmarked ? `! ${r.element}: ${r.unmarked} with no evidence (${r.evidence}) — check it by hand (not marked)` : `! ${r.element}: type unknown (${r.evidence}) — emitted an SDD-TODO(stub) placeholder, fill the type by hand`);
    if (flags.report) { out('stub report (element | confidence | evidence):'); for (const r of made.report ?? []) out(`  ${r.element} | ${r.confidence} | ${r.evidence}`); if (!made.report?.length) out('  (no inferred elements)'); }
    if (made.realMissing?.length) out(`! not stubbed: ${made.realMissing.join('; ')} — those modules hold real code, which stubs never edit: add the names by hand`);
    if (made.warnings?.length) out(`! not stubbed: ${[...new Set(made.warnings)].join('; ')} — add the exports by hand`);
    return made.verified === 'fail' && /\.(?:go|c|cc|cpp|cxx)$/.test(t.path) ? 1 : 0;
  }
  if (!['red', 'green', 'refactor'].includes(sub)) { out('usage: tdd red|green|refactor <TEST-ID> [--req REQ] [--weak] [--expect <text>] [--retest <why>] [--characterization <why>] [--allow-setup-red] [--wording <why> (refactor on T1 after a test change)] | tdd stub <TEST-ID> [<TEST-ID>... | --all] | tdd check | tdd merge-ledger'); return 2; }
  if (sub === 'refactor' && flags.stale && !pos[2]) {
    const staleIds = [...ents.values()].filter((e) => {
      if (e.kind !== 'TEST') return false;
      const last = readLedger().filter((x) => x.test === e.id && (x.type === 'green' || x.type === 'refactor')).at(-1);
      if (changedArtifacts(last).length) return true;
      const ev = evidenceStatus(e.id, e.path, readLedger());
      if (!ev.ok && /tdd refactor/.test(ev.why ?? '')) return true;
      return last?.implBlocks && [...ents.values()].some((c) => c.kind === 'CODE' && c.refs.implements.some((r) => e.refs.verifies.includes(r)) && last.implBlocks[`${c.path}:${c.id}`] !== implRegionSha(c));
    }).map((e) => e.id);
    if (!staleIds.length) {
      const led = readLedger(), outside = new Set();
      for (const c of ents.values()) {
        if (c.kind !== 'CODE') continue;
        for (const t of ents.values()) {
          const last = t.kind === 'TEST' && t.refs.verifies.some((r) => c.refs.implements.includes(r)) ? led.filter((x) => x.test === t.id && (x.type === 'green' || x.type === 'refactor')).at(-1) : null;
          if (last?.implFiles && last.implFiles[c.path] !== undefined && last.implFiles[c.path] !== fileSha(c.path)) outside.add(`${c.path} (tests: ${[...ents.values()].filter((x) => x.kind === 'TEST' && x.refs.verifies.some((r) => c.refs.implements.includes(r))).map((x) => x.id).join(' ')})`);
        }
      }
      for (const o of outside) out(`! edit fell outside any annotated CODE span in ${o}: --stale cannot tell which test it affects; re-run those tests (tdd refactor <TEST-ID>) or annotate the changed code \`@id CODE-... @implements REQ-...\``);
      out('no test has a stale shared-implementation or artifact Green'); return 0;
    }
    out(`re-verifying ${staleIds.length} stale test(s): ${staleIds.join(' ')}`);
    if (staleIds.length === 1) pos.push(staleIds[0]); else pos.push(...staleIds);
  }
  if (!pos[2]) { out(`usage: tdd ${sub} <TEST-ID> [<TEST-ID>...] [--req REQ] [--weak]${sub === 'refactor' ? ' | tdd refactor --stale' : ''}`); return 2; }
  if (flags.characterization === true) { out('usage: tdd red <TEST-ID> --characterization "<reason>" — records a test that passes without any implementation (data-only/golden check) as a weak Red; the reason text is required and is shown in the gate'); return 2; }
  // batch: run each ID in turn (flags such as --req/--characterization apply to every ID) (#126)
  if (pos.length > 3) {
    const ids = pos.slice(2);
    // validate every ID before the first ledger write: a typo must not leave a partial batch (#146)
    const missing = ids.filter((x) => ents.get(x)?.kind !== 'TEST');
    if (missing.length) { out(`${missing.join(', ')} not found as "@id TEST-..." annotation in source (nothing was run)`); return 2; }
    let rc = 0;
    const write = process.stdout.write.bind(process.stdout), seenRefused = new Set(), seenTail = new Set();
    // an identical REFUSED line (e.g. unapproved feature) is printed once, not per ID
    process.stdout.write = (chunk, ...rest) => { const k = String(chunk); if (k.startsWith('REFUSED:')) { if (seenRefused.has(k)) return true; seenRefused.add(k); } if (k.split('\n').length > 3) { if (seenTail.has(k)) return write('(same compiler/test output as above)\n', ...rest); seenTail.add(k); } return write(chunk, ...rest); };
    try { for (const one of ids) { pos.length = 2; pos.push(one); rc = Math.max(rc, cmdTdd()); } } finally { process.stdout.write = write; }
    return rc;
  }
  const id = pos[2];
  const t = ents.get(id);
  if (!t || t.kind !== 'TEST') { out(`${id} not found as "@id TEST-..." annotation in source`); return 2; }
  const dupOf = dups.find((x) => x.startsWith(`${id} (`));
  if (dupOf) { out(`REFUSED: duplicate @id ${dupOf} — every @id must be unique; rename one before recording evidence`); return 1; }
  rustRunnerSelection = null;
  const req = typeof flags.req === 'string' ? flags.req : t.refs.verifies[0];
  // a `(test-only)` REQ is verified by tests that need no failing Red: a passing Red is recorded as characterization (#306)
  const testOnlyReqs = t.refs.verifies.length > 0 && t.refs.verifies.every((r) => loadSpecs().flatMap((x) => x.reqs).some((q) => q.id === r && q.testOnly));
  const characFlag = typeof flags.characterization === 'string' ? flags.characterization : testOnlyReqs ? (t.refs.verifies.every((r) => loadSpecs().flatMap((x) => x.reqs).some((q) => q.id === r && q.characMarker)) ? '(characterization) REQ' : '(test-only) REQ') : undefined;
  const specs = loadSpecs();
  const spec = specs.find((s) => s.reqs.some((r) => r.id === req));
  if (!req || !spec) { out(`${id}: no @verifies REQ defined in a spec (.sdd/specs). add @verifies or --req`); return 2; }
  if (needsLock(spec) && approvalState(spec) !== 'ok') { out(`REFUSED: ${spec.tier} feature ${spec.feature} approval is ${approvalState(spec)}. run: ${spec.approval === 'human' ? `approve prepare ${spec.feature}, then approve record ${spec.feature} --by <human name>` : `approve record ${spec.feature} --by ai:<reviewer> --review <.sdd/review.md|summary>`}`); return 1; }

  const entries = readLedger();
  const ledgerProblem = verifyChain(entries) ?? ledgerRegression();
  if (ledgerProblem) {
    out(`REFUSED: invalid ledger: ${ledgerProblem}`);
    const stale = sub === 'green' ? sharedImplStale(t, ents, entries) : [];
    if (stale.length) out(`⚠ implementation shared with other REQs may have changed: ${stale.map((e) => e.id).join(', ')} (untrusted ledger; no evidence recorded)`);
    return 1;
  }
  const before = testSha(t.path, id);
  const rawBefore = sha(fs.readFileSync(path.join(ROOT, t.path)));
  const prior = entries.filter((e) => e.test === id);
  const cfg = loadConfig();
  if (sub === 'green') {
    const r = prior.filter((e) => e.type === 'red').at(-1);
    if (!r) { out(`REFUSED: no Red recorded for ${id}`); return 1; }
    // reverting a wrong edit back to content that already has a Red is fine, not only the very last Red (#100)
    // a dependency that is new since the matching Red (e.g. a stub-annotated support file replaced by unannotated code) is not covered by the raw-region hash match (#265)
    const matchedRed = prior.filter((e) => e.type === 'red' && shaMatches(e.fileSha, t.path, id)).at(-1);
    const admissionRed = matchedRed ?? r;
    if (admissionRed.admissionShas) {
      const current = checkAdmissionShas(cfg, admissionRed.admissionShas);
      const drift = [...new Set([...Object.keys(admissionRed.admissionShas), ...Object.keys(current)])]
        .filter((k) => admissionRed.admissionShas[k] !== current[k]);
      if (drift.length) {
        out(`REFUSED: check definition changed since Red (${drift.map((k) => k.slice(k.indexOf('|') + 1)).join(', ')}); restore the resolution/compiler/Python inputs or record a fresh assertion Red before Green`);
        return 1;
      }
    }
    const newDeps = matchedRed && !matchedRed.oracleShas && !/\.(?:py|jl)$/.test(t.path) && !BRACE_TEST.test(t.path) && (testSha(t.path, id), oracleDependencyFiles.length > 0);
    if (!matchedRed || newDeps) {
      const promoted = (r.protectedFiles ?? []).filter((f) => {
        try { const text = fs.readFileSync(path.join(ROOT, f), 'utf8'); return /@id\s+CODE-/.test(text) && !/@id\s+TEST-/.test(text); } catch { return false; }
      });
      out(promoted.length ? `REFUSED: production ownership changed since Red (${promoted.join(', ')}), not necessarily a test edit. Annotate handwritten production subjects before Red (a generated file or build script: declare it in .sdd/config.json "artifactProducers" instead); restore annotated failing code, record a fresh Red, then implement and Green` : `REFUSED: test file changed since Red (${t.path}; checked per test ${id}${oracleNote(changedOracleDeps(r, t.path, id)) || ', its own region or a local include/header it depends on'}${unannotatedHint(changedOracleDeps(r, t.path, id))}${changedOracleDeps(r, t.path, id).length ? '; if it is generated by a command, declare it in .sdd/config.json "artifactProducers": {"<artifact>": "<command or file>"} so regenerating it between Red and Green is accepted (or commit the regenerated file before Red)' : ''}). ${r.regSha && r.regSha === testRegionSha(t.path, id) && !changedOracleDeps(r, t.path, id).length ? `only shared test-file content (imports/header/setup) changed, not this test's own lines: revert it, or record a fresh Red (tdd red ${id}; it must fail), then Green` : `revert test edits to a recorded Red's content, or record a new Red; if the test expectation itself was wrong, run: tdd red ${id} --retest "<reason>"`}`);
      return 1;
    }
  }
  const retest = sub === 'red' && flags.retest !== undefined ? (typeof flags.retest === 'string' ? flags.retest.trim() : '') : null;
  if (retest !== null) {
    if (!retest) { out('usage: tdd red <ID> --retest "<why the test expectation was wrong>" (reason required)'); return 2; }
    const last = prior.filter((e) => e.type === 'green' || e.type === 'red').at(-1);
    if (!last) { out(`REFUSED: --retest needs a previous Red/Green run for ${id}; use a normal tdd red`); return 1; }
    if (shaMatches(last.fileSha, t.path, id)) { out(`REFUSED: --retest: the test of ${id} is unchanged since its last ${last.type}; nothing to re-test`); return 1; }
  }
  if (sub === 'refactor' && !prior.some((e) => e.type === 'green')) { out(`REFUSED: no Green recorded for ${id}`); return 1; }
  if (sub === 'refactor' && spec.tier === 'T1') {
    const lastG = prior.filter((e) => e.type === 'green' || e.type === 'refactor').at(-1);
    const movedRows = Object.entries(lastG?.reqShas ?? {}).filter(([rid, rsha]) => rsha && reqShaOf(rid) && !reqShaSame(rid, rsha)).map(([rid]) => rid);
    if (movedRows.length && readJson(CONFIG, {}).specEditPolicy === 'reapprove' && !(typeof flags.wording === 'string' && flags.wording.trim())) { out(`REFUSED: specEditPolicy reapprove: ${movedRows.join(', ')} changed since the previous Green and ${spec.tier} specs have no approval lock. Re-approve the new wording: tdd refactor ${id} --wording "<why the behaviour is unchanged>" (behaviour changed: tdd red then tdd green)`); return 1; }
    if (lastG && !shaMatches(lastG.fileSha, t.path, id) && typeof flags.wording === 'string' && flags.wording.trim() && !(lastG.regSha && lastG.regSha === testRegionSha(t.path, id))) { out(`REFUSED: ${id}: --wording only covers spec rows (and shared test-file content), but this test's own lines changed since its last Green, which could weaken an assertion. Expectation changed: tdd red ${id} --retest "<reason>", then tdd green. Behaviour/assertions changed: tdd red then tdd green. Otherwise revert the test edit and run tdd refactor ${id}`); return 1; }
    if (lastG && !shaMatches(lastG.fileSha, t.path, id) && !(typeof flags.wording === 'string' && flags.wording.trim())) { const shared = lastG.regSha && lastG.regSha === testRegionSha(t.path, id); out(`REFUSED: ${id}: ${flags.wording !== undefined ? '--wording needs a non-empty reason; ' : ''}the test changed since its last Green and ${spec.tier} specs have no approval lock, so a refactor would bless a behaviour change without a Red. ${shared ? `Only shared test-file content (imports/header/setup) changed, not this test's own lines: tdd refactor ${id} --wording "<why>"` : `The test's own lines changed. Expectation changed: tdd red ${id} --retest "<reason>", then tdd green. Behaviour/assertions changed: tdd red then tdd green. Wording/formatting only: tdd refactor ${id} --wording "<why>"`}`); return 1; }
  }

  const proj = projectFor(t.path);
  const fileArg = proj ? path.posix.relative(proj.root, t.path) : t.path;
  const baseCmd = proj?.testCmd ?? cfg.testCmd;
  if (!Array.isArray(baseCmd)) { out(`REFUSED: no testCmd for ${proj ? `project ${proj.root}` : 'this project'} (set projects[].testCmd or top-level testCmd in ${rel(CONFIG)})`); return 2; }
  const cmd = baseCmd.map((a) => a.replaceAll('{id}', id).replaceAll('{idu}', testName(t.path, id)).replaceAll('{IDU}', id.toUpperCase().replaceAll('-', '_')).replaceAll('{file}', fileArg));
  let selectedName = null;
  let dotnetReport = null, exactDotnetSelection = false, genericDotnetSelection = false;
  if (/\.rs$/.test(t.path) && cmd[0] === 'cargo' && cmd[1] === 'test') {
    const selector = cmd.findIndex((a) => /^(?:--lib|--test|--bin|--example)$/.test(a));
    const packageFlag = cmd.findIndex((a) => /^(?:-p|--package)$/.test(a));
    rustRunnerSelection = selector < 0 && packageFlag < 0 ? null : { kind: selector < 0 ? null : cmd[selector], name: cmd[selector + 1], package: packageFlag < 0 ? null : cmd[packageFlag + 1] };
    const name = testName(t.path, id);
    const i = cmd.indexOf(name);
    const doc = rustDocTest(t.path, id, cmd, path.resolve(ROOT, proj?.root ?? '.'));
    rustDocName = doc ? doc.at(-1) : null;
    if (doc) cmd.splice(0, cmd.length, ...doc);
    else if (i >= 0) {
      const owner = rustTarget(t.path, path.resolve(ROOT, proj?.root ?? '.'));
      cmd[i] = qualifiedTestName(t.path, id, true);
      if (owner && !cmd.some((a) => /^(?:--test|--lib|--bin|--example|--all-targets)$/.test(a))) {
        const selection = owner.kind.includes('test') ? ['--test', owner.target] : owner.kind.some((k) => /lib/.test(k)) ? ['--lib'] : owner.kind.includes('bin') ? ['--bin', owner.target] : ['--example', owner.target];
        cmd.splice(2, 0, ...selection);
      }
      if (owner && !cmd.includes('-p') && !cmd.includes('--package')) cmd.splice(2, 0, '-p', owner.package);
      if (!cmd.includes('--')) cmd.push('--');
      if (!cmd.includes('--exact')) cmd.push('--exact');
    }
  }
  if (/\.java$/.test(t.path)) {
    if (ambiguousJavaMethod(t.path, id)) { out(`${sub.toUpperCase()} REJECTED ${id}: overloaded JUnit method ownership is ambiguous; use unique method names within the declaring class`); return 1; }
    const name = testName(t.path, id), full = qualifiedTestName(t.path, id), cls = full.slice(0, -name.length - 1);
    for (let i = 0; i < cmd.length; i++) {
      if (cmd[i] === '-Dtest=*#*' + name || cmd[i] === '-Dtest=' + name) cmd[i] = `-Dtest=${cls}#${name}`;
      if (cmd[i].includes('--tests "*$0"') && cmd[i + 1] === name) { cmd[i] = cmd[i].replace('--tests "*$0"', '--tests "$0"'); cmd[i + 1] = full; }
      if (cmd[i] === '--tests' && cmd[i + 1] === '*' + name) cmd[i + 1] = full;
    }
    const reportRoots = [path.resolve(ROOT, proj?.root ?? '.')];
    for (const f of workspaceFiles().filter((f) => /(^|\/)(?:pom.xml|build.gradle(?:.kts)?)$/.test(f))) reportRoots.push(path.join(ROOT, path.dirname(f)));
    for (const root of new Set(reportRoots)) for (const sub of ['target/surefire-reports', 'build/test-results/test']) {
      const dir = path.join(root, sub);
      if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir).filter((f) => /\.xml$/.test(f))) fs.rmSync(path.join(dir, f));
    }
  }
  if (/ctest/.test(cmd.join(' '))) {
    const name = testName(t.path, id);
    const shell = cmd.findIndex((a) => a.includes('ctest') && a.includes(' -R "$0"'));
    const direct = cmd.indexOf('-R');
    if ((shell >= 0 && cmd[shell + 1] === name) || (direct >= 0 && cmd[direct + 1] === name)) {
      const cwd = path.resolve(ROOT, proj?.root ?? '.');
      if (shell >= 0) run(['sh', '-c', cmd[shell].slice(0, cmd[shell].indexOf('ctest')).replace(/;\s*$/, '')], cfg.timeoutMs ?? 120000, proj?.root);
      const testDir = shell >= 0 ? /ctest\s+--test-dir\s+(\S+)/.exec(cmd[shell])?.[1] : cmd.includes('--test-dir') ? cmd[cmd.indexOf('--test-dir') + 1] : null;
      let tests;
      try { tests = JSON.parse(cmdOut(['ctest', ...(testDir ? ['--test-dir', testDir] : []), '--show-only=json-v1'], cwd)).tests; } catch {}
      if (tests) {
        const exact = tests.filter((t) => t.name === name);
        const token = id.toLowerCase().replaceAll('-', '_');
        const candidates = exact.length ? exact : tests.filter((t) => new RegExp(`(?:^|[^A-Za-z0-9])${escapeRe(token)}(?:[^A-Za-z0-9]|$)`, 'i').test(t.name) || t.name === id);
        if (candidates.length !== 1) { out(`${sub.toUpperCase()} REJECTED ${id}: CTest registration is missing or ambiguous; configure an exact -R selector (a new test file or add_test not yet configured? re-run \`cmake -S . -B build\`)`); return 1; }
        selectedName = candidates[0].name;
        if (shell >= 0) cmd[shell + 1] = selectedName;
        if (direct >= 0) cmd[direct + 1] = selectedName;
      }
    }
    const i = cmd.indexOf('-R');
    if (i >= 0 && !selectedName && !/[\\^$.*+?()[\]{}|]/.test(cmd[i + 1])) selectedName = cmd[i + 1];
    if (i >= 0 && (cmd[i + 1] === name || cmd[i + 1] === selectedName)) cmd[i + 1] = '^' + escapeRe(cmd[i + 1]) + '$';
    for (let i = 0; i < cmd.length; i++) if (cmd[i].includes(' -R "$0"')) { cmd[i] = cmd[i].replace(' -R "$0"', ' -R "^$0$"'); if (cmd[i + 1] === name || cmd[i + 1] === selectedName) cmd[i + 1] = escapeRe(cmd[i + 1]); }
  }
  if (/\.php$/.test(t.path) && /phpunit/.test(cmd.join(' '))) {
    const i = cmd.indexOf('--filter');
    if (i >= 0 && cmd[i + 1] === testName(t.path, id)) {
      const full = qualifiedTestName(t.path, id), name = testName(t.path, id);
      let owner = full.slice(0, -name.length - 1);
      phpOwnerOverride = null;
      const declared = new RegExp(`^\\s*(?:(?:final|readonly)\\s+)*((?:abstract\\s+)?class|trait)\\s+${escapeRe(owner.split('\\').pop())}\\b`, 'm').exec(maskBraces(fs.readFileSync(path.join(ROOT, t.path), 'utf8')));
      if (owner && declared && /abstract|trait/.test(declared[1])) {
        const concrete = phpConcreteOwners(t.path, owner);
        if (!concrete.length) { out(`${sub.toUpperCase()} REJECTED ${id}: declared in ${declared[1].includes('trait') ? 'trait' : 'abstract class'} ${owner}, which PHPUnit cannot run, and no concrete test class extends/uses it; add one or set a custom testCmd`); return 1; }
        phpOwnerOverride = concrete.map((c) => c.fq);
        owner = phpOwnerOverride.length === 1 ? phpOwnerOverride[0] : `(?:${phpOwnerOverride.map(escapeRe).join('|')})`;
        const fi = cmd.indexOf(fileArg, i + 2);
        if (fi >= 0) { if (concrete.length === 1) cmd[fi] = proj ? path.posix.relative(proj.root, concrete[0].file) : concrete[0].file; else cmd.splice(fi, 1); }
      }
      cmd[i + 1] = '/' + (owner ? '^' + (phpOwnerOverride?.length > 1 ? owner : escapeRe(owner)) : '') + '::' + escapeRe(name) + '(?:\\s+with data set [\\s\\S]*)?$/';
    }
  }
  if (/\.jl$/.test(t.path) && cmd[0] === 'julia' && juliaScriptIndex(cmd) === cmd.length - 1 && cmd.at(-1) === fileArg) cmd.splice(cmd.at(-2) === '--' ? cmd.length - 2 : cmd.length - 1, 0, '-e', JULIA_VERBOSE);
  if (/\.cs$/.test(t.path) && cmd[0] === 'dotnet' && cmd[1] === 'test') {
    const owners = dotnetGraph(ROOT).ownersOf(t.path);
    if (owners.length) {
      const operand = cmd.findIndex((a, i) => i > 1 && /\.(?:csproj|sln|slnx)$/.test(a));
      const explicit = operand >= 0 && cmd[operand].endsWith('.csproj') ? path.posix.normalize(path.posix.join(proj?.root ?? '.', cmd[operand])) : null;
      const owner = explicit ? owners.find((o) => o.file === explicit) : owners.length === 1 ? owners[0] : null;
      if (!owner) { out(`${sub.toUpperCase()} REJECTED ${id}: .NET test project ownership is ambiguous or disagrees with the runner; configure the owning csproj explicitly`); return 1; }
      const projectArg = path.posix.relative(proj?.root ?? '.', owner.file);
      if (operand >= 0) cmd[operand] = projectArg;
      else cmd.splice(2, 0, projectArg);
    }
    const i = cmd.indexOf('--filter');
    if (i >= 0 && cmd[i + 1] === 'FullyQualifiedName~' + testName(t.path, id)) {
      const full = qualifiedTestName(t.path, id);
      const text = fs.readFileSync(path.join(ROOT, t.path), 'utf8');
      const at = text.search(new RegExp(`@id\\s+${id}\\b`));
      const scope = full.slice(0, -testName(t.path, id).length - 1);
      genericDotnetSelection = [...text.slice(0, at).matchAll(/\b(?:class|record)\s+(\w+)\s*</g)].some((m) => scope.split(/[.+]/).includes(m[1]));
      if (full.includes('.')) {
        cmd[i + 1] = genericDotnetSelection ? `FullyQualifiedName~${scope}&FullyQualifiedName~.${testName(t.path, id)}` : 'FullyQualifiedName=' + full;
        exactDotnetSelection = !genericDotnetSelection;
      }
      if (!cmd.includes('--logger')) cmd.push('--logger', 'console;verbosity=normal');
    }
    exactDotnetSelection ||= i >= 0 && cmd[i + 1] === 'FullyQualifiedName=' + qualifiedTestName(t.path, id);
    const resultDir = path.join(SDD, 'results');
    fs.mkdirSync(resultDir, { recursive: true });
    dotnetReport = path.join(resultDir, 'sdd-target.trx');
    fs.rmSync(dotnetReport, { force: true });
    cmd.push('--logger', 'trx;LogFileName=sdd-target.trx', '--results-directory', resultDir);
  }
  // pytest -k is a substring match: exclude longer test names that extend this one (test_x_007 vs test_x_0071) (#98)
  const ki = cmd.indexOf('-k');
  if (ki >= 0 && /pytest/.test(cmd.join(' ')) && cmd[ki + 1] === testName(t.path, id)) {
    const me = cmd[ki + 1];
    const names = [...new Set([...fs.readFileSync(path.join(ROOT, t.path), 'utf8').matchAll(/\bdef\s+(test\w*)/g)].map((m) => m[1]))];
    const longer = names.filter((n) => n !== me && n.includes(me));
    const exact = names.includes(me);
    if (exact && longer.length) cmd[ki + 1] = [me, ...longer.map((n) => `not ${n}`)].join(' and ');
  }
  // a build failure in another Go package must not turn this test's Red into a load error (#94)
  if (/_test\.go$/.test(t.path) && cmd[0] === 'go' && cmd[1] === 'test' && cmd.includes('./...')) { const pd = path.posix.dirname(fileArg); cmd[cmd.indexOf('./...')] = pd === '.' ? '.' : './' + pd; }
  const goRunner = /_test\.go$/.test(t.path) && cmd[0] === 'go' && cmd[1] === 'test';
  if (goRunner && !cmd.includes('-v')) cmd.push('-v');
  const goTarget = goRunner ? goTestTarget(t.path, id) : null;
  if (goTarget) {
    const ri = cmd.findIndex((a) => a === '-run' || a.startsWith('-run='));
    if (ri < 0) cmd.push('-run', goTarget.pattern);
    else if (cmd[ri] === '-run') cmd[ri + 1] = goTarget.pattern;
    else cmd[ri] = '-run=' + goTarget.pattern;
  }
  if (goRunner && /^(Benchmark)/.test(goTarget?.name ?? '')) {
    // `-run` never executes benchmarks: select this one explicitly, one iteration (#215)
    const bi = cmd.findIndex((a) => a === '-bench' || a.startsWith('-bench='));
    if (bi < 0) cmd.push('-bench', '^' + goTarget.name.split('/')[0] + '$', '-benchtime=1x'); 
  }
  // tests behind `//go:build tag` are invisible without -tags (#227)
  if (goRunner && !cmd.some((a) => /^-tags(=|$)/.test(a))) {
    const tags = goBuildTags(fs.readFileSync(path.join(ROOT, t.path), 'utf8'));
    if (tags.length) { cmd.splice(2, 0, '-tags', tags.join(',')); out(`go: building with -tags ${tags.join(',')} (from //go:build in ${t.path})`); }
  }
  if (/\.exs$/.test(t.path) && cmd[0] === 'mix' && cmd[1] === 'test') {
    const ex = exTest(t.path, id);
    if (!ex) { out(`${sub.toUpperCase()} REJECTED ${id}: no ExUnit test "..." follows its @id`); return 1; }
    const i = cmd.indexOf(fileArg);
    if (i > 1) cmd[i] = `${fileArg}:${ex.line}`;
  }
  checkDefClosure(cfg);
  const res = run(cmd, cfg.timeoutMs ?? 120000, proj?.root);
  const after = testSha(t.path, id);
  // a clean C/C++ build writes compile_commands.json, which feeds the hash context; only a changed test file is a real edit (#221)
  const buildContext = after !== before && /\.(?:c|cc|cpp|cxx)$/.test(t.path) && sha(fs.readFileSync(path.join(ROOT, t.path))) === rawBefore;
  if (after !== before && !buildContext) { out(`REFUSED: ${t.path} changed while running (formatter/watch?)`); return 1; }

  const goVerdict = goRunner ? goResult(res.text, goTarget?.name ?? testName(t.path, id)) : null;
  if (goRunner) res.text = goOutput(res.text);
  const plain = res.text.replace(/\x1b\[[0-9;]*m/g, '');
  const nodeFailure = nodeTestCommand(cmd, proj?.root) && nodeTestReport(plain) ? nodeFailureContext(plain, id, t.path, proj?.root) : null;
  const loadError = nodeFailure ? nodeFailure.loadError : isLoadErr(res.text);
  // Go t.Skip and JUnit @Disabled: every test that ran was skipped (#84)
  const allSkipped = (/--- SKIP:/.test(plain) && !/--- (PASS|FAIL):/.test(plain)) || [...plain.matchAll(/Tests run: (\d+), Failures: 0, Errors: 0, Skipped: (\d+)/g)].some((m) => m[1] === m[2] && +m[1] > 0 && [...plain.matchAll(/Tests run: (\d+), Failures: 0, Errors: 0, Skipped: (\d+)/g)].every((x) => x[1] === x[2]));
  // PHPUnit skipped / no assertions, dotnet Passed: 0 + Skipped: n executed nothing (#140)
  const noAssert = noExecution(plain);
  // Node >=22 can report a file-level pass: only an executed test result proves the ID matched (#154).
  const nodeUnobservable = nodeTestCommand(cmd, proj?.root) && !nodeTestReport(plain) && !loadError;
  const nodeNoMatch = nodeUnobservable || (res.exit === 0 && (nodeTestCommand(cmd, proj?.root) || nodeTestReport(plain)) && !nodeTestRan(plain, id, t.path, true));
  const goNoMatch = goRunner && !LOAD_ERR.test(plain) && (!goTarget || !goVerdict || goVerdict === 'skip');
  const javaRunner = /\.java$/.test(t.path) && /(?:^|[/\s])(?:mvn|mvnw|gradle|gradlew)(?:\s|$)/.test(cmd.join(' '));
  const runtimeVerdict = dotnetResult(dotnetReport, t.path, id, exactDotnetSelection);
  if (genericDotnetSelection && !runtimeVerdict && !LOAD_ERR.test(plain)) { out(`${sub.toUpperCase()} REJECTED ${id}: generic .NET fixtures require observable TRX method ownership; the runner did not emit sdd-target.trx`); return 1; }
  const pythonRows = res.pytestResults?.filter((r) => {
    const parts = r.nodeid.split('::');
    return path.resolve(ROOT, proj?.root ?? '.', parts[0]) === path.resolve(ROOT, t.path)
      && parts.at(-1).replace(/\[.*$/, '') === testName(t.path, id);
  });
  const pythonVerdict = pythonRows && !isLoadErr(plain) ? pythonRows.some((r) => r.outcome === 'failed') ? 'fail'
    : pythonRows.some((r) => r.outcome === 'passed') ? 'pass' : pythonRows.length ? 'skip' : 'notrun' : null;
  if (pythonVerdict === 'fail' && res.exit === 0) { out(`${sub.toUpperCase()} REJECTED ${id}: test failed but pytest returned a successful runner exit\n${failTail(res.text, 8)}`); return 1; }
  const verdict = runtimeVerdict ?? pythonVerdict ?? targetVerdict(plain, t.path, id, selectedName, javaRunner, exactDotnetSelection);
  const targetExecuted = verdict === 'pass' || verdict === 'fail';
  const zero = (!targetExecuted && ((ZERO_TESTS.test(res.text) && !RAN_TESTS.test(res.text)) || allSkipped || noAssert)) || NO_PASSED.test(plain) || pytestNoExecution(plain) || nodeNoMatch || goNoMatch || verdict === 'notrun' || verdict === 'skip';
  const siblingFail = juliaSiblingFail(plain, id);
  const targetPassed = verdict ? verdict === 'pass' : goVerdict ? goVerdict === 'pass' : siblingFail === 'sibling' || res.exit === 0;
  // ExUnit: the excerpt comes from the `N) test ...` failure block, not from compile-warning code frames printed before it (#246)
  const exBlock = /\.exs$/.test(t.path) ? (/^\s*\d+\) test [^\n]*\n[\s\S]*?(?=^Finished in |^\s*\d+\) test |(?![\s\S]))/m.exec(plain)?.[0] ?? null) : null;
  const targetOutput = juliaSummaryRows(plain) ? juliaFailureOutput(plain, id, t.path) : exBlock;
  const timeoutWhy = `the test run timed out after ${(res.ms / 1000).toFixed(0)}s (raise timeoutMs in .sdd/config.json or fix the hang); a timeout is neither Red nor Green`;
  // forked JVM / test host died: the test matched but the runner crashed (#143)
  let cAssertionAbort = false;
  if (/\.(?:c|cc|cpp|cxx)$/.test(t.path)) {
    const text = fs.readFileSync(path.join(ROOT, t.path), 'utf8'), ranges = braceFunctions(text, t.path) ?? [];
    const mine = ranges.find((r) => new RegExp(`@id\\s+${id}(?![\\w-])`).test(r.body));
    const called = mine ? [mine, ...reachableHelpers(mine, ranges.filter((r) => !r.test && !r.code), sharedOutside(text, ranges))].map((r) => r.name) : [testName(t.path, id)];
    const targetBlock = ctestRows(plain).find((r) => r.name === (selectedName ?? testName(t.path, id)))?.block ?? '';
    cAssertionAbort = /Subprocess aborted/.test(targetBlock) && called.some((name) => new RegExp(`\\b${escapeRe(name)}\\s*(?:\\([^\\n:]*\\))?(?:\\s+(?:const|noexcept))*:\\s+Assertion\\b[^\\n]*failed\\.`).test(targetBlock));
  }
  const childCrash = plain.split('\n').some((line) => /\*\*\*Exception:/i.test(line) && !(cAssertionAbort && new RegExp(`Test\\s+#\\d+:\\s+${escapeRe(selectedName ?? testName(t.path, id))}\\s+.*Subprocess aborted\\*\\*\\*Exception:`).test(line)));
  const crashed = res.exit !== 0 && (res.signal || /There was an error in the forked process|OutOfMemoryError|The forked VM terminated|Fatal error\. Internal CLR error|Test host process crashed|The active test run was aborted|Fatal Python error:|Premature end of PHP process|Allowed memory size of \d+ bytes exhausted|process didn't exit successfully:[^\n]*\((?:signal: \d+|exit (?:status|code): (?!101\))\d+)|\((?:SEGFAULT|ILLEGAL|NUMERICAL|OTHER_FAULT|INTERRUPT)\)/i.test(plain) || childCrash);
  const crashWhy = `the test runner process crashed (${res.signal ?? 'fatal Python error / forked JVM / test host failure'}), so the test result is unknown; make the failure an assertion or fix the crash`;
  const notRunWhy = `${id} never ran or its summary is unobservable (whole-file runner): use verbose=true on enclosing Julia testsets, or the direct Julia runner which enables verbose summaries; an earlier failing testset may also abort the file`;
  let ok;
  let why = '';
  if (sub === 'red') {
    if (res.timedOut) { ok = false; why = timeoutWhy; }
    else if (crashed) { ok = false; why = crashWhy; }
    else if (siblingFail === 'notrun') { ok = false; why = notRunWhy; }
    else if (retest && targetPassed && !zero && siblingFail !== 'skip') ok = true;
    else if (siblingFail === 'sibling') { ok = false; why = `${id} itself passes; the failure comes from another test of the same file (whole-file runner)`; }
    else if (verdict === 'pass' && res.exit !== 0) { ok = false; why = `${id} itself passes; the failure comes from another test or suite setup`; }
    else if (goRunner && goVerdict === 'pass' && res.exit !== 0) { ok = false; why = `${id} itself passes; the failure comes from its parent, a sibling or suite setup`; }
    else if (zero || siblingFail === 'skip') { ok = false; why = 'no test matched the ID, or the test is skipped/todo (check @id vs test title/method name; skipped tests cannot give Red/Green)' + (nodeUnobservable ? '; unobservable Node output: use --test-reporter=spec or --test-reporter=tap' : '') + (goRunner && /\[no test files\]/.test(plain) ? '; go printed [no test files]: a //go:build constraint may hide this file (pass -tags in testCmd)' : ''); }
    else if (res.exit === 0 && retest) ok = true;
    else if (res.exit === 0 && typeof characFlag === 'string' && characFlag.trim()) ok = true;
    else if (res.exit === 0 && vacuousThrows(t.path, id)) { ok = false; why = `test passed: a matcher-less assert.throws / pytest.raises is satisfied by the stub's own "not implemented" error (vacuous test); add a matcher (error type or message) that only the real behaviour satisfies, or record --characterization "<why>"`; }
    else if (res.exit === 0) { ok = false; why = 'test passed; Red needs a real failure (data-only / characterization test? record it explicitly: --characterization "<why no implementation can fail it>"; amending a wrong expectation after Red: --retest "<reason>")'; }
    else if (loadError && stubTodoHit(res.text)) { ok = false; why = stubTodoHit(res.text); }
    else if (loadError && !flags.weak && !(flags['missing-module'] && declaredMissingModule(res.text, t.path))) { ok = false; why = 'load/compile error, not an assertion failure. new module? run `tdd stub <ID>` once (or `--missing-module`); if stub already ran or found nothing, add the missing code by hand; or --weak to record as weak Red' + (/\.py$/.test(t.path) && /ERROR collecting[\s\S]*(?:NotImplementedError|not implemented)/.test(res.text) ? '\nhint: the stub threw at collection time (a call in `@pytest.mark.parametrize` arguments or module level). Build those values inside the test body (or a fixture) so the stub fails at run time as an assertion/Red' : ''); }
    else if (ownHelperTypeError(res.text, t.path)) { ok = false; why = `TypeError raised inside the test's own helper ${ownHelperTypeError(res.text, t.path)}() (argument/signature mismatch): a test bug, not a Red for the behaviour; fix the test`; }
    else if (typeof flags.expect === 'string' && !(juliaSummaryRows(plain) ? targetOutput ?? '' : res.text).includes(flags.expect)) { ok = false; why = `failure output does not contain --expect "${flags.expect}" (Red for the wrong reason?)`; }
    else ok = true;
  } else {
    if (res.timedOut) { ok = false; why = timeoutWhy; }
    else if (crashed) { ok = false; why = crashWhy; }
    else if (siblingFail === 'notrun') { ok = false; why = notRunWhy; }
    else if (verdict === 'fail' || (res.exit !== 0 && siblingFail !== 'sibling' && verdict !== 'pass')) { ok = false; why = loadError ? 'test failed — load/compile error (the build is broken, not an assertion)' : 'test failed'; }
    else if (zero || siblingFail === 'skip') { ok = false; why = 'no test matched the ID' + (nodeUnobservable ? '; unobservable Node output: use --test-reporter=spec or --test-reporter=tap' : ''); }
    else ok = true;
  }
  if (!ok) { out(`${sub.toUpperCase()} REJECTED ${id}: ${why}`); out(rejectTail(res.text)); return 1; }
  const rl = (targetOutput ?? plain).split('\n').map((l) => l.trim());
  const reason = sub === 'red' && res.exit !== 0 && !(retest && targetPassed) ? (rl.find((l) => /^E\s+\S/.test(l) && !/\d+ \/ \d+ \(\d+%\)|^E\s+\[\s*\d+%\]/.test(l))?.replace(/^E\s+/, '') ?? (() => { const i = rl.findIndex((l) => /panicked at/.test(l)); return i >= 0 && rl[i + 1] && !/^note:/.test(rl[i + 1]) ? rl[i + 1] : undefined; })() ?? rl.find((l) => /^(?:\[ERROR\]\s+)?(?:[\w$]+\.)+[\w$]*(?:Exception|Error)\s*$/.test(l))?.replace(/^\[ERROR\]\s+/, '') ?? specificReason(rl) ?? rl.find((l) => /not implemented/i.test(l) && !/^\d+\s*\|/.test(l)) ?? rl.find((l) => /(--- FAIL|AssertionError|Error:|assert |Failed asserting|FAILED|panicked|expected|\(Failed\)|not implemented|Test Failed|Error During Test|\w*Exception:|^Error in )/.test(l) && !/^(FAIL|❯|> Task|The following tests)/.test(l) && !/^\d+\s*\|/.test(l)) ?? rl.find((l) => /^(FAIL|not ok)\s+\S+$/.test(l)) ?? [...rl].reverse().find((l) => l && !/^(npm |note: |error: test failed|test result:|Failed!|Passed!)/.test(l)) ?? '').slice(0, 110) : '';
  // node:test: the file itself failed to load (module-level throw), so no test was registered or executed (#225)
  const nodeLoadFail = sub === 'red' && nodeFailure?.fileFailed;
  const loadWeak = sub === 'red' && (loadError || nodeLoadFail) && !(flags['missing-module'] && declaredMissingModule(res.text, t.path));
  const setupSym0 = sub === 'red' && !flags['allow-setup-red'] ? setupOrigin(rl.find((l) => /^E\s+.*(not implemented|NotImplementedError|unimplemented|is not a function|has no attribute|context manager protocol)/i.test(l)) ?? rl.find((l) => /not implemented|NotImplementedError|unimplemented|is not a function|has no attribute|context manager protocol/i.test(l) && !/^\d+\s*\|/.test(l)) ?? reason, t.path, id, res.text) : null;
  // --expect naming the setup call itself does not make a setup-origin Red the asserted behaviour (#256)
  // an --expect that names the call but says more than the stub's own message ("not implemented: sphere (layout)") and matches the failure is the asserted behaviour (r26d)
  const expectSaysMore = typeof flags.expect === 'string' && res.text.includes(flags.expect) && /\w/.test(flags.expect.replace(/not (?:yet )?implemented|unimplemented|todo|nyi/gi, '').replace(new RegExp(`(?<![\\w$])${escapeRe(setupSym0 ?? '')}(?![\\w$])`, 'g'), ''));
  const setupSym = setupSym0 && !expectSaysMore && (typeof flags.expect !== 'string' || new RegExp(`(?<![\\w$])${escapeRe(setupSym0)}(?![\\w$])`).test(flags.expect)) ? setupSym0 : null;
  const charac = sub === 'red' && res.exit === 0 && !retest ? String(characFlag).trim() : '';
  // a `NAME = None` stub that the test calls fails with TypeError: that is the stub, not the behaviour (#279)
  const noneStub = sub === 'red' && !flags['allow-setup-red'] && /TypeError: 'NoneType' object is not callable/.test(res.text);
  // only an oracle artifact changed since the earlier strong Red (the test's own text is identical): the strong Red still stands (#283)
  const priorStrong = sub === 'red' && targetPassed && !!retest ? prior.filter((e) => e.type === 'red' && !e.weak && !e.retest).at(-1) : null;
  const rebaselined = !!priorStrong?.testSha0 && priorStrong.testSha0 === testOwnSha(t.path, id);
  const retestWeak = sub === 'red' && targetPassed && !!retest && !rebaselined;
  const weakRed = loadWeak || !!setupSym || !!charac || retestWeak || noneStub;
  // `weak`: the stub failed before any assertion could run (fixture/setup error, static initializer, load, None stub). `suspect`: only the name-based setup-vs-act heuristic says so (r24c, design 3.3)
  const suspect = !!setupSym && !loadWeak && !noneStub && !charac && !retestWeak && !/ERROR at setup of|__ex_unit_setup|TypeInitializationException/.test(res.text);
  // human-approved code baseline follows the first implementation: refresh until the feature is fully Green (#92)
  const humanSpecs = sub === 'red' ? [] : loadSpecs().filter((x) => x.approval === 'human' && x.reqs.some((q) => t.refs.verifies.includes(q.id)));
  const wasDone = new Map(humanSpecs.map((x) => [x.feature, featureGreen(x)]));
  // Whole-file runners may fail a sibling while observably passing the selected test.
  const outcomeExit = targetPassed ? 0 : res.exit;
  appendLedger({ type: sub, test: id, req, reqSha: reqShaOf(req), reqShas: Object.fromEntries([...new Set([req, ...t.refs.verifies])].map((r) => [r, reqShaOf(r)]).filter(([, v]) => v)), file: t.path, fileSha: after, protectedFiles: oracleDependencyFiles, produced: Object.keys(producedShas).length ? producedShas : undefined, oracleShas: oracleDependencyFiles.length ? oracleDependencyShas : undefined, artifactShas: sub === 'red' ? undefined : artifactShasFor(t.path, id), checkDefShas: sub === 'red' ? undefined : checkDefShas(cfg), admissionShas: sub === 'red' ? checkAdmissionShas(cfg) : undefined, runnerEnv: runnerEnvRecord(cmd), cmdSha: sha(cmd.join('\0')), exit: outcomeExit, runnerExit: outcomeExit !== res.exit ? res.exit : undefined, ms: res.ms, testSha0: sub === 'red' ? testOwnSha(t.path, id) : undefined, regSha: testRegionSha(t.path, id), rebaselined: rebaselined || undefined, weak: weakRed ? true : undefined, suspect: suspect ? true : undefined, weakWhy: setupSym ? `setup:${setupSym}` : charac ? 'characterization' : retestWeak ? 'retest' : undefined, characterization: charac || undefined, retest: retestWeak || rebaselined ? retest : undefined, priorStrongRed: retestWeak && prior.some((e) => e.type === 'red' && !e.weak && !e.retest) ? true : undefined, implFiles: sub === 'red' ? undefined : Object.fromEntries([...new Set([...ents.values()].filter((c) => c.kind === 'CODE' && c.refs.implements.some((r) => t.refs.verifies.includes(r))).map((c) => c.path))].map((f) => [f, fileSha(f)])), implBlocks: sub === 'red' ? undefined : Object.fromEntries([...ents.values()].filter((c) => c.kind === 'CODE' && c.refs.implements.some((r) => t.refs.verifies.includes(r))).map((c) => [`${c.path}:${c.id}`, implRegionSha(c)]).filter(([, v]) => v)), moved: sub === 'refactor' && prior.filter((e) => e.type === 'green' || e.type === 'refactor').at(-1)?.fileSha !== after && prior.some((e) => e.type === 'green' || e.type === 'refactor') ? true : undefined });
  for (const x of humanSpecs) if (!wasDone.get(x.feature)) {
    const all = readJson(APPROVALS, {});
    if (all[x.feature]?.code) { all[x.feature].code = implFileShas(x); writeJson(APPROVALS, all); }
  }
  const regen = sub === 'green' ? Object.keys(producedShas).filter((f) => producedShas[f] !== prior.filter((e) => e.type === 'red').at(-1)?.produced?.[f]) : [];
  if (regen.length) out(`! ${id}: generated artifact regenerated since Red (artifactProducers): ${regen.slice(0, 4).join(', ')}; the new sha is recorded with this Green`);
  const lastGreen = prior.filter((e) => e.type === 'green' || e.type === 'refactor').at(-1);
  const movedDeps = sub === 'refactor' && lastGreen && lastGreen.fileSha !== after ? changedOracleDeps(lastGreen, t.path, id) : [];
  if (movedDeps.length) out(`⚠ ${id}: oracle dependency changed since the last Green${oracleNote(movedDeps).replace(/^ — oracle dependency changed/, '')} (the test's own region may be unchanged); a refactor does not prove the changed oracle can fail (no Red). If expectations changed, use tdd red/green instead (#239)`);
  else if (sub === 'refactor' && lastGreen && lastGreen.fileSha !== after) out(`⚠ ${id}: test body changed since the last Green (includes the file preamble: imports/includes/helpers); a refactor does not prove the new assertions can fail (no Red). If behaviour/assertions changed, use tdd red/green instead (#118)`);
  out(`${sub.toUpperCase()} ok ${id} (${req}) ${res.ms}ms${reason ? ` — fails with: ${reason}` : ''}${charac ? ` — characterization: ${charac} (test passed)` : retestWeak ? ` — retest: ${retest} (test passed)` : ''}${weakRed && !charac ? ' [weak]' : ''}${noneStub ? ' ⚠ Red is a call of a `NAME = None` stub (TypeError): implement or stub it as a callable' : ''}${setupSym ? ` ⚠ Red comes from setup call "${setupSym}", not the asserted behaviour (${typeof flags.expect === 'string' ? `--expect "${flags.expect}" names "${setupSym}" itself; use text from the asserted behaviour` : `use --expect <text> that does not name "${setupSym}"`}; if the failure text always names "${setupSym}" (it is the stubbed call, or the act call whose output is asserted), stub "${setupSym}" with a minimal working body so the assertion runs, or accept it with --allow-setup-red)` : ''}`);
  if (suspect) out(`! suspect Red (heuristic, not blocking): to record it as a normal Red run \`tdd red ${id} --allow-setup-red\``);
  if (sub === 'red' && res.exit !== 0 && typeof flags.characterization === 'string' && flags.characterization.trim()) out(`! --characterization ignored for ${id}: the test failed, so this is a normal Red (the flag only applies to a test that passes without implementation)`);
  if (sub === 'green') {
    const mine = new Set(t.refs.verifies), implFiles = [...ents.values()].filter((e) => e.kind === 'CODE' && e.refs.implements.some((r) => mine.has(r))).map((e) => e.path);
    const stale = sharedImplStale(t, ents, entries);
    if (!implFiles.length && !entries.some((x) => x.test === id && (x.type === 'green' || x.type === 'refactor')) && !loadSpecs().flatMap((x) => x.reqs).filter((q) => mine.has(q.id)).every((q) => q.testOnly || q.srcs.length)) out(`⚠ ${id}: no code carries @implements ${[...mine].join(', ')} — annotate the implementation so impact/trace can find it (#276); without it the shared-implementation staleness check cannot run (comment-only \`@id CODE-… @implements …\` is enough, the code itself stays unchanged)${dups.some((x) => /^CODE-/.test(x)) ? `; duplicate @id found (${dups.filter((x) => /^CODE-/.test(x)).slice(0, 3).join(', ')}) — only one annotation per id is read, rename the duplicate` : ''}`);
    if (stale.length) out(`⚠ implementation shared with other REQs changed since their Green: ${stale.map((e) => e.id).join(', ')} — re-run them (tdd refactor ${stale.map((e) => e.id).join(' ')}) or the project tests; their evidence is not re-checked automatically`);
  }
  if (sub === 'red' && loadWeak && /not implemented|NotImplementedError|unimplemented/i.test(res.text)) out(`! a stub failed at module load, before any test body ran: every test of this file fails the same way, so this Red says nothing about ${id}; move the stub call into the test or a fixture`);
  if (rebaselined) out(`! --retest: only an oracle dependency changed (the test text is unchanged), so the earlier strong Red of ${id} is kept`);
  if (sub !== 'red') {
    const pg = prior.filter((e) => e.type === 'green' || e.type === 'refactor').at(-1);
    const moved = pg && !needsLock(spec) && Object.entries(pg.reqShas ?? {}).filter(([rid, rsha]) => rsha && reqShaOf(rid) && !reqShaSame(rid, rsha)).map(([rid]) => rid);
    if (moved?.length) out(`⚠ ${moved.join(', ')} changed since its previous Green and ${spec.tier} specs are not hash-locked: confirm the row was not bent to match the code`);
  }
  if (retestWeak && prior.some((e) => e.type === 'red' && !e.weak && !e.retest)) out(`! --retest passed against the current implementation, so the earlier strong Red of ${id} is superseded by a weak Red; to keep failing-Red evidence, temporarily break the implementation and re-run \`tdd red ${id} --retest\``);
  return 0;
}

function traceCheck(ents, dups, specs) {
  const errors = [];
  const warnings = [];
  const reqs = new Map();
  for (const s of specs) for (const r of s.reqs) { if (reqs.has(r.id)) errors.push(`duplicate REQ ${r.id}`); else reqs.set(r.id, { ...r, spec: s }); }
  if (!specs.length) return { errors: [], warnings: ['no specs'], reqs, tested: new Set(), noSpecs: true };
  for (const d of dups.slice(0, 20)) errors.push(d.startsWith('INVALID:') ? `invalid @id ${d.slice(8)}: id suffixes must be uppercase (CODE-X-001B), a lowercase tail is not part of the id` : `duplicate @id ${d}`);
  if (dups.length > 20) errors.push(`... and ${dups.length - 20} more duplicate @id`);
  const tested = new Set();
  const implemented = new Set();
  for (const e of ents.values()) {
    for (const r of [...e.refs.implements, ...e.refs.verifies]) if (r.startsWith('REQ-') && !reqs.has(r)) errors.push(`${e.path}:${e.line} ${e.id} references unknown ${r}`);
    if (e.kind === 'TEST') {
      if (!e.refs.verifies.length) errors.push(`${e.path}:${e.line} ${e.id} has no @verifies`);
      e.refs.verifies.forEach((r) => tested.add(r));
    }
    if (e.kind === 'CODE') {
      if (!e.refs.implements.length) errors.push(`${e.path}:${e.line} ${e.id} has no @implements`);
      e.refs.implements.forEach((r) => implemented.add(r));
    }
  }
  for (const r of reqs.values()) {
    if (r.deferred) continue;
    if (!tested.has(r.id)) errors.push(`${r.id} has no test (@verifies)`);
    // the spec table's Test column is part of the contract: ids must exist and verify that REQ (#146)
    for (const tid of r.tests ?? []) {
      const te = ents.get(tid);
      if (!te || te.kind !== 'TEST') warnings.push(`${r.id}: spec lists ${tid} but no such test exists (@id ${tid})`);
      else if (!te.refs.verifies.includes(r.id)) warnings.push(`${r.id}: spec lists ${tid} but that test does not @verifies ${r.id}`);
    }
    if (!implemented.has(r.id) && !r.testOnly) warnings.push(`${r.id} has no @implements code`);
    // reverse-spec `[src: path:line]` must point at an existing line (#276)
    for (const [f, n, end, anchor] of r.srcs ?? []) {
      let lines = null;
      try { lines = fs.readFileSync(path.join(ROOT, f), 'utf8').split('\n'); } catch {}
      const len = lines ? lines.length : -1, label = `[src: ${f}:${n}${end ? '-' + end : ''}]`;
      if (len < 0) warnings.push(`${r.id}: ${label} file does not exist`);
      else if (n > len) warnings.push(`${r.id}: ${label} line is beyond the end of the file (${len} lines)`);
      else if (end && (end < n || end > len)) warnings.push(`${r.id}: ${label} line range does not resolve (file has ${len} lines)`);
      else if (!lines.slice(n - 1, end ?? n).some((x) => x.trim())) warnings.push(`${r.id}: ${label} cites only blank lines`);
      else if (anchor && !lines.slice(n - 1, end ?? n).some((x) => x.includes(anchor))) warnings.push(`${r.id}: ${label} anchor \`${anchor}\` not found in the cited lines`);
    }
  }
  return { errors, warnings, reqs, tested };
}

const BASELINE = path.join(SDD, 'trace-baseline.json');
const errKey = (e) => e.replace(/:\d+/g, '');
function applyBaseline(t) {
  const base = readJson(BASELINE, null);
  if (!base && !flags.changed) return t;
  const budget = new Map();
  for (const k of base?.errors ?? []) budget.set(k, (budget.get(k) ?? 0) + 1);
  const ch = flags.changed ? changedFiles() : null;
  const keep = (e) => {
    const k = errKey(e);
    if (budget.get(k) > 0) { budget.set(k, budget.get(k) - 1); return false; }
    // errors without a file location (no test for a REQ, duplicate REQ) are repo-wide: never hide them in --changed mode (#60)
    // a REQ removed from a spec leaves dangling references in files that did not change: repo-wide too (#70)
    return base || !ch || !/^\S+:\d+ /.test(e) || / references unknown REQ-/.test(e) || [...ch].some((f) => e.includes(f));
  };
  return { ...t, errors: t.errors.filter(keep) };
}

function cmdTrace() {
  const { ents, dups } = scanEntities(listFiles());
  let t = traceCheck(ents, dups, loadSpecs());
  if (flags.baseline) {
    writeJson(BASELINE, { at: new Date().toISOString(), errors: t.errors.map(errKey) });
    out(`baseline written: ${rel(BASELINE)} (${t.errors.length} errors)`);
    return 0;
  }
  t = applyBaseline(t);
  out(`TRACE ${t.errors.length ? 'FAIL' : 'OK'}: ${[...t.reqs.values()].filter((r) => !r.deferred).length} REQ${[...t.reqs.values()].some((r) => r.deferred) ? ` (+${[...t.reqs.values()].filter((r) => r.deferred).length} deferred: ${[...t.reqs.values()].filter((r) => r.deferred).map((r) => r.id).join(', ')})` : ''}, ${ents.size} annotated entities, ${t.errors.length} errors, ${t.warnings.length} warnings`);
  [...t.errors.slice(0, flags.verbose ? t.errors.length : 10).map((e) => `  ✗ ${e}`), ...t.warnings.slice(0, flags.verbose ? t.warnings.length : 5).map((w) => `  ! ${w}`), ...(t.warnings.length > 5 && !flags.verbose ? [`  ! … +${t.warnings.length - 5} more`] : [])].forEach((l) => out(l));
  return t.errors.length ? 1 : 0;
}

// Snapshot before prepare or checks can normalize a changed lockfile and hide it from later projects (#327, #337).
let changedSnap = null;
function changedFiles() {
  if (changedSnap) return changedSnap;
  const set = new Set();
  const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: ROOT, encoding: 'utf8' });
  if (top.status !== 0) return null;
  const st = spawnSync('git', ['status', '--porcelain', '-z', '-uall'], { cwd: ROOT, encoding: 'utf8' });
  const add = (f) => {
    const p = path.relative(ROOT, path.resolve(top.stdout.trim(), f)).split(path.sep).join('/');
    if (p && p !== '..' && !p.startsWith('../') && !path.isAbsolute(p)) set.add(p);
  };
  if (st.status === 0) {
    const entries = st.stdout.split('\0');
    for (let i = 0; i < entries.length; i++) {
      const l = entries[i];
      if (!l) continue;
      add(l.slice(3));
      if (/[RC]/.test(l.slice(0, 2)) && entries[i + 1]) add(entries[++i]);
    }
  } else return null;
  // `--baseline <ref>`: also everything committed since <ref> (#254)
  if (typeof flags.baseline === 'string') {
    const df = spawnSync('git', ['diff', '--name-only', '-z', flags.baseline, '--'], { cwd: ROOT, encoding: 'utf8' });
    if (df.status !== 0) return null;
    df.stdout.split('\0').filter(Boolean).forEach(add);
  }
  // a changed file of a `parity` pair puts its peer in scope too (#267)
  for (const pr of loadConfig().parity ?? []) for (const [x, y] of [[pr[0], pr[1]], [pr[1], pr[0]]]) { const a = x && normDep(x), b = y && normDep(y); if (a && b && set.has(a) && !set.has(b) && fs.existsSync(path.join(ROOT, b))) set.add(b); }
  return set;
}

const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]*\.py$|_test\.(py|go|exs)$/;
// dependsOn entries: `./contract`, `contract\\` and `contract/` all name the same repo-relative path (#146)
const normDep = (d) => path.posix.normalize(String(d).replace(/\\/g, '/')).replace(/^\.\//, '').replace(/\/+$/, '');
// conservative loosening classifier for what the gate runs/scopes vs the baseline (#331, #332)
/** @id CODE-RUNNER-SELECTION-001 @implements REQ-RUNNER-SELECTION-001 */
function cfgRunLoosening(bc, cfg) {
  const weak = [];
  const toks = (c) => (Array.isArray(c) ? c.map(String) : typeof c === 'string' ? c.trim().split(/\s+/) : []);
  const noop = (c) => {
    let t = toks(c);
    if (t.length >= 3 && /^(ba|z)?sh$/.test(t[0]) && t[1] === '-c') t = t.slice(2).join(' ').replace(/^["']|["']$/g, '').trim().split(/\s+/);
    return t.length === 0 || t[0] === 'true' || t[0] === ':' || t[0] === 'echo' || (t[0] === 'exit' && (t[1] === undefined || t[1] === '0'));
  };
  const runner = (c) => {
    const words = (s) => (s.match(/(?:[^\s"'\\]+|"(?:\\.|[^"])*"|'[^']*'|\\.)+/g) ?? []).map((w) => w.replace(/^(['"])(.*)\1$/, '$2'));
    let t = toks(c);
    while (t.length) {
      const exe = path.basename(t[0]);
      if (/^[A-Za-z_]\w*=/.test(t[0])) { t = t.slice(1); continue; }
      if (/^(ba|z)?sh$/.test(exe) && /^-[a-z]*c[a-z]*$/.test(t[1] ?? '')) { t = words(t[2] ?? ''); continue; }
      if (exe !== 'env') break;
      t = t.slice(1);
      while (t.length) {
        if (t[0] === '--') { t = t.slice(1); break; }
        if (/^[A-Za-z_]\w*=/.test(t[0]) || /^(?:-i|--ignore-environment)$|^--(?:unset|chdir)=/.test(t[0])) { t = t.slice(1); continue; }
        if (/^(?:-u|--unset|-C|--chdir)$/.test(t[0])) { t = t.slice(2); continue; }
        if (t[0] === '-S' || t[0] === '--split-string') { t = [...words(t[1] ?? ''), ...t.slice(2)]; continue; }
        if (t[0].startsWith('--split-string=')) { t = [...words(t[0].slice(15)), ...t.slice(1)]; continue; }
        break;
      }
    }
    const exe = path.basename(t[0] ?? '');
    if (/^(cargo|go|dotnet|mix)$/.test(exe)) return t.slice(1).includes('test');
    if (/^python[\d.]*$/.test(exe)) { const m = t.indexOf('-m'); return m >= 1 && t[m + 1] === 'pytest'; }
    if (exe === 'node') return t.slice(1).some((x) => /^--test(?:=|$)/.test(x));
    if (/^(npm|pnpm|yarn|bun)$/.test(exe) && /^(test|t|run|run-script)$/.test(t[1] ?? '')) return true;
    if (/^(npx|bunx)$/.test(exe)) return /^(pytest|jest|vitest|mocha|ava|playwright)$/.test(t[t[1] === 'exec' ? 2 : 1] ?? '');
    if (/^(npm|pnpm|yarn|bun)$/.test(exe) && t[1] === 'exec') return /^(pytest|jest|vitest|mocha|ava|playwright)$/.test(t[2] ?? '');
    return /^(pytest|jest|vitest|mocha|ava|playwright|mvn|mvnw|gradle|gradlew)$/.test(exe);
  };
  const cmdLoosened = (b, c) => {
    if (b === undefined || noop(b)) return null;
    if (c === undefined) return 'removed';
    if (noop(c)) return 'replaced by a no-op';
    // Runner arguments can select fewer tests even when both commands genuinely execute.
    if (runner(b) && JSON.stringify(toks(b)) !== JSON.stringify(toks(c))) return 'runner arguments/selection changed (may narrow coverage)';
    return null;
  };
  const scope = (label, b, c) => {
    for (const k of ['testCmd', 'changedCmd']) { const why = cmdLoosened(b?.[k], c?.[k]); if (why) weak.push(`${label} ${k} ${why}`); }
    const cur = new Map((c?.checks ?? []).map((x) => [x.name, x]));
    const gone = (b?.checks ?? []).filter((x) => !cur.has(x.name));
    if (gone.length) weak.push(`${label} checks removed: ${gone.map((x) => x.name).join(', ')}`);
    for (const x of b?.checks ?? []) for (const k of ['cmd', 'changedCmd']) if (cur.has(x.name)) { const why = cmdLoosened(x[k], cur.get(x.name)[k]); if (why) weak.push(`${label} check ${x.name} ${k} ${why}`); }
  };
  scope('root', bc, cfg);
  const cp = new Map((cfg.projects ?? []).map((p) => [normDep(p.root), p]));
  for (const bp of bc.projects ?? []) {
    const p = cp.get(normDep(bp.root));
    if (!p) { weak.push(`project ${bp.root} removed`); continue; }
    scope(`project ${bp.root}`, bp, p);
    const dm = [].concat(bp.dependsOn ?? []).map(normDep).filter((d) => !new Set([].concat(p.dependsOn ?? []).map(normDep)).has(d));
    if (dm.length) weak.push(`project ${bp.root} dependsOn removed: ${dm.join(', ')}`);
  }
  const art = (a) => (Array.isArray(a) ? Object.fromEntries(a.map((x) => [x, []])) : a && typeof a === 'object' ? a : {});
  const ba = art(bc.artifacts), ca = art(cfg.artifacts);
  for (const [a, u] of Object.entries(ba)) {
    if (!(a in ca)) { weak.push(`artifacts entry ${a} removed`); continue; }
    const cu = [].concat(ca[a]).map(normDep), lost = [].concat(u).map(normDep).filter((x) => !cu.includes(x));
    if (lost.length) weak.push(`artifacts ${a} consumers removed: ${lost.join(', ')}`);
  }
  const bg = [].concat(bc.generated ?? []).map(String), ng = [].concat(cfg.generated ?? []).map(String).filter((g) => !bg.includes(g));
  if (ng.length) weak.push(`generated += ${ng.join(', ')}`);
  const np = Object.keys(cfg.artifactProducers ?? {}).filter((k) => !(k in (bc.artifactProducers ?? {})));
  if (np.length) weak.push(`artifactProducers += ${np.join(', ')}`);
  return weak;
}
function pytestDefFiles(b) {
  const configs = ['pyproject.toml', 'pytest.ini', 'setup.cfg', 'tox.ini'].map((m) => b + m);
  const files = [], dirs = [ROOT];
  while (dirs.length) {
    const dir = dirs.pop();
    let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = path.join(dir, e.name), f = rel(p);
      if (SKIP.test(f + '/')) continue;
      if (e.isDirectory()) dirs.push(p);
      else if (/\.py$/.test(f)) files.push(f);
    }
  }
  const hooks = files.filter((f) => !SKIP.test(f)
    && (!b || f.startsWith(b) || f === 'conftest.py' || b.startsWith(path.posix.dirname(f) + '/'))
    && (/(^|\/)(?:conftest|pytest|sitecustomize|usercustomize)\.py$/.test(f)
      || (() => { try { return pythonStatements(fs.readFileSync(path.join(ROOT, f), 'utf8')).some((s) => s.tokens.some((t) => t.kind === 'name' && t.value === 'pytest_plugins')); } catch { return false; } })()));
  return [...configs, ...hooks];
}
// Shared lexical boundaries for Python definition discovery and declaration admission.
function pythonStatements(text) {
  const statements = [], tokens = [], brackets = [];
  let unresolved = false;
  const emit = () => {
    if (tokens.length) statements.push({ tokens: tokens.splice(0), unresolved });
    unresolved = false;
  };
  for (let i = 0; i < text.length;) {
    const start = i, ch = text[i];
    if (ch === '\\' && /^\\\r?\n/.test(text.slice(i, i + 3))) {
      i += text[i + 1] === '\r' ? 3 : 2;
      continue;
    }
    if (ch === '#') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if ((ch === '\n' || ch === ';') && !brackets.length) {
      emit(); i++; continue;
    }
    if (/\s/.test(ch)) { i++; continue; }
    let kind = 'symbol';
    if (ch === "'" || ch === '"') {
      kind = 'string';
      const quote = text.startsWith(ch.repeat(3), i) ? ch.repeat(3) : ch;
      i += quote.length;
      let closed = false;
      while (i < text.length) {
        if (text[i] === '\\') { i += 2; continue; }
        if (text.startsWith(quote, i)) { i += quote.length; closed = true; break; }
        if (quote.length === 1 && /[\r\n]/.test(text[i])) { unresolved = true; break; }
        i++;
      }
      if (!closed) unresolved = true;
    } else if (/[A-Za-z_]/.test(ch)) {
      kind = 'name';
      while (i < text.length && /\w/.test(text[i])) i++;
    } else {
      const operator = /^(?:\*\*=|\/\/=|<<=|>>=|[+\-*/%@&|^]=|:=|==|!=|<=|>=|->)/.exec(text.slice(i));
      i += operator ? operator[0].length : 1;
      if ('([{'.includes(ch)) brackets.push(ch);
      else if (')]}'.includes(ch) && brackets.pop() !== ({ ')': '(', ']': '[', '}': '{' })[ch]) unresolved = true;
      else if (ch === '\\') unresolved = true;
    }
    tokens.push({ kind, value: text.slice(start, i), start, end: i });
  }
  if (brackets.length) unresolved = true;
  emit();
  return statements;
}
/** @id CODE-R34-PYTEST-001 @implements REQ-R33-PYTEST-001 */
function pytestPluginDeclarations(text, file) {
  const declarations = [];
  const literal = String.raw`(?:'[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*'|"[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*")`;
  const sequence = String.raw`\s*(?:${literal}\s*(?:,\s*${literal}\s*)*,?\s*)?`;
  const valid = new RegExp(`^(?:${literal}|\\[${sequence}\\]|\\(${sequence}\\))$`);
  const assignment = /^(?:=|:=|\*\*=|\/\/=|<<=|>>=|[+\-*/%@&|^]=)$/;
  for (const statement of pythonStatements(text)) {
    const ts = statement.tokens;
    const binding = ts.findIndex((t) => t.kind === 'name' && t.value === 'pytest_plugins');
    if (binding < 0) continue;
    if (!ts.slice(binding + 1).some((t) => t.kind === 'symbol' && assignment.test(t.value))
      && ts[0].value !== 'del' && !(binding === 0 && ts[1]?.value === ':')) continue;
    let equals = 1;
    if (ts[1]?.value === ':') equals = ts.findIndex((t) => t.kind === 'symbol' && assignment.test(t.value));
    const value = ts.slice(equals + 1).map((t) => t.value).join(' ');
    if (statement.unresolved || ts[0].value !== 'pytest_plugins' || ts[equals]?.value !== '=' || !valid.test(value))
      throw new Error(`REFUSED: unresolved pytest_plugins in ${file}; use literal module names (a string, list or tuple), not computed expressions`);
    declarations.push({ text: text.slice(ts[0].start, ts.at(-1).end), names: [...value.matchAll(/['"]([\w.]+)['"]/g)].map((n) => n[1]) });
  }
  return declarations;
}
function cargoWrapperTokens(text) {
  const result = [];
  const refuse = (why) => { throw new Error(`REFUSED: unresolved Cargo compiler wrapper TOML: ${why}`); };
  for (let i = 0; i < text.length;) {
    const ch = text[i];
    if (ch === '#') { while (i < text.length && text[i] !== '\n') i++; continue; }
    if (ch === '\n') { result.push({ kind: 'separator', value: '\n' }); i++; continue; }
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === '"' || ch === "'") {
      const quote = ch, multi = text.slice(i, i + 3) === ch.repeat(3);
      i += multi ? 3 : 1;
      if (multi && text.slice(i, i + 2) === '\r\n') i += 2;
      else if (multi && text[i] === '\n') i++;
      let value = '', closed = false;
      while (i < text.length) {
        if (text[i] === quote) {
          let end = i;
          while (text[end] === quote) end++;
          const count = end - i;
          if (!multi || count >= 3) {
            if (multi && count > 5) refuse('excess closing quotes');
            value += multi ? quote.repeat(count - 3) : '';
            i += multi ? count : 1;
            closed = true;
            break;
          }
          value += quote.repeat(count); i = end; continue;
        }
        if (quote === '"' && text[i] === '\\') {
          i++;
          if (multi && /^[ \t]*(?:\r?\n)/.test(text.slice(i))) {
            while (/[ \t\r\n]/.test(text[i] ?? '') && i < text.length) i++;
            continue;
          }
          const escape = text[i++];
          const escapes = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' };
          if (Object.hasOwn(escapes, escape)) { value += escapes[escape]; continue; }
          if (escape !== 'u' && escape !== 'U') refuse('unsupported string escape');
          const digits = escape === 'u' ? 4 : 8, hex = text.slice(i, i + digits);
          if (!new RegExp(`^[0-9a-fA-F]{${digits}}$`).test(hex)) refuse('invalid Unicode escape');
          const cp = Number.parseInt(hex, 16);
          if (cp > 0x10ffff || cp >= 0xd800 && cp <= 0xdfff) refuse('invalid Unicode scalar');
          value += String.fromCodePoint(cp); i += digits; continue;
        }
        if (text.slice(i, i + 2) === '\r\n' && multi) { value += '\n'; i += 2; continue; }
        if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\r]/.test(text[i]) || !multi && text[i] === '\n')
          refuse('invalid string control character');
        value += text[i++];
      }
      if (!closed) refuse('unterminated string');
      result.push({ kind: 'string', value });
    } else if ('={}[],.'.includes(ch)) {
      result.push({ kind: 'punctuation', value: ch }); i++;
    } else {
      const start = i;
      while (i < text.length && !/[\s#"'={}[\],.]/.test(text[i])) i++;
      result.push({ kind: 'bare', value: text.slice(start, i) });
    }
  }
  return result;
}
// Static, conservative execution-surface closure; never execute wrappers to discover their inputs.
/** @id CODE-R34-CLOSURE-001 @implements REQ-R34-CLOSURE-001 REQ-CHECK-CLOSURE-001 REQ-CHECK-CLOSURE-002 REQ-CHECK-CLOSURE-003 */
function checkDefClosure(cfg, read = null, knownFiles = null) {
  const live = read === null;
  read ??= (f) => { try { return fs.readFileSync(path.resolve(ROOT, f), 'utf8'); } catch { return null; } };
  const all = [...(cfg.checks ?? []), ...(cfg.testCmd ? [{ name: 'tdd', cmd: cfg.testCmd }] : []),
    ...(cfg.projects ?? []).flatMap((p) => [...(p.checks ?? []), ...(p.testCmd ? [{ name: 'tdd', cmd: p.testCmd }] : [])].map((c) => ({ ...c, name: `${p.root}:${c.name}`, cwd: p.root })))];
  const cache = new Map(), defs = new Map(runnerSdkDefinitions()), directories = new Map(), resolutions = new Map(), executableInputs = new Map(), pythonDirectories = new Map(), tokenCache = new Map(), tokenKinds = new Map();
  const relative = (f) => path.relative(ROOT, f).split(path.sep).join('/');
  let bytes = 0, tokenCount = 0, directoryEntries = 0, inspectionWork = 0;
  const refuse = (f, reason) => { throw new Error(`REFUSED: check-definition discovery budget (${reason}) at ${f}; simplify the command closure or split its definitions; no evidence recorded`); };
  const inspectBudget = (count) => {
    inspectionWork += count;
    if (inspectionWork > 8000000) refuse('source tokens', '8000000 inspection steps');
  };
  const nativeInputs = new Map();
  const nativeBinary = (abs) => {
    if (process.platform !== 'win32') return false;
    if (/\.(?:exe|com)$/i.test(abs)) return true;
    try { return /\.(?:exe|com)$/i.test(fs.realpathSync(abs)); }
    catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
      return false;
    }
  };
  const nativeDigest = (abs) => {
    if (nativeInputs.has(abs)) return nativeInputs.get(abs);
    if (nativeInputs.size >= 200000) refuse(relative(abs), '200000 native executable inputs');
    let digest = null;
    if (live) {
      try { if (fs.statSync(abs).isFile()) digest = executableHash(abs); }
      catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error; }
    } else {
      let real = abs;
      try { real = fs.realpathSync(abs); }
      catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error; }
      const readBinary = read.raw ?? read;
      for (const f of new Set([relative(abs), relative(real)])) {
        const raw = readBinary(f);
        if (raw !== null) { digest = sha(raw); break; }
        if (knownFiles?.includes(f)) refuse(f, 'native executable baseline unreadable');
      }
    }
    nativeInputs.set(abs, digest);
    return digest;
  };
  const suffix = (ts, start) => { inspectBudget(ts.length - start); return ts.slice(start); };
  const directory = (abs) => {
    if (!directories.has(abs)) {
      if (directories.size >= 4096) refuse(relative(abs), '4096 directories');
      let entries;
      try { entries = fs.readdirSync(abs, { withFileTypes: true }); }
      catch (e) {
        if (!['ENOENT', 'ENOTDIR', 'ENAMETOOLONG', 'EINVAL'].includes(e.code)) refuse(relative(abs), `directory unreadable: ${e.code}`);
        entries = [];
      }
      directoryEntries += entries.length;
      if (directoryEntries > 200000) refuse(relative(abs), '200000 directory entries');
      directories.set(abs, new Map(entries.map((e) => [e.name, e])));
    }
    return directories.get(abs);
  };
  const rd = (f) => {
    const abs = path.resolve(ROOT, f);
    f = relative(abs);
    if (!cache.has(f)) {
      if (cache.size >= 200000) refuse(f, '200000 candidate paths');
      const entry = live ? directory(path.dirname(abs)).get(path.basename(abs)) : null;
      let text = null;
      if (!live || (entry && !entry.isDirectory())) {
        if (live) {
          let stat;
          try { stat = fs.statSync(abs); }
          catch (e) { refuse(f, `input unreadable: ${e.code}`); }
          if (stat.isDirectory()) { cache.set(f, null); return null; }
          if (!stat.isFile()) refuse(f, 'non-regular definition');
          if (stat.size > 16 * 1024 * 1024) refuse(f, '16 MiB definition');
        }
        text = read(f);
        if (live && text === null) refuse(f, 'input unreadable');
        if (text !== null) {
          const size = Buffer.byteLength(text);
          if (size > 16 * 1024 * 1024) refuse(f, '16 MiB definition');
          bytes += size;
          if (bytes > 64 * 1024 * 1024) refuse(f, '64 MiB total definitions');
        }
      }
      cache.set(f, text);
    }
    return cache.get(f);
  };
  const resolve = (token, cwd) => {
    const key = `${cwd}\0${token}`;
    if (!resolutions.has(key)) {
      if (resolutions.size >= 200000) refuse(token, '200000 executable candidates');
      resolutions.set(key, resolveExecutable(token, cwd));
    }
    return resolutions.get(key);
  };
  let manifests;
  const cargoManifests = () => manifests ??= (knownFiles ?? gitFiles('*Cargo.toml')).filter((f) => /(^|\/)Cargo\.toml$/.test(f) && !SKIP.test(f));
  let packages;
  const packageManifests = () => {
    if (packages) return packages;
    if (knownFiles) return packages = knownFiles.filter((f) => /(^|\/)package\.json$/.test(f));
    packages = [];
    const dirs = [ROOT];
    while (dirs.length) {
      const dir = dirs.pop();
      for (const e of directory(dir).values()) {
        const p = path.join(dir, e.name), f = relative(p);
        if (SKIP.test(f.replace(/(^|\/)node_modules(?=\/|$)/g, '$1packages') + '/')) continue;
        if (e.isDirectory()) dirs.push(p);
        else if (e.name === 'package.json') packages.push(f);
      }
    }
    return packages;
  };
  const tokens = (text, depth = 0) => {
    if (tokenCache.has(text)) {
      const result = tokenCache.get(text);
      tokenCount += result.length;
      if (tokenCount > 2000000) refuse('source tokens', '2000000 tokens');
      return result;
    }
    if (depth > 16) refuse('source tokens', '16 nested quoted fragments');
    const result = [];
    for (const m of String(text).matchAll(/"([^"]*)"|'([^']*)'|`([^`]*)`|([^\s"'`()\[\]{},;|&<>]+)/g)) {
      const t = m[1] ?? m[2] ?? m[3] ?? m[4];
      if (++tokenCount > 2000000) refuse('source tokens', '2000000 tokens');
      result.push(t);
      if (m[4] === undefined && /\s/.test(t)) for (const nested of tokens(t, depth + 1)) result.push(nested);
    }
    tokenCache.set(text, result);
    return result;
  };
  for (const c of all) {
    const visited = new Set(), activeFiles = new Set(), scripts = new Map(), pythonDefinitions = new Set(), contexts = new Map(), tsConfigs = new Set();
    let ordinaryCount = 0, candidateCount = 0;
    const put = (f, text, label = `check ${c.name} (${f} changed)`) => {
      defs.set(`${c.name}|${f}`, { sha: sha(text), label, python: pythonDefinitions.has(f) });
    };
    const file = (abs, cwd, label, definition = false, pythonRoot = null) => {
      const f = relative(abs), key = `${f}\0${cwd}`;
      if (visited.has(key) || activeFiles.has(f)) {
        const entry = defs.get(`${c.name}|${f}`);
        if (entry && pythonDefinitions.has(f)) entry.python = true;
        return;
      }
      if (nativeBinary(abs)) {
        const digest = nativeDigest(abs);
        if (digest !== null) {
          defs.set(`${c.name}|${f}`, { sha: digest, label: label ?? `check ${c.name} (${f} changed)` });
          visited.add(key);
        }
        return;
      }
      const t = rd(f);
      if (t === null) return;
      // Tests and their implementation are protected by evidence, not whole-file definition hashes.
      if (!definition && (TEST_FILE.test(f) || /@id\s+(?:TEST|CODE)-|@(?:verifies|implements)\b/.test(t))) return;
      if (!definition && !/\.(?:[cm]?[jt]sx?|py|sh|bash|zsh|rb|pl|php|ps1|cmd|bat|mk)$/.test(f) && !/^#!/.test(t)) return;
      put(f, t, label);
      if (t.includes('\0')) return;
      if (activeFiles.size >= 128) refuse(f, '128 nested definition files');
      visited.add(key);
      activeFiles.add(f);
      if (definition && /\.py$/.test(f)) {
        for (const declaration of pytestPluginDeclarations(t, f))
          for (const name of declaration.names) pythonModule(name, cwd, path.dirname(abs), pythonRoot);
        pythonImports(t, abs, cwd, pythonRoot);
      }
      inspect(tokens(t), cwd, path.dirname(abs), false, definition && /\.py$/.test(f));
      if (path.basename(f) === '.npmrc') inspect(tokens(t.replace(/^[\w-]+\s*=/gm, '')), cwd, path.dirname(abs), true);
      activeFiles.delete(f);
    };
    const nodeDefinitions = (cwd) => {
      const key = `resolution:${cwd}`;
      if (visited.has(key)) return;
      visited.add(key);
      const selected = new Set(packageManifests().filter((f) => path.resolve(ROOT, f).startsWith(cwd + path.sep)));
      for (let dir = cwd; ; dir = path.dirname(dir)) {
        selected.add(relative(path.join(dir, 'package.json')));
        if (dir === path.dirname(dir)) break;
      }
      for (const f of selected) {
        const text = rd(f); if (text === null) continue;
        defs.set(`resolution|${f}`, { sha: packageResolutionSha(text), label: `check ${c.name} package resolution (${f} changed)` });
      }
    };
    const compilerWrapper = (value, cwd, base = cwd, kind = 'rustc-wrapper') => {
      if (!value) return;
      const candidates = /[/\\]/.test(value) ? [path.resolve(base, value)]
        : (process.env.PATH ?? '').split(path.delimiter).map((d) => path.resolve(cwd, d || '.', value));
      const abs = resolve(/[/\\]/.test(value) ? path.resolve(base, value) : value, cwd)
        ?? candidates.find((p) => rd(relative(p)) !== null) ?? path.resolve(base, value);
      const f = relative(abs), text = rd(f);
      const raw = live ? (() => { try { return fs.readFileSync(abs); } catch { return null; } })() : read.raw?.(f) ?? text;
      let real = abs;
      try { real = fs.realpathSync(abs); } catch { /* Missing inputs retain their path and unreadable fingerprint. */ }
      defs.set(`executable:${kind}:${c.name}|${f}`, {
        sha: sha(`${relative(real)}\0${raw === null ? 'unreadable' : sha(raw)}`),
        label: `check ${c.name} ${kind} executable ${f} (changed)`,
      });
      file(abs, cwd, undefined, true);
    };
    const cargoWrappers = (text, cwd, base, cli = false) => {
      // Preserve legacy quote-stripped CLI paths, but never guess lost escape semantics.
      if (cli) text = text.replace(/^((?:[\w-]+\.)*(?:rustc(?:-workspace)?-wrapper|RUSTC(?:_WORKSPACE)?_WRAPPER)\s*=\s*)([^"'{}[\]\s]+)$/, (all, key, value) => {
        if (value.includes('\\')) throw new Error('REFUSED: unresolved Cargo compiler wrapper --config escape; use a TOML config file');
        return key + JSON.stringify(value);
      });
      const ts = cargoWrapperTokens(text);
      const refuse = (key) => { throw new Error(`REFUSED: unresolved Cargo compiler wrapper ${key}; use a TOML string or literal env value/relative table`); };
      for (let i = 0; i < ts.length; i++) {
        const key = ts[i].value;
        if (!/^(?:rustc(?:-workspace)?-wrapper|RUSTC(?:_WORKSPACE)?_WRAPPER)$/.test(key)) continue;
        if (ts[i + 1]?.value !== '=') {
          if (['.', ']'].includes(ts[i + 1]?.value)) refuse(key);
          continue;
        }
        const env = key.startsWith('RUSTC');
        let entry = ts[i + 2], relative = false, end = i + 3;
        if (entry?.value === '{' && entry.kind === 'punctuation' && env) {
          let value = null;
          const fields = new Set();
          for (end = i + 3; ts[end]?.value !== '}';) {
            const field = ts[end]?.value, token = ts[end + 2];
            if (!['value', 'relative', 'force'].includes(field) || fields.has(field) || ts[end + 1]?.value !== '=') refuse(key);
            fields.add(field);
            if (field === 'value') {
              if (token?.kind !== 'string') refuse(key);
              value = token;
            } else {
              if (token?.kind !== 'bare' || !['true', 'false'].includes(token.value)) refuse(key);
              if (field === 'relative') relative = token.value === 'true';
            }
            end += 3;
            if (ts[end]?.value === '}') break;
            if (ts[end]?.value !== ',') refuse(key);
            end++;
          }
          if (!value) refuse(key);
          entry = value; end++;
        }
        if (entry?.kind !== 'string') refuse(key);
        if (ts[end] && ts[end].kind !== 'separator') refuse(key);
        if (entry.value.includes('\0')) refuse(key);
        const value = relative ? path.resolve(base, entry.value) : entry.value;
        compilerWrapper(value, cwd, env && !relative ? cwd : base, key.toLowerCase().replaceAll('_', '-'));
        i = end - 1;
      }
    };
    const packageScript = (cwd, name, manager) => {
      const f = relative(path.join(cwd, 'package.json'));
      let pkg;
      try { pkg = JSON.parse(rd(f)); } catch { return; }
      const names = manager === 'bun' ? [name] : [name, `pre${name}`, `post${name}`];
      for (const n of names) {
        const value = pkg?.scripts?.[n];
        if (typeof value !== 'string') continue;
        if (!scripts.has(f)) scripts.set(f, new Map());
        const selected = scripts.get(f);
        if (selected.has(n)) continue;
        selected.set(n, value);
        inspect(tokens(value), cwd, cwd, n !== name);
      }
      const selected = scripts.get(f);
      if (selected) {
        const entries = [...selected].sort(([a], [b]) => a.localeCompare(b));
        // Preserve the old single-script digest for ledgers without hooks or nested scripts.
        put(f, entries.length === 1 ? entries[0][1] : JSON.stringify(entries),
          `check ${c.name} runs package.json script "${name}" (${f} changed)`);
      }
    };
    const cargoDefinitions = (ts, cwd) => {
      const mp = ts.findIndex((t) => t === '--manifest-path' || t.startsWith('--manifest-path='));
      let dir = mp < 0 ? cwd : path.dirname(path.resolve(cwd, ts[mp].includes('=') ? ts[mp].slice(ts[mp].indexOf('=') + 1) : ts[mp + 1] ?? 'Cargo.toml'));
      let root = null;
      const selected = new Set();
      for (; ; dir = path.dirname(dir)) {
        const f = relative(path.join(dir, 'Cargo.toml')), t = rd(f);
        if (t !== null) {
          selected.add(f);
          if (root === null || /^\s*\[workspace\]\s*(?:#.*)?$/m.test(t)) root = dir;
        }
        if (dir === path.dirname(dir)) break;
      }
      if (root) for (const f of cargoManifests()) {
        const p = path.resolve(ROOT, f);
        if (p.startsWith(root + path.sep)) selected.add(f);
      }
      const buildSeen = new Set();
      const buildSource = (abs, entry = abs) => {
        const f = relative(abs), text = rd(f);
        if (text === null || buildSeen.has(f)) return;
        buildSeen.add(f);
        put(f, text);
        for (const dep of [...rustLocalModules(abs, text, entry), ...rustIncludedSources(abs, text)]) buildSource(dep.file, entry);
      };
      for (const f of selected) {
        const t = rd(f); if (t === null) continue;
        put(f, t);
        const base = path.dirname(path.resolve(ROOT, f));
        const pkg = t.split(/^\s*(?=\[)/m).find((s) => /^\s*\[package\]/.test(s)) ?? '';
        const custom = /^\s*build\s*=\s*["']([^"']+)["']/m.exec(pkg)?.[1];
        for (const name of ['build.rs', ...(custom ? [custom] : [])]) buildSource(path.resolve(base, name));
        // Local dependency manifests and their build scripts may also emit admission cfg.
        for (const m of t.matchAll(/\bpath\s*=\s*["']([^"']+)["']/g)) {
          const dep = relative(path.resolve(base, m[1], 'Cargo.toml'));
          if (!selected.has(dep) && rd(dep) !== null) selected.add(dep);
        }
      }
    };
    const tsDefinitions = (ts, cwd) => {
      const seen = tsConfigs;
      const resolveConfig = (value, base) => {
        const p = path.resolve(base, value);
        return [p, p + '.json', path.join(p, 'tsconfig.json')].find((f) => rd(relative(f)) !== null);
      };
      const visit = (abs) => {
        if (!abs || seen.has(abs)) return;
        seen.add(abs);
        const f = relative(abs), text = rd(f);
        if (text === null) return;
        put(f, text);
        let json;
        try { json = JSON.parse(stripJsonc(text)); } catch { return; }
        for (const value of [].concat(json.extends ?? []).filter((v) => typeof v === 'string')) {
          if (/^(?:\.|\/|[A-Za-z]:)/.test(value)) visit(resolveConfig(value, path.dirname(abs)));
          else for (let dir = path.dirname(abs); ; dir = path.dirname(dir)) {
            const direct = resolveConfig(path.join('node_modules', value), dir);
            const parts = value.split('/'), count = value.startsWith('@') ? 2 : 1;
            const pkgDir = path.join(dir, 'node_modules', ...parts.slice(0, count));
            const pkgFile = relative(path.join(pkgDir, 'package.json')), pkgText = rd(pkgFile);
            let entry = direct;
            if (pkgText !== null) {
              put(pkgFile, pkgText);
              if (parts.length === count) {
                try { const pkg = JSON.parse(pkgText); entry = resolveConfig(pkg.tsconfig ?? 'tsconfig.json', pkgDir) ?? entry; } catch { /* compiler reports invalid package metadata */ }
              }
            }
            if (entry) { visit(entry); break; }
            if (dir === path.dirname(dir)) break;
          }
        }
        for (const ref of json.references ?? []) if (typeof ref?.path === 'string') visit(resolveConfig(ref.path, path.dirname(abs)));
      };
      const project = ts.findIndex((t) => /^(?:-p|--project)(?:=|$)/.test(t));
      const build = ts.findIndex((t) => /^(?:-b|--build)(?:=|$)/.test(t));
      if (project >= 0) {
        visit(resolveConfig(ts[project].includes('=') ? ts[project].slice(ts[project].indexOf('=') + 1) : ts[project + 1] ?? '.', cwd));
      } else if (build >= 0) {
        const names = [...(ts[build].includes('=') ? [ts[build].slice(ts[build].indexOf('=') + 1)] : []), ...ts.slice(build + 1).filter((v) => !v.startsWith('-'))];
        for (const name of names.length ? names : ['.']) visit(resolveConfig(name, cwd));
      } else if (!ts.some((t) => /\.[cm]?tsx?$/.test(t))) {
        for (let dir = cwd; ; dir = path.dirname(dir)) {
          const p = path.join(dir, 'tsconfig.json');
          if (rd(relative(p)) !== null) { visit(p); break; }
          if (dir === path.dirname(dir)) break;
        }
      }
    };
    const pythonDirectory = (base) => {
      const prefix = relative(base) + '/';
      if (knownFiles) return knownFiles.some((f) => f.startsWith(prefix));
      if (!pythonDirectories.has(base)) {
        if (pythonDirectories.size >= 200000) refuse(relative(base), '200000 namespace directory candidates');
        const entry = directory(path.dirname(base)).get(path.basename(base));
        let exists = entry?.isDirectory() ?? false;
        if (entry?.isSymbolicLink()) {
          try { exists = fs.statSync(base).isDirectory(); }
          catch (e) {
            if (!['ENOENT', 'ENOTDIR', 'ENAMETOOLONG', 'EINVAL'].includes(e.code)) refuse(relative(base), `namespace unreadable: ${e.code}`);
          }
        }
        pythonDirectories.set(base, exists);
      }
      return pythonDirectories.get(base);
    };
    /** @id CODE-R34-PYREL-001 @implements REQ-CHECK-CLOSURE-001 */
    const pythonInput = (base, root, cwd, required = false, namespace = false) => {
      const module = base + '.py', init = path.join(base, '__init__.py');
      const hasModule = rd(relative(module)) !== null, hasInit = rd(relative(init)) !== null;
      if (hasModule && hasInit) throw new Error(`REFUSED: unresolved Python module ${relative(base)}: ambiguous module and package`);
      if (!hasModule && !hasInit) {
        if (namespace && pythonDirectory(base)) return { base, root, package: true, text: '' };
        if (required) throw new Error(`REFUSED: unresolved Python relative import ${relative(base)}: missing protected input`);
        return null;
      }
      const abs = hasModule ? module : init;
      pythonDefinitions.add(relative(abs));
      for (let dir = path.dirname(base); dir !== root && dir.startsWith(root + path.sep); dir = path.dirname(dir)) {
        if (rd(relative(dir + '.py')) !== null)
          throw new Error(`REFUSED: unresolved Python module ${relative(dir)}: ambiguous or non-package parent`);
        pythonDefinitions.add(relative(path.join(dir, '__init__.py')));
        file(path.join(dir, '__init__.py'), cwd, undefined, true, root);
      }
      file(abs, cwd, undefined, true, root);
      return { base, root, package: hasInit, text: rd(relative(abs)) };
    };
    const pythonModule = (name, cwd, sourceDir = cwd, sourceRoot = null) => {
      if (!/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/.test(name)) return null;
      const p = name.replace(/\./g, '/'), candidates = new Map(), roots = new Set([cwd, sourceDir, ROOT, path.join(cwd, 'src')]);
      for (const d of roots) {
        const base = path.join(d, p);
        if (rd(relative(base + '.py')) === null && rd(relative(path.join(base, '__init__.py'))) === null && !pythonDirectory(base)) continue;
        let root = d;
        if (d === sourceDir) {
          if (sourceRoot && (base === sourceRoot || base.startsWith(sourceRoot + path.sep))) root = sourceRoot;
          else while (rd(relative(path.join(root, '__init__.py'))) !== null) root = path.dirname(root);
        }
        candidates.set(base, { base, root });
      }
      if (candidates.size > 1) throw new Error(`REFUSED: unresolved Python module ${name}: ambiguous local roots`);
      const selected = [...candidates.values()][0];
      if (!selected && name.includes('.') && [...roots].some((d) => {
        const top = path.join(d, name.split('.')[0]);
        return rd(relative(top + '.py')) !== null || rd(relative(path.join(top, '__init__.py'))) !== null
          || pythonDirectory(top);
      })) throw new Error(`REFUSED: unresolved Python module ${name}: missing protected local input`);
      return selected ? pythonInput(selected.base, selected.root, cwd, false, true) : null;
    };
    const pythonImports = (text, abs, cwd, root) => {
      const source = text.replace(/#[^\n]*/g, '').replace(/\\\r?\n/g, ' ');
      const importedNames = (body) => body.replace(/[()]/g, '').split(',').map((s) => s.trim().split(/\s+as\s+/)[0]).filter(Boolean);
      for (const m of source.matchAll(/^[ \t]*import[ \t]+([^\n;]+)/gm))
        for (const name of importedNames(m[1])) pythonModule(name, cwd, path.dirname(abs), root);
      for (const m of source.matchAll(/^[ \t]*from[ \t]+(\.*[\w.]+|\.+)[ \t]+import[ \t]+(\([^)]*\)|[^\n;]+)/gm)) {
        const name = m[1], names = importedNames(m[2]);
        let target;
        if (name.startsWith('.')) {
          const level = /^\.+/.exec(name)[0].length;
          let packageRoot = root;
          if (!packageRoot) {
            packageRoot = path.dirname(abs);
            while (rd(relative(path.join(packageRoot, '__init__.py'))) !== null) packageRoot = path.dirname(packageRoot);
          }
          const parts = path.relative(packageRoot, path.dirname(abs)).split(path.sep).filter(Boolean);
          if (!parts.length || parts.some((p) => p === '..') || level > parts.length)
            throw new Error(`REFUSED: unresolved Python relative import ${name} in ${relative(abs)}: beyond package boundary`);
          const base = path.join(packageRoot, ...parts.slice(0, parts.length - level + 1), ...name.slice(level).split('.').filter(Boolean));
          target = pythonInput(base, packageRoot, cwd, true, true);
        } else target = pythonModule(name, cwd, path.dirname(abs), root);
        if (!target?.package) continue;
        for (const child of names) {
          if (child === '*') continue;
          if (!/^[A-Za-z_]\w*$/.test(child))
            throw new Error(`REFUSED: unresolved Python relative import ${name} in ${relative(abs)}: unsupported imported name`);
          // Package attributes/re-exports are valid; otherwise a from-import loads a child module.
          const bound = new RegExp(`^[ \\t]*(?:(?:def|class)[ \\t]+${child}\\b|${child}[ \\t]*(?::[^=\\n]+)?=)`, 'm').test(target.text)
            || [...target.text.matchAll(/^[ \t]*(?:from[ \t]+\S+[ \t]+import[ \t]+(\([^)]*\)|[^\n;#]+)|import[ \t]+([^\n;#]+))/gm)]
              .some((im) => (im[1] ?? im[2]).replace(/[()]/g, '').split(',').some((s) => {
                const bits = s.trim().split(/\s+as\s+/);
                return (bits[1] ?? bits[0].split('.')[0]) === child;
              }));
          if (!bound) pythonInput(path.join(target.base, child), target.root, cwd, true, true);
        }
      }
    };
    const inspect = (ts, initialCwd, sourceDir = initialCwd, protectedHook = false, pythonSource = false) => {
      inspectBudget(ts.length);
      let cwd = initialCwd, contextCwd = null, context;
      for (let i = 0; i < ts.length; i++) {
        const token = ts[i];
        if (contextCwd !== cwd) {
          const key = `${cwd}\0${sourceDir}\0${protectedHook}\0${pythonSource}`;
          if (!contexts.has(key)) contexts.set(key, { ordinary: new Set(), candidates: new Set() });
          context = contexts.get(key);
          contextCwd = cwd;
        }
        if (!tokenKinds.has(token)) {
          const exe = runnerCommandName(token);
          tokenKinds.set(token, { exe, command: /^(?:cd|import|from|node|npm|pnpm|yarn|bun|npx|bunx|tsc)(?:\.cmd)?$|^(?:python[\d.]*|pytest|cargo|go|dotnet|make|gmake|sh|bash|env)$/.test(exe) || /^(?:CARGO_BUILD_)?RUSTC(?:_WORKSPACE)?_WRAPPER=/.test(token) });
        }
        const { exe, command } = tokenKinds.get(token);
        if (i !== 0 && !command) {
          if (context.ordinary.has(token)) continue;
          context.ordinary.add(token);
          if (++ordinaryCount > 200000) refuse(token, '200000 contextual source tokens');
        }
        if (token === 'cd' && ts[i + 1]) { cwd = path.resolve(cwd, ts[++i]); continue; }
        if (/^(?:node|npm|pnpm|yarn|bun|npx|bunx)(?:\.cmd)?$/.test(exe)) nodeDefinitions(cwd);
        const wrapperEnv = /^((?:CARGO_BUILD_)?RUSTC(?:_WORKSPACE)?_WRAPPER)=(.*)$/.exec(token);
        if (wrapperEnv) compilerWrapper(wrapperEnv[2], cwd, cwd, wrapperEnv[1].toLowerCase().replaceAll('_', '-').replace(/^cargo-build-/, ''));
        if (/^(npm|pnpm|yarn|bun)$/.test(exe)) {
          let j = i + 1, packageCwd = cwd;
          while (/^(--prefix|--cwd|-C|--dir)$/.test(ts[j] ?? '') && ts[j + 1]) {
            packageCwd = path.resolve(cwd, ts[j + 1]); j += 2;
          }
          let name = ts[j];
          if (/^run(?:-script)?$/.test(name ?? '')) name = ts[j + 1];
          if (name === 't') name = 'test';
          if (name && /^[\w:.-]+$/.test(name) && !/^(exec|install|ci|add|dlx)$/.test(name)) packageScript(packageCwd, name, exe);
          for (let dir = packageCwd; ; dir = path.dirname(dir)) {
            file(path.join(dir, '.npmrc'), packageCwd, undefined, true);
            if (dir === path.dirname(dir)) break;
          }
          for (const f of [path.join(os.homedir(), '.npmrc'), path.join(path.dirname(path.dirname(resolve(token, cwd) ?? cwd)), 'etc/npmrc')]) file(f, packageCwd, undefined, true);
        }
        if (exe === 'pytest') {
          const b = relative(cwd), prefix = b ? b + '/' : '';
          for (const f of pytestDefFiles(prefix)) {
            let t = rd(f); if (t === null) continue;
            if (path.posix.basename(f) === 'pyproject.toml') t = t.split(/^(?=\[)/m).filter((x) => /^\[tool\.pytest/.test(x)).join('');
            const declarations = /\.py$/.test(f) ? pytestPluginDeclarations(t, f) : [];
            if (TEST_FILE.test(f)) t = declarations.map((d) => d.text).join('\n');
            put(f, t, `check ${c.name} runs pytest, configured by ${f} (changed)`);
            const configKey = `pytest:${f}`;
            if (visited.has(configKey)) continue;
            visited.add(configKey);
            inspect(tokens(t), cwd, path.dirname(path.resolve(ROOT, f)));
            for (const declaration of declarations)
              for (const name of declaration.names) pythonModule(name, cwd, path.dirname(path.resolve(ROOT, f)));
          }
          inspectBudget(ts.length - i - 1);
          for (let j = i + 1; j < ts.length; j++) if (ts[j] === '-p' && ts[j + 1]) pythonModule(ts[++j], cwd);
        }
        if (exe === 'cargo') {
          const args = suffix(ts, i + 1);
          cargoDefinitions(args, cwd);
          const alias = args.find((t) => !t.startsWith('+') && !t.startsWith('-'));
          for (let dir = cwd; ; dir = path.dirname(dir)) {
            for (const m of ['.cargo/config.toml', '.cargo/config', 'rust-toolchain.toml', 'rust-toolchain']) {
              const f = relative(path.join(dir, m));
              file(path.join(dir, m), cwd, `check ${c.name} runs cargo alias "${alias ?? 'test'}" (${f} changed)`, true);
              if (m.startsWith('.cargo/')) cargoWrappers(rd(f) ?? '', cwd, dir);
            }
            if (dir === path.dirname(dir)) break;
          }
          const home = path.resolve(cwd, process.env.CARGO_HOME ?? path.join(os.homedir(), '.cargo'));
          for (const m of ['config.toml', 'config']) {
            file(path.join(home, m), cwd, undefined, true);
            cargoWrappers(rd(relative(path.join(home, m))) ?? '', cwd, path.dirname(home));
          }
          for (const name of ['RUSTC_WRAPPER', 'RUSTC_WORKSPACE_WRAPPER', 'CARGO_BUILD_RUSTC_WRAPPER', 'CARGO_BUILD_RUSTC_WORKSPACE_WRAPPER'])
            compilerWrapper(process.env[name], cwd, cwd, name.toLowerCase().replaceAll('_', '-').replace(/^cargo-build-/, ''));
          for (let j = i + 1; j < ts.length; j++) if (/^--config(?:=|$)/.test(ts[j])) {
            let value = ts[j].includes('=') ? ts[j].slice(9) : ts[++j] ?? '';
            if (value.endsWith('=') && ts[j + 1]) value += ts[++j];
            if (value.includes('=')) cargoWrappers(value, cwd, cwd, true);
            else {
              const abs = path.resolve(cwd, value);
              file(abs, cwd, undefined, true);
              cargoWrappers(rd(relative(abs)) ?? '', cwd, path.dirname(path.dirname(abs)));
            }
          }
        }
        if (/^tsc(?:\.cmd)?$/.test(exe)) tsDefinitions(suffix(ts, i + 1), cwd);
        if (/^(make|gmake)$/.test(exe)) {
          let makeCwd = cwd;
          const inputs = [];
          inspectBudget(ts.length - i - 1);
          for (let j = i + 1; j < ts.length; j++) {
            if (/^(?:-C|--directory)$/.test(ts[j]) && ts[j + 1]) makeCwd = path.resolve(makeCwd, ts[++j]);
            else if (/^--directory=/.test(ts[j])) makeCwd = path.resolve(makeCwd, ts[j].slice(12));
            else if (/^(?:-f|--file|--makefile)$/.test(ts[j]) && ts[j + 1]) inputs.push(ts[++j]);
            else if (/^(?:-f.+|--(?:file|makefile)=)/.test(ts[j])) inputs.push(ts[j].replace(/^(?:-f|--(?:file|makefile)=)/, ''));
          }
          for (const m of ['GNUmakefile', 'makefile', 'Makefile']) file(path.join(makeCwd, m), makeCwd, undefined, true);
          for (const m of inputs) file(path.resolve(makeCwd, m), makeCwd, undefined, true);
        }
        if (!pythonSource && (token === 'import' || token === 'from')) {
          if (ts[i + 1]) pythonModule(ts[i + 1], cwd, sourceDir);
        }
        const resolved = (i === 0 || /^(?:node|python[\d.]*|pytest|cargo|go|dotnet|npm|pnpm|yarn|bun|make|gmake|sh|bash|env)$/.test(exe)) ? resolve(token, cwd) : null;
        if (resolved && (i === 0 || /^(?:node|python[\d.]*|pytest|cargo|go|dotnet|npm|pnpm|yarn|bun|make|gmake|sh|bash|env)$/.test(exe))) {
          if (/^python[\d.]*$/.test(exe)) file(path.join(path.dirname(path.dirname(resolved)), 'pyvenv.cfg'), cwd, undefined, true);
          /** @id CODE-R36C-CLOSURE-002 @implements REQ-R36C-CLOSURE-001 */
          let input = executableInputs.get(resolved);
          if (!input) {
            const f = relative(resolved), real = fs.realpathSync(resolved), target = relative(real);
            let digest;
            if (nativeBinary(resolved)) digest = nativeDigest(resolved);
            else if (resolved.startsWith(ROOT + path.sep)) {
              // Git tracks a directory symlink, not files below its lexical path.
              const source = !live && real !== resolved && rd(f) === null ? target : f;
              const text = rd(source);
              if (text !== null) digest = live ? executableHash(resolved) : sha(read.raw?.(source) ?? text);
            } else digest = executableHash(resolved);
            input = { f, real, target, digest, fingerprint: digest ? sha(`${target}\0${digest}`) : null, targetSha: digest ? sha(digest) : null };
            executableInputs.set(resolved, input);
          }
          const { f, real, target, digest, fingerprint, targetSha } = input;
          if (digest) {
            if (resolved.startsWith(ROOT + path.sep)) file(resolved, cwd, undefined, true);
            defs.set(`executable:${exe}|${f}`, { sha: fingerprint, label: `check ${c.name} executable ${f} (changed)` });
            if (real !== resolved) defs.set(`executable:${exe}|${target}`, { sha: targetSha, label: `check ${c.name} executable target ${target} (changed)` });
          }
        }
        // Keep argv boundaries (including paths with spaces), and literal paths inside wrapper source.
        const candidate = token.replace(/^--?[\w-]+=/, '');
        if (!candidate || /[*?{}]/.test(candidate) || candidate.startsWith('-')) continue;
        if (context.candidates.has(candidate)) continue;
        context.candidates.add(candidate);
        if (++candidateCount > 200000) refuse(candidate, '200000 contextual candidates');
        /** @id CODE-R36C-CLOSURE-001 @implements REQ-R36C-CLOSURE-001 */
        // Fresh directory membership avoids normalizing nonexistent source identifiers.
        if (live && !/[/\\:]/.test(candidate) && !directory(cwd).has(candidate)
          && (sourceDir === cwd || !directory(sourceDir).has(candidate))) continue;
        const abs = path.resolve(cwd, candidate);
        if (path.isAbsolute(candidate) && !abs.startsWith(ROOT + path.sep) && !/\.(?:[cm]?[jt]s|py|sh|rb|pl)$/.test(candidate)) continue;
        file(abs, cwd, undefined, protectedHook);
        if (sourceDir !== cwd) file(path.resolve(sourceDir, candidate), cwd);
      }
    };
    for (const cmd of [c.cmd, c.changedCmd, c.hubFallbackCmd]) if (cmd) {
      const raw = (Array.isArray(cmd) ? cmd : [cmd]).map(String);
      const inline = /^(?:node|python[\d.]*|ruby|perl)$/.test(path.basename(raw[0] ?? ''));
      const argv = raw.filter((_, i) => !inline || !/^(?:-e|--eval|-p|--print|-c)$/.test(raw[i - 1] ?? ''));
      const cwd = path.resolve(ROOT, c.cwd ?? '.');
      inspect(argv, cwd);
      inspect(argv.flatMap(tokens), cwd);
      /** @id CODE-WINRUN-005 @implements REQ-WINRUN-003 */
      const launch = runnerCommand(raw, cwd, resolve);
      if (launch.script) {
        inspect([launch.file], cwd);
        file(launch.shim, cwd, undefined, true);
        const realShim = fs.realpathSync(launch.shim);
        if (realShim !== launch.shim) file(realShim, cwd, undefined, true);
        file(launch.script, cwd, undefined, true);
        const realScript = fs.realpathSync(launch.script);
        if (realScript !== launch.script) file(realScript, cwd, undefined, true);
        for (const input of [launch.shim, launch.file, launch.script]) {
          defs.set(`launcher:windows|${relative(input)}`, {
            sha: sha(`${relative(fs.realpathSync(input))}\0${executableHash(input)}`),
            label: `Windows launcher input ${relative(input)} (changed)`,
          });
        }
      }
      const pytest = pytestArgs(raw);
      if (pytest) inspect([isolatedPytest(raw, pytest, c.cwd)[0]], cwd);
    }
  }
  return defs;
}
function checkDefShas(cfg) {
  return Object.fromEntries([...checkDefClosure(cfg)].map(([k, v]) => [k, v.sha]));
}
function packageResolutionSha(text) {
  let value = text;
  try {
    const pkg = JSON.parse(text);
    value = JSON.stringify(Object.fromEntries(['name', 'type', 'main', 'imports', 'exports'].filter((k) => Object.hasOwn(pkg, k)).map((k) => [k, pkg[k]])));
  } catch { /* Invalid metadata is still a definition, never an absent input. */ }
  return sha(value);
}
function checkAdmissionShas(cfg, pinned = null) {
  const inputs = Object.fromEntries([...checkDefClosure(cfg)]
    .filter(([k, v]) => v.python || k.startsWith('resolution|') || k.startsWith('environment:msvc|') || k.startsWith('launcher:windows|')
      || /^executable:rustc(?:-workspace)?-wrapper:/.test(k) || /\|(?:.*\/)?\.cargo\/config(?:\.toml)?$/.test(k))
    .map(([k, v]) => [k, v.sha]));
  // Runner/check renames do not change metadata; recorded paths remain protected even if discovery changes.
  for (const k of Object.keys(pinned ?? {})) if (k.startsWith('resolution|') && !Object.hasOwn(inputs, k)) {
    try { inputs[k] = packageResolutionSha(fs.readFileSync(path.resolve(ROOT, k.slice(k.indexOf('|') + 1)), 'utf8')); } catch { /* Missing input differs from the pinned hash. */ }
  }
  return inputs;
}
function rustGateExecution(ents, cfg, runs) {
  if (!runs.length) return [];
  const defs = checkDefClosure(cfg), expected = new Map(), observed = [];
  const owners = new Map();
  rustRunnerSelection = null;
  for (const { c, cmd, scoped, r } of runs) {
    const plain = r.text.replace(/\x1b\[[0-9;]*m/g, '');
    const artifacts = new Map();
    for (const line of plain.split('\n')) if (line.startsWith('{')) {
      try { const a = JSON.parse(line); if (a.reason === 'compiler-artifact' && a.executable && a.target?.src_path) artifacts.set(path.resolve(a.executable), path.resolve(a.target.src_path)); } catch { /* harness output, not a Cargo message */ }
    }
    const headers = [...plain.matchAll(/^\s*(?:Running (?:unittests )?(.+?) \(([^\n]*)\)|Doc-tests\s+(\S+))\s*$/gm)];
    const blocks = [...plain.matchAll(/^running \d+ tests?\s*\n([\s\S]*?)^test result: [^\n]*/gm)];
    for (let i = 0; i < blocks.length; i++) {
      const header = headers.length === blocks.length ? headers[i] : null;
      for (const row of blocks[i][1].matchAll(/^test (.+?) \.\.\. (ok|FAILED)(?:\s|$)/gm)) {
        observed.push({ name: row[1], entry: header?.[2] ? artifacts.get(path.resolve(ROOT, c.cwd ?? '.', header[2])) ?? null : null, source: header?.[1] ?? null, docPackage: header?.[3] ?? null, used: false });
      }
    }
    const manifests = new Set([...defs.keys()].filter((k) => k.startsWith(c.name + '|') && /(?:^|\|)Cargo\.toml$|\/Cargo\.toml$/.test(k)).map((k) => k.slice(k.indexOf('|') + 1)));
    for (const e of ents.values()) {
      if (e.kind !== 'TEST' || !/\.rs$/.test(e.path)) continue;
      if (flags.changed && c.cwd && projectFor(e.path) && normDep(projectFor(e.path).root) !== normDep(c.cwd)) continue;
      let dir = path.dirname(path.resolve(ROOT, e.path)), manifest = null;
      for (; ; dir = path.dirname(dir)) {
        const f = rel(path.join(dir, 'Cargo.toml'));
        if (fs.existsSync(path.join(dir, 'Cargo.toml'))) { manifest = f; break; }
        if (dir === path.dirname(dir)) break;
      }
      if (!manifests.has(manifest)) continue;
      if (!owners.has(e.path)) {
        const selection = projectFor(e.path)?.testCmd ?? cfg.testCmd ?? [];
        const target = selection.findIndex((a) => /^(?:--lib|--test|--bin|--example)$/.test(a));
        const pkg = selection.findIndex((a) => /^(?:-p|--package)$/.test(a));
        rustRunnerSelection = target < 0 && pkg < 0 ? null : { kind: target < 0 ? null : selection[target], name: selection[target + 1], package: pkg < 0 ? null : selection[pkg + 1] };
        try { owners.set(e.path, { owner: rustTarget(e.path, path.resolve(ROOT, c.cwd ?? '.')) }); }
        catch (error) { owners.set(e.path, { error: error.message }); }
        finally { rustRunnerSelection = null; }
      }
      const { owner, error } = owners.get(e.path);
      if (scoped && owner) {
        const packages = cmd.flatMap((a, i) => /^(?:-p|--package)$/.test(a) ? [cmd[i + 1]] : a.startsWith('--package=') ? [a.slice(10)] : []);
        if (packages.length && !packages.includes(owner.package)) continue;
      }
      const text = fs.readFileSync(path.join(ROOT, e.path), 'utf8'), doc = rustDocBlock(text, e.id);
      if (doc) {
        const lines = text.split('\n'), at = lines.findIndex((l) => new RegExp(`@id\\s+${escapeRe(e.id)}(?![\\w-])`).test(l));
        let fence = at;
        while (fence < lines.length && !/^\s*\/\/[/!]\s*(?:```|~~~)/.test(lines[fence])) fence++;
        expected.set(e.id, { e, owner, error, docLine: fence + 1 });
      } else {
        const at = text.search(new RegExp(`@id\\s+${escapeRe(e.id)}(?![\\w-])`));
        const scope = qualifiedTestScope(e.path, text, at, true, owner?.mods ?? []);
        expected.set(e.id, { e, owner, error, name: [scope, testName(e.path, e.id)].filter(Boolean).join('::').replace(/\br#/g, '') });
      }
    }
  }
  const missing = [];
  for (const { e, owner, error, name, docLine } of expected.values()) {
    if (!owner || error) { missing.push(`${e.id} not executed: ${error ?? 'no owning Cargo target resolved'}`); continue; }
    const matches = observed.filter((r) => !r.used && (docLine
      ? r.name.endsWith(` (line ${docLine})`) && path.resolve(owner.dir, r.name.split(' - ')[0]) === path.resolve(ROOT, e.path) && (!r.docPackage || r.docPackage === owner.package.replace(/-/g, '_'))
      : r.name === name && !r.docPackage && (r.entry ? r.entry === owner.entry : !r.source || path.resolve(owner.dir, r.source) === owner.entry)));
    // Without target headers a same-named sibling is not proof of ownership.
    const ambiguous = !docLine && [...expected.values()].some((x) => x.e.id !== e.id && x.name === name && x.owner?.entry !== owner.entry);
    const row = matches.find((r) => r.entry || r.docPackage || !ambiguous);
    if (row) row.used = true;
    else missing.push(`${e.id} not executed in Cargo test output (${e.path}${name ? `: ${name}` : ''}); missing/ignored tests and zero-execution cannot verify evidence`);
  }
  return missing;
}
function missingPytestIds(result, cmd, cwd, ents) {
  if (!result.pytestResults) return [];
  const args = pytestArgs(cmd) ?? [];
  // Explicit selection is reviewed separately through command/config provenance.
  if (args.some((a) => /^(?:-k|-m|--deselect)(?:=|$)/.test(a))) return [];
  const base = path.resolve(ROOT, cwd ?? '.');
  const operands = args.filter((a) => !a.startsWith('-') && fs.existsSync(path.resolve(base, a.split('::')[0])));
  const executed = result.pytestResults.filter((r) => /^(passed|failed)$/.test(r.outcome));
  return [...ents.values()].filter((e) => e.kind === 'TEST' && /\.py$/.test(e.path)
    && path.resolve(ROOT, e.path).startsWith(base + path.sep)
    && (!operands.length || operands.some((p) => { const f = path.resolve(base, p.split('::')[0]), target = path.resolve(ROOT, e.path); return target === f || target.startsWith(f + path.sep); }))
    && !executed.some((r) => { const parts = (r.nodeid ?? '').split('::'); return path.resolve(base, parts[0]) === path.resolve(ROOT, e.path) && parts.at(-1).replace(/\[.*$/, '') === testName(e.path, e.id); })).map((e) => e.id);
}
function missingNodeIds(result, cmd, cwd, ents) {
  const text = result.text.replace(/\x1b\[[0-9;]*m/g, '');
  if (!nodeTestReport(text)) return nodeTestCommand(cmd, cwd) ? ['unobservable Node output: use --test-reporter=spec or --test-reporter=tap;'] : [];
  // Explicit name filters retain the existing command/config provenance policy.
  if (cmd.some((a) => /^--test-(?:name|skip)-pattern(?:=|$)/.test(a))) return [];
  const base = path.resolve(ROOT, cwd ?? '.');
  const at = cmd.indexOf('--test');
  const operands = at < 0 ? [] : cmd.slice(at + 1).filter((a) => !a.startsWith('-')
    && (/\.[cm]?[jt]sx?$/.test(a) || fs.existsSync(path.resolve(base, a))));
  return [...ents.values()].filter((e) => e.kind === 'TEST' && /\.[cm]?[jt]sx?$/.test(e.path)
    && path.resolve(ROOT, e.path).startsWith(base + path.sep)
    && (!operands.length || operands.some((p) => {
      const target = path.resolve(ROOT, e.path), f = path.resolve(base, p);
      return target === f || target.startsWith(f + path.sep) || globRe(f.split(path.sep).join('/')).test(target.split(path.sep).join('/'));
    }))
    && !nodeTestRan(text, e.id, e.path, result.exit === 0)).map((e) => e.id);
}
// scope confidence (design 3.1): globs for `unscoped` / --allow-unscoped / default ignores (matched with globRe)
const SCOPE_IGNORE = ['**/*.md', '.github/**', 'LICENSE', '.sdd/**'];
// workspace-root files that affect every member of an ecosystem: [file pattern, manifests identifying a member]
const WORKSPACE_ROOT = [
  [/^(Cargo\.(toml|lock)|rust-toolchain(\.toml)?|\.cargo\/config(\.toml)?)$/, ['Cargo.toml']],
  [/^(package\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|yarn\.lock|bun\.lockb?)$/, ['package.json']],
  [/^(pyproject\.toml|requirements[^/]*\.txt|uv\.lock|poetry\.lock)$/, ['pyproject.toml', 'requirements.txt', 'pytest.ini']],
  [/^(go\.(mod|sum|work|work\.sum))$/, ['go.mod']],
  [/^(pom\.xml|build\.gradle(\.kts)?|settings\.gradle(\.kts)?|gradle\.properties)$/, ['pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts']],
  [/^(mix\.exs|mix\.lock)$/, ['mix.exs']],
  [/^([^/]+\.(csproj|sln|slnx)|Directory\.(Build|Packages)\.(props|targets)|global\.json|nuget\.config)$/i, [/\.(csproj|sln|slnx)$/]],
];
function gitFiles(glob) {
  const r = spawnSync('git', ['ls-files', '-co', '--exclude-standard', glob], { cwd: ROOT, encoding: 'utf8' });
  const re = new RegExp('^' + glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
  return (r.status === 0 ? r.stdout.split('\n') : workspaceFiles().filter((f) => re.test(f))).filter((f) => f && !/(^|\/)(node_modules|vendor)\//.test(f));
}
const stripJsonc = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:"'])\/\/.*$/gm, '$1').replace(/,(\s*[}\]])/g, '$1');
// bare-specifier aliases: workspace package names and tsconfig paths -> source file candidates
function aliasMap(set, allowMissing = false) {
  const map = [];
  const pick = (dir, target, missing = allowMissing, exact = false) => {
    if (typeof target !== 'string') return null;
    const t = path.posix.normalize(path.posix.join(dir, String(target)));
    if (exact) return t;
    const stem = t.replace(/\.[cm]?[jt]sx?$/, '');
    const srcStem = stem.replace(/^((?:.*\/)?)(dist|build|lib)\//, '$1src/');
    for (const c of [stem, srcStem]) for (const e of ['.ts', '.tsx', '.js', '.mjs', '.jsx', '/index.ts', '/index.js']) if (set.has(c + e)) return c + e;
    if (missing) return /\.[cm]?[jt]sx?$/.test(t) ? t : stem + '.ts';
    return null;
  };
  for (const pf of gitFiles('*package.json')) {
    const dir = path.posix.dirname(pf);
    const pkg = readJson(path.join(ROOT, pf), null);
    if (!pkg) continue;
    const ex = typeof pkg.exports === 'string' || (pkg.exports && typeof pkg.exports === 'object' && !Object.keys(pkg.exports).some((k) => k.startsWith('.'))) ? { '.': pkg.exports } : pkg.exports ?? {};
    // The graph is shared by different runners. Widen across every ordered
    // condition/array branch instead of guessing import/default/require (#358).
    const entries = (v) => typeof v === 'string' ? [v] : v && typeof v === 'object' ? Object.values(v).flatMap(entries) : [];
    const packageAlias = (name, value, extra = {}) => {
      const targets = entries(value);
      if (!targets.length) map.push([name, null, false, { ...extra, unresolved: pf }]);
      for (const target of targets) {
        if (!target.startsWith('./') || target.split('/').includes('..')) { map.push([name, null, false, { ...extra, unresolved: pf }]); continue; }
        if (name.endsWith('/*') && target.includes('*')) {
          const i = target.indexOf('*'), pre = path.posix.normalize(path.posix.join(dir, target.slice(0, i)));
          map.push([name.slice(0, -2), '', true, { ...extra, wild: { pre: pre.replace(/\/+$/, '') + (target.slice(0, i).endsWith('/') ? '/' : ''), suf: target.slice(i + 1), exact: true } }]);
        } else if (!name.includes('*') && !target.includes('*')) {
          const exact = pick(dir, target, true, !allowMissing);
          map.push([name, exact, false, extra]);
          // Emitted TS entrypoints also retain their existing source edge, but
          // never replace the runtime target (including its missing sentinel).
          const source = !allowMissing && !set.has(exact) ? pick(dir, target, false) : null;
          if (source && source !== exact) map.push([name, source, false, extra]);
        } else map.push([name, null, false, { ...extra, unresolved: pf }]);
      }
    };
    if (pkg.name) {
      if (pkg.exports !== undefined) {
        packageAlias(pkg.name, ex['.'], { package: true });
        for (const [k, v] of Object.entries(ex)) if (k.startsWith('./')) packageAlias(`${pkg.name}/${k.slice(2)}`, v, { package: true });
      } else {
        const f = pick(dir, pkg.main ?? pkg.module ?? 'src/index.ts') ?? pick(dir, 'src/index');
        if (f) map.push([pkg.name, f, false]);
        map.push([pkg.name, dir === '.' ? '' : dir, true]);
      }
    }
    // package.json "imports" (#alias) apply only inside this package (#213)
    for (const [k, v] of Object.entries(pkg.imports ?? {})) {
      if (!k.startsWith('#')) continue;
      const scope = dir === '.' ? '' : dir;
      packageAlias(k, v, { scope });
    }
  }
  for (const tf of gitFiles('*tsconfig*.json')) {
    const dir = path.posix.dirname(tf);
    const co = readJson(path.join(ROOT, tf), null) ?? (() => { try { return JSON.parse(stripJsonc(fs.readFileSync(path.join(ROOT, tf), 'utf8'))); } catch { return null; } })();
    const base = path.posix.join(dir, co?.compilerOptions?.baseUrl ?? '.');
    for (const [k, vs] of Object.entries(co?.compilerOptions?.paths ?? {})) {
      const star = k.endsWith('/*');
      const t = star ? null : pick(base, String(vs[0]).replace(/\/\*$/, ''), allowMissing);
      map.push([star ? k.slice(0, -2) : k, t ?? path.posix.join(base, String(vs[0]).replace(/\/\*$/, '')), star || !t]);
    }
  }
  return map.sort((a, b) => b[0].length - a[0].length);
}

function aliasSources(aliases, set, spec, from = '') {
  const found = [];
  let owner = path.posix.dirname(from);
  if (spec.startsWith('#')) {
    while (owner !== '.' && !fs.existsSync(path.join(ROOT, owner, 'package.json'))) owner = path.posix.dirname(owner);
    if (owner === '.') owner = '';
  }
  for (const [name, target, isDir, extra] of aliases) {
    if (extra?.scope !== undefined && extra.scope !== owner) continue;
    const unsupportedPattern = extra?.unresolved && name.includes('*') && new RegExp('^' + name.split('*').map(escapeRe).join('.*') + '$').test(spec);
    if (spec !== name && !(isDir && spec.startsWith(name + '/')) && !unsupportedPattern) continue;
    if (extra?.unresolved) throw new Error(`REFUSED: unresolved Node package target ${spec} in ${extra.unresolved} — use local literal imports/exports targets or explicit relative oracle imports`);
    if (spec === name && !isDir) { found.push(target); continue; }
    if (extra?.wild && spec.startsWith(name + '/')) {
      const b = extra.wild.pre + spec.slice(name.length + 1) + extra.wild.suf;
      if (extra.wild.exact) {
        found.push(b);
        if (!set.has(b)) {
          const stem = b.replace(/\.[cm]?[jt]sx?$/, ''), src = stem.replace(/^((?:.*\/)?)(dist|build|lib)\//, '$1src/');
          const source = [src + '.ts', ...['.ts', '.tsx', '.js', '.mjs', '.cjs', '.jsx', '/index.ts', '/index.js'].map((e) => stem + e)].find((c) => set.has(c));
          if (source) found.push(source);
        }
        continue;
      }
    }
    if (isDir && !extra?.wild) {
      const base = path.posix.join(target, spec === name ? '' : spec.slice(name.length + 1)), stem = base.replace(/\.[cm]?[jt]sx?$/, '');
      const hit = [base, ...['.ts', '.tsx', '.js', '.mjs', '.cjs', '.jsx', '/index.ts', '/index.js', '/src/index.ts'].map((e) => stem + e)].find((c) => set.has(c));
      if (hit) found.push(hit);
    }
  }
  return [...new Set(found)];
}

// exported symbols touched by the uncommitted diff of a JS/TS file.
// -> { neutral: true } comment/blank-only | { symbols: Set } all hunks inside exported declarations | null unknown (be conservative)
const DECL = /^(export\s+)?(default\s+)?(declare\s+)?(async\s+)?(abstract\s+)?(const|let|var|function\*?|class|interface|type|enum|namespace)\s+([\w$]+)/;
const COMMENT_OR_BLANK = /^\s*($|\/\/|\/\*|\*)/;
function changedSymbols(file) {
  const r = spawnSync('git', ['diff', '-U0', 'HEAD', '--', file], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64e6 });
  if (r.status !== 0 || !r.stdout.trim()) return null;
  const lines = fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n');
  const starts = [];
  lines.forEach((l, i) => { const m = DECL.exec(l); if (m) starts.push({ i, exported: !!m[1], name: m[7] }); else if (/^export\s+(type\s+)?(\{|\*)/.test(l)) starts.push({ i, exported: true, name: null, reexport: true }); else if (/^export\s+default\b/.test(l)) starts.push({ i, exported: true, name: 'default' }); });
  const symbols = new Set();
  let neutral = true;
  for (const h of r.stdout.matchAll(/^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
    const oldN = h[1] === undefined ? 1 : +h[1];
    const start = +h[2] - 1;
    const n = h[3] === undefined ? 1 : +h[3];
    const hunkText = r.stdout.slice(h.index).split(/\n(?=@@ )/)[0].split('\n').slice(1).filter((l) => /^[+-]/.test(l)).map((l) => l.slice(1));
    if (hunkText.every((l) => COMMENT_OR_BLANK.test(l))) continue;
    neutral = false;
    if (n === 0 || oldN === 0 && n === 0) return null;
    for (let i = start; i < start + n; i++) {
      if (COMMENT_OR_BLANK.test(lines[i] ?? '')) continue;
      let d = null;
      for (const st of starts) if (st.i <= i) d = st; else break;
      if (!d || !d.exported) return null;
      if (d.reexport) {
        let j = d.i; let txt = lines[j];
        while (!/\}|\*\s+from|;\s*$/.test(txt) && j < lines.length - 1) txt += ' ' + lines[++j];
        if (/export\s+(type\s+)?\*/.test(txt) && !/\*\s+as\s+/.test(txt)) return null;
        const names = /\{([^}]*)\}/.exec(txt)?.[1].split(',').flatMap((x) => x.trim().split(/\s+as\s+/)).filter(Boolean) ?? [];
        if (!names.length) return null;
        names.forEach((x) => symbols.add(x.replace(/^type\s+/, '')));
      } else symbols.add(d.name);
    }
  }
  return neutral ? { neutral: true } : { symbols };
}

// name-level taint: tests (among dependents) that reach any changed symbol via declarations that mention it
function symbolReach(symbols, files) {
  const texts = new Map(files.map((f) => [f, fs.readFileSync(path.join(ROOT, f), 'utf8').split('\n')]));
  const decls = new Map();
  for (const [f, ls] of texts) {
    const st = [];
    ls.forEach((l, i) => { const m = DECL.exec(l); if (m) st.push({ i, name: m[7] }); });
    decls.set(f, st);
  }
  const tainted = new Set(symbols);
  const hit = new Set();
  const esc = (x) => x.replace(/[$]/g, '\\$&');
  for (let changed = true; changed;) {
    changed = false;
    const re = new RegExp(`(?<![\\w$])(${[...tainted].map(esc).join('|')})(?![\\w$])`);
    for (const [f, ls] of texts) {
      ls.forEach((l, i) => {
        if (COMMENT_OR_BLANK.test(l) || !re.test(l)) return;
        if (TEST_FILE.test(f)) { hit.add(f); return; }
        let d = null;
        for (const x of decls.get(f)) if (x.i <= i) d = x; else break;
        if (d && !tainted.has(d.name)) { tainted.add(d.name); changed = true; }
      });
    }
  }
  return [...hit];
}

// transitive dependents (relative imports only) of the changed JS/TS files, to detect hub changes
function jsRev(files) {
  const set = new Set(files);
  const resolve = (from, spec) => {
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
    const stem = base.replace(/\.[cm]?[jt]sx?$/, '');
    for (const c of [base, ...['.ts', '.tsx', '.js', '.mjs', '.cjs', '.jsx', '/index.ts', '/index.js'].map((e) => stem + e)]) if (set.has(c)) return c;
    return null;
  };
  const aliases = aliasMap(set);
  const rev = new Map();
  for (const f of files.filter((x) => !/\.json$/.test(x))) {
    // type-only imports are erased at runtime and do not propagate a change (#111)
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8')
      .replace(/\bimport\s+type\b[^;'"]*?from\s*['"][^'"\n]+['"]/g, '')
      .replace(/\bimport\s*\{([^}]*)\}\s*from\s*(['"][^'"\n]+['"])/g, (all, specs, q) => (specs.trim() && specs.split(',').filter((x) => x.trim()).every((x) => /^\s*type\s/.test(x)) ? '' : all));
    for (const m of src.matchAll(/(?:from\s+|import\s*\(?\s*|require\(\s*)['"]([^'"\n]+)['"]/g)) {
      const targets = m[1].startsWith('.') ? [resolve(f, m[1])] : aliasSources(aliases, set, m[1], f);
      for (const t of targets) if (t) { if (!rev.has(t)) rev.set(t, []); rev.get(t).push(f); }
    }
  }
  return rev;
}

function relatedTests(changed) {
  const files = listFiles().filter((f) => /\.[cm]?[jt]sx?$/.test(f));
  const set = new Set(files);
  const rev = jsRev(files);
  const seen = new Set(changed.filter((f) => set.has(f)));
  const queue = [...seen];
  while (queue.length) for (const d of rev.get(queue.pop()) ?? []) if (!seen.has(d)) { seen.add(d); queue.push(d); }
  const direct = [...new Set(changed.flatMap((f) => rev.get(f) ?? []))].filter((f) => TEST_FILE.test(f));
  return { direct, files: [...seen], tests: [...seen].filter((f) => TEST_FILE.test(f)), total: files.filter((f) => TEST_FILE.test(f)).length };
}

const PREPARE_CACHE = path.join(SDD, 'prepare-cache.json');
function prepareKey(pc) {
  const inputs = pc.inputs?.length ? scanless(pc.inputs.map(globRe)) : [...listFiles(), ...gitFiles('*package.json'), ...gitFiles('*tsconfig*.json')];
  const h = createHash('sha256').update(JSON.stringify(pc.cmd));
  for (const f of [...new Set(inputs)].sort()) if (fs.existsSync(path.join(ROOT, f))) h.update(f + '\0' + fileSha(f) + '\0');
  return h.digest('hex');
}
function scanless(res) {
  return workspaceFiles().filter((f) => res.some((x) => x.test(f)));
}

// Keep the bytes validated by the gate immutable across project-controlled commands (#342).
function gatePathSha(f, seen = new Set()) {
  if (f.startsWith('environment:msvc|')) return new Map(runnerSdkDefinitions()).get(f)?.sha ?? null;
  const p = path.resolve(ROOT, f);
  try {
    if (!fs.statSync(p).isDirectory()) return executableHashes.has(p) ? executableHash(p) : fileSha(f);
    const real = fs.realpathSync(p);
    if (seen.has(real)) return `cycle:${real}`;
    const next = new Set([...seen, real]);
    return sha(fs.readdirSync(p).sort().map((n) => n + '\0' + gatePathSha(path.join(f, n), next)).join('\0'));
  } catch (e) { return `unreadable:${e.code}`; }
}
function gateSpecPaths() {
  try { return fs.readdirSync(SPECS).filter((f) => f.endsWith('.md')).map((f) => `.sdd/specs/${f}`); } catch { return []; }
}
function gateInputSnapshot(specs, ents, cfg) {
  const paths = new Set([CONFIG, LEDGER, APPROVALS, RETIRED_REQS, BASELINE].map(rel));
  for (const s of specs) for (const f of s.artifacts) paths.add(rel(path.resolve(ROOT, f)));
  for (const a of Object.values(readJson(APPROVALS, {}))) if (a.reviewSha && a.review) paths.add(rel(path.resolve(ROOT, a.review)));
  for (const e of ents.values()) paths.add(e.path);
  const outputs = [].concat(cfg.prepare?.outputs ?? []).map(normDep);
  const isOutput = (f) => outputs.some((o) => f === o || f.startsWith(o + '/') || globRe(o).test(f));
  const testPaths = new Set();
  for (const e of ents.values()) if (e.kind === 'TEST') {
    testPaths.add(e.path);
    testSha(e.path, e.id);
    for (const f of oracleDependencyFiles) if (!isOutput(f)) paths.add(f);
    for (const f of Object.keys(artifactShasFor(e.path, e.id) ?? {})) if (!isOutput(f)) paths.add(f);
  }
  for (const k of Object.keys(checkDefShas(cfg))) paths.add(k.startsWith('environment:msvc|') ? k : k.slice(k.indexOf('|') + 1));
  // Direct command files and their local imports share the same closure for prepare and checks.
  for (const c of [cfg.prepare, ...cfg.checks ?? [], ...(cfg.projects ?? []).flatMap((p) => (p.checks ?? []).map((c) => ({ ...c, cwd: p.root })))].filter(Boolean)) {
    for (const arg of [...c.cmd ?? [], ...c.changedCmd ?? [], ...c.hubFallbackCmd ?? []]) {
      const f = rel(path.resolve(ROOT, c.cwd ?? '.', arg));
      if (f.startsWith('../') || path.isAbsolute(f)) continue;
      try {
        const p = path.join(ROOT, f);
        if (fs.statSync(p).isFile() && (EXT.test(f) || arg === c.cmd?.[0] || /^#!/.test(fs.readFileSync(p, 'utf8')))) {
          paths.add(f);
          if (!testPaths.has(f)) for (const dep of importClosure(f)) paths.add(dep);
        }
      } catch { /* not a local command file */ }
    }
  }
  return new Map([...paths].map((f) => [f, gatePathSha(f)]));
}
function changedGateInputs(snapshot, cfg) {
  const paths = new Set([...snapshot.keys(), ...gateSpecPaths(), ...[...scanEntities(listFiles()).ents.values()].map((e) => e.path)]);
  for (const k of Object.keys(checkDefShas(cfg))) paths.add(k.startsWith('environment:msvc|') ? k : k.slice(k.indexOf('|') + 1));
  return [...paths].filter((f) => !snapshot.has(f) || snapshot.get(f) !== gatePathSha(f)).sort();
}

/** @id CODE-PLAN-CLI-STANDALONE @implements REQ-PLAN-CLI-001 REQ-PLAN-CLI-004 */
function standalonePlanningRefusal() {
  const refuse = (exit, reason) => ({ enabled: true,
    stage: pos[0] === 'plan' ? pos[1] === 'verify' ? 'verify' : 'consistency' : pos[0],
    status: exit === 1 ? 'FAIL' : 'INCOMPLETE', exit,
    errors: [{ id: '.sdd/config.json', reason, exit }], tasks: [] });
  const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const inside = (base, target) => {
    const tail = path.relative(base, target);
    return tail !== '..' && !tail.startsWith('..' + path.sep) && !path.isAbsolute(tail);
  };
  let config = {}, exists = false, fd;
  try {
    try { fs.lstatSync(CONFIG); exists = true; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (exists) {
      const base = fs.realpathSync(ROOT);
      let file = base;
      for (const part of ['.sdd', 'config.json']) {
        file = path.join(file, part);
        const entry = fs.lstatSync(file);
        try { file = fs.realpathSync(file); }
        catch (error) {
          if (error.code === 'ENOENT' && entry.isSymbolicLink()
            && !inside(base, path.resolve(path.dirname(file), fs.readlinkSync(file)))) {
            return refuse(1, 'Configuration symlink points outside project root');
          }
          throw error;
        }
        if (!inside(base, file)) return refuse(1, 'Configuration symlink resolves outside project root');
      }
      if (!fs.statSync(file).isFile()) return refuse(1, 'Configuration must be a regular file');
      fd = fs.openSync(file, 'r');
      const limit = 1048576, bytes = Buffer.alloc(limit + 1);
      if (fs.fstatSync(fd).size > limit) return refuse(1, 'Configuration exceeds 1048576 bytes');
      let length = 0, count;
      while (length < bytes.length && (count = fs.readSync(fd, bytes, length, bytes.length - length, null)) > 0) length += count;
      if (length > limit) return refuse(1, 'Configuration exceeds 1048576 bytes');
      if (!isUtf8(bytes.subarray(0, length))) return refuse(1, 'Configuration is not valid UTF-8 JSON');
      config = JSON.parse(bytes.subarray(0, length).toString('utf8'));
    }
  } catch (error) {
    if (error instanceof SyntaxError) return refuse(1, 'Configuration is not valid JSON');
    if (error.code) return refuse(2, `Configuration unavailable (${error.code})`);
    throw error;
  } finally { if (fd !== undefined) fs.closeSync(fd); }
  if (!record(config)) return refuse(1, 'Project configuration must be a JSON object');
  if (Object.hasOwn(config, 'planning')
    && (!record(config.planning) || typeof config.planning.required !== 'boolean')) {
    return refuse(1, 'planning.required must be a boolean');
  }
  if (config.planning?.required !== true && (pos[0] === 'gate' || pos[0] === 'plan' && pos.length === 1)) return null;
  return refuse(2, 'Planning modules unavailable; install the complete lean-sdd-tdd skill');
}

/** @id CODE-PLAN-CLI-NATIVE @implements REQ-PLAN-CLI-001 REQ-PLAN-CLI-002 REQ-PLAN-CLI-004 */
function planningSession(specs, scanned) {
  if (!planningModules.length) return { enabled: false, stage: 'structure', status: 'DISABLED', exit: 0, errors: [] };
  try {
    const config = readPlanningConfiguration(ROOT, loadConfig);
    if (config.planning?.required !== true) return loadImplementationPlan({ root: ROOT, config, specs: [] });
    specs ??= loadSpecs();
    scanned ??= scanEntities(listFiles());
    const metadata = specs.map(spec => ({ ...spec, reqs: spec.reqs.map(req => ({ ...req,
      tests: [...new Set([...req.tests, ...[...scanned.ents.values()].filter(entity => entity.kind === 'TEST'
        && entity.refs.verifies.includes(req.id)).map(entity => entity.id)])] })) }));
    const loaded = loadImplementationPlan({ root: ROOT, config, specs: metadata });
    if (loaded.exit) return loaded;
    const nativeScript = fileURLToPath(import.meta.url);
    const nativeChecks = task => task.tests.map(id => ({ name: `native-${id}`,
      argv: [process.execPath, nativeScript, 'tdd', 'refactor', id, '--root', ROOT],
      timeoutMs: Math.min(config.timeoutMs ?? 600000, 600000) }));
    const inspect = task => {
      const bindings = Object.fromEntries(task.tests.map(id => [id, null])), errors = [], events = [];
      const problem = (id, exit, reason) => errors.push({ id, exit, reason });
      try {
        const currentConfig = readPlanningConfiguration(ROOT, loadConfig);
        const currentSpecs = loadSpecs(), { ents, dups } = scanEntities(listFiles());
        const tool = sha(['sdd.mjs', 'implementation-plan.mjs', 'implementation-plan-evidence.mjs',
          'implementation-plan-cli.mjs', 'spec-context.mjs'].map(file => file + '\0'
            + sha(fs.readFileSync(new URL(file, import.meta.url)))).join('\0'));
        const trace = traceCheck(ents, dups, currentSpecs);
        const ids = new Set([...task.reqs, ...task.tests]);
        for (const reason of trace.errors) if ([...reason.matchAll(/\b(?:REQ|TEST|CODE)-[A-Z0-9-]+\b/g)].some(match => ids.has(match[0]))) {
          problem(task.id, / has no test \(@verifies\)/.test(reason) ? 2 : 1, reason);
        }
        let entries = [], ledgerUnavailable = false;
        try {
          const fd = fs.openSync(LEDGER, 'r');
          try {
            if (fs.fstatSync(fd).size > 67108864) throw new PlanningError(2, task.id, 'Native ledger exceeds read budget');
            const bytes = fs.readFileSync(fd);
            if (bytes.length > 67108864) throw new PlanningError(2, task.id, 'Native ledger exceeds read budget');
            entries = new TextDecoder('utf-8', { fatal: true }).decode(bytes).split('\n').filter(Boolean).map(line => JSON.parse(line));
          } finally { fs.closeSync(fd); }
        } catch (error) {
          if (error.code !== 'ENOENT') {
            if (error instanceof PlanningError) problem(error.id, error.exit, error.message);
            else if (error instanceof SyntaxError || error instanceof TypeError || error.code) {
              problem(task.id, 2, 'Native ledger is unavailable or unparseable');
            } else throw error;
            ledgerUnavailable = true;
          }
        }
        const chain = ledgerUnavailable ? null : verifyChain(entries);
        if (chain) problem(task.id, 1, `invalid native ledger: ${chain}`);
        for (const id of task.tests) {
          const entity = ents.get(id);
          if (!entity || entity.kind !== 'TEST') { problem(id, 2, 'Required native TEST is unavailable'); continue; }
          const project = projectFor(entity.path);
          bindings[id] = { path: entity.path, sha256: testSha(entity.path, id), tool,
            reqs: Object.fromEntries(currentSpecs.flatMap(spec => spec.reqs)
              .filter(req => entity.refs.verifies.includes(req.id)).map(req => [req.id, req.sha])),
            runner: project?.testCmd ?? currentConfig.testCmd, project: project?.root ?? '.' };
          for (const spec of currentSpecs.filter(spec => !ledgerUnavailable && spec.reqs.some(req => entity.refs.verifies.includes(req.id)))) {
            if (needsLock(spec)) {
              const state = approvalState(spec);
              if (state !== 'ok') problem(id, state === 'missing' ? 2 : 1, `${spec.feature}: approval ${state}`);
              const design = designProblem(spec);
              if (design) problem(id, 1, design);
            }
          }
          if (chain || ledgerUnavailable) continue;
          const status = evidenceStatus(id, entity.path, entries);
          if (!status.ok) {
            problem(id, /^no (?:Green|Red)/.test(status.why) ? 2 : 1, status.why);
            continue;
          }
          const hashes = new Set(), reds = new Map();
          let latest = null, matching = null;
          for (const entry of entries.filter(entry => entry.test === id)) {
            if (entry.type === 'red') { reds.set(entry.fileSha, entry); continue; }
            if (!['green', 'refactor'].includes(entry.type)) continue;
            const current = shaMatches(entry.fileSha, entity.path, id);
            if (entry.type === 'green') {
              latest = { green: entry, red: reds.get(entry.fileSha) };
              if (current) matching = latest;
            }
            const pair = matching ?? latest;
            if (!current || !pair?.red || changedArtifacts(entry).length
              || Object.entries(entry.reqShas ?? { [entry.req]: entry.reqSha })
                .some(([req, hash]) => hash && reqShaOf(req) && !reqShaSame(req, hash))) continue;
            [pair.red.hash, pair.green.hash, entry.hash].forEach(hash => hashes.add(hash));
          }
          events.push({ test: id, hashes: [...hashes].sort() });
        }
        for (const req of task.reqs) if (!task.tests.some(id => ents.get(id)?.refs.verifies.includes(req))) {
          problem(req, 2, 'Required native REQ/TEST mapping is unavailable');
        }
      } catch (error) {
        if (error instanceof PlanningError) problem(error.id, error.exit, error.message);
        else if (error.code) problem(task.id, 2, `Native evidence input unavailable (${error.code})`);
        else throw error;
      }
      return { bindings, events, errors };
    };
    return { ...loaded, adapter: { inspect, nativeChecks, run(argv, timeoutMs) {
      const result = run1(argv, timeoutMs, '.', 8388609);
      if (argv[1] === nativeScript && argv[2] === 'tdd' && result.exit === 2 && !result.error) {
        result.error = 'Native verification is incomplete (exit 2)';
      }
      return result;
    } } };
  } catch (error) { return planningRefusal(error, 'structure'); }
}

/** @id CODE-GATESNAPSHOT-001 @implements REQ-GATESNAPSHOT-001 */
function cmdGate() {
  const lines = [];
  if (flags.changed && typeof flags.baseline === 'string' && spawnSync('git', ['rev-parse', '--verify', '--quiet', flags.baseline + '^{commit}'], { cwd: ROOT }).status !== 0) {
    out(`REFUSED: --baseline ${flags.baseline} is not a git ref; gate --changed --baseline <ref> diffs against it`);
    return 2;
  }
  if (flags.changed && (changedSnap = changedFiles()) === null) {
    lines.push('! Git change discovery unavailable — falling back to full evidence and checks');
    flags.changed = false;
  }
  let fail = false;
  let incomplete = false;
  const add = (ok, msg, extra = []) => { lines.push(`${ok ? '✓' : '✗'} ${msg}`); extra.forEach((x) => lines.push(`    ${x}`)); if (!ok) fail = true; };

  const specs = loadSpecs();
  const { ents, dups } = scanEntities(listFiles());
  const cfg = loadConfig();
  const planning = planningSession(specs, { ents, dups });
  if (planning.exit) return emitPlanningResult({ ...planning, stage: 'gate' }, flags.json);
  let planningDecision = null, planningIds = null;
  const inputSnapshot = flags['no-run'] ? null : gateInputSnapshot(specs, ents, cfg);
  let inputsStable = true;
  const checkInputs = (stage) => {
    const changed = changedGateInputs(inputSnapshot, cfg);
    if (changed.length) {
      add(false, `gate inputs changed after ${stage}: ${changed.slice(0, 6).join(', ')}${changed.length > 6 ? `, … +${changed.length - 6}` : ''} — validated evidence no longer describes the checked files; restore inputs and re-record Red→Green`);
      if (cfg.prepare) fs.rmSync(PREPARE_CACHE, { force: true });
      inputsStable = false;
    }
    return inputsStable;
  };
  if (!specs.length) { lines.push('! spec: none in .sdd/specs — T0 changes need no gate; for T1/T2 write .sdd/specs/<feature>.md (result is INCOMPLETE)'); incomplete = true; }
  for (const s of specs.filter((x) => x.approval === 'human')) {
    const ap = readJson(APPROVALS, {})[s.feature];
    if (!ap?.code) continue;
    const now = implFileShas(s);
    const changed = Object.keys({ ...ap.code, ...now }).filter((f) => ap.code[f] !== now[f]);
    if (changed.length) lines.push(`! human-approved ${s.feature}: implementation changed since approval (${changed.slice(0, 4).join(', ')}${changed.length > 4 ? ', …' : ''}) — a human should re-review, then approve record`);
  }
  for (const s of specs.filter(needsLock)) { const st = approvalState(s); const ap = readJson(APPROVALS, {})[s.feature]; add(st === 'ok', `lock ${s.feature}: ${st}${ap ? ` [${ap.kind}${ap.kind === 'ai' ? `, review ${ap.review ? (ap.reviewSha ? 'file' : 'summary') : 'none'}` : ''}]` : ''}${s.approval === 'human' ? ' (human required)' : ''}${lockDrift(s) ? ` (policy loosened: ${lockDrift(s)} — human re-approval needed)` : ''}`); const dp = designProblem(s); if (dp) add(false, `design ${s.feature}: missing`, [dp]); }
  for (const [f, a] of Object.entries(readJson(APPROVALS, {}))) if (!specs.some((s) => s.feature === f) && (a.tier === 'T2' || a.requireHuman)) add(false, `lock ${f}: spec removed`, [`a locked ${a.tier === 'T2' ? 'T2' : 'human'} spec disappeared — if intended: approve retire ${f} --by <human name>`]);

  {
    const live = new Set(specs.flatMap((x) => x.reqs.map((q) => q.id))), retired = readJson(RETIRED_REQS, {});
    const gone = [...new Set(readLedger().filter((e) => e.type === 'green').flatMap((e) => [e.req, ...Object.keys(e.reqShas ?? {})]).filter((r) => r && !live.has(r) && !retired[r]))];
    for (const r of gone) {
      const msg = `req ${r}: has Green evidence but no longer exists in any spec — if the removal is intended: approve retire ${r} --by <human name>; otherwise restore the REQ`;
      if (readJson(CONFIG, {}).scopePolicy === 'strict') add(false, `${msg} (scopePolicy strict)`); else lines.push(`! ${msg} (scopePolicy warn: set "scopePolicy": "strict" to fail)`);
    }
  }
  const t = applyBaseline(traceCheck(ents, dups, specs));
  add(!t.errors.length, `trace: ${[...t.reqs.values()].filter((r) => !r.deferred).length} REQ${[...t.reqs.values()].some((r) => r.deferred) ? ` (+${[...t.reqs.values()].filter((r) => r.deferred).length} deferred, not tested: ${[...t.reqs.values()].filter((r) => r.deferred).map((r) => r.id).join(', ')})` : ''}, ${t.errors.length} errors${t.warnings.length ? `, ${t.warnings.length} warnings` : ''}`, [...t.errors.slice(0, 6), ...t.warnings.slice(0, flags.verbose ? t.warnings.length : 3).map((w) => `warning: ${w}`), ...(t.warnings.length > 3 && !flags.verbose ? [`… +${t.warnings.length - 3} more warnings (all: trace --verbose)`] : [])]);

  const entries = readLedger();
  const chain = verifyChain(entries);
  add(!chain, `ledger: ${chain ?? `${entries.length} entries, chain intact`}`);

  // a declared config `artifacts` file missing from disk (never created, or deleted in the diff) is an error in full and --changed gates (#320)
  const goneArt = Object.keys(loadConfig().artifacts ?? {}).filter((a) => !fs.existsSync(path.join(ROOT, normDep(a))));
  for (const a of goneArt) add(false, `artifact ${a}: declared in .sdd/config.json artifacts but missing from disk`, ['restore it, or remove the entry from `artifacts` if it was removed on purpose']);

  let relevant = new Set([...t.reqs.keys()]);
  if (flags.changed) {
    const ch = changedFiles();
    relevant = new Set();
    for (const e of ents.values()) if (ch.has(e.path)) [...e.refs.implements, ...e.refs.verifies].forEach((r) => relevant.add(r));
    for (const s of specs) if (ch.has(s.path)) s.reqs.forEach((r) => relevant.add(r.id));
    // a changed non-code artifact (contract/data file): its consumers' REQs are in scope (#254)
    const known = new Set([...ents.values()].map((e) => e.path));
    const art = [...ch].filter((f) => !EXT.test(f) && !known.has(f) && !f.startsWith('.sdd/') && fs.existsSync(path.join(ROOT, f)));
    if (art.length) {
      const rv = importRev(), seen = new Set(art), q = [...art];
      while (q.length) for (const d of rv.get(q.shift()) ?? []) if (!seen.has(d)) { seen.add(d); q.push(d); }
      for (const e of ents.values()) if (seen.has(e.path)) [...e.refs.implements, ...e.refs.verifies].forEach((r) => relevant.add(r));
    }
    // evidence made stale by a changed oracle file (e.g. a contract named only in dependsOn) belongs to the changed scope too
    for (const e of ents.values()) if (e.kind === 'TEST') { const last = entries.filter((x) => x.test === e.id && (x.type === 'green' || x.type === 'refactor')).at(-1); if (changedOracleDeps(last, e.path, e.id).some((f) => ch.has(f))) [...e.refs.verifies].forEach((r) => relevant.add(r)); }
    // a REQ edited in an already-committed spec is still stale evidence (#70)
    for (const e of ents.values()) if (e.kind === 'TEST') for (const r of e.refs.verifies) if (!relevant.has(r) && /changed in the spec/.test(evidenceStatus(e.id, e.path, entries).why ?? '')) relevant.add(r);
  }
  if (planning.enabled) {
    try { planningIds = planningTaskScope(planning.model, {
      changed: flags.changed ? changedFiles() : null, relevant, impactOne }); }
    catch (error) { return emitPlanningResult(planningRefusal(error, 'gate'), flags.json); }
    planningDecision = publicPlanningResult(evaluateImplementationPlan({ model: planning.model,
      adapter: planning.adapter, stage: 'gate', taskIds: planningIds }));
    if (planningDecision.exit === 1) add(false, 'planning: FAIL', planningDecision.errors.map(error => `${error.id}: ${error.reason}`));
    else if (planningDecision.exit === 2) {
      incomplete = true;
      lines.push('! planning: INCOMPLETE', ...planningDecision.errors.map(error => `    ${error.id}: ${error.reason}`));
    } else lines.push('✓ planning: PASS');
  }
  const problems = [];
  let covered = 0;
  let weak = 0;
  const weakIds = [], suspectIds = [];
  let charac = 0;
  let retestN = 0, retestSupersededN = 0;
  const blessedIds = [];
  const retestIds = [];
  let total = 0;
  const seenTests = new Set();
  for (const id of relevant) {
    const r = t.reqs.get(id);
    if (!r || r.deferred) continue;
    for (const e of ents.values()) {
      if (e.kind !== 'TEST' || !e.refs.verifies.includes(id) || seenTests.has(e.id)) continue;
      seenTests.add(e.id);
      total++;
      const s = evidenceStatus(e.id, e.path, entries);
      if (s.ok) { covered++; if (s.weak) { weak++; if (s.suspect) suspectIds.push(e.id); if (!s.charac && !s.retest) weakIds.push(e.id); } if (s.charac) charac++; if (s.blessed) blessedIds.push(e.id); if (s.retest) { retestN++; retestIds.push(e.id); if (s.retestSuperseded) retestSupersededN++; } } else problems.push(`${e.id} (${id}): ${s.why}`);
    }
  }
  add(!problems.length, `tdd evidence${flags.changed ? ' (changed scope)' : ''}: ${covered}/${total} tests Red→Green${weak > charac ? `, ${weak - charac} weak Red${weak > charac + retestN ? ' — Red came from setup/load, not the asserted behaviour (before implementing: `tdd red <ID> --expect <text>`; after Green: keep as weak, or temporarily break the implementation to re-record Red): ' + weakIds.slice(0, 8).join(', ') + (weakIds.length > 8 ? `, … +${weakIds.length - 8}` : '') : ''}` : ''}${suspectIds.length ? ` (${suspectIds.length} suspect Red — heuristic setup-call classification, not blocking; audit: ${suspectIds.slice(0, 8).join(', ')}${suspectIds.length > 8 ? `, … +${suspectIds.length - 8}` : ''}; each is accepted as-is with \`tdd red <ID> --allow-setup-red\`)` : ''}${charac ? `${weak > charac ? '' : ','} ${charac} characterization (passed without a failing Red; not a weak Red)` : ''}${retestN ? ` (${retestN} retest: Red re-recorded with --retest, passed without a failing Red${retestSupersededN ? `; ${retestSupersededN} superseded an earlier strong Red — re-record a failing Red by temporarily breaking the implementation if that evidence matters` : ''}: ${retestIds.slice(0, 8).join(', ')}${retestIds.length > 8 ? `, … +${retestIds.length - 8}` : ''})` : ''}${blessedIds.length ? ` (${blessedIds.length} refactor-recorded after the test/setup changed, no new Red: ${blessedIds.slice(0, 8).join(', ')}${blessedIds.length > 8 ? `, … +${blessedIds.length - 8}` : ''}; to replace that with real evidence: tdd red <ID> --retest "<why>" then tdd green <ID>)` : ''}`, [...problems.slice(0, flags.verbose ? problems.length : 6), ...(problems.length > 6 && !flags.verbose ? [`… +${problems.length - 6} more (all: gate --verbose)`] : [])]);

  // leftover stub placeholders in source owned by a Green REQ (#330)
  {
    const greens = greenReqs(ents), left = [];
    for (const e of ents.values()) {
      if (e.kind === 'TEST' || left.some((x) => x.f === e.path) || !e.refs.implements.some((r) => greens.has(r) && relevant.has(r))) continue;
      let txt = ''; try { txt = fs.readFileSync(path.join(ROOT, e.path), 'utf8'); } catch { /* removed */ }
      const n = txt.split('\n').findIndex((l) => /SDD-TODO\(stub\)|['"`]not implemented: |\bnot implemented: \w/.test(l));
      if (n >= 0) left.push({ f: e.path, line: n + 1 });
    }
    if (left.length) {
      const msg = `stub: ${left.length} source file(s) of Green REQs still hold SDD-TODO(stub) / 'not implemented:' placeholders: ${left.slice(0, 4).map((x) => `${x.f}:${x.line}`).join(', ')}${left.length > 4 ? ', …' : ''} — implement or remove them`;
      if (loadConfig().scopePolicy === 'strict') add(false, `${msg} (scopePolicy strict)`); else lines.push(`! ${msg} (scopePolicy warn: set "scopePolicy": "strict" to fail)`);
    }
  }
  if (cfg.prepare && !flags['no-run']) {
    const pc = cfg.prepare;
    const cache = readJson(PREPARE_CACHE, {});
    const key = prepareKey(pc);
    const outsOk = (pc.outputs ?? []).every((o) => fs.existsSync(path.join(ROOT, o)));
    if (cache.key === key && outsOk) lines.push('✓ prepare: up to date (cached, inputs unchanged)');
    else {
      const r = run(pc.cmd, pc.timeoutMs ?? 1800000);
      checkInputs('prepare');
      if (r.exit === 0) { if (inputsStable) writeJson(PREPARE_CACHE, { key, at: new Date().toISOString() }); add(true, `prepare (${(r.ms / 1000).toFixed(1)}s)`); }
      else add(false, r.timedOut ? `prepare TIMEOUT after ${(r.ms / 1000).toFixed(0)}s (raise prepare.timeoutMs)` : `prepare failed (${(r.ms / 1000).toFixed(1)}s)`, r.timedOut ? [] : tail(r.text, 8).split('\n'));
    }
  }
  if (flags.changed && inputsStable) {
    const chg = changedFiles();
    const specFeatures = new Set(loadSpecs().filter((sp) => chg.has(sp.path) || [...chg].some((c) => c.replace(/^\.\//, '') === sp.path)).map((sp) => sp.feature));
    const specImpl = specFeatures.size ? [...scanEntities(listFiles()).ents.values()].filter((e) => e.refs.implements.some((r) => loadSpecs().some((sp) => specFeatures.has(sp.feature) && sp.reqs.some((q) => q.id === r)))).map((e) => e.path) : [];
    const x = crossImpact(new Set([...chg, ...specImpl]));
    const xf = [...new Set(x.map((o) => o.feature))];
    if (x.length) lines.push(`! changed files/specs are imported by other feature(s): ${xf.join(', ')} (${x.slice(0, 4).map((o) => o.req).join(', ')}${x.length > 4 ? ', …' : ''}) — their evidence is not re-checked here; run a full gate (or \`impact <file>\`)`);
  }
  // dependsOn is transitive: a project depending on another project's root (or a path under it) also depends on that project's dependsOn (#241)
  const depClosure = (p) => {
    const out = new Set((p.dependsOn ?? []).map(normDep));
    for (let grew = true; grew;) { grew = false; for (const q of cfg.projects ?? []) { const qr = normDep(q.root); if (q !== p && [...out].some((x) => x === qr || x.startsWith(qr + '/'))) for (const d of q.dependsOn ?? []) if (!out.has(normDep(d))) { out.add(normDep(d)); grew = true; } } }
    return [...out];
  };
  // a changed config `artifacts` file is in scope for the project that holds one of its consumers (#308)
  // a root Cargo.toml/Cargo.lock of a workspace whose members live under a project dir belongs to that project (#308)
  const cargoOwned = cargoMembersOf;
  // a root manifest/lockfile/toolchain file widens to every project of that ecosystem (design 3.1)
  // a lockfile in a workspace sub-root widens like the root one, to the projects under that dir (#327)
  const NESTED_LOCK = /^(Cargo\.lock|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|uv\.lock|poetry\.lock|Pipfile\.lock)$/;
  const widenOwned = (f) => { const dir = path.posix.dirname(f), nested = dir !== "." && NESTED_LOCK.test(path.posix.basename(f)); const w = WORKSPACE_ROOT.find(([re]) => re.test(nested ? path.posix.basename(f) : f)); return w ? (cfg.projects ?? []).filter((p) => (!nested || normDep(p.root) === dir || normDep(p.root).startsWith(dir + "/")) && w[1].some((m) => m instanceof RegExp ? (fs.existsSync(path.join(ROOT, p.root)) && fs.readdirSync(path.join(ROOT, p.root)).some((x) => m.test(x))) : fs.existsSync(path.join(ROOT, p.root, m)))).map((p) => normDep(p.root)) : []; };
  // projects that dependsOn (transitively) a package rebuilt by a root manifest change are consumers too (#322)
  const withDependents = (roots) => [...roots, ...(cfg.projects ?? []).filter((p) => depClosure(p).some((d) => roots.some((r) => d === r || d.startsWith(r + '/') || r.startsWith(d + '/')))).map((p) => normDep(p.root))];
  const artConsumers = (f) => { const u = Object.entries(cfg.artifacts ?? {}).find(([a]) => normDep(a) === f)?.[1]; const w = [...cargoOwned(f), ...widenOwned(f)]; return [...(u === undefined ? [] : [].concat(u).map(normDep)), ...(w.length ? withDependents(w) : [])]; };
  const scopeCount = { exact: 0, widened: 0, unknown: 0 };
  const explain = [];
  const allChecks = [...(cfg.checks ?? []), ...(cfg.projects ?? []).flatMap((p) => (p.checks ?? []).map((c) => ({ ...c, name: `${p.root}:${c.name}`, cwd: p.root, dependsOn: depClosure(p) })))];
  const rustRuns = [];
  let sharedHinted = false;
  // a changed spec puts the projects holding that feature's tests/code in scope; the project check then runs in full
  const specProjects = new Set();
  if (flags.changed && inputsStable) { const chs = changedFiles(); for (const sp of loadSpecs()) if (chs.has(sp.path)) { const ids = new Set(sp.reqs.map((r) => r.id)); for (const e of ents.values()) if ([...e.refs.implements, ...e.refs.verifies].some((r) => ids.has(r))) for (const p of cfg.projects ?? []) if (e.path.startsWith(normDep(p.root) + '/')) specProjects.add(p.root.replace(/\/$/, '')); } }
  const specOwned = (cwd) => specProjects.has(cwd.replace(/\/$/, ''));
  for (const p of cfg.projects ?? []) for (const dp of p.dependsOn ?? []) if (!fs.existsSync(path.join(ROOT, normDep(dp)))) lines.push(`! config: project ${p.root} dependsOn "${dp}" does not exist on disk — contract changes will not trigger its checks (typo?)`);
  if (flags['no-run']) { lines.push('! commands: SKIPPED (--no-run) — result is INCOMPLETE'); incomplete = true; }
  else if (inputsStable) {
  // root-owned files no project depends on: hint once, also when the root has no checks of its own (#67)
  if (flags.changed && (cfg.projects ?? []).length) {
    const pr = cfg.projects.map((p) => p.root.replace(/\/$/, '') + '/');
    const coveredBy = (f) => artConsumers(f).some((u) => pr.some((r) => (u + '/').startsWith(r))) || cfg.projects.some((p) => depClosure(p).some((d) => { const x = normDep(d); return f === x || f.startsWith(x + '/'); }));
    const dataOnly = [...changedFiles()].filter((f) => !f.startsWith('.sdd/') && !pr.some((r) => f.startsWith(r)) && !EXT.test(f) && !coveredBy(f));
    if (dataOnly.length) { sharedHinted = true; lines.push(`! root-owned data/config changes: ${dataOnly.slice(0, 3).join(', ')}${dataOnly.length > 3 ? ', …' : ''} — if a project reads these, add the path to its \`dependsOn\` in .sdd/config.json so that project's checks run too`); }
  }
  // a project reached only through dependsOn of a widened package with no check of its own is never re-verified (#322)
  if (flags.changed) {
    const unver = new Set();
    for (const f of changedFiles()) { const w = [...cargoOwned(f), ...widenOwned(f)]; if (w.length) for (const r of withDependents(w).slice(w.length)) { const p = (cfg.projects ?? []).find((q) => normDep(q.root) === r); if (p && !(p.checks ?? []).length) unver.add(r); } }
    if (unver.size) { lines.push(`! project(s) ${[...unver].join(', ')} dependsOn a package rebuilt by a root manifest change but have no check — not re-verified, result is INCOMPLETE (add checks to the project)`); incomplete = true; }
  }
  for (const c of allChecks) {
    let cmd = c.cmd;
    const base = c.cwd ? c.cwd.replace(/\/$/, '') + '/' : '';
    const inDeps = (f) => (c.dependsOn ?? []).some((d) => { const x = normDep(d); return f === x || f.startsWith(x + '/'); }) || (!!base && artConsumers(f).some((u) => (u + '/').startsWith(base)));
    const note = (scope) => {
      if (!flags.explain || !flags.changed) return;
      const chg = [...changedFiles()].filter((f) => !f.startsWith('.sdd/'));
      const closure = c.cwd ? [c.cwd.replace(/\/$/, ''), ...(c.dependsOn ?? []).map(normDep)] : chg;
      const why = (f) => specOwned(c.cwd ?? '') && c.cwd ? 'claimed: changed spec owns this project' : base && f.startsWith(base) ? `claimed: under ${c.cwd}` : (c.dependsOn ?? []).some((d) => { const x = normDep(d); return f === x || f.startsWith(x + '/'); }) ? 'claimed: dependsOn' : base && artConsumers(f).some((u) => (u + '/').startsWith(base)) ? 'claimed: artifact/workspace-root consumer' : c.cwd ? 'not claimed by this check' : 'claimed: root check covers it';
      explain.push({ check: c.name, scope, closureSize: closure.length, closure: closure.slice(0, 10), files: chg.map((f) => ({ file: f, why: why(f) })) });
    };
    if (c.cwd && flags.changed && !specOwned(c.cwd) && ![...changedFiles()].some((f) => f.startsWith(base) || inDeps(f))) { lines.push(`! cmd ${c.name}: no changed files in ${c.cwd}${c.dependsOn?.length ? ` or its dependencies (${c.dependsOn.join(', ')})` : ''} — skipped (input closure: ${c.cwd} + ${(c.dependsOn ?? []).length} dependsOn, disjoint from ${changedFiles().size} changed path(s))`); note('skipped'); continue; }
    const pRoots = (cfg.projects ?? []).map((p) => p.root.replace(/\/$/, '') + '/');
    if (!c.cwd && flags.changed && pRoots.length) {
      const chg = [...changedFiles()].filter((f) => !f.startsWith('.sdd/'));
      const outside = chg.filter((f) => !pRoots.some((r) => f.startsWith(r)));
      const testLike = /\b(?:tests?|spec|jest|vitest|pytest|mocha|unit)\b/i.test(`${c.name} ${(c.cmd ?? []).join(' ')}`);
      // skipping the root test check is only safe if the touched nested projects run checks of their own (r25b)
      const bare = chg.length && !outside.length && testLike ? (cfg.projects ?? []).filter((p) => !(p.checks ?? []).length && chg.some((f) => f.startsWith(p.root.replace(/\/$/, '') + '/'))).map((p) => p.root.replace(/\/$/, '') + '/') : [];
      if (bare.length) {
        const bmsg = `cmd ${c.name}: root test check skipped but nested project ${bare.join(', ')} has no check of its own — nothing verifies these changes (add checks to the project, or run the root check)`;
        if (cfg.scopePolicy === 'strict') add(false, `${bmsg} (scopePolicy strict)`); else lines.push(`! ${bmsg} (scopePolicy warn: set "scopePolicy": "strict" to fail)`);
      }
      if (chg.length && !outside.length && testLike) { lines.push(`! cmd ${c.name}: all changed files are inside nested projects (${pRoots.filter((r) => chg.some((f) => f.startsWith(r))).join(', ')}) — root test check skipped`); continue; }
      if (chg.length && !outside.length) lines.push(`! cmd ${c.name}: changes are inside nested projects but this root check is workspace-wide tooling — running it`);
    }
    const ownChanged = !flags.changed || !base || [...changedFiles()].some((f) => f.startsWith(base));
    let scoped = false;
    let widened = false;
    if (flags.changed && c.changedCmd && ownChanged) {
      const ch = [...changedFiles()].filter((f) => !f.startsWith('.sdd/') && fs.existsSync(path.join(ROOT, f)) && fs.statSync(path.join(ROOT, f)).isFile());
      const tests = ch.filter((f) => /\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]*\.py$|_test\.(py|go|exs)$/.test(f));
      // a deletion is a change: the check must run in full, not skip as "no changed files" (r25b)
      const gone = [...changedFiles()].filter((f) => !f.startsWith('.sdd/') && !fs.existsSync(path.join(ROOT, f)) && (!base || f.startsWith(base)));
      if (!ch.length && !gone.length) { lines.push(`! cmd ${c.name}: no changed files (input closure computed from ${changedFiles().size} changed path(s): none is an existing non-.sdd file) — skipped`); note('skipped'); continue; }
      const scopes = [...new Set(ch.filter((f) => !tests.includes(f)).map((f) => /^(packages|apps|libs)\/[^/]+/.exec(f)?.[0] ?? path.posix.dirname(f)))];
      const rel2 = relatedTests(ch);
      const limit = c.hubThreshold ?? cfg.hubThreshold ?? 0.25;
      if (c.hubFallbackCmd && rel2.total >= (c.minHubTests ?? cfg.minHubTests ?? 10) && rel2.tests.length / rel2.total > limit) {
        lines.push(`! cmd ${c.name}: hub change (${rel2.tests.length}/${rel2.total} test files depend on it) — using hubFallbackCmd`);
        const srcChanged = ch.filter((f) => /\.[cm]?[jt]sx?$/.test(f) && !TEST_FILE.test(f));
        const infos = srcChanged.map(changedSymbols);
        if (srcChanged.length && infos.every((x) => x?.neutral) && !tests.length) { lines.push(`! cmd ${c.name}: hub change is comment/whitespace-only (symbol-neutral) — skipped`); continue; }
        if (srcChanged.length && infos.every((x) => x && (x.neutral || x.symbols))) {
          const syms = [...new Set(infos.flatMap((x) => x.symbols ? [...x.symbols] : []))];
          rel2.direct = syms.length ? symbolReach(syms, rel2.files) : [];
          lines.push(`! cmd ${c.name}: scoped by changed symbols (${syms.slice(0, 5).join(', ')}${syms.length > 5 ? ', …' : ''}) → ${rel2.direct.length} test files`);
        }
        const maxN = c.hubMaxTests ?? cfg.hubMaxTests ?? 30;
        if (new Set([...tests, ...rel2.direct]).size > maxN) { lines.push(`! cmd ${c.name}: hub too large to scope (>${maxN} direct tests) — SKIPPED, run full gate (no --changed) — result is INCOMPLETE`); incomplete = true; continue; }
        if (!new Set([...tests, ...rel2.direct]).size) { lines.push(`! cmd ${c.name}: scoping selected no tests — SKIPPED, run full gate (no --changed) — result is INCOMPLETE`); incomplete = true; continue; }
        cmd = c.hubFallbackCmd;
      } else cmd = c.changedCmd;
      const rp = (arr) => base ? arr.filter((f) => f.startsWith(base)).map((f) => f.slice(base.length)) : arr;
      let noScope = false;
      const absBase = path.resolve(ROOT, c.cwd ?? '.');
      const scopeVals = {};
      for (const [tok, fn] of Object.entries(SCOPE_TOKENS)) {
        if (!c.changedCmd.includes(tok)) continue;
        const v = fn(rp(ch), absBase);
        const arr = Array.isArray(v) ? v : [v];
        if (!arr.length || (arr.length === 1 && !arr[0])) {
          // single-module Maven project: the root is the only module, so the full check is the scoped check (#81)
          const single = tok === '{changedModulesCsv}' && fs.existsSync(path.join(absBase, 'pom.xml')) && !/<modules>/.test(fs.readFileSync(path.join(absBase, 'pom.xml'), 'utf8'));
          if (!single) lines.push(`! cmd ${c.name}: cannot scope changes for ${tok === '{changedCargoPkgs}' ? 'the changed Cargo packages (Cargo.toml/Cargo.lock changed, a file outside any package, or `cargo metadata --offline` failed — e.g. a new, not-yet-resolved crate)' : tok} — running the full check${hasCommit() ? '' : ' (this repo has no commit yet: make an initial commit so `--changed` has a baseline)'}`); cmd = c.cmd; noScope = true; break;
        }
        scopeVals[tok] = arr;
      }
      const subst = { ...scopeVals, '{changedFiles}': rp(ch), '{changedTests}': rp(tests), '{changedScopes}': base ? [...new Set(rp(scopes))] : scopes, '{directTests}': rp(rel2.direct) };
      if (!noScope) cmd = cmd.flatMap((a) => subst[a] ?? [a]);
      if (!noScope && Object.keys(scopeVals).length) lines.push(`! cmd ${c.name}: scoped → ${cmd.join(' ').slice(0, 200)}`);
      scoped = !noScope;
      if (!ch.length) { lines.push(`! cmd ${c.name}: only deleted files changed (${gone.slice(0, 3).join(', ')}${gone.length > 3 ? ', …' : ''}) — running the full check`); cmd = c.cmd; scoped = false; widened = true; }
    }
    const cargoOutputCmd = (args) => {
      if (path.basename(args[0] ?? '') !== 'cargo' || !args.includes('test') || ![...ents.values()].some((e) => e.kind === 'TEST' && /\.rs$/.test(e.path)) || args.some((a) => /^--message-format(?:=|$)/.test(a))) return args;
      const at = args.indexOf('--');
      return [...args.slice(0, at < 0 ? args.length : at), '--message-format=json', ...(at < 0 ? [] : args.slice(at))];
    };
    let r = run(cargoOutputCmd(cmd), scoped ? (c.changedTimeoutMs ?? cfg.changedTimeoutMs ?? 60000) : (c.timeoutMs ?? cfg.timeoutMs ?? 120000), c.cwd);
    if (!checkInputs(`check ${c.name}`)) break;
    // a scoped run that executed no tests (e.g. `vitest related data.json`) proves nothing: run the full check instead
    if (scoped && r.exit === 0 && !r.timedOut && ((ZERO_TESTS.test(r.text) && !RAN_TESTS.test(r.text)) || NO_PASSED.test(r.text) || pytestNoExecution(r.text) || noExecution(r.text))) {
      lines.push(`! cmd ${c.name}: scoped run matched no tests — running the full check instead`);
      scoped = false;
      widened = true;
      cmd = c.cmd;
      r = run(cargoOutputCmd(cmd), c.timeoutMs ?? cfg.timeoutMs ?? 120000, c.cwd);
      if (!checkInputs(`check ${c.name} full fallback`)) break;
    }
    const cargoTest = /(?:^|\s)cargo(?:\s+\+\S+)?\s+test(?:\s|$)/.test(cmd.join(' ')) || /(^|:)test$/.test(c.name) || /test result: \w+\.\s*\d+ passed;/.test(r.text);
    if (cargoTest && [...checkDefClosure({ checks: [{ ...c, cmd, changedCmd: undefined, hubFallbackCmd: undefined }] }).keys()].some((k) => /(?:^|\|)Cargo\.toml$|\/Cargo\.toml$/.test(k))) rustRuns.push({ c, cmd, scoped, r });
    if (flags.changed) note(scoped || (!widened && !c.changedCmd && base && [...changedFiles()].some((f) => f.startsWith(base))) ? 'exact' : 'widened');
    if (flags.changed) scopeCount[scoped || (!widened && !c.changedCmd && base && [...changedFiles()].some((f) => f.startsWith(base))) ? 'exact' : 'widened']++;
    if (r.timedOut) { add(false, `cmd ${c.name} TIMEOUT after ${(r.ms / 1000).toFixed(0)}s ${scoped ? '— narrow changedCmd (e.g. {changedTests} {changedScopes}) or raise changedTimeoutMs; run full gate (no --changed) before merge' : '— raise timeoutMs in .sdd/config.json'}`); continue; }
    if (r.exit === 0 && r.pytestResults?.some((x) => x.outcome === 'failed')) { add(false, `cmd ${c.name}: pytest reported failed tests despite a successful runner exit`, failTail(r.text, 8).split('\n')); continue; }
    if (r.exit === 0 && (NO_PASSED.test(r.text) || pytestNoExecution(r.text) || noExecution(r.text) || (r.pytestResults && !r.pytestResults.some((x) => /^(passed|failed)$/.test(x.outcome))))) { lines.push(`! cmd ${c.name}: ${ZERO_TESTS.test(r.text) && !NO_PASSED.test(r.text) || r.pytestResults?.length === 0 ? 'no tests found or ran' : 'all tests skipped/todo/xfail'} — INCOMPLETE, no passing assertions`); incomplete = true; continue; }
    const missingIds = missingPytestIds(r, cmd, c.cwd, ents);
    if (missingIds.length) { add(false, `cmd ${c.name}: ${missingIds.join(', ')} missing executed pytest test ids`); continue; }
    const missingNode = missingNodeIds(r, cmd, c.cwd, ents);
    if (missingNode.length && r.exit === 0) { add(false, `cmd ${c.name}: ${missingNode.join(', ')} missing executed Node test ids (unobservable/skipped/todo results cannot verify evidence)`); continue; }
    if (r.exit !== 0 && ZERO_TESTS.test(r.text) && !RAN_TESTS.test(r.text)) { lines.push(`! cmd ${c.name}: no tests exist yet (runner exit ${r.exit}) — INCOMPLETE, not a failure`); incomplete = true; continue; }
    // a failed test check is re-run (flaky.retries, default 1): a pass on re-run is reported as "flaky suspected", never as a plain pass (#303)
    if (r.exit !== 0 && /(^|:)test$/.test(c.name)) {
      const retries = Math.max(0, Number.isInteger(cfg.flaky?.retries) ? cfg.flaky.retries : 1);
      const warnOnly = cfg.flaky?.policy === 'warn';
      for (let i = 0; i < retries; i++) {
        const r2 = run(cargoOutputCmd(cmd), scoped ? (c.changedTimeoutMs ?? cfg.changedTimeoutMs ?? 60000) : (c.timeoutMs ?? cfg.timeoutMs ?? 120000), c.cwd);
        if (!checkInputs(`check ${c.name} retry ${i + 1}`)) break;
        if (rustRuns.some((x) => x.c === c)) rustRuns.push({ c, cmd, scoped, r: r2 });
        if (r2.exit === 0 && !r2.timedOut && !NO_PASSED.test(r2.text) && !pytestNoExecution(r2.text) && !noExecution(r2.text) && (!r2.pytestResults || (r2.pytestResults.some((x) => x.outcome === 'passed') && !r2.pytestResults.some((x) => x.outcome === 'failed'))) && !missingPytestIds(r2, cmd, c.cwd, ents).length && !missingNodeIds(r2, cmd, c.cwd, ents).length) {
          add(warnOnly, `cmd ${c.name} FLAKY suspected: failed on the first run, passed on re-run ${i + 1}/${retries} (${(r2.ms / 1000).toFixed(1)}s) — a flaky entry was appended to .sdd/tdd.jsonl (commit it)${warnOnly ? ' — accepted by flaky.policy "warn"' : ' — set flaky.policy "warn" in .sdd/config.json to accept, or fix the test (no sleep, injected clock, port 0, generous timeouts)'}`, failTail(r.text, 8).split('\n'));
          appendLedger({ type: 'flaky', check: c.name, retry: i + 1, retries, policy: warnOnly ? 'warn' : 'fail', outcome: warnOnly ? 'accepted' : 'fail' });
          inputSnapshot.set(rel(LEDGER), gatePathSha(rel(LEDGER)));
          r = null;
          break;
        }
      }
      if (!inputsStable) break;
      if (!r) continue;
    }
    add(r.exit === 0, `cmd ${c.name} (${(r.ms / 1000).toFixed(1)}s)`, r.exit === 0 ? [] : failTail(r.text, 8).split('\n'));
  }
  }
  if (!flags['no-run'] && inputsStable) for (const error of rustGateExecution(ents, cfg, rustRuns)) add(false, error);
  if (!flags['no-run'] && !allChecks.length) { lines.push('! commands: none configured — nothing was run'); incomplete = true; }

    if (!flags.changed) {
      // full gate: compare with the HEAD version of the config (untracked or unchanged = nothing to report) (#331)
      const bs = spawnSync('git', ['show', 'HEAD:./.sdd/config.json'], { cwd: ROOT, encoding: 'utf8' });
      let bc = null;
      try { bc = bs.status === 0 ? JSON.parse(bs.stdout) : null; } catch { /* unparsable baseline */ }
      const weak = bc && typeof bc === 'object' ? cfgRunLoosening(bc, cfg) : [];
      if (weak.length) {
        const wm = `config: .sdd/config.json loosens what the gate runs vs HEAD: ${weak.join('; ')}`;
        if (bc.scopePolicy === 'strict' && !flags['allow-config-weaken']) add(false, `${wm} (baseline scopePolicy strict; accept with --allow-config-weaken)`);
        else lines.push(`! ${wm}${bc.scopePolicy === 'strict' ? ' (accepted by --allow-config-weaken)' : ''}`);
      }
    }
    if (!flags['no-run'] && inputsStable) {
      // Include new definitions: an added higher-precedence config can narrow the run without changing a recorded file (#333).
      const rec = readLedger().reverse().find((e) => e.checkDefShas)?.checkDefShas;
      if (rec) {
        const cur = checkDefShas(cfg);
        const diff = [...new Set([...Object.keys(rec), ...Object.keys(cur)])].filter((k) => cur[k] !== rec[k]).map((k) => { const [n, f] = k.split('|'); return `check ${n} (${f}${cur[k] === undefined ? ' no longer defines it' : rec[k] === undefined ? ' now defines it' : ' changed'})`; });
        if (diff.length) {
          const msg = `scope: a file defining what a gate check runs differs from the last Green record — ${diff.join('; ')} — the test run may have been narrowed; review the diff, then re-run \`tdd refactor\` to re-record`;
          if (cfg.scopePolicy === 'strict') add(false, `${msg} (scopePolicy strict)`);
          else lines.push(`! ${msg} (scopePolicy warn: set "scopePolicy": "strict" to fail)`);
        }
      }
    }
  const lreg = ledgerRegression(typeof flags.baseline === 'string' ? flags.baseline : 'HEAD');
  if (lreg) add(false, `ledger: ${lreg}`);
  let scopeJson;
  if (flags.changed) {
    const pr = (cfg.projects ?? []).map((p) => normDep(p.root) + '/');
    const flagGlobs = typeof flags['allow-unscoped'] === 'string' ? flags['allow-unscoped'].split(',').map((x) => x.trim()).filter(Boolean) : [];
    const cfgGlobs = [].concat(cfg.unscoped ?? []).map(String);
    const reDefault = SCOPE_IGNORE.map((g) => globRe(g)), reCfg = cfgGlobs.map((g) => globRe(normDep(g))), reFlag = flagGlobs.map((g) => globRe(normDep(g)));
    const hasRoot = (cfg.checks ?? []).length > 0;
    const claimed = (f) => pr.some((r) => f.startsWith(r)) || artConsumers(f).length > 0
      || (cfg.projects ?? []).some((p) => depClosure(p).some((d) => { const x = normDep(d); return f === x || f.startsWith(x + '/'); }))
      || (hasRoot && (!pr.length || (EXT.test(f) && !/\.sh$/.test(f)) || WORKSPACE_ROOT.some(([re]) => re.test(f)) || MANIFESTS.test(f)));
    const unscoped = [];
    const waived = { config: [], flag: [] };
    if (allChecks.length) for (const f of changedFiles()) {
      if (claimed(f) || reDefault.some((re) => re.test(f))) continue;
      if (reFlag.some((re) => re.test(f))) waived.flag.push(f);
      else if (reCfg.some((re) => re.test(f))) waived.config.push(f);
      else unscoped.push(f);
    }
    scopeCount.unknown = unscoped.length;
    const list = (a) => `${a.slice(0, 6).join(', ')}${a.length > 6 ? `, … (+${a.length - 6})` : ''}`;
    // a new source file under a project that carries no @id/@implements is unspecced code (#316)
    const newSrc = [];
    const gs = spawnSync('git', ['status', '--porcelain', '-z', '-uall'], { cwd: ROOT, encoding: 'utf8' });
    const gt = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim();
    if (gs.status === 0) for (const l of gs.stdout.split('\0')) {
      if (!/^(\?\?|A.|.A)/.test(l)) continue;
      const f = path.relative(ROOT, path.resolve(gt, l.slice(3))).split(path.sep).join('/');
      if (!pr.some((r) => f.startsWith(r)) || !EXT.test(f) || /\.sh$/.test(f) || TEST_FILE.test(f) || reDefault.some((re) => re.test(f)) || reCfg.some((re) => re.test(f)) || reFlag.some((re) => re.test(f))) continue;
      try { if (!/@id\s+(CODE|TEST)-|@implements\b|@verifies\b/.test(fs.readFileSync(path.join(ROOT, f), 'utf8'))) newSrc.push(f); } catch { /* unreadable */ }
    }
    if (newSrc.length) {
      const msg = `scope: ${newSrc.length} new source file(s) under a project carry no @id/@implements (not covered by any REQ): ${list(newSrc)} — annotate \`@id CODE-... @implements REQ-...\`, or waive with \`unscoped\` / --allow-unscoped`;
      if (cfg.scopePolicy === 'strict') add(false, `${msg} (scopePolicy strict)`);
      else lines.push(`! ${msg} (scopePolicy warn: set "scopePolicy": "strict" to fail)`);
    }
    // a .sdd/config.json edit that loosens gate strictness vs the baseline (#326)
    const bref = typeof flags.baseline === 'string' ? flags.baseline : 'HEAD';
    const bshow = spawnSync('git', ['show', `${bref}:./.sdd/config.json`], { cwd: ROOT, encoding: 'utf8' });
    if (bshow.status === 0) {
      let bc = null;
      try { bc = JSON.parse(bshow.stdout); } catch { /* unparsable baseline */ }
      if (bc && typeof bc === 'object') {
        const weak = [];
        if (bc.scopePolicy === 'strict' && cfg.scopePolicy !== 'strict') weak.push(`scopePolicy ${JSON.stringify(bc.scopePolicy)} → ${cfg.scopePolicy === undefined ? 'removed' : JSON.stringify(cfg.scopePolicy)}`);
        if (bc.specEditPolicy === 'reapprove' && cfg.specEditPolicy !== 'reapprove') weak.push(`specEditPolicy "reapprove" → ${cfg.specEditPolicy === undefined ? 'removed' : JSON.stringify(cfg.specEditPolicy)}`);
        if (cfg.flaky?.policy === 'warn' && bc.flaky?.policy !== 'warn') weak.push('flaky.policy → "warn"');
        const rt = (c) => (Number.isInteger(c.flaky?.retries) ? c.flaky.retries : 1);
        if (rt(cfg) > rt(bc)) weak.push(`flaky.retries ${rt(bc)} → ${rt(cfg)}`);
        const bu = [].concat(bc.unscoped ?? []).map(String), nu = [].concat(cfg.unscoped ?? []).map(String).filter((g) => !bu.includes(g));
        if (nu.length) weak.push(`unscoped += ${nu.join(', ')}`);
        if (bc.artifactStaleness === true && cfg.artifactStaleness !== true) weak.push('artifactStaleness turned off');
        if (bc.artifactGranularity !== undefined && cfg.artifactGranularity === undefined) weak.push('artifactGranularity removed');
        weak.push(...cfgRunLoosening(bc, cfg));
        if (weak.length) {
          const wm = `config: .sdd/config.json weakens gate strictness vs ${bref}: ${weak.join('; ')}`;
          if (bc.scopePolicy === 'strict' && !flags['allow-config-weaken']) add(false, `${wm} (baseline scopePolicy strict; accept with --allow-config-weaken)`);
          else lines.push(`! ${wm}${bc.scopePolicy === 'strict' ? ' (accepted by --allow-config-weaken)' : ''}`);
        }
      }
    }
    const currentDefs = checkDefClosure(cfg);
    const tree = spawnSync('git', ['ls-tree', '-r', '-z', bref, '--', '.'], { cwd: ROOT, encoding: 'utf8' });
    const modes = new Map((tree.stdout ?? '').split('\0').filter(Boolean).map((s) => [s.slice(s.indexOf('\t') + 1), s.slice(0, 6)]));
    const baselineRead = (f, seen = new Set()) => {
      if (seen.has(f)) return null;
      seen.add(f);
      if (f === '..' || f.startsWith('../') || path.isAbsolute(f)) {
        try { return fs.readFileSync(path.resolve(ROOT, f), 'utf8'); } catch { return null; }
      }
      if (!modes.has(f)) {
        // Installed, ignored package configs have no Git baseline; Green snapshots still protect them.
        if (/(^|\/)node_modules\//.test(f)) { try { return fs.readFileSync(path.resolve(ROOT, f), 'utf8'); } catch { return null; } }
        return null;
      }
      const r = spawnSync('git', ['show', `${bref}:./${f}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 256e6 });
      if (r.status !== 0) return null;
      return modes.get(f) === '120000' ? baselineRead(rel(path.resolve(ROOT, path.dirname(f), r.stdout)), seen) : r.stdout;
    };
    baselineRead.raw = (f, seen = new Set()) => {
      if (seen.has(f)) return null;
      seen.add(f);
      if (!modes.has(f)) {
        if (f === '..' || f.startsWith('../') || path.isAbsolute(f) || /(^|\/)node_modules\//.test(f)) {
          try { return fs.readFileSync(path.resolve(ROOT, f)); } catch { return null; }
        }
        return null;
      }
      const r = spawnSync('git', ['show', `${bref}:./${f}`], { cwd: ROOT, maxBuffer: 256e6 });
      if (r.status !== 0) return null;
      return modes.get(f) === '120000' ? baselineRead.raw(rel(path.resolve(ROOT, path.dirname(f), r.stdout.toString())), seen) : r.stdout;
    };
    const baselineDefs = checkDefClosure(cfg, baselineRead, [...modes.keys()]);
    const recordedDefs = readLedger().reverse().find((e) => e.checkDefShas)?.checkDefShas ?? {};
    const defs = [...new Set([...currentDefs.keys(), ...baselineDefs.keys(), ...Object.keys(recordedDefs)])]
      .filter((k) => {
        if (k.startsWith('environment:msvc|')) return currentDefs.get(k)?.sha !== recordedDefs[k];
        const f = k.slice(k.indexOf('|') + 1);
        const external = f === '..' || f.startsWith('../') || path.isAbsolute(f);
        const installed = /(^|\/)node_modules\//.test(f);
        const recordedExecutable = k.startsWith('executable:') && Object.keys(recordedDefs).some((r) => r.split('|')[0] === k.split('|')[0]);
        const baseline = modes.has(f) ? baselineDefs.get(k)?.sha : recordedDefs[k]
          ?? ((external && !recordedExecutable) || installed ? baselineDefs.get(k)?.sha : undefined);
        return tree.status === 0 && currentDefs.get(k)?.sha !== baseline;
      })
      .map((k) => (currentDefs.get(k) ?? baselineDefs.get(k))?.label ?? `check ${k.split('|')[0]} (${k.slice(k.indexOf('|') + 1)} removed)`);
    if (defs.length) {
      const msg = `scope: a changed file defines what a gate check runs — ${defs.join('; ')} — the test run may have been narrowed; review the diff`;
      if (cfg.scopePolicy === 'strict') add(false, `${msg} (scopePolicy strict)`);
      else lines.push(`! ${msg} (scopePolicy warn: set "scopePolicy": "strict" to fail)`);
    }
    if (unscoped.length) {
      const strict = cfg.scopePolicy === 'strict';
      const msg = `scope: ${unscoped.length} changed file(s) not claimed by any check/project: ${list(unscoped)} — add them to a project/dependsOn, or waive with \`unscoped\` in .sdd/config.json / --allow-unscoped <glob>`;
      if (strict) add(false, `${msg} (scopePolicy strict)`);
      else lines.push(`! ${msg} (scopePolicy warn: set "scopePolicy": "strict" to fail)`);
    }
    if (waived.config.length) lines.push(`! scope: unscoped by config (${list(waived.config)})`);
    if (waived.flag.length) {
      lines.push(`! scope: waived by --allow-unscoped ${flagGlobs.join(',')} (${list(waived.flag)})`);
      appendLedger({ type: 'scope-waiver', globs: flagGlobs, files: waived.flag.slice(0, 50) });
    }
    lines.push(`scope: exact=${scopeCount.exact} widened=${scopeCount.widened} unknown=${scopeCount.unknown}`);
    if (flags.explain) {
      for (const x of explain) { lines.push(`explain ${x.check}: scope=${x.scope} closure=${x.closureSize} [${x.closure.join(', ')}${x.closureSize > 10 ? ', …' : ''}]`); for (const f of x.files.slice(0, 20)) lines.push(`  ${f.file}: ${f.why}`); }
      for (const f of unscoped) lines.push(`explain unknown: ${f}: not claimed by any check/project`);
      for (const f of newSrc) lines.push(`explain unannotated: ${f}: new source file without @id/@implements`);
    }
    scopeJson = { ...scopeCount, policy: cfg.scopePolicy === 'strict' ? 'strict' : 'warn', unscoped, waived, ...(newSrc.length ? { unannotated: newSrc } : {}), ...(flags.explain ? { explain } : {}) };
  }
  if (planning.enabled && !flags['no-run']) {
    const after = planningSession();
    const result = after.exit ? { ...after, stage: 'gate' } : after.enabled
      ? evaluateImplementationPlan({ model: after.model, adapter: after.adapter, stage: 'gate', taskIds: planningIds })
      : { enabled: false, stage: 'gate', status: 'FAIL', exit: 1,
        errors: [{ id: 'planning', reason: 'planning policy changed during gate', exit: 1 }], tasks: [] };
    const current = publicPlanningResult(result);
    if (current.exit === 1) add(false, 'planning inputs changed or are invalid after checks',
      current.errors.map(error => `${error.id}: ${error.reason}`));
    else if (current.exit === 2) { incomplete = true; lines.push('! planning after checks: INCOMPLETE',
      ...current.errors.map(error => `    ${error.id}: ${error.reason}`)); }
    planningDecision = current;
  }
  const verdict = fail ? 'FAIL' : incomplete ? 'INCOMPLETE' : 'PASS';
  if (flags.json) out(JSON.stringify({ verdict, lines, runnerEnv: runnerEnvRecord(), tdd: { weak: weakIds, suspect: suspectIds },
    ...(planningDecision ? { planning: planningDecision } : {}), ...(scopeJson ? { scope: scopeJson } : {}) }));
  else { out(`SDD GATE ${verdict}`); lines.forEach((l) => out(l)); }
  return fail ? 1 : incomplete ? 2 : 0;
}

function cmdStatus() {
  const specs = loadSpecs();
  const { ents } = scanEntities(listFiles());
  const entries = readLedger();
  // an unlocked (T1) spec has no lock to go stale, but changed REQ/test evidence must still be visible (#77)
  const t1State = (s) => (s.reqs.some((r) => !r.deferred && [...ents.values()].some((e) => e.kind === 'TEST' && e.refs.verifies.includes(r.id) && /changed/.test(evidenceStatus(e.id, e.path, entries).why ?? ''))) ? 'stale' : 'n/a');
  const ap = specs.map((s) => `${s.feature}:${s.tier}:${needsLock(s) ? approvalState(s) : t1State(s)}`).join(' ');
  const { dups } = scanEntities(listFiles());
  const orphans = traceCheck(ents, dups, specs).errors.filter((e) => /references unknown REQ-/.test(e)).length;
  out(`specs ${specs.length} [${ap}] | entities ${ents.size} | ledger ${entries.length}${orphans ? ` | ORPHAN refs ${orphans} (unknown REQ — see trace)` : ''}`);
  return 0;
}

// ---------- plan (feature-level order for large work) ----------
function loadPlan() {
  const f = path.join(SDD, 'plan.md');
  if (!fs.existsSync(f)) return null;
  const rows = [];
  const bad = [];
  for (const l of fs.readFileSync(f, 'utf8').split('\n')) {
    const c = l.trim().replace(/^\||\|$/g, '').split('|').map((x) => x.trim());
    if (c.length >= 2 && l.trim().startsWith('|') && !/^\d+$/.test(c[0]) && !/^(order|no\.?|#|:?-+:?)$/i.test(c[0]) && c[1]) bad.push(`plan.md row ignored (order "${c[0]}" is not a number): ${c[1]}`);
    if (c.length < 2 || !/^\d+$/.test(c[0])) continue;
    rows.push({ order: Number(c[0]), feature: c[1], deps: (c[2] ?? '').split(/[,\s]+/).map((x) => x.trim()).filter((x) => x && !/^[-—–]$/.test(x)), note: c[3] ?? '' });
  }
  return Object.assign(rows.sort((a, b) => a.order - b.order), { bad });
}

function cmdPlan(args) {
  const planning = planningSession();
  if (planning.enabled || planning.exit || pos.length > 1) return emitPlanningResult(runPlanningCommand(planning, pos, flags), flags.json);
  const rows = loadPlan();
  if (!rows) { out('no .sdd/plan.md (table: | order | feature | depends | note |)'); return 1; }
  const specs = loadSpecs();
  const { ents, dups } = scanEntities(listFiles());
  const entries = readLedger();
  const byFeat = new Map(specs.map((s) => [s.feature, s]));
  const tr = traceCheck(ents, dups, specs);
  // a REQ removed from a spec leaves 'references unknown REQ-P-N' errors: attribute them to the feature whose REQs share the prefix (#77)
  const prefixOf = (id) => id.replace(/-[A-Z0-9]+$/, '');
  const traceDirty = (sp) => { const pf = new Set(sp.reqs.map((r) => prefixOf(r.id))); return tr.errors.some((e) => { const u = /references unknown (REQ-[A-Z0-9-]+)/.exec(e)?.[1]; return u ? pf.has(prefixOf(u)) : sp.reqs.some((r) => e.includes(r.id)); }); };
  const isDone = (feat) => {
    const sp = byFeat.get(feat);
    if (!sp) return false;
    if (traceDirty(sp)) return false;
    if (needsLock(sp) && (approvalState(sp) !== 'ok' || designProblem(sp))) return false;
    let n = 0;
    for (const r of sp.reqs) {
      if (r.deferred) continue;
      let covered = 0;
      for (const e of ents.values()) {
        if (e.kind !== 'TEST' || !e.refs.verifies.includes(r.id)) continue;
        covered++;
        if (!evidenceStatus(e.id, e.path, entries).ok) return false;
      }
      if (!covered) return false;
      n++;
    }
    return n > 0;
  };
  const problems = [];
  const warns = [...rows.bad];
  const seen = new Set();
  const orderByFeature = new Map(rows.map((r) => [r.feature, r.order]));
  for (const r of rows) {
    if (seen.has(r.feature)) problems.push(`duplicate feature ${r.feature}`);
    seen.add(r.feature);
    if (!byFeat.has(r.feature)) warns.push(`${r.feature}: no spec yet`);
    for (const d of r.deps) {
      if (!orderByFeature.has(d)) problems.push(`${r.feature}: unknown dependency ${d}`);
      else if (orderByFeature.get(d) === r.order) problems.push(`${r.feature}: dependency ${d} has the same order number (${r.order}); give ${r.feature} a larger number`);
      else if (orderByFeature.get(d) > r.order) problems.push(`${r.feature}: dependency ${d} is ordered after it (cycle or wrong order)`);
    }
  }
  const done = new Map(rows.map((r) => [r.feature, isDone(r.feature)]));
  // a dependency that was completed once and is merely stale/edited is not 'not started'
  const evidenced = (feat) => { const sp = byFeat.get(feat); return !!sp && [...ents.values()].some((e) => e.kind === 'TEST' && sp.reqs.some((q) => e.refs.verifies.includes(q.id)) && entries.some((x) => x.test === e.id && x.type === 'green')); };
  let next = null;
  for (const r of rows) {
    const sp = byFeat.get(r.feature);
    const depsOk = r.deps.every((d) => done.get(d));
    const started = sp && [...ents.values()].some((e) => e.kind === 'TEST' && sp.reqs.some((q) => e.refs.verifies.includes(q.id)) && entries.some((x) => x.test === e.id));
    const untouched = r.deps.filter((d) => !done.get(d) && !evidenced(d));
    if (started && untouched.length && !done.get(r.feature)) warns.push(`${r.feature}: started before dependencies are done (${untouched.join(', ')})`);
    if (!next && !done.get(r.feature) && depsOk) next = r.feature;
    const st = sp ? `${sp.tier}${needsLock(sp) ? `:${approvalState(sp)}` : ''}` : 'no-spec';
    const unplanned = sp ? '' : specs.filter((x) => !rows.some((q) => q.feature === x.feature)).map((x) => x.feature);
    out(`${done.get(r.feature) ? '✓' : '·'} ${r.order}. ${r.feature} [${st}]${r.deps.length ? ` ← ${r.deps.join(', ')}` : ''}${r.note ? ` — ${r.note}` : ''}${unplanned.length ? ` — no spec has feature: ${r.feature}; plan rows use the spec's feature name (unplanned specs: ${unplanned.slice(0, 5).join(', ')})` : ''}`);
  }
  const orphanReqs = [...new Set(tr.errors.map((e) => /references unknown (REQ-[A-Z0-9-]+)/.exec(e)?.[1]).filter(Boolean))].filter((u) => !specs.some((sp) => sp.reqs.some((r) => prefixOf(r.id) === prefixOf(u))));
  for (const u of orphanReqs) problems.push(`${u} is referenced by tests/code but no spec defines it (write the spec first)`);
  const unlisted = specs.filter((sp) => !orderByFeature.has(sp.feature)).map((sp) => sp.feature);
  for (const f of unlisted) warns.push(`${f}: spec is not in plan.md${isDone(f) ? '' : ' and is not done'}`);
  for (const w of warns) out(`  ! ${w}`);
  for (const p of problems) out(`  ✗ ${p}`);
  out(next ? `next: ${next}` : problems.length ? 'next: (fix plan first)' : unlisted.length ? `next: (listed features done; add to plan.md: ${unlisted.join(', ')})` : 'next: (all features done)');
  return problems.length ? 1 : 0;
}

// best-effort reverse import graph (target -> importers) for impact; JS/TS precise, others heuristic (#91)
function importRev(noParity = false) {
  const files = listFiles();
  const set = new Set(files);
  // JSON files are graph nodes only as targets of static JS/TS imports (a shared contract), #145
  const jsonFiles = gitFiles('*.json').filter((f) => !SKIP.test(f) && fs.existsSync(path.join(ROOT, f)));
  for (const j of jsonFiles) set.add(j);
  const rev = jsRev([...files.filter((f) => /\.[cm]?[jt]sx?$/.test(f)), ...jsonFiles]);
  const add = (t, f) => { if (t && t !== f && set.has(t)) { if (!rev.has(t)) rev.set(t, []); if (!rev.get(t).includes(f)) rev.get(t).push(f); } };
  const dir = (f) => path.posix.dirname(f);
  const byDir = new Map();
  for (const f of files) { const d = dir(f); if (!byDir.has(d)) byDir.set(d, []); byDir.get(d).push(f); }
  const cImpl = [];
  const javaPkg = new Map();
  for (const g of files) if (g.endsWith('.java')) { const k = /^\s*package\s+([\w.]+)\s*;/m.exec(fs.readFileSync(path.join(ROOT, g), 'utf8'))?.[1] ?? dir(g); if (!javaPkg.has(k)) javaPkg.set(k, []); javaPkg.get(k).push(g); }
  const phpDecl = new Map();
  for (const g of files) if (g.endsWith('.php')) {
    const code = fs.readFileSync(path.join(ROOT, g), 'utf8');
    const ns = /^\s*namespace\s+([\w\\]+)\s*;/m.exec(code)?.[1];
    if (ns) for (const m of code.matchAll(/^\s*(?:(?:abstract|final|readonly)\s+)*(?:class|interface|trait|enum)\s+(\w+)/gm)) { const q = `${ns}\\${m[1]}`; if (!phpDecl.has(q)) phpDecl.set(q, []); phpDecl.get(q).push(g); }
    // namespaced functions/consts are imported with `use function` / `use const` (#222)
    for (const [kind, re] of [['function', /^(?:function)\s+&?\s*(\w+)\s*\(/gm], ['const', /^const\s+(\w+)\s*=/gm]]) for (const m of maskBraces(code).matchAll(re)) { const q = `${kind}:${[ns, m[1]].filter(Boolean).join('\\')}`; if (!phpDecl.has(q)) phpDecl.set(q, []); phpDecl.get(q).push(g); }
  }
  const endsWith = (suffix) => files.filter((f) => f === suffix || f.endsWith('/' + suffix));
  // Rust cross-crate `use name::..` resolves by Cargo package name (`-` → `_`), not against every crate's lib.rs (#127)
  const crateBySrc = new Map();
  const cargoPackages = [];
  for (const g of gitFiles('*Cargo.toml')) if (/(^|\/)Cargo\.toml$/.test(g)) {
    const toml = fs.readFileSync(path.join(ROOT, g), 'utf8');
    const pkgName = /^\[package\][^[]*?^\s*name\s*=\s*"([^"]+)"/ms.exec(toml)?.[1];
    const libName = /^\[lib\][^[]*?^\s*name\s*=\s*"([^"]+)"/ms.exec(toml)?.[1];
    const sd = dir(g) === '.' ? 'src' : dir(g) + '/src';
    cargoPackages.push({ dir: dir(g), src: sd, name: pkgName, toml });
    for (const n of new Set([pkgName?.replace(/-/g, '_'), libName].filter(Boolean))) if (set.has(sd + '/lib.rs')) crateBySrc.set(n, [...(crateBySrc.get(n) ?? []), sd]);
  }
  const cargoAliases = new Map();
  for (const pkg of cargoSources()) cargoAliases.set(pkg.dir, new Map([...pkg.bindings].map(([alias, target]) => [alias, [path.posix.dirname(target.lib)]])));
  // `#[path = "x.rs"] mod name;` maps module `name` of the declaring module to that file (#217)
  const rsPathMods = new Map();
  for (const g of files) if (g.endsWith('.rs')) for (const m of fs.readFileSync(path.join(ROOT, g), 'utf8').matchAll(/#\[\s*path\s*=\s*"([^"\n]+)"\s*\]\s*(?:#\[[^\]\n]*\]\s*)*(?:pub(?:\([^)]*\))?\s+)?mod\s+(\w+)\s*;/g)) {
    const t = path.posix.normalize(path.posix.join(dir(g), m[1]));
    rsPathMods.set(`${/(?:^|\/)(?:lib|main|mod)\.rs$/.test(g) ? dir(g) : g.replace(/\.rs$/, '')}/${m[2]}`, t);
  }
  const stem = (x) => path.posix.basename(x).replace(/\.\w+$/, '');
  const goMods = gitFiles('*go.mod').filter((g) => /(^|\/)go\.mod$/.test(g)).map((g) => {
    const text = fs.readFileSync(path.join(ROOT, g), 'utf8');
    const replacements = [...text.matchAll(/^\s*(?:replace\s+)?([^\s()]+)(?:\s+v[^\s]+)?\s+=>\s+(\.[^\s]+)\s*$/gm)].map((m) => ({ path: m[1], dir: path.posix.normalize(path.posix.join(dir(g), m[2])) }));
    return { dir: dir(g), path: /^\s*module\s+(\S+)/m.exec(text)?.[1], replacements };
  }).filter((m) => m.path);
  // a header and its implementation pair when they share a directory, or are the only same-named .h/.c in the project (#127)
  const cPair = (h, c) => stem(h) === stem(c) && (dir(h) === dir(c) || (files.filter((x) => /\.h(pp|h)?$/.test(x) && stem(x) === stem(h)).length === 1 && files.filter((x) => /\.(c|cc|cpp|cxx)$/.test(x) && stem(x) === stem(c)).length === 1));
  const csNs = new Map(), jlMod = new Map(), exMod = new Map();
  // ProjectReference graph: a using only links to files of projects the importer's project references (transitively); project files, shared props and solutions are graph nodes too (#135)
  const dn = files.some((f) => f.endsWith('.cs')) ? dotnetGraph(ROOT) : null;
  const csOwner = (f) => dn?.ownersOf(f) ?? [];
  const csReach = new Map();
  if (dn) {
    for (const x of [...dn.projs.keys(), ...dn.props, ...dn.sols.keys()]) set.add(x);
    for (const q of dn.projs.values()) for (const r of q.refs) add(r, q.file);
    for (const x of dn.props) for (const q of dn.projs.values()) if (path.posix.dirname(x) === '.' || q.file.startsWith(path.posix.dirname(x) + '/')) add(x, q.file);
    for (const [sf, ms] of dn.sols) for (const m of ms) add(sf, m);
    for (const g of files) if (g.endsWith('.cs')) for (const o of csOwner(g)) add(o.file, g);
    for (const q of dn.projs.values()) csReach.set(q.file, dn.deps(q.file));
  }
  const csVisible = (f, g) => { const of = csOwner(f), og = csOwner(g); return !of.length || !og.length || of.some((a) => og.some((b) => csReach.get(a.file)?.has(b.file))); };
  for (const g of files) {
    if (g.endsWith('.cs')) { const code = fs.readFileSync(path.join(ROOT, g), 'utf8'); const ns = /^\s*namespace\s+([\w.]+)/m.exec(code)?.[1]; if (ns) { const types = [...code.matchAll(/\b(?:class|record|struct|interface|enum)\s+(?:(?:struct|class)\s+)?(\w+)/g)].map((m) => m[1]); csNs.set(g, { ns, types }); } }
    else if (/\.exs?$/.test(g)) for (const m of fs.readFileSync(path.join(ROOT, g), 'utf8').matchAll(/^\s*defmodule\s+([A-Z][\w.]*)/gm)) { if (!exMod.has(m[1])) exMod.set(m[1], []); exMod.get(m[1]).push(g); }
    else if (g.endsWith('.jl')) for (const m of fs.readFileSync(path.join(ROOT, g), 'utf8').matchAll(/^\s*module\s+(\w+)/gm)) { if (!jlMod.has(m[1])) jlMod.set(m[1], []); jlMod.get(m[1]).push(g); }
  }
  for (const f of files) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    if (/\.py$/.test(f)) {
      // relative imports resolve against the importing file's package (#111)
      for (const m of src.matchAll(/^\s*from\s+(\.+)([\w.]*)\s+import\s+(\([^)]*\)|[^\n#]+)/gm)) {
        let base = dir(f);
        for (let k = 1; k < m[1].length; k++) base = dir(base);
        const sub = m[2].replace(/\./g, '/');
        const root = [base, sub].filter((x) => x && x !== '.').join('/');
        if (sub) for (const c of [`${root}.py`, `${root}/__init__.py`]) add(c, f);
        else add(`${base === '.' ? '' : base + '/'}__init__.py`.replace(/^\//, ''), f);
        for (const n of m[3].replace(/[()]/g, '').split(',').map((x) => x.trim().split(/\s+as\s+/)[0]).filter((x) => /^\w+$/.test(x))) for (const c of [`${root}/${n}.py`, `${root}/${n}/__init__.py`]) add(c, f);
      }
      for (const m of src.matchAll(/^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/gm)) {
        const mod = (m[1] ?? m[2]).replace(/^\.+/, '').replace(/\./g, '/');
        if (mod) for (const c of [mod + '.py', mod + '/__init__.py']) endsWith(c).forEach((t) => add(t, f));
      }
      // `from pkg import submodule` resolves to pkg/submodule.py (#145)
      for (const m of src.matchAll(/^\s*from\s+([\w.]+)\s+import\s+(\([^)]*\)|[^\n#]+)/gm)) {
        const mod = m[1].replace(/\./g, '/');
        for (const n of m[2].replace(/[()]/g, '').split(',').map((x) => x.trim().split(/\s+as\s+/)[0]).filter((x) => /^\w+$/.test(x))) for (const c of [`${mod}/${n}.py`, `${mod}/${n}/__init__.py`]) endsWith(c).forEach((t) => add(t, f));
      }
    } else if (/\.go$/.test(f)) {
      // package-granular imports narrowed to the files declaring a symbol this file uses (#105); falls back to the whole package
      const declares = (t, names) => { const code = fs.readFileSync(path.join(ROOT, t), 'utf8'); return [...names].some((n) => new RegExp(`^(?:func\\s+(?:\\([^)]*\\)\\s*)?|type\\s+|var\\s+|const\\s+)${n}\\b|^\\s+${n}\\b\\s*(?:=|[A-Za-z*\\[])`, 'm').test(code)); };
      // methods-only files belong to the package API of the types they extend: include them when a hit file declares the receiver type (#145)
      const codeOf = (t) => fs.readFileSync(path.join(ROOT, t), 'utf8');
      const goTypes = (t) => new Set([...codeOf(t).matchAll(/^type\s+(\w+)|^\s+(\w+)\s+(?:struct|interface)\b/gm)].map((x) => x[1] ?? x[2]));
      const goRecv = (t) => [...codeOf(t).matchAll(/^func\s+\(\s*(?:\w+\s+)?\*?\s*(\w+)/gm)].map((x) => x[1]);
      const narrow = (cands, names) => {
        const hit = names.size ? cands.filter((t) => { try { return declares(t, names); } catch { return true; } }) : [];
        if (!hit.length) return cands;
        const tys = new Set(hit.flatMap((t) => { try { return [...goTypes(t)]; } catch { return []; } }));
        const aliases = cands.flatMap((t) => [...codeOf(t).matchAll(/^(?:type\s+|\s+)(\w+)\s*=\s*(\w+)\b/gm)].map((m) => [m[1], m[2]]));
        let grew;
        do {
          grew = false;
          for (const [a, b] of aliases) if (tys.has(a) || tys.has(b)) for (const n of [a, b]) if (!tys.has(n)) { tys.add(n); grew = true; }
        } while (grew);
        return [...new Set([...hit, ...cands.filter((t) => { try { return goRecv(t).some((r) => tys.has(r)); } catch { return false; } })])];
      };
      // import paths are module-relative: map `<module>/x` to `<go.mod dir>/x` (go.mod may live in a subdirectory)
      const owner = goMods.filter((m) => m.dir === '.' || f.startsWith(m.dir + '/')).sort((a, b) => b.dir.length - a.dir.length)[0];
      const goModDir = (imp) => {
        const mappings = [...(owner?.replacements ?? []), ...goMods].filter((m) => imp === m.path || imp.startsWith(m.path + '/'));
        const best = mappings.sort((a, b) => b.path.length - a.path.length)[0];
        return best ? path.posix.join(best.dir, imp.slice(best.path.length).replace(/^\//, '')) : null;
      };
      for (const m of src.matchAll(/(?:(\w+)\s+)?"([\w./-]+)"/g)) {
        const resolved = goModDir(m[2]);
        for (const d of byDir.keys()) if (resolved === d || (resolved === null && d !== '.' && (m[2] === d || m[2].endsWith('/' + d)))) {
          const pkg = (byDir.get(d) ?? []).find((x) => x.endsWith('.go') && !x.endsWith('_test.go'));
          const alias = m[1] && m[1] !== 'import' ? m[1] : pkg && /^\s*package\s+(\w+)/m.exec(codeOf(pkg))?.[1] || m[2].split('/').pop();
          const used = new Set([...src.matchAll(new RegExp(`\\b${alias}\\.([A-Za-z_]\\w*)`, 'g'))].map((x) => x[1]));
          narrow(byDir.get(d).filter((x) => /\.go$/.test(x) && !/_test\.go$/.test(x)), used).forEach((t) => add(t, f));
        }
      }
      const ownPackage = /^\s*package\s+(\w+)/m.exec(src)?.[1];
      const samePackage = (byDir.get(dir(f)) ?? []).filter((x) => /\.go$/.test(x) && !/_test\.go$/.test(x) && /^\s*package\s+(\w+)/m.exec(codeOf(x))?.[1] === ownPackage);
      const used = new Set([...src.matchAll(/\b([A-Za-z_]\w*)\b/g)].map((x) => x[1]));
      // Production callers have the same implicit symbol dependencies as in-package tests.
      const hits = samePackage.filter((t) => t !== f && declares(t, used));
      if (hits.length) narrow(samePackage, used).forEach((t) => add(t, f));
    } else if (/\.rs$/.test(f)) {
      const crateSrc = (x) => x.replace(/\/(src|tests|benches|examples)\/.*$/, '').replace(/^(src|tests|benches|examples)\/.*$/, '');
      const srcDir = (x) => (crateSrc(x) ? crateSrc(x) + '/src' : 'src');
      for (const m of src.matchAll(/^\s*(?:pub\s+)?use\s+(\w+)::([^;]+);/gms)) {
        const root = m[1];
        const bases = root === 'crate' || root === 'self' || root === 'super' ? [srcDir(f)] : (cargoAliases.get(crateSrc(f) || '.')?.get(root) ?? crateBySrc.get(root) ?? []);
        const paths = [];
        const rest = m[2].trim();
        if (rest.startsWith('{')) { let d = 0, cur = ''; for (const ch of rest.slice(1, rest.lastIndexOf('}'))) { if (ch === '{') d++; if (ch === '}') d--; if (ch === ',' && d === 0) { paths.push(cur.trim()); cur = ''; } else cur += ch; } if (cur.trim()) paths.push(cur.trim()); } else paths.push(rest);
        for (const p of paths) {
          const segs = p.replace(/\{.*$/s, '').split('::').map((x) => x.trim()).filter((x) => /^\w+$/.test(x));
          for (const b of bases) {
            let cur = b; let hit = false;
            for (const sg of segs) { const c = [rsPathMods.get(`${cur}/${sg}`), `${cur}/${sg}.rs`, `${cur}/${sg}/mod.rs`].find((x) => x && set.has(x)); if (!c) break; add(c, f); hit = true; cur = c.endsWith('/mod.rs') ? dir(c) : c.replace(/\.rs$/, ''); }
            // an item re-exported from the crate root: link to the file that declares it
            if (!hit && segs.length) for (const x of files) if (x.startsWith(b + '/') && x.endsWith('.rs') && new RegExp(`\\bpub(?:\\([\\w:]+\\))?\\s+(?:fn|struct|enum|trait|const|type|static)\\s+${segs[0]}\\b`).test(fs.readFileSync(path.join(ROOT, x), 'utf8'))) add(x, f);
            if (p.includes('*')) for (const x of files) if (x.endsWith('.rs') && (x.startsWith((hit ? cur : b) + '/') || x === cur + '.rs')) add(x, f);
          }
        }
      }
      if (!/(^|\/)(lib|main|mod)\.rs$/.test(f)) for (const m of src.matchAll(/^\s*(?:pub\s+)?mod\s+(\w+)\s*;/gm)) for (const c of [`${dir(f)}/${m[1]}.rs`, `${dir(f)}/${m[1]}/mod.rs`]) add(c, f);
    } else if (/\.java$/.test(f)) {
      for (const m of src.matchAll(/^\s*import\s+(?:static\s+)?([\w.]+?)(\.\*)?\s*;/gm)) {
        const parts = m[1].split('.');
        if (m[2]) { const pd = parts.join('/'); for (const g of files) if (g.endsWith('.java') && (dir(g) === pd || dir(g).endsWith('/' + pd)) && new RegExp(`\\b${path.posix.basename(g, '.java')}\\b`).test(src)) add(g, f); continue; }
        for (let n = parts.length; n > 0; n--) { const c = endsWith(parts.slice(0, n).join('/') + '.java'); if (c.length) { c.forEach((t) => add(t, f)); break; } }
      }
      // same-package types need no import
      const pk = /^\s*package\s+([\w.]+)\s*;/m.exec(src)?.[1] ?? dir(f);
      for (const g of javaPkg.get(pk) ?? []) if (g !== f && new RegExp(`\\b${path.posix.basename(g, '.java')}\\b`).test(src)) add(g, f);
    } else if (/\.(c|h|cc|cpp|cxx|hpp|hh)$/.test(f)) {
      // quoted includes resolve relative to the includer first, then as a project-relative suffix; angle includes only when they name an existing project path (#127)
      for (const m of src.matchAll(/^\s*#\s*include\s+([<"])([^>"]+)[>"]/gm)) {
        const rel0 = path.posix.normalize(path.posix.join(dir(f), m[2]));
        if (m[1] === '"' && set.has(rel0)) { add(rel0, f); continue; }
        const inc = m[2].replace(/^(\.\/|\.\.\/)+/, '');
        endsWith(inc).forEach((t) => add(t, f));
      }
      if (/\.h(pp|h)?$/.test(f)) for (const x of files) if (/\.(c|cc|cpp|cxx)$/.test(x) && cPair(f, x)) add(f, x);
      if (/\.(c|cc|cpp|cxx)$/.test(f)) cImpl.push(f);
    } else if (/\.cs$/.test(f)) {
      // `using Ns;` → files declaring that namespace whose types this file mentions; same-namespace types need no using (#127)
      const own = csNs.get(f)?.ns;
      const usings = new Set([...src.matchAll(/^\s*(?:global\s+)?using\s+(?:static\s+)?(?:\w+\s*=\s*)?([\w.]+)\s*;/gm)].map((m) => m[1]));
      if (own) usings.add(own);
      for (const [g, d] of csNs) if (g !== f && usings.has(d.ns) && csVisible(f, g) && d.types.some((t) => new RegExp(`\\b${t}\\b`).test(src))) add(g, f);
    } else if (/\.exs?$/.test(f)) {
      // alias/import/use/require (and any qualified `Mod.fun` call, through aliases) reach the files that defmodule the module
      const al = new Map(), refs = new Set();
      const body = src.replace(/#[^\n]*/g, '');
      const full = (n) => { const h = n.split('.')[0]; return al.has(h) ? al.get(h) + n.slice(h.length) : n; };
      for (const m of body.matchAll(/\balias\s+([A-Z][\w.]*)\.\{([^}]*)\}/g)) for (const x of m[2].split(',')) { const q = `${m[1]}.${x.trim()}`; al.set(q.split('.').at(-1), q); refs.add(q); refs.add(m[1]); }
      for (const m of body.matchAll(/\balias\s+([A-Z][\w.]*)(?![\w]|\.\{)(?:\s*,\s*as:\s*([A-Z]\w*))?/g)) { al.set(m[2] ?? m[1].split('.').at(-1), m[1]); refs.add(m[1]); }
      for (const m of body.matchAll(/\b(?:import|use|require)\s+([A-Z][\w.]*)/g)) refs.add(full(m[1]));
      for (const m of body.matchAll(/(?<![\w.:])([A-Z]\w*(?:\.[A-Z]\w*)*)/g)) refs.add(full(m[1]));
      for (const r of refs) (exMod.get(r) ?? []).forEach((t) => add(t, f));
    } else if (/\.jl$/.test(f)) {
      for (const m of src.matchAll(/^\s*include\(\s*"([^"]+)"\s*\)/gm)) add(path.posix.normalize(path.posix.join(dir(f), m[1])), f);
      for (const m of src.matchAll(/^\s*(?:using|import)\s+([^\n;]+)/gm)) {
        for (const item of m[1].split(':')[0].split(',')) {
          const name = /^\s*\.*(\w+)/.exec(item)?.[1];
          (jlMod.get(name) ?? []).forEach((t) => add(t, f));
        }
      }
    } else if (/\.[rR]$/.test(f)) {
      // literal `source("x.R")` / `sys.source(file.path("a", "x.R"))`: relative to the file (testthat) or the project root (#224)
      for (const m of src.replace(/^\s*#.*$/gm, '').matchAll(/\b(?:sys\.)?source\(\s*(?:file\s*=\s*)?(?:file\.path\(\s*((?:["'][^"'\n]*["']\s*,?\s*)+)\)|["']([^"'\n]+)["'])/g)) {
        const p = m[2] ?? [...m[1].matchAll(/["']([^"'\n]*)["']/g)].map((x) => x[1]).join('/');
        for (const c of [path.posix.join(dir(f), p), p]) add(path.posix.normalize(c), f);
      }
    } else if (/\.php$/.test(f)) {
      // `use Ns\Class;`, group uses and same-namespace references resolve through declared namespace + class name (#111)
      for (const m of src.matchAll(/^\s*use\s+(?:function\s+|const\s+)?([\w\\]+?)(?:\s+as\s+\w+)?\s*;|^\s*use\s+([\w\\]+)\\\{([^}]*)\}\s*;/gm)) {
        const fqns = m[1] ? [m[1]] : m[3].split(',').map((x) => `${m[2]}\\${x.trim().split(/\s+as\s+/)[0]}`);
        for (const q of fqns) phpDecl.get(q.replace(/^\\/, ''))?.forEach((t) => add(t, f));
      }
      for (const kind of ['function', 'const']) for (const q of phpImports(src, kind).values()) phpDecl.get(`${kind}:${q}`)?.forEach((t) => add(t, f));
      const ns = /^\s*namespace\s+([\w\\]+)\s*;/m.exec(src)?.[1];
      if (ns) for (const [q, ts] of phpDecl) if (!q.includes(':') && q.startsWith(ns + '\\') && !q.slice(ns.length + 1).includes('\\') && new RegExp(`\\b${q.split('\\').pop()}\\b`).test(src)) ts.forEach((t) => add(t, f));
      for (const m of src.matchAll(/(?:require|include)(?:_once)?\s*\(?\s*(?:__DIR__\s*\.\s*)?['"]([^'"]+)['"]/g)) {
        const p = m[1].replace(/^\//, '');
        add(path.posix.normalize(path.posix.join(dir(f), p)), f);
        endsWith(p.replace(/^(\.\.?\/)+/, '')).forEach((t) => add(t, f));
      }
    }
  }
  // an implementation file is reached by whatever includes its header
  for (const c of cImpl) for (const h of files) if (/\.h(pp|h)?$/.test(h) && cPair(h, c)) for (const imp of rev.get(h) ?? []) add(c, imp);
  // non-code artifacts declared in .sdd/config.json `artifacts` ({"contract/x.json": ["src/a.ts"]} = files that depend on it) are impact edges (#242)
  for (const [a, users] of Object.entries(loadConfig().artifacts ?? {})) for (const u of [].concat(users)) { const t = normDep(a), f = normDep(u); if (t !== f && fs.existsSync(path.join(ROOT, t)) && fs.existsSync(path.join(ROOT, f))) { if (!rev.has(t)) rev.set(t, []); if (!rev.get(t).includes(f)) rev.get(t).push(f); } }
  // `parity`: [["rust/hash.rs", "elixir/hash.ex"]] = two implementations of one algorithm; a change to either reaches the other (#266)
  if (!noParity) for (const pr of loadConfig().parity ?? []) for (const [x, y] of [[pr[0], pr[1]], [pr[1], pr[0]]]) { const t = x && normDep(x), f = y && normDep(y); if (t && f && t !== f && fs.existsSync(path.join(ROOT, t)) && fs.existsSync(path.join(ROOT, f))) { if (!rev.has(t)) rev.set(t, []); if (!rev.get(t).includes(f)) rev.get(t).push(f); } }
  return rev;
}

// other-feature REQs whose code/tests import the changed files: their evidence is not re-run by a --changed gate (#104)
function crossImpact(changed) {
  const specs = loadSpecs();
  const reqFeature = new Map();
  for (const sp of specs) for (const r of sp.reqs) reqFeature.set(r.id, sp.feature);
  const all = [...scanEntities(listFiles()).ents.values()];
  const files = [...changed].filter((f) => fs.existsSync(path.join(ROOT, f)) && !f.startsWith('.sdd/'));
  const own = new Set(all.filter((e) => files.includes(e.path)).flatMap((e) => [...e.refs.implements, ...e.refs.verifies]).map((r) => reqFeature.get(r)).filter(Boolean));
  const rev = importRev();
  const seen = new Set(files);
  const queue = [...files];
  while (queue.length) { const f = queue.shift(); for (const d of rev.get(f) ?? []) if (!seen.has(d)) { seen.add(d); queue.push(d); } }
  const hit = new Map();
  for (const e of all) if (seen.has(e.path) && !files.includes(e.path)) for (const r of [...e.refs.verifies, ...e.refs.implements]) { const ft = reqFeature.get(r); if (ft && !own.has(ft)) hit.set(r, ft); }
  return [...hit].map(([req, feature]) => ({ req, feature }));
}

function cmdImpact() {
  const targets = pos.slice(1);
  if (targets.length < 2) return impactOne(targets[0]);
  // several targets: report each one (one JSON line per target with --json) (#308)
  let code = 0;
  for (const t of targets) { if (!flags.json && t !== targets[0]) out(''); code = Math.max(code, impactOne(t)); }
  return code;
}
// workspace member dirs of a Cargo.toml/Cargo.lock; a trailing `*` member glob ("crates/*") expands to the existing subdirectories (#312)
function cargoMembersOf(f) {
  if (!/(^|\/)Cargo\.(toml|lock)$/.test(f)) return [];
  const dir = path.posix.dirname(f);
  try {
    const m = /^\s*members\s*=\s*\[([^\]]*)\]/m.exec(fs.readFileSync(path.join(ROOT, dir === '.' ? '' : dir, 'Cargo.toml'), 'utf8'));
    if (!m) return [];
    return [...m[1].matchAll(/["']([^"']+)["']/g)].flatMap((x) => {
      const g = /^(.*)\/\*$/.exec(x[1]);
      if (!g) return [normDep(path.posix.join(dir, x[1]))];
      try { return fs.readdirSync(path.join(ROOT, dir === '.' ? '' : dir, g[1]), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => normDep(path.posix.join(dir, g[1], e.name))); } catch { return []; }
    });
  } catch { return []; }
}
function impactOne(target, collect = false) {
  if (!target) { out('usage: impact <REQ-ID|TEST-ID|CODE-ID|file> [--json] [--all]'); return 2; }
  const specs = loadSpecs();
  const { ents } = scanEntities(listFiles());
  const reqFeature = new Map();
  for (const sp of specs) for (const r of sp.reqs) reqFeature.set(r.id, sp.feature);
  const all = [...ents.values()];
  let seeds; let reqs; let dataFile = false; let nonCode = false;
  if (/^REQ-/.test(target)) {
    if (!reqFeature.has(target)) { out(`IMPACT: unknown REQ ${target}`); return 1; }
    reqs = [target];
    seeds = [...new Set(all.filter((e) => e.refs.implements.includes(target)).map((e) => e.path))];
  } else if (ents.has(target)) {
    const e = ents.get(target);
    reqs = [...new Set([...e.refs.implements, ...e.refs.verifies])];
    seeds = [...new Set(all.filter((x) => x.refs.implements.some((r) => reqs.includes(r))).map((x) => x.path))];
    if (!seeds.length || e.kind === 'CODE') seeds = [...new Set([e.path, ...seeds])];
  } else if (fs.existsSync(path.join(ROOT, target))) {
    seeds = [target.replace(/^\.\//, '')];
    dataFile = !EXT.test(seeds[0]) && !all.some((e) => e.path === seeds[0]);
    nonCode = !EXT.test(seeds[0]) && !all.some((e) => e.path === seeds[0]);
    reqs = [...new Set(all.filter((e) => e.path === seeds[0]).flatMap((e) => [...e.refs.implements, ...e.refs.verifies]))];
  } else { out(`IMPACT: unknown target ${target}`); return 1; }
  // a shared data file is outside the import graph: name the projects that list it (or a parent dir) in dependsOn (#247)
  const rev = importRev(true);
  dataFile = dataFile && !(rev.get(seeds[0])?.size ?? rev.get(seeds[0])?.length);
  const projs = loadConfig().projects ?? [];
  const hits = (p, t) => (p.dependsOn ?? []).some((d) => { const x = normDep(d); return t === x || t.startsWith(x + '/'); });
  // a project's real reference to the data file: any of its files naming the file's path or basename (#287)
  const refCache = new Map();
  const referenced = (p, t) => { const k = p.root + '\0' + t; if (!refCache.has(k)) { const pr = normDep(p.root) + '/', bn = path.posix.basename(t); refCache.set(k, listFiles().some((f) => { if (!f.startsWith(pr) || f === t) return false; try { const txt = fs.readFileSync(path.join(ROOT, f), 'utf8'); return txt.includes(t) || txt.includes(bn); } catch { return false; } })); } return refCache.get(k); }
  // dependsOnMode "referenced": the declared edge counts only when a file of the project really mentions the data file
  const direct = (p, t) => hits(p, t) && (p.dependsOnMode !== 'referenced' || referenced(p, t));
  // dependsOn is transitive: a project depending on a dependent project depends on the file too (#255)
  const depProjects = dataFile ? (() => { const got = new Set(projs.filter((p) => direct(p, seeds[0]))); for (let g = true; g;) { g = false; for (const p of projs) if (!got.has(p) && [...got].some((q) => hits(p, normDep(q.root)))) { got.add(p); g = true; } } return projs.filter((p) => got.has(p)).map((p) => p.root); })() : [];
  const projReqs = new Map();
  // a Cargo workspace manifest reaches every member crate's REQs; a declared `artifacts` file reaches only the files that name it (#312)
  const members = dataFile ? cargoMembersOf(seeds[0]) : [];
  const readers = nonCode && !members.length && Object.keys(loadConfig().artifacts ?? {}).some((a) => normDep(a) === seeds[0]) ? new Set(listFiles().filter((f) => { try { const t = fs.readFileSync(path.join(ROOT, f), 'utf8'); return t.includes(seeds[0]) || t.includes(path.posix.basename(seeds[0])); } catch { return false; } })) : null;
  if (dataFile) for (const e of all) { const pr = projs.find((p) => depProjects.includes(p.root) && (e.path === normDep(p.root) || e.path.startsWith(normDep(p.root) + '/'))); const mem = members.some((m) => e.path === m || e.path.startsWith(m + '/')); if ((pr && (!readers || readers.has(e.path))) || mem) for (const r of [...e.refs.verifies, ...e.refs.implements]) { if (!projReqs.has(r)) projReqs.set(r, new Set()); projReqs.get(r).add(e.id + ' (' + e.path + ')'); } }
  const seeds0 = seeds[0];
  if (dataFile) seeds = [];
  const via = new Map(seeds.map((f) => [f, null]));
  const queue = [...seeds];
  while (queue.length) { const f = queue.shift(); for (const d of rev.get(f) ?? []) if (!via.has(d)) { via.set(d, f); queue.push(d); } }
  // parity is one hop (#294): the counterpart and its feature are reached, not the counterpart's importers
  for (const pr of loadConfig().parity ?? []) for (const [x, y] of [[pr[0], pr[1]], [pr[1], pr[0]]]) { const a = x && normDep(x), b = y && normDep(y); if (a && b && seeds.includes(a) && !via.has(b) && fs.existsSync(path.join(ROOT, b))) via.set(b, a); }
  // producers of a generated artifact: build.rs / codegen / writer files that name it (#294)
  const producers = nonCode ? listFiles().filter((f) => { if (f === seeds0) return false; try { const txt = fs.readFileSync(path.join(ROOT, f), 'utf8'); if (!txt.includes(path.posix.basename(seeds0))) return false; return /(^|\/)build\.rs$|codegen|generat/i.test(f) || /\b(writeFile(Sync)?|write_text|write_bytes|fs::write|File::create|json\.dump|WriteFile|to_json|to_csv|savetxt)\b|\bopen\([^)]*['\"][wax]b?\+?['\"]|\.open\(\s*['\"][wax]|\bcodegen\b/.test(txt); } catch { return false; } }) : [];
  // a producer declared in config `artifactProducers` (a file path, or a command naming a file) is a producer even when no file mentions the artifact (r26d)
  const declared = nonCode ? Object.entries(loadConfig().artifactProducers ?? {}).filter(([a]) => normDep(a) === seeds0).map(([, p]) => String(p)) : [];
  for (const dp of declared) if (!producers.includes(dp)) producers.push(dp);
  const reached = [...via.keys()].filter((f) => !seeds.includes(f));
  const entsIn = (f) => all.filter((e) => e.path === f);
  const verifiers = all.filter((e) => e.refs.verifies.some((r) => reqs.includes(r)));
  const affected = new Map();
  const ownFeatures = new Set(reqs.map((r) => reqFeature.get(r)));
  // a header/file without @implements belongs to the features of the same-named implementation files (#111)
  if (!reqs.length && !nonCode) for (const sd of seeds) {
    const st = path.posix.basename(sd).replace(/\.\w+$/, '');
    for (const e of all) if (path.posix.basename(e.path).replace(/\.\w+$/, '') === st) for (const r of [...e.refs.implements, ...e.refs.verifies]) if (reqFeature.get(r)) ownFeatures.add(reqFeature.get(r));
    // an unannotated file belongs to the feature(s) of its annotated siblings in the same directory (#127)
    // only when those siblings agree on one feature: a directory shared by several features says nothing about the file's owner (#145)
    if (!ownFeatures.size) { const sib = new Set(); for (const e of all) if (path.posix.dirname(e.path) === path.posix.dirname(sd)) for (const r of [...e.refs.implements, ...e.refs.verifies]) if (reqFeature.get(r)) sib.add(reqFeature.get(r)); if (sib.size === 1) sib.forEach((x) => ownFeatures.add(x)); }
  }
  for (const f of via.keys()) for (const e of entsIn(f)) for (const r of [...e.refs.verifies, ...e.refs.implements]) if (!reqs.includes(r)) { if (!affected.has(r)) affected.set(r, new Set()); affected.get(r).add(e.id + ' (' + f + ')'); }
  // code seeds reach projects that list the seed's project (or the file) in dependsOn, transitively (process-spawn / runtime consumers)
  if (!dataFile && seeds.length) {
    const got = new Map();
    const owner = (f) => projs.find((p) => f.startsWith(normDep(p.root) + '/'));
    for (const f of [...via.keys()]) { const own = owner(f); for (const p of projs) if (p !== own && (hits(p, f) || (own && hits(p, normDep(own.root)))) && !got.has(p)) got.set(p, f); }
    for (let g = true; g;) { g = false; for (const p of projs) if (!got.has(p)) { const q = [...got.keys()].find((x) => hits(p, normDep(x.root))); if (q) { got.set(p, got.get(q)); g = true; } } }
    for (const [p, f] of got) for (const e of all) if (e.path.startsWith(normDep(p.root) + '/') && !via.has(e.path) && (!readers || readers.has(e.path))) for (const r of [...e.refs.verifies, ...e.refs.implements]) { if (reqs.includes(r)) continue; if (!affected.has(r)) affected.set(r, new Set()); affected.get(r).add(`${e.id} (${e.path}; project ${p.root} dependsOn ${f})`); }
  }
  for (const [r, v] of projReqs) { if (!affected.has(r)) affected.set(r, new Set()); for (const x of v) affected.get(r).add(x); }
  const sameFeature = [...affected.keys()].filter((r) => ownFeatures.has(reqFeature.get(r)));
  for (const r of sameFeature) affected.delete(r);
  const chain = (f) => { const c = [f]; while (via.get(c[c.length - 1])) c.push(via.get(c[c.length - 1])); return c.join(' ← '); };
  const result = {
    target, reqs, impl: seeds, ...(dataFile ? { dataFile: true, projects: depProjects } : {}), verifiedBy: verifiers.map((e) => e.id), reachedFiles: reached,
    sameFeatureReqs: sameFeature,
    ...(nonCode ? { producers } : {}),
    otherReqs: [...affected].map(([r, v]) => ({ req: r, feature: reqFeature.get(r) ?? null, via: [...v] })),
    reachedTests: reached.filter((f) => entsIn(f).some((e) => e.refs.verifies.length) || TEST_FILE.test(f)),
  };
  if (collect) return result;
  if (flags.json) { out(JSON.stringify(result)); return 0; }
  const lim = flags.all ? Infinity : 8;
  const cap = (a, n = lim) => a.slice(0, n).join(', ') + (a.length > n ? `, … +${a.length - n} more` : '');
  out(`IMPACT ${target}${reqs.length && target !== reqs[0] ? ` (${cap(reqs)})` : ''}`);
  const seedIsTest = seeds.length > 0 && seeds.every((s) => TEST_FILE.test(s) || (entsIn(s).length > 0 && entsIn(s).every((e) => e.kind === 'TEST')));
  if (dataFile || result.otherReqs.length || sameFeature.length) out('  note: impact is file-granular — every REQ annotated in a reached file is listed, even if only one test/function uses the changed file; dependsOn edges are per project, not per language');
  if (dataFile) out(`  data file (outside the import graph); dependent projects (dependsOn): ${depProjects.join(', ') || '(none)'}`);
  const declOnly = dataFile ? depProjects.filter((r) => { const p = projs.find((q) => q.root === r); return p && !referenced(p, seeds0); }) : [];
  if (declOnly.length) out(`  declared dependsOn only (no file mentions ${seeds0}; set projects[].dependsOnMode "referenced" to drop): ${declOnly.join(', ')}`);
  else out(`  ${seedIsTest ? 'test' : 'impl'}: ${seeds.join(', ') || '(none)'}`);
  if (/^REQ-/.test(target) && !seeds.length) {
    const bare = listFiles().filter((f) => { try { return new RegExp('(?:\\/\\/|#|--|/\\*|;)\\s*' + target + '(?![\\w-])').test(fs.readFileSync(path.join(ROOT, f), 'utf8')); } catch { return false; } });
    if (!bare.length) out(`  ! no @implements ${target} found — annotate the implementing code (@id CODE-… @implements ${target}), then run trace`);
    if (bare.length) out(`  ! ${target} is only mentioned in a bare comment (${cap(bare, 3)}) — impact follows \`@id CODE-… @implements ${target}\` markers; add one so its implementation is found`);
  }
  if (nonCode) out(`  producers: ${producers.length ? cap(producers) : '(none found — name the generator in a build.rs/codegen file or a writer that mentions the artifact)'}`);
  if (verifiers.length) out(`  verified by: ${cap(verifiers.map((e) => e.id))}`);
  if (!dataFile) out(`  reaches ${reached.length} file(s) via imports${result.reachedTests.length ? `; tests: ${cap(result.reachedTests)}` : ''}`);
  if (sameFeature.length) out(`  same feature: ${sameFeature.length} other REQ(s) (${sameFeature.slice(0, 4).join(', ')}${sameFeature.length > 4 ? ', …' : ''})`);
  const perFeature = new Map();
  for (const o of result.otherReqs) perFeature.set(o.feature ?? '?', (perFeature.get(o.feature ?? '?') ?? 0) + 1);
  if (perFeature.size) out(`  other features: ${[...perFeature].map(([f, n]) => `${f} (${n})`).join(', ')}`);
  for (const o of result.otherReqs.slice(0, lim)) out(`  ! other feature ${o.req}${o.feature ? ` [${o.feature}]` : ''}: ${o.via.slice(0, 3).join(', ')} — chain ${chain(o.via[0].replace(/^.*\((.*)\)$/, '$1'))}`);
  if (result.otherReqs.length > lim) out(`  … +${result.otherReqs.length - lim} more (all: impact --all)`);
  return 0;
}

async function cmdContext() {
  const { runContext } = await import('./spec-context.mjs');
  const planning = planningSession();
  if (planning.exit) return emitPlanningResult({ ...planning, stage: 'context' }, flags.json);
  return runContext({ ROOT, pos, flags, loadSpecs, loadPlan, changedFiles, workspaceFiles, impactOne,
    planning: planning.enabled ? planning.model : null });
}

/** @id CODE-DIAGFLOW-001 @implements REQ-DIAGFLOW-001 REQ-DIAGFLOW-003 */
async function cmdDiagnostics() {
  const { runDiagnostics } = await import('./diagnostics.mjs');
  return runDiagnostics(process.argv.slice(2));
}

const cmds = { review: cmdReview, init: cmdInit, approve: cmdApprove, guard: cmdGuard, tdd: cmdTdd, trace: cmdTrace, gate: cmdGate, status: cmdStatus, plan: cmdPlan, impact: cmdImpact, context: cmdContext, diagnostics: cmdDiagnostics };
const fn = cmds[pos[0]];
// a mistyped flag (`gate --changd`) must not silently run the full gate (#146)
// known flags = every flags.<name> / flags['<name>'] this script reads
const KNOWN_FLAGS = new Set([...fs.readFileSync(new URL(import.meta.url), 'utf8').matchAll(/\bflags(?:\.([\w-]+)|\['([\w-]+)'\])/g)].map((m) => m[1] ?? m[2]).concat(['help', 'max-bytes']));
const badFlags = Object.keys(flags).filter((k) => !KNOWN_FLAGS.has(k));
if (fn && badFlags.length && pos[0] !== 'diagnostics') {
  out(`unknown flag${badFlags.length > 1 ? 's' : ''}: ${badFlags.map((k) => '--' + k).join(', ')} (known: ${[...KNOWN_FLAGS].map((k) => '--' + k).join(' ')})`);
  process.exit(2);
}
if (!fn) {
  out('usage: sdd.mjs init | review template <feature|--feature f> | review check <file> --feature <f> (or positional feature) | approve prepare|record <feature> | guard | tdd red|green|refactor <TEST-ID> | tdd stub <TEST-ID> [<TEST-ID>... | --all] | tdd check | trace [--baseline] | gate [--changed] [--no-run] | status | plan | impact <REQ|TEST|CODE|file> [--json] | context <feature|REQ|file>... | context --changed [--max-bytes N] [--json]   [--root dir]\n  tdd red: tdd red --characterization "<reason>" records a data-only/characterization test that cannot fail without implementation (weak Red); --expect <text> requires that text in the failure; --allow-setup-red accepts a stub-in-setup Red; --retest "<reason>" re-records a weak Red after correcting a wrong test expectation (needs a previous Red/Green and a changed test); --missing-module accepts a Red caused by the test own not-yet-created import (non-weak); approve record --by ai:<reviewer> needs --review <path|summary>');
  process.exit(2);
}
if (fn && flags.help && !['impact', 'diagnostics'].includes(pos[0])) {
  out(`usage: sdd.mjs ${pos[0]} ${{ gate: '[--changed] [--no-run] [--verbose]', trace: '[--baseline] [--verbose]', context: '<feature|REQ|file>... [--changed] [--max-bytes N] [--json]' }[pos[0]] ?? '(see sdd.mjs --help for all commands)'}`.replace('sdd.mjs gate', 'gate').replace('sdd.mjs trace', 'trace'));
  process.exit(0);
}
if (planningCommand && !planningModules.length) {
  const refusal = standalonePlanningRefusal();
  if (refusal) {
    out(flags.json ? JSON.stringify(refusal) : `SDD PLAN ${refusal.status}: ${refusal.errors[0].reason}`);
    process.exit(refusal.exit);
  }
}
/** @id CODE-PLAN-CLI-006 @implements REQ-PLAN-CLI-004 */
try { process.exitCode = await fn() ?? 0; }
catch (error) {
  if (!/^REFUSED: (?:source scan:|unresolved (?:Rust include (?:oracle|ownership)|pytest_plugins|Python (?:relative import|module)))/.test(error.message)) throw error;
  out(error.message);
  process.exit(1);
}
