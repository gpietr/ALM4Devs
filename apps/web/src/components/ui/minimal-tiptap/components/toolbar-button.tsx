import * as React from "react"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { Toggle } from "@/components/ui/toggle"
import { cn } from "@/lib/utils"

// This registry component originally typed `tooltipOptions` against Radix's
// TooltipContentProps - our shadcn init used Base UI, not Radix (see TECH_STACK.md), so
// this derives the same prop shape from our own (Base UI-backed) TooltipContent instead of
// depending on a package we don't otherwise use anywhere in the app.
interface ToolbarButtonProps extends React.ComponentProps<typeof Toggle> {
  isActive?: boolean
  tooltip?: string
  tooltipOptions?: React.ComponentProps<typeof TooltipContent>
}

export const ToolbarButton = ({
  isActive,
  children,
  tooltip,
  className,
  tooltipOptions,
  ...props
}: ToolbarButtonProps) => {
  // tabIndex={-1} by default (every toolbar action - formatting, headings, lists, link,
  // image - renders through this one component): sequential Tab should carry a user
  // straight from the field above the editor into the editable text, not stop at every
  // toolbar button first. Buttons stay fully mouse-clickable and screen-reader-discoverable
  // via the editor's own labelling; only their sequential-tab-order stop is removed. An
  // explicit tabIndex passed by a caller (none currently do) still wins.
  const toggleButton = (
    <Toggle
      className={cn({ "bg-accent": isActive }, className)}
      {...props}
      tabIndex={props.tabIndex ?? -1}
    >
      {children}
    </Toggle>
  )

  if (!tooltip) {
    return toggleButton
  }

  // `render={toggleButton}` (Base UI's polymorphism convention, used correctly elsewhere in
  // this vendored tree - see section/one.tsx's DropdownMenuTrigger), NOT
  // `<TooltipTrigger>{toggleButton}</TooltipTrigger>` (the upstream registry's original,
  // Radix-`asChild`-style code). Without `render`, our Base UI TooltipTrigger renders its
  // own real `<button>` and nests the Toggle's `<button>` inside it - invalid HTML that, in
  // practice, broke focus for the whole toolbar and even clicking into the editor's text
  // area (confirmed with a real headless-browser click: focus consistently landed on this
  // nested button instead of the ProseMirror content, matching the user's "can't type,
  // focus goes to the toolbar" report). `render` merges the trigger's props onto the single
  // `Toggle` element instead of wrapping it in a second one.
  return (
    <Tooltip>
      <TooltipTrigger render={toggleButton} />
      <TooltipContent {...tooltipOptions}>
        <div className="flex flex-col items-center text-center">{tooltip}</div>
      </TooltipContent>
    </Tooltip>
  )
}

ToolbarButton.displayName = "ToolbarButton"

export default ToolbarButton
