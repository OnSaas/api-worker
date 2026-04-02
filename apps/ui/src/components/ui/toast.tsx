import type { JSX } from "hono/jsx";
import { cx } from "./utils";

export const ToastViewport = ({
	class: className,
	...props
}: JSX.IntrinsicElements["div"]) => (
	<div {...props} class={cx("app-toast", className)} />
);

export const Toast = ({
	class: className,
	...props
}: JSX.IntrinsicElements["div"]) => (
	<div {...props} class={cx("app-toast-card", className)} />
);

export const ToastTitle = ({
	class: className,
	...props
}: JSX.IntrinsicElements["div"]) => (
	<div
		{...props}
		class={cx(
			"app-toast-title mt-1 text-sm font-semibold text-[color:var(--app-ink)]",
			className,
		)}
	/>
);

export const ToastProgress = ({
	class: className,
	...props
}: JSX.IntrinsicElements["span"]) => (
	<span {...props} class={cx("app-toast-progress", className)} />
);
