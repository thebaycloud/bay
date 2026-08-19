import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * The class joiner every shadcn component expects to import.
 *
 * `clsx` flattens conditionals; `twMerge` then resolves Tailwind conflicts so a
 * caller's `className` actually wins. Without the merge, `<Button className="h-8">`
 * loses to the variant's own `h-10` on cascade order alone, which is the single
 * most common "why won't this override" in a shadcn codebase.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
