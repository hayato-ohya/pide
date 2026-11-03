import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { get, useStore } from "../store";

interface Tab { id: number; ptyId: number | null; title: string; exited: boolean }
let nextTab = 1;

const LIGHT = { background: "#ffffff", foreground: "#1e1e1e", cursor: "#1e1e1e", selectionBackground: "#cfe6f5", black: "#000000", brightBlack: "#6b6b6b" };
const DARK = { background: "#1b1b1f", foreground: "#e6e6e6", cursor: "#e6e6e6", selectionBackground: "#2f4f63" };

function decode(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** One xterm instance bound to one PTY. */
function TermView({ tab, onExit, onTitle }: { tab: Tab; onExit: () => void; onTitle: (t: string) => void }) {
  const host = useRef<HTMLDivElement>(null);
  const theme = useStore((s) => s.theme);
  const xref = useRef<XTerm | null>(null);
  const ptyRef = useRef<number | null>(null);

  useEffect(() => {
    const el = host.current!;
    const term = new XTerm({ fontFamily: '"SF Mono", Menlo, Consolas, monospace', fontSize: 12.5, cursorBlink: true, scrollback: 5000, allowProposedApi: true, theme: theme === "dark" ? DARK : LIGHT, macOptionIsMeta: true });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(el);
    xref.current = term;
    requestAnimationFrame(() => { try { fit.fit(); } catch { /* not laid out yet */ } });
    let unlistenData: UnlistenFn | null = null;
    let unlistenExit: UnlistenFn | null = null;
    let disposed = false;

    (async () => {
      // The panel may mount (layout restore) before the working folder is known.
      for (let i = 0; i < 20 && !get().cwd && !get().remote; i++) await new Promise((r) => setTimeout(r, 150));
      const remote = get().remote;
      // Remote kernel selected → open an SSH session to that host instead of a local shell.
      const command = remote ? ["ssh", "-t", ...(remote.port ? ["-p", String(remote.port)] : []), remote.host, remote.cwd ? `cd ${JSON.stringify(remote.cwd)}; exec $SHELL -l` : "exec $SHELL -l"] : null;
      unlistenData = await listen<{ id: number; data: string }>("pty-data", (e) => { if (e.payload.id === ptyRef.current) term.write(decode(e.payload.data)); });
      unlistenExit = await listen<{ id: number }>("pty-exit", (e) => { if (e.payload.id === ptyRef.current) { term.write("\r\n\x1b[90m[process exited]\x1b[0m\r\n"); invoke("pty_reap").catch(() => {}); onExit(); } });
      if (disposed) return;
      try {
        const id = await invoke<number>("pty_spawn", { cols: term.cols, rows: term.rows, cwd: remote ? null : get().cwd, command, env: { PIDE_PYTHON: get().python ?? "" } });
        ptyRef.current = id;
        onTitle(remote ? `ssh ${remote.host}` : (get().cwd ?? "shell").split("/").pop() || "shell");
      } catch (err) {
        term.write(`\x1b[31mfailed to start terminal: ${err}\x1b[0m\r\n`);
      }
    })();

    const onData = term.onData((d) => { if (ptyRef.current != null) invoke("pty_write", { id: ptyRef.current, data: d }).catch(() => {}); });
    const onResize = term.onResize(({ cols, rows }) => { if (ptyRef.current != null) invoke("pty_resize", { id: ptyRef.current, cols, rows }).catch(() => {}); });
    const ro = new ResizeObserver(() => { if (el.clientHeight > 0) { try { fit.fit(); } catch { /* hidden */ } } });
    ro.observe(el);
    term.focus();
    el.closest(".dv-content-container")?.scrollTo?.(0, 0);
    return () => {
      disposed = true;
      ro.disconnect();
      onData.dispose();
      onResize.dispose();
      unlistenData?.();
      unlistenExit?.();
      if (ptyRef.current != null) invoke("pty_kill", { id: ptyRef.current }).catch(() => {});
      term.dispose();
    };
  }, [tab.id]);

  useEffect(() => { if (xref.current) xref.current.options.theme = theme === "dark" ? DARK : LIGHT; }, [theme]);

  return <div className="term-host" ref={host} />;
}

export default function TerminalPanel() {
  const [tabs, setTabs] = useState<Tab[]>([{ id: nextTab++, ptyId: null, title: "shell", exited: false }]);
  const [active, setActive] = useState<number>(tabs[0].id);
  const remote = useStore((s) => s.remote);
  const add = () => { const t = { id: nextTab++, ptyId: null, title: remote ? `ssh ${remote.host}` : "shell", exited: false }; setTabs((x) => [...x, t]); setActive(t.id); };
  const close = (id: number) => setTabs((x) => { const n = x.filter((t) => t.id !== id); if (active === id && n.length) setActive(n[n.length - 1].id); return n; });
  return (
    <div className="terminal">
      <div className="term-tabs">
        {tabs.map((t) => (
          <div key={t.id} className={`term-tab ${t.id === active ? "on" : ""} ${t.exited ? "exited" : ""}`} onClick={() => setActive(t.id)}>
            <span>{t.title}</span><button onClick={(e) => { e.stopPropagation(); close(t.id); }} title="Close">×</button>
          </div>
        ))}
        <button className="term-add" onClick={add} title="New terminal (in the current folder, or SSH to the remote kernel's host)">＋</button>
      </div>
      <div className="term-body">
        {tabs.map((t) => (
          <div key={t.id} style={{ display: t.id === active ? "block" : "none", height: "100%" }}>
            <TermView tab={t} onExit={() => setTabs((x) => x.map((y) => (y.id === t.id ? { ...y, exited: true } : y)))} onTitle={(title) => setTabs((x) => x.map((y) => (y.id === t.id ? { ...y, title } : y)))} />
          </div>
        ))}
        {!tabs.length && <div className="center muted">No terminals. Press ＋ to open one.</div>}
      </div>
    </div>
  );
}
