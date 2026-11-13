use std::net::TcpListener;
use std::path::{Path, PathBuf};

use anyhow::Result;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionInfo {
    pub transport: String,
    pub ip: String,
    pub shell_port: u16,
    pub iopub_port: u16,
    pub stdin_port: u16,
    pub control_port: u16,
    pub hb_port: u16,
    pub key: String,
    pub signature_scheme: String,
    #[serde(default)]
    pub kernel_name: String,
}

impl ConnectionInfo {
    /// Pick five free localhost ports and a random HMAC key.
    pub fn new_local() -> Result<Self> {
        // Hold the listeners until all ports are chosen so they are distinct.
        let listeners: Vec<TcpListener> = (0..5)
            .map(|_| TcpListener::bind("127.0.0.1:0"))
            .collect::<std::io::Result<_>>()?;
        let ports: Vec<u16> = listeners.iter().map(|l| l.local_addr().unwrap().port()).collect();
        drop(listeners);
        Ok(ConnectionInfo {
            transport: "tcp".into(),
            ip: "127.0.0.1".into(),
            shell_port: ports[0],
            iopub_port: ports[1],
            stdin_port: ports[2],
            control_port: ports[3],
            hb_port: ports[4],
            key: uuid::Uuid::new_v4().simple().to_string(),
            signature_scheme: "hmac-sha256".into(),
            kernel_name: "python3".into(),
        })
    }
}

/// How to start the kernel process.
#[derive(Debug, Clone, Default)]
pub struct LaunchSpec {
    /// Python interpreter to run `-m ipykernel_launcher` with.
    pub python: PathBuf,
    pub cwd: Option<PathBuf>,
    pub env: Vec<(String, String)>,
}

/// The pid in `kernel-<pid>-<uuid>.json` (None for other / older names).
fn owner_pid(name: &str) -> Option<u32> {
    name.strip_prefix("kernel-")?.split('-').next()?.parse().ok()
}

/// Temporary connection file; removed on drop.
pub struct ConnFile(PathBuf);

impl ConnFile {
    pub fn write(info: &ConnectionInfo) -> Result<Self> {
        let dir = std::env::var_os("XDG_RUNTIME_DIR").map(PathBuf::from).unwrap_or_else(std::env::temp_dir).join("pide-kernels");
        std::fs::create_dir_all(&dir)?;
        #[cfg(unix)]
        {
            // Without XDG_RUNTIME_DIR this is the shared /tmp: refuse a directory (or symlink)
            // planted by another user, which could read the HMAC key or swap the file.
            use std::os::unix::fs::{MetadataExt, PermissionsExt};
            extern "C" {
                fn geteuid() -> u32;
            }
            let md = std::fs::symlink_metadata(&dir)?;
            let uid = unsafe { geteuid() };
            if !md.file_type().is_dir() || md.uid() != uid {
                anyhow::bail!("{} is not a directory owned by the current user", dir.display());
            }
            std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))?;
        }
        // Sweep files left behind by crashed sessions (older than a day), but not the file of
        // a kernel another running Pide started more than a day ago: names carry the owner's pid.
        if let Ok(rd) = std::fs::read_dir(&dir) {
            for e in rd.flatten() {
                if let Ok(md) = e.metadata() {
                    let old = md.modified().ok().and_then(|t| t.elapsed().ok()).map(|d| d.as_secs() > 86_400).unwrap_or(false);
                    if old && owner_pid(&e.file_name().to_string_lossy()).and_then(crate::platform::process_alive) != Some(true) {
                        let _ = std::fs::remove_file(e.path());
                    }
                }
            }
        }
        let path = dir.join(format!("kernel-{}-{}.json", std::process::id(), uuid::Uuid::new_v4()));
        let mut opts = std::fs::OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        use std::io::Write;
        opts.open(&path)?.write_all(&serde_json::to_vec_pretty(info)?)?;
        Ok(ConnFile(path))
    }
    pub fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for ConnFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// How to start a kernel on another machine over SSH.
#[derive(Debug, Clone, Default, serde::Deserialize)]
pub struct RemoteSpec {
    /// `user@host` as accepted by ssh.
    pub host: String,
    pub port: Option<u16>,
    /// Interpreter on the remote (must have ipykernel).
    pub python: String,
    pub cwd: Option<String>,
    /// Override the ssh binary (tests use a local shim).
    pub ssh: Option<String>,
    #[serde(default)]
    pub ssh_args: Vec<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn owner_pid_from_file_name() {
        assert_eq!(owner_pid("kernel-4242-0b1c2d3e-aaaa-bbbb-cccc-000000000000.json"), Some(4242));
        // Files written before the pid was added start with the uuid: swept by age alone.
        assert_eq!(owner_pid("kernel-0b1c2d3e-aaaa-bbbb-cccc-000000000000.json"), None);
        assert_eq!(owner_pid("other.json"), None);
        assert!(crate::platform::process_alive(std::process::id()).unwrap_or(true));
    }
}
