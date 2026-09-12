'use strict';

const historyRoot = document.getElementById('history');
const empty = document.getElementById('empty');
const version = document.getElementById('version');
const testButton = document.getElementById('test');
const updateButton = document.getElementById('checkUpdate');
const monitorToggle = document.getElementById('monitorToggle');
const monitorDetail = document.getElementById('monitorDetail');
const attentionSection = document.getElementById('attentionSection');
const attentionRoot = document.getElementById('attention');

version.textContent = `v${chrome.runtime.getManifest().version}`;
let activeMonitoring = false;

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

async function openConversation(record) {
  try {
    const result = await chrome.runtime.sendMessage({
      type: 'OPEN_RECENT_NOTIFICATION',
      conversationId: record.conversationId,
      conversationUrl: record.conversationUrl
    });
    if (result?.ok) window.close();
    return result?.ok === true;
  } catch {
    return false;
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
    try { await openConversation(record); }
    finally { button.disabled = false; }
  });
  return button;
}

function makeAttentionItem(record) {
  const row = document.createElement('div');
  row.className = 'attention-item';

  const copy = document.createElement('div');
  copy.className = 'attention-copy';
  copy.tabIndex = 0;
  copy.setAttribute('role', 'button');

  const title = document.createElement('span');
  title.className = 'attention-title';
  title.textContent = record.title || 'ChatGPT';

  const reason = document.createElement('span');
  reason.className = 'attention-reason';
  reason.textContent = record.reason || 'attention-required';

  const preview = document.createElement('span');
  preview.className = 'attention-preview';
  preview.textContent = record.preview || 'This monitored build needs attention.';

  copy.append(title, reason, preview);
  const open = () => openConversation(record);
  copy.addEventListener('click', open);
  copy.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      open();
    }
  });

  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.className = 'mini dismiss';
  dismiss.title = 'Acknowledge this attention item';
  dismiss.textContent = '×';
  dismiss.addEventListener('click', async () => {
    dismiss.disabled = true;
    try {
      const result = await chrome.runtime.sendMessage({ type: 'ACK_RECOVERY_ATTENTION', attentionId: record.attentionId });
      if (result?.ok) row.remove();
      if (!attentionRoot.querySelector('.attention-item')) attentionSection.hidden = true;
    } catch {}
    finally { dismiss.disabled = false; }
  });

  row.append(copy, dismiss);
  return row;
}

async function loadHistory() {
  try {
    const result = await chrome.runtime.sendMessage({ type: 'GET_RECENT_NOTIFICATIONS' });
    const notifications = Array.isArray(result?.notifications) ? result.notifications.slice(0, 20) : [];
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

function monitorDescription(overview) {
  if (!overview?.activeConversationId) return 'Open a ChatGPT conversation';
  if (!overview.monitoring) return 'Off for this conversation';
  const run = overview.run;
  if (!run) return 'On — waiting for the next request';
  const reason = String(run.reason || run.state || 'observing').replaceAll('-', ' ');
  return `On — ${reason}`;
}

async function loadMonitorOverview() {
  try {
    const overview = await chrome.runtime.sendMessage({ type: 'GET_MONITOR_OVERVIEW' });
    if (!overview?.ok) throw new Error(overview?.error || 'Monitor overview unavailable.');
    activeMonitoring = overview.monitoring === true;
    monitorToggle.disabled = !overview.activeConversationId;
    monitorToggle.textContent = activeMonitoring ? 'Stop' : 'Monitor';
    monitorDetail.textContent = monitorDescription(overview);

    const attention = Array.isArray(overview.attention) ? overview.attention.slice(0, 20) : [];
    attentionRoot.replaceChildren();
    for (const record of attention) attentionRoot.append(makeAttentionItem(record));
    attentionSection.hidden = attention.length === 0;
  } catch {
    monitorToggle.disabled = true;
    monitorDetail.textContent = 'Monitoring state unavailable';
    attentionSection.hidden = true;
  }
}

async function runTinyAction(button, message) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = '…';
  try {
    const result = await chrome.runtime.sendMessage(message);
    button.textContent = result?.ok ? '✓' : '!';
    return result;
  } catch {
    button.textContent = '!';
    return null;
  } finally {
    setTimeout(() => {
      button.textContent = original;
      button.disabled = false;
    }, 900);
  }
}

testButton.addEventListener('click', () => {
  runTinyAction(testButton, { type: 'TEST_NATIVE_TOAST' });
});

updateButton.addEventListener('click', () => {
  runTinyAction(updateButton, { type: 'CHECK_MANAGED_UPDATE' });
});

monitorToggle.addEventListener('click', async () => {
  monitorToggle.disabled = true;
  const desired = !activeMonitoring;
  try {
    const result = await chrome.runtime.sendMessage({ type: 'SET_ACTIVE_CHAT_MONITORING', enabled: desired });
    if (result?.ok) activeMonitoring = result.monitoring === true;
  } catch {}
  await loadMonitorOverview();
});

Promise.all([loadHistory(), loadMonitorOverview()]).catch(() => {});
