'use strict';

const historyRoot = document.getElementById('history');
const empty = document.getElementById('empty');
const version = document.getElementById('version');
const testButton = document.getElementById('test');
const updateButton = document.getElementById('checkUpdate');
const automationToggle = document.getElementById('automationToggle');
const monitorDetail = document.getElementById('monitorDetail');
const monitorError = document.getElementById('monitorError');
const attentionSection = document.getElementById('attentionSection');
const attentionRoot = document.getElementById('attention');

version.textContent = `v${chrome.runtime.getManifest().version}`;

let verifiedAutomation = null;
let automationConfirmed = false;
let automationBusy = false;

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

function humanizeReason(value) {
  return String(value || '').replaceAll('-', ' ').trim();
}

function recoveryPauseReason(overview) {
  const recovery = overview?.recovery;
  if (recovery?.profile?.breakerOpen === true) return recovery.profile.breakerReason || 'recovery breaker open';
  if (Number(recovery?.humanRun?.generationActions || 0) >= 12) return 'run action limit reached';
  if (recovery?.incident?.state === 'attention') return recovery.incident.reason || 'recovery needs attention';
  return '';
}

function detailForOverview(overview) {
  if (!Number.isInteger(overview?.activeTabId)) return 'Open ChatGPT';
  if (overview.pausedByUser === true) return 'Paused by you';
  const guarded = recoveryPauseReason(overview);
  if (overview.automationEnabled === true && guarded) return `Paused — ${humanizeReason(guarded)}`;
  if (overview.automationEnabled === true) {
    const reason = overview?.run?.reason || overview?.run?.state || (overview.provisional ? 'waiting for the next request' : 'waiting for build work');
    return `Monitoring + recovery on — ${humanizeReason(reason)}`;
  }
  if (overview.provisional) return 'Ready — monitoring + recovery will attach to the next submitted request';
  if (!overview.activeConversationId) return 'Ready — monitor the next build request';
  return 'Ready — build work will enable automatically when recognized';
}

function buttonMode(overview) {
  if (!Number.isInteger(overview?.activeTabId)) return { label: 'Monitor', disabled: true, enabledClass: false, warningClass: false, desired: true, resume: false };
  if (overview.pausedByUser === true) return { label: 'Resume', disabled: false, enabledClass: false, warningClass: true, desired: true, resume: true };
  if (overview.automationEnabled === true && recoveryPauseReason(overview)) {
    return { label: 'Resume', disabled: false, enabledClass: true, warningClass: true, desired: true, resume: true };
  }
  if (overview.automationEnabled === true) return { label: 'Pause', disabled: false, enabledClass: true, warningClass: false, desired: false, resume: false };
  return { label: 'Monitor', disabled: false, enabledClass: false, warningClass: false, desired: true, resume: false };
}

function renderAttention(overview) {
  const attention = Array.isArray(overview?.attention) ? overview.attention.slice(0, 20) : [];
  attentionRoot.replaceChildren();
  for (const record of attention) attentionRoot.append(makeAttentionItem(record));
  attentionSection.hidden = attention.length === 0;
}

function showAutomationError(message) {
  monitorError.hidden = false;
  monitorError.textContent = message || 'Build automation state could not be verified.';
}

function clearAutomationError() {
  monitorError.hidden = true;
  monitorError.textContent = '';
}

function renderAutomation(overview, { confirmed = true } = {}) {
  const state = overview || verifiedAutomation;
  if (!state) {
    monitorDetail.textContent = 'Build automation state unavailable';
    automationToggle.textContent = 'Monitor';
    automationToggle.disabled = true;
    automationToggle.classList.remove('enabled', 'warning');
    attentionSection.hidden = true;
    return;
  }

  const mode = buttonMode(state);
  monitorDetail.textContent = `${detailForOverview(state)}${confirmed ? '' : ' · state unconfirmed'}`;
  automationToggle.textContent = mode.label;
  automationToggle.disabled = automationBusy || mode.disabled;
  automationToggle.classList.toggle('enabled', mode.enabledClass);
  automationToggle.classList.toggle('warning', mode.warningClass);
  renderAttention(state);
}

function normalizeOverview(result) {
  return {
    activeTabId: Number.isInteger(result?.activeTabId) ? result.activeTabId : null,
    activeConversationId: String(result?.activeConversationId || ''),
    activeConversationUrl: String(result?.activeConversationUrl || ''),
    automationEnabled: result?.automationEnabled === true,
    monitoring: result?.monitoring === true,
    recoveryEnabled: result?.recoveryEnabled === true,
    pausedByUser: result?.pausedByUser === true,
    stateRevision: Math.max(0, Number(result?.stateRevision || 0)),
    enrollmentSource: String(result?.enrollmentSource || ''),
    provisional: result?.provisional === true,
    run: result?.run || null,
    recovery: result?.recovery || null,
    attention: Array.isArray(result?.attention) ? result.attention : [],
    profile: result?.profile || null,
    helperConnected: result?.helperConnected === true
  };
}

async function loadAutomationOverview({ preserveOnFailure = true } = {}) {
  try {
    const result = await chrome.runtime.sendMessage({ type: 'GET_BUILD_AUTOMATION_OVERVIEW' });
    if (!result?.ok) throw new Error(result?.error || 'Build automation overview unavailable.');
    const next = normalizeOverview(result);
    if (next.automationEnabled !== next.recoveryEnabled || next.automationEnabled !== next.monitoring) {
      throw new Error('Build automation state is inconsistent; monitoring and recovery must match.');
    }
    verifiedAutomation = next;
    automationConfirmed = true;
    clearAutomationError();
    renderAutomation(next, { confirmed: true });
    return next;
  } catch (error) {
    automationConfirmed = false;
    showAutomationError(String(error?.message || error || 'Build automation state unavailable.'));
    if (!preserveOnFailure) verifiedAutomation = null;
    renderAutomation(verifiedAutomation, { confirmed: false });
    return null;
  }
}

async function setBuildAutomation() {
  if (automationBusy || !verifiedAutomation || !Number.isInteger(verifiedAutomation.activeTabId)) return;
  const mode = buttonMode(verifiedAutomation);
  const requestId = crypto.randomUUID();
  const before = verifiedAutomation;
  automationBusy = true;
  automationToggle.disabled = true;
  clearAutomationError();

  try {
    const result = await chrome.runtime.sendMessage({
      type: 'SET_BUILD_AUTOMATION_STATE',
      enabled: mode.desired,
      resumeExistingRun: mode.resume,
      tabId: before.activeTabId,
      conversationId: before.activeConversationId,
      expectedRevision: before.stateRevision,
      requestId
    });
    if (!result?.ok) throw new Error(result?.error || result?.reason || 'Build automation change was rejected.');
    if (String(result.requestId || '') !== requestId) throw new Error('Build automation confirmation did not match this request.');

    const next = normalizeOverview(result);
    const expectedEnabled = mode.desired === true;
    if (next.automationEnabled !== expectedEnabled || next.recoveryEnabled !== expectedEnabled || next.monitoring !== expectedEnabled) {
      throw new Error('Build automation write could not be verified from readback.');
    }
    if (mode.desired === false && next.pausedByUser !== true) throw new Error('Pause was not persisted as an operator override.');
    if (next.stateRevision <= before.stateRevision) throw new Error('Build automation revision did not advance.');

    verifiedAutomation = next;
    automationConfirmed = true;
    renderAutomation(next, { confirmed: true });
  } catch (error) {
    automationConfirmed = false;
    showAutomationError(String(error?.message || error || 'Build automation change failed.'));
    renderAutomation(verifiedAutomation, { confirmed: false });
    // Reconcile an unknown outcome. A successful committed write may have lost
    // its response, so never invert the previous boolean or blindly retry it.
    await loadAutomationOverview({ preserveOnFailure: true });
  } finally {
    automationBusy = false;
    renderAutomation(verifiedAutomation, { confirmed: automationConfirmed });
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

automationToggle.addEventListener('click', setBuildAutomation);

Promise.all([loadHistory(), loadAutomationOverview({ preserveOnFailure: false })]).catch(() => {});
