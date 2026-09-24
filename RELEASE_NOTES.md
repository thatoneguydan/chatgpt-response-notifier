# ChatGPT Response Notifier 0.9.66

- Notifier self-update checks now bypass stale raw-GitHub/CDN caches with a unique manifest request URL plus explicit no-cache/no-store headers.
- Quick Continue update checks retain the same cache-bypass protection added in 0.9.65.
- Quick Continue 1.2.14 fixes the in-page JSON editor after managed hot updates by disposing stale page runtimes before rebinding them to the current config API.
- Existing notifier state, Quick Continue config, and per-conversation timestamp state remain preserved across the update.
