'use strict';

const historyRoot = document.getElementById('history');
const empty = document.getElementById('empty');
const version = document.getElementById('version');
const testButton = document.getElementById('test');
const updateButton = document.getElementById('checkUpdate');

version.textContent = `v${chrome.runtime.getManifest().version}`;

function formatTime(value) {
  try {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    const now = new Date();
    const sameDay = date.getFullYear() === now.getFullYear()
      && date.getMonth() === now.getMonth()
      && date.getDate() === now.getDate();
    return sameDay
      ? date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
      : date.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  } catch {
    return '';
  }
}

function makeHistoryItem(record) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'history-item';

  const title = document.createElement('span');
  title.className = 'history-title';
  title.textContent = record.title || 'ChatGPT';

  const status = document.createElement('span');
  status.className = 'history-status';
  status.textContent = record.statusCode || '';

  const preview = document.createElement('span');
  preview.className = 'history-preview';
  preview.textContent = record.preview || 'Response finished.';

  const time = document.createElement('span');
  time.className = 'history-time';
  time.textContent = formatTime(record.completedAt);

  button.append(title, status, preview, time);
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      const result = await chrome.runtime.sendMessage({
        type: 'OPEN_RECENT_NOTIFICATION',
        conversationId: record.conversationId,
        conversationUrl: record.conversationUrl
      });
      if (result?.ok) window.close();
    } catch {}
    finally {
      button.disabled = false;
    }
  });
  return button;
}

async function loadHistory() {
  try {
    const result = await chrome.runtime.sendMessage({ type: 'GET_RECENT_NOTIFICATIONS' });
    const notifications = Array.isArray(result?.notifications) ? result.notifications.slice(0, 10) : [];
    historyRoot.replaceChildren();
    if (notifications.length === 0) {
      historyRoot.append(empty);
      return;
    }
    for (const record of notifications) historyRoot.append(makeHistoryItem(record));
  } catch {
    historyRoot.replaceChildren(empty);
  }
}

async function runTinyAction(button, message) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = '…';
  try {
    const result = await chrome.runtime.sendMessage(message);
    button.textContent = result?.ok ? '✓' : '!';
  } catch {
    button.textContent = '!';
  }
  setTimeout(() => {
    button.textContent = original;
    button.disabled = false;
  }, 900);
}

testButton.addEventListener('click', () => {
  runTinyAction(testButton, { type: 'TEST_NATIVE_TOAST' });
});

updateButton.addEventListener('click', () => {
  runTinyAction(updateButton, { type: 'CHECK_MANAGED_UPDATE' });
});

loadHistory();
