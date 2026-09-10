'use strict';

const testButton = document.getElementById('test');
const updateButton = document.getElementById('checkUpdate');
const status = document.getElementById('status');
const updateStatus = document.getElementById('updateStatus');
const captureStatus = document.getElementById('captureStatus');
const captureHistory = document.getElementById('captureHistory');

function formatUpdateState(value) {
  if (!value || typeof value !== 'object') return 'Managed updates: waiting for helper status.';
  switch (value.state) {
    case 'waiting': return 'Managed updates: waiting for first background check.';
    case 'checking': return 'Managed updates: checking silently...';
    case 'current': return `Managed updates: current (${value.currentVersion || chrome.runtime.getManifest().version}).`;
    case 'downloading': return `Managed updates: downloading ${value.availableVersion || ''} silently...`;
    case 'installing': return `Managed updates: installing ${value.availableVersion || ''}...`;
    case 'installed': return `Managed updates: installed ${value.currentVersion || value.availableVersion || ''}; reloading extension.`;
    case 'error': return `Managed update error: ${value.error || 'unknown error'}`;
    default: return `Managed updates: ${value.state || 'unknown state'}.`;
  }
}

function formatCaptureLine(capture) {
  if (!capture || typeof capture !== 'object') return 'none';
  return `${capture.status || 'unknown'}; ${capture.responseLength || 0} chars; source ${capture.captureSource || 'none'}; turn ${capture.turnTextLength || 0}; surfaces ${capture.responseSurfaceCount || 0}/${capture.responseSurfaceTextLength || 0}; assistant nodes ${capture.assistantRoleNodeCount || 0}/${capture.assistantRoleTextLength || 0}; render ${capture.renderSignatureLength || 0}; streaming ${capture.generationActive ? 'yes' : 'no'}; streaming seen ${capture.generationObserved ? 'yes' : 'no'}; result streaming ${capture.resultStreamingActive ? 'yes' : 'no'}; final marker ${capture.finalActionKind || 'none'}; ${capture.elapsedMs || 0} ms.`;
}

function formatHistoryLine(capture, index) {
  const observedAt = capture?.observedAt ? new Date(capture.observedAt) : null;
  const time = observedAt && !Number.isNaN(observedAt.getTime())
    ? observedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : 'time unknown';
  const context = capture?.projectContext ? 'project' : 'chat';
  return `${index + 1}. ${time} · ${context} · ${formatCaptureLine(capture)}`;
}

async function refreshHostStatus() {
  status.textContent = 'Checking Windows helper...';
  try {
    const result = await chrome.runtime.sendMessage({ type: 'PING_NATIVE_HOST' });
    if (result?.ok) {
      status.textContent = `Windows helper connected over localhost. Extension ${chrome.runtime.getManifest().version}.`;
      updateStatus.textContent = formatUpdateState(result.updateStatus);
    } else {
      status.textContent = 'Windows helper is not running. Re-run the ChatGPT Response Notifier installer.';
      updateStatus.textContent = 'Managed updates unavailable until the helper is running.';
    }
  } catch (error) {
    status.textContent = `Helper check failed: ${error.message}`;
    updateStatus.textContent = 'Managed update status unavailable.';
  }
}

async function refreshCaptureStatus() {
  captureStatus.textContent = 'Last capture: checking current ChatGPT tab...';
  captureHistory.textContent = '';
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (typeof tab?.id !== 'number' || !String(tab.url || '').startsWith('https://chatgpt.com/')) {
      captureStatus.textContent = 'Last capture: open a ChatGPT tab to inspect.';
      return;
    }
    const result = await chrome.tabs.sendMessage(tab.id, { type: 'GET_CHATGPT_CAPTURE_DIAGNOSTIC' });
    const capture = result?.capture;
    if (!capture) {
      captureStatus.textContent = 'Last capture: none recorded in this tab yet.';
      return;
    }
    captureStatus.textContent = `Last capture: ${formatCaptureLine(capture)}`;
    const history = Array.isArray(result?.history) ? result.history : [capture];
    if (history.length > 1) {
      captureHistory.textContent = `Recent captures (newest first):\n${history.slice(0, 8).map(formatHistoryLine).join('\n')}`;
    }
  } catch {
    captureStatus.textContent = 'Last capture: unavailable for the current tab.';
  }
}

testButton.addEventListener('click', async () => {
  testButton.disabled = true;
  status.textContent = 'Checking helper and sending test toast...';
  try {
    const result = await chrome.runtime.sendMessage({ type: 'TEST_NATIVE_TOAST' });
    status.textContent = result?.ok
      ? 'Native toast + completion chime created.'
      : `Test failed: ${result?.error || 'unknown error'}`;
  } catch (error) {
    status.textContent = `Test failed: ${error.message}`;
  } finally {
    testButton.disabled = false;
  }
});

updateButton.addEventListener('click', async () => {
  updateButton.disabled = true;
  updateStatus.textContent = 'Managed updates: checking silently...';
  try {
    const result = await chrome.runtime.sendMessage({ type: 'CHECK_MANAGED_UPDATE' });
    updateStatus.textContent = result?.ok
      ? formatUpdateState(result.updateStatus)
      : `Managed update check failed: ${result?.error || 'unknown error'}`;
  } catch (error) {
    updateStatus.textContent = `Managed update check failed: ${error.message}`;
  } finally {
    updateButton.disabled = false;
  }
});

refreshHostStatus();
refreshCaptureStatus();
