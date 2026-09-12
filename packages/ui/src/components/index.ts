/**
 * The OMNIS component library.
 *
 * ORGANISING PRINCIPLE
 * --------------------
 * Fifteen components, in three groups:
 *
 * - **Surfaces** — `Surface`, `Card`, `Panel`, `Divider`: the containers that decide
 *   what reads as grouped and what reads as raised.
 * - **Layout and type** — `Stack`, `Text`, `EmptyState`: composition and copy.
 * - **Controls and feedback** — `Button`, `IconButton`, `Input`, `Badge`, `Spinner`,
 *   `Progress`, `Modal`, `Tooltip`.
 *
 * Every one of them is polymorphic (`as`), forwards a ref, accepts `className` and
 * `style`, and resolves its appearance from theme custom properties rather than from
 * literals. That uniformity is the point: a consumer should never have to read a
 * component's source to know how to override it.
 */

export { Badge } from "./Badge/index.js";
export type { BadgeProps } from "./Badge/index.js";

export { Button, buttonHoverBackground } from "./Button/index.js";
export type { ButtonProps, ButtonVariant } from "./Button/index.js";

export { Card, CardContent, CardFooter, CardHeader, CardTitle } from "./Card/index.js";
export type {
  CardContentProps,
  CardFooterProps,
  CardHeaderProps,
  CardProps,
  CardTitleProps,
} from "./Card/index.js";

export { Divider } from "./Divider/index.js";
export type { DividerProps } from "./Divider/index.js";

export { EmptyState } from "./EmptyState/index.js";
export type { EmptyStateProps } from "./EmptyState/index.js";

export { IconButton } from "./IconButton/index.js";
export type { IconButtonProps } from "./IconButton/index.js";

export { Input } from "./Input/index.js";
export type { InputProps } from "./Input/index.js";

export { Modal } from "./Modal/index.js";
export type { ModalProps, ModalSize } from "./Modal/index.js";

export { Panel } from "./Panel/index.js";
export type { PanelProps } from "./Panel/index.js";

export { Progress } from "./Progress/index.js";
export type { ProgressProps } from "./Progress/index.js";

export { Spinner } from "./Spinner/index.js";
export type { SpinnerProps } from "./Spinner/index.js";

export { Stack } from "./Stack/index.js";
export type { StackProps } from "./Stack/index.js";

export { Surface } from "./Surface/index.js";
export type { SurfaceProps } from "./Surface/index.js";

export { Text } from "./Text/index.js";
export type { TextProps, TextSize, TextTracking, TextWeight } from "./Text/index.js";

export { Tooltip } from "./Tooltip/index.js";
export type { TooltipProps } from "./Tooltip/index.js";
