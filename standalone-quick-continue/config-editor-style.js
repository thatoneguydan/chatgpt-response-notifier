'use strict';

(() => {
  const STYLE_ID = 'chatgpt-quick-continue-config-editor-style';
  const previous = document.getElementById(STYLE_ID);
  if (previous) previous.remove();

  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
#chatgpt-quick-continue-toolbar [hidden] {
  display: none !important;
}
#chatgpt-quick-continue-simple-countdown {
  position: absolute;
  box-sizing: border-box;
  width: calc(100% + 2px);
  left: -1px;
  bottom: calc(100% + 4px);
  padding: 3px 4px;
  border: 1px solid var(--border-light, rgba(0,0,0,.14));
  border-radius: 6px;
  background: var(--main-surface-primary, #fff);
  color: #111;
  box-shadow: 0 1px 4px rgba(0,0,0,.14);
  font-size: 11px;
  line-height: 1.25;
  white-space: normal;
  overflow-wrap: anywhere;
  text-align: right;
  font-variant-numeric: tabular-nums;
}
#chatgpt-quick-continue-simple-countdown[hidden],
#chatgpt-quick-continue-toolbar[data-simple-watchdog-active="true"] [data-chatgpt-notifier-watchdog-status-owner] {
  display: none !important;
}
#chatgpt-quick-continue-toolbar [aria-label="Quick Continue menu popover"]:has(div:not([hidden]) > textarea[aria-label="Quick Continue JSON"]) {
  width: min(780px, calc(100vw - 32px)) !important;
  min-width: min(780px, calc(100vw - 32px)) !important;
  max-width: calc(100vw - 32px) !important;
}
#chatgpt-quick-continue-toolbar textarea[aria-label="Quick Continue JSON"] {
  width: 100% !important;
  max-width: 100% !important;
  height: min(560px, calc(100vh - 180px)) !important;
  min-height: min(560px, calc(100vh - 180px)) !important;
  caret-color: var(--text-primary, #000000) !important;
  color: var(--text-primary, #111111) !important;
}
#chatgpt-quick-continue-toolbar [aria-label="Quick Continue menu popover"]:has(div:not([hidden]) > textarea[aria-label="Quick Continue JSON"]) [role="alert"] {
  max-width: 100% !important;
}
`;
  (document.head || document.documentElement).append(style);

  globalThis.__chatgptQuickContinueConfigEditorStyle = Object.freeze({
    version: 2,
    styleId: STYLE_ID
  });
})();
