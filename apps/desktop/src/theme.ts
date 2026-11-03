// Light / dark / system theme, applied as data-theme on <html> and mirrored to Monaco, dockview and plotly.
import * as monaco from "monaco-editor";
import { set, useStore } from "./store";

export type ThemePref = "light" | "dark" | "system";
const media = window.matchMedia("(prefers-color-scheme: dark)");

export function effectiveTheme(pref: ThemePref): "light" | "dark" {
  return pref === "system" ? (media.matches ? "dark" : "light") : pref;
}

export function applyTheme(pref: ThemePref) {
  const eff = effectiveTheme(pref);
  document.documentElement.setAttribute("data-theme", eff);
  monaco.editor.setTheme(eff === "dark" ? "vs-dark" : "vs");
  localStorage.setItem("pide.theme", pref);
  set({ themePref: pref, theme: eff });
}

export function initTheme() {
  const pref = (localStorage.getItem("pide.theme") as ThemePref | null) ?? "system";
  applyTheme(pref);
  media.addEventListener("change", () => { const p = (localStorage.getItem("pide.theme") as ThemePref | null) ?? "system"; if (p === "system") applyTheme("system"); });
}

export const useTheme = () => useStore((s) => s.theme);

/** Plotly layout fragment that follows the current theme. */
export function plotlyTheme(): Record<string, unknown> {
  const dark = document.documentElement.getAttribute("data-theme") === "dark";
  const css = getComputedStyle(document.documentElement);
  const text = css.getPropertyValue("--text").trim() || (dark ? "#e6e6e6" : "#1e1e1e");
  const grid = dark ? "#3a3a42" : "#e5e5e5";
  return {
    paper_bgcolor: "rgba(0,0,0,0)",
    plot_bgcolor: dark ? "#1e1e23" : "#ffffff",
    font: { color: text },
    xaxis: { gridcolor: grid, zerolinecolor: grid },
    yaxis: { gridcolor: grid, zerolinecolor: grid },
    template: dark ? "plotly_dark" : "plotly",
  };
}
