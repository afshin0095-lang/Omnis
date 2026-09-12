/**
 * Modal — a dialog that takes exclusive focus.
 *
 * WHY THIS IS THE HARDEST COMPONENT IN THE LIBRARY
 * ------------------------------------------------
 * A dialog is the one place where getting accessibility wrong is not cosmetic. Four
 * behaviours are required and none of them is optional:
 *
 * 1. **Focus moves into the dialog** when it opens, and lands on something sensible
 *    rather than on the document body — otherwise a keyboard user tabs from the top
 *    of the page and cannot tell anything happened.
 * 2. **Focus is trapped** while it is open. A tab that escapes to the page behind an
 *    `aria-modal` dialog activates a control the user cannot see.
 * 3. **Focus returns** to whatever had it before, on close. Without this the user is
 *    dropped at the top of the document and loses their place.
 * 4. **Escape closes it**, because that is the platform convention a user brings with
 *    them and cannot be taught away by a product.
 *
 * The dialog is portalled to the end of `document.body`. That is not for styling
 * convenience: a dialog nested inside a `overflow: hidden` or `transform`ed ancestor
 * is clipped by it, and a transformed ancestor becomes the containing block for
 * `position: fixed`, which silently breaks the overlay's coverage.
 *
 * `aria-modal` is set, so assistive technology hides the rest of the page. The
 * background is additionally marked `inert` where the platform supports it, because
 * `aria-modal` describes the dialog to a screen reader but does not stop a keyboard
 * from reaching the content behind it.
 */

import { useEffect, useId, useRef } from "react";
import type { KeyboardEvent, MouseEvent, ReactNode, RefObject } from "react";
import { createPortal } from "react-dom";
import { IconButton } from "../IconButton/IconButton.js";
import { Surface } from "../Surface/Surface.js";
import { Text } from "../Text/Text.js";
import { ANIMATED_CLASS, ANIMATIONS } from "../../styles/index.js";
import { CSS_VARS, blockClass, cn, elementClass } from "../../utils/index.js";
import type { SpacingStep } from "../../types.js";

/** Elements that can receive focus, in the order the platform reports them. */
const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

export type ModalSize = "sm" | "md" | "lg" | "full";

export interface ModalProps {
  /** Whether the dialog is open. The component renders nothing when false. */
  open: boolean;
  /** Called when the user asks to close it: Escape, the close button, or the overlay. */
  onClose: () => void;
  /** Accessible name. Without it the dialog announces as "dialog" and nothing else. */
  title?: ReactNode;
  /** Accessible description, associated via `aria-describedby`. */
  description?: ReactNode;
  children?: ReactNode;
  /** Trailing actions, right-aligned by default. */
  footer?: ReactNode;
  size?: ModalSize;
  padding?: SpacingStep;
  closeOnEscape?: boolean;
  closeOnOverlayClick?: boolean;
  /** Renders the built-in close button. */
  dismissible?: boolean;
  /** Element to focus on open. Defaults to the first focusable element in the dialog. */
  initialFocusRef?: RefObject<HTMLElement | null>;
  /** Portal target. Defaults to `document.body`. */
  portal?: HTMLElement | null;
  className?: string;
  overlayClassName?: string;
}

/**
 * Maximum width per size.
 *
 * The dialog itself is `width: 100%` and the overlay supplies the inset padding, so
 * no `min()` expression is needed — one less thing for a browser to resolve and one
 * less thing that can silently compute to zero.
 */
const SIZE_MAX_WIDTH: Readonly<Record<ModalSize, string>> = {
  sm: "26rem",
  md: "36rem",
  lg: "52rem",
  full: "80rem",
};

/** Every focusable element inside a container, in tab order. */
function focusableWithin(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) => !element.hasAttribute("disabled") && element.tabIndex !== -1,
  );
}

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = "md",
  padding = 6,
  closeOnEscape = true,
  closeOnOverlayClick = true,
  dismissible = true,
  initialFocusRef,
  portal,
  className,
  overlayClassName,
}: ModalProps): ReactNode {
  const generatedId = useId();
  const titleId = `${generatedId}-title`;
  const descriptionId = `${generatedId}-description`;

  const dialogRef = useRef<HTMLDivElement | null>(null);
  // Remembered so focus can be returned on close, and so a re-render while open does
  // not move it again.
  const restoreToRef = useRef<HTMLElement | null>(null);
  // Set when a pointer went down inside the dialog: a drag that starts on content and
  // ends on the overlay must not be read as a request to close.
  const pointerDownInsideRef = useRef(false);

  // Focus management and scroll lock, for as long as the dialog is open.
  useEffect(() => {
    if (!open || typeof document === "undefined") {
      return;
    }

    const dialog = dialogRef.current;
    restoreToRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const target =
      initialFocusRef?.current ??
      focusableWithin(dialog ?? document.createElement("div"))[0] ??
      dialog;
    target?.focus();

    // Lock the background. The scrollbar gap is compensated so the page does not
    // shift sideways by fifteen pixels the moment a dialog opens.
    const body = document.body;
    const previousOverflow = body.style.overflow;
    const previousPaddingRight = body.style.paddingRight;
    const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;
    body.style.overflow = "hidden";
    if (scrollbarWidth > 0) {
      body.style.paddingRight = `${scrollbarWidth}px`;
    }

    // `inert` is the only mechanism that actually stops keyboard and pointer access
    // to the page behind the dialog; `aria-modal` only describes it.
    const inerted: HTMLElement[] = [];
    const rootChildren = Array.from(document.body.children);
    for (const child of rootChildren) {
      if (!(child instanceof HTMLElement) || child.contains(dialog)) {
        continue;
      }
      if (child.hasAttribute("inert")) {
        continue;
      }
      child.setAttribute("inert", "");
      inerted.push(child);
    }

    return () => {
      body.style.overflow = previousOverflow;
      body.style.paddingRight = previousPaddingRight;
      for (const element of inerted) {
        element.removeAttribute("inert");
      }
      // Restore focus only if it has not already moved somewhere deliberate.
      const current = document.activeElement;
      if (
        (current === null || current === document.body || dialog?.contains(current)) &&
        restoreToRef.current !== null
      ) {
        restoreToRef.current.focus();
      }
      restoreToRef.current = null;
    };
  }, [open, initialFocusRef]);

  // Escape closes the dialog from anywhere inside it.
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape" && closeOnEscape) {
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== "Tab") {
      return;
    }

    const dialog = dialogRef.current;
    if (dialog === null) {
      return;
    }
    const focusable = focusableWithin(dialog);
    if (focusable.length === 0) {
      // Nothing to tab to: keep focus on the dialog itself rather than letting it
      // escape to the page behind.
      event.preventDefault();
      dialog.focus();
      return;
    }

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (first === undefined || last === undefined) {
      return;
    }

    if (event.shiftKey && (active === first || !dialog.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };

  if (!open || typeof document === "undefined") {
    return null;
  }

  const overlayPointerDown = (event: MouseEvent<HTMLDivElement>): void => {
    pointerDownInsideRef.current = event.target !== event.currentTarget;
  };

  const overlayClick = (event: MouseEvent<HTMLDivElement>): void => {
    const startedInside = pointerDownInsideRef.current;
    pointerDownInsideRef.current = false;
    if (!closeOnOverlayClick || startedInside || event.target !== event.currentTarget) {
      return;
    }
    onClose();
  };

  const node = (
    <div
      className={cn(blockClass("modal-overlay"), ANIMATED_CLASS, overlayClassName)}
      data-omnis-modal-overlay=""
      onPointerDown={overlayPointerDown}
      onClick={overlayClick}
      style={{
        position: "fixed",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: CSS_VARS.space6,
        background: CSS_VARS.overlay,
        backdropFilter: `blur(${CSS_VARS.glassBlur})`,
        WebkitBackdropFilter: `blur(${CSS_VARS.glassBlur})`,
        zIndex: CSS_VARS.zOverlay,
        animation: `${ANIMATIONS.fadeIn} ${CSS_VARS.durationFast} ${CSS_VARS.easingStandard} both`,
      }}
    >
      <Surface
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title === undefined ? undefined : titleId}
        aria-describedby={description === undefined ? undefined : descriptionId}
        tabIndex={-1}
        tone="raised"
        radius="xl"
        padding={padding}
        elevation="lg"
        bordered
        onKeyDown={handleKeyDown}
        className={cn(blockClass("modal"), blockClass("modal", size), ANIMATED_CLASS, className)}
        style={{
          width: "100%",
          maxWidth: SIZE_MAX_WIDTH[size],
          maxHeight: "100%",
          overflow: "auto",
          display: "flex",
          flexDirection: "column",
          gap: CSS_VARS.space4,
          boxShadow: CSS_VARS.shadowLg,
          animation: `${ANIMATIONS.riseIn} ${CSS_VARS.durationNormal} ${CSS_VARS.easingEmphasized} both`,
        }}
      >
        {title !== undefined || dismissible ? (
          <header
            className={elementClass("modal", "header")}
            style={{
              display: "flex",
              alignItems: "flex-start",
              justifyContent: "space-between",
              gap: CSS_VARS.space3,
            }}
          >
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: CSS_VARS.space1,
                minWidth: 0,
              }}
            >
              {title === undefined ? null : (
                <Text id={titleId} as="h2" size="xl" weight="semibold" tracking="tight">
                  {title}
                </Text>
              )}
              {description === undefined ? null : (
                <Text id={descriptionId} size="sm" tone="muted">
                  {description}
                </Text>
              )}
            </div>
            {dismissible ? (
              <IconButton
                icon={<span aria-hidden="true">&times;</span>}
                label="Close dialog"
                size="sm"
                onClick={onClose}
                className={elementClass("modal", "close")}
              />
            ) : null}
          </header>
        ) : null}

        <div
          className={elementClass("modal", "body")}
          style={{ display: "flex", flexDirection: "column", gap: CSS_VARS.space4, minWidth: 0 }}
        >
          {children}
        </div>

        {footer === undefined ? null : (
          <footer
            className={elementClass("modal", "footer")}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "flex-end",
              gap: CSS_VARS.space2,
            }}
          >
            {footer}
          </footer>
        )}
      </Surface>
    </div>
  );

  return createPortal(node, portal ?? document.body);
}
