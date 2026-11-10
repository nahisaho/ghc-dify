# Dify 1.19.0をローカルの単一コンテナで動かす

Linux/WSL2 x86_64向けの単一イメージで、Dify、PostgreSQL/pgvector、Redis、署名済みプラグイン、ネイティブMCP、エージェント関連サービス、公開鍵専用の開発用SSHを動かします。各プロセスを一つのsupervisorが管理します。Compose、入れ子のDocker、ホストのDockerソケット、privilegedコンテナは使いません。

初めて利用する方は[セットアップ手順](../../../docs/setup.ja.md)を参照してください。この文書はイメージの技術資料です。最終更新：2026-11-10。

セキュリティ要件は[承認済み仕様](../../../.sdd/specs/dify-image.md)に従います。本成果物はローカル開発用です。悪意のあるコードを封じ込める境界としては使えません。ソース公開の準備と、ビルド済みイメージの配布承認は別です。

## 前提条件

- Linux/WSL2 x86_64、Dockerへのアクセス、ホストのPython 3.10+。検証にはNode 24も必要です。
- 固定版の上流イメージやパッケージ、署名済みプラグインを取得できるインターネット接続。
- `$HOME/.ssh/id_ed25519.pub`など、鍵行だけを含む通常ファイルの公開SSH鍵。読み取り可能な権限（通常は`0644`）が必要です。ホストの一般ユーザーが所有する`0600`ファイルは、DAC回避権限のないコンテナrootからは読めません。秘密鍵はマウントしないでください。
- ビルドとイメージ書き出しに十分な空き容量。イメージは約6 GiBで、共有レイヤーやビルドキャッシュは別途必要です。guardはworkspaceとDocker-rootの空きを個別に測ります。3 GiBは停止基準であり、ビルドに十分な容量ではありません。
- 以下のコマンドは`https://github.com/nahisaho/ghc-dify`をcloneしたディレクトリのルートで実行します。`python`がない環境では`python3`を使ってください。

## ビルドしてローカルの初期設定画面を開く

```bash
python code/infrastructure/dify-image/guard.py doctor
python code/infrastructure/dify-image/guard.py build --target runtime --tag okayama-u/dify-allinone:1.19.0-local
python code/infrastructure/dify-image/guard.py run \
  --tag okayama-u/dify-allinone:1.19.0-local \
  --authorized-keys "$HOME/.ssh/id_ed25519.pub" \
  --volume okayama-u-dify-data --name okayama-u-dify --owner local-dify-image
docker inspect --format '{{.State.Health.Status}}' okayama-u-dify
```

`healthy`になるまで待ちます。初回起動ではデータベースの初期化とDifyのマイグレーションも行います。ヘルスチェックは15役割すべてを対象にします。<http://localhost:8080/install>で管理者アカウントを自分で作成してください。アカウントやパスワードの初期値はありません。設定画面が表示されただけでは、全役割の正常性は確認できません。

| 既定値 | 用途 |
|---|---|
| `127.0.0.1:8080` → `80` | DifyのWeb/API/ネイティブMCP |
| `127.0.0.1:2222` → `22` | `dev`ユーザーの公開鍵専用SSH |
| `okayama-u-dify-data` → `/data` | DB、ストレージ、作業領域、開発用ホーム、実行時鍵、SSHホスト鍵 |

wrapperは所有者ラベルの異なる既存ボリュームを拒否します。この確認を回避したり、無関係なデータのあるボリュームを接続したりしないでください。

## 永続化された開発用ホームを使う

```bash
ssh -p 2222 dev@localhost
node --version
npm --version
nvm --version
copilot
```

Copilotでは自分で`/login`を実行します。ホストのCopilotトークンは取り込みません。専用ホームは`/data`に残るため、ログイン後のボリュームは機密情報として扱ってください。導入版はNode 24.22.1、npm 11.19.1、nvm 0.41.0、Copilot CLI 1.0.106です。開発用ユーザーはサービスの認証情報ディレクトリを読めません。

既定以外の鍵を使う場合は、対応するローカルの秘密鍵を`ssh -i`で指定します。たとえば`gmail_rsa.pub`をマウントした場合は、`ssh -i "$HOME/.ssh/gmail_rsa" -p 2222 dev@localhost`を使います。暗号化した鍵のパスフレーズは、ローカルのSSHクライアントでだけ入力します。秘密鍵をマウントしたり、パスフレーズを共有したりしないでください。

別のPCからはDockerホストのSSHを経由します。Dockerのloopbackバインドは変更しません。

```bash
ssh -N -L 8080:127.0.0.1:8080 -L 2222:127.0.0.1:2222 HOST_USER@HOST
```

ホスト側のSSHサービスは別途設定してください。トンネル接続後は、接続元PCでも同じローカルのブラウザーURLとコンテナ用SSHポートを使えます。

## ネイティブMCPのワークフローを非公開で使う

ワークフローを作成して公開し、ネイティブMCPサーバーを有効にします。生成された認証情報付きURLは、MCPクライアントの非公開設定だけに保存してください。第三者製MCPサーバーは不要です。URLをログ、スクリーンショット、issueに貼らないでください。必要に応じてDifyで認証情報を更新するか、サーバーを無効にします。

検証用ワークフローでは、Codeノードが`{"answer":"DIFY_IMAGE_OK"}`を返すため、LLMプロバイダーは不要です。実際のLLMアプリや本番用の埋め込みには、別途プロバイダーの設定と認証情報が必要です。

## データを保持したままコンテナを作り直す

```bash
docker stop --time 30 okayama-u-dify
docker rm okayama-u-dify
python code/infrastructure/dify-image/guard.py run \
  --authorized-keys "$HOME/.ssh/id_ed25519.pub" \
  --volume okayama-u-dify-data --name okayama-u-dify --owner local-dify-image
```

ボリュームと同じ公開鍵ファイルを保持します。既存環境の認証情報やSSHホスト鍵は再生成しません。鍵が欠損、切り詰め、シンボリックリンク化されていたり、所有者や権限が不正だったりする場合は、安全側に停止する必要があります。初期化マーカーを削除したり自動修復を試みたりせず、信頼できる整合したバックアップを復元してください。機密情報を含むボリューム全体をバックアップする際は、先にコンテナを停止します。

shellジョブのhome更新は、コピーと同期を済ませた`home.next`と、復旧用の`home.previous`へのrenameを使います。コンテナが異常終了した場合、不完全なコピーを破棄し、最後に確定したhomeを残します。古いジョブUIDのプロセスが残っていないことを確認してから、`/run/dify/shell-roots`内のroot所有UUIDディレクトリだけを検証して削除します。作業領域のFIFOとsocketは参照先をたどらずに破棄します。通常のジョブ・IPCエラーではジョブだけを失敗させ、スタックは停止しません。所有者が不正な場合、復旧用ディレクトリがsymlinkの場合、後片付けを確認できない場合は停止します。認証情報の封印や、homeとバックアップの両方を失った状態は自動修復しません。

## 検証を再実行する

```bash
node --test code/infrastructure/dify-image/tests/requirements.test.mjs
python3 -m unittest discover -s code/infrastructure/dify-image/tests -p fixture_workspace_test.py
```

上のコマンドはcloneしたソースから実動作テストを実行します。先にイメージをビルドし、Node 24と、ホストのPythonを起動する`python`コマンドを用意してください。`python3`だけがある場合は、自分の仮想環境などで`python`を利用可能にします。テスト用の一時鍵や状態は`~/.cache/ghc-dify/validation`に保存するため、このディレクトリも公開しないでください。同じユーザーで検証を同時実行しないでください。

SDDの承認記録とRed→Greenの実行台帳は公開対象から除外しています。そのため、新しいcloneで`node .github/skills/lean-sdd-tdd/scripts/sdd.mjs gate`を実行しても、開発元の台帳に基づく判定は再現できません。SDD gateの再実行には、そのcloneで仕様の承認とテスト証跡を新たに取得する必要があります。実動作テストの成功と、SDD gateの成功は別です。

ネイティブテストは、合成アカウントと所有者ラベル付きの専用環境を使います。ポートはDockerが割り当てる一時的なloopbackポートです。実ラッパーの既定`8080`/`2222`も別に検証し、稼働中の環境には干渉しません。自分のデータを対象にしないでください。ファイルのパターン照合だけでなく実際のプロトコルを検証し、必要なシナリオの欠落を拒否します。役割別の障害試験は専用コンテナを意図的に停止します。レイヤー監査には、イメージサイズに3 GiBを加えた追加の空き容量も必要です。

2026-11-06の検証結果は **6/6 Red→Green、full SDD gate PASS** です。全体gateのネイティブテストでは6シナリオを各1回実行し、782.6秒で完了しました。15役割の起動と個別停止、署名付きプラグインと2文書のRAG検索21項目、ネイティブMCPの17項目、ジョブ隔離、SSH・開発ツール、データ・home・鍵の永続化を検証しました。100件の破損拒否と復元、初期化中断時の拒否も通りました。レビュー後の回帰試験では、隔離したshell環境で復旧・エラー処理の20ケースを検証しました。実際にジョブ実行中のコンテナをkillして再起動し、認証情報の封印が変わらないことも確認しました。限定した5件の変異も検出しました。

前回の検証対象は、ID`sha256:d780c3212a07a2183026b5438c746cb3e4c136f664ea771fd08a920fce57e767`、サイズ5.72 GiBのイメージです。2026-11-07の再検証では **6/6 Red→Green、full SDD gate PASS** となりました。6シナリオを各1回実行し、778.7秒で完了しました。Ruff/mypyはPythonの31ファイルを検査しました。SSH修正版の候補`okayama-u/dify-allinone:1.19.0-local`は、ID`sha256:5fce6019e1636bf88a693d2eaedd897a9dcf6fd945a8dfa198ee331a005f3849`、サイズ6,155,305,306 bytes、5.73 GiBです。Ed25519/RSAで通常コマンド、強制PTY、実際の対話ログインが通り、devのcapabilityなしと不正認証の拒否も確認しました。非ログイン時の`python3`/Node/npm/Copilotも使えました。PATHの回帰試験では、以前の実装を戻すと1.953秒で失敗を検出し、修正版は3.212秒で通りました。公開していないためregistry digestはありません。

現在のイメージは、空の層と削除済みの内容を含め、40の論理レイヤー、39の一意なblobを監査しました。例外は、独立して公開ソースと照合した19組の暗号自己試験ファイルのパス・ハッシュだけです。対象は`tests/secrets_checks.py`に明記しています。変更されたファイル、対象外の秘密鍵、実行時の認証情報は拒否します。導入済みのPython実行時ソース14ファイルのハッシュも、前回レビューしたファイルと一致しました。技術的なgateの成功は、独立した最終レビューや公開承認とは別です。

## セキュリティ境界と残る制約

- **SSHのLinux auditに関する制約:** DebianのLinux audit処理は、`AUDIT_WRITE`がないとPTYログインを異常終了させました。サーバー実行ファイル3個を、OpenSSH `10.0p1`とDebian `1:10.0p1-7+deb13u4`の全セキュリティパッチから、上流が認識する`--without-audit`で再ビルドしています。ホストカーネルのLinux audit記録は送信せず、監査成功の偽装もしません。通常のSSHログと公開鍵・UID・capabilityの方針は変えず、`AUDIT_WRITE`、`FOWNER`、DAC回避の権限は追加しません。Linux audit連携が必要なホストは、この候補の監視機能の対応範囲外です。
- configureには`--enable-option-checking=fatal`を指定し、未対応のオプションがあればビルドを失敗させます。ビルド時の検査ではLinux/BSM/debug auditのマクロを拒否し、`USE_PAM`と`WITH_SELINUX`を要求します。以前の`--without-linux-audit`は上流に認識されない指定だったため、この候補では使いません。
- 元のパッケージの非ログインSSH PATHを、`--with-default-path=/usr/local/bin:/usr/bin:/bin:/usr/games`とDebianの`--with-superuser-path=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`で保持します。ログイン用profileを読まないリモートコマンドでも、`python3`、Node、npm、Copilotを使えます。rootのSSHログインを許可する変更ではありません。
- ソースは`https://deb.debian.org/debian/pool/main/o/openssh/`から取得し、SHA-256を照合してから`debian/patches/series`の全項目を適用します。`openssh_10.0p1.orig.tar.gz`のハッシュは`021a2e709a0edf4250b1256bd5a9e500411a90dddabea830ed59cef90eb9d85c`、`openssh_10.0p1-7+deb13u4.debian.tar.xz`は`102e1065030c6002acabd7f896eeba1462bf54b4d7393bac34b0308312868ec6`です。configureでは`--with-pam`、`--with-selinux`、権限分離ユーザー`sshd`とルート`/run/sshd`を保持します。実効設定の`UsePAM no`は変えません。保存したコンパイラ出力では、PIE、stack protector、FORTIFY、RELRO/NOW、実行不可stackのフラグを確認しました。差し替えるのは`sshd`、`sshd-session`、`sshd-auth`だけで、クライアントと実行時設定は変えません。
- サービスは別々の非root IDで動きます。信頼する初期化処理、sshd、限定権限のsandbox/shell起動処理はrootの例外です。実行ジョブには別UID、GID 1000、補助グループなし、capabilityなし、NoNewPrivs、seccompを要求し、専用ルートに`/data`を含めません。
- コンテナの既定capabilityは`CHOWN`、`SETUID`、`SETGID`、`KILL`、`SYS_CHROOT`だけです。brokerでは`KILL`も落として4種類にします。`FOWNER`、`SYS_ADMIN`、ネットワーク管理、ptrace、DAC回避の権限は有効にしません。
- network/PID namespaceは共有です。サービス別のネットワーク分離、強制的な外向き通信制限、ポートの専有、悪意あるプラグインの封じ込めは保証しません。必要な低ポート用sysctlにより、すべての非root役割が低ポートをbindできます。
- PythonのCodeノードはDifyのネットワーク有効モードで動きます。ネットワーク無効のsandboxは保証しません。エージェントのshellジョブで本物の対話PTYを使う動作は未検証です。
- Copilotのバージョン確認と合成データによるhome永続化は通りました。実アカウントのOAuthログインとトークン更新は試していません。
- 検証には現在のLinux Dockerホストを使っています。利用者のWindows/WSL2環境への導入は未検証です。
- 初期化、マイグレーション、全役割の起動確認は、共通の300秒の期限を使います。WSLのストレージなどが遅い環境では、初回起動が期限を超える可能性があります。ラッパーの待機時間330秒は、この期限を延長しません。起動失敗を隠すためにデータボリュームを削除しないでください。
- ホスト・Docker管理者と信頼するコンテナrootは永続化した秘密情報にアクセスできます。保存時の暗号化は保証しません。
- 公式イメージ、ソース、主要ツールは固定していますが、aptの依存パッケージ全体は固定していません。RAGの検証はテスト専用の決定的な埋め込みAPIを使っており、実モデルの検索品質を示すものではありません。
- 上流のライセンスを保持し、共有前に再配布条件を確認してください。SSH修正版の独立レビューでは、公開を妨げるコード上の指摘は残っていません。ただし、これはライセンス審査や配布承認ではありません。registryへのpushやreleaseは実行していません。
