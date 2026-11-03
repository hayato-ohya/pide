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

#[derive(Default)]
pub struct LspState {
    servers: Mutex<HashMap<String, Server>>,
}

struct Server {
    child: Child,
    tx: mpsc::Sender<Value>,
}

#[derive(Serialize, Clone)]
struct LspMessage {
    server: String,
    msg: Value,
}

#[derive(Serialize, Clone)]
struct LspExit {
    server: String,
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

fn find_near(python: &str, names: &[&str]) -> Option<String> {
    let bin = PathBuf::from(python).parent().map(|p| p.to_path_buf());
    for n in names {
        if let Some(b) = &bin {
            let p = b.join(n);
            if p.exists() {
                return Some(p.to_string_lossy().into());
            }
        }
    }
    if let Ok(path) = std::env::var("PATH") {
        for dir in path.split(':') {
            for n in names {
                let p = PathBuf::from(dir).join(n);
                if p.exists() {
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
) -> Result<(), String> {
    lsp_stop_inner(&state, &name).await;
    let mut c = Command::new(&cmd);
    c.args(&args).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
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
    tokio::spawn(async move {
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
    tokio::spawn(async move {
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
                    let _ = app2.emit("lsp-message", LspMessage { server: n2.clone(), msg });
                }
                Err(e) => tracing::warn!("lsp {n2}: bad json: {e}"),
            }
        }
    });

    // Stderr → log.
    let n3 = name.clone();
    tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(l)) = lines.next_line().await {
            tracing::info!(target: "lsp", "[{n3}] {l}");
        }
    });

    state.servers.lock().await.insert(name, Server { child, tx });
    Ok(())
}

#[tauri::command]
pub async fn lsp_send(state: tauri::State<'_, LspState>, name: String, msg: Value) -> Result<(), String> {
    let servers = state.servers.lock().await;
    let s = servers.get(&name).ok_or_else(|| format!("lsp {name} not running"))?;
    s.tx.send(msg).await.map_err(|e| e.to_string())
}

async fn lsp_stop_inner(state: &tauri::State<'_, LspState>, name: &str) {
    if let Some(mut s) = state.servers.lock().await.remove(name) {
        let _ = s.child.start_kill();
        let _ = s.child.wait().await;
    }
}

#[tauri::command]
pub async fn lsp_stop(state: tauri::State<'_, LspState>, name: String) -> Result<(), String> {
    lsp_stop_inner(&state, &name).await;
    Ok(())
}

/// Poll: report servers that exited so the UI can show it and restart.
#[tauri::command]
pub async fn lsp_check(app: AppHandle, state: tauri::State<'_, LspState>) -> Result<Vec<String>, String> {
    let mut servers = state.servers.lock().await;
    let mut dead = vec![];
    for (name, s) in servers.iter_mut() {
        if let Ok(Some(st)) = s.child.try_wait() {
            dead.push(name.clone());
            let _ = app.emit("lsp-exit", LspExit { server: name.clone(), code: st.code(), detail: format!("{st}") });
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
    if let Some(d) = cwd.filter(|d| std::path::Path::new(d).is_dir()) {
        c.current_dir(d);
    }
    let mut child = c.spawn().map_err(|e| format!("{tool}: {e}"))?;
    if let Some(mut si) = child.stdin.take() {
        let _ = si.write_all(stdin.as_bytes()).await;
        drop(si);
    }
    let out = tokio::time::timeout(std::time::Duration::from_secs(60), child.wait_with_output())
        .await
        .map_err(|_| format!("{tool} timed out"))?
        .map_err(|e| e.to_string())?;
    Ok(ToolResult { found: true, code: out.status.code(), stdout: String::from_utf8_lossy(&out.stdout).into(), stderr: String::from_utf8_lossy(&out.stderr).into() })
}
