from pathlib import Path

worker_path = Path('extension/service-worker.js')
worker = worker_path.read_text(encoding='utf-8')


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected exactly one match, found {count}')
    return text.replace(old, new, 1)


worker = replace_once(
    worker,
    "const SERVER_CAPTURE_RETRY_DELAYS_MS = [100, 350, 900, 1800, 3000];",
    "const SERVER_CAPTURE_RETRY_DELAYS_MS = [100, 350, 900, 1800, 3000];\nconst SERVER_CAPTURE_START_WATCH_DELAYS_MS = [1000, 1500, 2500, 4000, 6000, 8000, 10000, 12000, 15000];\nconst SERVER_CAPTURE_START_WATCH_TIMEOUT_MS = 30 * 60 * 1000;\nconst SERVER_CAPTURE_DIAGNOSTIC_HISTORY_LIMIT = 12;",
    'watch constants'
)
worker = replace_once(
    worker,
    "const answerRequestContexts = new Map();",
    "const answerRequestContexts = new Map();\nconst answerRequestWatches = new Map();\nconst answerRequestWatchIdsByTab = new Map();\nconst completedAnswerRequestIds = new Set();\nlet backgroundCaptureHistory = [];",
    'watch state'
)
worker = replace_once(
    worker,
    "function isAnswerStreamRequest(details) {\n  if (details.tabId < 0 || details.method !== 'POST') return false;\n  try {\n    const path = new URL(details.url).pathname.replace(/\\/+$/, '');\n    return path === '/backend-api/f/conversation' || path === '/backend-api/conversation';\n  } catch {\n    return false;\n  }\n}",
    "function answerRequestPath(details) {\n  try {\n    return new URL(details?.url || '').pathname.replace(/\\/+$/, '');\n  } catch {\n    return '';\n  }\n}\n\nfunction isAnswerStartRequest(details) {\n  if (details.tabId < 0 || details.method !== 'POST') return false;\n  const path = answerRequestPath(details);\n  return path === '/backend-api/f/conversation' ||\n    path === '/backend-api/conversation' ||\n    path === '/backend-api/f/conversation/prepare';\n}\n\nfunction isAnswerStreamRequest(details) {\n  if (details.tabId < 0 || details.method !== 'POST') return false;\n  const path = answerRequestPath(details);\n  return path === '/backend-api/f/conversation' || path === '/backend-api/conversation';\n}",
    'request classification'
)
worker = replace_once(
    worker,
    "function boundedRequestContextCache() {\n  while (answerRequestContexts.size > 100) {\n    const oldest = answerRequestContexts.keys().next().value;\n    if (!oldest) break;\n    answerRequestContexts.delete(oldest);\n  }\n}",
    "function boundedRequestContextCache() {\n  while (answerRequestContexts.size > 100) {\n    const oldest = answerRequestContexts.keys().next().value;\n    if (!oldest) break;\n    answerRequestContexts.delete(oldest);\n  }\n}\n\nfunction recordBackgroundCapture(status, details = {}) {\n  const diagnostic = {\n    status: String(status || 'unknown'),\n    observedAt: new Date().toISOString(),\n    ...details\n  };\n  backgroundCaptureHistory = [diagnostic, ...backgroundCaptureHistory]\n    .slice(0, SERVER_CAPTURE_DIAGNOSTIC_HISTORY_LIMIT);\n}\n\nfunction rememberCompletedAnswerRequest(requestId) {\n  const value = String(requestId || '');\n  if (!value) return;\n  completedAnswerRequestIds.add(value);\n  while (completedAnswerRequestIds.size > 100) {\n    const oldest = completedAnswerRequestIds.values().next().value;\n    if (!oldest) break;\n    completedAnswerRequestIds.delete(oldest);\n  }\n}",
    'diagnostic helpers'
)
worker = replace_once(
    worker,
    "function captureAnswerRequestContext(details) {\n  if (!isAnswerStreamRequest(details)) return;\n  answerRequestContexts.set(String(details.requestId), {\n    tabId: details.tabId,\n    startedAt: Number(details.timeStamp) || Date.now(),\n    headers: captureRequestHeaders(details.requestHeaders)\n  });\n  boundedRequestContextCache();\n}",
    "function captureAnswerRequestContext(details) {\n  if (!isAnswerStartRequest(details)) return;\n  const requestId = String(details.requestId || '');\n  const context = {\n    tabId: details.tabId,\n    startedAt: Number(details.timeStamp) || Date.now(),\n    headers: captureRequestHeaders(details.requestHeaders),\n    triggerPath: answerRequestPath(details)\n  };\n  answerRequestContexts.set(requestId, context);\n  boundedRequestContextCache();\n  recordBackgroundCapture('request-start-observed', {\n    tabId: details.tabId,\n    triggerPath: context.triggerPath\n  });\n  watchAnswerRequestFromStart(details, context).catch((error) => {\n    recordBackgroundCapture('request-start-watch-error', {\n      tabId: details.tabId,\n      triggerPath: context.triggerPath,\n      error: String(error?.message || error)\n    });\n    console.warn('Request-start ChatGPT completion watch failed', error);\n  });\n}",
    'request start arm'
)
worker = replace_once(
    worker,
    "async function readCompletedConversation(identity, context) {",
    "async function readCompletedConversation(identity, context, retryDelays = SERVER_CAPTURE_RETRY_DELAYS_MS) {",
    'read signature'
)
worker = replace_once(
    worker,
    "  for (const delayMs of SERVER_CAPTURE_RETRY_DELAYS_MS) {",
    "  for (const delayMs of retryDelays) {",
    'read delays'
)

anchor = "async function handleCompletedAnswerRequest(details) {"
watch_code = '''function cancelAnswerRequestWatch(requestId) {
  const key = String(requestId || '');
  const watch = answerRequestWatches.get(key);
  if (!watch) return;
  watch.cancelled = true;
  answerRequestWatches.delete(key);
  if (answerRequestWatchIdsByTab.get(watch.tabId) === key) {
    answerRequestWatchIdsByTab.delete(watch.tabId);
  }
}

function startWatchDelay(attempt) {
  const index = Math.min(
    Math.max(0, Number(attempt) || 0),
    SERVER_CAPTURE_START_WATCH_DELAYS_MS.length - 1
  );
  return SERVER_CAPTURE_START_WATCH_DELAYS_MS[index];
}

async function watchAnswerRequestFromStart(details, context) {
  const requestId = String(details?.requestId || '');
  if (!requestId || typeof details?.tabId !== 'number') return;

  const priorRequestId = answerRequestWatchIdsByTab.get(details.tabId);
  if (priorRequestId && priorRequestId !== requestId) {
    cancelAnswerRequestWatch(priorRequestId);
    answerRequestContexts.delete(priorRequestId);
  }

  const watch = {
    requestId,
    tabId: details.tabId,
    startedAt: Number(context?.startedAt) || Date.now(),
    triggerPath: String(context?.triggerPath || answerRequestPath(details)),
    cancelled: false
  };
  answerRequestWatches.set(requestId, watch);
  answerRequestWatchIdsByTab.set(details.tabId, requestId);

  let tab = null;
  try { tab = await chrome.tabs.get(details.tabId); } catch {}
  let identity = await resolveConversationIdentity(tab?.url || '', details.tabId);
  for (let attempt = 0; !identity && attempt < 20 && !watch.cancelled; attempt += 1) {
    await sleep(500);
    try {
      tab = await chrome.tabs.get(details.tabId);
      identity = conversationFromUrl(tab?.url || '');
    } catch {
      break;
    }
  }

  if (watch.cancelled) return;
  if (!identity) {
    recordBackgroundCapture('request-start-no-identity', {
      tabId: details.tabId,
      triggerPath: watch.triggerPath
    });
    cancelAnswerRequestWatch(requestId);
    return;
  }

  recordBackgroundCapture('request-start-watch-armed', {
    tabId: details.tabId,
    conversationId: identity.id,
    triggerPath: watch.triggerPath,
    frozen: Boolean(tab?.frozen),
    discarded: Boolean(tab?.discarded)
  });

  const watchStartedAt = Date.now();
  let attempt = 0;
  let lastReason = '';
  while (!watch.cancelled && Date.now() - watchStartedAt < SERVER_CAPTURE_START_WATCH_TIMEOUT_MS) {
    await sleep(startWatchDelay(attempt));
    if (watch.cancelled) return;

    const activeContext = answerRequestContexts.get(requestId) || context;
    const result = await readCompletedConversation(identity, activeContext, [0]);
    if (watch.cancelled) return;
    if (result.ok && result.capture?.response) {
      try { tab = await chrome.tabs.get(details.tabId); } catch {}
      showCompletionToast(
        identity,
        result.capture.response,
        result.capture.title || tab?.title || 'ChatGPT',
        ''
      );
      rememberCompletedAnswerRequest(requestId);
      answerRequestContexts.delete(requestId);
      recordBackgroundCapture('request-start-toast', {
        tabId: details.tabId,
        conversationId: identity.id,
        triggerPath: watch.triggerPath,
        source: result.source,
        statusCode: result.status || 0,
        elapsedMs: Date.now() - watch.startedAt,
        frozen: Boolean(tab?.frozen),
        discarded: Boolean(tab?.discarded)
      });
      cancelAnswerRequestWatch(requestId);
      return;
    }

    const reason = String(result.reason || `http-${result.status || 0}`);
    if (reason !== lastReason) {
      lastReason = reason;
      recordBackgroundCapture('request-start-polling', {
        tabId: details.tabId,
        conversationId: identity.id,
        triggerPath: watch.triggerPath,
        reason,
        statusCode: result.status || 0
      });
    }
    attempt += 1;
  }

  if (!watch.cancelled) {
    recordBackgroundCapture('request-start-watch-timeout', {
      tabId: details.tabId,
      conversationId: identity.id,
      triggerPath: watch.triggerPath,
      elapsedMs: Date.now() - watch.startedAt
    });
    cancelAnswerRequestWatch(requestId);
  }
}

'''
if anchor not in worker:
    raise SystemExit('completion handler anchor missing')
worker = worker.replace(anchor, watch_code + anchor, 1)
worker = replace_once(
    worker,
    "async function handleCompletedAnswerRequest(details) {\n  const context = takeAnswerRequestContext(details) || {",
    "async function handleCompletedAnswerRequest(details) {\n  const requestId = String(details?.requestId || '');\n  if (completedAnswerRequestIds.has(requestId)) {\n    completedAnswerRequestIds.delete(requestId);\n    takeAnswerRequestContext(details);\n    cancelAnswerRequestWatch(requestId);\n    recordBackgroundCapture('network-completed-after-request-start-toast', {\n      tabId: details.tabId,\n      triggerPath: answerRequestPath(details)\n    });\n    return;\n  }\n  cancelAnswerRequestWatch(requestId);\n  recordBackgroundCapture('network-completed-observed', {\n    tabId: details.tabId,\n    triggerPath: answerRequestPath(details),\n    statusCode: details.statusCode || 0\n  });\n  const context = takeAnswerRequestContext(details) || {",
    'completion dedupe'
)
worker = replace_once(
    worker,
    "chrome.webRequest.onErrorOccurred.addListener((details) => {\n  if (!isAnswerStreamRequest(details)) return;\n  takeAnswerRequestContext(details);\n}, CHATGPT_REQUEST_FILTER);",
    "chrome.webRequest.onErrorOccurred.addListener((details) => {\n  if (!isAnswerStartRequest(details)) return;\n  cancelAnswerRequestWatch(details.requestId);\n  takeAnswerRequestContext(details);\n  recordBackgroundCapture('answer-request-error', {\n    tabId: details.tabId,\n    triggerPath: answerRequestPath(details),\n    error: String(details.error || '')\n  });\n}, CHATGPT_REQUEST_FILTER);",
    'error cleanup'
)
worker = replace_once(
    worker,
    "  if (details.statusCode < 200 || details.statusCode >= 300) {\n    takeAnswerRequestContext(details);\n    return;\n  }",
    "  if (details.statusCode < 200 || details.statusCode >= 300) {\n    cancelAnswerRequestWatch(details.requestId);\n    takeAnswerRequestContext(details);\n    recordBackgroundCapture('network-completed-non-success', {\n      tabId: details.tabId,\n      triggerPath: answerRequestPath(details),\n      statusCode: details.statusCode || 0\n    });\n    return;\n  }",
    'non-success completion cleanup'
)
message_anchor = "  if (message?.type === 'TEST_NATIVE_TOAST') {"
diagnostics = "  if (message?.type === 'GET_BACKGROUND_CAPTURE_DIAGNOSTIC') {\n    sendResponse?.({\n      ok: true,\n      capture: backgroundCaptureHistory[0] || null,\n      history: backgroundCaptureHistory.slice(0, SERVER_CAPTURE_DIAGNOSTIC_HISTORY_LIMIT)\n    });\n    return false;\n  }\n\n"
if message_anchor not in worker:
    raise SystemExit('runtime handler anchor missing')
worker = worker.replace(message_anchor, diagnostics + message_anchor, 1)
worker_path.write_text(worker, encoding='utf-8')

popup_html_path = Path('extension/popup.html')
popup_html = popup_html_path.read_text(encoding='utf-8')
popup_html = replace_once(
    popup_html,
    "    #updateStatus, #captureStatus { margin-top: 8px; color: #a9a9a9; line-height: 1.35; }",
    "    #updateStatus, #captureStatus, #backgroundStatus { margin-top: 8px; color: #a9a9a9; line-height: 1.35; }",
    'popup CSS'
)
popup_html = replace_once(
    popup_html,
    "  <div id=\"captureStatus\">Last capture: checking current ChatGPT tab...</div>\n  <div id=\"captureHistory\"></div>",
    "  <div id=\"backgroundStatus\">Background watcher: checking...</div>\n  <div id=\"captureStatus\">Last page capture: checking current ChatGPT tab...</div>\n  <div id=\"captureHistory\"></div>",
    'popup status markup'
)
popup_html_path.write_text(popup_html, encoding='utf-8')

popup_js_path = Path('extension/popup.js')
popup_js = popup_js_path.read_text(encoding='utf-8')
popup_js = replace_once(
    popup_js,
    "const captureStatus = document.getElementById('captureStatus');",
    "const captureStatus = document.getElementById('captureStatus');\nconst backgroundStatus = document.getElementById('backgroundStatus');",
    'popup element'
)
functions = '''
function formatBackgroundCapture(capture) {
  if (!capture || typeof capture !== 'object') return 'none observed since this extension worker started';
  const details = [];
  if (capture.triggerPath) details.push(capture.triggerPath);
  if (capture.conversationId) details.push(`chat …${String(capture.conversationId).slice(-8)}`);
  if (capture.reason) details.push(capture.reason);
  if (capture.statusCode) details.push(`HTTP ${capture.statusCode}`);
  if (Number.isFinite(capture.elapsedMs)) details.push(`${capture.elapsedMs} ms`);
  if (capture.frozen === true) details.push('tab frozen');
  if (capture.discarded === true) details.push('tab discarded');
  return `${capture.status || 'unknown'}${details.length ? `; ${details.join('; ')}` : ''}.`;
}

async function refreshBackgroundStatus() {
  backgroundStatus.textContent = 'Background watcher: checking...';
  try {
    const result = await chrome.runtime.sendMessage({ type: 'GET_BACKGROUND_CAPTURE_DIAGNOSTIC' });
    backgroundStatus.textContent = `Background watcher: ${formatBackgroundCapture(result?.capture)}`;
  } catch (error) {
    backgroundStatus.textContent = `Background watcher unavailable: ${error.message}`;
  }
}
'''
popup_js = replace_once(popup_js, "async function refreshCaptureStatus() {", functions + "\nasync function refreshCaptureStatus() {", 'popup functions')
popup_js = replace_once(popup_js, "refreshHostStatus();\nrefreshCaptureStatus();", "refreshHostStatus();\nrefreshBackgroundStatus();\nrefreshCaptureStatus();", 'popup refresh')
popup_js_path.write_text(popup_js, encoding='utf-8')

version_path = Path('VERSION.txt')
if version_path.read_text(encoding='utf-8').strip() != '0.2.19':
    raise SystemExit('unexpected public version before bump')
version_path.write_text('0.2.20\n', encoding='utf-8')
manifest_path = Path('extension/manifest.json')
manifest = manifest_path.read_text(encoding='utf-8')
manifest = replace_once(manifest, '"version": "0.2.19"', '"version": "0.2.20"', 'manifest version')
manifest_path.write_text(manifest, encoding='utf-8')

Path('.github/workflows/apply-0.2.20.yml').unlink()
Path('apply-0.2.20.py').unlink()
