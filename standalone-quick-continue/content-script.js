'use strict';

(() => {
  const RUNTIME_VERSION = 5;
  const prompts = globalThis.ChatGPTQuickContinuePrompts;
  const configApi = globalThis.ChatGPTQuickContinueConfig;
  if (!prompts || !configApi) return;

  const previousRuntime = globalThis.__chatgptQuickContinueRuntime;
  if (Number(previousRuntime?.version || 0) === RUNTIME_VERSION) return;
  try { previousRuntime?.dispose?.(); } catch {}

  const TOOLBAR_ID = 'chatgpt-quick-continue-toolbar';
  const NOTIFIER_MUTATION_SELECTOR = [
    '#chatgpt-notifier-automation-indicator',
    '#chatgpt-notifier-automation-status',
    '[id^="chatgpt-notifier-automation-indicator-v"]',
    '[id^="chatgpt-notifier-automation-status-v"]'
  ].join(',');
  const SEND_READY_TIMEOUT_MS = 1800;
  const sendButtons = [];
  const projectButtons = [];

  let toolbar = null;
  let clock = null;
  let projectPopover = null;
  let projectList = null;
  let projectInput = null;
  let projectSend = null;
  let browsePanel = null;
  let editorPanel = null;
  let editorTextarea = null;
  let editorError = null;
  let status = null;
  let statusTimer = null;
  let observer = null;
  let resizeObserver = null;
  let observedComposer = null;
  let observedAnchor = null;
  let scheduled = null;
  let scheduledWithAnimationFrame = false;
  let clockTimer = null;
  let toolbarHideTimer = null;
  let busy = false;
  let currentConfig = null;
  let configLoadPromise = null;
  let unsubscribeConfig = null;

  const cleanComposer = (value) => String(value || '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  function composerElement() {
    for (const selector of [
      '#prompt-textarea',
      'textarea[data-testid="prompt-textarea"]',
      '[contenteditable="true"][data-testid="prompt-textarea"]'
    ]) {
      let node = null;
      try { node = document.querySelector(selector); } catch {}
      if (!node || node.disabled || node.getAttribute?.('aria-disabled') === 'true') continue;
      if (node instanceof HTMLTextAreaElement || node instanceof HTMLInputElement || node.isContentEditable) return node;
    }
    return null;
  }

  function composerAnchor(composer) {
    if (!composer) return null;
    try {
      return composer.closest?.('form')
        || composer.closest?.('[data-type="unified-composer"]')
        || composer.closest?.('[data-testid*="composer" i]')
        || composer.parentElement
        || composer;
    } catch {
      return composer;
    }
  }

  function composerText(node) {
    try {
      if (node instanceof HTMLTextAreaElement || node instanceof HTMLInputElement) return cleanComposer(node.value);
      return cleanComposer(node?.innerText || node?.textContent || '');
    } catch {
      return '';
    }
  }

  function dispatchInput(node, text) {
    try {
      node.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        inputType: text ? 'insertText' : 'deleteContentBackward',
        data: text || null
      }));
    } catch {
      try { node.dispatchEvent(new Event('input', { bubbles: true })); } catch {}
    }
  }

  function writeComposer(node, text) {
    if (!node) return false;
    try {
      if (node instanceof HTMLTextAreaElement || node instanceof HTMLInputElement) {
        const proto = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (setter) setter.call(node, text);
        else node.value = text;
        dispatchInput(node, text);
      } else if (node.isContentEditable) {
        node.textContent = text;
        dispatchInput(node, text);
      } else {
        return false;
      }
      return composerText(node) === cleanComposer(text);
    } catch {
      return false;
    }
  }

  function enabledSend(composer) {
    const root = composer?.closest?.('form') || document;
    for (const selector of [
      'button[data-testid="send-button"]',
      'button[aria-label="Send prompt"]',
      'button[aria-label="Send message"]',
      'button[aria-label="Send"]'
    ]) {
      let button = null;
      try {
        button = root.querySelector(selector) || (root !== document ? document.querySelector(selector) : null);
      } catch {}
      if (!button || button.disabled || button.getAttribute?.('aria-disabled') === 'true') continue;
      return button;
    }
    return null;
  }

  function waitForSendButton(composer) {
    const immediate = enabledSend(composer);
    if (immediate) return Promise.resolve(immediate);

    return new Promise((resolve) => {
      let settled = false;
      let mutationObserver = null;
      const root = composer?.closest?.('form') || document.body || document.documentElement;

      const finish = (button) => {
        if (settled) return;
        settled = true;
        try { mutationObserver?.disconnect(); } catch {}
        clearTimeout(timer);
        resolve(button || null);
      };

      const inspect = () => {
        const button = enabledSend(composer);
        if (button) finish(button);
      };

      if (root && typeof MutationObserver === 'function') {
        mutationObserver = new MutationObserver(inspect);
        mutationObserver.observe(root, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['disabled', 'aria-disabled', 'data-testid', 'aria-label']
        });
      }

      const timer = setTimeout(() => finish(enabledSend(composer)), SEND_READY_TIMEOUT_MS);
      inspect();
    });
  }

  function setStatus(message) {
    if (!status) return;
    status.textContent = String(message || '');
    status.hidden = !message;
    if (statusTimer !== null) clearTimeout(statusTimer);
    statusTimer = setTimeout(() => {
      statusTimer = null;
      if (status) {
        status.textContent = '';
        status.hidden = true;
      }
    }, 2200);
  }

  function setEditorError(message) {
    if (!editorError) return;
    editorError.textContent = String(message || '');
    editorError.hidden = !message;
  }

  async function ensureConfig() {
    if (currentConfig) return currentConfig;
    if (configLoadPromise) return configLoadPromise;

    configLoadPromise = configApi.load()
      .then((config) => {
        currentConfig = config;
        return currentConfig;
      })
      .catch((error) => {
        setStatus(String(error?.message || 'Could not load config.'));
        return null;
      })
      .finally(() => {
        configLoadPromise = null;
      });

    return configLoadPromise;
  }

  async function sendPrompt(text) {
    if (busy || !text) return false;
    const composer = composerElement();
    if (!composer) {
      setStatus('ChatGPT composer not found.');
      return false;
    }
    if (composerText(composer)) {
      setStatus('Clear the current draft first.');
      scheduleSync();
      return false;
    }
    busy = true;
    updateAvailability(composer);
    try {
      if (!writeComposer(composer, text)) {
        setStatus('Could not write the prompt.');
        return false;
      }

      const sendButton = await waitForSendButton(composer);
      if (!sendButton) {
        setStatus('Send not ready; prompt left in composer.');
        return false;
      }
      if (composerText(composer) !== cleanComposer(text)) {
        setStatus('Composer changed; nothing sent.');
        return false;
      }

      try {
        sendButton.click();
        setStatus('Sent.');
        return true;
      } catch {
        setStatus('Send failed; prompt left in composer.');
        return false;
      }
    } finally {
      busy = false;
      scheduleSync();
    }
  }

  async function sendContinue() {
    const config = await ensureConfig();
    if (!config) return;
    await sendPrompt(prompts.continuePrompt(config.continueText, new Date()));
  }

  function formatClock(date = new Date()) {
    try {
      return new Intl.DateTimeFormat(undefined, {
        hour: 'numeric',
        minute: '2-digit'
      }).format(date);
    } catch {
      return date.toLocaleTimeString();
    }
  }

  function visible(node) {
    try {
      const rect = node?.getBoundingClientRect?.();
      if (!rect || rect.width <= 0 || rect.height <= 0) return false;
      return rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth;
    } catch {
      return false;
    }
  }

  function preferredPopoverDirection(toolbarRect, popoverHeight, viewportHeight) {
    const gap = 6;
    const margin = 8;
    const height = Math.max(0, Number(popoverHeight) || 0);
    const top = Number(toolbarRect?.top || 0);
    const bottom = Number(toolbarRect?.bottom || top);
    const viewport = Math.max(0, Number(viewportHeight) || 0);
    const upwardTop = top - gap - height;

    if (upwardTop >= margin) return 'above';

    const downwardBottom = bottom + gap + height;
    if (downwardBottom <= viewport - margin) return 'below';

    const spaceAbove = Math.max(0, top - margin);
    const spaceBelow = Math.max(0, viewport - bottom - margin);
    return spaceBelow > spaceAbove ? 'below' : 'above';
  }

  function positionProjectPopover() {
    if (!projectPopover || projectPopover.hidden || !toolbar) return;
    const direction = preferredPopoverDirection(
      toolbar.getBoundingClientRect(),
      projectPopover.offsetHeight,
      window.innerHeight
    );

    if (direction === 'below') {
      projectPopover.style.top = 'calc(100% + 6px)';
      projectPopover.style.bottom = 'auto';
    } else {
      projectPopover.style.top = 'auto';
      projectPopover.style.bottom = 'calc(100% + 6px)';
    }
  }

  function setEditorMode(editing) {
    if (!browsePanel || !editorPanel) return;
    browsePanel.hidden = Boolean(editing);
    editorPanel.hidden = !editing;
    if (!editing) setEditorError('');
    positionProjectPopover();
  }

  function closeProjectPopover({ clear = false } = {}) {
    if (!projectPopover) return;
    projectPopover.hidden = true;
    setEditorMode(false);
    if (clear && projectInput) projectInput.value = '';
    updateProjectSendState();
  }

  function canSendProject() {
    const composer = composerElement();
    return !busy
      && Boolean(composer)
      && !composerText(composer);
  }

  function updateProjectSendState() {
    const canSend = canSendProject();
    if (projectSend && projectInput) {
      projectSend.disabled = !canSend || !prompts.normalizeInline(projectInput.value);
    }
    for (const button of projectButtons) {
      button.disabled = !canSend;
      button.style.opacity = button.disabled ? '.45' : '1';
      button.style.cursor = button.disabled ? 'default' : 'pointer';
    }
  }

  async function sendProjectName(projectName) {
    const normalized = prompts.normalizeInline(projectName);
    if (!normalized) return;

    const config = await ensureConfig();
    if (!config) return;

    const text = prompts.projectContinuePrompt(normalized, config.projectText, new Date());
    const sent = await sendPrompt(text);
    if (sent) closeProjectPopover({ clear: true });
  }

  async function sendCustomProject() {
    if (!projectInput) return;
    await sendProjectName(projectInput.value);
  }

  function renderProjectList(projects = currentConfig?.projects || []) {
    if (!projectList) return;
    projectList.replaceChildren();
    projectButtons.length = 0;

    if (!projects.length) {
      const empty = document.createElement('div');
      empty.textContent = 'No saved projects';
      Object.assign(empty.style, {
        padding: '4px 2px',
        opacity: '.6'
      });
      projectList.append(empty);
      return;
    }

    for (const project of projects) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = project;
      button.setAttribute('aria-label', `Continue ${project}`);
      styleButton(button);
      Object.assign(button.style, {
        width: '100%',
        textAlign: 'left'
      });
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        sendProjectName(project);
      });
      projectButtons.push(button);
      projectList.append(button);
    }

    updateProjectSendState();
  }

  async function openProjectPopover() {
    if (!projectPopover) return;
    projectPopover.hidden = false;
    setEditorMode(false);
    const config = await ensureConfig();
    if (config) renderProjectList(config.projects);
    updateProjectSendState();
    positionProjectPopover();
  }

  async function openConfigEditor() {
    const config = await ensureConfig();
    if (!config || !editorTextarea) return;
    editorTextarea.value = configApi.serialize(config);
    setEditorError('');
    setEditorMode(true);
    positionProjectPopover();
  }

  function handleDocumentPointerDown(event) {
    if (!projectPopover || projectPopover.hidden) return;
    if (toolbar?.contains(event.target)) return;
    closeProjectPopover();
  }

  async function saveConfigEditor() {
    if (!editorTextarea) return;
    let parsed = null;
    try {
      parsed = JSON.parse(editorTextarea.value);
    } catch (error) {
      setEditorError(`Invalid JSON: ${error?.message || 'parse failed'}`);
      return;
    }

    try {
      currentConfig = await configApi.save(parsed);
      editorTextarea.value = configApi.serialize(currentConfig);
      renderProjectList(currentConfig.projects);
      setEditorMode(false);
      setStatus('Config saved.');
    } catch (error) {
      setEditorError(String(error?.message || 'Config could not be saved.'));
    }
  }

  function buildToolbar() {
    const root = document.createElement('div');
    root.id = TOOLBAR_ID;
    root.setAttribute('role', 'toolbar');
    root.setAttribute('aria-label', 'Quick Continue');
    Object.assign(root.style, {
      position: 'fixed',
      display: 'none',
      alignItems: 'center',
      gap: '4px',
      padding: '4px 5px',
      border: '1px solid var(--border-light, rgba(127,127,127,.28))',
      borderRadius: '9px',
      background: 'var(--main-surface-primary, #fff)',
      color: 'var(--text-primary, #111)',
      boxShadow: '0 4px 18px rgba(0,0,0,.14)',
      zIndex: '40',
      fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      fontSize: '11px',
      lineHeight: '1',
      whiteSpace: 'nowrap'
    });

    const continueButton = document.createElement('button');
    continueButton.type = 'button';
    continueButton.textContent = 'Continue';
    continueButton.setAttribute('aria-label', 'Send timestamped Continue');
    styleButton(continueButton);
    continueButton.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      sendContinue();
    });
    sendButtons.push(continueButton);
    root.append(continueButton);

    const projectButton = document.createElement('button');
    projectButton.type = 'button';
    projectButton.textContent = 'Project';
    projectButton.setAttribute('aria-label', 'Project Continue');
    styleButton(projectButton);
    projectButton.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!projectPopover) return;
      if (projectPopover.hidden) openProjectPopover();
      else closeProjectPopover();
    });
    root.append(projectButton);

    const time = document.createElement('span');
    time.setAttribute('aria-label', 'Current local time');
    Object.assign(time.style, {
      marginLeft: '2px',
      padding: '0 3px',
      opacity: '.65',
      fontVariantNumeric: 'tabular-nums'
    });
    root.append(time);
    clock = time;

    const statusNode = document.createElement('span');
    statusNode.hidden = true;
    statusNode.setAttribute('role', 'status');
    Object.assign(statusNode.style, {
      marginLeft: '2px',
      maxWidth: '180px',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
      opacity: '.72'
    });
    root.append(statusNode);
    status = statusNode;

    const popover = document.createElement('div');
    popover.hidden = true;
    popover.setAttribute('role', 'group');
    popover.setAttribute('aria-label', 'Project Continue');
    Object.assign(popover.style, {
      position: 'absolute',
      right: '0',
      bottom: 'calc(100% + 6px)',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'stretch',
      gap: '6px',
      minWidth: '250px',
      maxWidth: '330px',
      padding: '7px',
      border: '1px solid var(--border-light, rgba(127,127,127,.28))',
      borderRadius: '9px',
      background: 'var(--main-surface-primary, #fff)',
      color: 'var(--text-primary, #111)',
      boxShadow: '0 4px 18px rgba(0,0,0,.14)'
    });

    const header = document.createElement('div');
    Object.assign(header.style, {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: '8px'
    });

    const savedLabel = document.createElement('div');
    savedLabel.textContent = 'Projects';
    Object.assign(savedLabel.style, {
      padding: '1px 2px',
      opacity: '.62',
      fontWeight: '600'
    });
    header.append(savedLabel);

    const editButton = document.createElement('button');
    editButton.type = 'button';
    editButton.textContent = 'Edit';
    editButton.setAttribute('aria-label', 'Edit Quick Continue JSON');
    styleButton(editButton);
    Object.assign(editButton.style, {
      padding: '3px 6px',
      fontSize: '10px'
    });
    editButton.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      openConfigEditor();
    });
    header.append(editButton);
    popover.append(header);

    const browse = document.createElement('div');
    Object.assign(browse.style, {
      display: 'flex',
      flexDirection: 'column',
      gap: '6px'
    });
    browsePanel = browse;

    const list = document.createElement('div');
    Object.assign(list.style, {
      display: 'flex',
      flexDirection: 'column',
      gap: '3px',
      maxHeight: '190px',
      overflowY: 'auto'
    });
    browse.append(list);
    projectList = list;

    const divider = document.createElement('div');
    Object.assign(divider.style, {
      height: '1px',
      background: 'var(--border-light, rgba(127,127,127,.20))'
    });
    browse.append(divider);

    const customRow = document.createElement('div');
    Object.assign(customRow.style, {
      display: 'flex',
      alignItems: 'center',
      gap: '5px'
    });

    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'Other project…';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.setAttribute('aria-label', 'Other project name');
    Object.assign(input.style, {
      flex: '1',
      minWidth: '0',
      height: '27px',
      padding: '0 7px',
      border: '1px solid var(--border-light, rgba(127,127,127,.30))',
      borderRadius: '6px',
      outline: 'none',
      background: 'var(--main-surface-secondary, rgba(127,127,127,.08))',
      color: 'inherit',
      font: '12px system-ui, sans-serif'
    });
    input.addEventListener('input', updateProjectSendState);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        event.stopPropagation();
        sendCustomProject();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        closeProjectPopover();
      }
    });
    customRow.append(input);
    projectInput = input;

    const send = document.createElement('button');
    send.type = 'button';
    send.textContent = 'Send';
    send.setAttribute('aria-label', 'Send custom Project Continue');
    styleButton(send);
    send.disabled = true;
    send.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      sendCustomProject();
    });
    customRow.append(send);
    projectSend = send;
    browse.append(customRow);
    popover.append(browse);

    const editor = document.createElement('div');
    editor.hidden = true;
    Object.assign(editor.style, {
      display: 'flex',
      flexDirection: 'column',
      gap: '6px'
    });
    editorPanel = editor;

    const textarea = document.createElement('textarea');
    textarea.setAttribute('aria-label', 'Quick Continue JSON');
    textarea.spellcheck = false;
    Object.assign(textarea.style, {
      width: '300px',
      maxWidth: 'calc(100vw - 40px)',
      height: '220px',
      resize: 'both',
      padding: '7px',
      boxSizing: 'border-box',
      border: '1px solid var(--border-light, rgba(127,127,127,.30))',
      borderRadius: '6px',
      outline: 'none',
      background: 'var(--main-surface-secondary, rgba(127,127,127,.08))',
      color: 'inherit',
      font: '11px ui-monospace, SFMono-Regular, Consolas, monospace',
      lineHeight: '1.35',
      whiteSpace: 'pre'
    });
    textarea.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setEditorMode(false);
      }
    });
    editor.append(textarea);
    editorTextarea = textarea;

    const error = document.createElement('div');
    error.hidden = true;
    error.setAttribute('role', 'alert');
    Object.assign(error.style, {
      maxWidth: '300px',
      whiteSpace: 'normal',
      lineHeight: '1.25',
      opacity: '.82'
    });
    editor.append(error);
    editorError = error;

    const editorActions = document.createElement('div');
    Object.assign(editorActions.style, {
      display: 'flex',
      justifyContent: 'flex-end',
      gap: '5px'
    });

    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = 'Cancel';
    cancel.setAttribute('aria-label', 'Cancel JSON edit');
    styleButton(cancel);
    cancel.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      setEditorMode(false);
    });
    editorActions.append(cancel);

    const save = document.createElement('button');
    save.type = 'button';
    save.textContent = 'Save';
    save.setAttribute('aria-label', 'Save Quick Continue JSON');
    styleButton(save);
    save.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      saveConfigEditor();
    });
    editorActions.append(save);

    editor.append(editorActions);
    popover.append(editor);

    root.append(popover);
    projectPopover = popover;

    (document.body || document.documentElement).append(root);
    toolbar = root;
    return root;
  }

  function styleButton(button) {
    Object.assign(button.style, {
      border: '1px solid var(--border-light, rgba(127,127,127,.25))',
      borderRadius: '6px',
      padding: '5px 7px',
      background: 'var(--main-surface-secondary, rgba(127,127,127,.10))',
      color: 'inherit',
      font: 'inherit',
      fontWeight: '600',
      cursor: 'pointer'
    });
    button.addEventListener('mouseenter', () => {
      if (!button.disabled) button.style.background = 'var(--main-surface-tertiary, rgba(127,127,127,.18))';
    });
    button.addEventListener('mouseleave', () => {
      button.style.background = 'var(--main-surface-secondary, rgba(127,127,127,.10))';
    });
  }

  function updateAvailability(composer) {
    const hasDraft = Boolean(composer && composerText(composer));
    const unavailable = busy || !composer || hasDraft;
    for (const button of sendButtons) {
      button.disabled = unavailable;
      button.style.opacity = button.disabled ? '.45' : '1';
      button.style.cursor = button.disabled ? 'default' : 'pointer';
    }
    updateProjectSendState();
  }

  function observeGeometry(composer, anchor) {
    if (typeof ResizeObserver !== 'function') return;
    if (!resizeObserver) resizeObserver = new ResizeObserver(scheduleSync);

    if (observedComposer !== composer) {
      try { if (observedComposer) resizeObserver.unobserve(observedComposer); } catch {}
      observedComposer = composer || null;
      try { if (observedComposer) resizeObserver.observe(observedComposer); } catch {}
    }

    if (observedAnchor !== anchor) {
      try { if (observedAnchor && observedAnchor !== observedComposer) resizeObserver.unobserve(observedAnchor); } catch {}
      observedAnchor = anchor || null;
      try { if (observedAnchor && observedAnchor !== observedComposer) resizeObserver.observe(observedAnchor); } catch {}
    }
  }

  function suppressLegacyNotifierToolbar() {
    try {
      const legacy = document.getElementById('chatgpt-notifier-quick-prompts');
      if (legacy) legacy.remove();
    } catch {}
  }

  function scheduleToolbarHide(root) {
    if (toolbarHideTimer !== null) return;
    toolbarHideTimer = setTimeout(() => {
      toolbarHideTimer = null;
      const composer = composerElement();
      const anchor = composerAnchor(composer);
      if (!composer || !anchor || !visible(anchor)) root.style.display = 'none';
    }, 200);
  }

  function cancelToolbarHide() {
    if (toolbarHideTimer === null) return;
    clearTimeout(toolbarHideTimer);
    toolbarHideTimer = null;
  }

  function syncToolbar() {
    scheduled = null;
    suppressLegacyNotifierToolbar();
    const composer = composerElement();
    const anchor = composerAnchor(composer);
    const root = toolbar || buildToolbar();
    if (!root.isConnected) {
      try { (document.body || document.documentElement).append(root); } catch {}
    }
    observeGeometry(composer, anchor);

    if (!composer || !anchor || !visible(anchor)) {
      scheduleToolbarHide(root);
      return;
    }

    cancelToolbarHide();
    const now = new Date();
    updateAvailability(composer);
    if (clock) clock.textContent = formatClock(now);

    root.style.display = 'flex';
    const rect = anchor.getBoundingClientRect();
    const width = root.offsetWidth;
    const height = root.offsetHeight;
    const left = Math.max(8, Math.min(window.innerWidth - width - 8, rect.right - width));
    const top = Math.max(8, rect.top - height - 8);
    root.style.left = `${Math.round(left)}px`;
    root.style.top = `${Math.round(top)}px`;
    root.style.visibility = 'visible';
    positionProjectPopover();
  }

  function scheduleSync() {
    if (scheduled !== null) return;
    if (typeof requestAnimationFrame === 'function' && document.visibilityState !== 'hidden') {
      scheduledWithAnimationFrame = true;
      scheduled = requestAnimationFrame(syncToolbar);
    } else {
      scheduledWithAnimationFrame = false;
      scheduled = setTimeout(syncToolbar, 16);
    }
  }

  function notifierOnlyMutation(records) {
    const entries = Array.from(records || []);
    if (!entries.length) return false;
    return entries.every((record) => {
      const target = record?.target;
      const element = target?.nodeType === 1 ? target : target?.parentElement;
      try { return Boolean(element?.closest?.(NOTIFIER_MUTATION_SELECTOR)); } catch { return false; }
    });
  }

  function handleDocumentMutations(records) {
    if (notifierOnlyMutation(records)) return;
    scheduleSync();
  }

  unsubscribeConfig = configApi.subscribe((nextConfig) => {
    currentConfig = nextConfig;
    if (projectList && (!editorPanel || editorPanel.hidden)) renderProjectList(nextConfig.projects);
    updateProjectSendState();
  });

  ensureConfig();

  observer = new MutationObserver(handleDocumentMutations);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener('pointerdown', handleDocumentPointerDown, true);
  document.addEventListener('input', scheduleSync, { capture: true, passive: true });
  document.addEventListener('scroll', scheduleSync, { capture: true, passive: true });
  document.addEventListener('visibilitychange', scheduleSync, true);
  window.addEventListener('resize', scheduleSync, { passive: true });
  clockTimer = setInterval(scheduleSync, 30_000);

  globalThis.__chatgptQuickContinueRuntime = Object.freeze({
    version: RUNTIME_VERSION,
    dispose() {
      try { observer?.disconnect(); } catch {}
      try { resizeObserver?.disconnect(); } catch {}
      try { unsubscribeConfig?.(); } catch {}
      try {
        if (scheduled !== null) {
          if (scheduledWithAnimationFrame && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(scheduled);
          else clearTimeout(scheduled);
        }
      } catch {}
      try { if (clockTimer !== null) clearInterval(clockTimer); } catch {}
      try { if (toolbarHideTimer !== null) clearTimeout(toolbarHideTimer); } catch {}
      try { if (statusTimer !== null) clearTimeout(statusTimer); } catch {}
      try { document.removeEventListener('pointerdown', handleDocumentPointerDown, true); } catch {}
      try { document.removeEventListener('input', scheduleSync, true); } catch {}
      try { document.removeEventListener('scroll', scheduleSync, true); } catch {}
      try { document.removeEventListener('visibilitychange', scheduleSync, true); } catch {}
      try { window.removeEventListener('resize', scheduleSync); } catch {}
      try { toolbar?.remove(); } catch {}
    }
  });

  scheduleSync();
})();
