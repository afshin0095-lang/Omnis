/**
 * IconButton — a button whose content is an icon.
 *
 * WHY IT IS NOT JUST `Button` WITH AN ICON
 * ----------------------------------------
 * An icon-only control has one failure mode that a labelled control does not: without
 * a text alternative it is announced as "button", with no indication of what it does.
 * Making `label` a required prop means that failure cannot be committed — the compiler
 * rejects an icon button nobody can identify. It is also the reason this is a separate
 * component rather than a `Button` flag: a required prop cannot be enforced on a
 * component whose label is optional.
 *
 * The button is square, its hit area meets the size of the surrounding controls, and
 * the icon is `aria-hidden` because the label already carries the meaning.
 */

import type { ReactNode, Ref } from "react";
import { Button } from "../Button/Button.js";
import type { ButtonProps, ButtonVariant } from "../Button/Button.js";
import { CSS_VARS, blockClass, cn, elementClass } from "../../utils/index.js";
import type { ControlSize } from "../../types.js";

export interface IconButtonProps extends Omit<
  ButtonProps,
  "children" | "iconLeft" | "iconRight" | "fullWidth"
> {
  ref?: Ref<HTMLButtonElement>;
  /** The icon to render. Marked `aria-hidden` internally. */
  icon: ReactNode;
  /** Accessible name. Required: an unlabelled icon button announces as "button". */
  label: string;
  variant?: ButtonVariant;
  size?: ControlSize;
}

/** Square edge length per size, matched to the corresponding `Button` height. */
const EDGE: Readonly<Record<ControlSize, string>> = {
  sm: CSS_VARS.componentButtonHeightSm,
  md: CSS_VARS.componentButtonHeightMd,
  lg: CSS_VARS.componentButtonHeightLg,
};

/** Icon box per size. Kept smaller than the edge so the icon never touches the border. */
const ICON_BOX: Readonly<Record<ControlSize, string>> = {
  sm: CSS_VARS.fontSizeBase,
  md: CSS_VARS.fontSizeLg,
  lg: CSS_VARS.fontSizeXl,
};

export function IconButton({
  icon,
  label,
  size = "md",
  variant = "ghost",
  className,
  style,
  disabled,
  loading,
  ...rest
}: IconButtonProps): ReactNode {
  return (
    <Button
      variant={variant}
      size={size}
      disabled={disabled}
      loading={loading}
      {...rest}
      aria-label={label}
      data-omnis-icon-button={variant}
      className={cn(blockClass("icon-button"), className)}
      style={{
        // Zero horizontal padding and an explicit edge make the control square;
        // without this the icon's intrinsic width decides the shape.
        width: EDGE[size],
        paddingInline: 0,
        ...style,
      }}
    >
      <span
        aria-hidden="true"
        className={elementClass("icon-button", "icon")}
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: ICON_BOX[size],
          height: ICON_BOX[size],
          fontSize: ICON_BOX[size],
        }}
      >
        {icon}
      </span>
    </Button>
  );
}
