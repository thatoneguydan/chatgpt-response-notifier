export const CHATGPT_ORIGIN = 'https://chatgpt.com';

export function normalizeChatGptUrl(rawUrl) {
  try {
    const url = new URL(String(rawUrl || ''));
    if (url.hostname !== 'chatgpt.com' && url.hostname !== 'www.chatgpt.com') return null;
    url.protocol = 'https:';
    url.hostname = 'chatgpt.com';
    url.username = '';
    url.password = '';
    url.port = '';
    url.search = '';
    url.hash = '';
    url.pathname = url.pathname.replace(/\/+$/, '') || '/';
    return url;
  } catch { return null; }
}

export function conversationFromUrl(rawUrl) {
  const url = normalizeChatGptUrl(rawUrl);
  if (!url) return null;
  const segments = url.pathname.split('/').filter(Boolean);
  let conversationId = '';
  for (let index = segments.length - 2; index >= 0; index -= 1) {
    if (segments[index] !== 'c') continue;
    conversationId = decodeURIComponent(segments[index + 1] || '').trim();
    if (conversationId) break;
  }
  if (!conversationId) return null;
  return { id: conversationId, url: `${CHATGPT_ORIGIN}${url.pathname}` };
}

export function sameConversation(leftUrl, rightUrl) {
  const left = conversationFromUrl(leftUrl);
  const right = conversationFromUrl(rightUrl);
  return Boolean(left && right && left.id === right.id);
}

export function cleanSessionTitle(rawTitle) {
  const raw = String(rawTitle || '').replace(/\s+/g, ' ').trim();
  if (!raw) return 'Chat';
  const cleaned = raw
    .replace(/\s*[-|\u2013\u2014]\s*ChatGPT\s*$/i, '')
    .replace(/^ChatGPT\s*[-|\u2013\u2014]\s*/i, '')
    .trim();
  return cleaned && cleaned.toLowerCase() !== 'chatgpt' ? cleaned : 'Chat';
}

export function cleanProjectTitle(rawTitle) {
  const raw = String(rawTitle || '').replace(/\s+/g, ' ').trim();
  if (!raw) return '';
  const options = raw.match(/^Open project options for\s+(.+)$/i);
  if (options?.[1]) return options[1].trim();
  const openProject = raw.match(/^Open\s+(.+?)\s+project(?:\b.*)?$/i);
  if (openProject?.[1]) return openProject[1].trim();
  return raw;
}

export function formatNotificationTitle(projectTitle, rawSessionTitle) {
  const chatTitle = cleanSessionTitle(rawSessionTitle);
  const project = cleanProjectTitle(projectTitle);
  if (!project || project.toLowerCase() === chatTitle.toLowerCase()) return chatTitle;
  return `${project} — ${chatTitle}`;
}

export function truncatePreview(text, maxChars = 600) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  if (normalized.length <= maxChars) return normalized;
  const slice = normalized.slice(0, Math.max(1, maxChars - 3));
  const lastSpace = slice.lastIndexOf(' ');
  const safeCut = lastSpace >= Math.floor(maxChars * 0.7) ? slice.slice(0, lastSpace) : slice;
  return `${safeCut.trimEnd()}...`;
}
