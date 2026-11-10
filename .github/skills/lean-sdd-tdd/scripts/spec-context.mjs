import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { planningFeatureClosure } from './implementation-plan-cli.mjs';
import { containedPlanningPath } from './implementation-plan.mjs';

/** @id CODE-SPECCTX-001 @implements REQ-SPECCTX-001 REQ-SPECCTX-002 REQ-SPECCTX-003 REQ-SPECCTX-004 REQ-SPECCTX-005 */
export function runContext({ ROOT, pos, flags, loadSpecs, loadPlan, changedFiles, workspaceFiles, impactOne, planning = null }) {
  const SDD = path.join(ROOT, '.sdd'), SPECS = path.join(SDD, 'specs');
  const rel = (file) => path.relative(ROOT, file).split(path.sep).join('/');
  const refuse = (message) => { throw new Error(`CONTEXT REFUSED: ${message}`); };
  function containedFile(file) {
    const absolute = path.resolve(ROOT, file.replace(/\\/g, '/'));
    const inside = (base, candidate) => {
      const relative = path.relative(base, candidate);
      return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
    };
    if (!inside(ROOT, absolute)) refuse('path outside root; specify an in-root feature/file');
    if (!fs.existsSync(absolute)) refuse('missing file; specify an existing feature/file');
    if (!inside(fs.realpathSync(ROOT), fs.realpathSync(absolute))) refuse('symlink outside root');
    if (!fs.statSync(absolute).isFile()) refuse('selector/artifact must be a regular file');
    return rel(absolute);
  }
  function selection() {
    if (fs.existsSync(SPECS)) {
      for (const file of fs.readdirSync(SPECS).filter((f) => f.endsWith('.md'))) containedFile(path.join(SPECS, file));
    }
    const specs = loadSpecs();
    const byFeature = new Map(), byReq = new Map(), byPath = new Map();
    for (const spec of specs) {
      if (byFeature.has(spec.feature)) refuse('duplicate feature definition');
      byFeature.set(spec.feature, spec);
      byPath.set(spec.path, spec);
      for (const req of spec.reqs) {
        if (byReq.has(req.id)) refuse('duplicate REQ definition');
        byReq.set(req.id, spec);
      }
    }
    if (!planning && fs.existsSync(path.join(SDD, 'plan.md'))) containedFile('.sdd/plan.md');
    const plan = planning ? null : loadPlan();
    if (plan && (!plan.length || plan.bad?.length || plan.some((row) => !row.feature))) refuse('malformed plan rows');
    const deps = new Map();
    for (const row of plan ?? []) {
      if (deps.has(row.feature)) refuse('duplicate plan feature');
      deps.set(row.feature, row.deps);
    }
    const selected = new Set(), active = new Set();
    const include = (feature) => {
      if (planning) {
        for (const id of planningFeatureClosure(planning, [feature])) {
          if (!byFeature.has(id)) refuse('missing prerequisite spec');
          selected.add(id);
        }
        return;
      }
      if (active.has(feature)) refuse('plan dependency cycle');
      if (selected.has(feature)) return;
      if (!byFeature.has(feature)) refuse('missing prerequisite spec');
      active.add(feature);
      for (const dependency of deps.get(feature) ?? []) include(dependency);
      active.delete(feature);
      selected.add(feature);
    };
    const targets = [...pos.slice(1)];
    if (flags.changed) {
      const changed = changedFiles();
      if (!changed || !changed.size) refuse('--changed needs Git and a non-empty change set; specify a feature/REQ instead');
      targets.push(...[...changed].sort());
    }
    if (!targets.length) refuse('usage: context <feature|REQ|file>... | --changed [--max-bytes N] [--json]');
    let checkedWorkspace = false;
    for (const target of targets) {
      if (byFeature.has(target) && byReq.has(target) && byFeature.get(target) !== byReq.get(target)) refuse('ambiguous feature and REQ selector; use a spec path');
      const named = byFeature.get(target) ?? byReq.get(target);
      const absolute = path.resolve(ROOT, target.replace(/\\/g, '/'));
      const exists = fs.existsSync(absolute);
      if (named) {
        if (exists && rel(absolute) !== named.path) refuse('ambiguous feature/REQ and file selector; use a spec path');
        include(named.feature);
        continue;
      }
      const file = containedFile(target);
      if (byPath.has(file)) { include(byPath.get(file).feature); continue; }
      const canonical = planning ? rel(containedPlanningPath(ROOT, file)) : file;
      const owners = planning?.owners[canonical] ?? [];
      for (const id of owners) include(planning.tasks.find(task => task.id === id).feature);
      if (!checkedWorkspace) {
        for (const source of workspaceFiles()) containedFile(source);
        checkedWorkspace = true;
      }
      const impact = impactOne(file, true);
      if (typeof impact !== 'object') refuse('file impact could not be resolved; specify a feature/REQ');
      const reqs = new Set([...impact.reqs, ...impact.sameFeatureReqs, ...impact.otherReqs.map((r) => r.req)]);
      if (!reqs.size && !owners.length) refuse('file has no known owning/impacted requirements; specify a feature/REQ');
      for (const req of reqs) {
        if (!byReq.has(req)) refuse('impact references an undefined REQ');
        include(byReq.get(req).feature);
      }
    }
    return { specs, selected: [...selected].sort().map((feature) => byFeature.get(feature)) };
  }
  try {
    if (Object.keys(flags).some((flag) => !['root', 'changed', 'json', 'max-bytes', 'help'].includes(flag))) refuse('unsupported context flag');
    const limit = flags['max-bytes'] === undefined ? 16384 : typeof flags['max-bytes'] === 'string' && /^[1-9]\d*$/.test(flags['max-bytes']) ? Number(flags['max-bytes']) : NaN;
    if (!Number.isSafeInteger(limit) || limit <= 0) refuse('--max-bytes must be a positive safe integer');
    const { specs, selected } = selection();
    const files = new Map();
    const features = selected.map((spec) => {
      const owned = planning?.tasks.filter(task => task.feature === spec.feature).flatMap(task => task.artifacts) ?? [];
      const paths = [...new Set([...spec.artifacts, ...owned].map((file) => containedFile(file)))].sort();
      for (const file of paths) if (!files.has(file)) {
        const bytes = fs.readFileSync(path.join(ROOT, file));
        files.set(file, { path: file, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, text: bytes.toString('utf8') });
      }
      return { feature: spec.feature, paths };
    });
    const payload = {
      kind: 'reading-context',
      notice: 'Reading context only, not validation or approval evidence. File impact is static, file-granular and language-limited; undeclared relationships require explicit selectors. Run the full gate before merge.',
      totalSpecs: specs.length,
      features,
      files: [...files.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
      ...(planning ? { planning: { enabled: true, stage: 'context', status: 'PASS', exit: 0,
        taskIds: planning.tasks.filter(task => features.some(feature => feature.feature === task.feature)).map(task => task.id).sort(),
        reqs: [...new Set(selected.flatMap(spec => spec.reqs.map(req => req.id)))].sort() } } : {}),
    };
    const rendered = flags.json ? JSON.stringify(payload) + '\n' : [
      `CONTEXT ${features.length}/${specs.length} specs`,
      payload.notice,
      ...payload.files.map((file) => `\n## ${file.path} sha256:${file.sha256}\n${file.text}`),
    ].join('\n') + '\n';
    const required = Buffer.byteLength(rendered);
    if (required > limit) {
      console.log(`CONTEXT OVER BUDGET required=${required} limit=${limit}; no spec bodies emitted`);
      console.log('Narrow selectors or explicitly raise --max-bytes; feature sizes (source UTF-8 bytes):');
      for (const feature of features.slice(0, 10)) console.log(`  ${JSON.stringify(feature.feature).slice(0, 120)}: ${feature.paths.reduce((sum, file) => sum + files.get(file).bytes, 0)}`);
      if (features.length > 10) console.log(`  ... ${features.length - 10} more feature(s)`);
      return 2;
    }
    fs.writeFileSync(process.stdout.fd, rendered);
    return 0;
  } catch (error) {
    if (!error.message.startsWith('CONTEXT REFUSED:')) throw error;
    console.log(error.message);
    return 2;
  }
}
