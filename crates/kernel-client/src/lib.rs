//! Minimal Jupyter kernel client: launches `ipykernel`, speaks the wire
//! protocol over ZeroMQ (pure Rust `zeromq` crate) and broadcasts every
//! message it receives.  UI independent.

pub mod message;
pub mod launch;
pub mod platform;

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Arc;

use anyhow::{Context, Result};
use bytes::Bytes;
use serde_json::{json, Value};
use tokio::process::{Child, Command};
use tokio::sync::{broadcast, mpsc, Mutex};
use tokio_util::sync::CancellationToken;
use zeromq::{DealerSendHalf, DealerSocket, ReqSocket, Socket, SocketRecv, SocketSend, SubSocket, ZmqMessage};

pub use launch::{ConnectionInfo, LaunchSpec};
pub use message::{Header, Message, Signer};

/// Which socket a message arrived on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Channel {
    Shell,
    IoPub,
    Control,
    Stdin,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct Event {
    pub channel: Channel,
    pub msg: Message,
}

pub struct Kernel {
    child: Mutex<Option<Child>>,
    /// Helper processes (SSH tunnels) that must die with the kernel.
    extra: Mutex<Vec<Child>>,
    /// True when the kernel process is not local (interrupt via control channel).
    pub remote: bool,
    /// False for kernels we merely attached to: never send them shutdown_request.
    pub owned: bool,
    pub info: ConnectionInfo,
    signer: Signer,
    session: String,
    shell_tx: mpsc::Sender<ZmqMessage>,
    control_tx: mpsc::Sender<ZmqMessage>,
    stdin_tx: mpsc::Sender<ZmqMessage>,
    events: broadcast::Sender<Event>,
    /// Cancels every task spawned for this kernel (socket pumps, heartbeat).
    cancel: CancellationToken,
    /// Set by the heartbeat task after repeated misses.
    hb_dead: std::sync::Arc<std::sync::atomic::AtomicBool>,
    _conn_file: Option<launch::ConnFile>,
    /// Interrupt / parent handles for a locally launched kernel.
    handles: platform::KernelHandles,
}

impl Drop for Kernel {
    fn drop(&mut self) {
        self.cancel.cancel();
    }
}

impl Kernel {
    /// Launch a kernel process and connect all channels.
    pub async fn launch(spec: LaunchSpec) -> Result<Arc<Kernel>> {
        let info = ConnectionInfo::new_local()?;
        let conn_file = launch::ConnFile::write(&info)?;

        let mut cmd = Command::new(&spec.python);
        cmd.args(["-m", "ipykernel_launcher", "-f"])
            .arg(conn_file.path())
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        platform::quiet(&mut cmd);
        if let Some(cwd) = &spec.cwd {
            cmd.current_dir(cwd);
        }
        // Never let a user's PYTHONPATH/cwd shadow stdlib modules the kernel imports.
        cmd.env("PYTHONSAFEPATH", "1");
        for (k, v) in &spec.env {
            cmd.env(k, v);
        }
        let handles = platform::KernelHandles::prepare(&mut cmd);
        let mut child = cmd.spawn().context("spawning ipykernel")?;
        // Forward kernel stderr/stdout to tracing so they are never lost.
        if let Some(out) = child.stdout.take() {
            tokio::spawn(pipe_log("kernel.stdout", out));
        }
        if let Some(err) = child.stderr.take() {
            tokio::spawn(pipe_log("kernel.stderr", err));
        }
        Self::connect_inner(info, Some(child), vec![], false, true, Some(conn_file), handles).await
    }

    /// Connect to an already running kernel described by a connection file
    /// (e.g. a kernel started by hand, or in a container with published ports).
    pub async fn connect(info: ConnectionInfo) -> Result<Arc<Kernel>> {
        Self::connect_inner(info, None, vec![], true, false, None, Default::default()).await
    }

    /// Start a kernel on a remote host over SSH and tunnel its ports.
    ///
    /// 1. upload the `pide_kernel` helper (single file) to `~/.pide`
    /// 2. run a bootstrap that picks free ports, prints the connection info
    ///    and execs ipykernel (that SSH session stays open for its lifetime)
    /// 3. open a second SSH session with `-L` forwards for the five ports
    pub async fn launch_remote(spec: launch::RemoteSpec, helper_src: &str) -> Result<Arc<Kernel>> {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
        if spec.host.starts_with('-') || spec.host.is_empty() {
            anyhow::bail!("invalid ssh host {:?}", spec.host);
        }
        let ssh = spec.ssh.clone().unwrap_or_else(|| "ssh".into());
        let base_args = |s: &launch::RemoteSpec| -> Vec<String> {
            let mut a = vec!["-o".into(), "BatchMode=yes".into(), "-o".into(), "ServerAliveInterval=15".into()];
            if let Some(p) = s.port { a.push("-p".into()); a.push(p.to_string()); }
            a.extend(s.ssh_args.clone());
            a
        };

        // 1. helper upload
        let mut up = Command::new(&ssh);
        up.args(base_args(&spec)).arg("--").arg(&spec.host)
            .arg("umask 077 && mkdir -p ~/.pide/pide_kernel && chmod 700 ~/.pide && cat > ~/.pide/pide_kernel/__init__.py")
            .stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::piped());
        let mut up_child = platform::quiet(&mut up).spawn().context("ssh (upload helper)")?;
        if let Some(mut stdin) = up_child.stdin.take() {
            stdin.write_all(helper_src.as_bytes()).await?;
            drop(stdin);
        }
        let st = up_child.wait_with_output().await?;
        if !st.status.success() {
            anyhow::bail!("ssh upload failed: {}", String::from_utf8_lossy(&st.stderr).trim());
        }

        // 2. remote bootstrap: free ports → connection file → exec ipykernel
        let cwd = spec.cwd.clone().unwrap_or_else(|| "~".into());
        let bootstrap = r#"import json,os,socket,sys,uuid
ls=[socket.socket() for _ in range(5)]
for s in ls: s.bind(("127.0.0.1",0))
ports=[s.getsockname()[1] for s in ls]
for s in ls: s.close()
info={"transport":"tcp","ip":"127.0.0.1","shell_port":ports[0],"iopub_port":ports[1],"stdin_port":ports[2],"control_port":ports[3],"hb_port":ports[4],"key":uuid.uuid4().hex,"signature_scheme":"hmac-sha256","kernel_name":"python3"}
d=os.path.expanduser("~/.pide/run"); os.makedirs(d,exist_ok=True)
f=os.path.join(d,"kernel-%d.json"%os.getpid()); json.dump(info,open(f,"w"))
print("PIDE_CONN:"+json.dumps(info),flush=True)
os.environ["PYTHONPATH"]=os.path.expanduser("~/.pide")+os.pathsep+os.environ.get("PYTHONPATH","")
os.environ.setdefault("MPLBACKEND","module://matplotlib_inline.backend_inline")
os.execvp(sys.executable,[sys.executable,"-m","ipykernel_launcher","-f",f])"#;
        let b64 = b64encode(bootstrap.as_bytes());
        // cwd is handed to Python (expanduser + chdir) so no shell quoting of user paths is needed.
        let cwd_b64 = b64encode(cwd.as_bytes());
        let remote_cmd = format!(
            "PIDE_CWD_B64={} {} -c \"import base64,os;os.chdir(os.path.expanduser(base64.b64decode(os.environ['PIDE_CWD_B64']).decode()));exec(base64.b64decode('{}'))\"",
            cwd_b64, shell_quote(&spec.python), b64
        );
        let mut run = Command::new(&ssh);
        run.args(base_args(&spec)).arg("--").arg(&spec.host).arg(&remote_cmd)
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
        let mut kernel_child = platform::quiet(&mut run).spawn().context("ssh (start kernel)")?;
        let stdout = kernel_child.stdout.take().unwrap();
        if let Some(err) = kernel_child.stderr.take() {
            tokio::spawn(pipe_log("remote.stderr", err));
        }
        let mut lines = tokio::io::BufReader::new(stdout).lines();
        let remote_info: ConnectionInfo = loop {
            let line = tokio::time::timeout(std::time::Duration::from_secs(60), lines.next_line()).await
                .context("timeout waiting for remote kernel to start")??
                .ok_or_else(|| anyhow::anyhow!("remote kernel exited before printing connection info"))?;
            if let Some(json) = line.strip_prefix("PIDE_CONN:") {
                break serde_json::from_str(json).context("parsing remote connection info")?;
            }
            tracing::debug!(target: "kernel", "[remote.stdout] {line}");
        };
        tokio::spawn(async move {
            while let Ok(Some(l)) = lines.next_line().await {
                tracing::debug!(target: "kernel", "[remote.stdout] {l}");
            }
        });

        // 3. tunnels: local free ports → remote kernel ports
        let local = ConnectionInfo::new_local()?;
        let pairs = [
            (local.shell_port, remote_info.shell_port),
            (local.iopub_port, remote_info.iopub_port),
            (local.stdin_port, remote_info.stdin_port),
            (local.control_port, remote_info.control_port),
            (local.hb_port, remote_info.hb_port),
        ];
        let mut tun = Command::new(&ssh);
        tun.args(base_args(&spec)).arg("-N");
        for (l, r) in pairs {
            tun.arg("-L").arg(format!("127.0.0.1:{l}:127.0.0.1:{r}"));
        }
        tun.arg("--").arg(&spec.host).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped()).kill_on_drop(true);
        let mut tun_child = platform::quiet(&mut tun).spawn().context("ssh (tunnel)")?;
        if let Some(err) = tun_child.stderr.take() {
            tokio::spawn(pipe_log("tunnel.stderr", err));
        }
        // give the tunnel a moment to bind
        tokio::time::sleep(std::time::Duration::from_millis(800)).await;

        let info = ConnectionInfo { key: remote_info.key.clone(), signature_scheme: remote_info.signature_scheme.clone(), ..local };
        Self::connect_inner(info, Some(kernel_child), vec![tun_child], true, true, None, Default::default()).await
    }

    async fn connect_inner(
        info: ConnectionInfo,
        child: Option<Child>,
        extra: Vec<Child>,
        remote: bool,
        owned: bool,
        conn_file: Option<launch::ConnFile>,
        handles: platform::KernelHandles,
    ) -> Result<Arc<Kernel>> {
        if info.signature_scheme != "hmac-sha256" && !info.key.is_empty() {
            anyhow::bail!("unsupported signature scheme {:?}", info.signature_scheme);
        }
        let signer = Signer::new(&info.key);
        let session = uuid::Uuid::new_v4().to_string();
        // Large enough that a tight print loop does not drop the execute_reply.
        let (events, _) = broadcast::channel(65_536);
        let cancel = CancellationToken::new();

        let ep = |port: u16| format!("tcp://{}:{}", info.ip, port);

        // Dealer sockets (shell / control / stdin): a send half fed by an mpsc
        // and a recv half pumped into the broadcast channel.
        let shell_tx = dealer(&ep(info.shell_port), Channel::Shell, signer.clone(), events.clone(), cancel.clone()).await?;
        let control_tx = dealer(&ep(info.control_port), Channel::Control, signer.clone(), events.clone(), cancel.clone()).await?;
        let stdin_tx = dealer(&ep(info.stdin_port), Channel::Stdin, signer.clone(), events.clone(), cancel.clone()).await?;

        // IOPub subscriber.
        let mut sub = SubSocket::new();
        sub.connect(&ep(info.iopub_port)).await.context("connect iopub")?;
        sub.subscribe("").await?;
        {
            let signer = signer.clone();
            let events = events.clone();
            let cancel = cancel.clone();
            tokio::spawn(async move {
                loop {
                    let m = tokio::select! {
                        _ = cancel.cancelled() => break,
                        r = sub.recv() => r,
                    };
                    match m {
                        Ok(m) => match Message::decode(m.into_vec(), &signer) {
                            Ok(msg) => {
                                let _ = events.send(Event { channel: Channel::IoPub, msg });
                            }
                            Err(e) => tracing::warn!("iopub decode: {e:#}"),
                        },
                        Err(e) => {
                            tracing::warn!("iopub closed: {e}");
                            break;
                        }
                    }
                }
                drop(sub);
            });
        }

        // Heartbeat: REQ/REP ping every 3 s; three misses mark the kernel dead.
        let hb_dead;
        {
            let hb_ep = ep(info.hb_port);
            let cancel = cancel.clone();
            let flag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
            let flag2 = flag.clone();
            tokio::spawn(async move {
                let mut misses = 0u32;
                'outer: loop {
                    let mut sock = ReqSocket::new();
                    let connected = tokio::select! {
                        _ = cancel.cancelled() => break,
                        r = tokio::time::timeout(std::time::Duration::from_secs(3), sock.connect(&hb_ep)) => matches!(r, Ok(Ok(_))),
                    };
                    if !connected {
                        misses += 1; // refused / unreachable counts as a missed beat
                        tracing::debug!("heartbeat connect failed ({misses})");
                        if misses >= 3 {
                            tracing::warn!("kernel heartbeat lost");
                            flag2.store(true, std::sync::atomic::Ordering::Relaxed);
                            break;
                        }
                        tokio::select! { _ = cancel.cancelled() => break, _ = tokio::time::sleep(std::time::Duration::from_secs(3)) => {} }
                        continue;
                    }
                    loop {
                        tokio::select! { _ = cancel.cancelled() => break 'outer, _ = tokio::time::sleep(std::time::Duration::from_secs(3)) => {} }
                        // send() blocks while the peer is gone, so it needs a timeout as well.
                        let sent = tokio::select! {
                            _ = cancel.cancelled() => break 'outer,
                            r = tokio::time::timeout(std::time::Duration::from_secs(3), sock.send(ZmqMessage::from("ping"))) => r,
                        };
                        if !matches!(sent, Ok(Ok(()))) {
                            misses += 1;
                            break;
                        }
                        let got = tokio::select! {
                            _ = cancel.cancelled() => break 'outer,
                            r = tokio::time::timeout(std::time::Duration::from_secs(3), sock.recv()) => r,
                        };
                        match got {
                            Ok(Ok(_)) => { misses = 0; flag2.store(false, std::sync::atomic::Ordering::Relaxed); }
                            _ => { misses += 1; break; } // REQ state is now broken: rebuild the socket
                        }
                    }
                    if misses >= 3 {
                        tracing::warn!("kernel heartbeat lost");
                        flag2.store(true, std::sync::atomic::Ordering::Relaxed);
                        break;
                    }
                }
            });
            hb_dead = flag;
        }

        let kernel = Arc::new(Kernel {
            child: Mutex::new(child),
            extra: Mutex::new(extra),
            remote,
            owned,
            info,
            signer,
            session,
            shell_tx,
            control_tx,
            stdin_tx,
            events,
            cancel,
            hb_dead,
            _conn_file: conn_file,
            handles,
        });

        // Wait until the kernel answers kernel_info (ipykernel needs ~1s to bind).
        kernel.wait_ready(std::time::Duration::from_secs(60)).await?;
        Ok(kernel)
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Event> {
        self.events.subscribe()
    }

    fn build(&self, msg_type: &str, content: Value) -> (String, ZmqMessage) {
        self.build_with_id(msg_type, content, None)
    }

    /// Like `build`, but the caller may supply the msg_id so it can register
    /// handlers before the request is even sent (avoids reply/ID races).
    fn build_with_id(&self, msg_type: &str, content: Value, msg_id: Option<String>) -> (String, ZmqMessage) {
        let mut header = Header::new(msg_type, &self.session);
        if let Some(id) = msg_id {
            header.msg_id = id;
        }
        let id = header.msg_id.clone();
        let msg = Message {
            header,
            parent_header: json!({}),
            metadata: json!({}),
            content,
            buffers: vec![],
        };
        (id, msg.encode(&self.signer))
    }

    /// Send an execute_request. Returns the msg_id so callers can match replies.
    pub async fn execute(
        &self,
        code: &str,
        silent: bool,
        store_history: bool,
        user_expressions: HashMap<String, String>,
        allow_stdin: bool,
    ) -> Result<String> {
        self.execute_with_id(code, silent, store_history, user_expressions, allow_stdin, None).await
    }

    pub async fn execute_with_id(
        &self,
        code: &str,
        silent: bool,
        store_history: bool,
        user_expressions: HashMap<String, String>,
        allow_stdin: bool,
        msg_id: Option<String>,
    ) -> Result<String> {
        let (id, msg) = self.build_with_id(
            "execute_request",
            json!({
                "code": code,
                "silent": silent,
                "store_history": store_history,
                "user_expressions": user_expressions,
                "allow_stdin": allow_stdin,
                "stop_on_error": true,
            }),
            msg_id,
        );
        self.shell_tx.send(msg).await?;
        Ok(id)
    }

    pub async fn complete(&self, code: &str, cursor_pos: usize) -> Result<String> {
        let (id, msg) = self.build("complete_request", json!({"code": code, "cursor_pos": cursor_pos}));
        self.shell_tx.send(msg).await?;
        Ok(id)
    }

    pub async fn inspect(&self, code: &str, cursor_pos: usize, detail_level: u8) -> Result<String> {
        let (id, msg) = self.build(
            "inspect_request",
            json!({"code": code, "cursor_pos": cursor_pos, "detail_level": detail_level}),
        );
        self.shell_tx.send(msg).await?;
        Ok(id)
    }

    pub async fn is_complete(&self, code: &str) -> Result<String> {
        let (id, msg) = self.build("is_complete_request", json!({"code": code}));
        self.shell_tx.send(msg).await?;
        Ok(id)
    }

    /// Send an arbitrary request on the control channel (e.g. debug_request).
    pub async fn control(&self, msg_type: &str, content: Value) -> Result<String> {
        let (id, msg) = self.build(msg_type, content);
        self.control_tx.send(msg).await?;
        Ok(id)
    }

    pub async fn kernel_info(&self) -> Result<String> {
        let (id, msg) = self.build("kernel_info_request", json!({}));
        self.shell_tx.send(msg).await?;
        Ok(id)
    }

    /// Reply to an input_request from the kernel.
    pub async fn input_reply(&self, parent: &Header, value: &str) -> Result<()> {
        let header = Header::new("input_reply", &self.session);
        let msg = Message {
            header,
            parent_header: serde_json::to_value(parent)?,
            metadata: json!({}),
            content: json!({"value": value}),
            buffers: vec![],
        };
        self.stdin_tx.send(msg.encode(&self.signer)).await?;
        Ok(())
    }

    /// Interrupt the running cell (SIGINT, like Jupyter's default interrupt_mode).
    pub async fn interrupt(&self) -> Result<()> {
        if self.remote {
            let (_, msg) = self.build("interrupt_request", json!({}));
            self.control_tx.send(msg).await?;
            return Ok(());
        }
        let mut child = self.child.lock().await;
        if let Some(c) = child.as_mut() {
            if matches!(c.try_wait(), Ok(Some(_))) {
                return Ok(());
            }
            if let Some(pid) = c.id() {
                if !self.handles.interrupt(pid) {
                    // No signal/event available: ask the kernel over the control channel.
                    let (_, msg) = self.build("interrupt_request", json!({}));
                    self.control_tx.send(msg).await?;
                }
            }
        }
        Ok(())
    }

    pub async fn shutdown(&self, restart: bool) -> Result<()> {
        if self.owned {
            let (_, msg) = self.build("shutdown_request", json!({"restart": restart}));
            let _ = self.control_tx.send(msg).await;
        }
        let mut child = self.child.lock().await;
        if let Some(mut c) = child.take() {
            // Let the kernel exit cleanly (flush files) before forcing it.
            let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(3);
            while tokio::time::Instant::now() < deadline {
                if matches!(c.try_wait(), Ok(Some(_))) {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            }
            let _ = c.start_kill();
            let _ = c.wait().await;
        }
        for mut c in self.extra.lock().await.drain(..) {
            let _ = c.start_kill();
            let _ = c.wait().await;
        }
        self.cancel.cancel();
        Ok(())
    }

    pub async fn is_alive(&self) -> bool {
        if self.cancel.is_cancelled() || self.hb_dead.load(std::sync::atomic::Ordering::Relaxed) {
            return false;
        }
        for c in self.extra.lock().await.iter_mut() {
            if matches!(c.try_wait(), Ok(Some(_))) {
                return false; // ssh tunnel died
            }
        }
        let mut child = self.child.lock().await;
        match child.as_mut() {
            Some(c) => matches!(c.try_wait(), Ok(None)),
            None => true,
        }
    }

    /// Resolves when the kernel has been shut down or dropped.
    pub async fn cancelled(&self) {
        self.cancel.cancelled().await
    }

    async fn wait_ready(&self, timeout: std::time::Duration) -> Result<()> {
        let mut rx = self.subscribe();
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            if tokio::time::Instant::now() > deadline {
                anyhow::bail!("kernel did not become ready within {timeout:?}");
            }
            let id = self.kernel_info().await?;
            let wait = tokio::time::timeout(std::time::Duration::from_secs(1), async {
                loop {
                    match rx.recv().await {
                        Ok(ev) if ev.channel == Channel::Shell && ev.msg.parent_id() == Some(id.as_str()) => {
                            return true;
                        }
                        Ok(_) => {}
                        Err(broadcast::error::RecvError::Lagged(_)) => {}
                        Err(_) => return false,
                    }
                }
            })
            .await;
            if let Ok(true) = wait {
                return Ok(());
            }
            if !self.is_alive().await {
                anyhow::bail!("kernel process exited during startup");
            }
        }
    }
}

async fn dealer(
    endpoint: &str,
    channel: Channel,
    signer: Signer,
    events: broadcast::Sender<Event>,
    cancel: CancellationToken,
) -> Result<mpsc::Sender<ZmqMessage>> {
    let mut sock = DealerSocket::new();
    sock.connect(endpoint).await.with_context(|| format!("connect {channel:?} {endpoint}"))?;
    let (mut send_half, mut recv_half): (DealerSendHalf, _) = sock.split();
    let (tx, mut rx) = mpsc::channel::<ZmqMessage>(256);
    let c1 = cancel.clone();
    tokio::spawn(async move {
        loop {
            let m = tokio::select! { _ = c1.cancelled() => break, m = rx.recv() => m };
            let Some(m) = m else { break };
            if let Err(e) = send_half.send(m).await {
                tracing::warn!("{channel:?} send: {e}");
                break;
            }
        }
        drop(send_half);
    });
    tokio::spawn(async move {
        loop {
            let r = tokio::select! { _ = cancel.cancelled() => break, r = recv_half.recv() => r };
            match r {
                Ok(m) => match Message::decode(m.into_vec(), &signer) {
                    Ok(msg) => {
                        let _ = events.send(Event { channel, msg });
                    }
                    Err(e) => tracing::warn!("{channel:?} decode: {e:#}"),
                },
                Err(e) => {
                    tracing::warn!("{channel:?} closed: {e}");
                    break;
                }
            }
        }
        drop(recv_half);
    });
    Ok(tx)
}

pub fn b64encode(d: &[u8]) -> String {
    const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut o = String::new();
    for c in d.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        o.push(T[(n >> 18 & 63) as usize] as char);
        o.push(T[(n >> 12 & 63) as usize] as char);
        o.push(if c.len() > 1 { T[(n >> 6 & 63) as usize] as char } else { '=' });
        o.push(if c.len() > 2 { T[(n & 63) as usize] as char } else { '=' });
    }
    o
}

/// POSIX single-quote; `~` is expanded by the remote shell only when it is the
/// whole string or a `~/` prefix with no further quoting hazards.
pub fn shell_quote(s: &str) -> String {
    if let Some(rest) = s.strip_prefix("~/") {
        return format!("~/'{}'", rest.replace('\'', "'\\''"));
    }
    if s == "~" {
        return s.to_string();
    }
    format!("'{}'", s.replace('\'', "'\\''"))
}

async fn pipe_log<R: tokio::io::AsyncRead + Unpin>(name: &'static str, r: R) {
    use tokio::io::AsyncBufReadExt;
    let mut lines = tokio::io::BufReader::new(r).lines();
    while let Ok(Some(l)) = lines.next_line().await {
        tracing::debug!(target: "kernel", "[{name}] {l}");
    }
}

#[allow(dead_code)]
fn _bytes(v: &[u8]) -> Bytes {
    Bytes::copy_from_slice(v)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_quote_escapes_single_quotes_and_keeps_tilde() {
        assert_eq!(shell_quote("plain"), "'plain'");
        assert_eq!(shell_quote("it's"), "'it'\\''s'");
        assert_eq!(shell_quote("~"), "~");
        assert_eq!(shell_quote("~/my project"), "~/'my project'");
        assert_eq!(shell_quote("~/x;rm -rf ~"), "~/'x;rm -rf ~'");
    }

    #[test]
    fn b64encode_matches_standard() {
        assert_eq!(b64encode(b""), "");
        assert_eq!(b64encode(b"f"), "Zg==");
        assert_eq!(b64encode(b"fo"), "Zm8=");
        assert_eq!(b64encode(b"foo"), "Zm9v");
        assert_eq!(b64encode(b"hello world"), "aGVsbG8gd29ybGQ=");
    }

    #[test]
    fn connection_info_ports_are_distinct() {
        let i = ConnectionInfo::new_local().unwrap();
        let mut p = vec![i.shell_port, i.iopub_port, i.stdin_port, i.control_port, i.hb_port];
        p.sort();
        p.dedup();
        assert_eq!(p.len(), 5);
        assert_eq!(i.key.len(), 32);
    }
}
