# @id CODE-DIAGPY-002 @implements REQ-DIAGPY-001 REQ-DIAGPY-002 REQ-DIAGPY-004 REQ-DIAGPY-005
import sys
import json
import os


def fail(message):
    print(json.dumps({"error": message}))
    raise SystemExit(2)


if sys.version_info[:2] != (3, 14) or sys.version_info.releaselevel != "final":
    fail("Unsupported Python version; Python 3.14.x is required")

import configparser
import importlib.metadata
import importlib.util
import re
import runpy
import sysconfig
import tokenize
import tomllib

root, source, action = sys.argv[1:4]
venv = os.path.realpath(os.path.join(root, ".venv"))
if os.path.realpath(sys.prefix) != venv or venv == os.path.realpath(sys.base_prefix):
    fail("Python must belong to the selected root .venv")
sites = list(dict.fromkeys(sysconfig.get_path(name) for name in ("purelib", "platlib")))
for directory in sites:
    if os.path.commonpath((venv, os.path.realpath(directory))) != venv:
        fail("Python site-packages must belong to root .venv")
sys.path[:0] = sites
expected = {"ruff": "0.17.1", "mypy": "2.4.0"}[source]
distributions = [
    item for item in importlib.metadata.distributions(path=sites)
    if item.metadata["Name"].lower() == source
]
if len(distributions) != 1 or distributions[0].version != expected:
    fail("Missing or unsupported " + source + " package; required version " + expected)
spec = importlib.util.find_spec(source)
if spec is None or spec.origin is None or not any(
    os.path.commonpath((directory, os.path.abspath(spec.origin))) == directory
    for directory in sites
):
    fail(source + " entry must come from root .venv")


def config_path():
    names = [".ruff.toml", "ruff.toml", "pyproject.toml"] if source == "ruff" else [
        "mypy.ini", ".mypy.ini", "pyproject.toml", "setup.cfg"
    ]
    for name in names:
        file = os.path.join(root, name)
        if not os.path.exists(file):
            continue
        if name == "pyproject.toml":
            with open(file, "rb") as handle:
                config = tomllib.load(handle)
            if source not in config.get("tool", {}):
                continue
        elif name in ("setup.cfg", "mypy.ini", ".mypy.ini"):
            config = configparser.ConfigParser()
            with open(file, encoding="utf-8") as handle:
                config.read_file(handle)
            if name == "setup.cfg" and not config.has_section("mypy"):
                continue
        return file
    return None


try:
    if action == "probe":
        print(json.dumps({"version": expected, "configPath": config_path()}))
    elif action == "mypy-select":
        from mypy.main import process_options
        from mypy.find_sources import InvalidSourceList
        request = json.load(sys.stdin)
        base = request["args"]
        mandatory = [r"(^|/)(\.git|\.venv)(/|$)"]
        mandatory += [
            r"^(?:" + re.escape(root.replace(os.sep, "/")) + r"/|\./)?" + re.escape(name) + r"(/|$)"
            for name in request["symlinkDirectories"]
        ]
        args = base + ["--exclude", "|".join("(?:" + expression + ")" for expression in mandatory), "."]
        try:
            sources, unused = process_options(args)
            paths = [item.path for item in sources]
            selection_error = None
        except (InvalidSourceList, SystemExit) as error:
            paths = None
            selection_error = str(error)
        print(json.dumps({"args": args, "paths": paths, "selectionError": selection_error}))
    elif action == "locations":
        result = []
        for file, line in json.load(sys.stdin):
            with tokenize.open(file) as handle:
                lines = handle.read().split("\n")
            if not 0 < line <= len(lines):
                raise ValueError("Diagnostic line is outside source: " + file)
            result.append(lines[line - 1])
        print(json.dumps(result))
    elif action == "tool":
        sys.argv = [source] + json.load(sys.stdin)["args"]
        runpy.run_module(source, run_name="__main__", alter_sys=True)
    else:
        fail("Unknown Python diagnostic bridge action")
except (OSError, ValueError, configparser.Error, importlib.metadata.PackageNotFoundError) as error:
    fail(type(error).__name__ + ": " + str(error))
