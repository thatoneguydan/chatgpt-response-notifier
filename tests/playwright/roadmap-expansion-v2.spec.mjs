import {
  test,
  expect,
  evaluateInExtensionWorld
} from './extension-fixture.mjs';

const toolbarSelector = '#chatgpt-quick-continue-toolbar';
const fixtureConversationId = 'playwright-browser-regression';
const workerEntryPaths = Object.freeze({
  'ChatGPT Quick Continue': 'background.js',
  'ChatGPT Response Notifier': 'diagnostics-bootstrap.js'
});
let nestedCdpCommandId = 0;

async function expectTrafficInert(traffic) {
  const blocked = traffic.filter((entry) => entry.kind === 'blocked');
  expect(blocked, `Unexpected ChatGPT network attempts: ${JSON.stringify(blocked)}`).toEqual([]);
}

async function extensionWorkerDescriptor(page, extensionName) {
  const workerPath = workerEntryPaths[extensionName];
  if (!workerPath) throw new Error(`Unknown extension worker path: ${extensionName}`);
  const extensionId = await evaluateInExtensionWorld(
    page,
    extensionName,
    `String(globalThis.chrome?.runtime?.id || '')`
  );
  if (!extensionId) throw new Error(`Could not resolve extension ID: ${extensionName}`);
  return {
    extensionName,
    extensionId,
    workerPath,
    workerUrl: `chrome-extension://${extensionId}/${workerPath}`
  };
}

async function findWorkerTarget(rootSession, workerUrl, timeout = 10_000) {
  let target = null;
  let diagnostics = [];
  await expect.poll(async () => {
    const { targetInfos = [] } = await rootSession.send('Target.getTargets');
    diagnostics = targetInfos
      .filter((candidate) => candidate.type === 'service_worker')
      .map((candidate) => ({
        targetId: candidate.targetId,
        url: candidate.url,
        attached: candidate.attached === true
      }));
    target = targetInfos.find((candidate) =>
      candidate.type === 'service_worker' && candidate.url === workerUrl
    ) || null;
    return Boolean(target);
  }, {
    timeout,
    message: `MV3 service-worker target not found for ${workerUrl}. Last workers: ${JSON.stringify(diagnostics)}`
  }).toBe(true);
  return target;
}

async function sendNestedCdpCommand(rootSession, sessionId, method, params = {}, timeout = 10_000) {
  const id = ++nestedCdpCommandId;
  return await new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rootSession.off('Target.receivedMessageFromTarget', onMessage);
    };
    const finish = (callback, value) => {
      cleanup();
      callback(value);
    };
    const onMessage = (event) => {
      if (String(event?.sessionId || '') !== String(sessionId || '')) return;
      let payload;
      try { payload = JSON.parse(String(event?.message || '')); }
      catch { return; }
      if (payload?.id !== id) return;
      if (payload?.error) {
        finish(reject, new Error(`CDP ${method} failed: ${String(payload.error.message || payload.error.code || 'unknown')}`));
        return;
      }
      finish(resolve, payload?.result || {});
    };
    const timer = setTimeout(() => {
      finish(reject, new Error(`Timed out waiting for nested CDP command ${method}.`));
    }, timeout);

    rootSession.on('Target.receivedMessageFromTarget', onMessage);
    rootSession.send('Target.sendMessageToTarget', {
      sessionId,
      message: JSON.stringify({ id, method, params })
    }).catch((error) => finish(reject, error));
  });
}

async function evaluateInExtensionWorker(page, extensionName, expression, { timeout = 10_000 } = {}) {
  const browser = page.context().browser();
  if (!browser) throw new Error('Playwright browser instance unavailable for MV3 worker inspection.');
  const descriptor = await extensionWorkerDescriptor(page, extensionName);
  const rootSession = await browser.newBrowserCDPSession();
  let sessionId = '';
  try {
    const target = await findWorkerTarget(rootSession, descriptor.workerUrl, timeout);
    const attached = await rootSession.send('Target.attachToTarget', {
      targetId: target.targetId,
      flatten: false
    });
    sessionId = String(attached?.sessionId || '');
    if (!sessionId) throw new Error(`Could not attach to MV3 service worker: ${descriptor.workerUrl}`);

    const evaluated = await sendNestedCdpCommand(rootSession, sessionId, 'Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true
    }, timeout);
    if (evaluated?.exceptionDetails) {
      throw new Error(
        evaluated.exceptionDetails.exception?.description
        || evaluated.exceptionDetails.text
        || `MV3 worker evaluation failed: ${extensionName}`
      );
    }
    return evaluated?.result?.value;
  } finally {
    if (sessionId) {
      await rootSession.send('Target.detachFromTarget', { sessionId }).catch(() => {});
    }
    await rootSession.detach().catch(() => {});
  }
}

async function notifierWatchdog(page, conversationId = fixtureConversationId) {
  const id = JSON.stringify(conversationId);
  return evaluateInExtensionWorker(page, 'ChatGPT Response Notifier', `(async () => {
    const monitor = globalThis.__chatgptNotifierMonitorBackground;
    if (typeof monitor?.readCodeWatchdog !== 'function') {
      throw new Error('Notifier watchdog runtime unavailable in service worker.');
    }
    return await monitor.readCodeWatchdog(${id});
  })()`);
}

async function prepareNonTerminalNotifier(page) {
  await page.evaluate(() => {
    const wrapper = document.querySelector('[data-testid="conversation-turn-1"]');
    wrapper?.querySelector('.rendered-footer')?.remove();
    const markdown = wrapper?.querySelector('.markdown');
    if (markdown) markdown.textContent = 'Browser-level work is still in progress.';
  });

  const conversationId = JSON.stringify(fixtureConversationId);
  await evaluateInExtensionWorker(page, 'ChatGPT Response Notifier', `(async () => {
    const id = ${conversationId};
    const tabs = await chrome.tabs.query({ url: ['https://chatgpt.com/*'] });
    const tab = tabs.find((candidate) => {
      try { return new URL(String(candidate?.url || '')).pathname === '/c/' + id; }
      catch { return false; }
    });
    if (!Number.isInteger(tab?.id)) throw new Error('Playwright ChatGPT fixture tab not found.');
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['status-code.js', 'status-policy.js', 'status-script.js']
    });
    return { tabId: tab.id };
  })()`);

  let promptKey = '';
  await expect.poll(async () => {
    const snapshot = await evaluateInExtensionWorld(page, 'ChatGPT Response Notifier', `(() => {
      const value = globalThis.__chatgptNotifierStatusDom?.latestAssistantSnapshot?.() || {};
      return {
        statusCode: String(value.statusCode || ''),
        promptKey: String(value.promptKey || '')
      };
    })()`);
    promptKey = String(snapshot?.promptKey || '');
    return {
      statusCode: String(snapshot?.statusCode || ''),
      hasPromptKey: Boolean(promptKey)
    };
  }, { timeout: 10_000 }).toEqual({ statusCode: '', hasPromptKey: true });
  return promptKey;
}

async function seedEnabledWatchdog(page, promptKey, { due = false } = {}) {
  const input = JSON.stringify({
    conversationId: fixtureConversationId,
    promptKey,
    due
  });
  return evaluateInExtensionWorker(page, 'ChatGPT Response Notifier', `(async () => {
    const command = ${input};
    const conversationId = String(command.conversationId || '');
    const promptKey = String(command.promptKey || '');
    const monitor = globalThis.__chatgptNotifierMonitorBackground;
    if (!conversationId || !promptKey) throw new Error('Missing notifier watchdog seed identity.');
    if (
      typeof monitor?.setEnrollment !== 'function'
      || typeof monitor?.armCodeWatchdogForTarget !== 'function'
      || typeof monitor?.readCodeWatchdog !== 'function'
    ) {
      throw new Error('Notifier monitor runtime unavailable in service worker.');
    }

    const tabs = await chrome.tabs.query({ url: ['https://chatgpt.com/*'] });
    const tab = tabs.find((candidate) => {
      try { return new URL(String(candidate?.url || '')).pathname === '/c/' + conversationId; }
      catch { return false; }
    });
    if (!Number.isInteger(tab?.id)) throw new Error('Playwright ChatGPT fixture tab not found for watchdog seed.');
    const target = {
      id: conversationId,
      url: String(tab.url || ('https://chatgpt.com/c/' + conversationId)),
      tab
    };

    await monitor.setEnrollment(target, true, 'playwright-browser-regression');
    const armed = await monitor.armCodeWatchdogForTarget({
      conversationId,
      promptKey,
      source: 'playwright-browser-regression',
      requestId: 'playwright-watchdog-seed'
    }, target);
    if (armed?.ok !== true) {
      throw new Error('Could not arm notifier watchdog: ' + String(armed?.reason || armed?.error || 'unknown'));
    }

    if (command.due === true) {
      const key = 'code-watchdog:' + conversationId;
      const database = await new Promise((resolve, reject) => {
        const request = indexedDB.open('chatgpt-response-notifier-monitor', 1);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error('Could not open notifier watchdog database.'));
      });
      try {
        await new Promise((resolve, reject) => {
          const transaction = database.transaction('profile', 'readwrite');
          const store = transaction.objectStore('profile');
          const request = store.get(key);
          request.onsuccess = () => {
            const current = request.result || null;
            if (!current) {
              reject(new Error('Notifier watchdog record missing before due seed.'));
              try { transaction.abort(); } catch {}
              return;
            }
            store.put({
              ...current,
              deadlineAt: Date.now() - 1000,
              retryAt: 0,
              retryReason: '',
              stopped: false,
              stopReason: '',
              watchdogRevision: Math.max(0, Number(current.watchdogRevision || 0)) + 1,
              updatedAt: Date.now()
            });
          };
          request.onerror = () => reject(request.error || new Error('Could not read notifier watchdog record.'));
          transaction.oncomplete = resolve;
          transaction.onerror = () => reject(transaction.error || new Error('Could not seed due notifier watchdog record.'));
          transaction.onabort = () => reject(transaction.error || new Error('Due notifier watchdog seed was aborted.'));
        });
      } finally {
        try { database.close(); } catch {}
      }
    }

    return await monitor.readCodeWatchdog(conversationId);
  })()`);
}

async function forceTerminalStop(page, promptKey, statusCode) {
  const input = JSON.stringify({
    conversationId: fixtureConversationId,
    promptKey,
    statusCode
  });
  return evaluateInExtensionWorker(page, 'ChatGPT Response Notifier', `(async () => {
    const command = ${input};
    const authority = globalThis.__chatgptNotifierWatchdogAuthorityV3;
    if (typeof authority?.forceTerminalStop !== 'function') {
      throw new Error('Notifier terminal-stop authority unavailable in service worker.');
    }
    const tabs = await chrome.tabs.query({ url: ['https://chatgpt.com/*'] });
    const tab = tabs.find((candidate) => {
      try { return new URL(String(candidate?.url || '')).pathname === '/c/' + command.conversationId; }
      catch { return false; }
    });
    if (!Number.isInteger(tab?.id)) throw new Error('Playwright ChatGPT fixture tab not found for terminal stop.');
    return await authority.forceTerminalStop({
      conversationId: command.conversationId,
      promptKey: command.promptKey,
      statusCode: command.statusCode,
      requestStartedAt: 0
    }, { tab });
  })()`);
}

async function runDueWatchdog(page) {
  const conversationId = JSON.stringify(fixtureConversationId);
  return evaluateInExtensionWorker(page, 'ChatGPT Response Notifier', `(async () => {
    const id = ${conversationId};
    const authority = globalThis.__chatgptNotifierWatchdogAuthorityV3;
    if (typeof authority?.runDueWatchdogNow !== 'function') {
      throw new Error('Notifier watchdog-run authority unavailable in service worker.');
    }
    const tabs = await chrome.tabs.query({ url: ['https://chatgpt.com/*'] });
    const tab = tabs.find((candidate) => {
      try { return new URL(String(candidate?.url || '')).pathname === '/c/' + id; }
      catch { return false; }
    });
    if (!Number.isInteger(tab?.id)) throw new Error('Playwright ChatGPT fixture tab not found for watchdog run.');
    return await authority.runDueWatchdogNow({ conversationId: id }, { tab });
  })()`);
}

test('recovers the same Quick Continue toolbar owner after external host detachment', async ({ fixturePage, chatgptTraffic }) => {
  const toolbar = fixturePage.locator(toolbarSelector);
  await expect(toolbar).toBeVisible();
  const original = await fixturePage.evaluateHandle(() => document.getElementById('chatgpt-quick-continue-toolbar'));

  await fixturePage.evaluate(() => document.getElementById('chatgpt-quick-continue-toolbar')?.remove());
  await expect(toolbar).toHaveCount(1);
  await expect(toolbar).toBeVisible();
  await fixturePage.waitForTimeout(400);
  expect(await fixturePage.evaluate(
    (node) => node === document.getElementById('chatgpt-quick-continue-toolbar') && node?.isConnected === true,
    original
  )).toBe(true);
  await expectTrafficInert(chatgptTraffic);
});

test('send transaction survives composer replacement during edit commit and same-conversation navigation', async ({ fixturePage, chatgptTraffic }) => {
  await fixturePage.evaluate(() => {
    const composer = document.querySelector('#prompt-textarea');
    composer?.addEventListener('input', () => {
      window.__fixture.remountComposer();
      history.pushState({}, '', '/c/playwright-browser-regression?during-send=1');
    }, { once: true });
  });

  const result = await evaluateInExtensionWorld(fixturePage, 'ChatGPT Quick Continue', `(async () => {
    const composer = document.querySelector('#prompt-textarea');
    return await globalThis.ChatGPTQuickContinueSend.submit(
      composer,
      'Playwright remount-safe transaction',
      { replace: true, timeoutMs: 4000 }
    );
  })()`);

  const submissions = await fixturePage.evaluate(() => window.__fixture.submits);
  expect(result).toMatchObject({ ok: true, reason: 'sent', activated: true });
  expect(submissions).toHaveLength(1);
  expect(submissions[0].text).toBe('Playwright remount-safe transaction');
  expect(submissions[0].generation).toBeGreaterThan(1);
  expect(new URL(fixturePage.url()).searchParams.get('during-send')).toBe('1');
  await expectTrafficInert(chatgptTraffic);
});

test('terminal detector remains same-turn bounded after assistant wrapper replacement', async ({ fixturePage, chatgptTraffic }) => {
  await fixturePage.evaluate(() => {
    const wrapper = document.querySelector('[data-testid="conversation-turn-1"]');
    wrapper.replaceChildren();
    const surface = document.createElement('div');
    surface.className = 'assistant-surface';
    const semantic = document.createElement('article');
    semantic.dataset.messageAuthorRole = 'assistant';
    const prose = document.createElement('div');
    prose.className = 'markdown prose';
    prose.textContent = 'Browser-level work completed.';
    semantic.append(prose);
    const footer = document.createElement('div');
    footer.className = 'rendered-footer';
    footer.textContent = '[GITHUB_STATUS: COMPLETE_APPLIED]';
    surface.append(semantic, footer);
    wrapper.append(surface);

    const neighboringUser = document.createElement('section');
    neighboringUser.dataset.testid = 'conversation-turn-neighbor-user';
    const role = document.createElement('div');
    role.dataset.messageAuthorRole = 'user';
    role.textContent = '[GITHUB_STATUS: BLOCKED_HUMAN]';
    neighboringUser.append(role);
    wrapper.after(neighboringUser);
  });

  const detection = await evaluateInExtensionWorld(fixturePage, 'ChatGPT Response Notifier', `(() => {
    const api = globalThis.ChatGPTNotifierRenderedTerminalStatus;
    const wrapper = document.querySelector('[data-testid="conversation-turn-1"]');
    const semanticAssistant = wrapper?.querySelector('[data-message-author-role="assistant"]');
    return {
      wrapper: String(api?.detect?.(wrapper) || ''),
      semanticAssistant: String(api?.detect?.(semanticAssistant) || '')
    };
  })()`);

  expect(detection).toEqual({
    wrapper: 'COMPLETE_APPLIED',
    semanticAssistant: 'COMPLETE_APPLIED'
  });
  await expectTrafficInert(chatgptTraffic);
});

test('Quick Continue MV3 worker naturally suspends and wakes without rebuilding live page UI', async ({ fixturePage, chatgptTraffic }) => {
  test.setTimeout(120_000);
  const toolbar = fixturePage.locator(toolbarSelector);
  await expect(toolbar).toBeVisible();
  const original = await fixturePage.evaluateHandle(() => document.getElementById('chatgpt-quick-continue-toolbar'));
  const beforeRuntime = await evaluateInExtensionWorld(fixturePage, 'ChatGPT Quick Continue', `(() => ({
    runtimeVersion: Number(globalThis.__chatgptQuickContinueRuntime?.version || 0),
    hoverVersion: Number(globalThis.__chatgptQuickContinueHoverEditRuntime?.version || 0)
  }))()`);

  const beforeWorker = await evaluateInExtensionWorker(fixturePage, 'ChatGPT Quick Continue', `(() => {
    const sentinel = Date.now() + '-' + Math.random().toString(36).slice(2);
    globalThis.__playwrightMv3IdleSentinel = sentinel;
    chrome.alarms.create('playwright-mv3-idle-wake', { delayInMinutes: 0.75 });
    return {
      extensionName: String(chrome.runtime.getManifest().name || ''),
      sentinel
    };
  })()`);
  expect(beforeWorker.extensionName).toBe('ChatGPT Quick Continue');
  expect(String(beforeWorker.sentinel || '')).not.toBe('');

  // The debugger detaches immediately. Chrome can then suspend the idle worker;
  // a one-shot extension alarm wakes production background.js without touching
  // page DOM. Losing the worker-global sentinel proves a real MV3 recreation.
  await fixturePage.waitForTimeout(50_000);
  const afterWorker = await evaluateInExtensionWorker(
    fixturePage,
    'ChatGPT Quick Continue',
    `(() => ({
      extensionName: String(chrome.runtime.getManifest().name || ''),
      sentinel: String(globalThis.__playwrightMv3IdleSentinel || '')
    }))()`,
    { timeout: 15_000 }
  );
  expect(afterWorker.extensionName).toBe('ChatGPT Quick Continue');
  expect(afterWorker.sentinel).toBe('');

  await fixturePage.waitForTimeout(500);
  const afterRuntime = await evaluateInExtensionWorld(fixturePage, 'ChatGPT Quick Continue', `(() => ({
    runtimeVersion: Number(globalThis.__chatgptQuickContinueRuntime?.version || 0),
    hoverVersion: Number(globalThis.__chatgptQuickContinueHoverEditRuntime?.version || 0)
  }))()`);
  expect(await fixturePage.evaluate(
    (node) => node === document.getElementById('chatgpt-quick-continue-toolbar') && node?.isConnected === true,
    original
  )).toBe(true);
  expect(afterRuntime).toEqual(beforeRuntime);
  await expect(toolbar).toHaveCount(1);
  await expect(toolbar).toBeVisible();
  await expectTrafficInert(chatgptTraffic);
});

test('terminal stop rejects a superseded prompt then persists the rendered definitive stop', async ({ fixturePage, chatgptTraffic }) => {
  const promptKey = await prepareNonTerminalNotifier(fixturePage);
  const armed = await seedEnabledWatchdog(fixturePage, promptKey);
  expect(String(armed?.lastPromptKey || '')).toBe(promptKey);

  const rejected = await forceTerminalStop(fixturePage, `${promptKey}-superseded`, 'COMPLETE_APPLIED');
  expect(rejected).toMatchObject({ ok: false, reason: 'terminal-prompt-superseded' });
  expect((await notifierWatchdog(fixturePage))?.stopped === true).toBe(false);

  await fixturePage.evaluate(() => {
    const wrapper = document.querySelector('[data-testid="conversation-turn-1"]');
    const footer = document.createElement('div');
    footer.className = 'rendered-footer';
    footer.textContent = '[GITHUB_STATUS: COMPLETE_APPLIED]';
    wrapper?.append(footer);
  });

  await expect.poll(async () => {
    const watchdog = await notifierWatchdog(fixturePage);
    return {
      stopped: watchdog?.stopped === true,
      stopReason: String(watchdog?.stopReason || ''),
      deadlineAt: Math.max(0, Number(watchdog?.deadlineAt || 0)),
      retryAt: Math.max(0, Number(watchdog?.retryAt || 0)),
      sendCount: Math.max(0, Number(watchdog?.sendCount || 0))
    };
  }, { timeout: 10_000 }).toEqual({
    stopped: true,
    stopReason: 'status:COMPLETE_APPLIED',
    deadlineAt: 0,
    retryAt: 0,
    sendCount: 0
  });
  await expectTrafficInert(chatgptTraffic);
});

test('due watchdog sends exactly once and reserves the next 30-minute cadence before replay', async ({ fixturePage, chatgptTraffic }) => {
  const promptKey = await prepareNonTerminalNotifier(fixturePage);
  const seeded = await seedEnabledWatchdog(fixturePage, promptKey, { due: true });
  expect(Math.max(0, Number(seeded?.deadlineAt || 0))).toBeLessThanOrEqual(Date.now());

  const first = await runDueWatchdog(fixturePage);
  expect(first).toMatchObject({ ok: true, ran: true });

  await expect.poll(() => fixturePage.evaluate(() => window.__fixture.submits.length), { timeout: 10_000 }).toBe(1);
  const firstSubmissions = await fixturePage.evaluate(() => window.__fixture.submits.map((entry) => entry.text));
  expect(firstSubmissions[0]).toContain('Continue until you finish or need something from me.');

  const afterFirst = await notifierWatchdog(fixturePage);
  expect(Math.max(0, Number(afterFirst?.sendCount || 0))).toBe(1);
  expect(Math.max(0, Number(afterFirst?.retryAt || 0))).toBe(0);
  expect(Math.max(0, Number(afterFirst?.deadlineAt || 0))).toBeGreaterThan(Date.now() + 20 * 60_000);

  const second = await runDueWatchdog(fixturePage);
  expect(second).toMatchObject({ ok: true, ran: false, reason: 'watchdog-not-due' });
  await fixturePage.waitForTimeout(1000);
  expect(await fixturePage.evaluate(() => window.__fixture.submits.length)).toBe(1);
  await expectTrafficInert(chatgptTraffic);
});
