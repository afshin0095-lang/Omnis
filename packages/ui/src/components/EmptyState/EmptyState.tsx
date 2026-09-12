/**
 * EmptyState — what a surface shows when it has nothing to show.
 *
 * WHY THIS IS A COMPONENT AND NOT AN AFTERTHOUGHT
 * -----------------------------------------------
 * An empty list is the first thing a new operator sees, and the default rendering of
 * "no data" is a blank rectangle that reads as a bug. A useful empty state does three
 * jobs at once: confirms the system worked, explains why there is nothing here, and
 * offers the action that would put something here. Those three jobs are structural,
 * which is why they are slots on a component rather than copy each team writes again.
 *
 * It is a `<div>` with no landmark role: an empty state is content, not a region, and
 * adding `role="status"` would announce it on every page that happens to load an empty
 * list.
 */

import type { HTMLAttributes, CSSProperties, ElementType, ReactNode, Ref } from "react";
import { Stack } from "../Stack/Stack.js";
import { Text } from "../Text/Text.js";
import { CSS_VARS, blockClass, cn, elementClass } from "../../utils/index.js";

export interface EmptyStateProps extends Omit<HTMLAttributes<HTMLElement>, "title"> {
  as?: ElementType;
  ref?: Ref<HTMLElement>;
  /** Rendered above the title, typically an icon or an illustration. */
  icon?: ReactNode;
  /** The fact, stated plainly: "No clips yet". */
  title: ReactNode;
  /** The reason and, where useful, what would change it. */
  description?: ReactNode;
  /** The action that would put something here. */
  action?: ReactNode;
  /** A secondary, lower-emphasis action. */
  secondaryAction?: ReactNode;
  /** Tighter spacing, for use inside a card rather than as a whole page. */
  compact?: boolean;
  align?: "start" | "center" | "end";
}

export function EmptyState({
  as,
  icon,
  title,
  description,
  action,
  secondaryAction,
  compact = false,
  align = "center",
  className,
  style,
  children,
  ref,
  ...rest
}: EmptyStateProps): ReactNode {
  const Tag = (as ?? "div") as ElementType;

  const emptyStyle: CSSProperties = {
    display: "flex",
    flexDirection: "column",
    alignItems: align === "center" ? "center" : align === "start" ? "flex-start" : "flex-end",
    justifyContent: "center",
    gap: compact ? CSS_VARS.space3 : CSS_VARS.space5,
    padding: compact ? CSS_VARS.space4 : `${CSS_VARS.space12} ${CSS_VARS.space6}`,
    textAlign: align,
    width: "100%",
  };

  return (
    <Tag
      ref={ref}
      data-omnis-empty-state={compact ? "compact" : "full"}
      className={cn(
        blockClass("empty-state"),
        { [blockClass("empty-state", "compact")]: compact },
        className,
      )}
      style={{ ...emptyStyle, ...style }}
      {...rest}
    >
      {icon === undefined ? null : (
        <span
          aria-hidden="true"
          className={elementClass("empty-state", "icon")}
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            color: CSS_VARS.primaryGlow,
            fontSize: compact ? CSS_VARS.fontSize2xl : CSS_VARS.fontSize3xl,
            filter: `drop-shadow(0 0 16px ${CSS_VARS.primaryGlow})`,
          }}
        >
          {icon}
        </span>
      )}

      <Stack
        gap={2}
        align={align === "center" ? "center" : "stretch"}
        className={elementClass("empty-state", "copy")}
      >
        <Text as="h3" size={compact ? "lg" : "xl"} weight="semibold" tracking="tight" align={align}>
          {title}
        </Text>
        {description === undefined ? null : (
          <Text size="sm" tone="muted" align={align}>
            {description}
          </Text>
        )}
        {children}
      </Stack>

      {action === undefined && secondaryAction === undefined ? null : (
        <Stack
          direction="row"
          gap={3}
          align="center"
          justify="center"
          wrap
          className={elementClass("empty-state", "actions")}
        >
          {action}
          {secondaryAction}
        </Stack>
      )}
    </Tag>
  );
}
