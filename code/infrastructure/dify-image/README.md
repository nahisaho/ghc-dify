# Dify 1.19.0 in one local container

One Linux/WSL2 x86_64 image runs Dify, PostgreSQL/pgvector, Redis, signed plugins, native MCP, agent services and public-key-only development SSH. Native processes share one supervisor; no Compose, nested Docker, host Docker socket or privileged container is used.

New users should start with the [Japanese setup guide](../../../docs/setup.ja.md). This document covers image internals and qualification. Last updated: 2026-11-10.

The [approved specification](../../../.sdd/specs/dify-image.md) defines the security contract. This is a local development environment, not a hostile-code security boundary. Preparing source publication does not authorize distribution of the built image.

## Prerequisites

- Linux/WSL2 x86_64, Docker access and host Python 3.10+; Node 24 for qualification.
- Internet access for pinned upstream images, packages and signed plugin installation.
- An existing regular public SSH key file, such as `$HOME/.ssh/id_ed25519.pub`, with ordinary key lines and readable permissions (normally `0644`). A `0600` file owned by a nonroot host user is not readable by container root without DAC-bypass privileges. Never mount a private key.
- Substantial build/export headroom: the image is approximately 6 GiB, excluding shared layers and build cache. The guard measures workspace and Docker-root filesystems separately; 3 GiB is a hard stop floor, not a sufficient build-space estimate.
- Run the commands from the root of your clone of `https://github.com/nahisaho/ghc-dify`. Use `python3` if your environment has no `python` command.

## Build and open the local setup page

```bash
python code/infrastructure/dify-image/guard.py doctor
python code/infrastructure/dify-image/guard.py build --target runtime --tag okayama-u/dify-allinone:1.19.0-local
python code/infrastructure/dify-image/guard.py run \
  --tag okayama-u/dify-allinone:1.19.0-local \
  --authorized-keys "$HOME/.ssh/id_ed25519.pub" \
  --volume okayama-u-dify-data --name okayama-u-dify --owner local-dify-image
docker inspect --format '{{.State.Health.Status}}' okayama-u-dify
```

Wait for `healthy`; cold startup includes database initialization and Dify migrations. Health checks cover all 15 roles. Open <http://localhost:8080/install> and create your own administrator account; no account or password is seeded. A setup page is not proof that all roles are healthy.

| Default | Purpose |
|---|---|
| `127.0.0.1:8080` → `80` | Dify web/API/native MCP |
| `127.0.0.1:2222` → `22` | SSH as `dev`, public key only |
| `okayama-u-dify-data` → `/data` | Databases, storage, workspaces, dev home, runtime keys and SSH hostkeys |

The wrapper refuses an existing data volume with a different ownership label. Do not bypass that check or attach a volume containing unrelated data.

## Use the persistent development home

```bash
ssh -p 2222 dev@localhost
node --version
npm --version
nvm --version
copilot
```

In Copilot, run `/login` yourself. No host Copilot token is imported. Its dedicated home persists in `/data`; treat that volume as sensitive after login. Installed defaults are Node 24.22.1, npm 11.19.1, nvm 0.41.0 and Copilot CLI 1.0.106. The dev user cannot read service credential directories.

Use the matching local private key with `ssh -i` when it is not a default identity; for example, `ssh -i "$HOME/.ssh/gmail_rsa" -p 2222 dev@localhost` when `gmail_rsa.pub` was mounted. An encrypted key's passphrase is entered only in the local SSH client. Never mount that private key or share its passphrase.

For access from another PC, tunnel through SSH on the Docker host; do not change Docker's loopback bindings:

```bash
ssh -N -L 8080:127.0.0.1:8080 -L 2222:127.0.0.1:2222 HOST_USER@HOST
```

This requires a separately configured host SSH service. Then use the same local browser and container SSH endpoints on the client PC.

## Publish a native MCP workflow privately

Create and publish a workflow, enable its native MCP server, and store its generated credential-bearing URL only in a private MCP client configuration. No third-party MCP server is needed. Never paste the URL into logs, screenshots or issues. Rotate or disable it through Dify when needed.

The qualification workflow needs no LLM provider: a Code node returns `{"answer":"DIFY_IMAGE_OK"}`. Real LLM apps and production embeddings still need their own provider configuration and credentials.

## Recreate without replacing data

```bash
docker stop --time 30 okayama-u-dify
docker rm okayama-u-dify
python code/infrastructure/dify-image/guard.py run \
  --authorized-keys "$HOME/.ssh/id_ed25519.pub" \
  --volume okayama-u-dify-data --name okayama-u-dify --owner local-dify-image
```

Keep the volume and the same public key file. Credentials and SSH hostkeys are not regenerated on an existing installation. Missing, truncated, symlinked, misowned or insecure credential files must fail closed; restore a consistent trusted backup rather than deleting initialization markers or attempting automatic key repair. Stop the container before backing up the whole sensitive volume.

Shell jobs commit home changes through a copied, synced `home.next` and a recoverable `home.previous` rename. After a container crash, incomplete copies are discarded and the last committed home is retained. Only validated root-owned UUID trees under `/run/dify/shell-roots` are reclaimed, after confirming the old job UID is gone. FIFO/socket workspace nodes are discarded without following them; ordinary job/IPC errors return a job failure, not a stack failure. Unsafe ownership, symlinked recovery directories or uncertain cleanup still fail closed. Recovery never repairs credential seals or reconstructs an already missing home and backup.

## Reproduce qualification

```bash
node --test code/infrastructure/dify-image/tests/requirements.test.mjs
python3 -m unittest discover -s code/infrastructure/dify-image/tests -p fixture_workspace_test.py
```

These commands run behavioral tests from a fresh clone. Build the image first and provide Node 24 and a `python` command for the host Python. If only `python3` exists, use a personal virtual environment or equivalent to make `python` available. Temporary test keys and state are stored in `~/.cache/ghc-dify/validation`; do not publish that directory. Do not run qualification concurrently under the same user.

SDD approval records and the Red→Green ledger are excluded from publication. Therefore, a fresh clone cannot reproduce the development ledger's verdict with `node .github/skills/lean-sdd-tdd/scripts/sdd.mjs gate`. Running the SDD gate requires obtaining new specification approval and test evidence in that clone. Passing behavioral tests is distinct from passing the SDD gate.

Native tests create synthetic local accounts and label-owned fixtures on Docker-assigned ephemeral loopback ports; do not point them at your own data. The real wrapper's default `8080`/`2222` bindings are still asserted separately, without disturbing a running deployment. Tests exercise actual protocols, not just file patterns, and reject missing scenarios. Independent role-failure tests intentionally stop their own containers. Layer auditing also needs additional headroom of the image size plus 3 GiB.

Qualification on 2026-11-06: **6/6 Red→Green and full SDD gate PASS**. Its native test command ran all six scenarios exactly once in 782.6 seconds. Checks include all 15 native readiness probes and independent role failures, signed-plugin/two-document RAG retrieval (21 assertions), native MCP (17 assertions), job isolation, SSH/tooling, data/home/key persistence, 100 restored corruption controls and interrupted-bootstrap refusal. Review regressions also cover 20 isolated shell recovery/error cases and a real active-job container kill/start with unchanged credential seals; five bounded mutants were detected.

That prior qualification used image ID `sha256:d780c3212a07a2183026b5438c746cb3e4c136f664ea771fd08a920fce57e767` (5.72 GiB). Requalification on 2026-11-07: **6/6 Red→Green and full SDD gate PASS**, all six native scenarios exactly once in 778.7 seconds; Ruff/mypy checked 31 Python files. The SSH-fixed candidate `okayama-u/dify-allinone:1.19.0-local` is ID `sha256:5fce6019e1636bf88a693d2eaedd897a9dcf6fd945a8dfa198ee331a005f3849` (6,155,305,306 bytes, 5.73 GiB). Ed25519/RSA command, forced-PTY and real interactive-login controls passed with empty dev capabilities and invalid-auth rejection; non-login `python3`/Node/npm/Copilot resolution also passed. Its PATH regression detected the restored earlier implementation in 1.953 seconds and accepted the fixed image in 3.212 seconds. No registry digest exists because it has not been published.

The current audit covers all 40 logical layers (39 unique blobs), including empty and deleted lower-layer contents. Only 19 exact public cryptographic self-test artifact path/hash pairs are qualified in `tests/secrets_checks.py`, following independent source verification. Changed fixtures, unqualified private keys and runtime credentials remain rejected. All 14 installed Python runtime-source hashes match the previously reviewed files. Technical gate success is not independent final review or publication approval.

## Security boundaries and remaining limitations

- **SSH Linux-audit limitation:** the Debian Linux-audit backend fatally terminated PTY login without `AUDIT_WRITE`. The three server executables are rebuilt from OpenSSH `10.0p1` with the complete Debian `1:10.0p1-7+deb13u4` security patchset and the recognized `--without-audit` switch. They do not submit host-kernel Linux audit records, and no audit success is fabricated. Normal SSH logging and the existing public-key/UID/capability policy remain unchanged; `AUDIT_WRITE`, `FOWNER` and DAC-bypass privileges are not added. A host requiring Linux-audit integration is outside this candidate's supported observability contract.
- Configure uses `--enable-option-checking=fatal`, so unsupported options fail the build. Build assertions reject Linux/BSM/debug audit macros and require `USE_PAM` and `WITH_SELINUX`. The earlier `--without-linux-audit` spelling was not recognized upstream; it is not used in this candidate.
- The original packaged non-login SSH PATH is explicitly preserved with `--with-default-path=/usr/local/bin:/usr/bin:/bin:/usr/games` and Debian's `--with-superuser-path=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`. This keeps `python3`, Node, npm and Copilot available to remote commands that do not source a login profile; it does not enable root SSH login.
- Source archives are fetched from `https://deb.debian.org/debian/pool/main/o/openssh/` and SHA-256 checked before applying every entry of `debian/patches/series`: `openssh_10.0p1.orig.tar.gz` → `021a2e709a0edf4250b1256bd5a9e500411a90dddabea830ed59cef90eb9d85c`; `openssh_10.0p1-7+deb13u4.debian.tar.xz` → `102e1065030c6002acabd7f896eeba1462bf54b4d7393bac34b0308312868ec6`. Configure retains `--with-pam`, `--with-selinux`, privilege-separation user `sshd` and root `/run/sshd`; effective `UsePAM no` is unchanged. The captured compiler output confirms PIE, stack protector, FORTIFY, RELRO/NOW and non-executable-stack flags. Only `sshd`, `sshd-session` and `sshd-auth` replace their packaged server binaries; clients and runtime configuration are unchanged.
- Services have separate nonroot identities. Trusted initialization, sshd and narrowly privileged sandbox/shell launchers are explicit root exceptions. Executed jobs must have separate UIDs, GID 1000, no supplementary groups, empty capabilities, NoNewPrivs and seccomp; private roots exclude `/data`.
- Default container capabilities are only `CHOWN`, `SETUID`, `SETGID`, `KILL`, `SYS_CHROOT`; brokers reduce to four without `KILL`. No `FOWNER`, `SYS_ADMIN`, network-admin, ptrace or DAC-bypass capability is enabled.
- Network/PID namespaces remain shared. There is no per-service network isolation, forced egress policy, exclusive port ownership or hostile-plugin containment. The required low-port sysctl lets all nonroot roles bind low ports.
- Python Code nodes use Dify's network-enabled execution mode; this is not a network-disabled sandbox guarantee. True interactive PTY behavior for agent shell jobs is not qualified.
- Copilot version checks and synthetic home persistence passed; actual user OAuth login and token refresh were not exercised.
- Qualification uses the current Linux Docker host; deployment on a user's Windows/WSL2 installation remains unqualified.
- Initialization, migrations and all-role readiness share one 300-second budget. Slow first runs, including slow WSL storage, may exceed it; the wrapper's 330-second wait does not extend that budget. Do not delete the data volume to hide a startup failure.
- Host/Docker administrators and trusted container root can access persistent secrets; no at-rest encryption is promised.
- Official images/source and major tools are pinned, but all transitive apt packages are not locked. The RAG oracle uses a test-only deterministic embedding endpoint, not evidence of real-model retrieval quality.
- Preserve upstream licenses and review redistribution obligations before sharing an image. Independent review of the SSH-fixed candidate left no blocking code findings; this is not a license review or distribution approval. No registry push or release has been performed.
