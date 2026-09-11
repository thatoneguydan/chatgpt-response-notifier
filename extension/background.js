'use strict';

// Keep Ram Haidar's upstream-compatible completion worker isolated from local
// policy/recovery/history layers. These layers observe browser/page state only;
// none creates ChatGPT HTTP traffic.
importScripts(
  'status-code.js',
  'service-worker.js',
  'recovery-background.js',
  'history-background.js'
);
