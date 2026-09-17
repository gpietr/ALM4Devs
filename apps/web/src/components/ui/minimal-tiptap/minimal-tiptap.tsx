import "./styles/index.css"

import type { Content, Editor } from "@tiptap/react"
import type { UseMinimalTiptapEditorProps } from "./hooks/use-minimal-tiptap"
import { EditorContent, EditorContext } from "@tiptap/react"
import { Separator } from "@/components/ui/separator"
import { cn } from "@/lib/utils"
import { SectionOne } from "./components/section/one"
import { SectionTwo } from "./components/section/two"
import { SectionFour } from "./components/section/four"
import { SectionFive } from "./components/section/five"
import { LinkBubbleMenu } from "./components/bubble-menu/link-bubble-menu"
import { useMinimalTiptapEditor } from "./hooks/use-minimal-tiptap"
import { MeasuredContainer } from "./components/measured-container"
import { useTiptapEditor } from "./hooks/use-tiptap-editor"
import { useEffect } from "react"

export interface MinimalTiptapProps extends Omit<
  UseMinimalTiptapEditorProps,
  "onUpdate"
> {
  value?: Content
  onChange?: (value: Content) => void
  className?: string
  editorContentClassName?: string
}

// Trimmed from the upstream registry toolbar to match what packages/core/src/rich-text.ts's
// sanitizer actually keeps: heading levels 4-6 aren't in its allowlist (only h1-h3), the
// color picker (SectionThree) needs a `style` attribute the sanitizer strips entirely, and
// horizontalRule (<hr>) isn't allowed either - offering any of these would let content look
// right in the editor and then silently disappear on save. Widen the sanitizer's allowlist
// first if any of these are ever wanted back, not just the toolbar.
// Sized "sm" and packed tight throughout - the upstream registry defaults (h-12 bar,
// default-size h-8 buttons, mx-2 separators) read as a full word-processor ribbon, which
// swamps this app's actual use (short requirement/step fields, several editors per page).
// This mirrors the old homebrew toolbar's footprint while keeping the new engine's
// mark-persistence fix.
//
// SectionTwo (plain formatting toggles: Bold/Italic/Underline) stays FIRST, ahead of
// SectionOne's heading menu - not just cosmetic ordering. Verified with a real headless
// click: the very first click into a freshly-mounted editor produces a genuine but
// transient extra focusin+click on whatever toolbar element is first in DOM order,
// immediately after the real click/focus on the editor itself. A dropdown trigger does
// not recover from that (Base UI opens on mousedown and holds focus); a plain toggle
// first still avoids the "can't type" failure mode for menus.
//
// The stray click also used to run toggleBold(). Fixes that don't steal typing focus:
// (1) format-button onClick ignores events whose coordinates aren't inside the button,
// (2) Toggle `pressed` is controlled from editor.isActive, (3) any focus that lands on a
// toolbar button is immediately bounced back to the editor (toolbar uses tabIndex=-1 and
// mousedown-preventDefault already, but the phantom focusin still arrives), (4) empty
// editors clear leftover stored marks shortly after focus.
//
// min-w-0 matters as much as overflow-x-auto here: as a flex-col child (see
// MainMinimalTiptapEditor's MeasuredContainer below), this div defaults to
// min-width:auto, which refuses to shrink below its own content's intrinsic width
// regardless of what its parent constrains it to - meaning overflow-x-auto never actually
// triggers, the toolbar just grows and pushes anything embedding this editor (a form, a
// narrow table cell) wider instead. min-w-0 is what lets it actually shrink and scroll
// internally, however narrow its container ends up being (a compact test-step table cell,
// in practice).

function useClearPhantomMarksOnEmptyFocus(editor: Editor) {
  useEffect(() => {
    const onFocus = () => {
      window.setTimeout(() => {
        if (editor.isDestroyed || !editor.isEmpty) return
        if (
          editor.isActive("bold") ||
          editor.isActive("italic") ||
          editor.isActive("underline") ||
          editor.isActive("strike") ||
          editor.isActive("code")
        ) {
          editor.commands.unsetAllMarks()
        }
      }, 0)
    }
    editor.on("focus", onFocus)
    return () => {
      editor.off("focus", onFocus)
    }
  }, [editor])
}

const Toolbar = ({ editor }: { editor: Editor }) => {
  useClearPhantomMarksOnEmptyFocus(editor)

  return (
    <div className="border-border flex h-9 min-w-0 shrink-0 overflow-x-auto border-b px-1 py-1">
      <div className="flex w-max items-center gap-0.5">
        <SectionTwo
          editor={editor}
          activeActions={[
            "bold",
            "italic",
            "underline",
            "strikethrough",
            "code",
            "clearFormatting",
          ]}
          mainActionCount={3}
          size="sm"
        />

        <Separator orientation="vertical" className="mx-1" />

        <SectionOne editor={editor} activeLevels={[1, 2, 3]} size="sm" />

        <Separator orientation="vertical" className="mx-1" />

        <SectionFour
          editor={editor}
          activeActions={["orderedList", "bulletList"]}
          mainActionCount={0}
          size="sm"
        />

        <Separator orientation="vertical" className="mx-1" />

        <SectionFive
          editor={editor}
          activeActions={["codeBlock", "blockquote"]}
          mainActionCount={0}
          size="sm"
        />
      </div>
    </div>
  )
}

export const MinimalTiptapEditor = ({
  value,
  onChange,
  className,
  editorContentClassName,
  ...props
}: MinimalTiptapProps) => {
  const editor = useMinimalTiptapEditor({
    value,
    onUpdate: onChange,
    ...props,
  })

  if (!editor) {
    return null
  }

  return (
    <EditorContext.Provider value={{ editor }}>
      <MainMinimalTiptapEditor
        editor={editor}
        className={className}
        editorContentClassName={editorContentClassName}
      />
    </EditorContext.Provider>
  )
}

MinimalTiptapEditor.displayName = "MinimalTiptapEditor"

export default MinimalTiptapEditor

export const MainMinimalTiptapEditor = ({
  editor: providedEditor,
  className,
  editorContentClassName,
}: MinimalTiptapProps & { editor: Editor }) => {
  const { editor } = useTiptapEditor(providedEditor)

  if (!editor) {
    return null
  }

  return (
    <MeasuredContainer
      as="div"
      name="editor"
      className={cn(
        "border-input min-data-[orientation=vertical]:h-72 flex h-auto w-full flex-col rounded-md border shadow-xs",
        "focus-within:border-ring focus-within:ring-ring/50 focus-within:ring-[3px]",
        className
      )}
    >
      <Toolbar editor={editor} />
      <EditorContent
        editor={editor}
        className={cn("minimal-tiptap-editor", editorContentClassName)}
      />
      <LinkBubbleMenu editor={editor} />
    </MeasuredContainer>
  )
}
