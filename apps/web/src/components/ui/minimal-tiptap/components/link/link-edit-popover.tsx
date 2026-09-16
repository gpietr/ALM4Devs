import * as React from "react"
import type { Editor } from "@tiptap/react"
import type { VariantProps } from "class-variance-authority"
import type { toggleVariants } from "@/components/ui/toggle"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { Link2Icon } from "@radix-ui/react-icons"
import { ToolbarButton } from "../toolbar-button"
import { LinkEditBlock } from "./link-edit-block"

interface LinkEditPopoverProps extends VariantProps<typeof toggleVariants> {
  editor: Editor
}

const LinkEditPopover = ({ editor, size, variant }: LinkEditPopoverProps) => {
  const [open, setOpen] = React.useState(false)

  const { from, to } = editor.state.selection
  const text = editor.state.doc.textBetween(from, to, " ")

  const onSetLink = React.useCallback(
    (url: string, text?: string, openInNewTab?: boolean) => {
      editor
        .chain()
        .focus()
        .extendMarkRange("link")
        .insertContent({
          type: "text",
          text: text || url,
          marks: [
            {
              type: "link",
              attrs: {
                href: url,
                target: openInNewTab ? "_blank" : "",
              },
            },
          ],
        })
        .setLink({ href: url })
        .run()

      editor.commands.enter()
    },
    [editor]
  )

  return (
    <Popover open={open} onOpenChange={setOpen}>
      {/* No `tooltip` here - see toolbar-button.tsx's note on why stacking a Tooltip inside
          another Base UI trigger's `render` (PopoverTrigger here) breaks it. */}
      {/* tabIndex={-1} here (not just on ToolbarButton) - PopoverTrigger's own internal
          button-props merge (Base UI) sets its own tabIndex last, overriding whatever the
          rendered element tried to set - see toolbar-button.tsx's tabIndex note. */}
      <PopoverTrigger tabIndex={-1} render={<ToolbarButton isActive={editor.isActive("link")} aria-label="Insert link" disabled={editor.isActive("codeBlock")} size={size} variant={variant} />}><Link2Icon className="size-4" /></PopoverTrigger>
      <PopoverContent align="end" side="bottom">
        <LinkEditBlock onSave={onSetLink} defaultText={text} />
      </PopoverContent>
    </Popover>
  )
}

export { LinkEditPopover }
