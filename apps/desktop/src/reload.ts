// Re-sync open editors / notebooks with the files on disk (window focus, git operations).
// Each file panel registers a checker that decides whether to reload silently, ask, or do nothing.
export const reloaders = new Map<string, () => Promise<void>>();

let running: Promise<void> | null = null;

export function reloadOpenFiles(): Promise<void> {
  if (running) return running;
  running = (async () => {
    for (const f of [...reloaders.values()]) {
      try { await f(); } catch { /* unreadable / deleted: keep the buffer */ }
    }
  })().finally(() => { running = null; });
  return running;
}
