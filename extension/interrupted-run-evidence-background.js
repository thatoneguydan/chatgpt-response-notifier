'use strict';

(() => {
  if (globalThis.__chatgptNotifierInterruptedRunEvidence?.version === 1) return;

  const DB_NAME = 'chatgpt-response-notifier-interrupted-run-evidence';
  const DB_VERSION = 1;
  const STORE_NAME = 'evidence';
  const policy = () => globalThis.ChatGPTNotifierInterruptedEvidencePolicy || null;
  const continuationPolicy = () => globalThis.ChatGPTNotifierContinuationPolicy || null;
  const memory = new Map();
  let databasePromise = null;
  const previousSendMessage = chrome.tabs.sendMessage.bind(chrome.tabs);

  function openDatabase() {
    if (databasePromise) return databasePromise;
    databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(STORE_NAME)) database.createObjectStore(STORE_NAME, { keyPath: 'generationKey' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Could not open interrupted-run evidence database.'));
      request.onblocked = () => reject(new Error('Interrupted-run evidence database upgrade was blocked.'));
    });
    databasePromise.catch(() => { databasePromise = null; });
    return databasePromise;
  }

  function requestResult(request, message) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error(message));
    });
  }

  async function readEvidence(key) {
    const normalizedKey = String(key || '');
    if (!normalizedKey) return null;
    if (memory.has(normalizedKey)) return memory.get(normalizedKey);
    try {
      const database = await openDatabase();
      const transaction = database.transaction(STORE_NAME, 'readonly');
      const raw = await requestResult(transaction.objectStore(STORE_NAME).get(normalizedKey), 'Could not read interrupted-run evidence.');
      if (!raw) return null;
      const evidence = policy()?.normalizeEvidence?.(raw) || raw;
      memory.set(normalizedKey, evidence);
      return evidence;
    } catch { return null; }
  }

  async function writeEvidence(value) {
    const evidence = policy()?.normalizeEvidence?.(value);
    if (!evidence?.generationKey) return false;
    memory.set(evidence.generationKey, evidence);
    try {
      const database = await openDatabase();
      await new Promise((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, 'readwrite');
        transaction.objectStore(STORE_NAME).put(evidence);
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error || new Error('Could not write interrupted-run evidence.'));
        transaction.onabort = () => reject(transaction.error || new Error('Interrupted-run evidence write was aborted.'));
      });
      return true;
    } catch { return false; }
  }

  async function clearEvidence(key) {
    const normalizedKey = String(key || '');
    if (!normalizedKey) return false;
    memory.delete(normalizedKey);
    try {
      const database = await openDatabase();
      await new Promise((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, 'readwrite');
        transaction.objectStore(STORE_NAME).delete(normalizedKey);
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error || new Error('Could not clear interrupted-run evidence.'));
        transaction.onabort = () => reject(transaction.error || new Error('Interrupted-run evidence clear was aborted.'));
      });
      return true;
    } catch { return false; }
  }

  async function observeSnapshot(snapshot = {}) {
    const evidencePolicy = policy();
    if (!evidencePolicy || !snapshot?.conversationId || !snapshot?.promptKey) return;
    const key = evidencePolicy.generationKey(snapshot);
    const classification = continuationPolicy()?.classifyObservation?.(snapshot) || {};
    const captured = evidencePolicy.fromObservation(snapshot, classification, Date.now());
    if (captured) {
      memory.set(captured.generationKey, captured);
      await writeEvidence(captured);
      return;
    }

    const existing = await readEvidence(key);
    if (!existing) return;
    const decision = evidencePolicy.evaluate(snapshot, existing, Date.now());
    if (decision.action === 'clear') await clearEvidence(key);
  }

  async function augmentSnapshot(snapshot = {}) {
    const evidencePolicy = policy();
    if (!evidencePolicy || !snapshot?.conversationId || !snapshot?.promptKey) return snapshot;
    const key = evidencePolicy.generationKey(snapshot);
    const currentClassification = continuationPolicy()?.classifyObservation?.(snapshot) || {};
    const captured = evidencePolicy.fromObservation(snapshot, currentClassification, Date.now());
    if (captured) {
      memory.set(captured.generationKey, captured);
      writeEvidence(captured).catch(() => {});
      return snapshot;
    }

    const evidence = await readEvidence(key);
    if (!evidence) return snapshot;
    const decision = evidencePolicy.evaluate(snapshot, evidence, Date.now());
    if (decision.action === 'clear') {
      clearEvidence(key).catch(() => {});
      return snapshot;
    }
    if (decision.action !== 'patch' || !decision.patch) return snapshot;
    return { ...snapshot, ...decision.patch };
  }

  chrome.tabs.sendMessage = async function interruptedEvidenceAwareSendMessage(tabId, message, ...rest) {
    const result = await previousSendMessage(tabId, message, ...rest);
    if (message?.type !== 'CHATGPT_MONITOR_QUERY') return result;
    const base = result?.snapshot && typeof result.snapshot === 'object' ? result.snapshot : result;
    if (!base || typeof base !== 'object' || !base.conversationId || !base.promptKey) return result;
    const augmented = await augmentSnapshot(base);
    if (result?.snapshot && typeof result.snapshot === 'object') {
      const patch = {};
      for (const key of ['explicitInterruption', 'interruptionKind', 'interruptionAttribution', 'applicationStateIdentityMatched', 'applicationStateReason']) {
        if (augmented[key] !== base[key]) patch[key] = augmented[key];
      }
      return Object.keys(patch).length ? { ...result, ...patch, snapshot: augmented } : result;
    }
    return augmented;
  };

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type !== 'CHATGPT_MONITOR_STATE' || !message?.snapshot) return false;
    observeSnapshot(message.snapshot).catch(() => {});
    return false;
  });

  globalThis.__chatgptNotifierInterruptedRunEvidence = Object.freeze({
    version: 1,
    readEvidence,
    writeEvidence,
    clearEvidence,
    observeSnapshot,
    augmentSnapshot
  });
})();
