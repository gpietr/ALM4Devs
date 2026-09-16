"use client";

import { MinimalTiptapEditor } from "@/components/ui/minimal-tiptap";

/**
 * Thin wrapper over the shadcn-registry "minimal-tiptap" editor
 * (https://github.com/Aslam97/shadcn-minimal-tiptap, MIT) instead of the hand-rolled
 * toolbar this used to be. Two real bugs traced back to the homemade version, and rather
 * than keep patching a toolbar no one else has exercised at scale, this swaps in one that
 * has: it ships dedicated `ResetMarksOnEnter`/`UnsetAllMarks` extensions specifically for
 * the class of "a mark keeps applying after the cursor moves" bug we kept hitting, plus
 * every toolbar button already wired for correct mousedown/focus/selection handling. Same
 * Tiptap engine, same HTML output - existing stored content and the sanitizer in
 * packages/core/src/rich-text.ts are unaffected; only the toolbar/editor shell changed.
 */
export function RichTextEditor({
  value,
  onChange,
  placeholder,
  /** Associates any images uploaded through this instance with a step execution
   * (evidence) rather than leaving them as an unassociated rich-text image. */
  stepExecutionId,
  /** For dense contexts (a step's cell in the test-case step table) where the default
   * min-h-40 reserved space is overkill - most steps are a line or two, not a document.
   * Same toolbar and engine, just a shorter minimum content height. */
  compact,
}: {
  value: string;
  onChange: (html: string) => void;
  placeholder?: string;
  stepExecutionId?: string;
  compact?: boolean;
}) {
  async function uploader(file: File): Promise<string> {
    const query = stepExecutionId ? `?stepExecutionId=${stepExecutionId}` : "";
    const res = await fetch(`/api/attachments/upload${query}`, {
      method: "POST",
      headers: {
        "Content-Type": file.type || "application/octet-stream",
        "X-Filename": file.name,
      },
      body: file,
    });
    if (!res.ok) throw new Error("Image upload failed");
    const body = (await res.json()) as { url: string };
    return body.url;
  }

  return (
    <MinimalTiptapEditor
      value={value}
      onChange={(v) => onChange(typeof v === "string" ? v : "")}
      output="html"
      placeholder={placeholder}
      uploader={uploader}
      // font-normal for the same reason as before (see TECH_STACK.md): this editor gets
      // placed inside shadcn's Label at a few call sites, which ships font-medium in its
      // own base classes - an explicit reset here means this component is never fragile
      // to an ancestor's incidental font-weight, regardless of which editor renders it.
      editorContentClassName="font-normal"
      // The vendored ProseMirror element ships with no padding and no min-height, so an
      // empty/short field rendered right under the (still real, just smaller now) toolbar
      // left almost no visible room for actual content. min-h-40 (10rem) reserves real
      // typing/reading space regardless of how little has been typed yet; p-3 keeps text
      // off the border.
      editorClassName={compact ? "min-h-16 p-2" : "min-h-40 p-3"}
      className="w-full font-normal"
    />
  );
}
