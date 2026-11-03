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
conda create -n pide-test python=3.12
~/miniconda3/envs/pide-test/bin/python -m pip install ipykernel numpy pandas polars pyarrow matplotlib plotly scipy scikit-learn pillow xarray torch torchvision jax basedpyright ruff
PIDE_PYTHON=~/miniconda3/envs/pide-test/bin/python npm run tauri dev   # この環境で起動
```

Workspace / Variable Viewer / 画像ビューワーで検証済みの型: numpy、pandas(category / datetime / NaN 含む)、polars DataFrame / Series、torch Tensor(CPU / MPS / requires_grad / float16 / bool)、torch.nn.Module(パラメータ一覧、`model.0.weight` のように掘れる)、jax Array、xarray DataArray、PIL Image、scikit-learn 推定器(属性一覧)。

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

## 実装済み(第 5 段階: デバッガとリモートカーネル)

### デバッガ
- ipykernel 内蔵のデバッガ(debugpy)を Jupyter の `debug_request`(control チャネル)経由で使う。カーネルの名前空間を保ったまま止められる。リモートカーネルでもそのまま使える
- DEBUG タブ: Debug File(保存してから実ファイル名で実行)、Debug Cell(`# %%` セルまたは選択範囲。`dumpCell` で一時ファイルに対応付け)、Continue / Step / Step In / Step Out / Quit(F5 / F10 / F11 / Shift+F11 / Shift+F5)
- エディタの左余白クリックでブレークポイント(永続化)。停止行は矢印と黄色の帯で表示し、別ファイルなら開いてジャンプ
- 停止中は Workspace がそのフレームの変数一覧(K>> 表示、フレーム切替、ツリー展開、「→ ws」でカーネルのグローバルへコピー)に切り替わる。Command Window のプロンプトは `K>>`
- Debugger パネル: コールスタック(ダブルクリックでジャンプ)とブレークポイント一覧
- HOME の Run(F5)も `pide_kernel.run_file` で実ファイル名実行に変更(トレースバックにファイル名が出る)

### リモートカーネル
- ENVIRONMENT のセレクタから「Remote kernel (SSH)…」(または ⇄ ボタン)。ホスト、ポート、リモートの python、作業フォルダをプロファイルとして保存できる
- 仕組み: ヘルパーパッケージを `~/.pide` に転送 → リモートでブートストラップ(空きポート確保、接続情報出力、ipykernel を exec)→ 別の ssh セッションで 5 ポートを `-L` 転送 → ローカルと同じ経路で接続。割り込みは control チャネルの `interrupt_request`
- 鍵認証が必要(BatchMode)。ssh コマンドは `PIDE_SSH` で差し替え可能(テストでは `fake_ssh.py` シムを使用)
- 「Connection file…」で起動済みカーネルの接続ファイルを指定して接続できる(ポートを公開したコンテナなど。リモート側に `pide_kernel` が import できる必要あり)
- Docker 専用の起動は未実装(SSH でコンテナに入るか、接続ファイル方式を使う)

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

- Git のコンフリクト解決の支援
- 条件付きブレークポイント、例外で停止
- リモートファイルのブラウズ(現状 Current Folder はローカルのみ)
- 配布ビルド(`npm run tauri build`)とコード署名

## ライセンス

MIT License。詳細は `LICENSE` を参照。
