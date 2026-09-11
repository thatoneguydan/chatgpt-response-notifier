from pathlib import Path

service_path = Path('extension/service-worker.js')
service = service_path.read_text(encoding='utf-8')
service = service.replace(
    "const SERVER_CAPTURE_GENERIC_PREVIEW = 'Your ChatGPT response finished. Open this conversation to read it.';\n",
    ''
)
start = service.index('async function handleCompletedAnswerRequest(details) {')
end = service.index('\n\nchrome.webRequest.onBeforeSendHeaders.addListener(', start)
new_function = r'''async function handleCompletedAnswerRequest(details) {
  const requestId = String(details?.requestId || '');
  if (completedAnswerRequestIds.has(requestId)) {
    completedAnswerRequestIds.delete(requestId);
    takeAnswerRequestContext(details);
    cancelAnswerRequestWatch(requestId);
    recordBackgroundCapture('network-completed-after-request-start-toast', {
      tabId: details.tabId,
      triggerPath: answerRequestPath(details)
    });
    return;
  }

  const existingWatch = answerRequestWatches.get(requestId) || null;
  recordBackgroundCapture('network-completed-observed', {
    tabId: details.tabId,
    triggerPath: answerRequestPath(details),
    statusCode: details.statusCode || 0
  });
  const context = answerRequestContexts.get(requestId) || {
    tabId: details.tabId,
    startedAt: Number(details.timeStamp) || Date.now(),
    headers: {},
    triggerPath: answerRequestPath(details)
  };

  let tab = null;
  try { tab = await chrome.tabs.get(details.tabId); } catch {}
  const identity = await resolveConversationIdentity(tab?.url || '', details.tabId);
  if (!identity) {
    if (!existingWatch) {
      // New conversations can briefly lack a stable /c/<id> URL. The DOM path
      // remains a compatibility fallback only when no service-worker watch survived.
      await signalConversationRequestCompleted(details.tabId);
    }
    return;
  }

  const result = await readCompletedConversation(identity, context);

  // The request-start watch may have found and notified the terminal answer while
  // this acceleration read was in flight. Never emit a second toast in that race.
  if (completedAnswerRequestIds.has(requestId)) {
    completedAnswerRequestIds.delete(requestId);
    takeAnswerRequestContext(details);
    cancelAnswerRequestWatch(requestId);
    recordBackgroundCapture('network-completed-after-request-start-toast', {
      tabId: details.tabId,
      triggerPath: answerRequestPath(details)
    });
    return;
  }

  if (result.ok && result.capture?.response) {
    showCompletionToast(
      identity,
      result.capture.response,
      result.capture.title || tab?.title || 'ChatGPT',
      ''
    );
    takeAnswerRequestContext(details);
    cancelAnswerRequestWatch(requestId);
    recordBackgroundCapture('network-completed-terminal-toast', {
      tabId: details.tabId,
      conversationId: identity.id,
      triggerPath: answerRequestPath(details),
      source: result.source,
      statusCode: result.status || 0
    });
    return;
  }

  // A transport request can finish between tool calls while the ChatGPT turn is
  // still running. Network completion is therefore only an acceleration signal,
  // never sufficient evidence by itself that the user-facing answer is ready.
  if (existingWatch && !existingWatch.cancelled) {
    recordBackgroundCapture('network-completed-waiting-for-terminal', {
      tabId: details.tabId,
      conversationId: identity.id,
      triggerPath: answerRequestPath(details),
      reason: result.reason || 'no-terminal-assistant',
      statusCode: result.status || 0
    });
    return;
  }

  // If the service worker restarted and lost its in-memory request-start watch,
  // re-arm a bounded server-side watch instead of producing a premature generic
  // notification. This remains independent of hidden-tab DOM execution.
  answerRequestContexts.set(requestId, context);
  boundedRequestContextCache();
  recordBackgroundCapture('network-completed-rearming-terminal-watch', {
    tabId: details.tabId,
    conversationId: identity.id,
    triggerPath: answerRequestPath(details),
    reason: result.reason || 'no-terminal-assistant',
    statusCode: result.status || 0
  });
  watchAnswerRequestFromStart(details, context).catch((error) => {
    recordBackgroundCapture('network-completed-rearm-error', {
      tabId: details.tabId,
      conversationId: identity.id,
      triggerPath: answerRequestPath(details),
      error: String(error?.message || error)
    });
    console.warn('Could not re-arm terminal ChatGPT completion watch', error);
  });
}'''
service = service[:start] + new_function + service[end:]
if 'SERVER_CAPTURE_GENERIC_PREVIEW' in service:
    raise SystemExit('generic preview fallback was not fully removed')
if 'network-completed-waiting-for-terminal' not in service:
    raise SystemExit('terminal wait marker missing after patch')
service_path.write_text(service, encoding='utf-8')
