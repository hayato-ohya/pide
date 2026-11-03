//! Heartbeat check: attach to a kernel we also own, kill it, and expect the
//! attached (child-less) handle to notice through the heartbeat.
use kernel_client::{Kernel, LaunchSpec};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt().init();
    let python = std::env::args().nth(1).unwrap_or_else(|| "python3".into());
    let helper = concat!(env!("CARGO_MANIFEST_DIR"), "/../../python");
    let owner = Kernel::launch(LaunchSpec { python: python.into(), cwd: None, env: vec![("PYTHONPATH".into(), helper.into())] }).await?;
    let attached = Kernel::connect(owner.info.clone()).await?;
    println!("attached alive: {}", attached.is_alive().await);
    let t0 = std::time::Instant::now();
    owner.shutdown(false).await?;
    println!("owner shut down; waiting for heartbeat to notice");
    loop {
        if !attached.is_alive().await {
            println!("attached reported dead after {:.1}s", t0.elapsed().as_secs_f32());
            break;
        }
        if t0.elapsed().as_secs() > 40 {
            println!("FAIL: still alive after 40s");
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }
    Ok(())
}
