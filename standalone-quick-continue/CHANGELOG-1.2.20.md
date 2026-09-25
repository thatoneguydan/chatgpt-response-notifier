# Quick Continue 1.2.20

- Fix false `Could not write the prompt.` failures when ChatGPT/Lexical represents a correctly inserted multiline prompt as block/paragraph DOM.
- Verify logical editor text structurally while preserving exact real blank lines.
- Treat post-write editor contents as authoritative instead of requiring deprecated `document.execCommand()` to return `true`.
