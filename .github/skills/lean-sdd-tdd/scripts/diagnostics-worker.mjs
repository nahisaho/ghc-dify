import { diagnoseTypeScript } from './diagnostics-typescript.mjs';
import { diagnoseESLint } from './diagnostics-eslint.mjs';
import { providerFailure } from './diagnostics.mjs';
import { nativeBudget } from './diagnostics-native.mjs';

/** @id CODE-DIAGCLI-002 @implements REQ-DIAGCLI-004 REQ-DIAGCLI-005 */
const [source, root, profile = 'typescript', scratch, limitsJSON] = process.argv.slice(2);
try {
  const limits = limitsJSON ? JSON.parse(limitsJSON) : { deadline: Date.now() + 60000, outputBytes: 8388608 };
  const budget = nativeBudget({ timeoutMs: Math.max(0, limits.deadline - Date.now()), outputBytes: limits.outputBytes });
  const result = source === 'typescript' ? await diagnoseTypeScript(root)
    : source === 'eslint' ? await diagnoseESLint(root, { profile })
    : ['ruff', 'mypy'].includes(source) ? await (await import('./diagnostics-python.mjs')).diagnosePython(root, source, budget)
    : source === 'cargo-check' ? await (await import('./diagnostics-rust.mjs')).diagnoseRust(root, scratch, budget)
    : providerFailure(source, 'Unknown diagnostic provider');
  process.stdout.write(JSON.stringify(result), () => process.exit(0));
} catch (error) {
  process.stdout.write(JSON.stringify(providerFailure(source, `Provider failed: ${error.message}`)), () => process.exit(0));
}
