import Link from "next/link";
import { ArrowLeft } from "lucide-react";

/**
 * The "up one level" link every page below the landing page carries.
 *
 * Shared because it appeared on four pages and was drifting: two of them had an
 * arrow glyph in the text, one had none, and none of them agreed on the gap.
 */
export function BackLink({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      className="group inline-flex items-center gap-2 text-[14px] text-ink-2 transition-colors hover:text-ink"
    >
      <ArrowLeft
        size={14}
        strokeWidth={2}
        className="transition-transform group-hover:-translate-x-[3px]"
      />
      {label}
    </Link>
  );
}
