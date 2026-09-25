'use strict';

const UPDATE_ALARM = 'quick-continue-managed-update';
const UPDATE_URL = 'http://127.0.0.1:38473/quick-continue/update';
const CONTENT_FILES = [
  'dom-compat.js',
  'prompt-format.js',
  'config.js',
  'composer-text.js',
  'runtime-reset.js',
  'content-script.js',
  'hover-edit-script.js',
  'conversation-state.js'
];

function parseVersion(value) {
  const parts = String(value || '').split('.');
  if (parts.length < 2 || parts.length > 4) return null;
  const numbers = parts.map((part) => Number.parseInt(part, 10));
  if (numbers.some((part) => !Number.isInteger(part) || part < 0)) return null;
  return numbers;
}

function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return null;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const av = a[index] || 0;
    const bv = b[index] || 0;
    if (av !== bv) return av > bv ? 1 : -1;
  }
  return 0;
}

async function injectCurrentRuntimeIntoOpenTabs() {
  let tabs = [];
  try { tabs = await chrome.tabs.query({ url: ['https://chatgpt.com/*'] }); } catch { return; }

  for (const tab of tabs) {
    if (!Number.isInteger(tab?.id) || tab.discarded === true || tab.frozen === true) continue;
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: CONTENT_FILES
      });
    } catch {}
  }
}

async function checkManagedUpdate() {
  let response;
  try {
    response = await fetch(UPDATE_URL, { cache: 'no-store' });
  } catch {
    return false;
  }
  if (!response.ok) return false;

  let payload;
  try { payload = await response.json(); } catch { return false; }
  const installedVersion = String(payload?.installedVersion || '');
  const runningVersion = String(chrome.runtime.getManifest().version || '');
  const comparison = compareVersions(installedVersion, runningVersion);
  if (comparison === null || comparison === 0) return false;

  setTimeout(() => chrome.runtime.reload(), 200);
  return true;
}

function ensureUpdateAlarm() {
  try {
    chrome.alarms.create(UPDATE_ALARM, {
      delayInMinutes: 1,
      periodInMinutes: 15
    });
  } catch {}
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm?.name !== UPDATE_ALARM) return;
  checkManagedUpdate().catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  ensureUpdateAlarm();
  injectCurrentRuntimeIntoOpenTabs().catch(() => {});
  checkManagedUpdate().catch(() => {});
});

chrome.runtime.onInstalled.addListener(() => {
  ensureUpdateAlarm();
  injectCurrentRuntimeIntoOpenTabs().catch(() => {});
  checkManagedUpdate().catch(() => {});
});

ensureUpdateAlarm();
injectCurrentRuntimeIntoOpenTabs().catch(() => {});
checkManagedUpdate().catch(() => {});
