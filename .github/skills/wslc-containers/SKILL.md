---
name: wslc-containers
description: Manage Linux containers on Windows using the built-in WSL container CLI (wslc.exe), without Docker Desktop. Use this when asked to build, run, list, inspect, stop, or otherwise operate containers via WSL/wslc from a Copilot CLI or Claude Code session running inside WSL.
---

# WSL Container (`wslc`) Operations

This skill lets the agent operate Linux containers through the native WSL container
feature (`wslc.exe`), which ships with WSL version 2.9.3 or later and requires no
Docker Desktop installation. It works from a bash shell running inside a WSL
distribution by invoking the Windows-side `wslc.exe` binary through the `/mnt/c`
interop mount.

## Prerequisites

- Windows host has WSL >= 2.9.3 (check with `wsl.exe --version` from inside WSL,
  or `wsl --version` from PowerShell). Update with `wsl --update` if needed.
- The WSL container feature is installed (ships by default with recent WSL; if
  missing, instruct the user to run `wsl --install` or update WSL).
- This repo's bundled wrapper script resolves the `wslc.exe` path automatically.

## How to invoke `wslc`

Always use the bundled wrapper script instead of guessing paths directly, since
`wslc.exe` normally lives under a path containing spaces
(`/mnt/c/Program Files/WSL/wslc.exe`):

```bash
bash "<skill-dir>/scripts/wslc.sh" <command> [args...]
```

Resolve `<skill-dir>` to this loaded skill's directory, such as
`.github/skills/wslc-containers` or `.claude/skills/wslc-containers`;
do not assume that either directory exists in every installation.
Use the host's shell tool (Copilot CLI shell/bash or Claude Code Bash) and
normal permission prompts; this skill does not grant command permissions.

The wrapper searches, in order:
1. The default install path (`/mnt/c/Program Files/WSL/wslc.exe`)
2. Common Program Files locations under `/mnt/c`
3. `cmd.exe /c "where wslc.exe"` as a last resort

If it cannot find `wslc.exe`, it prints guidance to run `wsl --update` and exits
non-zero — surface that message to the user rather than retrying blindly.

## wslc は Docker ではない (Docker との主な違い)

`wslc` は Docker 風のサブコマンドを持つが、互換ではない。Docker の知識で推測せず、
不明な場合は `wslc <command> -?` で確認する (`--help` ではなく `-?` が基本)。
`wslc 3.0.3.0` で検証済みの差異:

- `docker ps` 相当は `wslc list` / `wslc ls` / `wslc ps` (`-a`, `-q`, `--format json|table`)。
  `wslc container ps` も可。`--format` は `json` か `table` のみ (Go テンプレート不可)。
- `wslc inspect <name>` は JSON のみ。`-f json` は単一行出力で、Go テンプレートは使えない。
  値の抽出は `python3`/`jq` で行う。
- `wslc remove` (alias `rm`, `delete`)、`wslc rmi` / `wslc image remove`。
- `docker compose`、`docker-compose`、Swarm、`docker network create --attachable` 等は無い。
- 既定ネットワークは `bridge` / `host` / `none` のみ (`wslc network ls`)。
- `wslc build` は `-t/--tag`, `-f`, `--build-arg`, `--target`, `--no-cache`, `--secret`,
  `-o` を持つ。`<path>` が必須。
- `run` は `--network`, `--network-alias`, `--ip`, `--hostname`, `--dns`, `-p`, `-v`,
  `--mount`, `--health-cmd` などを持つ。`--link` は `run` には無く、`network connect` にのみある。
- `--session <name>` がグローバルオプション。セッションが異なるとコンテナー/ネットワークは別物。

## Common operations

Run these through the wrapper script shown above (replace `wslc` with
`bash "<skill-dir>/scripts/wslc.sh"`):

```bash
# Show version / general info
wslc version
wslc info

# Images
wslc images                     # or: wslc image list
wslc pull <image>              # e.g. wslc pull docker.io/library/alpine:latest
wslc build -t <tag> <path>      # build from a Dockerfile
wslc rmi <image>

# Containers
wslc run --rm -it <image> <cmd...>
wslc run -d --name <name> -p <hostPort>:<containerPort> <image>
wslc list -a                    # or: wslc ps -a
wslc exec <container> <cmd...>
wslc logs <container>
wslc stop <container>
wslc restart <container>
wslc remove <container>         # -f to force

# Networks / volumes
wslc network list
wslc network create|inspect|remove|connect|disconnect|prune
wslc volume list
```

## コンテナー間通信 (container A → container B)

検証結果 (wslc 3.0.3.0):

| 条件 | 名前解決 | IP 到達 |
|---|---|---|
| 同じユーザー定義ネットワーク | ✅ コンテナー名・`--network-alias` | ✅ |
| 既定 `bridge` 同士 | ❌ (`bad address`) | ✅ (172.17.0.x) |
| 異なるネットワーク間 | ❌ | ❌ (分離される) |

**結論: 名前で接続するには、ユーザー定義ネットワークを作り、両方を同じネットワークに参加させる。**
既定 `bridge` は名前解決できない。

### 名前で接続 (推奨)

```bash
wslc network create appnet

# B: サーバー (エイリアス svc-b も付与できる)
wslc run -d --name b --network appnet --network-alias svc-b <imageB>

# A: クライアント。b または svc-b で接続
wslc run -d --name a --network appnet <imageA>
wslc exec a ping -c1 b
wslc exec a ping -c1 svc-b
wslc exec a wget -qO- http://b:<port>/    # アプリのポートは EXPOSE/-p 不要
```

- コンテナー間通信は同一ネットワーク内なら公開ポート指定 (`-p`) 不要。`-p` はホスト→コンテナー用。
- 作成済みコンテナーを後から参加させる: `wslc network connect [--network-alias <alias>] appnet <container>`
  (引数順は `<network-name> <container-id>`。`--ip`, `--link name:alias` も可)。
- 切り離し: `wslc network disconnect appnet <container>`。

### IP で接続

```bash
# IP の取得 (JSON のみ。テンプレート不可)
wslc inspect b -f json | python3 -c \
  'import json,sys;print(json.load(sys.stdin)[0]["NetworkSettings"]["Networks"]["appnet"]["IPAddress"])'
wslc exec a ping -c1 <IP>
```

IP は再作成で変わるため、固定したい場合はサブネットを指定して `--ip` を使う:

```bash
wslc network create --subnet 10.55.0.0/24 --gateway 10.55.0.1 fixednet
wslc run -d --name b --network fixednet --ip 10.55.0.50 <imageB>
```

`--ip` は `--subnet` 付きで作成したユーザー定義ネットワークでのみ使うこと。
同一ネットワーク内の別コンテナーから `10.55.0.50` で到達できる。

### 補足

- 外部アクセスを遮断したい場合は `wslc network create --internal <name>`。
- ネットワーク削除はコンテナー削除後に `wslc network remove <name>`。
- 既存の別プロジェクトのコンテナーに影響しないよう、ネットワーク/コンテナー名は
  用途固有にし、後始末 (`stop` → `remove` → `network remove`) を行う。

## オフライン構成 (外部ネットワークに出られない場合)

wslc 3.0.3.0 では、コンテナー VM から外部へ接続できない環境がある
(`wslc pull docker.io/library/node:...` が `network is unreachable` / `E_FAIL`、
コンテナー内の `wget`/`ping` も失敗する。`wslc build` の `FROM` や `apk add`/`npm install` も同様)。
その場合は公式イメージの取得やビルド中のダウンロードを前提にせず、次の方針に切り替える。
先に接続を確認する: `wslc run --rm docker.io/library/alpine:latest wget -q -T5 -O- https://registry-1.docker.io/v2/`
が `401 Unauthorized` なら届いている (一時的な失敗なので `pull`/`build` を再試行する)。
届かなければ `wsl --shutdown` で VM を再起動して再試行し、それでも駄目な場合だけ切り替える。

1. `wslc images` で取得済みのローカルイメージ (例: `alpine:latest`) を確認し、それを `FROM` にする。
2. ランタイム (例: Node.js) は**ホスト側で用意して COPY** する。検証済みの方法 (glibc 版):
   ```bash
   mkdir -p .stage/usr/local/bin .stage/lib64 .stage/usr/lib/x86_64-linux-gnu
   cp -L "$(which node)" .stage/usr/local/bin/node
   for l in $(ldd "$(which node)" | awk '/=>/{print $3}'); do cp -L "$l" .stage/usr/lib/x86_64-linux-gnu/; done
   cp -L /lib64/ld-linux-x86-64.so.2 .stage/lib64/
   cp -L /lib/x86_64-linux-gnu/lib{resolv.so.2,nss_dns.so.2,nss_files.so.2} .stage/usr/lib/x86_64-linux-gnu/
   ```
   ```dockerfile
   FROM alpine:latest
   COPY .stage/ /
   COPY app /app
   WORKDIR /app
   ENV LD_LIBRARY_PATH=/usr/lib/x86_64-linux-gnu
   ```
   `wslc build -t <tag> .` 後に `wslc run --rm <tag> node -v` で確認する。
   ビルド用の `.stage/` は後で削除する。
3. musl 版 Node を使う場合は、ホストで取得した `libstdc++`/`libgcc` の apk を一緒に載せる
   (`alpine` に `libstdc++` は含まれず、無いと `symbol not found`)。検証済みの方法 (wslc 3.0.3.0、ベース `python:3.13-alpine`):
   ```bash
   v=$(node -v)
   curl -fLO https://unofficial-builds.nodejs.org/download/release/$v/node-$v-linux-x64-musl.tar.xz
   mkdir -p x .stage/usr/local/bin && tar -xJf node-$v-linux-x64-musl.tar.xz -C x --strip-components=1
   cp x/bin/node .stage/usr/local/bin/node
   B=https://dl-cdn.alpinelinux.org/alpine/latest-stable/main/x86_64
   for p in libgcc libstdc++; do f=$(curl -s $B/ | grep -o "$p-[0-9][^\"]*\.apk" | head -1); curl -fLO $B/$f; tar -xzf $f -C .stage 2>/dev/null; done
   rm -f .stage/.PKGINFO .stage/.SIGN* .stage/.post*
   # apk 内の libstdc++.so.6 はシンボリックリンクなので実体に置き換える (symlink を含むコンテキストは build に失敗する)
   cp -L .stage/usr/lib/libstdc++.so.6.0.* .stage/usr/lib/libstdc++.so.6.tmp && rm .stage/usr/lib/libstdc++.so.6 && mv .stage/usr/lib/libstdc++.so.6.tmp .stage/usr/lib/libstdc++.so.6
   ```
   `FROM <ローカルの alpine 系イメージ>` / `COPY .stage/ /` でビルドし、`wslc run --rm <tag> node -v` が通ることを確認した。
   Node の動作確認は `node-v24.21.0-linux-x64-musl` で実施。glibc 版の手順 2 も検証済み。

制限事項:
- 外部への通信 (レジストリ、パッケージ取得、外部 API) はできない。依存はホスト側で解決してから COPY する。
- シンボリックリンクを含むビルドコンテキストは `readlink: function not implemented` で失敗する (再現済み)。
  `cp -L` で実体に置き換えたコンテキストを使うと成功する。
- ポート公開 (`-p`)、バインドマウント (`-v`)、コンテナー間ネットワーク (上記) は、外部接続できなくても動作する (検証済み)。
- 取得できない場合に `wsl --update` を勧めるだけで終わらせず、ローカルイメージ方式に切り替えるか、
  ユーザーにネットワーク設定の確認 (`wslc settings` 等) を依頼する。

## Guidelines for the agent

1. Always resolve the binary through the wrapper script; never hardcode
   `/mnt/c/Program Files/WSL/wslc.exe` directly in commands, since the install
   path can vary across machines.
2. Treat `wslc run`/`wslc exec` as capable of executing arbitrary code inside a
   container — confirm with the user before running unfamiliar images or
   commands, especially anything pulling from untrusted registries.
3. Quote image names/tags and paths carefully; container names and ports passed
   by the user should be validated before use in a command line.
4. If a command fails because `wslc.exe` is missing or outdated, report the
   exact error and suggest `wsl --update` rather than attempting workarounds.
5. Prefer `wslc list -a` / `wslc images` to confirm state before
   destructive operations like `wslc remove` or `wslc rmi`.
