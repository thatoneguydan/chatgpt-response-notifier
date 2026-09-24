'use strict';

(() => {
  if (globalThis.__chatgptNotifierRecoveryRefreshPolicy) return;

  const MIN_HARD_RELOAD_SPACING_MS = 60_000;

  const continuationPolicy = globalThis.ChatGPTNotifierContinuationPolicy;
  if (continuationPolicy?.thresholds) {
    globalThis.ChatGPTNotifierContinuationPolicy = Object.freeze({
      ...continuationPolicy,
      thresholds: Object.freeze({
        ...continuationPolicy.thresholds,
        profileActionSpacingMs: Math.max(
          MIN_HARD_RELOAD_SPACING_MS,
          Number(continuationPolicy.thresholds.profileActionSpacingMs || 0)
        )
      })
    });
  }

  const recoveryModel = globalThis.ChatGPTNotifierRecoveryModel;
  if (recoveryModel?.thresholds) {
    globalThis.ChatGPTNotifierRecoveryModel = Object.freeze({
      ...recoveryModel,
      thresholds: Object.freeze({
        ...recoveryModel.thresholds,
        profileActionSpacingMs: Math.max(
          MIN_HARD_RELOAD_SPACING_MS,
          Number(recoveryModel.thresholds.profileActionSpacingMs || 0)
        )
      })
    });
  }

  globalThis.__chatgptNotifierRecoveryRefreshPolicy = Object.freeze({
    version: 1,
    minHardReloadSpacingMs: MIN_HARD_RELOAD_SPACING_MS,
    bypassCacheRequired: true
  });
})();
