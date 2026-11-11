//! Integrated terminal: one PTY per tab, output streamed to the webview as
//! `pty-data` events, input written back through `pty_write`.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{mpsc, Mutex};
use std::time::Duration;

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

#[derive(Default)]
pub struct TermState {
    terms: Mutex<HashMap<u32, Term>>,
    next: Mutex<u32>,
}

/// The map lock is only ever held for O(1) work: input goes to a per-terminal
/// writer thread through `input` (a write to a PTY whose child is not reading
/// can block indefinitely), and the child is owned by a waiter thread, so
/// nothing here waits on the process.
struct Term {
    master: Box<dyn MasterPty + Send>,
    input: mpsc::Sender<Vec<u8>>,
    killer: Box<dyn ChildKiller + Send + Sync>,
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
    // Launched from Finder/Dock there is no locale in the environment, and
    // shells/readline then mangle UTF-8 (e.g. Japanese) input and output.
    if !cfg!(windows) && ["LANG", "LC_ALL", "LC_CTYPE"].iter().all(|k| cmd.get_env(k).is_none_or(|v| v.is_empty())) {
        cmd.env("LANG", "en_US.UTF-8");
    }
    if let Some(e) = env {
        for (k, v) in e {
            cmd.env(k, v);
        }
    }
    let mut child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let mut writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let killer = child.clone_killer();
    let (input, input_rx) = mpsc::channel::<Vec<u8>>();

    let id = {
        let mut n = state.next.lock().unwrap();
        *n += 1;
        *n
    };
    // Insert before starting the waiter so its removal cannot race the insert.
    state.terms.lock().unwrap().insert(id, Term { master: pair.master, input, killer });

    // Writer thread: may block on a full PTY buffer without holding any lock.
    // Ends when the Term (the only Sender) is dropped or the PTY goes away.
    std::thread::spawn(move || {
        for buf in input_rx {
            if writer.write_all(&buf).and_then(|_| writer.flush()).is_err() {
                break;
            }
        }
    });

    // Reader thread → events.
    let (eof_tx, eof_rx) = mpsc::channel::<()>();
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
        let _ = eof_tx.send(());
    });

    // Waiter thread: the only place that reaps the child (no zombies) and
    // reports the exit.  Reader EOF alone is not enough: with ConPTY it only
    // comes once the master is closed, and on Unix a background job can keep
    // the slave open.
    std::thread::spawn(move || {
        let code = child.wait().ok().map(|st| st.exit_code());
        // Give the reader a moment to forward the last output, then drop the
        // master and the writer's Sender so the reader/writer threads end.
        let _ = eof_rx.recv_timeout(Duration::from_millis(500));
        let t = app.state::<TermState>().terms.lock().unwrap().remove(&id);
        drop(t);
        let _ = app.emit("pty-exit", PtyExit { id, code });
    });
    Ok(id)
}

#[tauri::command(async)]
pub fn pty_write(state: tauri::State<'_, TermState>, id: u32, data: String) -> Result<(), String> {
    let terms = state.terms.lock().unwrap();
    let t = terms.get(&id).ok_or("no such terminal")?;
    t.input.send(data.into_bytes()).map_err(|_| "terminal closed".to_string())
}

#[tauri::command]
pub fn pty_resize(state: tauri::State<'_, TermState>, id: u32, cols: u16, rows: u16) -> Result<(), String> {
    let terms = state.terms.lock().unwrap();
    let t = terms.get(&id).ok_or("no such terminal")?;
    t.master.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 }).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_kill(state: tauri::State<'_, TermState>, id: u32) -> Result<(), String> {
    let t = state.terms.lock().unwrap().remove(&id);
    if let Some(mut t) = t {
        // Off the main thread: closing a ConPTY master can block.  The waiter
        // thread reaps the child.
        std::thread::spawn(move || {
            let _ = t.killer.kill();
            drop(t);
        });
    }
    Ok(())
}

/// Kept for older frontends: exited children are now reaped and removed by
/// their waiter thread, so there is nothing left to collect here.
#[tauri::command]
pub fn pty_reap() -> Result<Vec<u32>, String> {
    Ok(vec![])
}

pub fn shutdown_all(state: &TermState) {
    let all: Vec<Term> = state.terms.lock().unwrap().drain().map(|(_, t)| t).collect();
    for mut t in all {
        let _ = t.killer.kill();
    }
}
