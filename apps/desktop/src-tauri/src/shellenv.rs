//! Launched from Finder/Dock (or a desktop launcher) the app inherits only the
//! session manager's minimal PATH, so Homebrew / conda / npm tools (python,
//! git, pyright, ruff, ...) are not found.  Once at startup, ask the user's
//! login shell for its PATH and merge it into ours, like VS Code does.

use std::io::Read;
use std::time::Duration;

const MARKER: &str = "__PIDE_PATH_7f3a__";
const TIMEOUT: Duration = Duration::from_secs(3);

/// Merge the login shell's PATH into the process environment and default the
/// locale.  Never panics; bounded by `TIMEOUT`.  Call before other threads use
/// the environment.  Returns a line for the log (logging is not set up yet).
pub fn init() -> Option<String> {
    if cfg!(unix) {
        // Shells, readline and Python's stdio otherwise fall back to ASCII.
        if ["LANG", "LC_ALL", "LC_CTYPE"].iter().all(|k| std::env::var_os(k).is_none_or(|v| v.is_empty())) {
            std::env::set_var("LANG", "en_US.UTF-8");
        }
        // Launched from a terminal (or with a customised PATH): keep it as is, so an
        // activated conda env or venv wins. Only the bare launchd/systemd PATH that
        // Finder/Dock launches get is replaced with the login shell's.
        let current = std::env::var("PATH").unwrap_or_default();
        if !is_minimal_path(&current) {
            return None;
        }
        match login_shell_path() {
            Some(shell_path) => {
                let merged = merge_path(&shell_path, &current);
                if merged != current {
                    std::env::set_var("PATH", &merged);
                }
                return Some(format!("PATH from login shell: {merged}"));
            }
            None => return Some(format!("could not read PATH from the login shell; using {current:?}", current = std::env::var("PATH").unwrap_or_default())),
        }
    }
    None
}

/// Run `$SHELL` as an interactive login shell and print PATH between markers,
/// so whatever rc files echo is ignored.
fn login_shell_path() -> Option<String> {
    let shell = std::env::var("SHELL").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| {
        if cfg!(target_os = "macos") { "/bin/zsh".into() } else { "/bin/sh".into() }
    });
    let name = std::path::Path::new(&shell).file_name()?.to_string_lossy().into_owned();
    // printf/printenv as external commands so the same line works in sh, fish and csh.
    let script = format!("printf {MARKER}; printenv PATH; printf {MARKER}");
    let mut cmd = std::process::Command::new(&shell);
    if name.contains("csh") {
        // csh/tcsh accept -l only as the sole flag; -c alone still reads ~/.cshrc.
        cmd.args(["-c", &script]);
    } else {
        cmd.args(["-l", "-i", "-c", &script]);
    }
    #[cfg(unix)]
    {
        // A session of its own: an interactive shell must not grab the terminal of
        // `tauri dev` (job control / tcsetpgrp) or open /dev/tty for prompts.
        use std::os::unix::process::CommandExt;
        extern "C" {
            fn setsid() -> i32;
        }
        // SAFETY: setsid is async-signal-safe and touches no Rust state.
        unsafe {
            cmd.pre_exec(|| {
                setsid();
                Ok(())
            });
        }
    }
    let mut child = cmd
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .ok()?;
    let mut out = child.stdout.take()?;
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut s = String::new();
        let _ = out.read_to_string(&mut s);
        let _ = tx.send(s);
    });
    let got = rx.recv_timeout(TIMEOUT).ok();
    // Exited already in the normal case; on timeout this stops a hung rc file.
    let _ = child.kill();
    let _ = child.wait();
    extract_marked(&got?).map(str::to_owned)
}

/// The text between the first two markers, trimmed; None if absent or empty.
fn extract_marked(out: &str) -> Option<&str> {
    let start = out.find(MARKER)? + MARKER.len();
    let len = out[start..].find(MARKER)?;
    Some(out[start..start + len].trim()).filter(|s| !s.is_empty())
}

/// Login-shell entries first (the user's configured order, e.g. Homebrew
/// before /usr/bin), then current entries it lacks; duplicates and empty
/// entries dropped.
/// True when PATH holds nothing beyond the system directories a GUI launch inherits.
fn is_minimal_path(path: &str) -> bool {
    const SYSTEM: [&str; 8] = ["/usr/bin", "/bin", "/usr/sbin", "/sbin", "/usr/local/bin", "/usr/local/sbin", "/usr/games", "/snap/bin"];
    path.split(':').filter(|p| !p.is_empty()).all(|p| SYSTEM.contains(&p))
}

fn merge_path(shell: &str, current: &str) -> String {
    let mut out: Vec<&str> = vec![];
    for p in shell.split(':').chain(current.split(':')) {
        if !p.is_empty() && !out.contains(&p) {
            out.push(p);
        }
    }
    out.join(":")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_ignores_rc_noise() {
        let out = format!("welcome!\n{MARKER}/opt/homebrew/bin:/usr/bin\n{MARKER}bye\n");
        assert_eq!(extract_marked(&out), Some("/opt/homebrew/bin:/usr/bin"));
        assert_eq!(extract_marked("no markers"), None);
        assert_eq!(extract_marked(&format!("{MARKER}only one")), None);
        assert_eq!(extract_marked(&format!("{MARKER}\n{MARKER}")), None);
    }

    #[test]
    fn merge_keeps_order_and_existing_entries() {
        assert_eq!(
            merge_path("/opt/homebrew/bin:/usr/bin:/bin:/opt/homebrew/bin", "/usr/bin:/bin:/usr/sbin:/sbin"),
            "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
        );
        assert_eq!(merge_path("", "/usr/bin:/bin"), "/usr/bin:/bin");
        assert_eq!(merge_path("/a::/b", ""), "/a:/b");
    }

    #[test]
    fn minimal_path_detection() {
        assert!(is_minimal_path("/usr/bin:/bin:/usr/sbin:/sbin"));
        assert!(is_minimal_path(""));
        assert!(!is_minimal_path("/Users/me/miniconda3/envs/x/bin:/usr/bin:/bin"));
        assert!(!is_minimal_path("/opt/homebrew/bin:/usr/bin"));
    }

    /// Depends on the user's shell setup: `cargo test -p pide-desktop -- --ignored login_shell`.
    #[test]
    #[ignore]
    fn login_shell_reports_path() {
        let p = login_shell_path().expect("login shell PATH");
        eprintln!("{p}");
        assert!(p.contains("/usr/bin"));
    }
}
