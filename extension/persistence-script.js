'use strict';

(() => {
  if (globalThis.__chatgptNotifierPersistenceInstalled) return;

  // Generic pointer/keyboard activity used to dismiss every native notification
  // for the current conversation. That is much broader than acknowledgement:
  // ordinary typing, scrolling, or clicking while a response finishes can erase
  // a newly presented completion toast before the operator ever sees it.
  //
  // Native completion notifications are now dismissed only by explicit toast
  // actions / presentation completion in the worker-host protocol. Keep this
  // compatibility runtime so already-open tabs can hot-rebind cleanly without
  // retaining the retired interaction listeners from a new extension context.
  globalThis.__chatgptNotifierPersistenceInstalled = Object.freeze({
    version: 2,
    genericInteractionDismissRetired: true
  });
})();
