# ChatGPT Response Notifier

Canonical source: **thatoneguydan/chatgpt-response-notifier**. Canonical coordination for current work: [DevelopmentInfrastructure #443](https://github.com/thatoneguydan/DevelopmentInfrastructure/issues/443). [#442](https://github.com/thatoneguydan/DevelopmentInfrastructure/issues/442) retains the merged cross-Windows-virtual-desktop toast-click acceptance work and is blocked behind #443. [#283](https://github.com/thatoneguydan/DevelopmentInfrastructure/issues/283) remains historical incident context.

Read [ROADMAP.md](ROADMAP.md) for the current five-workstream program and acceptance gates. Read [CHROME-WEB-STORE-DURABLE-DISTRIBUTION.md](docs/CHROME-WEB-STORE-DURABLE-DISTRIBUTION.md) for the active reboot-durable browser-install design. Hidden-window investigation checkpoints remain under `docs/HIDDEN-WINDOW-*` as historical evidence; they are no longer the active blocker.

## Current checkpoint — 2026-09-16

Notifier runtime source is **v0.9.28**. Hidden/unfocused completion delivery was proven on v0.9.27: a real notifier-eligible coded response produced its native notification while Chrome remained hidden/unfocused. v0.9.28 then merged the browser-only cross-desktop toast-click fallback.

After a normal Windows Update reboot, the v0.9.28 extension files, helper installation/startup state, stable unpacked root, and protected Chrome preference entry remained present, but Chrome no longer exposed a live notifier extension runtime. Full Chrome exit/reopen did not restore it. Bounded diagnostics through notifier PR #66 ruled out ordinary path/manifest/identity/policy/disable/blocklist/source-compatibility causes and corrected an isolated-clone diagnostic that had shared Chromium's external PreferenceMAC basename.

The active repair in #443 is therefore architectural: **stop treating one-time manual `Load unpacked` registration as the production browser installation mechanism.** Use Chrome Web Store distribution (Unlisted for Glass) while preserving the localhost helper, managed updater/release path, rollback, notification ownership, bounded recovery, and no-focus-stealing behavior.

Current durable-distribution preparation: notifier PR #67 / branch `repair/cws-durable-distribution`, based on main `d47b4a205370fe588f09cf9bc4840366e1bc0184`.

## Hard boundaries

- Do not write Chrome `Preferences` or `Secure Preferences` to restore an extension.
- Do not use recurring/production CDP `loadUnpacked` as installation persistence.
- Do not add ChatGPT API/session polling or duplicate ChatGPT requests.
- Do not restore native Win32 foreground/window-enumeration routing.
- Do not place private signing keys, OAuth credentials, passwords, recovery codes, or other account secrets in source, issues, workflow evidence, or artifacts.
- Preserve loopback-only helper transport and exact extension-origin validation.

## Operator-interaction policy

Operator interaction is a last resort. A chat must not ask the operator to click **Update**, run an installer, reload Chrome, execute a command, or perform another manual deployment/recovery step merely because that path is convenient.

Before requesting operator action, exhaust safe non-interactive routes already available to the project: managed update/release automation, loopback helper/control paths, protected Glass deployment and verification workflows, exact-head package validation, and repository-defined diagnostics that preserve Chrome profile state.

For #443, the first unavoidable human boundary is the authenticated Chrome Web Store Developer Dashboard. Source/package preparation and validation must be complete first. The operator should only be asked to create/upload the initial Store item and return its **public** Item ID/public key; never request private keys or account credentials. After source is bound to that Store identity, automation resumes until the later authenticated publish/install/reboot acceptance boundary.
