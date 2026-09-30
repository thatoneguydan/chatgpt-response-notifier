'use strict';

(() => {
  const STYLE_ID = 'chatgpt-quick-continue-config-editor-style';
  const previous = document.getElementById(STYLE_ID);
  if (previous) previous.remove();

  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
#chatgpt-quick-continue-toolbar [aria-label="Project Continue"]:has(div:not([hidden]) > textarea[aria-label="Quick Continue JSON"]) {
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
#chatgpt-quick-continue-toolbar [aria-label="Project Continue"]:has(div:not([hidden]) > textarea[aria-label="Quick Continue JSON"]) [role="alert"] {
  max-width: 100% !important;
}
`;
  (document.head || document.documentElement).append(style);

  globalThis.__chatgptQuickContinueConfigEditorStyle = Object.freeze({
    version: 1,
    styleId: STYLE_ID
  });
})();
