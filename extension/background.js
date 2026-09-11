'use strict';

// Keep the upstream-compatible service worker isolated from optional recovery.
// The recovery layer only observes existing browser traffic and local DOM state.
importScripts('service-worker.js', 'recovery-background.js');
