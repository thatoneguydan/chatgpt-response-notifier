'use strict';

(() => {
  if (globalThis.ChatGPTQuickContinueConfig) return;

  const STORAGE_KEY = 'quickContinueConfig';
  const MAX_PROJECTS = 40;
  const listeners = new Set();
  let current = null;
  let loadPromise = null;

  const normalizeInline = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

  function normalizeProjectList(value) {
    if (!Array.isArray(value)) throw new Error('"projects" must be an array.');
    const seen = new Set();
    const projects = [];

    for (const entry of value) {
      if (typeof entry !== 'string') throw new Error('Every project title must be a string.');
      const title = normalizeInline(entry);
      if (!title) continue;
      const key = title.toLocaleLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      projects.push(title);
      if (projects.length >= MAX_PROJECTS) break;
    }

    return projects;
  }

  function normalizeConfig(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('Config must be a JSON object.');
    }

    const continueText = normalizeInline(value.continueText);
    const projectText = normalizeInline(value.projectText);

    if (!continueText) throw new Error('"continueText" must not be blank.');
    if (!projectText) throw new Error('"projectText" must not be blank.');
    if (!projectText.includes('{project}')) {
      throw new Error('"projectText" must include {project}.');
    }

    return Object.freeze({
      continueText,
      projectText,
      projects: Object.freeze(normalizeProjectList(value.projects))
    });
  }

  function cloneConfig(value) {
    return {
      continueText: value.continueText,
      projectText: value.projectText,
      projects: [...value.projects]
    };
  }

  function notify() {
    if (!current) return;
    const snapshot = cloneConfig(current);
    for (const listener of listeners) {
      try { listener(snapshot); } catch {}
    }
  }

  async function bundledConfig() {
    const response = await fetch(chrome.runtime.getURL('config.json'), { cache: 'no-store' });
    if (!response.ok) throw new Error(`Could not load config.json (HTTP ${response.status}).`);
    return normalizeConfig(await response.json());
  }

  async function load() {
    if (current) return cloneConfig(current);
    if (loadPromise) return loadPromise;

    loadPromise = (async () => {
      const defaults = await bundledConfig();
      let stored = null;
      try {
        stored = (await chrome.storage.local.get(STORAGE_KEY))?.[STORAGE_KEY] ?? null;
      } catch {}

      if (stored !== null) {
        try { current = normalizeConfig(stored); }
        catch { current = defaults; }
      } else {
        current = defaults;
      }

      loadPromise = null;
      return cloneConfig(current);
    })().catch((error) => {
      loadPromise = null;
      throw error;
    });

    return loadPromise;
  }

  async function save(value) {
    const normalized = normalizeConfig(value);
    await chrome.storage.local.set({ [STORAGE_KEY]: cloneConfig(normalized) });
    current = normalized;
    notify();
    return cloneConfig(current);
  }

  async function reset() {
    await chrome.storage.local.remove(STORAGE_KEY);
    current = await bundledConfig();
    notify();
    return cloneConfig(current);
  }

  function serialize(value = current) {
    if (!value) return '';
    const normalized = normalizeConfig(value);
    return JSON.stringify(cloneConfig(normalized), null, 2);
  }

  function subscribe(listener) {
    if (typeof listener !== 'function') return () => {};
    listeners.add(listener);
    if (current) {
      try { listener(cloneConfig(current)); } catch {}
    }
    return () => listeners.delete(listener);
  }

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local' || !Object.prototype.hasOwnProperty.call(changes, STORAGE_KEY)) return;
    const next = changes[STORAGE_KEY]?.newValue;
    if (next === undefined) {
      bundledConfig()
        .then((value) => {
          current = value;
          notify();
        })
        .catch(() => {});
      return;
    }

    try {
      current = normalizeConfig(next);
      notify();
    } catch {}
  });

  globalThis.ChatGPTQuickContinueConfig = Object.freeze({
    load,
    save,
    reset,
    serialize,
    subscribe,
    normalizeConfig
  });
})();
