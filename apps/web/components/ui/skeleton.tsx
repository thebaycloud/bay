import { cn } from "@/lib/utils"

function Skeleton({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      // `bg-accent`, which is the registry's own choice and maps to --tile here.
      // It was `bg-primary/10` — the BRAND RED at ten percent — so every skeleton
      // in the product was a pink block, which reads as a warning rather than as
      // an absence.
      className={cn("animate-pulse rounded-md bg-accent", className)}
      {...props}
    />
  )
}

export { Skeleton }
