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
    // Stop an existing kernel first.
    if let Some(old) = state.kernel.lock().await.take() {
        let _ = old.shutdown(false).await;
    }
    let python = python
        .or(state.python.lock().await.clone())
        .unwrap_or_else(|| "python3".to_string());
    let cwd = cwd.or(state.cwd.lock().await.clone());
    emit_status(&app, "starting", Some(python.clone()), cwd.clone(), None);

    let helper = helper_dir(&app);
    let mut pythonpath = helper.to_string_lossy().to_string();
    if let Ok(existing) = std::env::var("PYTHONPATH") {
        pythonpath = format!("{pythonpath}:{existing}");
    }
    let spec = LaunchSpec {
        python: PathBuf::from(&python),
        cwd: cwd.clone().map(PathBuf::from),
        env: vec![
            ("PYTHONPATH".into(), pythonpath),
            ("MPLBACKEND".into(), "module://matplotlib_inline.backend_inline".into()),
            // ipykernel's parent poller exits the kernel when Pide dies (also on crash).
            ("JPY_PARENT_PID".into(), std::process::id().to_string()),
            // Python >= 3.11: do not put the cwd first on sys.path (untrusted folders).
            ("PYTHONSAFEPATH".into(), "1".into()),
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

    // Forward every message to the webview.
    let mut rx = k.subscribe();
    let app2 = app.clone();
    tokio::spawn(async move {
        loop {
            match rx.recv().await {
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
                    let _ = app2.emit("kernel-event", payload);
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                    tracing::warn!("UI lagged {n} kernel events");
                }
                Err(_) => break,
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
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            if !k2.is_alive().await {
                emit_status(&app3, "dead", Some(py.clone()), cwd2.clone(), Some("kernel process exited".into()));
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
        "__import__('pide_kernel').detail({:?}, {}, {}, {}, {}, {})",
        path, win.row0, win.row1.max(win.row0 + 1), win.col0, win.col1.max(win.col0 + 1), idx
    );
    user_expr(&state, "detail", expr).await
}

#[tauri::command]
async fn plot_data(state: State<'_, AppState>, path: String) -> Result<String, String> {
    user_expr(&state, "plot", format!("__import__('pide_kernel').plot_data({:?})", path)).await
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
    let f = |v: Option<f64>| v.map(|x| x.to_string()).unwrap_or_else(|| "None".into());
    let expr = format!(
        "__import__('pide_kernel').image({:?}, {}, {}, {}, {:?})",
        path, idx, f(opts.vmin), f(opts.vmax), opts.layout.unwrap_or_else(|| "auto".into())
    );
    user_expr(&state, "image", expr).await
}

#[tauri::command]
async fn plot_expr(state: State<'_, AppState>, expr: String) -> Result<String, String> {
    user_expr(&state, "plot", format!("__import__('pide_kernel').plot_expr({:?})", expr)).await
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
    if let Some(k) = state.kernel.lock().await.take() {
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

#[tauri::command]
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
            path: e.path().to_string_lossy().to_string(),
            is_dir: md.is_dir(),
            size: md.len(),
            modified: md.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_secs()),
        });
    }
    out.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then(a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(out)
}

#[tauri::command]
fn read_text_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn write_text_file(path: String, content: String) -> Result<(), String> {
    std::fs::write(&path, content).map_err(|e| e.to_string())
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

#[tauri::command]
fn write_binary_file(path: String, b64: String) -> Result<(), String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD.decode(b64).map_err(|e| e.to_string())?;
    std::fs::write(&path, bytes).map_err(|e| e.to_string())
}

#[tauri::command]
fn home_dir() -> String {
    std::env::var("HOME").unwrap_or_else(|_| "/".into())
}

/// Candidate interpreters: PATH python3, conda base + envs, common venvs.
#[tauri::command]
fn detect_pythons() -> Vec<String> {
    let mut found: Vec<String> = vec![];
    let home = PathBuf::from(std::env::var("HOME").unwrap_or_default());
    for root in ["miniconda3", "anaconda3", "miniforge3", "mambaforge", ".pyenv/versions"] {
        let base = home.join(root);
        if base.join("bin/python").exists() {
            found.push(base.join("bin/python").to_string_lossy().into());
        }
        let envs = if root == ".pyenv/versions" { base.clone() } else { base.join("envs") };
        if let Ok(rd) = std::fs::read_dir(&envs) {
            for e in rd.flatten() {
                let p = e.path().join("bin/python");
                if p.exists() {
                    found.push(p.to_string_lossy().into());
                }
            }
        }
    }
    if let Ok(path) = std::env::var("PATH") {
        for dir in path.split(':') {
            let p = PathBuf::from(dir).join("python3");
            if p.exists() {
                let s = p.to_string_lossy().to_string();
                if !found.contains(&s) {
                    found.push(s);
                }
            }
        }
    }
    found
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env().add_directive("info".parse().unwrap()))
        .init();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
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
