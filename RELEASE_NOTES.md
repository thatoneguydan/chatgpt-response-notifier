# ChatGPT Response Notifier 0.9.71

- Continue and Project actions now explicitly enable build monitoring and only arm the auto-continue watchdog after ChatGPT has created the new user turn, so a terminal footer from the previous response cannot immediately stop newly started work.
- Definitive current-turn GitHub status footers such as `COMPLETE_APPLIED`, `COMPLETE_NO_CHANGES`, `PLANNING_ACTIVE`, and `BLOCKED_HUMAN` receive a prompt-identity-checked fallback into watchdog reconciliation, ensuring auto-continue stops when the current response is actually terminal.
- The auto-continue countdown/status is left aligned above the Quick Continue toolbar, with the toolbar box beneath it.
- Quick Continue monitoring UI now preserves its last indicator/countdown geometry across hot runtime reinjection, preventing the periodic control flicker caused by notifier attachment replacement.
- The Quick Continue monitoring bridge is hot-injected into already-open and newly completed ChatGPT tabs without adding ChatGPT API polling or extra conversation requests.
- The notifier continues to tolerate the current ChatGPT web UI when legacy `conversation-turn-*`, composer, Send, or Stop selectors are absent, using only DOM that ChatGPT already rendered in the page.
- Existing hot-runtime injections retain the compatibility layer, so already-open ChatGPT tabs do not need a manual extension reload just to regain turn/composer detection.
- Recovery reloads continue to bypass cache, and the persistent recovery action gate remains at least 60 seconds between recovery actions.
