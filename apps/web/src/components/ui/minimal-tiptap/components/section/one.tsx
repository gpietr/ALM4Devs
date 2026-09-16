import * as React from "react"
import type { Editor } from "@tiptap/react"
import type { FormatAction } from "../../types"
import type { VariantProps } from "class-variance-authority"
import type { toggleVariants } from "@/components/ui/toggle"
import { cn } from "@/lib/utils"
import { CaretDownIcon, LetterCaseCapitalizeIcon } from "@radix-ui/react-icons"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { ToolbarButton } from "../toolbar-button"
import { ShortcutKey } from "../shortcut-key"

type Level = 1 | 2 | 3 | 4 | 5 | 6
interface TextStyle
  extends Omit<
    FormatAction,
    "value" | "icon" | "action" | "isActive" | "canExecute"
  > {
  element: keyof React.JSX.IntrinsicElements
  level?: Level
  className: string
}

const formatActions: TextStyle[] = [
  {
    label: "Normal Text",
    element: "span",
    className: "grow",
    shortcuts: ["mod", "alt", "0"],
  },
  {
    label: "Heading 1",
    element: "h1",
    level: 1,
    className: "m-0 grow text-3xl font-extrabold",
    shortcuts: ["mod", "alt", "1"],
  },
  {
    label: "Heading 2",
    element: "h2",
    level: 2,
    className: "m-0 grow text-xl font-bold",
    shortcuts: ["mod", "alt", "2"],
  },
  {
    label: "Heading 3",
    element: "h3",
    level: 3,
    className: "m-0 grow text-lg font-semibold",
    shortcuts: ["mod", "alt", "3"],
  },
  {
    label: "Heading 4",
    element: "h4",
    level: 4,
    className: "m-0 grow text-base font-semibold",
    shortcuts: ["mod", "alt", "4"],
  },
  {
    label: "Heading 5",
    element: "h5",
    level: 5,
    className: "m-0 grow text-sm font-normal",
    shortcuts: ["mod", "alt", "5"],
  },
  {
    label: "Heading 6",
    element: "h6",
    level: 6,
    className: "m-0 grow text-sm font-normal",
    shortcuts: ["mod", "alt", "6"],
  },
]

interface SectionOneProps extends VariantProps<typeof toggleVariants> {
  editor: Editor
  activeLevels?: Level[]
}

export const SectionOne: React.FC<SectionOneProps> = ({
  editor,
  activeLevels = [1, 2, 3, 4, 5, 6],
  size,
  variant,
}) => {
  const filteredActions = React.useMemo(
    () =>
      formatActions.filter(
        (action) => !action.level || activeLevels.includes(action.level)
      ),
    [activeLevels]
  )

  const handleStyleChange = React.useCallback(
    (level?: Level) => {
      if (level) {
        editor.chain().focus().toggleHeading({ level }).run()
      } else {
        editor.chain().focus().setParagraph().run()
      }
    },
    [editor]
  )

  const renderMenuItem = React.useCallback(
    ({ label, element: Element, level, className, shortcuts }: TextStyle) => (
      <DropdownMenuItem
        key={label}
        onClick={() => handleStyleChange(level)}
        className={cn("flex flex-row items-center justify-between gap-4", {
          "bg-accent": level
            ? editor.isActive("heading", { level })
            : editor.isActive("paragraph"),
        })}
        aria-label={label}
      >
        <Element className={className}>{label}</Element>
        <ShortcutKey keys={shortcuts} />
      </DropdownMenuItem>
    ),
    [editor, handleStyleChange]
  )

  return (
    <DropdownMenu>
      {/* No `tooltip` here (unlike the plain formatting buttons) - see toolbar-button.tsx's
          note. Stacking ToolbarButton's own Tooltip *inside* another Base UI trigger
          (DropdownMenuTrigger here) breaks the outer trigger's ref/prop forwarding: Tooltip
          is a state container, not a DOM-forwarding element, so DropdownMenuTrigger's
          `render` clone lands its click/anchor wiring on Tooltip instead of the real button
          - this is what caused the "can't type, focus jumps to the toolbar" bug. aria-label
          alone still carries the accessible name. */}
      <DropdownMenuTrigger tabIndex={-1} render={<ToolbarButton isActive={editor.isActive("heading")} aria-label="Text styles" pressed={editor.isActive("heading")} disabled={editor.isActive("codeBlock")} size={size} variant={variant} className="gap-0" />}><LetterCaseCapitalizeIcon className="size-4" /><CaretDownIcon className="size-4" /></DropdownMenuTrigger>
      {/* Explicit width, not "w-full" (the upstream registry's original value): this menu
          renders in a portal via Base UI's fixed positioning, so "w-full" resolves against
          the viewport rather than the small toolbar button anchoring it - a full-width
          dropdown, not a menu sized to its own items. */}
      <DropdownMenuContent align="start" className="w-56">
        {filteredActions.map(renderMenuItem)}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

SectionOne.displayName = "SectionOne"

export default SectionOne
