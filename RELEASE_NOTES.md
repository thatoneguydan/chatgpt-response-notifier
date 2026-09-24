# ChatGPT Response Notifier 0.9.67

- A current `Message delivery timed out` interruption still triggers the existing bounded refresh recovery path.
- If the timeout clears after refresh while the response turn remains present, recovery now returns to observation instead of pausing automation for ambiguous attention.
- The existing auto-continue countdown and attempts-remaining state therefore continue instead of requiring a manual Resume.
- If the interruption remains after refresh, bounded recovery still retries it; genuinely ambiguous no-response states still fail closed for attention.
