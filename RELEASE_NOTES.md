# ChatGPT Response Notifier 0.9.73

- Restores notification delivery when a ChatGPT conversation stream settles through Chrome's request-error path after the assistant response and terminal GitHub status footer have already rendered.
- Request-error settlement now runs the same local terminal-status DOM probe used after successful request completion and routes valid terminal results through the existing durable notification pipeline.
- Genuine transport failures without a valid rendered terminal status footer do not manufacture completion notifications.
- Live Glass diagnostics confirmed the 0.9.72 helper, localhost bridge, extension runtime, and Chrome registration were healthy and isolated the missed-delivery boundary to request-error settlement.
- The 0.9.72 auto-continue timer and attempts-remaining fallback remains unchanged.