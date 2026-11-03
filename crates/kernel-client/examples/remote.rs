//! Start a kernel "remotely" through an ssh-compatible command and run code.
//! Usage: remote <ssh-binary> <host> <remote-python>
use kernel_client::{launch::RemoteSpec, Channel, Kernel};
use std::collections::HashMap;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt::init();
    let a: Vec<String> = std::env::args().collect();
    let helper = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../../python/pide_kernel/__init__.py"))?;
    let k = Kernel::launch_remote(RemoteSpec { host: a[2].clone(), python: a[3].clone(), ssh: Some(a[1].clone()), cwd: None, port: None, ssh_args: vec![] }, &helper).await?;
    println!("remote kernel ready via local shell port {}", k.info.shell_port);
    let mut rx = k.subscribe();
    let mut ue = HashMap::new();
    ue.insert("ws".to_string(), "__import__('pide_kernel').snapshot()".to_string());
    let id = k.execute("import os, socket\nhost = socket.gethostname()\nprint('running in', os.getcwd(), 'pid', os.getpid())", false, true, ue, false).await?;
    loop {
        let ev = rx.recv().await?;
        if ev.msg.parent_id() != Some(id.as_str()) { continue; }
        match (ev.channel, ev.msg.msg_type()) {
            (Channel::IoPub, "stream") => println!("stream: {}", ev.msg.content["text"]),
            (Channel::Shell, "execute_reply") => {
                let ws = &ev.msg.content["user_expressions"]["ws"]["data"]["application/x-pide+json"];
                println!("workspace vars: {:?}", ws["variables"].as_array().map(|v| v.iter().map(|x| x["name"].as_str().unwrap_or("").to_string()).collect::<Vec<_>>()));
                break;
            }
            _ => {}
        }
    }
    // interrupt path for remote kernels goes through the control channel
    let id2 = k.execute("import time\ntime.sleep(30)", false, true, HashMap::new(), false).await?;
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    k.interrupt().await?;
    loop {
        let ev = rx.recv().await?;
        if ev.msg.parent_id() == Some(id2.as_str()) && ev.channel == Channel::Shell {
            println!("after interrupt: status={} ename={}", ev.msg.content["status"], ev.msg.content["ename"]);
            break;
        }
    }
    k.shutdown(false).await?;
    Ok(())
}
