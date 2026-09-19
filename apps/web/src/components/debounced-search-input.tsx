"use client";

import { useEffect, useState } from "react";

/**
 * A search box whose typing state is owned by *this* component, not its caller - the
 * whole point. `value`/`onChange` still work like a normal controlled input from the
 * outside (`value` is the committed search term, `onChange` fires after `delayMs` of no
 * typing), but every keystroke in between only re-renders this one `<input>`, not
 * whatever expensive list the caller renders from `value`.
 *
 * That distinction is load-bearing, not a micro-optimization: on a page-level search box
 * whose `value` feeds a list of a couple thousand rows, a naive debounce that still
 * stores the in-progress text in the *parent's* state (e.g. a `useDebouncedValue` hook
 * called from the list component) re-renders that whole list on every keystroke anyway -
 * only the URL write and the actual filtering end up debounced, not the render. Measured
 * on a 2,000-row requirements list, that re-render-per-keystroke was enough to hang the
 * tab for 45+ seconds typing a single search term. Keeping the fast-changing state
 * (`local`) inside this leaf component, with the parent only being told about it once
 * typing settles, keeps every keystroke's cost down to re-rendering one `<input>`.
 */
export function DebouncedSearchInput({
  value,
  onChange,
  placeholder,
  className,
  delayMs = 300,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  delayMs?: number;
}) {
  const [local, setLocal] = useState(value);

  // Stay in sync when `value` changes from outside (a "Clear filters" button, browser
  // back/forward) rather than from this component's own debounced call below.
  useEffect(() => {
    setLocal(value);
  }, [value]);

  useEffect(() => {
    if (local === value) return;
    const timer = setTimeout(() => onChange(local), delayMs);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [local]);

  return (
    <input
      value={local}
      onChange={(e) => setLocal(e.target.value)}
      placeholder={placeholder}
      className={className}
    />
  );
}
