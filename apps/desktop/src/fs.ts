// File access that follows the kernel: local Tauri commands normally, the
// kernel's pide_kernel.fs_* helpers when the kernel runs on another machine.
import { invoke } from "@tauri-apps/api/core";
import { awaitReply } from "./kernel";
import { get } from "./store";
import { promptAsync } from "./dialogs";

export interface Entry { name: string; path: string; is_dir: boolean; size: number; modified: number | null }

export const isRemote = () => !!(get().remote || get().connectionFile);

/** Remote file access needs a live kernel; wait briefly for startup. */
async function waitKernel(timeoutMs = 60_000) {
  const t0 = Date.now();
  while (get().kernel !== "idle" && get().kernel !== "busy") {
    if (get().kernel === "dead" || Date.now() - t0 > timeoutMs) throw new Error("kernel not running (remote files need a running kernel)");
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function evalHelper(expr: string): Promise<any> {
  await waitKernel();
  const id = await invoke<string>("kernel_eval", { expr });
  const reply = await awaitReply(id, 60_000);
  const ue = reply.user_expressions?.eval;
  if (ue?.status === "error") throw new Error(`${ue.ename}: ${ue.evalue}`);
  const data = ue?.data?.["application/x-pide+json"];
  if (data?.error) throw new Error(data.error);
  return data;
}

export async function listDir(path: string): Promise<Entry[]> {
  if (!isRemote()) return invoke<Entry[]>("list_dir", { path });
  return (await evalHelper(`fs_list(${JSON.stringify(path)})`)).entries;
}

export async function readText(path: string): Promise<string> {
  if (!isRemote()) return invoke<string>("read_text_file", { path });
  return (await evalHelper(`fs_read(${JSON.stringify(path)})`)).text;
}

export async function writeText(path: string, content: string): Promise<void> {
  if (!isRemote()) return invoke("write_text_file", { path, content });
  const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(content)));
  await evalHelper(`fs_write(${JSON.stringify(path)}, ${JSON.stringify(b64)})`);
}

export async function homeDir(): Promise<string> {
  if (!isRemote()) return invoke<string>("home_dir");
  return (await evalHelper("fs_info()")).home;
}

/** cwd / home / host of the machine the kernel runs on. */
export async function kernelInfo(): Promise<{ cwd: string; home: string; host: string }> {
  if (!isRemote()) return { cwd: get().cwd ?? "", home: await invoke<string>("home_dir"), host: "local" };
  return evalHelper("fs_info()");
}

/** "Save as" path: native dialog locally, a prompt for remote kernels. */
export async function savePath(defaultName: string, filters: { name: string; extensions: string[] }[]): Promise<string | null> {
  if (!isRemote()) {
    const { save } = await import("@tauri-apps/plugin-dialog");
    return save({ defaultPath: defaultName, filters });
  }
  const base = get().cwd ?? "~";
  return promptAsync(`Save on ${get().remote?.host ?? "remote"} as:`, `${base.replace(/\/$/, "")}/${defaultName}`);
}
