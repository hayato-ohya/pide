import { execute } from "../kernel";
import { useStore } from "../store";

export default function History() {
  const history = useStore((s) => s.history);
  return (
    <div className="history">
      {history
        .slice()
        .reverse()
        .map((h, i) => (
          <div key={i} className="history-item" title="Double-click to run again" onDoubleClick={() => execute(h)}>
            {h.split("\n")[0]}
            {h.includes("\n") ? " …" : ""}
          </div>
        ))}
    </div>
  );
}
