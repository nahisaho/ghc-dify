# ghc-dify セットアップ手順

GitHubから取得したソースをビルドし、Difyの画面と開発用SSHに接続するための手順です。
Dockerとターミナルの基本操作を知っている初回利用者を対象とします。

対象：Dify 1.19.0 / Linux・Windows WSL2 x86_64。最終更新：2026-11-10。

## 実行場所と必要な環境

以下のBashコマンドは、Dockerを動かすLinuxホストで実行します。WindowsではWSL2のLinuxターミナルを使います。PowerShell用コマンドは明記しています。

| 項目 | 条件 |
|---|---|
| CPU | x86_64 / amd64。ARM64・Apple Siliconは対象外 |
| Docker | Linuxコンテナ、BuildKitによるマルチステージビルドが利用可能 |
| ホストのツール | Git、Python 3.10以上（この手順では`python3`）、OpenSSHクライアント |
| メモリ | ラッパーはコンテナの上限を8 GiBに設定。ビルドとホスト用の余裕も確保 |
| ディスク | 最終イメージは約6 GiB。取得イメージ・ビルドキャッシュ・データ用の空きが別途必要 |
| ネットワーク | GitHub、コンテナregistry、Debian、npmなどの取得先へ接続可能 |
| ポート | Dockerホストの`8080`と`2222`が未使用 |

Windowsでは、先にWSL2を準備し、利用するLinuxディストリビューション内にDocker Engineを導入する構成を推奨します。**このラッパーはDockerのデータ保存先をホスト側から測定できる必要があります**。Docker Desktopはデータを別VMに保存するため、そのWSL連携だけでは通常この条件を満たしません。別VM・リモートのDocker daemonも対象外です。後述の`doctor`が成功し、表示された保存先が実際のDocker保存先と一致することを確認してから進めてください。

WSLでは、`/mnt/c`ではなくLinux側のホーム以下にcloneすることを推奨します。Docker管理権限はホストの管理者権限に相当します。共有PCでは管理者の方針に従ってください。

## 1. リポジトリを取得する

```bash
git clone https://github.com/nahisaho/ghc-dify.git
cd ghc-dify
```

以降はこのディレクトリで実行します。

```bash
test -f code/infrastructure/dify-image/guard.py && echo "repository OK"
docker version
python3 --version
```

`repository OK`とDockerのServer情報を確認してください。`docker version`が失敗する場合は、daemonの起動や利用権限を先に直します。

## 2. SSH用の鍵を準備する

次の例は、この環境専用の新しい鍵を作成します。同名のファイルがすでにある場合は上書きせず、別名にしてください。

```bash
mkdir -p "$HOME/.ssh"
chmod 700 "$HOME/.ssh"
ssh-keygen -t ed25519 -f "$HOME/.ssh/ghc_dify" -C "ghc-dify"
```

パスフレーズを設定した場合、SSH接続時にローカルPCで入力します。Difyのパスワードとは別です。

```bash
chmod 600 "$HOME/.ssh/ghc_dify"
chmod 644 "$HOME/.ssh/ghc_dify.pub"
ssh-keygen -l -f "$HOME/.ssh/ghc_dify.pub"
```

`ghc_dify`は秘密鍵、`ghc_dify.pub`は公開鍵です。コンテナに渡すのは **公開鍵だけ** です。既存の鍵を使う場合は、以降の両方のパスを対応する鍵に置き換えてください。

公開鍵はシンボリックリンクではない通常ファイルにし、一般的な`ssh-ed25519`・`ssh-rsa`・`ecdsa-sha2-*`の鍵行を使います。`authorized_keys`のオプション付き行は受け付けません。秘密鍵をリポジトリにコピーしないでください。

## 3. 容量とDocker環境を確認する

```bash
python3 code/infrastructure/dify-image/guard.py doctor
```

`freeBytes`に`workspace`と`docker-root`が表示されれば、両方の保存先を測定できています。3 GiB未満ではラッパーが停止します。**3 GiBはビルドに必要な容量ではなく、停止する下限です。**

十分な容量を確保してから進めてください。空き容量不足時に、他の利用者のイメージ・キャッシュ・ボリュームを一括削除しないでください。

## 4. イメージをビルドする

```bash
python3 code/infrastructure/dify-image/guard.py build \
  --target runtime \
  --tag okayama-u/dify-allinone:1.19.0-local
```

`okayama-u/dify-allinone:1.19.0-local`は **ローカルのイメージ名** で、公開registryからpullする指示ではありません。初回は上流イメージ・ソース・パッケージを取得します。ビルドの制限時間は20分です。

```bash
docker image inspect --format '{{.Id}}' okayama-u/dify-allinone:1.19.0-local
```

`sha256:`で始まるIDが表示されれば、イメージが存在します。apt依存パッケージ全体は固定していないため、他の環境で同じIDになる保証はありません。固定版パッケージが取得先からなくなった場合も、ビルドが失敗することがあります。

## 5. データボリュームを作成して起動する

```bash
python3 code/infrastructure/dify-image/guard.py run \
  --tag okayama-u/dify-allinone:1.19.0-local \
  --authorized-keys "$HOME/.ssh/ghc_dify.pub" \
  --volume okayama-u-dify-data \
  --name okayama-u-dify \
  --owner local-dify-image
```

ボリュームはラッパーが作成するため、先に`docker volume create`する必要はありません。`freeBytes`だけが表示されている間は起動待ちです。`"ready": true`が表示されると全15役割のヘルスチェックが通っています。

```bash
docker inspect --format '{{.State.Status}} / {{.State.Health.Status}}' okayama-u-dify
```

成功時は`running / healthy`です。初回はDB初期化とマイグレーションが走ります。330秒以内に起動を確認できない場合、ラッパーは作成したコンテナを停止してエラーを返します。内部の初期化・起動期限は300秒で、遅い環境では超過することがあります。

| ホスト側の接続先 | 内容 |
|---|---|
| `127.0.0.1:8080` | Dify Web / API / 標準MCP |
| `127.0.0.1:2222` | 開発用SSH |
| `okayama-u-dify-data` | DB・ファイル・内部鍵・SSHホスト鍵・開発用ホームを保存するボリューム |

DBとRedisはホストに公開しません。同じ名前のコンテナがある場合や、所有者ラベルの異なるボリュームがある場合は、そのまま上書きできません。

## 6. ブラウザーでDifyの管理者を作成する

Dockerホスト上のブラウザーで <http://localhost:8080/install> を開き、管理者アカウントを作成します。既定の管理者メールアドレス・パスワードはありません。設定済みの場合は <http://localhost:8080/signin> からサインインします。

実際のLLMアプリを動かすには、Difyの設定から利用するモデルプロバイダーを追加してください。APIキーや利用料金は利用者が用意・管理します。このイメージにLLMモデルやプロバイダーの認証情報は含まれません。

### 同じWindows PCのブラウザーから開く

WSL2でDockerを動かしているWindows PCでは、Windows側のEdgeやChromeで <http://localhost:8080> を開きます。通常はWSLのlocalhost転送を利用できますが、WSLの設定・VPN・ファイアウォールの影響を受けます。

接続できない場合は、`curl`を導入したWSLのターミナルで確認します。

```bash
curl -I http://127.0.0.1:8080/install
```

WSLで応答し、Windows側でだけ接続できない場合は、WSLのlocalhost転送とWindows側の接続制限を確認してください。`0.0.0.0`への公開やファイアウォールの全面無効化で回避しないでください。

### 別のWindows PCからSSHトンネルで開く

Dockerホスト側でSSHサーバーを別途設定し、Windows PCからホストにSSH接続できる必要があります。WSL内のホストSSHを使う場合は、必要に応じてWindowsからWSLへの転送も管理者が設定します。コンテナのSSHを起動するだけでは、ホストへのSSH接続は用意されません。

次は接続元WindowsのPowerShellで実行します。`HOST_USER`と`DOCKER_HOST`は、接続可能なホストのユーザー名とIPアドレスまたはホスト名に置き換えます。転送先の`127.0.0.1:8080`はSSH接続先から見たアドレスなので、その接続先でDifyへ到達できる必要があります。

```powershell
ssh -N -o ExitOnForwardFailure=yes -L 8080:127.0.0.1:8080 HOST_USER@DOCKER_HOST
```

この接続を維持したまま、Windowsのブラウザーで <http://localhost:8080> を開きます。PowerShellで`Ctrl+C`を押すとトンネルが終了します。接続元の8080番が使用中なら、先頭だけ`18080`に変え、<http://localhost:18080> を使えます。ただしDifyのファイルURLなどには既定の`localhost:8080`が保存されるため、全機能の利用には8080番を空けることを推奨します。

ここで接続するのは **DockerホストのSSH** です。コンテナの`dev`ユーザーや2222番ではありません。ホストSSHの転送先`127.0.0.1:8080`が、Difyを公開しているDockerホストを指す必要があります。

## 7. SSHで開発環境に入る

Dockerホストのターミナルから実行します。

```bash
ssh -i "$HOME/.ssh/ghc_dify" -p 2222 dev@localhost
```

初回はSSHホスト鍵の確認が表示されます。必要ならホスト側の次のコマンドで指紋を確認し、接続先が正しいことを確かめてから登録してください。

```bash
docker exec okayama-u-dify ssh-keygen -lf /data/ssh/ssh_host_ed25519_key.pub
```

接続後のコマンドです。

```bash
whoami
node --version
npm --version
nvm --version
copilot
```

`whoami`は`dev`を返します。Copilotを初めて使う場合は画面内で`/login`を実行し、自分のGitHubアカウントで認証します。Copilotの利用資格・契約が別途必要な場合があります。ホストのトークンを自動では取り込みません。

`nvm`はインストール済みNodeの読み込みに使えますが、共通の`/opt/nvm`へ一般ユーザーが別バージョンを追加できる保証はありません。開発用ホームはボリュームに保存されます。`exit`でSSH接続を終了します。

別PCからコンテナSSHも使う場合は、ホストSSHのトンネルに`-L 2222:127.0.0.1:2222`を追加します。そのPCのSSHクライアントから、自分の秘密鍵で`dev@localhost -p 2222`へ接続してください。対応する公開鍵を起動時の公開鍵ファイルに含める必要があります。トンネルを使うために秘密鍵をDockerホストへコピーしないでください。

## 8. ワークフローを標準MCPで呼び出す

MCPは、AIクライアントからDifyのアプリやワークフローをツールとして呼び出すための接続方式です。別のDify MCPサーバーをインストールする必要はありません。

1. Difyでワークフローを作成し、Dify上で実行できることを確認します。
2. ワークフローを公開します。
3. アプリの「Access Point（アクセスAPI）」画面にあるMCP Serverを有効にします。画面表記はUI言語によって異なります。
4. 生成されたURLを、利用するMCPクライアントの非公開設定に登録します。

登録形式はクライアントの手順に従ってください。クライアントからツールの一覧を取得し、呼び出し結果をDify上の結果と照合できれば完了です。別PCのクライアントも、SSHトンネル経由で同じlocalhostの接続先を使います。

**生成URLには認証情報が含まれます。** リポジトリ、Issue、ログ、スクリーンショットには載せないでください。漏えいした場合はDifyでURLの認証情報を更新するか、MCPを無効にしてください。[Dify公式のMCP公開手順](https://docs.dify.ai/en/cloud/use-dify/publish/publish-mcp)も参照してください。

## 停止・再開とデータの保存

```bash
docker stop --time 30 okayama-u-dify
```

コンテナを停止してもボリュームは残ります。再開には次を使います。

```bash
docker start okayama-u-dify
docker inspect --format '{{.State.Health.Status}}' okayama-u-dify
```

`healthy`になるまで確認します。`docker start`はラッパーの待機や容量チェックを実行しないため、再開前の容量確認には`guard.py doctor`を使ってください。自動再起動ポリシーは設定していません。ホスト再起動後も必要に応じて手動で再開します。

イメージを再ビルドしても、既存コンテナは自動で更新されません。同じDify版のコンテナを作り直す場合は、先に停止・バックアップを行い、旧コンテナを別名で保管します。第5節の起動コマンドで同じボリューム・公開鍵・ownerを指定し、停止した旧コンテナと新コンテナを同時に動かさないでください。単なる`docker restart`ではイメージは切り替わりません。

異なるDify版への更新・DBマイグレーションの巻き戻しは、この手順の対象外です。データのあるボリュームを`docker volume rm`や`docker system prune --volumes`で削除しないでください。

## 停止したデータをバックアップする

バックアップにはDB・内部鍵・Copilotの認証情報も含まれます。十分な容量を用意し、暗号化した保存先などで管理してください。以下はローカルファイルを作成する例で、暗号化は行いません。

まず`docker stop --time 30 okayama-u-dify`で停止し、以降の処理が終わるまで再開しません。使用中のイメージIDを取得し、停止済みコンテナのボリュームを読み取り専用で接続して保存します。

```bash
umask 077
mkdir -p "$HOME/ghc-dify-backups"
BACKUP="$HOME/ghc-dify-backups/data-$(date +%Y%m%d-%H%M%S).tar.gz"
IMAGE_ID=$(docker inspect --format '{{.Image}}' okayama-u-dify)
docker run --rm --network none \
  --volumes-from okayama-u-dify:ro \
  --entrypoint tar "$IMAGE_ID" -C /data -czpf - . > "$BACKUP.part" \
  && tar -tzf "$BACKUP.part" > /dev/null \
  && mv "$BACKUP.part" "$BACKUP" \
  && printf '%s\n' "$IMAGE_ID" > "$BACKUP.image-id"
```

終了コード0と、`.part`ではないバックアップファイルの作成を確認します。エラーが出た場合、残った`.part`は有効なバックアップではありません。保存したイメージIDのファイルと、対応するローカルイメージも保管してください。別ホストで復元するには、そのイメージを別途移送する必要があります。

```bash
docker start okayama-u-dify
```

### 新しいボリュームへ復元する

復元前に稼働中の`okayama-u-dify`を停止し、8080・2222番を空けます。元のボリュームは削除しません。次は同じホスト上での復元例です。`BACKUP`には先ほど作成したアーカイブの絶対パスを設定し、`IMAGE_ID`は保存したファイルから読み込みます。

```bash
IMAGE_ID=$(cat "$BACKUP.image-id")
docker image inspect "$IMAGE_ID"
RESTORE_VOLUME="ghc-dify-restore-$(date +%Y%m%d-%H%M%S)"
docker volume create \
  --label io.okayama-u.dify-image.owner=local-dify-image \
  "$RESTORE_VOLUME"
```

`RESTORE_VOLUME`には必ず未使用の名前を指定します。次のコマンドはそのボリュームへ書き込むため、既存データのあるボリュームには実行しないでください。UID/GIDを名前ではなく数値で復元し、ファイルの権限も保持します。

```bash
docker run --rm --interactive --network none \
  --mount "type=volume,source=$RESTORE_VOLUME,target=/data" \
  --entrypoint tar "$IMAGE_ID" \
  -C /data --numeric-owner -xzpf - < "$BACKUP"
```

終了コード0を確認してから、復元先を指定して起動します。

```bash
python3 code/infrastructure/dify-image/guard.py run \
  --tag "$IMAGE_ID" \
  --authorized-keys "$HOME/.ssh/ghc_dify.pub" \
  --volume "$RESTORE_VOLUME" \
  --name okayama-u-dify-restored \
  --owner local-dify-image
```

以降はコンテナ名を`okayama-u-dify-restored`に読み替えます。管理者ログイン・既存データ・SSHホスト鍵を確認するまで元ボリュームを保管してください。部分的な鍵の差し替えや初期化マーカーの削除は復旧手順ではありません。

## 完了を確認する

| 確認対象 | 成功の目安 |
|---|---|
| コンテナ | `running / healthy` |
| Dify | 自分で作成した管理者でサインインできる |
| SSH | 公開鍵で入り、`whoami`が`dev`を返す |
| 開発ツール | Node / npm / nvmのバージョンが表示され、Copilotが起動する |
| MCP（利用する場合） | ツールを列挙でき、ワークフローの期待する結果を受け取れる |
| 永続化 | 停止・再開後も管理者と既存データが残る |

## よくあるエラーと対処

| 症状 | 主な原因 | 対処 |
|---|---|---|
| `can't open file ... guard.py` | リポジトリ外で実行している | cloneした`ghc-dify`に`cd`し、ファイルの存在を確認 |
| `python: command not found` | `python`という名前がない | 本手順どおり`python3`を使い、3.10以上を確認 |
| `A regular authorized_keys file is required` | 公開鍵がない、またはsymlink | 指定した`.pub`の存在と種類を確認。秘密鍵は渡さない |
| 公開鍵の読み取りが失敗 | 公開鍵が`0600`など | 公開鍵だけを`chmod 644`。秘密鍵は`0600`のままにする |
| `Enter passphrase for key` | ローカル秘密鍵が暗号化されている | 鍵作成時のパスフレーズを入力。忘れたら新しい鍵を用意 |
| `Permission denied (publickey)` | 対応しない鍵・ユーザー | `dev`と2222番を使い、マウントした公開鍵と`ssh -i`の秘密鍵の組を確認 |
| `Connection ... closed` | SSHセッション開始失敗、旧イメージなど | 最新ソースでビルド済みか確認。更新は再作成が必要。無差別に権限を追加しない |
| `Refusing unrelated volume` | 既存ボリュームのownerが不一致 | 自分の既存環境のownerを確認するか、新しい未使用のボリューム名を選ぶ。ラベルを安易に変更しない |
| コンテナ名・ポートが使用中 | 同名環境や別アプリがある | 対象を調べ、自分が管理する環境だけ停止。ラッパーにポート変更のCLIオプションはない |
| `DockerRootDir`の測定失敗 | Docker保存先がホストから見えない | Docker contextと保存先を確認。同じLinuxホストで容量を測定できるdaemonを使う |
| `Capacity guard stopped` | どちらかの保存先が3 GiB未満 | 容量を確保する。他人のデータや共有キャッシュを一括削除しない |
| ビルドが20分で終了 | ガードの制限時間超過 | ネットワーク・計算資源を確認し、原因解消後に再実行。既存キャッシュは再利用可能 |
| `starting`のまま／起動失敗 | 遅い初期化やサービスのエラー | `docker logs --tail 100 okayama-u-dify`をローカルで確認。ログを外部共有する前に機密情報を除く |
| 破損・初期化中断として拒否 | データと鍵の整合性がない | 自動修復やマーカー削除をせず、整合したバックアップを専用ボリュームへ復元 |

起動失敗後もコンテナ名は残ります。原因を直して第5節をやり直す場合は、まず状態とログを確認し、**自分が作成した停止済みコンテナだけ** を`docker rm okayama-u-dify`で削除します。`-v`は付けず、データボリュームも削除しません。削除前に、必要なデータが`/data`のボリュームにあり、コンテナ内だけに置いたファイルは退避済みであることを確認してください。既存データが破損している場合、同じ起動コマンドの再実行では直りません。

## 制約と検証範囲

本環境はローカル開発用です。サービスのnetwork/PID namespaceは共有され、信頼するroot補助処理とホスト管理者は内部鍵を読めます。悪意あるプラグインの封じ込め、保存時暗号化、強制的な通信制限は保証しません。インターネットへ直接公開しないでください。

OpenSSHはLinux audit連携を無効化して再ビルドしています。ホストのLinux監査ログにSSHイベントは送信しません。公開鍵認証と通常のSSHログを使います。コンテナには5種類の限定したcapabilityを付与し、privilegedモードやホストのDockerソケットは使いません。

Linux Dockerホストで、起動・MCP・RAG・SSH対話端末・永続化・破損拒否を検証しています。RAGの検証はテスト用の埋め込みAPIを使っており、実モデルの検索品質を示しません。Windows/WSL2環境全般の動作、Copilotの実OAuth認証・トークン更新、エージェントshellジョブの対話PTYは未検証です。

詳しい権限・検証結果は[イメージの技術資料](../code/infrastructure/dify-image/README.ja.md)を参照してください。

## 公開者がGitHubへのアップロード前に確認すること

ソースの公開と、ビルド済みイメージのregistryへの配布は別です。この手順はソースからのビルドを案内しており、イメージのpushやGitHubの公開操作は実行しません。

- 独自コードとドキュメントには [MITライセンス](../LICENSE) が適用されます。同梱ソフトウェアのライセンス・再配布条件は別途確認します。Difyには追加条件があるため、同梱物全体をMITと表記しないでください。
- `.venv/`、`__pycache__/`、`.ruff_cache/`などのローカル生成物は [.gitignoreの設定](../.gitignore) で除外します。独自の名前で保存した秘密情報や、すでに追跡されているファイルまでは保護できないため、公開対象を別途確認してください。
- `.sdd/`の証跡やローカル設定に、個人の絶対パス・機密情報がないか確認します。
- 秘密鍵、`.env`、モデルAPIキー、認証情報付きMCP URL、Copilotの認証ファイル、ボリュームのバックアップは公開しません。
- ログやIssueには、SSHパスフレーズ・トークンを載せません。問題の再現情報と、必要な範囲だけを伏せ字で共有します。
