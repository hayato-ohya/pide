# Pide — MATLAB 風 Python IDE

Rust(Tauri 2)+ TypeScript(React)で作る、MATLAB のワークフローを Python に持ち込む IDE。

## 構成

```
crates/kernel-client/   Jupyter ワイヤプロトコルの Rust 実装(ZeroMQ, HMAC, ipykernel 起動)。UI 非依存
python/pide_kernel/    カーネル内で動く変数収集パッケージ(user_expressions 経由で呼ばれる)
apps/desktop/           Tauri アプリ
  src-tauri/            Rust バックエンド(カーネル所有、イベント転送、ファイル操作)
  src/                  React フロントエンド(dockview レイアウト、Monaco、Plotly)
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

- Rust: `cargo test -p kernel-client`(HMAC 署名の往復・改ざん検出、シェル引用、接続情報)
- Python: `python -m pytest python/tests -q`(ヘルパーのスナップショット、パス解決、統計、プロット、ファイル操作)
- GitHub Actions(`.github/workflows/ci.yml`)が push / PR ごとに macOS / Linux / Windows で上記とフロントエンドのビルド、カーネルのスモークテストを実行します

## 配布ビルド

```
cd apps/desktop && npm run tauri build
```

成果物は `target/release/bundle/` に出ます(macOS: `macos/Pide.app` と `dmg/Pide_<version>_aarch64.dmg`、Linux: `deb/` と `appimage/`、Windows: `msi/` と `nsis/`)。Python ヘルパー(`python/pide_kernel`)はアプリのリソースとして同梱されるので、実行には Python 3.10 以上と `ipykernel`(デバッグには `debugpy`、補完には `basedpyright` / `ruff`)が入った環境だけが必要です。

`v*` のタグを push すると `.github/workflows/release.yml` が 4 ターゲット(macOS Apple Silicon / Intel、Linux x86_64、Windows x86_64)のインストーラを作り、ドラフトの GitHub Release に添付します(`workflow_dispatch` で手動実行した場合は Actions のアーティファクトに残ります)。

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

## 実装済み(第 1 段階)

- ipykernel の起動・割り込み・再起動、インタープリタ選択(conda / pyenv / PATH を自動検出)
- Command Window: 入力補完判定(`is_complete`)、履歴(↑↓)、stdout / stderr、ANSI トレースバック、`input()` 対応
- Workspace: 実行のたびに全変数を要約(型、shape、dtype、device、要素数、バイト数、min / max / mean / NaN 数)。変化した変数をハイライト。モジュール・関数・`_` 付きの表示切替。列の表示切替、ソート、フィルタ
- Variable Viewer: 仮想スクロールの 2 次元グリッド(200 行 × 50 列のブロックを遅延取得)。ndarray / torch / jax / pandas / polars / dict / list / 一般オブジェクト。N 次元配列は先頭軸のインデックスで 2 次元スライス
- Figures: matplotlib(inline)、plotly、Workspace からの plot / scatter / bar / histogram / imagesc
- Editor: Monaco、`# %%` セル、F5 / Ctrl+Enter / Ctrl+S
- Current Folder、Command History、dockview による自由配置(レイアウトは自動保存、View タブから既定に戻す)

## 実装済み(第 2 段階: エディタ強化)

- 言語サーバーの Rust ホスト(`apps/desktop/src-tauri/src/lsp.rs`): stdio の JSON-RPC を中継する汎用実装
- basedpyright: 補完(resolve 付き)、ホバー、シグネチャヘルプ、定義ジャンプ(別ファイルは新しいタブで開く)、診断
- ruff: lint 診断、整形(Shift+Alt+F または EDITOR タブの Format)
- linter / formatter の切替(EDITOR タブまたは VIEW タブの「⚙ Linter / Formatter…」): linter は ruff / flake8 / pylint / none、formatter は ruff / black / autopep8 / none。追加引数と行長も指定できる。ruff 以外は LSP を話さないので、インタープリタの環境(なければ PATH)のコマンドを標準入力で実行して結果を取り込む(入力後 0.6 秒で再 lint)。ノートブックのセルにも適用。pyright の型診断は常に有効
- サーバーはカーネルのインタープリタと同じ環境から探す(`pip install basedpyright ruff`)。見つからなければコンソールに案内を出す。ステータスバー右端に稼働状態を表示
- ホームディレクトリやルートが作業フォルダのときはワークスペースなしで起動(全ファイル走査を避ける)
- Command Window の Tab 補完(カーネルの `complete_request`。候補が複数なら選択ポップアップ)

## 実装済み(第 3 段階: 可視化の強化)

- 画像ビューワー(Variable Viewer の Table / Image 切替、Workspace 右クリックの View as image、PLOTS タブの image viewer): 2 次元配列はカラーマップ(viridis / magma / gray / jet / coolwarm / hot)、HWC / CHW は RGB 表示。NCHW のようなバッチは先頭軸のセレクタでページ送り。min / max の手動指定、ズーム、ホバーで座標と概算値。大きい画像はカーネル側で間引き
- 変数ビューワーの列選択(列ヘッダをクリック、Cmd / Ctrl で複数)→ PLOTS タブでその列だけをプロット(`df[["a","b"]]` や `x[:, [1, 3]]` の式を生成)
- Workspace の複数選択(Cmd / Ctrl / Shift クリック)→ 重ね描き、または subplots でグリッド表示
- Figures: フロートウィンドウ化(⧉ Float)、PNG 保存、log x / log y 切替

## 実装済み(第 4 段階: Git)

- Rust 側は git2(libgit2)で実装(`apps/desktop/src-tauri/src/git.rs`)。fetch / pull / push だけは `git` コマンドを呼び出す(ユーザーの ssh-agent や credential helper をそのまま使うため)。プロンプトは出さない設定(`GIT_TERMINAL_PROMPT=0`、`BatchMode=yes`)なので、認証が必要なら事前に鍵や helper を設定しておく
- Git パネル(Current Folder の隣のタブ、VIEW タブからも開ける)
  - Changes: Staged / Changes / Untracked / Conflicts を分けて表示。行ホバーで stage / unstage / discard、見出しで一括。コミットメッセージ(Cmd+Enter)、amend
  - History: 全ブランチの履歴グラフ(マージの車線表示)、HEAD / ローカル / リモートのラベル、コミット選択でその変更ファイル一覧(+/−行数)
  - ブランチの切替と新規作成(ヘッダのセレクタ)、リポジトリでなければ `git init` ボタン
  - Fetch(--all --prune)/ Pull(--ff-only、右クリックで --rebase)/ Push(上流がなければ Publish で `-u origin <branch>`、右クリックで --force-with-lease)。↑↓ で ahead / behind を表示。リモートがなければ「＋ remote」で origin を登録
- 差分ビューワー: ファイルをダブルクリックで Monaco の左右差分(作業ツリー / インデックス / 任意コミット)
- ipynb のセル単位差分: cell id(なければソースの LCS)でセルを対応付け、変更セルはインライン差分、追加 / 削除セルは色分け。出力は無視し、出力数の変化だけ注記
- Current Folder にファイルの状態バッジ(M / A / D / ? と、配下に変更があるフォルダの •)
- コンフリクト解決: 「⑂ Merge」でブランチをマージ。merge / rebase / cherry-pick / revert の途中はパネル上部にバナー(Continue / Abort)。Conflicts の各ファイルは ours / theirs / resolved(作業ツリーのまま stage)をワンクリック、ダブルクリックで ours ⇄ theirs / base ⇄ ours / base ⇄ theirs / ours ⇄ 作業ツリーの比較ビュー。エディタではコンフリクト範囲を色分けし、上部バーの Accept ours / theirs / both / Next と「Mark resolved」(保存して stage)で解決できる。マーカーが残ったままの stage は確認を求める
- Current Folder と Git パネルは表示中だけポーリングする(非表示タブや最小化中は停止、ウィンドウにフォーカスが戻ると即更新)

### アクセシビリティ

- ダイアログは `role="dialog"` でフォーカスを閉じ込め、Esc で閉じ、閉じた後は元の要素にフォーカスを戻す
- アイコンだけのボタンには `aria-label`、ステータスバーはライブリージョン
- キーボード操作: リボンのタブは ← →、Workspace / Current Folder の行は ↑ ↓ Home End、Enter で開く(Current Folder は Backspace で上へ)、Workspace の Shift+F10 でコンテキストメニュー(メニュー内は ↑ ↓ Enter Esc)、Git の行は Enter で差分 / コンフリクトビュー

## 実装済み(第 5 段階: デバッガとリモートカーネル)

### デバッガ
- ipykernel 内蔵のデバッガ(debugpy)を Jupyter の `debug_request`(control チャネル)経由で使う。カーネルの名前空間を保ったまま止められる。リモートカーネルでもそのまま使える
- DEBUG タブ: Debug File(保存してから実ファイル名で実行)、Debug Cell(`# %%` セルまたは選択範囲。`dumpCell` で一時ファイルに対応付け)、Continue / Step / Step In / Step Out / Quit(F5 / F10 / F11 / Shift+F11 / Shift+F5)
- エディタの左余白クリックでブレークポイント(永続化)。右クリック(または Alt+クリック)で条件式、ヒット回数(`5`、`>= 3`、`% 10`)、ログポイント(`{式}` を埋め込んで出力、停止しない。書式指定は不可)を設定。条件付きは黄色、ログポイントは青で表示
- 例外停止: DEBUG タブと Debugger パネルの「Uncaught」「Raised」。ipykernel 内では例外が最終的にカーネルに捕捉されるため、Uncaught は debugpy の `userUnhandled` フィルタで実現。停止時は例外の種類・メッセージ・トレースを Debugger パネルに表示
- 停止行は矢印と黄色の帯で表示し、別ファイルなら開いてジャンプ
- 停止中は Workspace がそのフレームの変数一覧(K>> 表示、フレーム切替、ツリー展開、「→ ws」でカーネルのグローバルへコピー)に切り替わる。Command Window のプロンプトは `K>>`
- Debugger パネル: コールスタック(ダブルクリックでジャンプ)とブレークポイント一覧
- HOME の Run(F5)も `pide_kernel.run_file` で実ファイル名実行に変更(トレースバックにファイル名が出る)

### リモートカーネル
- ENVIRONMENT のセレクタから「Remote kernel (SSH)…」(または ⇄ ボタン)。ホスト、ポート、リモートの python、作業フォルダをプロファイルとして保存できる
- 仕組み: ヘルパーパッケージを `~/.pide` に転送 → リモートでブートストラップ(空きポート確保、接続情報出力、ipykernel を exec)→ 別の ssh セッションで 5 ポートを `-L` 転送 → ローカルと同じ経路で接続。割り込みは control チャネルの `interrupt_request`
- 鍵認証が必要(BatchMode)。初回接続先は事前に Terminal タブから `ssh user@host` でホスト鍵を受け入れておく。ssh コマンドはデバッグビルドでのみ `PIDE_SSH` で差し替え可能
- 「Connection file…」で起動済みカーネルの接続ファイルを指定して接続できる(ポートを公開したコンテナなど。リモート側に `pide_kernel` が import できる必要あり)
- Docker 専用の起動は未実装(SSH でコンテナに入るか、接続ファイル方式を使う)
- リモートファイルの閲覧: リモートカーネル使用中は Current Folder、エディタ、ノートブックがカーネル側のファイルを扱う(カーネル内の `pide_kernel.fs_*` 経由、追加の SSH セッション不要)。接続後は作業フォルダがリモートの cwd になり、Current Folder にホスト名バッジが付く。「名前を付けて保存」はパス入力。Git パネルはリモート中は無効。LSP はローカルの環境で解析するため、リモートにしかないパッケージは未解決と出ることがある

## ターミナル

- Command Window の隣の「Terminal」タブ(VIEW タブや Ctrl+` でも開く)。＋ で複数タブ
- Rust 側は portable-pty で PTY を開き、ログインシェル(`$SHELL -l`、conda / pyenv の初期化が走る)を作業フォルダで起動。表示は xterm.js で、パネルのサイズに追従し、テーマにも連動
- リモートカーネル使用中に開くと、そのホストへ `ssh -t` で入り、設定したリモートフォルダに移動する
- 環境変数 `PIDE=1` と `PIDE_PYTHON`(選択中のインタープリタ)を渡す

## ノートブック(.ipynb)

- Current Folder や Open… から .ipynb を開くとノートブックパネルになる。HOME の「New Notebook」で新規作成
- コードセルは Monaco(高さ自動)。Markdown セルはレンダリング表示で、ダブルクリックすると左に Monaco(Markdown)、右にライブプレビューの分割編集になる(◧ でプレビュー切替、Shift+Enter / Esc / ✓ で確定)
- Shift+Enter(実行して次へ、末尾なら新規セル)、Cmd+Enter(実行)、Alt+Enter(実行して下に挿入)、Cmd+S(保存)。ツールバーに Run All / Run Above / 移動 / 削除 / 種別変更 / Clear Outputs
- 出力はセルに表示し、画像は Figures パネルにも流す。実行後は Workspace も更新される
- nbformat 4 で保存(cell id、出力、実行番号を保持)。Git パネルのセル単位差分と組み合わせて使える
- LSP: `notebookDocument` 同期でセルを 1 つの名前空間として扱う(別セルで定義した変数の補完、ホバー、診断)。セルの URI は VS Code 互換の `vscode-notebook-cell:<path>#<cellId>`
- デバッグ: セルの左余白でブレークポイント、ツールバーの 🐞 Debug でそのセルをデバッガ下で実行。停止行の表示、ステップ、Workspace のフレーム変数は .py と同じ
- 整形: ツールバーの Format(選択セル、Shift+Alt+F)/ Format All で ruff 整形
- 出力の折りたたみ: 出力左上の ▾ か Cmd+O でセルごとに折りたたみ、⇕ Outputs で一括。40 行を超える出力は自動的に高さ制限(クリックで全表示)。折りたたみ状態は `metadata.collapsed` / `jupyter.outputs_hidden` として保存(Jupyter 互換)
- 実行 ID はフロントエンドで生成し、出力ハンドラを登録してから送信する(出力の取りこぼし防止)

## テーマ

VIEW タブの THEME で Light / Dark / System を切り替えられる(保存される)。配色は `styles.css` の CSS 変数(`:root` と `:root[data-theme="dark"]`)に集約し、Monaco(エディタ・差分)、dockview、Plotly も連動する。

## 今後の候補

- コード署名と公証(Apple Developer ID、Windows 証明書)
- Windows / Linux の GUI の実機確認

## ライセンス

MIT License。詳細は `LICENSE` を参照。
