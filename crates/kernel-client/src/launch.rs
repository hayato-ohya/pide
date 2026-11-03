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

/// Temporary connection file; removed on drop.
pub struct ConnFile(PathBuf);

impl ConnFile {
    pub fn write(info: &ConnectionInfo) -> Result<Self> {
        let dir = std::env::var_os("XDG_RUNTIME_DIR").map(PathBuf::from).unwrap_or_else(std::env::temp_dir).join("pide-kernels");
        std::fs::create_dir_all(&dir)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
        }
        // Sweep files left behind by crashed sessions (older than a day).
        if let Ok(rd) = std::fs::read_dir(&dir) {
            for e in rd.flatten() {
                if let Ok(md) = e.metadata() {
                    if md.modified().ok().and_then(|t| t.elapsed().ok()).map(|d| d.as_secs() > 86_400).unwrap_or(false) {
                        let _ = std::fs::remove_file(e.path());
                    }
                }
            }
        }
        let path = dir.join(format!("kernel-{}.json", uuid::Uuid::new_v4()));
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
