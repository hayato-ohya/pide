import { useEffect, useRef, useState } from "react";
import { AnsiUp } from "ansi_up";
import { complete, execute, interrupt, isComplete, replyInput } from "../kernel";
import { useStore } from "../store";
import type { ConsoleItem, Mime } from "../types";

const ansi = new AnsiUp();
ansi.use_classes = false;

function Output({ data }: { data: Mime }) {
  if (data["text/html"]) return <div className="out-html" dangerouslySetInnerHTML={{ __html: String(data["text/html"]) }} />;
  if (data["image/png"]) return <img className="out-img" src={`data:image/png;base64,${data["image/png"]}`} />;
  if (data["image/svg+xml"]) return <div className="out-img" dangerouslySetInnerHTML={{ __html: String(data["image/svg+xml"]) }} />;
  if (data["application/vnd.plotly.v1+json"]) return <div className="out-note">[interactive figure → Figures panel]</div>;
  if (data["text/plain"]) return <pre className="out-text">{String(data["text/plain"])}</pre>;
  return null;
}

function Item({ it }: { it: ConsoleItem }) {
  switch (it.kind) {
    case "input":
      return (
        <div className="c-input">
          <span className="prompt">&gt;&gt; </span>
          <pre>{it.code}</pre>
        </div>
      );
    case "stream":
      return <pre className={`c-stream ${it.name}`} dangerouslySetInnerHTML={{ __html: ansi.ansi_to_html(it.text) }} />;
    case "result":
      return (
        <div className="c-result">
          <Output data={it.data} />
        </div>
      );
    case "display":
      return (
        <div className="c-display">
          <Output data={it.data} />
        </div>
      );
    case "error":
      return <pre className="c-error" dangerouslySetInnerHTML={{ __html: ansi.ansi_to_html(it.traceback.join("\n") || `${it.ename}: ${it.evalue}`) }} />;
    case "info":
      return <div className="c-info">{it.text}</div>;
  }
}

export default function Console() {
  const items = useStore((s) => s.console);
  const kernel = useStore((s) => s.kernel);
  const history = useStore((s) => s.history);
  const inputReq = useStore((s) => s.inputRequest);
  const stopped = useStore((s) => s.debug.stopped);
  const [code, setCode] = useState("");
  const [hIdx, setHIdx] = useState<number | null>(null);
  const [comp, setComp] = useState<{ matches: string[]; start: number; end: number; sel: number } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const stickBottom = useRef(true);

  useEffect(() => {
    const el = listRef.current;
    if (el && stickBottom.current) el.scrollTop = el.scrollHeight;
  }, [items, inputReq]);

  const onScroll = () => {
    const el = listRef.current!;
    stickBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  const applyCompDirect = (m: string, start: number, end: number) => {
    const next = code.slice(0, start) + m + code.slice(end);
    setCode(next);
    setComp(null);
    requestAnimationFrame(() => taRef.current?.setSelectionRange(start + m.length, start + m.length));
  };

  const submit = async () => {
    const c = code;
    if (inputReq) {
      setCode("");
      await replyInput(c);
      return;
    }
    if (!c.trim()) return;
    setCode("");
    setHIdx(null);
    stickBottom.current = true;
    await execute(c);
  };

  const applyComp = (m: string) => {
    if (!comp) return;
    const next = code.slice(0, comp.start) + m + code.slice(comp.end);
    setCode(next);
    setComp(null);
    requestAnimationFrame(() => taRef.current?.setSelectionRange(comp.start + m.length, comp.start + m.length));
  };

  const onKey = async (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (comp) {
      if (e.key === "ArrowDown") { e.preventDefault(); setComp({ ...comp, sel: (comp.sel + 1) % comp.matches.length }); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setComp({ ...comp, sel: (comp.sel - 1 + comp.matches.length) % comp.matches.length }); return; }
      if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); applyComp(comp.matches[comp.sel]); return; }
      if (e.key === "Escape") { e.preventDefault(); setComp(null); return; }
      setComp(null);
    }
    if (e.key === "Tab" && !inputReq) {
      e.preventDefault();
      const cursor = e.currentTarget.selectionStart;
      if (!code.slice(0, cursor).trim()) { setCode(code.slice(0, cursor) + "    " + code.slice(cursor)); return; }
      try {
        const r = await complete(code, cursor);
        const matches: string[] = r.matches ?? [];
        if (matches.length === 1) { setComp({ matches, start: r.cursor_start, end: r.cursor_end, sel: 0 }); applyCompDirect(matches[0], r.cursor_start, r.cursor_end); }
        else if (matches.length > 1) setComp({ matches: matches.slice(0, 200), start: r.cursor_start, end: r.cursor_end, sel: 0 });
      } catch { /* kernel busy */ }
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      // Enter runs when the statement is complete; otherwise it adds a line.
      const ta = e.currentTarget;
      const multiline = code.includes("\n");
      if (!multiline && !inputReq) {
        e.preventDefault();
        const st = await isComplete(code);
        if (st === "incomplete") setCode(code + "\n");
        else await submit();
        return;
      }
      if (inputReq || code.endsWith("\n") || ta.selectionStart === code.length) {
        if (inputReq || !multiline || code.endsWith("\n")) {
          e.preventDefault();
          await submit();
          return;
        }
      }
    } else if (e.key === "ArrowUp" && !code.includes("\n")) {
      e.preventDefault();
      const i = hIdx === null ? history.length - 1 : Math.max(0, hIdx - 1);
      if (history[i] !== undefined) {
        setHIdx(i);
        setCode(history[i]);
      }
    } else if (e.key === "ArrowDown" && hIdx !== null) {
      e.preventDefault();
      const i = hIdx + 1;
      if (i >= history.length) {
        setHIdx(null);
        setCode("");
      } else {
        setHIdx(i);
        setCode(history[i]);
      }
    } else if (e.key === "c" && e.ctrlKey && kernel === "busy") {
      e.preventDefault();
      await interrupt();
    } else if (e.key === "l" && e.ctrlKey) {
      e.preventDefault();
      listRef.current && (listRef.current.scrollTop = listRef.current.scrollHeight);
    }
  };

  return (
    <div className="console" onClick={(e) => e.target === listRef.current && taRef.current?.focus()}>
      <div className="console-list" ref={listRef} onScroll={onScroll}>
        {items.map((it) => (
          <Item key={it.id} it={it} />
        ))}
        {inputReq && <div className="c-info">{inputReq.prompt}</div>}
      </div>
      {comp && (
        <div className="comp-popup">
          {comp.matches.map((m, i) => (
            <div key={m} className={i === comp.sel ? "selected" : ""} onMouseDown={(e) => { e.preventDefault(); applyComp(m); }}>{m}</div>
          ))}
        </div>
      )}
      <div className={`console-input ${kernel}`}>
        <span className="prompt">{inputReq ? "?" : stopped ? "K>>" : kernel === "busy" ? "…" : ">>"}</span>
        <textarea
          ref={taRef}
          value={code}
          rows={Math.min(12, code.split("\n").length)}
          placeholder={kernel === "stopped" ? "Kernel stopped. Type a command to start it." : stopped ? "Paused in debugger: use Continue / Step (DEBUG tab)" : ""}
          onChange={(e) => setCode(e.target.value)}
          onKeyDown={onKey}
          spellCheck={false}
          autoFocus
        />
      </div>
    </div>
  );
}
