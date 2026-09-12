/**
 * Tooltip — supplementary text anchored to a control.
 *
 * WHAT A TOOLTIP MAY AND MAY NOT CONTAIN
 * --------------------------------------
 * A tooltip expands on a control that is already identifiable. It must never be the
 * *only* label — an icon button whose name lives in a tooltip is unnamed until the
 * pointer arrives, which is why `IconButton` requires a `label` prop of its own.
 * It must never contain interactive content, because a tooltip is dismissed by the
 * very movement required to reach it.
 *
 * ASSOCIATION
 * -----------
 * The tooltip is linked with `aria-describedby`, not `aria-labelledby`: it describes
 * the trigger, it does not name it. The attribute is applied only while the tooltip
 * is shown, because a permanently-associated description would be read on every
 * focus even when nothing is visible, and the user would hear text with no on-screen
 * counterpart.
 *
 * KEYBOARD
 * --------
 * Shown on focus as well as hover, and dismissed by Escape. A tooltip that only
 * appears on hover is invisible to anyone who does not use a pointer, which makes the
 * information it carries pointer-only — an accessibility failure, not a nicety.
 */

import { cloneElement, isValidElement, useEffect, useId, useRef, useState } from "react";
import type {
  CSSProperties,
  FocusEvent,
  KeyboardEvent,
  MouseEvent,
  ReactElement,
  ReactNode,
} from "react";
import { ANIMATED_CLASS, ANIMATIONS } from "../../styles/index.js";
import { CSS_VARS, blockClass, cn } from "../../utils/index.js";
import type { Placement } from "../../types.js";

export interface TooltipProps {
  /** The tooltip's content. Text, or a short fragment; never interactive. */
  content: ReactNode;
  /** The trigger. Must be focusable, or the tooltip is pointer-only. */
  children: ReactElement;
  placement?: Placement;
  /** Hover delay in milliseconds. Focus shows the tooltip immediately. */
  delay?: number;
  /** Explicit id, for callers that need to reference the tooltip themselves. */
  id?: string;
  /** Disables the tooltip without unmounting the trigger. */
  disabled?: boolean;
}

/** Offset from the trigger, so the tooltip never touches what it describes. */
const OFFSET = "8px";

/** Positions the floating layer relative to the wrapper. */
const PLACEMENT_STYLE: Readonly<Record<Placement, CSSProperties>> = {
  top: { bottom: `calc(100% + ${OFFSET})`, left: "50%", transform: "translateX(-50%)" },
  bottom: { top: `calc(100% + ${OFFSET})`, left: "50%", transform: "translateX(-50%)" },
  left: { right: `calc(100% + ${OFFSET})`, top: "50%", transform: "translateY(-50%)" },
  right: { left: `calc(100% + ${OFFSET})`, top: "50%", transform: "translateY(-50%)" },
};

export function Tooltip({
  content,
  children,
  placement = "top",
  delay = 250,
  id,
  disabled = false,
}: TooltipProps): ReactNode {
  const generatedId = useId();
  const tooltipId = id ?? generatedId;
  const [visible, setVisible] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = (): void => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  // A pending show timer must not survive unmount, or it fires against a component
  // that no longer exists.
  useEffect(() => clearTimer, []);

  const showAfterDelay = (): void => {
    clearTimer();
    timerRef.current = setTimeout(() => {
      setVisible(true);
    }, delay);
  };

  const showImmediately = (): void => {
    // Keyboard focus gets no delay: the user has already navigated deliberately, and
    // making them wait to discover what a control does is friction without a purpose.
    clearTimer();
    setVisible(true);
  };

  const hide = (): void => {
    clearTimer();
    setVisible(false);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLSpanElement>): void => {
    if (event.key === "Escape" && visible) {
      // Stop the event so a tooltip inside a modal dismisses itself without closing
      // the modal underneath it.
      event.stopPropagation();
      hide();
    }
  };

  if (!isValidElement(children)) {
    // A tooltip needs a single element to anchor to and to decorate with
    // aria-describedby. Refusing to render anything would hide the trigger, so the
    // child is rendered bare and the tooltip is dropped.
    return children;
  }

  const show = !disabled && visible;

  const trigger = cloneElement(children as ReactElement<Record<string, unknown>>, {
    "aria-describedby": show ? tooltipId : undefined,
    onMouseEnter: (event: MouseEvent<HTMLElement>) => {
      const existing = (children.props as Record<string, unknown>)["onMouseEnter"];
      if (typeof existing === "function") {
        (existing as (event: MouseEvent<HTMLElement>) => void)(event);
      }
      showAfterDelay();
    },
    onMouseLeave: (event: MouseEvent<HTMLElement>) => {
      const existing = (children.props as Record<string, unknown>)["onMouseLeave"];
      if (typeof existing === "function") {
        (existing as (event: MouseEvent<HTMLElement>) => void)(event);
      }
      hide();
    },
    onFocus: (event: FocusEvent<HTMLElement>) => {
      const existing = (children.props as Record<string, unknown>)["onFocus"];
      if (typeof existing === "function") {
        (existing as (event: FocusEvent<HTMLElement>) => void)(event);
      }
      showImmediately();
    },
    onBlur: (event: FocusEvent<HTMLElement>) => {
      const existing = (children.props as Record<string, unknown>)["onBlur"];
      if (typeof existing === "function") {
        (existing as (event: FocusEvent<HTMLElement>) => void)(event);
      }
      hide();
    },
  });

  return (
    <span
      className={blockClass("tooltip-anchor")}
      onKeyDown={handleKeyDown}
      style={{ position: "relative", display: "inline-flex" }}
    >
      {trigger}
      {show ? (
        <span
          id={tooltipId}
          role="tooltip"
          data-omnis-tooltip={placement}
          className={cn(blockClass("tooltip"), blockClass("tooltip", placement), ANIMATED_CLASS)}
          style={{
            position: "absolute",
            ...PLACEMENT_STYLE[placement],
            zIndex: CSS_VARS.zTooltip,
            maxWidth: "20rem",
            padding: `${CSS_VARS.space1} ${CSS_VARS.space2}`,
            borderRadius: CSS_VARS.radiusSm,
            background: CSS_VARS.surfaceRaised,
            borderWidth: "1px",
            borderStyle: "solid",
            borderColor: CSS_VARS.border,
            boxShadow: CSS_VARS.shadowMd,
            color: CSS_VARS.text,
            fontFamily: CSS_VARS.fontSans,
            fontSize: CSS_VARS.fontSizeXs,
            lineHeight: CSS_VARS.lineHeightNormal,
            textAlign: "center",
            pointerEvents: "none",
            whiteSpace: "normal",
            animation: `${ANIMATIONS.fadeIn} ${CSS_VARS.durationInstant} ${CSS_VARS.easingStandard} both`,
          }}
        >
          {content}
        </span>
      ) : null}
    </span>
  );
}
