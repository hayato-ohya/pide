import { useState } from "react";
import { saveToolSettings, type Formatter, type Linter, type ToolSettings } from "../tools";
import { useStore } from "../store";
import { startLsp } from "../lsp";
import { pushConsole } from "../store";
import Modal from "./Modal";

const LINTERS: { id: Linter; label: string; note: string }[] = [
  { id: "ruff", label: "ruff", note: "LSP server, fastest; pip install ruff" },
  { id: "flake8", label: "flake8", note: "CLI on save/typing; pip install flake8" },
  { id: "pylint", label: "pylint", note: "CLI, slower but thorough; pip install pylint" },
  { id: "none", label: "none", note: "pyright type diagnostics only" },
];
const FORMATTERS: { id: Formatter; label: string; note: string }[] = [
  { id: "ruff", label: "ruff format", note: "black-compatible; pip install ruff" },
  { id: "black", label: "black", note: "pip install black" },
  { id: "autopep8", label: "autopep8", note: "pip install autopep8" },
  { id: "none", label: "none", note: "" },
];

/** Linter / formatter selection, stored in localStorage (pide.tools). */
export default function ToolsDialog({ onClose }: { onClose: () => void }) {
  const current = useStore((s) => s.tools);
  const python = useStore((s) => s.python);
  const [t, setT] = useState<ToolSettings>({ ...current });
  const apply = async () => {
    saveToolSettings(t);
    onClose();
    pushConsole({ kind: "info", text: `Tools: linter=${t.linter}, formatter=${t.formatter}, line length ${t.lineLength}` });
    await startLsp().catch(() => {}); // start/stop ruff server as needed; re-lint open files on next edit
  };
  return (
    <Modal title="Linter & formatter" onClose={onClose} onEnter={apply}>
        <p className="muted">Tools are looked up in the kernel's environment first (<code>{python}</code>), then on PATH. pyright type checking is always on.</p>
        <div className="row"><label htmlFor="td-linter">Linter</label>
          <select id="td-linter" value={t.linter} onChange={(e) => setT({ ...t, linter: e.target.value as Linter })}>{LINTERS.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}</select>
          <span className="muted">{LINTERS.find((l) => l.id === t.linter)?.note}</span></div>
        <div className="row"><label htmlFor="td-largs">Linter args</label><input id="td-largs" value={t.linterArgs} onChange={(e) => setT({ ...t, linterArgs: e.target.value })} placeholder="e.g. --ignore E501,W503  or  --disable=C0114" /></div>
        <div className="row"><label htmlFor="td-fmt">Formatter</label>
          <select id="td-fmt" value={t.formatter} onChange={(e) => setT({ ...t, formatter: e.target.value as Formatter })}>{FORMATTERS.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}</select>
          <span className="muted">{FORMATTERS.find((f) => f.id === t.formatter)?.note}</span></div>
        <div className="row"><label htmlFor="td-fargs">Formatter args</label><input id="td-fargs" value={t.formatterArgs} onChange={(e) => setT({ ...t, formatterArgs: e.target.value })} placeholder="e.g. --skip-string-normalization" /></div>
        <div className="row"><label htmlFor="td-len">Line length</label><input id="td-len" className="small" type="number" min={60} max={200} value={t.lineLength} onChange={(e) => setT({ ...t, lineLength: Number(e.target.value) || 88 })} /><span className="muted">passed to flake8 / pylint / black / autopep8 (ruff reads pyproject.toml)</span></div>
        <div className="row buttons"><button className="primary" onClick={apply}>Apply</button><button onClick={onClose}>Cancel</button></div>
    </Modal>
  );
}
