'use strict';

(() => {
  const RUNTIME_VERSION = 1;
  const previousRuntime = globalThis.__chatgptQuickContinueHoverEditRuntime;
  if (Number(previousRuntime?.version || 0) === RUNTIME_VERSION) return;
  try { previousRuntime?.dispose?.(); } catch {}

  const TOOLBAR_ID = 'chatgpt-quick-continue-toolbar';
  const EDIT_BUTTON_ID = 'chatgpt-quick-continue-hover-edit';
  const TARGET_SELECTOR = [
    'button[aria-label="Send timestamped Continue"]',
    'button[aria-label="Project Continue"]'
  ].join(',');
  const HOVER_DELAY_MS = 700;
  const HIDE_DELAY_MS = 260;

  let observer = null;
  let toolbar = null;
  let editButton = null;
  let activeTarget = null;
  let hoverTimer = null;
  let hideTimer = null;

  function clearHoverTimer() {
    if (hoverTimer === null) return;
    clearTimeout(hoverTimer);
    hoverTimer = null;
  }

  function clearHideTimer() {
    if (hideTimer === null) return;
    clearTimeout(hideTimer);
    hideTimer = null;
  }

  function hideEditButton() {
    clearHoverTimer();
    clearHideTimer();
    activeTarget = null;
    if (editButton) editButton.hidden = true;
  }

  function scheduleHide() {
    clearHideTimer();
    hideTimer = setTimeout(() => {
      hideTimer = null;
      try {
        if (activeTarget?.matches?.(':hover') || editButton?.matches?.(':hover')) return;
      } catch {}
      hideEditButton();
    }, HIDE_DELAY_MS);
  }

  function styleEditButton(button) {
    Object.assign(button.style, {
      border: '1px solid var(--border-light, rgba(127,127,127,.25))',
      borderRadius: '6px',
      padding: '4px 6px',
      background: 'var(--main-surface-secondary, rgba(127,127,127,.10))',
      color: 'inherit',
      font: 'inherit',
      fontWeight: '600',
      fontSize: '10px',
      lineHeight: '1',
      cursor: 'pointer'
    });
  }

  function openConfigEditor() {
    const root = toolbar;
    if (!root?.isConnected) return;

    const projectButton = root.querySelector('button[aria-label="Project Continue"]');
    const projectPopover = root.querySelector('[role="group"][aria-label="Project Continue"]');
    const configEditButton = root.querySelector('button[aria-label="Edit Quick Continue JSON"]');
    if (!projectButton || !projectPopover || !configEditButton) return;

    if (projectPopover.hidden) projectButton.click();
    setTimeout(() => {
      try {
        root.querySelector('button[aria-label="Edit Quick Continue JSON"]')?.click();
      } catch {}
    }, 0);
  }

  function ensureEditButton() {
    if (editButton?.isConnected || editButton) return editButton;

    const button = document.createElement('button');
    button.id = EDIT_BUTTON_ID;
    button.type = 'button';
    button.textContent = 'Edit';
    button.hidden = true;
    button.setAttribute('aria-label', 'Edit Continue and Project text');
    styleEditButton(button);

    button.addEventListener('pointerenter', () => {
      clearHoverTimer();
      clearHideTimer();
      button.style.background = 'var(--main-surface-tertiary, rgba(127,127,127,.18))';
    });
    button.addEventListener('pointerleave', () => {
      button.style.background = 'var(--main-surface-secondary, rgba(127,127,127,.10))';
      scheduleHide();
    });
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      openConfigEditor();
      hideEditButton();
    });

    editButton = button;
    return editButton;
  }

  function revealFor(target) {
    if (!toolbar?.isConnected || !target?.isConnected || !toolbar.contains(target)) return;
    const button = ensureEditButton();
    activeTarget = target;
    target.insertAdjacentElement('afterend', button);
    button.hidden = false;
  }

  function scheduleReveal(target) {
    clearHoverTimer();
    clearHideTimer();
    activeTarget = target;
    hoverTimer = setTimeout(() => {
      hoverTimer = null;
      revealFor(target);
    }, HOVER_DELAY_MS);
  }

  function targetFromEvent(event) {
    const node = event?.target;
    if (!(node instanceof Element)) return null;
    const target = node.closest(TARGET_SELECTOR);
    if (!target || !toolbar?.contains(target)) return null;
    return target;
  }

  function handlePointerOver(event) {
    const target = targetFromEvent(event);
    if (!target) return;
    if (target === activeTarget && editButton && !editButton.hidden) {
      clearHideTimer();
      return;
    }
    scheduleReveal(target);
  }

  function handlePointerOut(event) {
    const target = targetFromEvent(event);
    if (!target || target !== activeTarget) return;
    const related = event.relatedTarget;
    if (related && (target.contains(related) || editButton === related || editButton?.contains?.(related))) return;
    scheduleHide();
  }

  function detachToolbar() {
    clearHoverTimer();
    clearHideTimer();
    activeTarget = null;
    if (toolbar) {
      try { toolbar.removeEventListener('pointerover', handlePointerOver); } catch {}
      try { toolbar.removeEventListener('pointerout', handlePointerOut); } catch {}
      try { toolbar.removeEventListener('pointerleave', scheduleHide); } catch {}
    }
    try { editButton?.remove(); } catch {}
    editButton = null;
    toolbar = null;
  }

  function attachToolbar(nextToolbar) {
    if (!nextToolbar || nextToolbar === toolbar) return;
    detachToolbar();
    toolbar = nextToolbar;
    toolbar.addEventListener('pointerover', handlePointerOver);
    toolbar.addEventListener('pointerout', handlePointerOut);
    toolbar.addEventListener('pointerleave', scheduleHide);
  }

  function syncToolbar() {
    const nextToolbar = document.getElementById(TOOLBAR_ID);
    if (nextToolbar === toolbar) return;
    if (nextToolbar) attachToolbar(nextToolbar);
    else detachToolbar();
  }

  observer = new MutationObserver(syncToolbar);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  syncToolbar();

  globalThis.__chatgptQuickContinueHoverEditRuntime = Object.freeze({
    version: RUNTIME_VERSION,
    dispose() {
      try { observer?.disconnect(); } catch {}
      detachToolbar();
    }
  });
})();
