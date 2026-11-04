// Visibility helpers so background panels and a hidden window do not poll.
import { useEffect, useState } from "react";
import type { DockviewPanelApi } from "dockview";
import { dockApi } from "./layout";

/** True while the dockview panel is visible (its tab is active and the group is shown). */
export function usePanelVisible(api: DockviewPanelApi): boolean {
  const [visible, setVisible] = useState(api.isVisible);
  useEffect(() => {
    const d = api.onDidVisibilityChange((e) => setVisible(e.isVisible));
    return () => d.dispose();
  }, [api]);
  return visible;
}

/** True while the browser document is visible (window not minimised / hidden). */
export function usePageVisible(): boolean {
  const [visible, setVisible] = useState(document.visibilityState !== "hidden");
  useEffect(() => {
    const f = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", f);
    return () => document.removeEventListener("visibilitychange", f);
  }, []);
  return visible;
}

/** Whether any of the given dockview panel ids is currently visible. */
export function anyPanelVisible(ids: string[]): boolean {
  let api;
  try { api = dockApi(); } catch { return false; }
  if (!api) return false;
  return api.panels.some((p) => ids.includes(p.id) && p.api.isVisible);
}
