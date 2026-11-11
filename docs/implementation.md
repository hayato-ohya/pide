# Pide 実装記録

段階ごとに実装した機能と、その後の改善で加えた挙動の記録。使い方の概要とビルド手順は [README](../README.md) を参照。

## 実装済み(第 1 段階)

- ipykernel の起動・割り込み・再起動、インタープリタ選択(conda / pyenv / PATH を自動検出)
- Command Window: 入力補完判定(`is_complete`)、履歴(↑↓。複数行の入力では 1 行目 / 最終行で履歴を移動)、stdout / stderr、ANSI トレースバック、`input()` 対応。`\r` による進捗表示(tqdm など)は同じ行を上書きし、`clear_output(wait=True)` は次の出力の直前に消す。日本語 IME の変換確定 Enter では送信しない
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

- Rust 側は git2(libgit2)で実装(`apps/desktop/src-tauri/src/git.rs`)。fetch / pull / push だけは `git` コマンドを呼び出す(ユーザーの ssh-agent や credential helper をそのまま使うため)。プロンプトは出さない設定(`GIT_TERMINAL_PROMPT=0`。`core.sshCommand` / `GIT_SSH_COMMAND` / `GIT_SSH` が未設定のときだけ `ssh -o BatchMode=yes` を使い、設定があればそれを尊重する)なので、認証が必要なら事前に鍵や helper を設定しておく。300 秒でタイムアウトすると git / ssh プロセスも終了させる
- Git パネル(Current Folder の隣のタブ、VIEW タブからも開ける)
  - Changes: Staged / Changes / Untracked / Conflicts を分けて表示。行ホバーで stage / unstage / discard、見出しで一括。コミットメッセージ(Cmd+Enter)、amend(メッセージ欄が空なら元のメッセージを維持)。ステージが空の通常コミットは拒否。リネームは「old → new」で表示し、unstage は両方のパスに効く。unstage はパス文字列をそのまま扱う(`a[1].py` が `a1.py` にマッチしない)。バイナリと 2MB 超のファイルは +/− 行数を数えない
  - merge / rebase / cherry-pick / revert の途中は Commit を無効にし、Continue を案内する(MERGE_HEAD を失ったコミットを防ぐ)
  - History: 全ブランチの履歴グラフ(マージの車線表示)、HEAD / ローカル / リモートのラベル、コミット選択でその変更ファイル一覧(+/−行数)
  - ブランチの切替と新規作成(ヘッダのセレクタ)、リポジトリでなければ `git init` ボタン
  - リモートブランチ(`origin/feature` など)の checkout は、追跡するローカルブランチを作って(あれば再利用して)切り替える
  - Fetch(--all --prune)/ Pull(--ff-only、右クリックで --rebase)/ Push(上流がなければ Publish で `-u <remote> <branch>`。remote はブランチの設定 → `origin` → 唯一の remote の順に選ぶ。右クリックで --force-with-lease)。↑↓ で ahead / behind を表示。リモートがなければ「＋ remote」で origin を登録
- 差分ビューワー: ファイルをダブルクリックで Monaco の左右差分(作業ツリー / インデックス / 任意コミット)。コミット差分・ステージ差分でもリネームを検出する。`core.autocrlf` が true / input のときは両側を LF に揃えて比較する(`.gitattributes` の eol 指定や `core.eol` は未対応)
- ipynb のセル単位差分: cell id(なければソースの LCS)でセルを対応付け、変更セルはインライン差分、追加 / 削除セルは色分け。出力は無視し、出力数の変化だけ注記
- Current Folder にファイルの状態バッジ(M / A / D / ? と、配下に変更があるフォルダの •)
- コンフリクト解決: 「⑂ Merge」でブランチをマージ。merge / rebase / cherry-pick / revert の途中はパネル上部にバナー(Continue / Abort)。Conflicts の各ファイルは ours / theirs / resolved(作業ツリーのまま stage)をワンクリック(ours / theirs は libgit2 の checkout で書き出すので、eol フィルタ・実行ビット・シンボリックリンクが保たれる)、ダブルクリックで ours ⇄ theirs / base ⇄ ours / base ⇄ theirs / ours ⇄ 作業ツリーの比較ビュー。エディタではコンフリクト範囲を色分けし、上部バーの Accept ours / theirs / both / Next と「Mark resolved」(保存して stage)で解決できる。マーカーが残ったままの stage は確認を求める
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
- 仕組み: ヘルパーパッケージを `~/.pide` に転送 → リモートでブートストラップ(空きポート確保、ipykernel を子プロセスとして起動し、5 ポートが listen してから接続情報を出力)→ 別の ssh セッションで 5 ポートを `-L` 転送 → ローカルと同じ経路で接続(トンネルが先に上がっても期限 60 秒までリトライ)。割り込みは control チャネルの `interrupt_request`
- 後始末: ブートストラップはカーネルの親として残り、ssh の標準入力が閉じたら(アプリの終了やクラッシュを含む)カーネルを止めて接続ファイルを消す。トンネルもリモートで `cat` を動かして標準入力を監視するので、アプリと一緒に終わる。そのためシェルを使えないポートフォワード専用アカウントでは動かない。古い `~/.pide/run/kernel-*.json` は次回起動時に掃除する。リモートのログインシェルは sh / bash / zsh / csh / tcsh のいずれでもよい
- 鍵認証が必要(BatchMode、ConnectTimeout 15 秒)。初回接続先は事前に Terminal タブから `ssh user@host` でホスト鍵を受け入れておく。ssh コマンドはデバッグビルドでのみ `PIDE_SSH` で差し替え可能
- 「Connection file…」で起動済みカーネルの接続ファイルを指定して接続できる(ポートを公開したコンテナなど。リモート側に `pide_kernel` が import できる必要あり)
- Docker 専用の起動は未実装(SSH でコンテナに入るか、接続ファイル方式を使う)
- リモートファイルの閲覧: リモートカーネル使用中は Current Folder、エディタ、ノートブックがカーネル側のファイルを扱う(カーネル内の `pide_kernel.fs_*` 経由、追加の SSH セッション不要)。接続後は作業フォルダがリモートの cwd になり、Current Folder にホスト名バッジが付く。「名前を付けて保存」はパス入力。Git パネルはリモート中は無効。LSP はローカルの環境で解析するため、リモートにしかないパッケージは未解決と出ることがある

## ターミナル

- Command Window の隣の「Terminal」タブ(VIEW タブや Ctrl+` でも開く)。＋ で複数タブ
- Rust 側は portable-pty で PTY を開き、ログインシェル(`$SHELL -l`、conda / pyenv の初期化が走る)を作業フォルダで起動。表示は xterm.js で、パネルのサイズに追従し、テーマにも連動。入力は端末ごとの書き込みスレッドで送るので、大量に貼り付けても UI や他の端末は固まらない。シェルが終了すると終了コードを表示する
- リモートカーネル使用中に開くと、そのホストへ `ssh -t` で入り、設定したリモートフォルダに移動する
- 環境変数 `PIDE=1` と `PIDE_PYTHON`(選択中のインタープリタ)を渡す

## ノートブック(.ipynb)

- Current Folder や Open… から .ipynb を開くとノートブックパネルになる。HOME の「New Notebook」で新規作成
- コードセルは Monaco(高さ自動)。Markdown セルはレンダリング表示で、ダブルクリックすると左に Monaco(Markdown)、右にライブプレビューの分割編集になる(◧ でプレビュー切替、Shift+Enter / Esc / ✓ で確定)
- Shift+Enter(実行して次へ、末尾なら新規セル)、Cmd+Enter(実行)、Alt+Enter(実行して下に挿入)、Cmd+S(保存)。ツールバーに Run All / Run Above / 移動 / 削除 / 種別変更 / Clear Outputs
- 出力はセルに表示し、画像は Figures パネルにも流す。実行後は Workspace も更新される
- nbformat 4 で保存(cell id、出力、実行番号を保持)。attachments やセル・ノートブックの未知のフィールドもそのまま書き戻す。cell id を書くときは `nbformat_minor` を 5 以上にする。`display_id` は保存しない。Git パネルのセル単位差分と組み合わせて使える
- Raw セルは実行しない。Run All / Run Above はエラーや割り込みで止まる
- `update_display_data` は同じ `display_id` を持つ出力をノートブック内のどこでも更新する
- LSP: `notebookDocument` 同期でセルを 1 つの名前空間として扱う(別セルで定義した変数の補完、ホバー、診断)。セルの URI は VS Code 互換の `vscode-notebook-cell:<path>#<cellId>`
- デバッグ: セルの左余白でブレークポイント、ツールバーの 🐞 Debug でそのセルをデバッガ下で実行。停止行の表示、ステップ、Workspace のフレーム変数は .py と同じ
- 整形: ツールバーの Format(選択セル、Shift+Alt+F)/ Format All で ruff 整形
- 出力の折りたたみ: 出力左上の ▾ か Cmd+O でセルごとに折りたたみ、⇕ Outputs で一括。40 行を超える出力は自動的に高さ制限(クリックで全表示)。折りたたみ状態は `metadata.collapsed` / `jupyter.outputs_hidden` として保存(Jupyter 互換)
- 実行 ID はフロントエンドで生成し、出力ハンドラを登録してから送信する(出力の取りこぼし防止)

## 堅牢性

### カーネル接続
- ユーザーのセル実行にはタイムアウトがない(長時間の学習ループも完了まで待つ)。起動中・再起動中の実行は、起動が終わるのを待ってから送る
- 起動はキャンセルできる。起動中の Restart、カーネル停止、アプリ終了で中断し、途中まで起動したプロセス(SSH を含む)は片付ける
- ローカルカーネルは独自のプロセスグループで動かす(Unix)。割り込みはグループ全体に SIGINT を送るので、ユーザーコードが起動した `subprocess` も止まる。終了時はグループごと kill する
- ipykernel が起動直後に終了した場合(未インストール、パス誤り)は、待たずにカーネルの stderr の末尾を添えてエラーにする
- shell / control / stdin チャネルは切断されると同じ identity で再接続する(iopub は ZeroMQ が再接続する)。切断を検知する前に送った要求の返事が失われた場合は、再接続後に "unknown" として片付ける
- 「Kernel died」には理由(プロセス終了 / 接続断 / heartbeat)が付く。heartbeat の途絶だけなら 30 秒待ち、その間に回復すれば実行中のセルの出力はそのままセルに流れる
- busy 表示は自分が送った実行だけから決める(デバッガの要求や Workspace の更新で「Ready」に戻らない)

### ファイル
- 外部での変更を検出する: ウィンドウにフォーカスが戻ったときと、Git の discard / checkout / merge / pull / コンフリクト解決の後に開いているファイルを確認し、未編集なら再読込(エディタは undo 可能)、編集中なら再読込するか確認する
- 保存中に入力した内容は未保存のまま扱う。Default Layout は未保存のパネルがあれば確認する
- 保存は一時ファイル経由で置き換える。シンボリックリンクはリンク先の実ファイルに書き、パーミッションも保つ。リモートでも同様で、改行コード(CRLF)を保持する
- UTF-8 以外のファイルと 50MB を超えるファイルは開かない(壊して保存するのを防ぐため)

### 言語サーバー
- サーバーが落ちたら 1 / 2 / 4 秒の間隔で再起動する(60 秒以内に 3 回を超えたら諦めて Console に表示)。落ちたサーバーの診断は消す
- 再起動はインタープリタかワークスペースのルートが変わったときだけ(カーネルの再起動では pyright を再解析しない)
- auto-import 補完は import 行も挿入する

### 出力の表示
- HTML 出力は DOMPurify で無害化し、`<style>` も除去する(信頼できないノートブックがアプリ全体の見た目を変えられないように)

### macOS で Finder / Dock から起動した場合
- launchd の最小の PATH しか持たないので、起動時にログインシェルから PATH を取り込む(最大 3 秒)。Homebrew / conda / npm で入れた python・basedpyright・git が見つかる。ターミナルから起動した場合は PATH をそのまま使う(activate 済みの conda 環境が優先される)
- `LANG` / `LC_ALL` / `LC_CTYPE` がすべて未設定なら `LANG=en_US.UTF-8` にする(ターミナルの日本語の文字化け対策)

## テーマ

VIEW タブの THEME で Light / Dark / System を切り替えられる(保存される)。配色は `styles.css` の CSS 変数(`:root` と `:root[data-theme="dark"]`)に集約し、Monaco(エディタ・差分)、dockview、Plotly も連動する。
