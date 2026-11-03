//! Tiny end-to-end check: launch a kernel, run code, print iopub traffic and
//! the workspace snapshot returned through user_expressions.
use std::collections::HashMap;
use kernel_client::{Channel, Kernel, LaunchSpec};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt::init();
    let python = std::env::args().nth(1).unwrap_or_else(|| "python3".into());
    let helper = concat!(env!("CARGO_MANIFEST_DIR"), "/../../python");
    let k = Kernel::launch(LaunchSpec {
        python: python.into(),
        cwd: None,
        env: vec![("PYTHONPATH".into(), helper.into())],
    })
    .await?;
    println!("kernel ready on shell port {}", k.info.shell_port);
    let mut rx = k.subscribe();
    let mut ue = HashMap::new();
    ue.insert("ws".to_string(), "__import__('pide_kernel').snapshot()".to_string());
    let id = k
        .execute("import numpy as np\nx = np.arange(12).reshape(3,4)\nprint('hello from kernel')\nx.sum()", false, true, ue, false)
        .await?;
    loop {
        let ev = rx.recv().await?;
        if ev.msg.parent_id() != Some(id.as_str()) {
            continue;
        }
        match (ev.channel, ev.msg.msg_type()) {
            (Channel::IoPub, "stream") => println!("stream: {}", ev.msg.content["text"]),
            (Channel::IoPub, "execute_result") => println!("result: {}", ev.msg.content["data"]["text/plain"]),
            (Channel::IoPub, t) => println!("iopub {t}"),
            (Channel::Shell, "execute_reply") => {
                let ws = &ev.msg.content["user_expressions"]["ws"]["data"]["application/x-pide+json"];
                for v in ws["variables"].as_array().unwrap() {
                    println!("  {:<6} {:<10} {}", v["name"], v["kind"], v["value"]);
                }
                break;
            }
            _ => {}
        }
    }
    k.shutdown(false).await?;
    Ok(())
}
