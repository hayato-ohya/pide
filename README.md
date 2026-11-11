# Pide — MATLAB 風 Python IDE

Rust(Tauri 2)+ TypeScript(React)で作る、MATLAB のワークフローを Python に持ち込む IDE。

## 主な機能

- Command Window / Workspace / Variable Viewer / Figures を中心にした MATLAB 風のレイアウト(dockview で自由配置)
- エディタ(Monaco、`# %%` セル)とノートブック(.ipynb)。basedpyright と ruff による補完・診断・整形
- 変数ビューワーと画像ビューワー(numpy / pandas / polars / torch / jax / xarray / PIL)、Workspace からのプロット
- Git パネル(差分、履歴グラフ、コンフリクト解決)、ターミナル
- デバッガ(ipykernel 内蔵の debugpy)、SSH リモートカーネル、接続ファイルでの接続

機能の詳細と実装の経緯は [docs/implementation.md](docs/implementation.md) にまとめています。

## 構成

```
crates/kernel-client/   Jupyter ワイヤプロトコルの Rust 実装(ZeroMQ, HMAC, ipykernel 起動)。UI 非依存
python/pide_kernel/    カーネル内で動く変数収集パッケージ(user_expressions 経由で呼ばれる)
apps/desktop/           Tauri アプリ
  src-tauri/            Rust バックエンド(カーネル所有、イベント転送、ファイル操作)
  src/                  React フロントエンド(dockview レイアウト、Monaco、Plotly)
docs/implementation.md  機能の詳細と実装記録
```

## 検証用 conda 環境

```
conda create -n pyide-test python=3.12
~/miniconda3/envs/pyide-test/bin/python -m pip install ipykernel numpy pandas polars pyarrow matplotlib plotly scipy scikit-learn pillow xarray torch torchvision jax basedpyright ruff
PIDE_PYTHON=~/miniconda3/envs/pyide-test/bin/python npm run tauri dev   # この環境で起動
```

Workspace / Variable Viewer / 画像ビューワーで検証済みの型: numpy、pandas(category / datetime / NaN 含む)、polars DataFrame / Series、torch Tensor(CPU / MPS / requires_grad / float16 / bool)、torch.nn.Module(パラメータ一覧、`model.0.weight` のように掘れる)、jax Array、xarray DataArray、PIL Image、scikit-learn 推定器(属性一覧)。

## 対応プラットフォーム

macOS、Linux、Windows に対応しています。CI は 3 OS で Rust / フロントエンドのビルドと、カーネルの起動・変数スナップショット・割り込み・終了を通すスモークテスト(`crates/kernel-client/examples/smoke.rs`)を実行します。

- macOS: 実機で動作確認している環境です
- Linux: ビルドとカーネルのスモークテストは CI で確認。WebKitGTK(`libwebkit2gtk-4.1`)が必要です
- Windows: ビルドとスモークテストは CI で確認(GUI の実機確認は未実施)。割り込みは Win32 イベント(`JPY_INTERRUPT_EVENT`)で行い(CPython の仕様で Python のループは即座に止まるが、`time.sleep()` などの C 呼び出し中はその呼び出しが戻った時点で止まる。Jupyter と同じ挙動)、親プロセスの監視は継承ハンドル(`JPY_PARENT_PID`)で行います。インタープリタは `python.exe`(conda の `<env>\python.exe`、PATH)を検出し、linter / LSP は `<env>\Scripts` と PATH の `.exe` / `.cmd` を探します。ターミナルは pwsh / powershell / cmd。Git 操作は `git` コマンド(Git for Windows)が必要です。フロントエンドに渡すパスは常に `/` 区切りです

## 注意(プロジェクト設定の信頼)

flake8 / pylint / black / autopep8 はプロジェクトのフォルダで実行するため、そのフォルダの設定ファイル(たとえば `.pylintrc` の `init-hook`)に書かれたコードが実行される。カーネルでプロジェクトのコードを実行するのと同じ信頼レベルなので、信用できないリポジトリを開くときは linter を ruff か none にしておく。

## ログ

アプリのログは標準エラー出力に加え、macOS では `~/Library/Logs/Pide/`、Linux では `~/.local/state/pide/logs/` に日次ローテーションで書き出します。カーネルや言語サーバーの出力は DEBUG レベルなので、必要なら `RUST_LOG=debug` で起動してください。

## テストと CI

- Rust: `cargo test --workspace`(HMAC 署名の往復・改ざん検出、シェル引用、接続情報、一時リポジトリでの Git 操作、PATH の取り込み)
- Python: `python -m pytest -q`(`python/` で実行。`pytest.ini` で `tests/` だけを収集。ヘルパーのスナップショット、パス解決、統計、画像、プロット、ファイル操作)
- GitHub Actions(`.github/workflows/ci.yml`)が push / PR ごとに macOS / Linux / Windows で上記とフロントエンドのビルド(`tsc --noEmit` を含む)、カーネルのスモークテストを実行します。Linux では `cargo clippy --workspace --all-targets -- -D warnings` と `cargo test --workspace` も実行します

## 配布ビルド

```
cd apps/desktop && npm run tauri build
```

成果物は `target/release/bundle/` に出ます(macOS: `macos/Pide.app` と `dmg/Pide_<version>_aarch64.dmg`、Linux: `deb/` と `appimage/`、Windows: `msi/` と `nsis/`)。Python ヘルパー(`python/pide_kernel`)はアプリのリソースとして同梱されるので、実行には Python 3.10 以上と `ipykernel`(デバッグには `debugpy`、補完には `basedpyright` / `ruff`)が入った環境だけが必要です。

`v*` のタグを push すると `.github/workflows/release.yml` が 4 ターゲット(macOS Apple Silicon / Intel、Linux x86_64、Windows x86_64)のインストーラを作り、ドラフトの GitHub Release に添付します(`workflow_dispatch` で手動実行した場合は Actions のアーティファクトに残ります)。ドラフトは最初のジョブで 1 回だけ作り、各ビルドはその `releaseId` に添付します。

バージョンはルートの `Cargo.toml`(`[workspace.package] version`)だけが正です(`tauri.conf.json` には書かず、Tauri は Cargo の値を使う)。タグ(先頭の `v` を除く)がこの値と一致しないとリリースは失敗します。`apps/desktop/package.json` の version はどこからも参照されていないので、上げるときは手で揃えてください。

署名はしていません。macOS では初回に Finder で右クリック → 開く、または `xattr -d com.apple.quarantine /Applications/Pide.app`。Windows では SmartScreen の「詳細情報 → 実行」が必要です。Apple Developer ID / Windows のコード署名証明書を用意したら、`APPLE_CERTIFICATE` などの secrets を tauri-action に渡すだけで署名・公証できます。

## 開発環境

- Rust(rustup)、Node 18+、Python 3.10+ と `ipykernel`(カーネル側に `numpy` / `pandas` / `matplotlib` があると便利)
- 初回: `cd apps/desktop && npm install`
- 起動: `cd apps/desktop && npm run tauri dev`
- 配布ビルド: `cd apps/desktop && npm run tauri build`

### 開発用フック

- `PIDE_AUTORUN="print(1)"` カーネル起動直後に実行するコード
- `PIDE_DEV_SCRIPT="window.pide.openVariable('x')"` 起動後に実行する JS(`window.pide` に `openFile` / `openVariable` / `plotVariable` / `dockApi` を公開)
- `PIDE_PYTHON` 起動時に使うインタープリタを固定する
- `PIDE_HELPER_DIR` `pide_kernel` を置いたディレクトリを明示する

## 今後の候補

- コード署名と公証(Apple Developer ID、Windows 証明書)
- Windows / Linux の GUI の実機確認(特に Windows の ConPTY の終了検出とパス区切り)
- 実際の OpenSSH ホストでのリモートカーネルの確認(開発中は ssh 互換のスタブで検証)
- Git の差分で `.gitattributes` の eol 指定と `core.eol` に対応する

## ライセンス

MIT License。詳細は `LICENSE` を参照。
