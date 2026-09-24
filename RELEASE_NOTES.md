# ChatGPT Response Notifier 0.9.65

- Quick Continue update checks now bypass stale raw-GitHub/CDN caches by using a unique manifest request URL plus explicit no-cache/no-store headers.
- This prevents the Windows helper from remaining stuck on an older Quick Continue feed after a newer release has already been published.
- Quick Continue 1.2.14 fixes the in-page JSON editor after managed hot updates by disposing stale page runtimes before rebinding them to the current config API.
- Existing Quick Continue config and per-conversation timestamp state remain preserved across the update.
