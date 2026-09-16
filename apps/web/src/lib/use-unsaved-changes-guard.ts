"use client";

import { useEffect, useRef } from "react";

/**
 * Warns before unsaved form changes are lost: a native "leave site?" prompt on an actual
 * page unload (refresh, close tab, typed URL, external link), plus a confirm() gate on
 * in-app link clicks (this app's nav is all real `<a>` elements via next/link, and the App
 * Router has no stable route-change-blocking API to hook into directly).
 *
 * Known gap: the browser back/forward button between two already-visited internal routes
 * is a client-side transition - no `beforeunload`, no anchor click - so it isn't caught
 * here. Callers with a non-anchor way to navigate away (e.g. a button that calls
 * `router.push`) should check `isDirty` themselves before that call.
 */
export function useUnsavedChangesGuard(
  isDirty: boolean,
  message = "You have unsaved changes. Leave without saving?",
) {
  // Read inside the listeners via a ref, not the `isDirty` closure, so the listeners
  // themselves only need to be (de)registered once rather than on every dirty/clean flip.
  const isDirtyRef = useRef(isDirty);
  isDirtyRef.current = isDirty;

  useEffect(() => {
    function handleBeforeUnload(event: BeforeUnloadEvent) {
      if (!isDirtyRef.current) return;
      event.preventDefault();
      // Chrome ignores the prompt unless returnValue is set; the string itself is ignored
      // by every modern browser in favor of a fixed, generic message.
      event.returnValue = "";
    }

    function handleClick(event: MouseEvent) {
      if (!isDirtyRef.current || event.defaultPrevented) return;
      // A modifier/non-primary click means "open in a new tab" - this page isn't actually
      // going anywhere, so there's nothing to warn about.
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = (event.target as HTMLElement | null)?.closest("a");
      if (!anchor || !anchor.href || anchor.target === "_blank") return;
      // A download anchor (e.g. a synthetic <a download> used to save a generated blob)
      // never navigates the page away - it's not "leaving", so it's exempt from this
      // guard regardless of isDirty. Real bug this fixes: a document export's own
      // completed-download click was being caught by this exact listener (isDirty was
      // still true for the instant the export itself is the "unsaved work" being
      // guarded), popping a spurious "leaving this page will cancel it" confirm right as
      // the export finished, and - if declined - silently cancelling the download too.
      if (anchor.hasAttribute("download")) return;
      if (!window.confirm(message)) {
        event.preventDefault();
        // Capture-phase + stopImmediatePropagation, so this runs (and can cancel the
        // click) before next/link's own bubble-phase click handler ever sees it.
        event.stopImmediatePropagation();
      }
    }

    window.addEventListener("beforeunload", handleBeforeUnload);
    document.addEventListener("click", handleClick, true);
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
      document.removeEventListener("click", handleClick, true);
    };
  }, [message]);
}
