"use client"

import * as React from "react"
import { Combobox as ComboboxPrimitive } from "@base-ui/react/combobox"
import { cn } from "cn"
import { CheckIcon, XIcon } from "lucide-react"

// Styled wrapper around Base UI's Combobox, following the same thin-wrapper convention as
// ./select.tsx (data-slot on every part, classes layered onto Base UI's own with `cn`).
// Covers the parts this app currently needs - a searchable, multi-select "tag picker" (see
// components/requirement-picker.tsx) - not the full anatomy (no Icon/Clear/Group; add them
// here if a future caller needs single-select or grouped lists).

function Combobox<Value, Multiple extends boolean | undefined = false, Item = Value>({
  ...props
}: ComboboxPrimitive.Root.Props<Value, Multiple, Item>) {
  return <ComboboxPrimitive.Root data-slot="combobox" {...props} />
}

function ComboboxInputGroup({ className, ...props }: ComboboxPrimitive.InputGroup.Props) {
  return (
    <ComboboxPrimitive.InputGroup
      data-slot="combobox-input-group"
      className={cn(
        "flex min-h-8 w-full cursor-text flex-wrap items-center gap-1 rounded-lg border border-input bg-transparent px-2 py-1 text-sm outline-none focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 dark:bg-input/30",
        className,
      )}
      {...props}
    />
  )
}

function ComboboxChips({ className, ...props }: ComboboxPrimitive.Chips.Props) {
  return (
    <ComboboxPrimitive.Chips
      data-slot="combobox-chips"
      className={cn("flex w-full flex-wrap items-center gap-1", className)}
      {...props}
    />
  )
}

/** One selected value, rendered as a small removable tag - the "label" in the Jira-style
 * picker this backs. */
function ComboboxChip({ className, ...props }: ComboboxPrimitive.Chip.Props) {
  return (
    <ComboboxPrimitive.Chip
      data-slot="combobox-chip"
      className={cn(
        "group flex h-6 max-w-full cursor-default items-center gap-1 overflow-hidden rounded-md border border-border bg-muted pr-1 pl-2 text-xs font-medium text-foreground outline-none focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 data-highlighted:border-ring data-highlighted:ring-3 data-highlighted:ring-ring/50",
        className,
      )}
      {...props}
    />
  )
}

function ComboboxChipRemove({ className, ...props }: ComboboxPrimitive.ChipRemove.Props) {
  return (
    <ComboboxPrimitive.ChipRemove
      data-slot="combobox-chip-remove"
      className={cn(
        "-mr-0.5 flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground outline-none hover:bg-foreground/10 hover:text-foreground [&_svg]:size-3",
        className,
      )}
      {...props}
    >
      <XIcon />
    </ComboboxPrimitive.ChipRemove>
  )
}

function ComboboxInput({ className, ...props }: ComboboxPrimitive.Input.Props) {
  return (
    <ComboboxPrimitive.Input
      data-slot="combobox-input"
      className={cn(
        "h-6 min-w-20 flex-1 border-0 bg-transparent p-0 text-sm text-foreground outline-none placeholder:text-muted-foreground",
        className,
      )}
      {...props}
    />
  )
}

/** A button that opens the popup on its own - for a "chips list + small add button" layout
 * where the search input lives inside the popup (see ComboboxPopup below) rather than
 * always being visible next to the chips. */
function ComboboxTrigger({ className, ...props }: ComboboxPrimitive.Trigger.Props) {
  return (
    <ComboboxPrimitive.Trigger
      data-slot="combobox-trigger"
      className={cn(
        "flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-3.5",
        className,
      )}
      {...props}
    />
  )
}

function ComboboxPortal(props: ComboboxPrimitive.Portal.Props) {
  return <ComboboxPrimitive.Portal {...props} />
}

function ComboboxPositioner({ className, sideOffset = 4, ...props }: ComboboxPrimitive.Positioner.Props) {
  return (
    <ComboboxPrimitive.Positioner
      data-slot="combobox-positioner"
      sideOffset={sideOffset}
      className={cn("isolate z-50 outline-none", className)}
      {...props}
    />
  )
}

function ComboboxPopup({ className, ...props }: ComboboxPrimitive.Popup.Props) {
  return (
    <ComboboxPrimitive.Popup
      data-slot="combobox-popup"
      className={cn(
        "relative z-50 max-h-(--available-height) w-(--anchor-width) min-w-48 max-w-(--available-width) origin-(--transform-origin) overflow-x-hidden overflow-y-auto rounded-lg bg-popover py-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 duration-100 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
        className,
      )}
      {...props}
    />
  )
}

function ComboboxList({ className, ...props }: ComboboxPrimitive.List.Props) {
  return (
    <ComboboxPrimitive.List
      data-slot="combobox-list"
      className={cn("scroll-py-1 outline-none data-empty:p-0", className)}
      {...props}
    />
  )
}

function ComboboxEmpty({ className, ...props }: ComboboxPrimitive.Empty.Props) {
  return (
    <ComboboxPrimitive.Empty
      data-slot="combobox-empty"
      className={cn("px-2.5 py-2 text-xs text-muted-foreground empty:m-0 empty:p-0", className)}
      {...props}
    />
  )
}

function ComboboxItem({ className, children, ...props }: ComboboxPrimitive.Item.Props) {
  return (
    <ComboboxPrimitive.Item
      data-slot="combobox-item"
      className={cn(
        "relative flex w-full cursor-default items-center gap-1.5 rounded-md py-1.5 pr-2 pl-7 text-sm outline-hidden select-none data-highlighted:bg-accent data-highlighted:text-accent-foreground",
        className,
      )}
      {...props}
    >
      <ComboboxPrimitive.ItemIndicator className="absolute left-1.5 flex size-4 items-center justify-center">
        <CheckIcon className="size-3.5" />
      </ComboboxPrimitive.ItemIndicator>
      {children}
    </ComboboxPrimitive.Item>
  )
}

export {
  Combobox,
  ComboboxInputGroup,
  ComboboxChips,
  ComboboxChip,
  ComboboxChipRemove,
  ComboboxInput,
  ComboboxTrigger,
  ComboboxPortal,
  ComboboxPositioner,
  ComboboxPopup,
  ComboboxList,
  ComboboxEmpty,
  ComboboxItem,
}
