//! Cross-platform smoke test used by CI: launch ipykernel, run code, interrupt
//! a busy cell (SIGINT on Unix, the interrupt event on Windows), shut down.
//! Usage: cargo run --example smoke -- <python>
use std::collections::HashMap;
use std::time::Duration;

use kernel_client::{Channel, Kernel, LaunchSpec};

async fn wait_reply(rx: &mut tokio::sync::broadcast::Receiver<kernel_client::Event>, id: &str, secs: u64) -> anyhow::Result<serde_json::Value> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(secs);
    loop {
        let ev = tokio::time::timeout_at(deadline, rx.recv()).await??;
        if ev.msg.parent_id() != Some(id) {
            continue;
        }
        if ev.channel == Channel::IoPub && ev.msg.msg_type() == "stream" {
            print!("  [{}] {}", ev.msg.content["name"].as_str().unwrap_or("?"), ev.msg.content["text"].as_str().unwrap_or(""));
        }
        if ev.channel == Channel::Shell && ev.msg.msg_type() == "execute_reply" {
            return Ok(ev.msg.content.clone());
        }
    }
}

/// What the kernel sees of the interrupt plumbing (printed for CI logs).
const DIAG: &str = r#"
import os, signal, sys, threading
print("python", sys.version.split()[0], "platform", sys.platform)
print("env JPY_INTERRUPT_EVENT", os.environ.get("JPY_INTERRUPT_EVENT"), "JPY_PARENT_PID", os.environ.get("JPY_PARENT_PID"))
try:
    import ipykernel; print("ipykernel", ipykernel.__version__)
    from ipykernel.kernelapp import IPKernelApp
    app = IPKernelApp.instance()
    p = app.poller
    print("poller", type(p).__name__ if p else None, "alive", p.is_alive() if p else None, "interrupt_handle", getattr(p, "interrupt_handle", None), "parent_handle", getattr(p, "parent_handle", None))
except Exception as e:
    print("poller error", e)
print("sigint handler", signal.getsignal(signal.SIGINT), "main thread", threading.current_thread() is threading.main_thread())
if sys.platform == "win32":
    import ctypes
    h = int(os.environ.get("JPY_INTERRUPT_EVENT") or 0)
    print("WaitForSingleObject(event, 0) ->", ctypes.windll.kernel32.WaitForSingleObject(h, 0), "(258 = valid+unsignalled, 4294967295 = invalid handle; err", ctypes.windll.kernel32.GetLastError(), ")")
"#;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt().with_env_filter(tracing_subscriber::EnvFilter::from_default_env()).init();
    let python = std::env::args().nth(1).unwrap_or_else(|| if cfg!(windows) { "python".into() } else { "python3".into() });
    let helper = concat!(env!("CARGO_MANIFEST_DIR"), "/../../python");
    let k = Kernel::launch(LaunchSpec { python: python.into(), cwd: None, env: vec![("PYTHONPATH".into(), helper.into())] }).await?;
    println!("launched; shell port {}", k.info.shell_port);
    let mut rx = k.subscribe();

    // 1. plain execution + workspace snapshot through user_expressions
    let mut ue = HashMap::new();
    ue.insert("ws".to_string(), "__import__('pide_kernel').snapshot()".to_string());
    let id = k.execute("x = [1, 2, 3]\ny = 'hi'", false, true, ue, false).await?;
    let reply = wait_reply(&mut rx, &id, 30).await?;
    anyhow::ensure!(reply["status"] == "ok", "execute failed: {reply}");
    let vars = reply["user_expressions"]["ws"]["data"]["application/x-pide+json"]["variables"].as_array().cloned().unwrap_or_default();
    let names: Vec<&str> = vars.iter().filter_map(|v| v["name"].as_str()).collect();
    anyhow::ensure!(names.contains(&"x") && names.contains(&"y"), "snapshot missing variables: {names:?}");
    println!("snapshot ok: {names:?}");

    let id = k.execute(DIAG, false, false, HashMap::new(), false).await?;
    let reply = wait_reply(&mut rx, &id, 30).await?;
    anyhow::ensure!(reply["status"] == "ok", "diagnostics cell failed: {reply}");

    // 2. interrupt a busy cell.  A Python-level loop (not time.sleep): on Windows the
    // interrupt event only trips the eval loop, so a blocking C call such as
    // time.sleep() is interrupted when it returns, exactly as in Jupyter.
    let id = k.execute("i = 0\nwhile True:\n    i += 1", false, true, HashMap::new(), false).await?;
    tokio::time::sleep(Duration::from_millis(1500)).await;
    k.interrupt().await?;
    let reply = wait_reply(&mut rx, &id, 20).await?;
    anyhow::ensure!(reply["status"] == "error" && reply["ename"] == "KeyboardInterrupt", "interrupt did not stop the cell: {reply}");
    println!("interrupt ok");

    // 3. the kernel is still usable afterwards
    let id = k.execute("1 + 1", false, true, HashMap::new(), false).await?;
    let reply = wait_reply(&mut rx, &id, 30).await?;
    anyhow::ensure!(reply["status"] == "ok", "post-interrupt execute failed: {reply}");

    // 4. shutdown terminates the process
    k.shutdown(false).await?;
    tokio::time::sleep(Duration::from_millis(500)).await;
    anyhow::ensure!(!k.is_alive().await, "kernel still alive after shutdown");
    println!("shutdown ok");
    Ok(())
}
