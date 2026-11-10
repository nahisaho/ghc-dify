---
name: agent-watchdog
description: Use when background agents (task with mode background) are running long jobs and may go idle before finishing: detect stalled agents every few minutes and resume them with a continue instruction. バックグラウンドエージェントが未完了のまま停止していないかを定期確認し、停止していれば続行を指示するときに使用。
---

# agent-watchdog

**Copilot-only:** this workflow requires Copilot CLI agent and scheduling tools.
It is not supported in Claude Code; `init --host claude` omits it.

Background agents often end their turn (status `idle`) with work left. Repo code cannot message agents; only the Copilot CLI session can (`write_agent`). So: a read-only detector script plus this procedure.

## Detector

```bash
node .github/skills/agent-watchdog/scripts/watchdog.mjs <workspace-dir>... [--stale-min 10] [--done-glob 'findings/*.md']
```

JSON per directory: `idleMinutes` (since the newest file change, ignoring `.git`, `node_modules`, `target`, caches), `done` (a file matching `--done-glob` exists), `stale` (not done and idle > `--stale-min`). Exit 0 = all active/done, 1 = some stale, 2 = bad input or missing dir.

## Procedure

1. Schedule it: `manage_schedule` action `create`, `interval: 5m`, prompt = "run the watchdog on the agents' workspaces, cross-check `list_agents`, resume stalled agents".
2. Each tick:
   - `list_agents` (`include_completed: false`, `scope: children`) and note agents in **Idle** that belong to the current batch.
   - Run the detector on their workspaces.
3. For each idle agent whose last reply did NOT state that all work is done (`read_agent`, no wait), `write_agent` this message:
   "Continue now and finish ALL remaining work without stopping; list what remains if blocked. Reply (<=8 lines) only when everything is done."
4. Leave alone: agents that reported completion, `done: true` workspaces, and agents from earlier batches.
5. Cap at 3 continue messages per agent; after that report it to the user instead of looping.
6. Stop the schedule (`manage_schedule` action `stop`) when every agent in the batch is done.

## Limits

An agent that is running but stuck in a long command still looks active to the agent list; the detector's `idleMinutes` is what exposes it. A workspace edited by something else counts as activity.
