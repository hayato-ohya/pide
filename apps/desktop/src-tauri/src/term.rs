//! Integrated terminal: one PTY per tab, output streamed to the webview as
//! `pty-data` events, input written back through `pty_write`.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

#[derive(Default)]
pub struct TermState {
    terms: Mutex<HashMap<u32, Term>>,
    next: Mutex<u32>,
}

struct Term {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
}

#[derive(Serialize, Clone)]
struct PtyData {
    id: u32,
    data: String, // base64 so arbitrary bytes survive JSON
}

#[derive(Serialize, Clone)]
struct PtyExit {
    id: u32,
    code: Option<u32>,
}

fn default_shell() -> String {
    if cfg!(windows) {
        // PowerShell if present, else the command interpreter.
        if let Some(path) = std::env::var_os("PATH") {
            for d in std::env::split_paths(&path) {
                for n in ["pwsh.exe", "powershell.exe"] {
                    if d.join(n).is_file() { return n.into(); }
                }
            }
        }
        return std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".into());
    }
    std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into())
}

#[tauri::command(async)]
pub fn pty_spawn(
    app: AppHandle,
    state: tauri::State<'_, TermState>,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
    command: Option<Vec<String>>,
    env: Option<HashMap<String, String>>,
) -> Result<u32, String> {
    let pty = native_pty_system();
    let pair = pty.openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 }).map_err(|e| e.to_string())?;
    let mut cmd = match command.filter(|c| !c.is_empty()) {
        Some(parts) => {
            let mut c = CommandBuilder::new(&parts[0]);
            c.args(&parts[1..]);
            c
        }
        None => {
            let mut c = CommandBuilder::new(default_shell());
            if !cfg!(windows) {
                c.arg("-l"); // login shell so conda / pyenv init runs
            }
            c
        }
    };
    if let Some(d) = cwd.filter(|d| std::path::Path::new(d).is_dir()) {
        cmd.cwd(d);
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("PIDE", "1");
    if let Some(e) = env {
        for (k, v) in e {
            cmd.env(k, v);
        }
    }
    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    let id = {
        let mut n = state.next.lock().unwrap();
        *n += 1;
        *n
    };
    state.terms.lock().unwrap().insert(id, Term { master: pair.master, writer, child });

    // Reader thread → events.
    let app2 = app.clone();
    std::thread::spawn(move || {
        use base64::Engine;
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let data = base64::engine::general_purpose::STANDARD.encode(&buf[..n]);
                    let _ = app2.emit("pty-data", PtyData { id, data });
                }
            }
        }
        let _ = app2.emit("pty-exit", PtyExit { id, code: None });
    });
    Ok(id)
}

#[tauri::command(async)]
pub fn pty_write(state: tauri::State<'_, TermState>, id: u32, data: String) -> Result<(), String> {
    let mut terms = state.terms.lock().unwrap();
    let t = terms.get_mut(&id).ok_or("no such terminal")?;
    t.writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
    t.writer.flush().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_resize(state: tauri::State<'_, TermState>, id: u32, cols: u16, rows: u16) -> Result<(), String> {
    let terms = state.terms.lock().unwrap();
    let t = terms.get(&id).ok_or("no such terminal")?;
    t.master.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 }).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_kill(state: tauri::State<'_, TermState>, id: u32) -> Result<(), String> {
    if let Some(mut t) = state.terms.lock().unwrap().remove(&id) {
        let _ = t.child.kill();
    }
    Ok(())
}

/// Garbage-collect exited children (called by the UI on pty-exit).
#[tauri::command]
pub fn pty_reap(state: tauri::State<'_, TermState>) -> Result<Vec<u32>, String> {
    let mut terms = state.terms.lock().unwrap();
    let mut gone = vec![];
    for (id, t) in terms.iter_mut() {
        if let Ok(Some(_)) = t.child.try_wait() {
            gone.push(*id);
        }
    }
    for id in &gone {
        terms.remove(id);
    }
    Ok(gone)
}

pub fn shutdown_all(state: &TermState) {
    for (_, mut t) in state.terms.lock().unwrap().drain() {
        let _ = t.child.kill();
    }
}

#[allow(dead_code)]
pub fn _keep(_: Arc<()>) {}
