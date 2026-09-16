# ChatGPT Response Notifier

Canonical source: **thatoneguydan/chatgpt-response-notifier**, main plus the active work recorded in [DevelopmentInfrastructure #439](https://github.com/thatoneguydan/DevelopmentInfrastructure/issues/439). [#283](https://github.com/thatoneguydan/DevelopmentInfrastructure/issues/283) retains the historical incident work.

Read [ROADMAP.md](ROADMAP.md) for program structure and acceptance gates. For the current hidden-window investigation, the authoritative installed checkpoint is [v0.9.27 hidden-window diagnostics — installed checkpoint](docs/HIDDEN-WINDOW-DIAGNOSTICS-V0927-INSTALLED-2026-09-15.md), with the earlier source audit and conditional repair branches in [the v0.9.26 diagnostic handoff](docs/HIDDEN-WINDOW-DIAGNOSTIC-HANDOFF-2026-09-15.md). Read [README.md](README.md) for released behavior. [Review #32](https://github.com/thatoneguydan/chatgpt-response-notifier/issues/32) records the v0.8.1 reliability findings and offline proof.

**Current runtime:** v0.9.27 is published and installed on Glass from validated candidate source `d87d80a08093d985aad315b2fc6fa837535b7e4e`. Its bounded hidden-window diagnostics have been proven through the extension → helper → safe-evidence projection. v0.9.27 is diagnostic instrumentation, not a claimed fix. The next required evidence is one real notifier-eligible completion while Chrome remains unfocused/occluded, preferably on another Windows virtual desktop, followed immediately by the exact-source read-only evidence rerun documented in the installed checkpoint. Do not ship another behavior guess before that trace selects the repair boundary.

The older Glass project documents are historical and do not establish the current release, installed state, or active work. The stable known-good/v0.6.0 branch remains the pre-status-gating rollback.

Normal completion uses the unchanged upstream detector. Local browser code owns canonical status interpretation and guarded composer interaction; the loopback Windows helper owns persistent independent toasts. Never add ChatGPT polling or automatic foregrounding to recover a missed browser event.

## Operator-interaction policy

Operator interaction is a last resort for this project. A chat must not ask the operator to click **Update**, run an installer, reload Chrome, execute a command, or perform another manual deployment/recovery step merely because that path is convenient.

Before requesting operator action, exhaust the safe non-interactive routes that are already available to the project, including the managed updater, the loopback helper/control path, protected Glass deployment/verification workflows, and other repository-defined automation that preserves the stable unpacked extension root/ID and Chrome profile/registration state. Prefer those routes even when they require additional diagnosis or implementation work.

A manual operator action is acceptable only when the required action is inherently interactive or all applicable non-interactive routes are unavailable or have failed with concrete evidence. Ordinary update cadence, a sleeping helper/service worker, or the existence of a popup button is not by itself a reason to hand work to the operator. When operator action is genuinely unavoidable, document what automated routes were attempted or ruled out and why the remaining step cannot be completed safely without the operator.
