'use strict';

importScripts('page-runtime-compat-background.js');
importScripts('background.js');
importScripts('quick-continue-monitor-bridge-background.js');
importScripts('recovery-refresh-policy-background.js');

if (!globalThis.__chatgptNotifierBootstrapFailure) {
  try {
    importScripts('last-mile-toast-dedupe-background.js');
  } catch (error) {
    try {
      if (typeof sendNative === 'function') {
        sendNative({
          type: 'diagnostics.event',
          diagnostic: {
            source: 'last-mile-toast-dedupe',
            status: 'dedupe-import-failed',
            observedAt: new Date().toISOString(),
            extensionVersion: String(chrome.runtime.getManifest().version || ''),
            reason: String(error?.message || error || 'import-failed').replace(/[\r\n\t]+/g, ' ').slice(0, 96)
          }
        });
      }
    } catch {}
  }

  try {
    importScripts('cross-desktop-click-fallback-background.js');
  } catch (error) {
    try {
      if (typeof sendNative === 'function') {
        sendNative({
          type: 'diagnostics.event',
          diagnostic: {
            source: 'toast-click',
            status: 'cross-desktop-fallback-import-failed',
            observedAt: new Date().toISOString(),
            extensionVersion: String(chrome.runtime.getManifest().version || ''),
            reason: String(error?.message || error || 'import-failed').replace(/[\r\n\t]+/g, ' ').slice(0, 96)
          }
        });
      }
    } catch {}
  }

  try {
    importScripts('recovery-decision-diagnostics-background.js');
  } catch (error) {
    try {
      if (typeof sendNative === 'function') {
        sendNative({
          type: 'diagnostics.event',
          diagnostic: {
            source: 'recovery-decision',
            status: 'diagnostics-import-failed',
            observedAt: new Date().toISOString(),
            extensionVersion: String(chrome.runtime.getManifest().version || ''),
            reason: String(error?.message || error || 'import-failed').replace(/[\r\n\t]+/g, ' ').slice(0, 96)
          }
        });
      }
    } catch {}
  }

  try {
    importScripts('hidden-window-diagnostics-background.js');
  } catch (error) {
    try {
      if (typeof sendNative === 'function') {
        sendNative({
          type: 'diagnostics.event',
          diagnostic: {
            source: 'hidden-window-diagnostics',
            status: 'worker-diagnostics-import-failed',
            observedAt: new Date().toISOString(),
            extensionVersion: String(chrome.runtime.getManifest().version || ''),
            reason: String(error?.message || error || 'import-failed').replace(/[\r\n\t]+/g, ' ').slice(0, 96)
          }
        });
      }
    } catch {}
  }
}
