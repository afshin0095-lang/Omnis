/**
 * A capture box for callback refs, used by the component tests.
 *
 * WHY THIS EXISTS
 * ---------------
 * A callback ref assigns inside a closure, and TypeScript's control-flow analysis
 * cannot know that the closure has run. A plain `let captured: Element | null = null`
 * is therefore still narrowed to `null` at the assertion site, and reading a property
 * off it fails to compile — the optional chain resolves against `never`.
 *
 * Widening the variable with a cast would compile but would assert nothing: the whole
 * point of these tests is that the element actually reached the caller. Reading the
 * captured node back through a function keeps the declared type honest, because a
 * function's return type is not narrowed by the caller's control flow.
 *
 * Not exported from the package entry point: this is test equipment, not UI.
 */

/** A callback ref plus a reader for whatever it last received. */
export interface RefCapture<TElement> {
  /** Pass this to a component's `ref` prop. */
  readonly ref: (node: TElement | null) => void;
  /** The node last passed to {@link RefCapture.ref}, or `null` before the first call. */
  readonly read: () => TElement | null;
}

/** Creates an empty capture box. */
export function refCapture<TElement>(): RefCapture<TElement> {
  let node: TElement | null = null;
  return {
    ref: (value: TElement | null): void => {
      node = value;
    },
    read: (): TElement | null => node,
  };
}
