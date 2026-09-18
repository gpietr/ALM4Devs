"use client"

import * as React from "react"
import { Combobox as ComboboxPrimitive } from "@base-ui/react/combobox"
import {
  Combobox,
  ComboboxChip,
  ComboboxChipRemove,
  ComboboxChips,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxInputGroup,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxPortal,
  ComboboxPositioner,
  ComboboxTrigger,
} from "@/components/ui/combobox"
import { formatItemId } from "@/lib/format-item-id"
import { Plus } from "lucide-react"

export interface RequirementOption {
  id: string
  title: string
  levelName: string
  levelCode: string
  sequenceNumber: number
}

function optionLabel(option: RequirementOption): string {
  return `${formatItemId(option.levelCode, option.sequenceNumber)}: ${option.title}`
}

/** Cancels Base UI's "press Escape while closed clears the whole multi-select value"
 * convention (see ComboboxInput's keydown handler) - fine for an in-progress typed value,
 * but destructive here: these chips are already-committed requirement links, not a draft,
 * and Escape is also the natural way to dismiss a popover this picker may sit in. Shared by
 * both pickers below, and by architecture-picker.tsx's ArchitecturePicker/TestCasePicker -
 * exported so those chip comboboxes stay in lockstep with this Escape-key behavior instead
 * of re-declaring their own copy. */
export function guardEscapeClear(onChange: (ids: string[]) => void) {
  return (ids: string[], eventDetails: { reason: string; cancel: () => void }) => {
    if (eventDetails.reason === "escape-key") {
      eventDetails.cancel()
      return
    }
    onChange(ids)
  }
}

/**
 * Tag-style requirement linker: linked requirements show as small removable chips ("labels"),
 * with an inline search input to find and add more - the same pattern as Jira's label
 * picker. Used for the test-case-level requirement links, where there's a full-width form
 * field to spend (see test-cases/[id]/page.tsx and test-cases/new/page.tsx) - replacing the
 * old native `<select multiple>` scroll box, which had no way to search. For the step-level
 * links, which live in a narrow table cell, see `RequirementLinkList` below instead.
 *
 * `options` is the full requirement list to search over (typically
 * `requirements.listAllByProduct`); `value`/`onChange` are the linked requirement ids, in
 * selection order.
 */
export function RequirementPicker({
  options,
  value,
  onChange,
  placeholder = "Search requirements…",
  emptyMessage = "No requirements in this product yet.",
  className,
}: {
  options: RequirementOption[]
  value: string[]
  onChange: (ids: string[]) => void
  placeholder?: string
  emptyMessage?: string
  className?: string
}) {
  const optionsById = React.useMemo(() => new Map(options.map((o) => [o.id, o])), [options])
  const items = React.useMemo(
    () =>
      ComboboxPrimitive.createItems(options, {
        getValue: (option: RequirementOption) => option.id,
        getLabel: optionLabel,
      }),
    [options],
  )

  return (
    <Combobox items={items} multiple value={value} onValueChange={guardEscapeClear(onChange)}>
      <ComboboxInputGroup className={className}>
        <ComboboxChips>
          {value.map((id) => {
            const option = optionsById.get(id)
            const label = option ? optionLabel(option) : id
            return (
              <ComboboxChip key={id} aria-label={label} aria-description="Press Backspace or Delete to remove">
                <span className="truncate">{label}</span>
                <ComboboxChipRemove aria-label={`Remove ${label}`} />
              </ComboboxChip>
            )
          })}
          <ComboboxInput placeholder={value.length > 0 ? "" : placeholder} />
        </ComboboxChips>
      </ComboboxInputGroup>

      <ComboboxPortal>
        <ComboboxPositioner>
          <ComboboxPopup>
            <ComboboxEmpty>{options.length === 0 ? emptyMessage : "No matching requirements."}</ComboboxEmpty>
            <ComboboxList>
              {(option: RequirementOption) => (
                <ComboboxItem key={option.id} value={option.id}>
                  {optionLabel(option)}
                </ComboboxItem>
              )}
            </ComboboxList>
          </ComboboxPopup>
        </ComboboxPositioner>
      </ComboboxPortal>
    </Combobox>
  )
}

/**
 * Compact requirement linker for tight spaces (the step-link table cell): the linked
 * requirements' short ids show directly as chips - always visible, not hidden behind an
 * icon that has to be clicked open first - with the full title on hover, plus a small "+"
 * button. Unlike `RequirementPicker` above, the search input isn't inline (there's no room
 * for it next to the chips in a table cell); clicking "+" opens a small popup with the
 * search box inside it, following Base UI's own "input inside popup" pattern.
 */
export function RequirementLinkList({
  options,
  value,
  onChange,
  emptyMessage = "No requirements in this product yet.",
  addLabel = "Add linked requirement",
}: {
  options: RequirementOption[]
  value: string[]
  onChange: (ids: string[]) => void
  emptyMessage?: string
  addLabel?: string
}) {
  const optionsById = React.useMemo(() => new Map(options.map((o) => [o.id, o])), [options])
  const items = React.useMemo(
    () =>
      ComboboxPrimitive.createItems(options, {
        getValue: (option: RequirementOption) => option.id,
        getLabel: optionLabel,
      }),
    [options],
  )

  return (
    <Combobox items={items} multiple value={value} onValueChange={guardEscapeClear(onChange)}>
      <ComboboxChips className="flex flex-wrap items-center gap-1">
        {value.map((id) => {
          const option = optionsById.get(id)
          const shortId = option ? formatItemId(option.levelCode, option.sequenceNumber) : id
          const label = option ? optionLabel(option) : id
          return (
            <ComboboxChip
              key={id}
              title={label}
              aria-label={label}
              aria-description="Press Backspace or Delete to remove"
            >
              <span className="truncate">{shortId}</span>
              <ComboboxChipRemove aria-label={`Remove ${label}`} />
            </ComboboxChip>
          )
        })}
        <ComboboxTrigger aria-label={addLabel}>
          <Plus />
        </ComboboxTrigger>
      </ComboboxChips>

      <ComboboxPortal>
        <ComboboxPositioner align="start">
          {/* Overrides the default popup's `w-(--anchor-width)` - the anchor here is the
              small icon Trigger, not a full-width input group, so matching its width would
              make the search box and result list absurdly narrow. */}
          <ComboboxPopup className="w-64 p-2">
            <p className="px-0.5 pb-1.5 text-xs font-medium text-muted-foreground">
              Linked requirements (linking a step also links the test case)
            </p>
            <ComboboxInput autoFocus placeholder="Search requirements…" className="mb-1 px-1" />
            <ComboboxEmpty>{options.length === 0 ? emptyMessage : "No matching requirements."}</ComboboxEmpty>
            <ComboboxList>
              {(option: RequirementOption) => (
                <ComboboxItem key={option.id} value={option.id}>
                  {optionLabel(option)}
                </ComboboxItem>
              )}
            </ComboboxList>
          </ComboboxPopup>
        </ComboboxPositioner>
      </ComboboxPortal>
    </Combobox>
  )
}
