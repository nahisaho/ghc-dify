#!/usr/bin/env python3
"""Fail-closed source adaptation of the approved dify-sandbox revision."""
import sys
from pathlib import Path

root = Path(sys.argv[1])

# Shell jobs own 10900..10999; code jobs must never lease the same UID.
pool = root / "internal/core/runner/uidpool/uid_pool.go"
pool_text = pool.read_text()
if pool_text.count("10000, 11000") != 3:
    raise RuntimeError("UID range structure changed")
pool.write_text(pool_text.replace("10000, 11000", "10000, 10900")
                .replace("sandbox%d:x:%d:0:", "sandbox%d:x:%d:1000:"))

# Load immutable standard-library extension modules before the restrictive
# upstream seccomp filter. This does not execute user preload or widen syscalls.
replace_prescript = root / "internal/core/runner/python/prescript.py"
prescript = replace_prescript.read_text()
if prescript.count("{{preload}}") != 1:
    raise RuntimeError("Python bootstrap anchor changed")
replace_prescript.write_text(prescript.replace(
    "{{preload}}", "import json\nimport math\nimport re\nimport datetime\n{{preload}}"))


def replace(path, before, after):
    """Reject source drift instead of silently omitting a security adaptation."""
    file = root / path
    text = file.read_text()
    if text.count(before) != 1:
        raise RuntimeError(f"Upstream anchor mismatch: {path}")
    file.write_text(text.replace(before, after))


# @id CODE-DIFYIMG-103 @implements REQ-DIFYIMG-003
replace(
    "internal/core/runner/python/python.go",
    '''\tif err = syscall.Chown(bootstrapPath, uid, static.SANDBOX_GROUP_ID); err != nil {
\t\tos.Remove(bootstrapPath)
\t\treturn "", fmt.Errorf("chown script to uid %d: %w", uid, err)
\t}''',
    '''\tinfo, err := os.Lstat(bootstrapPath)
\tif err != nil || !info.Mode().IsRegular() || info.Mode().Perm() != 0600 ||
\t\tinfo.Sys().(*syscall.Stat_t).Uid != 0 {
\t\tos.Remove(bootstrapPath)
\t\treturn "", fmt.Errorf("insecure bootstrap")
\t}''',
)
replace(
    "internal/core/runner/python/python.go",
    "\t// create a new process\n",
    '''\tbootstrapReader, err := os.Open(bootstrapPath)
\tif err != nil {
\t\tcodeReader.Close()
\t\tcodeWriter.Close()
\t\tos.Remove(bootstrapPath)
\t\tReleaseUID(uid)
\t\treturn nil, nil, nil, err
\t}
\t// Consume a root-owned 0600 bootstrap before dropping privileges.
\t// FD3 remains the separate, untrusted user-code pipe.
\tdefer bootstrapReader.Close()
\t// create a new process
''',
)
replace("internal/core/runner/python/python.go", "\t\tbootstrapPath,\n", '\t\t"-",\n')
replace(
    "internal/core/runner/python/python.go",
    "\tcmd.Env = []string{}\n",
    "\tcmd.Stdin = bootstrapReader\n\tcmd.Env = []string{}\n",
)
for language, variable in (("python", "outputHandler"), ("nodejs", "output_handler")):
    replace(
        f"internal/core/runner/{language}/{language}.go",
        f"\t{variable} := runner.NewOutputCaptureRunner()\n",
        f"\t{variable} := runner.NewOutputCaptureRunner()\n\t{variable}.SetJobUID(uid)\n",
    )
replace("internal/controller/router.go", '\t\tdependencyRouter.POST("update", UpdateDependencies)\n', "")
replace("internal/controller/router.go", '\t\tdependencyRouter.GET("refresh", RefreshDependencies)\n', "")
# Only the run controller has a Preload field; dependency handlers do not.
file = root / "internal/controller/run.go"
text = file.read_text()
anchor = "\t\tswitch req.Language {\n"
if text.count(anchor) != 4:
    raise RuntimeError("Run-controller structure changed")
file.write_text(text.replace(anchor, '\t\tif req.Preload != "" { c.AbortWithStatus(400); return }\n' + anchor, 1))

file = root / "internal/server/server.go"
text = file.read_text()
start, end = text.index("func initDependencies()"), text.index("func Run()")
text = text[:start] + '''func initDependencies() {
\t// Packages are installed at image build time, never by the root broker.
\tif err := python.PreparePythonDependenciesEnv(); err != nil {
\t\tpanic("sandbox dependency preparation failed")
\t}
}

''' + text[end:]
text = text.replace('\n\t"time"', "").replace("go initDependencies()", "initDependencies()")
file.write_text(text)
