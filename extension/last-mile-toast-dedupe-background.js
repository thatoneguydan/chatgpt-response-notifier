'use strict';

(() => {
  if (globalThis.__chatgptNotifierLastMileToastDedupe) return;

  const originalNotificationFromTurnRecord = globalThis.notificationFromTurnRecord;
  if (typeof originalNotificationFromTurnRecord !== 'function') {
    throw new Error('Last-mile toast dedupe could not find notificationFromTurnRecord.');
  }

  function deliveryKeyFromTurnRecord(record) {
    const conversationId = String(record?.conversationId || '').trim();
    const assistantKey = String(record?.assistantKey || '').trim();
    if (!conversationId || !assistantKey) return '';
    return `assistant|${conversationId}|${assistantKey}`;
  }

  globalThis.notificationFromTurnRecord = function notificationFromTurnRecordWithDeliveryKey(record) {
    const notification = originalNotificationFromTurnRecord(record);
    if (!notification) return notification;
    const deliveryKey = deliveryKeyFromTurnRecord(record);
    return deliveryKey ? { ...notification, deliveryKey } : notification;
  };

  globalThis.__chatgptNotifierLastMileToastDedupe = Object.freeze({
    version: 1,
    deliveryKeyFromTurnRecord
  });
})();
