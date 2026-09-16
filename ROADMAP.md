# ChatGPT Response Notifier — Roadmap

Program: **ChatGPT Response Notifier**. Source authority: this repository. Historical incident authority: DevelopmentInfrastructure #283. Current reboot-durable installation authority: DevelopmentInfrastructure #443. Cross-Windows-virtual-desktop toast-click acceptance authority: #442.

## Current checkpoint — 2026-09-16, v0.9.28 source; browser registration durability is the blocker

The hidden/unfocused completion problem is no longer the active blocker. v0.9.27 produced a real notifier-eligible native notification while Chrome remained hidden/unfocused. v0.9.28 then merged a browser-only cross-desktop toast-click fallback that activates the existing conversation first and, only after a physical toast click, opens the same conversation URL in a new focused Chrome window when the original remains invisible on another Windows virtual desktop.

After a normal Windows Update reboot, the v0.9.28 extension files and helper installation remained intact but Chrome exposed no live notifier extension runtime. Full Chrome exit/reopen did not restore it. Bounded evidence ruled out ordinary source/path/manifest/identity/policy/disable/blocklist incompatibility causes. PR #66 also fixed a diagnostic-control flaw where a disposable clone using the basename `Default` could share Chromium's external `PreferenceMACs\Default` validator; the remaining isolated clone probe now uses a collision-free `scoped_dir` basename and fails closed.

The active repair is DevelopmentInfrastructure **#443**: replace the production dependency on one-time manual **Load unpacked** registration with a reboot-durable, supported Chrome distribution mechanism. For an unmanaged Glass Windows PC, the production target is an **Unlisted Chrome Web Store item**. The localhost helper, notification ownership, bounded recovery, updater/release automation, rollback, protected deployment, and no-focus-stealing boundaries remain unchanged.

Active source work: notifier **PR #67**, branch `repair/cws-durable-distribution`, based on main `d47b4a205370fe588f09cf9bc4840366e1bc0184`.

## #443 durable distribution sequence

Parent: **ChatGPT Response Notifier → Workstream 3/5 — Installation, Release, and Acceptance → Stage 1/1 — Reboot-durable Chrome distribution**.

| Step | Gate | Tasks |
| --- | --- | --- |
| Step 1/4 — Prepare deterministic Store packaging | Gate 1/1 — exact-head Seed package is reproducible, reviewable, contains required Store icon assets, preserves runtime files byte-for-byte, strips only the development identity key, and contains no private key material | Restore/audit package builder; generate Store-only PNG icons; validate Seed/Bound identity modes; publish exact-head Seed ZIP artifact; document Store policy/human boundary. |
| Step 2/4 — Bind the Store-assigned identity | Gate 1/1 — Store Item ID/public key are proven to match, all source/helper identity surfaces move together, and Bound packaging fails closed on drift | Obtain public Store Item ID/public key through Developer Dashboard; derive ID; update manifest/helper/test metadata atomically; validate exact head. |
| Step 3/4 — Publish and cut over Glass | Gate 1/1 — matching helper identity is released/deployed and the Unlisted Store extension is the live runtime | Build/release matching helper; protected Glass deployment; upload reviewed Bound package; complete accurate Store listing/privacy fields; publish Unlisted; install Store item; remove reliance on manual Load unpacked. |
| Step 4/4 — Prove restart durability and unblock #442 | Gate 1/1 — normal reboot/login leaves Store extension installed/live and helper connected without manual recovery | Collect pre/post reboot evidence; verify notification path; then rerun #442 cross-desktop physical-toast-click acceptance. |

**Current:** Step 1/4 → Gate 1/1. Complete all safe source/package work before requesting the authenticated Developer Dashboard action needed to create the Store item.

## #443 hardening contract

- Chrome profile protected preferences are evidence, never an installation API. Do not write `Preferences` / `Secure Preferences` to repair registration.
- CDP `loadUnpacked` remains disposable-test tooling only. Do not turn it into production restart persistence.
- Normal Chrome Web Store publishing uses Store-managed signing. Do not add private signing material to GitHub, workflow artifacts, installed bundles, or evidence.
- Do not opt into Verified CRX Uploads during this migration unless a separate reviewed key-management design is approved.
- Seed Store packages omit the current development `manifest.key`; source remains unchanged until Chrome Web Store assigns the item public key/ID.
- Bound Store packages require committed Store identity metadata and must fail closed unless manifest key, derived extension ID, helper origin/ID, and Store Item ID agree.
- No temporary broad helper origin wildcard is allowed. If Store identity differs from the current unpacked ID, cut over the exact new origin coherently.
- Preserve loopback-only helper transport. No ChatGPT API/session polling, duplicate ChatGPT request, or background page scraping outside the existing extension behavior.
- Preserve the retired native foreground boundary. Cross-desktop click handling remains browser-only and user-initiated.
- Promotion requires exact-head normal validation plus exact-head Store-package validation before any user-facing Store upload.

## Program structure

| Workstream | Scope | Current state |
| --- | --- | --- |
| Workstream 1/5 — Foundation and Conversation Identity | Completion sensor, stable chat routing, request/document identity, loopback protocol. | Hidden/unfocused completion accepted on v0.9.27. Diagnostic evidence retained; no new behavior guess is active. |
| Workstream 2/5 — Native Toast UX | Persistent notifications, timestamps, history, quick prompts, click/dismiss routing. | v0.9.28 cross-desktop click fallback merged. Live physical-click acceptance is blocked by #443 because the extension runtime is not durably loaded. |
| Workstream 3/5 — Installation, Release, and Acceptance | Installer/helper startup, stable root, updater, rollback, release publication, Chrome distribution, live acceptance. | **ACTIVE:** #443 replaces manual unpacked registration with Unlisted Chrome Web Store distribution and reboot proof. |
| Workstream 4/5 — Reliable Background Automation | Durable ownership, guarded continuation, timeout/silent-stop recovery, outbox/delivery. | Existing bounded automation retained. Store migration must not weaken request identity, safety vetoes, or continuation caps. |
| Workstream 5/5 — Status Contract and Bounded Recovery | Work-status contract recognition, coded notification eligibility, bounded recovery and proof. | Existing status-contract v2 and DOM/stream identity semantics remain authoritative. Distribution work must not change them. |

## Accepted behavior retained

- Coded completion notification no longer requires waiting for the final assistant DOM to paint while Chrome is hidden; the v0.9.27 stream/DOM evidence path delivered a real hidden-window notification.
- Stream-derived evidence is notification-only. Automatic Continue still requires the existing DOM terminal identity checks and user/safety vetoes.
- Existing open ChatGPT tabs receive notifier startup/update attachment without requiring a manual page refresh when a live extension runtime exists.
- Verified timeout/system recovery and silent-stop recovery remain separate bounded paths.
- Automatic recovery Continue and coded-status Continue remain timestamped at send time using the local quick-prompt format.
- Automatic continuation remains bounded by exact request identity, user/safety vetoes, per-incident caps, and profile-wide spacing.
- Persistent notification history, durable helper acknowledgment, duplicate suppression, manual-stop behavior, rollback, stable install root, and helper-owned native presentation remain retained.
- Cross-desktop toast clicks remain user-initiated and browser-only; no native foreground/window enumeration route is permitted.

## Retained recovery defaults

- missing-footer grace: 30 seconds;
- silent-stop evidence: at least 90 seconds idle plus two consistent inspections at least 30 seconds apart;
- ambiguous-thinking diagnostic: 15 minutes without forced retry;
- silent-stop reload cap: 3;
- explicit-interruption reload cap: 5;
- explicit-interruption retry spacing after a surviving reload: 5 minutes;
- recovery continuation cap: 1 per incident;
- format-repair prompts: 0;
- profile-wide action spacing: at least 30 seconds;
- generation-producing action ceiling: 12 per trusted human-started run;
- reset only by a genuinely new trusted human request or explicit Resume.

## Recent accepted proof

- **v0.9.27 hidden-window acceptance:** a real notifier-eligible coded response produced its native notification while Chrome stayed hidden/unfocused. This closed the live completion-timing blocker that had driven #439.
- **v0.9.28 click repair:** notifier PR #58 merged the browser-only cross-desktop click fallback. Its live physical-click acceptance remains blocked behind #443.
- **Reboot registration incident:** after a normal Windows Update reboot, installed v0.9.28 files/helper state remained while Chrome omitted the live notifier runtime. Full Chrome exit/reopen did not restore it.
- **Bounded registration diagnostics:** PRs #59–#65 ruled out ordinary source/path/manifest/ID/policy/disable/blocklist/suppressing-flag/source-compatibility explanations and showed fresh Chrome 153 could load the exact source in an isolated test profile.
- **Clone-control hardening:** notifier PR #66 merged as `d47b4a205370fe588f09cf9bc4840366e1bc0184`, replacing the collision-prone `Default` clone control with an isolated `scoped_dir` probe and external PreferenceMAC validator checks.

## Continuing work

Adopt DevelopmentInfrastructure #443 and notifier PR #67. Finish deterministic Store package/identity preparation and exact-head validation first. Only then cross the authenticated Developer Dashboard boundary to create the initial Store item and obtain its public Item ID/public key. Resume automation immediately after identity is supplied. Keep #443 open through Unlisted Store publication, Glass install, and a normal reboot/login durability proof. Rerun and close #442 only after that durable runtime gate passes.
