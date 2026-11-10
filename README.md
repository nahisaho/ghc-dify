# ghc-dify

Dify・標準MCP・開発ツール・SSHを、一つのDockerコンテナで動かすローカル開発環境です。
初めて利用する方は、[日本語セットアップ手順](docs/setup.ja.md)に沿ってビルド・初期設定・接続を進めてください。

対象：Linux / Windows WSL2のx86_64環境。Dify 1.19.0。最終更新：2026-11-10。

## 同梱するサービスとツール

| 用途 | 内容 |
|---|---|
| アプリ・ワークフロー | Dify Web / API / worker、標準MCP公開機能 |
| データ保存 | PostgreSQL / pgvector、Redis、アップロード用ストレージ |
| 実行基盤 | プラグイン、コード実行sandbox、エージェント関連サービス |
| 開発環境 | Node.js 24.22.1、npm 11.19.1、nvm 0.41.0、GitHub Copilot CLI 1.0.106 |
| SSH | `dev`ユーザー、公開鍵認証のみ、永続化されたホーム |

Compose、コンテナ内Docker、ホストのDockerソケット、privilegedコンテナは使いません。イメージは自分の環境でビルドします。取得可能な公開registryイメージは案内していません。

## 利用手順と技術資料

- [セットアップ・Windowsからの接続・日常操作・トラブル対応](docs/setup.ja.md)
- [イメージの詳細・検証方法・制約（日本語）](code/infrastructure/dify-image/README.ja.md)
- [Image details and qualification (English)](code/infrastructure/dify-image/README.md)
- [Dockerfile](code/infrastructure/dify-image/Dockerfile)

## 利用前に確認する制約

**信頼できる利用者のローカル開発向けです。インターネットへの直接公開や、信頼できないコードの実行基盤には使わないでください。**

Webは`127.0.0.1:8080`、SSHは`127.0.0.1:2222`にだけ公開します。別PCからはDockerホストへのSSHトンネルを使います。サービス間のnetwork/PID namespaceは共有され、悪意のあるプラグインの封じ込めは保証しません。

DB・内部認証情報・SSHホスト鍵・CopilotのホームはDockerボリュームに保存します。ボリュームには秘密情報が含まれるため、GitHubへアップロードしないでください。SSHのLinux audit連携は無効です。Windows/WSL2全般の互換性と、Copilotの実アカウント認証・トークン更新は検証を完了していません。

## ライセンスとリポジトリ公開

本プロジェクト独自のコードとドキュメントは [MITライセンス](LICENSE) で提供します。第三者のコード・ドキュメント・同梱ソフトウェアには、それぞれのライセンスが適用されます。

[Difyのライセンス](https://github.com/langgenius/dify/blob/1.19.0/LICENSE)など、利用・改変・再配布の条件を確認してください。本プロジェクトのMITライセンスは、第三者のライセンスや追加条件を変更しません。[公開前の確認事項](docs/setup.ja.md#公開者がgithubへのアップロード前に確認すること)も参照してください。
