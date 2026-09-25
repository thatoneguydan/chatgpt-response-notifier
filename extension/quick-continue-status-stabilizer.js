'use strict';

(() => {
  const STYLE_ID = 'chatgpt-notifier-quick-status-stabilizer-v1';
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    #chatgpt-quick-continue-toolbar [id^="chatgpt-notifier-countdown-v"],
    #chatgpt-quick-continue-toolbar #chatgpt-notifier-automation-status {
      display: none !important;
    }
    #chatgpt-quick-continue-toolbar[data-chatgpt-notifier-last-status]::after {
      content: none !important;
      display: none !important;
    }
  `;
  (document.head || document.documentElement).append(style);
})();