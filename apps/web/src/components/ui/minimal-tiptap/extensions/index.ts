export * from "./code-block-lowlight"
export * from "./image"
export * from "./unset-all-marks"
export * from "./reset-marks-on-enter"
export * from "./file-handler"
// "color" and "markdown-paste" deliberately not re-exported and unused - see the note in
// use-minimal-tiptap.ts's createExtensions: neither produces markup
// packages/core/src/rich-text.ts's sanitizer allows (no style attr/<span>, no markdown
// output mode), and leaving them unreferenced keeps their real type mismatches against our
// installed tiptap-markdown version (this app never uses output:"markdown") out of scope
// rather than needing to hand-fix dead code we don't call.
// "horizontal-rule" also unused - <hr> isn't in the sanitizer's allowlist either.
