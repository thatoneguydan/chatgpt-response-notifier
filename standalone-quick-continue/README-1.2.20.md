# Quick Continue 1.2.20

Fixes a false `Could not write the prompt.` failure after a multiline prompt was visibly inserted into ChatGPT. The composer verifier now reads Lexical-style paragraph DOM as logical text and treats verified post-write contents—not the deprecated `execCommand()` boolean—as the success signal. Exact blank-line verification remains enforced.
