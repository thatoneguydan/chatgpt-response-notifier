# ChatGPT Response Notifier

Canonical source: **thatoneguydan/chatgpt-response-notifier**. Current runtime source: **v0.9.29**. Reconcile current GitHub heads and active-work claims before implementation.

## Read next

- [ROADMAP.md](ROADMAP.md) — immediate reliability priorities within the existing five workstreams.
- [Independent failure review](docs/INDEPENDENT-FAILURE-REVIEW-2026-09-16.md) — evidence, limitations, exact next repairs and acceptance matrix.
- [DevelopmentInfrastructure #443](https://github.com/thatoneguydan/DevelopmentInfrastructure/issues/443) — owns registration diagnosis, implementation, release and Glass deployment.
- [DevelopmentInfrastructure #442](https://github.com/thatoneguydan/DevelopmentInfrastructure/issues/442) — owns cross-desktop click repair/acceptance, blocked by a loaded runtime.
- [DevelopmentInfrastructure #453](https://github.com/thatoneguydan/DevelopmentInfrastructure/issues/453) — independent documentation review; does not replace either runtime owner.

## Current checkpoint — 2026-09-16

One real coded notification was accepted while Chrome stayed hidden/unfocused on v0.9.27. This proves that observed completion-delivery path; it does not establish universal hidden-tab recovery or click reliability. v0.9.28 added the browser-only cross-desktop fallback, whose physical acceptance remains open.

The reboot disappearance now has an evidenced Chrome registration cause. PR #70 found the intended fork `lciedmoiiapbgemklkpoadimhffaaaah` and a stale legacy fork `pbbmmjcakamllfpcglbhcpmbpegapgih` both pointing at the same stable extension root; the legacy record no longer matches the current manifest-derived ID and carries disable reason 4 (`DISABLE_RELOAD`). PR #73 reproduced that exact same-root stale-ID shape on Glass's installed Chrome 153.0.8010.48 only when unpacked extension identity changed during a live `chrome.runtime.reload()`. Chromium's unpacked startup loader re-reads manifests from disk and rejects a path when a persisted registration's ID does not match the manifest-derived ID, so the stale record can make Chrome skip the valid intended registration at the shared path during startup.

PR #74 separately proved the smallest cleanup in a disposable profile on the same Chrome build: Chrome-native uninstall of only the stale ID removes that registration while preserving the intended fixed-ID registration, its same root and its live runtime. This avoids direct writes to Chrome Preferences/Secure Preferences and leaves the original control untouched. The exact historical event that first produced the legacy ID is not recoverable from committed Git history; do not invent a more specific key/no-key migration story than the evidence supports.

PR #72 repaired the validation blind spot: normal validation/release now use one deterministic complete test runner. Exact-head runs discover all 19 extension test files and pass 256/256 tests, so the previous 11-file CI omission is closed.

**Immediate next boundary:** one explicit, bounded cleanup of only legacy fork ID `pbbmmjcakamllfpcglbhcpmbpegapgih` in the real Default profile through Chrome's own uninstall path, after operator approval. Preserve original control `omnikbipejdflnfjkppfdkkdhglepbam`, intended fork `lciedmoiiapbgemklkpoadimhffaaaah`, the stable root/key, helper transport and rollback. After cleanup, prove a clean Chrome exit/reopen and then Windows reboot/login without re-registration. Chrome Web Store migration remains contingency rather than the active repair.

The independent review also reproduced phrase/location detection gaps, passive handling of progress-then-silence, and incomplete click verification. Those remain subsequent reliability work once #443 restores and proves a durable loaded runtime.

## Boundaries

- Do not write Chrome Preferences, Secure Preferences or external integrity state to repair registration.
- Do not use recurring/production CDP `loadUnpacked`, native Win32 foreground routing or Chrome process/window enumeration as a repair.
- Preserve the stable install root/key, exact extension-origin validation, loopback-only helper, rollback and protected deployment gates.
- Remove no Chrome extension registration except the exact stale legacy fork selected by #443's evidence, and only after explicit operator approval of that one-time live-profile mutation.
- Observe existing ChatGPT requests only: no ChatGPT API/session polling, duplicate backend requests or broad background scraping.
- Preserve Pause/manual Stop, drafts/uploads, authentication/approval/rate-limit vetoes, request identity, durable budgets and uncertainty stops.
- Stream-derived completion evidence remains notification-only. Silence/missing footer alone is insufficient automatic-action authority.
- Focus changes follow a physical user click; preserve the original tab/window when opening the existing fallback.
- Do not export conversations, raw profiles, credentials, signing secrets or unnecessary user paths in evidence.

## Operator interaction

Complete safe source work and use existing bounded diagnostic/update/deployment routes before asking for manual action. The current deterministic work is complete through root-cause reproduction, full-test validation and disposable selective-cleanup proof. The next step intentionally changes the real Chrome registration, so it requires explicit operator approval and a cleanly closed Chrome profile. Combine the post-cleanup Chrome restart, Windows reboot/login durability check and subsequent #442 physical click acceptance where practical; do not request repeated reinstalls, Developer Mode toggles or a Store account.