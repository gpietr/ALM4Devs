import { Button as ButtonPrimitive } from "@base-ui/react/button"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"

const buttonVariants = cva(
  // Barlow Condensed 600, uppercase, tracked - the handoff's "Button / tab label"
  // typography (13.5px, .06-.1em) - applied here once so every button across the app
  // gets it for free, not per call site. `focus-visible:ring-0` cancels the ring/border
  // treatment base-ui's own default focus styling would otherwise add on top of the
  // global `:focus-visible` outline rule (globals.css) - this app wants exactly one
  // focus indicator, not both stacked.
  "group/button inline-flex shrink-0 items-center justify-center gap-1.5 rounded-none border border-transparent bg-clip-padding font-heading text-[13.5px] tracking-[0.06em] uppercase whitespace-nowrap transition-colors outline-none select-none focus-visible:border-transparent focus-visible:ring-0 active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:opacity-45 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5",
  {
    variants: {
      variant: {
        // Solid accent fill, white text - the one "primary action" treatment (New
        // requirement, Save changes, Start run, Refine, ...). Hover/active are the
        // handoff's own accent-600/700 steps, a literal darken like the previous
        // palette's primary already did, not an opacity fade.
        default: "bg-primary text-primary-foreground hover:bg-primary-hover active:bg-primary-active",
        // Hairline border, transparent fill - the "secondary action" chip (Export,
        // Discard, Add step, Delete, ...) every wireframe screen in the handoff uses far
        // more than a filled button. `outline` is this shape now; `secondary` (below)
        // is kept as a plain alias so existing call sites don't all need renaming.
        outline:
          "border-border bg-transparent hover:bg-foreground/7 aria-expanded:bg-foreground/7",
        secondary: "border-border bg-transparent hover:bg-foreground/7 aria-expanded:bg-foreground/7",
        ghost: "hover:bg-primary/10 hover:text-primary aria-expanded:bg-primary/10 aria-expanded:text-primary",
        destructive: "bg-destructive/10 text-destructive hover:bg-destructive/20",
        link: "text-primary normal-case tracking-normal underline-offset-4 hover:underline",
      },
      size: {
        default:
          "h-8 gap-1.5 px-3 has-data-[icon=inline-end]:pr-2.5 has-data-[icon=inline-start]:pl-2.5",
        xs: "h-6 gap-1 px-2 text-[11px] has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-7 gap-1 px-2.5 text-[12.5px] has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
        lg: "h-9 gap-1.5 px-3 has-data-[icon=inline-end]:pr-2.5 has-data-[icon=inline-start]:pl-2.5",
        icon: "size-8",
        "icon-xs": "size-6 [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-7",
        "icon-lg": "size-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
