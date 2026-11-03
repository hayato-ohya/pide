import React from "react";
import ReactDOM from "react-dom/client";
import "dockview/dist/styles/dockview.css";
import "./styles.css";
import App from "./App";
import { initTheme } from "./theme";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";

(self as any).MonacoEnvironment = { getWorker: () => new editorWorker() };
initTheme();
if (import.meta.env.DEV) import("monaco-editor").then((m) => ((window as any).monaco = m)); // dev hook

ReactDOM.createRoot(document.getElementById("root")!).render(
  <App />,
);
