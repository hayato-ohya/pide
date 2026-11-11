//! Generic language-server host: spawns a server on stdio, frames JSON-RPC
//! with Content-Length headers, and relays messages both ways.  The
//! frontend owns the protocol; this module only moves bytes.

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, Mutex};
use tokio::task::JoinHandle;

#[derive(Default)]
pub struct LspState {
    servers: Mutex<HashMap<String, Server>>,
    /// Bumped per `lsp_start`; tags events so the UI can drop ones from an
    /// earlier session of the same server name.
    gen: std::sync::atomic::AtomicU64,
}

struct Server {
    child: Child,
    tx: mpsc::Sender<Value>,
    gen: u64,
    tasks: Vec<JoinHandle<()>>,
}

impl Server {
    /// Kill the process and make sure its relay tasks can no longer emit.
    async fn shutdown(mut self) {
        for t in &self.tasks {
            t.abort();
        }
        for t in self.tasks.drain(..) {
            let _ = t.await;
        }
        let _ = self.child.start_kill();
        let _ = self.child.wait().await;
    }
}

#[derive(Serialize, Clone)]
struct LspMessage {
    server: String,
    gen: u64,
    msg: Value,
}

#[derive(Serialize, Clone)]
struct LspExit {
    server: String,
    gen: u64,
    code: Option<i32>,
    detail: String,
}

/// Which servers are reachable for a given interpreter: looks next to the
/// interpreter first (pip-installed into that env), then on PATH.
#[derive(Serialize)]
pub struct LspDetect {
    pub pyright: Option<String>,
    pub ruff: Option<String>,
}

/// Executable file names a tool may have on this platform.
fn candidates(name: &str) -> Vec<String> {
    if cfg!(windows) {
        // pip console scripts are .exe; npm shims are .cmd; plain names last.
        vec![format!("{name}.exe"), format!("{name}.cmd"), format!("{name}.bat"), name.to_string()]
    } else {
        vec![name.to_string()]
    }
}

fn find_near(python: &str, names: &[&str]) -> Option<String> {
    let py = PathBuf::from(python);
    let mut dirs: Vec<PathBuf> = vec![];
    if let Some(b) = py.parent() {
        dirs.push(b.to_path_buf());
        if cfg!(windows) {
            // <env>/python.exe keeps its console scripts in <env>/Scripts.
            dirs.push(b.join("Scripts"));
        }
    }
    if let Some(path) = std::env::var_os("PATH") {
        dirs.extend(std::env::split_paths(&path));
    }
    for d in dirs {
        for n in names {
            for c in candidates(n) {
                let p = d.join(&c);
                if p.is_file() {
                    return Some(p.to_string_lossy().into());
                }
            }
        }
    }
    None
}

#[tauri::command]
pub fn detect_lsp(python: String) -> LspDetect {
    LspDetect {
        pyright: find_near(&python, &["basedpyright-langserver", "pyright-langserver"]),
        ruff: find_near(&python, &["ruff"]),
    }
}

#[tauri::command]
pub async fn lsp_start(
    app: AppHandle,
    state: tauri::State<'_, LspState>,
    name: String,
    cmd: String,
    args: Vec<String>,
    cwd: Option<String>,
) -> Result<u64, String> {
    lsp_stop_inner(&state, &name).await;
    let gen = state.gen.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
    let mut c = Command::new(&cmd);
    c.args(&args).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    kernel_client::platform::quiet(&mut c);
    if let Some(d) = &cwd {
        c.current_dir(d);
    }
    let mut child = c.spawn().map_err(|e| format!("spawn {cmd}: {e}"))?;
    let mut stdin = child.stdin.take().unwrap();
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();

    // Writer task.
    let (tx, mut rx) = mpsc::channel::<Value>(256);
    let n1 = name.clone();
    let writer = tokio::spawn(async move {
        while let Some(v) = rx.recv().await {
            let body = serde_json::to_vec(&v).unwrap();
            let head = format!("Content-Length: {}\r\n\r\n", body.len());
            if stdin.write_all(head.as_bytes()).await.is_err() || stdin.write_all(&body).await.is_err() {
                tracing::warn!("lsp {n1}: stdin closed");
                break;
            }
            let _ = stdin.flush().await;
        }
    });

    // Reader task: parse Content-Length frames and emit each message.
    let app2 = app.clone();
    let n2 = name.clone();
    let reader = tokio::spawn(async move {
        let mut rd = BufReader::new(stdout);
        loop {
            let mut len: Option<usize> = None;
            loop {
                let mut line = String::new();
                match rd.read_line(&mut line).await {
                    Ok(0) => return,
                    Ok(_) => {}
                    Err(_) => return,
                }
                let t = line.trim_end();
                if t.is_empty() {
                    break;
                }
                if let Some(v) = t.strip_prefix("Content-Length:") {
                    len = v.trim().parse().ok();
                }
            }
            let Some(len) = len else { continue };
            let mut buf = vec![0u8; len];
            if rd.read_exact(&mut buf).await.is_err() {
                return;
            }
            match serde_json::from_slice::<Value>(&buf) {
                Ok(msg) => {
                    let _ = app2.emit("lsp-message", LspMessage { server: n2.clone(), gen, msg });
                }
                Err(e) => tracing::warn!("lsp {n2}: bad json: {e}"),
            }
        }
    });

    // Stderr → log.
    let n3 = name.clone();
    let errlog = tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(l)) = lines.next_line().await {
            tracing::debug!(target: "lsp", "[{n3}] {l}");
        }
    });

    let tasks = vec![writer, reader, errlog];
    let old = state.servers.lock().await.insert(name, Server { child, tx, gen, tasks });
    if let Some(old) = old {
        old.shutdown().await; // a concurrent lsp_start for the same name won the race
    }
    Ok(gen)
}

#[tauri::command]
pub async fn lsp_send(state: tauri::State<'_, LspState>, name: String, msg: Value) -> Result<(), String> {
    // Clone the sender and release the lock before a possibly long wait for
    // channel space (a busy server not reading stdin must not block every
    // other LSP command, including stopping/restarting it).
    let tx = {
        let servers = state.servers.lock().await;
        servers.get(&name).ok_or_else(|| format!("lsp {name} not running"))?.tx.clone()
    };
    tx.send(msg).await.map_err(|e| e.to_string())
}

async fn lsp_stop_inner(state: &tauri::State<'_, LspState>, name: &str) {
    let s = state.servers.lock().await.remove(name);
    if let Some(s) = s {
        s.shutdown().await;
    }
}

#[tauri::command]
pub async fn lsp_stop(state: tauri::State<'_, LspState>, name: String) -> Result<(), String> {
    lsp_stop_inner(&state, &name).await;
    Ok(())
}

pub async fn shutdown_all(state: &LspState) {
    let all: Vec<Server> = state.servers.lock().await.drain().map(|(_, s)| s).collect();
    for s in all {
        s.shutdown().await;
    }
}

/// Poll: report servers that exited so the UI can show it and restart.
#[tauri::command]
pub async fn lsp_check(app: AppHandle, state: tauri::State<'_, LspState>) -> Result<Vec<String>, String> {
    let mut servers = state.servers.lock().await;
    let mut dead = vec![];
    for (name, s) in servers.iter_mut() {
        if let Ok(Some(st)) = s.child.try_wait() {
            dead.push(name.clone());
            let _ = app.emit("lsp-exit", LspExit { server: name.clone(), gen: s.gen, code: st.code(), detail: format!("{st}") });
        }
    }
    for d in &dead {
        servers.remove(d);
    }
    Ok(dead)
}


/// Run a CLI tool (flake8, black, ...) found next to the interpreter or on
/// PATH, feeding `stdin`; used for linters/formatters that do not speak LSP.
#[derive(Serialize)]
pub struct ToolResult {
    pub found: bool,
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

#[tauri::command]
pub async fn run_tool(python: String, tool: String, args: Vec<String>, stdin: String, cwd: Option<String>) -> Result<ToolResult, String> {
    use tokio::io::AsyncWriteExt;
    let Some(bin) = find_near(&python, &[tool.as_str()]) else {
        return Ok(ToolResult { found: false, code: None, stdout: String::new(), stderr: format!("{tool} not found for {python}") });
    };
    let mut c = Command::new(&bin);
    c.args(&args).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    kernel_client::platform::quiet(&mut c);
    if let Some(d) = cwd.filter(|d| std::path::Path::new(d).is_dir()) {
        c.current_dir(d);
    }
    let mut child = c.spawn().map_err(|e| format!("{tool}: {e}"))?;
    // Feed stdin concurrently with draining stdout/stderr: writing it all
    // first deadlocks once both pipes fill.  On timeout the dropped future
    // drops the child, which kill_on_drop kills (the writer then fails too).
    if let Some(mut si) = child.stdin.take() {
        tokio::spawn(async move {
            let _ = si.write_all(stdin.as_bytes()).await;
        });
    }
    let out = tokio::time::timeout(std::time::Duration::from_secs(60), child.wait_with_output())
        .await
        .map_err(|_| format!("{tool} timed out"))?
        .map_err(|e| e.to_string())?;
    Ok(ToolResult { found: true, code: out.status.code(), stdout: String::from_utf8_lossy(&out.stdout).into(), stderr: String::from_utf8_lossy(&out.stderr).into() })
}
