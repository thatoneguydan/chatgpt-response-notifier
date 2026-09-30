'use strict';

(() => {
  if (globalThis.__chatgptNotifierLastMileToastDedupe) return;

  const originalNotificationFromTurnRecord = globalThis.notificationFromTurnRecord;
  if (typeof originalNotificationFromTurnRecord !== 'function') {
    throw new Error('Last-mile toast dedupe could not find notificationFromTurnRecord.');
  }

  function deliveryKeyFromTurnRecord(record) {
    const conversationId = String(record?.conversationId || '').trim();
    if (!conversationId) return '';

    // DOM-backed turn IDs are not stable across ChatGPT remounts. The same live
    // response can therefore be observed first as assistant-N and seconds later
    // as assistant-(N-1), which previously generated two native notification IDs.
    // The assistant revision is a content-derived identity that survives that
    // remount. The host applies this response-revision key only within a bounded
    // same-completion window, so a genuinely later identical response remains
    // eligible for its own notification.
    const revision = String(record?.revision || '').trim();
    if (revision) {
      const statusCode = String(record?.statusCode || '').trim() || 'NO_STATUS';
      return `response-revision|${conversationId}|${statusCode}|${revision}`;
    }

    // Legacy/non-revision notification paths keep the older assistant identity
    // fallback for compatibility. This is intentionally not preferred when a
    // stable response revision is available.
    const assistantKey = String(record?.assistantKey || '').trim();
    return assistantKey ? `assistant|${conversationId}|${assistantKey}` : '';
  }

  globalThis.notificationFromTurnRecord = function notificationFromTurnRecordWithDeliveryKey(record) {
    const notification = originalNotificationFromTurnRecord(record);
    if (!notification) return notification;
    const deliveryKey = deliveryKeyFromTurnRecord(record);
    return deliveryKey ? { ...notification, deliveryKey } : notification;
  };

  globalThis.__chatgptNotifierLastMileToastDedupe = Object.freeze({
    version: 2,
    deliveryKeyFromTurnRecord
  });
})();
