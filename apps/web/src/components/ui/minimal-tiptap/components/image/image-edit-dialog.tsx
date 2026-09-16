import type { Editor } from "@tiptap/react"
import type { VariantProps } from "class-variance-authority"
import type { toggleVariants } from "@/components/ui/toggle"
import { useState } from "react"
import { ImageIcon } from "@radix-ui/react-icons"
import { ToolbarButton } from "../toolbar-button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { ImageEditBlock } from "./image-edit-block"

interface ImageEditDialogProps extends VariantProps<typeof toggleVariants> {
  editor: Editor
}

const ImageEditDialog = ({ editor, size, variant }: ImageEditDialogProps) => {
  const [open, setOpen] = useState(false)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {/* No `tooltip` here - see toolbar-button.tsx's note on why stacking a Tooltip inside
          another Base UI trigger's `render` (DialogTrigger here) breaks it. */}
      {/* tabIndex={-1} here (not just on ToolbarButton) - see link-edit-popover.tsx's note. */}
      <DialogTrigger tabIndex={-1} render={<ToolbarButton isActive={editor.isActive("image")} aria-label="Image" size={size} variant={variant} />}><ImageIcon className="size-4" /></DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Select image</DialogTitle>
          <DialogDescription className="sr-only">
            Upload an image from your computer
          </DialogDescription>
        </DialogHeader>
        <ImageEditBlock editor={editor} close={() => setOpen(false)} />
      </DialogContent>
    </Dialog>
  )
}

export { ImageEditDialog }
