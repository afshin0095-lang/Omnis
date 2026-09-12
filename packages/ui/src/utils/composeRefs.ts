/**
 * Ref composition.
 *
 * WHY COMPONENTS NEED THIS
 * ------------------------
 * Every component in this package forwards a ref, because a consumer needs the
 * underlying element to position a popover, focus a field or measure a surface.
 * Several components *also* need that element themselves — `Modal` traps focus in
 * its dialog node, `Tooltip` reads its trigger's box. Composing the two refs lets a
 * component keep its own handle without stealing the consumer's.
 *
 * REACT 19 CLEANUP
 * ----------------
 * A ref callback may return a cleanup function, and React calls it when the ref is
 * detached. The composed callback must therefore return a function that runs every
 * inner cleanup; dropping them would leave a detached element still referenced by
 * whoever returned the cleanup — a leak that only surfaces after many mount and
 * unmount cycles.
 */

import type { Ref, RefCallback, RefObject } from "react";

/** Every ref shape this package accepts. */
export type ComposableRef<T> = Ref<T> | RefObject<T | null> | undefined | null;

/** Assigns a value to one ref, returning its cleanup if it produced one. */
function assignRef<T>(ref: ComposableRef<T>, value: T | null): (() => void) | undefined {
  if (ref === null || ref === undefined) {
    return undefined;
  }
  if (typeof ref === "function") {
    const result = ref(value);
    // React 19 ref callbacks may return a cleanup; older ones return void.
    return typeof result === "function" ? result : undefined;
  }
  // `RefObject.current` is writable in React 19.
  ref.current = value;
  return undefined;
}

/**
 * Merges refs into a single callback ref.
 *
 * The returned callback closes over the refs it was given, so a component whose
 * ref list changes identity every render should memoise the result.
 */
export function composeRefs<T>(...refs: readonly ComposableRef<T>[]): RefCallback<T | null> {
  return (value: T | null) => {
    const cleanups: Array<() => void> = [];
    for (const ref of refs) {
      const cleanup = assignRef(ref, value);
      if (cleanup !== undefined) {
        cleanups.push(cleanup);
      }
    }
    if (cleanups.length === 0) {
      return undefined;
    }
    return () => {
      // Reverse order: an inner ref that depends on an outer one is released in the
      // opposite order to acquisition.
      for (let index = cleanups.length - 1; index >= 0; index -= 1) {
        cleanups[index]?.();
      }
    };
  };
}
