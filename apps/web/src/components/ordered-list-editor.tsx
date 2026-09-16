"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ChevronDown, ChevronUp } from "lucide-react";
import { useState } from "react";

interface NamedItem {
  id: string;
  name: string;
  /** The id-prefix code (SYSREQ-1, ...) - only present for requirement/test levels, not
   * environments or statuses, so every code-related prop below is optional and this
   * component degrades to its original name-only behavior when omitted. */
  code?: string;
}

/** Shared "tenant-owned ordered list" management UI - reorder/rename/delete/create -
 * used for hierarchy levels, test levels, and environments (three identical instances of
 * the same UI pattern, backed by three structurally-identical but separate core modules -
 * see the note in test-levels.ts on why those weren't generic-ized too). Statuses use
 * their own bespoke section instead: enable/disable rather than delete, since a status
 * can never truly be removed, only turned off.
 *
 * The `code` (id prefix, e.g. "SYSREQ") is a distinct concept from `name` (the display
 * label) - a team might fix a typo in one without touching the other - so it gets its own
 * input in both the create form and the inline edit form, submitted via `onUpdateCode`
 * separately from `onRename`. Only requirement/test levels pass the code-related props;
 * environments don't have a code at all, and the component works exactly as before when
 * they're omitted. */
export function OrderedListEditor<T extends NamedItem>({
  items,
  onRename,
  onReorder,
  onDelete,
  onCreate,
  onUpdateCode,
  createPlaceholder,
  createCodePlaceholder,
  error,
}: {
  items: T[];
  onRename: (id: string, name: string) => void;
  onReorder: (id: string, direction: "up" | "down") => void;
  onDelete: (id: string) => void;
  onCreate: (name: string, code?: string) => void;
  onUpdateCode?: (id: string, code: string) => void;
  createPlaceholder: string;
  /** Presence of this (rather than a boolean) is what turns on the code input in both the
   * create and edit forms - it's also the placeholder text for the create one. */
  createCodePlaceholder?: string;
  error?: string | null;
}) {
  const hasCodes = createCodePlaceholder !== undefined;
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [editingCode, setEditingCode] = useState("");
  const [newName, setNewName] = useState("");
  const [newCode, setNewCode] = useState("");

  return (
    <>
      <ul className="mt-4 divide-y divide-border overflow-hidden rounded-md border">
        {items.map((item, i) => (
          <li key={item.id} className="flex items-center gap-3 px-3 py-2.5">
              <div className="flex flex-col">
                <Button
                  variant="ghost"
                  size="icon-xs"
                  disabled={i === 0}
                  onClick={() => onReorder(item.id, "up")}
                  aria-label={`Move ${item.name} up`}
                >
                  <ChevronUp />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  disabled={i === items.length - 1}
                  onClick={() => onReorder(item.id, "down")}
                  aria-label={`Move ${item.name} down`}
                >
                  <ChevronDown />
                </Button>
              </div>

              {editingId === item.id ? (
                <form
                  className="flex flex-1 items-center gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    onRename(item.id, editingName);
                    if (hasCodes && onUpdateCode && editingCode !== item.code) onUpdateCode(item.id, editingCode);
                    setEditingId(null);
                  }}
                >
                  <Input
                    autoFocus
                    value={editingName}
                    onChange={(e) => setEditingName(e.target.value)}
                    className="h-8 flex-1"
                  />
                  {hasCodes && (
                    <Input
                      value={editingCode}
                      onChange={(e) => setEditingCode(e.target.value)}
                      placeholder={createCodePlaceholder}
                      className="h-8 w-28 font-mono uppercase"
                      title="The id prefix used everywhere this level's items are shown, e.g. SYSREQ-1"
                    />
                  )}
                  <Button type="submit" variant="ghost" size="sm">
                    Save
                  </Button>
                  <Button type="button" variant="ghost" size="sm" onClick={() => setEditingId(null)}>
                    Cancel
                  </Button>
                </form>
              ) : (
                <button
                  className="flex flex-1 items-center gap-2 text-left text-sm font-medium hover:underline"
                  onClick={() => {
                    setEditingId(item.id);
                    setEditingName(item.name);
                    setEditingCode(item.code ?? "");
                  }}
                >
                  {hasCodes && item.code && (
                    <span className="font-mono text-xs font-semibold text-primary no-underline">{item.code}</span>
                  )}
                  {item.name}
                </button>
              )}

              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground hover:text-destructive"
                onClick={() => {
                  if (confirm(`Delete "${item.name}"?`)) onDelete(item.id);
                }}
              >
                Delete
              </Button>
          </li>
        ))}
      </ul>

      <form
        className="mt-3 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          onCreate(newName, hasCodes ? newCode : undefined);
          setNewName("");
          setNewCode("");
        }}
      >
        <Input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder={createPlaceholder}
          className="flex-1"
        />
        {hasCodes && (
          <Input
            value={newCode}
            onChange={(e) => setNewCode(e.target.value)}
            placeholder={createCodePlaceholder}
            className="w-28 font-mono uppercase"
            title="The id prefix this level's items will use, e.g. SYSREQ-1"
          />
        )}
        <Button type="submit" variant="outline" disabled={!newName.trim() || (hasCodes && !newCode.trim())}>
          Add
        </Button>
      </form>
      {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
    </>
  );
}
