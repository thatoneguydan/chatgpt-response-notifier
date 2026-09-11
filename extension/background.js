'use strict';

// Keep the upstream-compatible service worker isolated from optional local layers.
// Recovery and popup history observe existing browser/page events only; neither
// creates ChatGPT HTTP traffic.
importScripts('service-worker.js', 'recovery-background.js', 'history-background.js');
