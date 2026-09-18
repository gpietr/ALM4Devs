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
} from "@/components/ui/combobox"
import { formatItemId } from "@/lib/format-item-id"
import { guardEscapeClear } from "@/components/requirement-picker"

export interface ArchitectureOption {
  id: string
  title: string
  kind: string
  levelName: string
  levelCode: string
  sequenceNumber: number
}

function optionLabel(option: ArchitectureOption): string {
  return `${formatItemId(option.levelCode, option.sequenceNumber)}: ${option.title}`
}

/**
 * Tag-style architecture linker (items / units / OTS) - same chip pattern as
 * RequirementPicker. Used on requirement and test-case detail pages; architecture
 * detail uses RequirementPicker / a simple test-case chip picker instead.
 */
export function ArchitecturePicker({
  options,
  value,
  onChange,
  placeholder = "Search software items…",
  emptyMessage = "No software items in this product yet.",
  className,
}: {
  options: ArchitectureOption[]
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
        getValue: (option: ArchitectureOption) => option.id,
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
            <ComboboxEmpty>{options.length === 0 ? emptyMessage : "No matching software items."}</ComboboxEmpty>
            <ComboboxList>
              {(option: ArchitectureOption) => (
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

export interface TestCaseOption {
  id: string
  title: string
  levelCode: string
  sequenceNumber: number
}

function testCaseLabel(option: TestCaseOption): string {
  return `${formatItemId(option.levelCode, option.sequenceNumber)}: ${option.title}`
}

/** Chip multi-select for linking test cases from an architecture node. */
export function TestCasePicker({
  options,
  value,
  onChange,
  placeholder = "Search test cases…",
  emptyMessage = "No test cases in this product yet.",
  className,
}: {
  options: TestCaseOption[]
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
        getValue: (option: TestCaseOption) => option.id,
        getLabel: testCaseLabel,
      }),
    [options],
  )

  return (
    <Combobox items={items} multiple value={value} onValueChange={guardEscapeClear(onChange)}>
      <ComboboxInputGroup className={className}>
        <ComboboxChips>
          {value.map((id) => {
            const option = optionsById.get(id)
            const label = option ? testCaseLabel(option) : id
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
            <ComboboxEmpty>{options.length === 0 ? emptyMessage : "No matching test cases."}</ComboboxEmpty>
            <ComboboxList>
              {(option: TestCaseOption) => (
                <ComboboxItem key={option.id} value={option.id}>
                  {testCaseLabel(option)}
                </ComboboxItem>
              )}
            </ComboboxList>
          </ComboboxPopup>
        </ComboboxPositioner>
      </ComboboxPortal>
    </Combobox>
  )
}
