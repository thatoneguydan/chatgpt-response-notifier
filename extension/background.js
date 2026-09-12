'use strict';

// Keep Ram Haidar's upstream-compatible completion worker isolated from local
// policy/recovery/history layers. These layers observe browser/page state only;
// none creates ChatGPT HTTP traffic.
importScripts(
  'status-code.js',
  'status-policy.js',
  'recovery-model.js',
  'coordinator-background.js',
  'recovery-background.js',
  'history-background.js',
  'monitor-background.js',
  'recovery-control-background.js',
  'bounded-recovery-background.js',
  'bounded-recovery-attachment-background.js',
  'service-worker.js',
  'normal-continuation-budget-hook.js'
);
