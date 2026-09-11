export const SERVER_CAPTURE_NUM_TURNS = 10;

const FINISHED_STATUSES = new Set([
  'finished_successfully',
  'finished',
  'completed',
  'complete'
]);

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function normalizeMessage(raw, fallbackId = '') {
  const wrapper = asObject(raw);
  if (!wrapper) return null;
  const nested = asObject(wrapper.message);
  const message = nested ? { ...nested } : { ...wrapper };
  const id = String(message.id || wrapper.id || fallbackId || '').trim();
  if (id) message.id = id;
  if (!message.parent) {
    message.parent = wrapper.parent || message.parent_message_id || message.parent_id ||
      message.metadata?.parent_message_id || message.metadata?.parent_id || null;
  }
  if (!message.children && Array.isArray(wrapper.children)) message.children = wrapper.children;
  if (message.recipient == null && wrapper.recipient != null) message.recipient = wrapper.recipient;
  if (message.channel == null && wrapper.channel != null) message.channel = wrapper.channel;
  if (message.end_turn == null && wrapper.end_turn != null) message.end_turn = wrapper.end_turn;
  if (message.status == null && wrapper.status != null) message.status = wrapper.status;
  return message;
}

export function normalizeConversationPayload(payload) {
  const root = asObject(payload?.conversation) || asObject(payload) || {};
  const messages = [];

  if (Array.isArray(root.messages)) {
    for (const raw of root.messages) {
      const message = normalizeMessage(raw);
      if (message) messages.push(message);
    }
  } else if (asObject(root.mapping)) {
    for (const [nodeId, node] of Object.entries(root.mapping)) {
      const message = normalizeMessage(node, nodeId);
      if (message) messages.push(message);
    }
  }

  return {
    title: String(root.title || payload?.title || '').trim(),
    currentNode: String(root.current_node || root.current_node_id || payload?.current_node || payload?.current_node_id || '').trim(),
    messages
  };
}

function textFromPart(part) {
  if (typeof part === 'string') return part;
  const value = asObject(part);
  if (!value) return '';
  if (typeof value.text === 'string') return value.text;
  if (typeof value.content === 'string') return value.content;
  if (typeof value.value === 'string') return value.value;
  return '';
}

export function extractServerMessageText(message) {
  const parts = message?.content?.parts;
  if (Array.isArray(parts)) {
    return parts.map(textFromPart).filter(Boolean).join('\n').trim();
  }
  if (typeof message?.content?.text === 'string') return message.content.text.trim();
  if (typeof message?.content === 'string') return message.content.trim();
  return '';
}

function isVisuallyHidden(message) {
  return message?.metadata?.is_visually_hidden_from_conversation === true ||
    message?.metadata?.is_visually_hidden === true;
}

function messageRole(message) {
  return String(message?.author?.role || message?.role || '').trim().toLowerCase();
}

function messageRecipient(message) {
  const candidates = [
    message?.recipient,
    message?.metadata?.recipient,
    message?.metadata?.recipient_name
  ];
  return String(candidates.find((value) => typeof value === 'string' && value.trim()) || '').trim().toLowerCase();
}

function messageChannel(message) {
  const candidates = [
    message?.channel,
    message?.metadata?.channel
  ];
  return String(candidates.find((value) => typeof value === 'string' && value.trim()) || '').trim().toLowerCase();
}

function isUserFacingRecipient(message) {
  const recipient = messageRecipient(message);
  if (!recipient) return true;
  return recipient === 'all' || recipient === 'user';
}

function isTerminalUserFacingChannel(message) {
  const channel = messageChannel(message);
  if (!channel) return true;
  return channel === 'final';
}

function messageParentId(message) {
  const candidates = [
    message?.parent,
    message?.parent_message_id,
    message?.parent_id,
    message?.metadata?.parent_message_id,
    message?.metadata?.parent_id
  ];
  return String(candidates.find((value) => typeof value === 'string' && value.trim()) || '').trim();
}

function isCompletedAssistant(message) {
  if (!message || messageRole(message) !== 'assistant' || isVisuallyHidden(message)) return false;
  // A tool-directed or commentary/analysis assistant node can be individually
  // "finished" while the overall ChatGPT turn is still running. Explicit
  // non-terminal/user-facing metadata always wins over a generic status.
  if (message.end_turn === false) return false;
  if (!isUserFacingRecipient(message)) return false;
  if (!isTerminalUserFacingChannel(message)) return false;
  if (!extractServerMessageText(message)) return false;
  if (message.end_turn === true) return true;
  const status = String(message.status || '').trim().toLowerCase();
  if (FINISHED_STATUSES.has(status)) return true;
  return message.metadata?.is_complete === true || message.metadata?.finished === true;
}

function createdAtMs(message) {
  const seconds = Number(message?.create_time);
  return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : null;
}

function captureFromMessage(message, title) {
  if (!isCompletedAssistant(message)) return null;
  return {
    messageId: String(message.id || '').trim(),
    response: extractServerMessageText(message),
    title: String(title || '').trim(),
    createdAtMs: createdAtMs(message)
  };
}

export function latestCompletedAssistant(payload) {
  const normalized = normalizeConversationPayload(payload);
  const byId = new Map();
  for (const message of normalized.messages) {
    const id = String(message?.id || '').trim();
    if (id) byId.set(id, message);
  }

  let currentId = normalized.currentNode;
  const seen = new Set();
  for (let depth = 0; currentId && depth < 200; depth += 1) {
    if (seen.has(currentId)) break;
    seen.add(currentId);
    const message = byId.get(currentId);
    if (!message) break;
    const capture = captureFromMessage(message, normalized.title);
    if (capture) return capture;
    currentId = messageParentId(message);
  }

  const candidates = normalized.messages
    .map((message) => ({ message, capture: captureFromMessage(message, normalized.title) }))
    .filter((entry) => entry.capture)
    .sort((left, right) => {
      const leftTime = left.capture.createdAtMs ?? Number.NEGATIVE_INFINITY;
      const rightTime = right.capture.createdAtMs ?? Number.NEGATIVE_INFINITY;
      return rightTime - leftTime;
    });
  return candidates[0]?.capture || null;
}

function safeSuffix(value) {
  const text = String(value || '').trim();
  return text.length <= 8 ? text : text.slice(-8);
}

function summarizeMessageMetadata(message) {
  if (!message) return null;
  return {
    idSuffix: safeSuffix(message.id),
    parentSuffix: safeSuffix(messageParentId(message)),
    role: messageRole(message),
    recipient: messageRecipient(message),
    channel: messageChannel(message),
    endTurn: typeof message.end_turn === 'boolean' ? message.end_turn : null,
    status: String(message.status || '').trim().toLowerCase().slice(0, 80),
    hidden: isVisuallyHidden(message),
    hasText: Boolean(extractServerMessageText(message)),
    contentType: String(message?.content?.content_type || '').trim().toLowerCase().slice(0, 80)
  };
}

export function summarizeConversationTerminalState(payload) {
  const normalized = normalizeConversationPayload(payload);
  const byId = new Map();
  for (const message of normalized.messages) {
    const id = String(message?.id || '').trim();
    if (id) byId.set(id, message);
  }

  const ancestry = [];
  let currentId = normalized.currentNode;
  const seen = new Set();
  for (let depth = 0; currentId && depth < 12; depth += 1) {
    if (seen.has(currentId)) break;
    seen.add(currentId);
    const message = byId.get(currentId);
    if (!message) break;
    const summary = summarizeMessageMetadata(message);
    if (summary) ancestry.push(summary);
    currentId = messageParentId(message);
  }

  return {
    messageCount: normalized.messages.length,
    currentNodeSuffix: safeSuffix(normalized.currentNode),
    currentNodePresent: Boolean(normalized.currentNode && byId.has(normalized.currentNode)),
    ancestry
  };
}

export function captureIsFreshForRequest(capture, requestStartedAt, toleranceMs = 5000) {
  if (!capture?.response) return false;
  const startedAt = Number(requestStartedAt);
  if (!Number.isFinite(startedAt) || startedAt <= 0) return true;
  if (!Number.isFinite(capture.createdAtMs)) return false;
  return capture.createdAtMs >= startedAt - Math.max(0, Number(toleranceMs) || 0);
}

export function currentConversationReadUrl(conversationId) {
  const encodedId = encodeURIComponent(String(conversationId || '').trim());
  return `https://chatgpt.com/backend-api/conversations/${encodedId}?include_has_versions=true&num_turns=${SERVER_CAPTURE_NUM_TURNS}`;
}

export function legacyConversationReadUrl(conversationId) {
  const encodedId = encodeURIComponent(String(conversationId || '').trim());
  return `https://chatgpt.com/backend-api/conversation/${encodedId}`;
}
