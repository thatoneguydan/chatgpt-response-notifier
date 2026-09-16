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

After Windows Update reboot, files, helper and a persisted Chrome registration remained, but the intended extension runtime was absent. The original unpacked notifier survives reboot on Glass. **Chrome Web Store migration is paused; unpacked installation alone is not an established cause.** [Store preparation](docs/CHROME-WEB-STORE-DURABLE-DISTRIBUTION.md) is contingency material, including its Developer Dashboard instructions. No Store fee/item creation is the current next step.

The active implementation's [PR #70 comparison run](https://github.com/thatoneguydan/chatgpt-response-notifier/actions/runs/35135642109) verified helper update/restart to v0.9.29. Both intended fork and original control report location 4, readable existing manifests and no disable reasons. A legacy fork ID also points at the current fork root and no longer matches its manifest key. Investigate that divergence through #443; it is not yet proof of the reboot cause. Helper restart and persisted preferences do not prove a loaded Chrome extension.

The independent review reproduced phrase/location detection gaps, passive handling of progress-then-silence, and incomplete click verification. It also found 11 existing test files omitted from normal validation/release test lists. These are immediate reliability tasks before new features or distribution redesign.

## Boundaries

- Do not write Chrome Preferences, Secure Preferences or external integrity state to repair registration.
- Do not use recurring/production CDP `loadUnpacked`, native Win32 foreground routing or Chrome process/window enumeration as a repair.
- Preserve the stable install root/key, exact extension-origin validation, loopback-only helper, rollback and protected deployment gates.
- Observe existing ChatGPT requests only: no ChatGPT API/session polling, duplicate backend requests or broad background scraping.
- Preserve Pause/manual Stop, drafts/uploads, authentication/approval/rate-limit vetoes, request identity, durable budgets and uncertainty stops.
- Stream-derived completion evidence remains notification-only. Silence/missing footer alone is insufficient automatic-action authority.
- Focus changes follow a physical user click; preserve the original tab/window when opening the existing fallback.
- Do not export conversations, raw profiles, credentials, signing secrets or unnecessary user paths in evidence.

## Operator interaction

Complete safe source work and use existing bounded diagnostic/update/deployment routes before asking for manual action. A desktop switch, foreground observation or normal reboot may still be needed for physical acceptance; combine those checks into one prepared pass after deterministic repairs are validated. Do not request repeated reinstalls, test commands, Chrome restarts, Developer Mode toggles or a Store account while evidence and source work remain available.
