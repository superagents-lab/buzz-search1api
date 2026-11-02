// One stylesheet, added to <head> inside ctx.effect and removed by its cleanup. Surfaces,
// text and borders come from the host's theme tokens, so light and dark follow Settings →
// Appearance. The accent is the host's own (--accent-9). Every var() has a fallback in case
// a later host drops a token.
export const CSS = /* css */ `
.s1b-root {
  --s1b-ink: var(--text-standard, #e9eef4);
  --s1b-muted: var(--text-metadata, #8290a0);
  --s1b-card: var(--surface-panel, #12161c);
  --s1b-line: var(--border-standard, #2b333d);
  --s1b-hover: var(--affordance-row-hover, rgba(128, 140, 160, 0.14));
  --s1b-accent: var(--accent-9, #0a7cff);
  --s1b-mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace;
  display: flex; flex-direction: column; gap: 12px; max-width: 640px; color: var(--s1b-ink); line-height: 1.5;
}
.s1b-root p { margin: 0; }
.s1b-root code { font-family: var(--s1b-mono); font-size: 0.92em; }
.s1b-root a { color: var(--s1b-accent); text-decoration: none; }
.s1b-root a:hover { text-decoration: underline; }
.s1b-root :focus-visible { outline: 2px solid var(--border-focus, var(--s1b-accent)); outline-offset: 2px; }
.s1b-muted { color: var(--s1b-muted); }
.s1b-form { display: flex; flex-direction: column; gap: 8px; }
.s1b-form label { font-weight: 500; }
.s1b-form input { height: 30px; padding: 0 8px; border: 1px solid var(--s1b-line); border-radius: 6px;
  background: var(--s1b-card); color: var(--s1b-ink); font: inherit; color-scheme: inherit; }
.s1b-form input:hover { border-color: color-mix(in srgb, var(--s1b-accent) 50%, var(--s1b-line)); }
.s1b-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.s1b-button { display: inline-flex; align-items: center; height: 30px; padding: 0 12px; border: 1px solid var(--s1b-line);
  border-radius: 6px; background: transparent; color: var(--s1b-ink); font: inherit; font-weight: 500; cursor: pointer; }
.s1b-button:hover:not(:disabled) { background: var(--s1b-hover); }
.s1b-button[data-primary] { border-color: var(--s1b-accent); background: var(--s1b-accent); color: var(--accent-contrast, #fff); }
.s1b-button[data-primary]:hover:not(:disabled) { background: color-mix(in srgb, var(--s1b-accent) 85%, #000); }
.s1b-button:disabled { opacity: 0.5; cursor: default; }
.s1b-code { display: block; padding: 8px 10px; border: 1px solid var(--s1b-line); border-radius: 6px; background: var(--s1b-card);
  overflow-x: auto; white-space: pre; }
.s1b-root [data-tone="error"] { color: var(--red-11, #ff6369); }
.s1b-root [data-tone="ok"] { color: var(--green-11, #3dd68c); }
`;
