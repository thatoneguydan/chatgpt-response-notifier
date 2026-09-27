# Playwright browser-regression roadmap — 2026-09-27

Canonical hierarchy: **ChatGPT Response Notifier → Workstream 4/6 — Reliable Background Automation → Stage 3/3 — Browser Integration Regression Harness**.

**Initial stage gate: COMPLETE.** The first traffic-inert browser suite is green on Glass, existing source/installer validation is green, Chrome Web Store package validation is green, and the Playwright workflow remains a separate CI gate so deterministic source validation stays fast and browser failures remain easy to attribute. The unchecked items below are deliberate follow-on expansion, not blockers for the initial Stage 3/3 acceptance boundary.

This stage extends the existing deterministic/state-machine test architecture. It does **not** replace it and it does **not** move Playwright into either extension's production runtime. The purpose is to close the recurring gap between source-level tests and real Chromium DOM/MV3 behavior.

## Design contract

- Run the actual `extension/` and `standalone-quick-continue/` MV3 payloads in Playwright's bundled Chromium through a persistent browser context.
- Keep ordinary browser regressions completely traffic-inert with respect to ChatGPT. The harness serves an intercepted `https://chatgpt.com/c/playwright-browser-regression` fixture and blocks every other ChatGPT/OpenAI request it sees.
- Preserve deterministic Node tests as the primary authority for watchdog cadence, attempt accounting, durable ownership, recovery budgets, terminal policy and other state-machine invariants.
- Use browser regressions for integration boundaries that Node fixtures cannot faithfully prove: content-script injection, DOM remounts, SPA navigation, trusted keyboard behavior, browser-native form submission, isolated extension worlds and MV3 service workers.
- Keep Windows/Glass physical acceptance only for OS boundaries Playwright cannot prove: virtual desktops, native notifications/chimes, Chrome crashes, real-profile registration/update handoff and Windows process behavior.
- Every expensive browser regression found in the field should receive the smallest deterministic reproducer at the lowest useful layer. Add a Playwright case when the failure depends on Chromium/DOM/MV3 semantics.

## Step 1/4 — Establish the traffic-inert MV3 harness

**Gate 1/1:** Both production extensions load together in headless bundled Chromium without a ChatGPT backend request.

- [x] Pin `@playwright/test` to a reviewed version rather than floating `latest`.
- [x] Launch a temporary persistent Chromium profile with both unpacked production extension roots.
- [x] Serve the ChatGPT fixture by network interception while blocking all other ChatGPT/OpenAI requests.
- [x] Assert both MV3 service workers and the real Quick Continue toolbar are present.
- [x] Retain traces/screenshots only on failure; never reuse the operator's Chrome profile for routine CI.

## Step 2/4 — Convert known browser failures into regressions

**Gate 1/1:** The first suite proves browser behaviors that recently escaped deterministic tests.

- [x] Toolbar remains a singleton and the same DOM owner across repeated composer remounts and SPA history transitions.
- [x] The production Continue prompt/send transaction performs exactly one browser-native form submission and cannot double-send from the extension path.
- [x] Trusted manual Enter with timestamps preserves exactly one logical newline between two lines and sends once.
- [x] The notifier's production rendered-terminal detector sees `COMPLETE_APPLIED` when the footer is a sibling of the semantic assistant marker inside the same turn wrapper.
- [ ] Add explicit MV3 worker stop/wake coverage once a stable Chromium DevTools control path is proven not to introduce false lifecycle behavior.
- [ ] Add guarded watchdog/browser integration cases only where they can remain traffic-inert and cannot create production ChatGPT actions.

## Step 3/4 — Make browser regressions automatic CI authority

**Gate 1/1:** Same-repository pull requests execute the suite on the isolated Glass self-hosted runner with no operator clicks.

- [x] Add a dedicated pull-request/workflow-dispatch workflow using `[self-hosted, Windows, X64, glass-builder]`.
- [x] Verify exact checked-out source SHA before running tests.
- [x] Install the pinned Playwright dependency and bundled Chromium automatically.
- [x] Upload Playwright failure traces as short-retention evidence.
- [x] Keep Playwright as a separate CI gate from source validation so deterministic validation remains fast and failures remain attributable.

## Step 4/4 — Expand only from demonstrated value

**Gate 1/1:** Browser coverage grows from real failure classes without becoming a brittle reimplementation of ChatGPT.

- [ ] Add fixture variants for assistant-turn wrapper changes, composer replacement during edit commit, toolbar host replacement and navigation while a request is active.
- [ ] Add browser-level assertions for terminal-stop acknowledgement/retry boundaries where the required background state can be seeded safely without a live account.
- [ ] Keep the fixture intentionally minimal. Do not clone ChatGPT UI or chase unrelated layout changes.
- [ ] Track false positives, runtime and maintenance burden. If a browser case is flaky, either make the environmental dependency explicit and deterministic or demote/remove it; do not normalize retries as success.
- [ ] Maintain a small physical Glass acceptance matrix for OS-only behavior rather than attempting to force those boundaries into Playwright.

## Acceptance boundary

Stage 3/3 initial acceptance is complete when the initial Playwright suite is green on the exact PR head, the workflow is automatic and traffic-inert, and its regression cases demonstrably exercise the production extension payloads rather than copied test-only implementations. No user-account/manual testing is required for this stage's initial gate. Real Windows notification/virtual-desktop behavior remains covered by the existing Glass acceptance paths.

## Dependency choice

Initial implementation pins **Playwright 1.63.0**. As of 2026-09-27 it is the current stable release, and Playwright documents headless Chrome-extension support by launching bundled Chromium with a persistent context and the `chromium` channel. Upgrade deliberately when browser compatibility or a needed testing capability justifies it; do not float versions in CI.
