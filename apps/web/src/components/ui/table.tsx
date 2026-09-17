"use client"

import * as React from "react"
import { cn } from "cn"

function Table({ className, ...props }: React.ComponentProps<"table">) {
  return (
    <div
      data-slot="table-container"
      className="relative w-full overflow-x-auto"
    >
      <table
        data-slot="table"
        className={cn("w-full caption-bottom text-sm", className)}
        {...props}
      />
    </div>
  )
}

function TableHeader({ className, ...props }: React.ComponentProps<"thead">) {
  return (
    <thead
      data-slot="table-header"
      // The header row's own bottom rule is the full --border divider, not the lighter
      // row-to-row rule TableRow uses between body rows - overrides it explicitly since
      // both are otherwise the same border-b utility.
      className={cn("[&_tr]:border-border [&_tr]:border-b [&_tr]:hover:bg-transparent", className)}
      {...props}
    />
  )
}

function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return (
    <tbody
      data-slot="table-body"
      className={cn("[&_tr:last-child]:border-0", className)}
      {...props}
    />
  )
}

function TableFooter({ className, ...props }: React.ComponentProps<"tfoot">) {
  return (
    <tfoot
      data-slot="table-footer"
      className={cn(
        "border-t bg-muted/50 font-medium [&>tr]:last:border-b-0",
        className
      )}
      {...props}
    />
  )
}

function TableRow({ className, ...props }: React.ComponentProps<"tr">) {
  return (
    <tr
      data-slot="table-row"
      className={cn(
        "border-b border-foreground/9 transition-colors last:border-0 hover:bg-primary/6 has-aria-expanded:bg-primary/6 data-[state=selected]:bg-primary/6",
        className
      )}
      {...props}
    />
  )
}

function TableHead({ className, ...props }: React.ComponentProps<"th">) {
  return (
    <th
      data-slot="table-head"
      className={cn(
        // Barlow Condensed 600, 11.5px, tracked, uppercase, muted - the handoff's "Table
        // header cell" typography. No border of its own - TableHeader puts the row's
        // bottom divider on the <tr>, matching the reference markup exactly.
        "px-3 py-2 text-left align-middle font-heading text-[11.5px] font-semibold tracking-[0.12em] text-muted-foreground uppercase [&:has([role=checkbox])]:pr-0",
        className
      )}
      {...props}
    />
  )
}

function TableCell({ className, ...props }: React.ComponentProps<"td">) {
  return (
    <td
      data-slot="table-cell"
      className={cn(
        // break-words (overflow-wrap: break-word) is a no-op for the whitespace-nowrap
        // default below (nothing wraps, so nothing needs a break point) but matters for
        // any cell overriding that to whitespace-normal - a long unbroken string (a title,
        // an id, a url) then wraps inside the column instead of overflowing it.
        "px-3 py-[9px] align-middle whitespace-nowrap break-words [&:has([role=checkbox])]:pr-0",
        className
      )}
      {...props}
    />
  )
}

function TableCaption({
  className,
  ...props
}: React.ComponentProps<"caption">) {
  return (
    <caption
      data-slot="table-caption"
      className={cn("mt-4 text-sm text-muted-foreground", className)}
      {...props}
    />
  )
}

export {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableHead,
  TableRow,
  TableCell,
  TableCaption,
}
