// Async replacements for window.confirm / window.prompt, which the Tauri
// webview does not implement synchronously (confirm returns a Promise, prompt null).
import { ask } from "@tauri-apps/plugin-dialog";
import { set } from "./store";

export function confirmAsync(message: string, title = "Pide"): Promise<boolean> {
  return ask(message, { title, kind: "warning", okLabel: "OK", cancelLabel: "Cancel" }).catch(() => false);
}

/** In-app text prompt rendered by <PromptDialog/>; resolves null on cancel. */
export function promptAsync(message: string, defaultValue = "", placeholder = ""): Promise<string | null> {
  return new Promise((resolve) => set({ promptReq: { message, value: defaultValue, placeholder, resolve } }));
}
