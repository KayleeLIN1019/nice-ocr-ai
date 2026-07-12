import { cloneElement, isValidElement, type ButtonHTMLAttributes, type ReactElement } from "react";
import { cn } from "@/lib/utils";

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "success";
type ButtonSize = "sm" | "md" | "icon";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** 渲染为子元素（如 next/link 的 <Link>），合并样式而非包一层 <button>。 */
  asChild?: boolean;
}

const variants: Record<ButtonVariant, string> = {
  primary: "border-primary bg-primary text-primary-foreground hover:bg-primary-hover",
  secondary: "border-border bg-surface text-foreground hover:bg-muted",
  ghost: "border-transparent bg-transparent text-muted-foreground hover:bg-muted hover:text-foreground",
  danger: "border-danger bg-danger text-white hover:bg-danger-strong",
  success: "border-success bg-success text-white hover:bg-success-strong",
};

const sizes: Record<ButtonSize, string> = {
  sm: "h-8 gap-1.5 px-3 text-xs",
  md: "h-9 gap-2 px-4 text-sm",
  icon: "h-8 w-8 justify-center p-0",
};

export function Button({
  className,
  variant = "secondary",
  size = "md",
  type = "button",
  asChild = false,
  children,
  ...props
}: ButtonProps) {
  const composedClassName = cn(
    "inline-flex shrink-0 items-center justify-center rounded-md border font-medium transition-colors disabled:pointer-events-none disabled:opacity-50",
    variants[variant],
    sizes[size],
    className,
  );

  if (asChild && isValidElement(children)) {
    const child = children as ReactElement<{ className?: string }>;
    return cloneElement(child, {
      className: cn(composedClassName, child.props.className),
    });
  }

  return (
    <button type={type} className={composedClassName} {...props}>
      {children}
    </button>
  );
}
