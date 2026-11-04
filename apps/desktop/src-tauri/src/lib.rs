//! Tauri backend: owns the kernel, forwards every Jupyter message to the
//! webview as a `kernel-event`, and exposes file-system helpers.

mod git;
mod lsp;
mod term;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use kernel_client::{Channel, Kernel, LaunchSpec};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::Mutex;

#[derive(Default)]
pub struct AppState {
    kernel: Mutex<Option<Arc<Kernel>>>,
    /// Serializes start / shutdown so two overlapping restarts cannot leak a kernel.
    lifecycle: Mutex<()>,
    python: Mutex<Option<String>>,
    cwd: Mutex<Option<String>>,
}

#[derive(Serialize, Clone)]
struct KernelEvent {
    channel: Channel,
    msg_type: String,
    msg_id: String,
    parent_id: Option<String>,
    header: kernel_client::Header,
    content: Value,
    metadata: Value,
}

#[derive(Serialize, Clone)]
struct KernelStatus {
    state: String,
    python: Option<String>,
    cwd: Option<String>,
    detail: Option<String>,
}

/// Append an event, merging it into the previous one when both are `stream`
/// messages of the same parent and stream name.
fn push_coalesced(batch: &mut Vec<KernelEvent>, ev: KernelEvent) {
    if ev.msg_type == "stream" {
        if let Some(last) = batch.last_mut() {
            if last.msg_type == "stream" && last.parent_id == ev.parent_id && last.content.get("name") == ev.content.get("name") {
                let add = ev.content.get("text").and_then(|t| t.as_str()).unwrap_or("").to_string();
                if let Some(serde_json::Value::String(t)) = last.content.get_mut("text") {
                    if t.len() + add.len() <= 256 * 1024 {
                        t.push_str(&add);
                        return;
                    }
                }
            }
        }
    }
    batch.push(ev);
}

fn emit_status(app: &AppHandle, state: &str, python: Option<String>, cwd: Option<String>, detail: Option<String>) {
    let _ = app.emit("kernel-status", KernelStatus { state: state.into(), python, cwd, detail });
}

/// Directory holding the `pide_kernel` helper package.
fn helper_dir(app: &AppHandle) -> PathBuf {
    #[cfg(debug_assertions)]
    if let Ok(p) = std::env::var("PIDE_HELPER_DIR") {
        return PathBuf::from(p);
    }
    // Bundled resource (release builds).
    if let Ok(dir) = app.path().resource_dir() {
        let p = dir.join("python");
        if p.join("pide_kernel").exists() {
            return p;
        }
    }
    // Source tree (dev builds).
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../python")
}

/// A JSON string literal is also a valid Python string literal (Rust's `{:?}` is not).
fn pyq(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| "''".into())
}

fn ws_expr(include_hidden: bool) -> String {
    format!("__import__('pide_kernel').snapshot(include_hidden={})", if include_hidden { "True" } else { "False" })
}

async fn kernel(state: &State<'_, AppState>) -> Result<Arc<Kernel>, String> {
    state.kernel.lock().await.clone().ok_or_else(|| "kernel not running".to_string())
}

#[tauri::command]
async fn start_kernel(
    app: AppHandle,
    state: State<'_, AppState>,
    python: Option<String>,
    cwd: Option<String>,
    remote: Option<kernel_client::launch::RemoteSpec>,
    connection_file: Option<String>,
) -> Result<Value, String> {
    let _guard = state.lifecycle.lock().await;
    // Stop an existing kernel first.
    let old = state.kernel.lock().await.take();
    if let Some(old) = old {
        let _ = old.shutdown(false).await;
    }
    let python = python
        .or(state.python.lock().await.clone())
        .unwrap_or_else(|| default_python().to_string());
    let cwd = cwd.or(state.cwd.lock().await.clone());
    emit_status(&app, "starting", Some(python.clone()), cwd.clone(), None);

    let helper = helper_dir(&app);
    let mut pythonpath = helper.to_string_lossy().to_string();
    if let Ok(existing) = std::env::var("PYTHONPATH") {
        let sep = if cfg!(windows) { ';' } else { ':' };
        pythonpath = format!("{pythonpath}{sep}{existing}");
    }
    let spec = LaunchSpec {
        python: PathBuf::from(&python),
        cwd: cwd.clone().map(PathBuf::from),
        env: vec![
            ("PYTHONPATH".into(), pythonpath),
            ("MPLBACKEND".into(), "module://matplotlib_inline.backend_inline".into()),
            // ipykernel's parent poller exits the kernel when Pide dies (also on crash).
            // Python >= 3.11: do not put the cwd first on sys.path (untrusted folders).
        ],
    };
    let launched = if let Some(mut r) = remote {
        // Remote kernel over SSH: ship the helper package with it.
        #[cfg(debug_assertions)]
        if r.ssh.is_none() { r.ssh = std::env::var("PIDE_SSH").ok(); }
        let helper_src = std::fs::read_to_string(helper.join("pide_kernel/__init__.py")).map_err(|e| format!("helper source: {e}"))?;
        Kernel::launch_remote(r, &helper_src).await
    } else if let Some(cf) = connection_file {
        // Attach to a running kernel (needs pide_kernel importable there).
        let txt = std::fs::read_to_string(&cf).map_err(|e| format!("connection file: {e}"))?;
        let info: kernel_client::ConnectionInfo = serde_json::from_str(&txt).map_err(|e| format!("connection file: {e}"))?;
        Kernel::connect(info).await
    } else {
        Kernel::launch(spec).await
    };
    let k = match launched {
        Ok(k) => k,
        Err(e) => {
            emit_status(&app, "dead", Some(python.clone()), cwd.clone(), Some(format!("{e:#}")));
            return Err(format!("{e:#}"));
        }
    };

    // Forward every message to the webview, batched per ~16 ms frame with
    // consecutive stream chunks coalesced, so a tight print loop cannot
    // out-run IPC serialization and starve the reply that ends the cell.
    let mut rx = k.subscribe();
    let app2 = app.clone();
    tokio::spawn(async move {
        let mut batch: Vec<KernelEvent> = Vec::new();
        let mut tick = tokio::time::interval(std::time::Duration::from_millis(16));
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let mut lagged: u64 = 0;
        loop {
            tokio::select! {
                r = rx.recv() => match r {
                    Ok(ev) => {
                        let payload = KernelEvent {
                            channel: ev.channel,
                            msg_type: ev.msg.header.msg_type.clone(),
                            msg_id: ev.msg.header.msg_id.clone(),
                            parent_id: ev.msg.parent_id().map(|s| s.to_string()),
                            header: ev.msg.header.clone(),
                            content: ev.msg.content,
                            metadata: ev.msg.metadata,
                        };
                        push_coalesced(&mut batch, payload);
                        if batch.len() >= 2048 {
                            let _ = app2.emit("kernel-events", std::mem::take(&mut batch));
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                        tracing::warn!("UI lagged {n} kernel events");
                        lagged += n;
                    }
                    Err(_) => {
                        if !batch.is_empty() { let _ = app2.emit("kernel-events", std::mem::take(&mut batch)); }
                        break;
                    }
                },
                _ = tick.tick() => {
                    if !batch.is_empty() {
                        let _ = app2.emit("kernel-events", std::mem::take(&mut batch));
                    }
                    if lagged > 0 {
                        let _ = app2.emit("kernel-lagged", lagged);
                        lagged = 0;
                    }
                }
            }
        }
    });

    // Liveness watcher.
    let app3 = app.clone();
    let k2 = k.clone();
    let py = python.clone();
    let cwd2 = cwd.clone();
    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = k2.cancelled() => break,
                _ = tokio::time::sleep(std::time::Duration::from_secs(2)) => {}
            }
            if !k2.is_alive().await {
                emit_status(&app3, "dead", Some(py.clone()), cwd2.clone(), Some("kernel stopped responding (process exited, tunnel dropped or heartbeat lost)".into()));
                break;
            }
        }
    });

    *state.python.lock().await = Some(python.clone());
    *state.cwd.lock().await = cwd.clone();
    let info = serde_json::to_value(&k.info).map_err(|e| e.to_string())?;
    *state.kernel.lock().await = Some(k);
    emit_status(&app, "idle", Some(python), cwd, None);
    Ok(info)
}

#[derive(Deserialize)]
#[serde(default)]
struct ExecOpts {
    silent: bool,
    store_history: bool,
    workspace: bool,
    include_hidden: bool,
    /// Client-chosen msg_id (lets the UI register output handlers first).
    msg_id: Option<String>,
}
impl Default for ExecOpts {
    fn default() -> Self {
        ExecOpts { silent: false, store_history: true, workspace: true, include_hidden: false, msg_id: None }
    }
}

#[tauri::command]
async fn execute(state: State<'_, AppState>, code: String, opts: Option<ExecOpts>) -> Result<String, String> {
    let opts = opts.unwrap_or_default();
    let k = kernel(&state).await?;
    let mut ue = HashMap::new();
    if opts.workspace {
        ue.insert("ws".to_string(), ws_expr(opts.include_hidden));
    }
    k.execute_with_id(&code, opts.silent, opts.store_history, ue, true, opts.msg_id)
        .await
        .map_err(|e| e.to_string())
}

/// Evaluate a helper expression silently; the result comes back in the
/// execute_reply's user_expressions under `key`.
async fn user_expr(state: &State<'_, AppState>, key: &str, expr: String) -> Result<String, String> {
    let k = kernel(state).await?;
    let mut ue = HashMap::new();
    ue.insert(key.to_string(), expr);
    k.execute("", true, false, ue, false).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn refresh_workspace(state: State<'_, AppState>, include_hidden: bool) -> Result<String, String> {
    user_expr(&state, "ws", ws_expr(include_hidden)).await
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct Window {
    row0: usize,
    row1: usize,
    col0: usize,
    col1: usize,
    index: Option<Vec<usize>>,
}

#[tauri::command]
async fn variable_detail(state: State<'_, AppState>, path: String, win: Window) -> Result<String, String> {
    let idx = match &win.index {
        Some(v) => serde_json::to_string(v).unwrap(),
        None => "None".into(),
    };
    let expr = format!(
        "__import__('pide_kernel').detail({}, {}, {}, {}, {}, {})",
        pyq(&path), win.row0, win.row1.max(win.row0 + 1), win.col0, win.col1.max(win.col0 + 1), idx
    );
    user_expr(&state, "detail", expr).await
}

#[tauri::command]
async fn plot_data(state: State<'_, AppState>, path: String) -> Result<String, String> {
    user_expr(&state, "plot", format!("__import__('pide_kernel').plot_data({})", pyq(&path))).await
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct ImageOpts {
    index: Option<Vec<usize>>,
    vmin: Option<f64>,
    vmax: Option<f64>,
    layout: Option<String>,
}

#[tauri::command]
async fn variable_image(state: State<'_, AppState>, path: String, opts: ImageOpts) -> Result<String, String> {
    let idx = match &opts.index { Some(v) => serde_json::to_string(v).unwrap(), None => "None".into() };
    let f = |v: Option<f64>| v.filter(|x| x.is_finite()).map(|x| x.to_string()).unwrap_or_else(|| "None".into());
    let expr = format!(
        "__import__('pide_kernel').image({}, {}, {}, {}, {})",
        pyq(&path), idx, f(opts.vmin), f(opts.vmax), pyq(&opts.layout.unwrap_or_else(|| "auto".into()))
    );
    user_expr(&state, "image", expr).await
}

#[tauri::command]
async fn plot_expr(state: State<'_, AppState>, expr: String) -> Result<String, String> {
    user_expr(&state, "plot", format!("__import__('pide_kernel').plot_expr({})", pyq(&expr))).await
}

/// Forward a DAP request to the kernel's debugger (ipykernel + debugpy).
#[tauri::command]
async fn debug_request(state: State<'_, AppState>, content: Value) -> Result<String, String> {
    kernel(&state).await?.control("debug_request", content).await.map_err(|e| e.to_string())
}

/// Evaluate a `pide_kernel` helper call; the result comes back under user_expressions["eval"].
#[tauri::command]
async fn kernel_eval(state: State<'_, AppState>, expr: String) -> Result<String, String> {
    user_expr(&state, "eval", format!("__import__('pide_kernel').{expr}")).await
}

#[tauri::command]
async fn complete(state: State<'_, AppState>, code: String, cursor: usize) -> Result<String, String> {
    kernel(&state).await?.complete(&code, cursor).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn inspect(state: State<'_, AppState>, code: String, cursor: usize) -> Result<String, String> {
    kernel(&state).await?.inspect(&code, cursor, 0).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn is_complete(state: State<'_, AppState>, code: String) -> Result<String, String> {
    kernel(&state).await?.is_complete(&code).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn input_reply(state: State<'_, AppState>, parent: kernel_client::Header, value: String) -> Result<(), String> {
    kernel(&state).await?.input_reply(&parent, &value).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn interrupt_kernel(state: State<'_, AppState>) -> Result<(), String> {
    kernel(&state).await?.interrupt().await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn shutdown_kernel(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let _guard = state.lifecycle.lock().await;
    let k = state.kernel.lock().await.take();
    if let Some(k) = k {
        k.shutdown(false).await.map_err(|e| e.to_string())?;
    }
    emit_status(&app, "stopped", None, None, None);
    Ok(())
}

// ---------------------------------------------------------------- files ----

#[derive(Serialize)]
struct DirEntry {
    name: String,
    path: String,
    is_dir: bool,
    size: u64,
    modified: Option<u64>,
}

#[tauri::command(async)]
fn list_dir(path: String) -> Result<Vec<DirEntry>, String> {
    let mut out = vec![];
    for e in std::fs::read_dir(&path).map_err(|e| e.to_string())? {
        let e = e.map_err(|e| e.to_string())?;
        let md = e.metadata().map_err(|e| e.to_string())?;
        let name = e.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        out.push(DirEntry {
            name,
            path: fwd(&e.path()),
            is_dir: md.is_dir(),
            size: md.len(),
            modified: md.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_secs()),
        });
    }
    out.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then(a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(out)
}

#[tauri::command(async)]
fn read_text_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command(async)]
fn write_text_file(path: String, content: String) -> Result<(), String> {
    write_atomic(&path, content.as_bytes())
}

/// Write to a sibling temp file and rename, so a crash never leaves a truncated file.
fn write_atomic(path: &str, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    let p = std::path::Path::new(path);
    let dir = p.parent().filter(|d| !d.as_os_str().is_empty()).unwrap_or_else(|| std::path::Path::new("."));
    let tmp = dir.join(format!(".{}.pide-tmp", p.file_name().map(|n| n.to_string_lossy()).unwrap_or_default()));
    let mut f = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
    f.write_all(bytes).map_err(|e| e.to_string())?;
    f.sync_all().ok();
    #[cfg(unix)]
    if let Ok(md) = std::fs::metadata(p) {
        let _ = std::fs::set_permissions(&tmp, md.permissions());
    }
    std::fs::rename(&tmp, p).map_err(|e| { let _ = std::fs::remove_file(&tmp); e.to_string() })
}

/// Launch-time overrides (safe to ship): interpreter and working folder.
#[derive(Serialize)]
struct LaunchOverrides {
    python: Option<String>,
    cwd: Option<String>,
}

#[tauri::command]
fn launch_overrides() -> LaunchOverrides {
    LaunchOverrides { python: std::env::var("PIDE_PYTHON").ok(), cwd: std::env::var("PIDE_CWD").ok() }
}

/// Dev-only hooks for scripted UI checks. Always return None in release builds.
#[tauri::command]
fn dev_autorun() -> Option<String> {
    if cfg!(debug_assertions) { std::env::var("PIDE_AUTORUN").ok() } else { None }
}

#[tauri::command]
fn dev_script() -> Option<String> {
    if cfg!(debug_assertions) { std::env::var("PIDE_DEV_SCRIPT").ok() } else { None }
}

#[tauri::command(async)]
fn write_binary_file(path: String, b64: String) -> Result<(), String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD.decode(b64).map_err(|e| e.to_string())?;
    write_atomic(&path, &bytes)
}

/// The user's home directory (HOME on Unix, USERPROFILE on Windows).
fn home() -> PathBuf {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(if cfg!(windows) { "C:/" } else { "/" }))
}

/// Paths handed to the frontend always use forward slashes (Windows accepts them too).
fn fwd(p: &std::path::Path) -> String {
    let s = p.to_string_lossy();
    if cfg!(windows) { s.replace('\\', "/") } else { s.into_owned() }
}

fn default_python() -> &'static str {
    if cfg!(windows) { "python" } else { "python3" }
}

#[tauri::command]
fn home_dir() -> String {
    fwd(&home())
}

/// Candidate interpreters: conda base + envs, pyenv, then every python on PATH.
#[tauri::command(async)]
fn detect_pythons() -> Vec<String> {
    let mut found: Vec<String> = vec![];
    let mut push = |p: PathBuf| {
        if p.exists() {
            let s = fwd(&p);
            if !found.contains(&s) {
                found.push(s);
            }
        }
    };
    let home = home();
    // conda-style env layout: <env>/bin/python on Unix, <env>/python.exe on Windows.
    let env_python = |env: &std::path::Path| if cfg!(windows) { env.join("python.exe") } else { env.join("bin/python") };
    let mut roots: Vec<PathBuf> = ["miniconda3", "anaconda3", "miniforge3", "mambaforge", ".pyenv/versions"].iter().map(|r| home.join(r)).collect();
    if cfg!(windows) {
        for base in [std::env::var_os("LOCALAPPDATA"), std::env::var_os("PROGRAMDATA")].into_iter().flatten() {
            for r in ["miniconda3", "anaconda3", "miniforge3", "Miniconda3", "Anaconda3"] {
                roots.push(PathBuf::from(&base).join(r));
            }
        }
    }
    for base in roots {
        let is_pyenv = base.ends_with("versions");
        if !is_pyenv {
            push(env_python(&base));
        }
        let envs = if is_pyenv { base.clone() } else { base.join("envs") };
        if let Ok(rd) = std::fs::read_dir(&envs) {
            for e in rd.flatten() {
                push(env_python(&e.path()));
            }
        }
    }
    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            if cfg!(windows) {
                // Skip the Microsoft Store alias stubs, which only open the Store.
                if dir.to_string_lossy().contains("WindowsApps") { continue; }
                push(dir.join("python.exe"));
            } else {
                push(dir.join("python3"));
            }
        }
    }
    found
}

fn dirs_log_dir() -> PathBuf {
    let home = home();
    if cfg!(target_os = "macos") { home.join("Library/Logs/Pide") }
    else if cfg!(windows) { std::env::var_os("LOCALAPPDATA").map(PathBuf::from).unwrap_or(home).join("Pide/logs") }
    else { std::env::var_os("XDG_STATE_HOME").map(PathBuf::from).unwrap_or_else(|| home.join(".local/state")).join("pide/logs") }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Log to stderr (dev) and to a daily-rotated file in the OS log dir, so a
    // Dock-launched app still leaves diagnostics behind. Child-process output
    // is DEBUG; set RUST_LOG=debug to see it.
    let log_dir = dirs_log_dir();
    let _ = std::fs::create_dir_all(&log_dir);
    let file = tracing_appender::rolling::daily(&log_dir, "pide.log");
    let (file_writer, guard) = tracing_appender::non_blocking(file);
    std::mem::forget(guard); // keep the writer alive for the process lifetime
    use tracing_subscriber::layer::SubscriberExt;
    use tracing_subscriber::util::SubscriberInitExt;
    let filter = tracing_subscriber::EnvFilter::from_default_env().add_directive("info".parse().unwrap());
    tracing_subscriber::registry()
        .with(filter)
        .with(tracing_subscriber::fmt::layer().with_writer(std::io::stderr))
        .with(tracing_subscriber::fmt::layer().with_ansi(false).with_writer(file_writer))
        .init();
    tracing::info!("log directory: {}", log_dir.display());
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .manage(lsp::LspState::default())
        .manage(term::TermState::default())
        .invoke_handler(tauri::generate_handler![
            start_kernel,
            execute,
            refresh_workspace,
            variable_detail,
            plot_data,
            variable_image,
            plot_expr,
            complete,
            debug_request,
            kernel_eval,
            inspect,
            is_complete,
            input_reply,
            interrupt_kernel,
            shutdown_kernel,
            list_dir,
            read_text_file,
            write_text_file,
            write_binary_file,
            home_dir,
            launch_overrides,
            dev_autorun,
            dev_script,
            detect_pythons,
            lsp::detect_lsp,
            lsp::lsp_start,
            lsp::lsp_send,
            lsp::lsp_stop,
            lsp::lsp_check,
            lsp::run_tool,
            term::pty_spawn,
            term::pty_write,
            term::pty_resize,
            term::pty_kill,
            term::pty_reap,
            git::git_status,
            git::git_log,
            git::git_diff,
            git::git_commit_diff,
            git::git_commit_file,
            git::git_stage,
            git::git_unstage,
            git::git_discard,
            git::git_commit,
            git::git_branches,
            git::git_checkout,
            git::git_create_branch,
            git::git_init,
            git::git_fetch,
            git::git_pull,
            git::git_push,
            git::git_remotes,
            git::git_add_remote,
            git::git_conflict,
            git::git_resolve,
            git::git_merge,
            git::git_abort,
            git::git_continue,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(st) = app.try_state::<term::TermState>() {
                    term::shutdown_all(&st);
                }
                // Kernel (and its SSH sessions / tunnels) and language servers must not outlive the app.
                if let Some(st) = app.try_state::<AppState>() {
                    let k = tauri::async_runtime::block_on(async { st.kernel.lock().await.take() });
                    if let Some(k) = k {
                        let _ = tauri::async_runtime::block_on(tokio::time::timeout(std::time::Duration::from_secs(4), k.shutdown(false)));
                    }
                }
                if let Some(st) = app.try_state::<lsp::LspState>() {
                    tauri::async_runtime::block_on(lsp::shutdown_all(&st));
                }
            }
        });
}
