//! Cross-platform smoke test used by CI: launch ipykernel, run code, interrupt
//! a sleeping cell (SIGINT on Unix, the interrupt event on Windows), shut down.
//! Usage: cargo run --example smoke -- <python>
use std::collections::HashMap;
use std::time::Duration;

use kernel_client::{Channel, Kernel, LaunchSpec};

async fn wait_reply(rx: &mut tokio::sync::broadcast::Receiver<kernel_client::Event>, id: &str, secs: u64) -> anyhow::Result<serde_json::Value> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(secs);
    loop {
        let ev = tokio::time::timeout_at(deadline, rx.recv()).await??;
        if ev.channel == Channel::Shell && ev.msg.msg_type() == "execute_reply" && ev.msg.parent_id() == Some(id) {
            return Ok(ev.msg.content.clone());
        }
    }
}

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

    // 2. interrupt a sleeping cell
    let id = k.execute("import time\ntime.sleep(60)", false, true, HashMap::new(), false).await?;
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
