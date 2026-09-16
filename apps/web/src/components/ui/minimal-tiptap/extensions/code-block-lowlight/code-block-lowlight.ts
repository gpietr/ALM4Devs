import { CodeBlockLowlight as TiptapCodeBlockLowlight } from "@tiptap/extension-code-block-lowlight"
import { common, createLowlight } from "lowlight"

export const CodeBlockLowlight = TiptapCodeBlockLowlight.extend({
  addOptions() {
    return {
      ...this.parent?.(),
      lowlight: createLowlight(common),
      defaultLanguage: null,
      HTMLAttributes: {
        class: "block-node",
      },
      languageClassPrefix: 'language-',
      exitOnTripleEnter: true,
      exitOnArrowDown: true,
      // Required (not optional) in the installed extension version this app pins -
      // added to match, not part of the upstream registry file originally.
      exitOnArrowUp: true,
      enableTabIndentation: false,
      tabSize: 4,
    }
  },
})

export default CodeBlockLowlight
