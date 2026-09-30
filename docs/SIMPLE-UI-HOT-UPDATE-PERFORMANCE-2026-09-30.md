# Simple controls, hot update cleanup and page performance

Canonical baseline: `79bf64aa99aa45097bb308fd136e79fdb9faa14b` on `main`.
Work branch: `fix/simple-ui-hot-update-lag-20260930`.
Candidates: Quick Continue **1.2.30**, notifier **0.9.99**.

## Request and implementation

- Place Simple between Continue and Project; represent its enabled state with the existing green highlight and remove routine on/off status messages.
- Start Simple's persisted deadline from the click, without smart enrollment, request-start evidence, response state or terminal-code conditions. Display Simple's own timer immediately. Allow a new unsaved chat to start, then bind its first saved ID while retaining the deadline. Disable on subsequent conversation changes.
- Position the JSON frame using the combined bounds of the toolbar and visible timer rows, including wrapped rows. Observe row geometry while the frame is open.
- Retire old page closures before any new runtime/API loads. The existing runtime-reset file owns a DOM event and a registry of real disposers so inaccessible globals cannot strand observers/listeners. Disposed runtimes reject queued and late async UI writes. Remove stale toolbar DOM on the next singleton mount.
- Separate toolbar positioning from draft/availability reads. Scroll/resize/clock events perform positioning only. Composer input performs one draft read for availability; own UI text does not schedule full sync. Hover and conversation state readers react only to toolbar remounts or route changes.
- Keep composer-text mutations out of terminal-only scans. The notifier monitor still owns draft/upload/control observations and action safeguards; real assistant mutations and composer structural replacement remain visible.
- Reuse submitted conversation state only for coalesced draft-only monitor publications. These publications still read current draft/upload/request controls. Assistant or structural mutations invalidate reuse; explicit safety queries always inspect fresh submitted turns.

Simple owns the visible countdown while enabled; the independent smart watchdog continues its existing persisted behavior. No ChatGPT API polling or new foreground processes are introduced.

## Verification and continuation

Existing deterministic suites plus new cases cover the fixed phase sequence, no-code independence, click deadline, unsaved-to-saved binding and immediate cancellation.

The traffic-inert Playwright suite adds real MV3 checks for button order and independent activation with an existing draft and terminal footer; fresh-chat activation; JSON clearance; three consecutive hot replacements after losing old globals; exactly one timestamped submission afterward; zero draft reads for forty scroll frames; and zero terminal scans or submitted-turn clones during forty draft changes while draft safeguards still publish.

Local deterministic validation: 592 tests, 578 passed, 14 existing skips, zero failures. Syntax and whitespace checks pass.

The first browser run exposed that the old harness proved content scripts but never required either native background worker. Native diagnostics show both extensions enabled with no manifest/runtime errors and inactive workers. The harness now resolves workers by extension identity, attempts native startup in its disposable profile, and emits native registration/error diagnostics if either worker is missing. It does not inject a replacement background implementation.

Next: pass all Glass exact-source browser/build/package gates on PR #261, apply through the established managed releases, and verify publication/Glass installation evidence. Record actual deployment results in the PR before claiming completion.

No duplicate-notification changes are part of this request.
