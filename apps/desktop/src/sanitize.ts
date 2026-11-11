// All kernel-, file- and markdown-provided HTML goes through here before it
// touches the DOM. Notebook outputs render on *open*, so this is the line
// between "opened an untrusted .ipynb" and "ran its author's JavaScript".
import DOMPurify from "dompurify";

const cfg = {
  USE_PROFILES: { html: true, svg: true, svgFilters: true, mathMl: true },
  FORBID_TAGS: ["script", "iframe", "object", "embed", "form", "base", "meta", "link", "style"],
  FORBID_ATTR: ["srcdoc", "formaction"],
  ADD_ATTR: ["target"],
  ALLOW_UNKNOWN_PROTOCOLS: false,
};

// Links open outside the app; never inside the webview.
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

/** Sanitized HTML for dangerouslySetInnerHTML. */
export function safeHtml(html: unknown): { __html: string } {
  return { __html: DOMPurify.sanitize(String(html ?? ""), cfg) };
}
