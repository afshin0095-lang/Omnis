/**
 * Input — a labelled text field.
 *
 * WHY THE LABEL IS PART OF THE COMPONENT
 * --------------------------------------
 * A placeholder is not a label: it disappears on entry, it is not reliably announced,
 * and its contrast is typically too low to read. Wiring a real `<label>` to the field
 * is three ids and two `aria-describedby` entries that every team otherwise gets
 * slightly differently wrong, so the component owns the wiring and the caller only
 * supplies the words.
 *
 * `useId` generates the identifiers. They are stable across server and client renders,
 * which matters because a mismatched id is the classic hydration error and — worse —
 * silently breaks the label association for anyone using a screen reader.
 *
 * THE ERROR IS ANNOUNCED, NOT JUST COLOURED
 * -----------------------------------------
 * A red border communicates nothing without sight. The message is linked with
 * `aria-describedby` and the field is marked `aria-invalid`, so the problem is read
 * out with the field rather than discovered by tabbing away and back.
 */

import { useId } from "react";
import type { CSSProperties, ElementType, InputHTMLAttributes, ReactNode, Ref } from "react";
import { Text } from "../Text/Text.js";
import { FOCUSABLE_CLASS } from "../../styles/index.js";
import { CSS_VARS, blockClass, cn, elementClass } from "../../utils/index.js";
import type { ControlSize } from "../../types.js";

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "size" | "prefix"> {
  as?: ElementType;
  ref?: Ref<HTMLInputElement>;
  /** The field's label. Rendered as a real `<label>` and associated by id. */
  label?: ReactNode;
  /** Supporting text, always associated with the field. */
  hint?: ReactNode;
  /** Validation message. Marks the field invalid when present. */
  error?: ReactNode;
  /** Rendered inside the field, before the text. */
  prefix?: ReactNode;
  /** Rendered inside the field, after the text. */
  suffix?: ReactNode;
  size?: ControlSize;
  /** Forces the invalid presentation without an error message. */
  invalid?: boolean;
  fullWidth?: boolean;
  /** Class applied to the outer wrapper rather than the input. */
  containerClassName?: string;
}

const SIZE_HEIGHT: Readonly<Record<ControlSize, string>> = {
  sm: CSS_VARS.componentButtonHeightSm,
  md: CSS_VARS.componentButtonHeightMd,
  lg: CSS_VARS.componentButtonHeightLg,
};

const SIZE_FONT: Readonly<Record<ControlSize, string>> = {
  sm: CSS_VARS.fontSizeSm,
  md: CSS_VARS.fontSizeBase,
  lg: CSS_VARS.fontSizeLg,
};

export function Input({
  as,
  label,
  hint,
  error,
  prefix,
  suffix,
  size = "md",
  invalid = false,
  fullWidth = true,
  disabled,
  required,
  id,
  className,
  containerClassName,
  style,
  ref,
  ...rest
}: InputProps): ReactNode {
  const Tag = (as ?? "input") as ElementType;
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const hintId = `${inputId}-hint`;
  const errorId = `${inputId}-error`;

  const hasError = error !== undefined && error !== null && error !== false;
  const isInvalid = invalid || hasError;

  // Only ids that actually resolve to content may be listed: an aria-describedby
  // pointing at a missing element is read as silence and masks a real bug.
  const describedBy = [hint === undefined ? null : hintId, hasError ? errorId : null]
    .filter((value): value is string => value !== null)
    .join(" ");

  const fieldStyle: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: CSS_VARS.space2,
    width: fullWidth ? "100%" : undefined,
    minHeight: SIZE_HEIGHT[size],
    paddingInline: CSS_VARS.space3,
    borderRadius: CSS_VARS.radiusMd,
    background: CSS_VARS.surface,
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: isInvalid ? CSS_VARS.danger : CSS_VARS.border,
    boxShadow: isInvalid ? undefined : CSS_VARS.shadowNone,
    color: CSS_VARS.text,
    transition: `border-color ${CSS_VARS.durationFast} ${CSS_VARS.easingStandard}, box-shadow ${CSS_VARS.durationFast} ${CSS_VARS.easingStandard}`,
  };

  const inputStyle: CSSProperties = {
    flex: 1,
    minWidth: 0,
    height: "100%",
    border: 0,
    outline: "none",
    background: "transparent",
    color: "inherit",
    fontFamily: CSS_VARS.fontSans,
    fontSize: SIZE_FONT[size],
    lineHeight: CSS_VARS.lineHeightNormal,
    padding: 0,
  };

  return (
    <div
      className={cn(
        blockClass("field"),
        { [blockClass("field", "invalid")]: isInvalid },
        containerClassName,
      )}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: CSS_VARS.space2,
        width: fullWidth ? "100%" : undefined,
      }}
    >
      {label === undefined ? null : (
        <Text
          as="label"
          htmlFor={inputId}
          size="sm"
          weight="medium"
          tone="muted"
          className={elementClass("field", "label")}
        >
          {label}
          {required === true ? (
            <span
              aria-hidden="true"
              style={{ color: CSS_VARS.danger, marginInlineStart: "0.25em" }}
            >
              *
            </span>
          ) : null}
        </Text>
      )}

      <div className={elementClass("field", "control")} style={fieldStyle}>
        {prefix === undefined ? null : (
          <span
            aria-hidden="true"
            className={elementClass("field", "prefix")}
            style={{ color: CSS_VARS.textSubtle, display: "inline-flex", flexShrink: 0 }}
          >
            {prefix}
          </span>
        )}

        <Tag
          ref={ref}
          id={inputId}
          disabled={disabled}
          required={required}
          aria-invalid={isInvalid || undefined}
          aria-describedby={describedBy.length > 0 ? describedBy : undefined}
          className={cn(blockClass("input"), FOCUSABLE_CLASS, className)}
          style={{ ...inputStyle, ...style }}
          {...rest}
        />

        {suffix === undefined ? null : (
          <span
            aria-hidden="true"
            className={elementClass("field", "suffix")}
            style={{ color: CSS_VARS.textSubtle, display: "inline-flex", flexShrink: 0 }}
          >
            {suffix}
          </span>
        )}
      </div>

      {hint === undefined ? null : (
        <Text id={hintId} size="xs" tone="subtle" className={elementClass("field", "hint")}>
          {hint}
        </Text>
      )}

      {hasError ? (
        // Not a live region: the message is already associated with the field, so it
        // is read when the field is focused. Announcing it again on every keystroke
        // would interrupt the user mid-word.
        <Text id={errorId} size="xs" tone="danger" className={elementClass("field", "error")}>
          {error}
        </Text>
      ) : null}
    </div>
  );
}
