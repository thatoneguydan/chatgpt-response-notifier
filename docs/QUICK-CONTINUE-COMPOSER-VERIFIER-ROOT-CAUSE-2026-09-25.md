# Quick Continue composer verification root cause — 2026-09-25

## Symptom

After Quick Continue 1.2.19 inserted a multiline prompt into ChatGPT, the toolbar could show `Could not write the prompt.` while the intended prompt was visibly present in the composer. The send button was not clicked.

## Root cause

`composer-text.js` wrote through the real contenteditable editing transaction and then required `read(node) === requestedText`. For contenteditable editors, `read(node)` used `innerText`. Chromium's `innerText` is presentation-oriented: block/paragraph DOM can serialize with separator newlines that do not correspond one-for-one with the editor's logical line breaks. ChatGPT's Lexical editor may represent the inserted text as paragraph/block DOM, so a successful write could be rejected by the strict verifier.

The same function also treated `document.execCommand('insertText', ...) === true` as a required success signal. That API is deprecated and its boolean is not a reliable authoritative signal once the resulting editor contents can be checked directly.

The unit test used a fake editable whose `innerText` was assigned directly, so it did not reproduce Chromium/Lexical paragraph serialization.

## Fix

Quick Continue 1.2.20 keeps exact verification but changes what is verified:

- contenteditable text is read structurally, treating sibling block elements as logical paragraphs and `<br>` as an explicit line break;
- empty paragraph placeholder blocks remain distinguishable as real blank logical lines;
- the `execCommand` boolean is ignored and the post-write logical editor contents are authoritative;
- exact comparison remains in place, so a real added/removed blank line still blocks sending.

A dedicated Lexical-style regression test models paragraph DOM and the false `execCommand` return case.
