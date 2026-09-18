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
import { guardEscapeClear } from "@/components/requirement-picker"
import { Plus } from "lucide-react"

export interface SoftwareVersionOption {
  id: string
  versionNumber: string
}

/**
 * Tag-style software version linker - same chip pattern as RequirementPicker/
 * ArchitecturePicker, for "which releases does this apply to". `SoftwareVersionPicker` is
 * the full-width variant (requirement/test-case detail pages, which have a full form
 * field to spend); `SoftwareVersionLinkList` is the compact chips-plus-popover variant
 * for tight spaces (the OTS version rows on the architecture detail page).
 */
export function SoftwareVersionPicker({
  options,
  value,
  onChange,
  placeholder = "Search versions…",
  emptyMessage = "No versions defined for this product yet.",
  className,
}: {
  options: SoftwareVersionOption[]
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
        getValue: (option: SoftwareVersionOption) => option.id,
        getLabel: (option: SoftwareVersionOption) => option.versionNumber,
      }),
    [options],
  )

  return (
    <Combobox items={items} multiple value={value} onValueChange={guardEscapeClear(onChange)}>
      <ComboboxInputGroup className={className}>
        <ComboboxChips>
          {value.map((id) => {
            const label = optionsById.get(id)?.versionNumber ?? id
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
            <ComboboxEmpty>{options.length === 0 ? emptyMessage : "No matching versions."}</ComboboxEmpty>
            <ComboboxList>
              {(option: SoftwareVersionOption) => (
                <ComboboxItem key={option.id} value={option.id}>
                  {option.versionNumber}
                </ComboboxItem>
              )}
            </ComboboxList>
          </ComboboxPopup>
        </ComboboxPositioner>
      </ComboboxPortal>
    </Combobox>
  )
}

export function SoftwareVersionLinkList({
  options,
  value,
  onChange,
  emptyMessage = "No versions defined for this product yet.",
  addLabel = "Applies to versions",
}: {
  options: SoftwareVersionOption[]
  value: string[]
  onChange: (ids: string[]) => void
  emptyMessage?: string
  addLabel?: string
}) {
  const optionsById = React.useMemo(() => new Map(options.map((o) => [o.id, o])), [options])
  const items = React.useMemo(
    () =>
      ComboboxPrimitive.createItems(options, {
        getValue: (option: SoftwareVersionOption) => option.id,
        getLabel: (option: SoftwareVersionOption) => option.versionNumber,
      }),
    [options],
  )

  return (
    <Combobox items={items} multiple value={value} onValueChange={guardEscapeClear(onChange)}>
      <ComboboxChips className="flex flex-wrap items-center gap-1">
        {value.map((id) => {
          const label = optionsById.get(id)?.versionNumber ?? id
          return (
            <ComboboxChip key={id} title={label} aria-label={label} aria-description="Press Backspace or Delete to remove">
              <span className="truncate">{label}</span>
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
          <ComboboxPopup className="w-56 p-2">
            <p className="px-0.5 pb-1.5 text-xs font-medium text-muted-foreground">{addLabel}</p>
            <ComboboxInput autoFocus placeholder="Search versions…" className="mb-1 px-1" />
            <ComboboxEmpty>{options.length === 0 ? emptyMessage : "No matching versions."}</ComboboxEmpty>
            <ComboboxList>
              {(option: SoftwareVersionOption) => (
                <ComboboxItem key={option.id} value={option.id}>
                  {option.versionNumber}
                </ComboboxItem>
              )}
            </ComboboxList>
          </ComboboxPopup>
        </ComboboxPositioner>
      </ComboboxPortal>
    </Combobox>
  )
}
