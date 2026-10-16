/** Styles for the Shadow-DOM panel. Colors follow GitHub's Primer CSS variables so light/dark themes match. */
export const PANEL_CSS = `
:host { all: initial; }
.panel {
  position: fixed; right: 16px; bottom: 16px; z-index: 2147483000;
  width: 340px; max-height: 72vh; display: flex; flex-direction: column;
  font: 12px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif;
  color: var(--fgColor-default, #1f2328);
  background: var(--bgColor-default, #ffffff);
  border: 1px solid var(--borderColor-default, #d1d9e0);
  border-radius: 12px;
  box-shadow: var(--shadow-floating-large, 0 8px 24px rgba(66, 74, 83, 0.2));
  overflow: hidden;
}
:host(.collapsed) .panel { width: auto; }
.header { display: flex; align-items: center; gap: 8px; padding: 8px 10px; cursor: pointer; user-select: none;
  border-bottom: 1px solid var(--borderColor-muted, #d1d9e0b3); }
:host(.collapsed) .header { border-bottom: 0; }
.badge { color: var(--fgColor-muted, #59636e); }
.spacer { flex: 1; }
.body { overflow: auto; padding: 10px; display: flex; flex-direction: column; gap: 10px; }
.body[hidden] { display: none; }
.sections { display: flex; flex-direction: column; gap: 10px; }
input[type=search], textarea {
  width: 100%; box-sizing: border-box; font: 12px ui-monospace, SFMono-Regular, Menlo, monospace;
  color: inherit; background: var(--bgColor-default, #fff);
  border: 1px solid var(--borderColor-default, #d1d9e0); border-radius: 6px; padding: 5px 8px;
}
textarea { resize: vertical; margin: 6px 0; }
input[type=search]:focus, textarea:focus { outline: 2px solid var(--focus-outlineColor, #0969da); outline-offset: -1px; }
button {
  font: inherit; color: inherit; cursor: pointer; padding: 2px 8px; border-radius: 6px; white-space: nowrap;
  background: var(--button-default-bgColor-rest, #f6f8fa); border: 1px solid var(--borderColor-default, #d1d9e0);
}
button:hover { background: var(--button-default-bgColor-hover, #eff2f5); }
button.primary { background: var(--button-primary-bgColor-rest, #1f883d); color: var(--button-primary-fgColor-rest, #fff); border-color: transparent; }
button.icon { border: 0; background: transparent; padding: 0 4px; font-size: 14px; }
.row { display: flex; align-items: center; gap: 6px; }
.jev .row { flex-wrap: wrap; }
.jev .note { white-space: nowrap; }
.field { display: grid; grid-template-columns: 52px 1fr; column-gap: 8px; align-items: baseline; }
.field > .label { line-height: 22px; }
.jev { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.label, summary { font-weight: 600; color: var(--fgColor-muted, #59636e); }
summary { cursor: pointer; }
.chips { display: flex; flex-wrap: wrap; gap: 4px; }
.chip { border-radius: 12px; padding: 0 8px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.chip.on { background: var(--bgColor-accent-muted, #ddf4ff); border-color: var(--borderColor-accent-emphasis, #0969da); }
.chip.off { text-decoration: line-through; opacity: 0.6; }
.count { color: var(--fgColor-muted, #59636e); font-weight: 400; }
.note { color: var(--fgColor-muted, #59636e); }
.error { color: var(--fgColor-danger, #d1242f); overflow-wrap: anywhere; }
a { color: var(--fgColor-accent, #0969da); }
progress { flex: 1; }
.list { list-style: none; margin: 6px 0 0; padding: 0; max-height: 240px; overflow: auto;
  border: 1px solid var(--borderColor-muted, #d1d9e0b3); border-radius: 6px; }
.list li { padding: 4px 6px; border-top: 1px solid var(--borderColor-muted, #d1d9e0b3); }
.list li:first-child { border-top: 0; }
.list .path { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; text-align: left; }
.list .reason { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
`;
