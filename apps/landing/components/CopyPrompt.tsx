"use client";

import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The only call to action on a template page.
 *
 * It copies a prompt rather than starting a deploy, because the first step of
 * signing up is handing that prompt to your agent: the agent clones upstream and
 * runs `bay deploy`, and the CLI's first run is what opens a browser to sign in.
 * There is no wizard on the path on purpose.
 */
export function CopyPrompt({
  prompt,
  label,
  copiedLabel,
  logos,
}: {
  prompt: string;
  label: string;
  /** What the button says once it has copied. */
  copiedLabel: string;
  /** Agent marks, to say who this is for without a sentence saying it. */
  logos?: string[];
}) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2400);
    return () => clearTimeout(t);
  }, [copied]);

  return (
    <button
      type="button"
      aria-label={label}
      onClick={() => {
        navigator.clipboard?.writeText(prompt).then(() => setCopied(true)).catch(() => {});
      }}
      className="group inline-flex h-12 items-center gap-3 rounded-[6px] border border-brand-ink bg-brand pl-3 pr-2 transition-colors hover:bg-[#cf3522]"
    >
      {logos?.length ? (
        <span className="flex items-center">
          {logos.map((l, i) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={l}
              src={`/logos/${l}.png`}
              alt=""
              width={24}
              height={24}
              className={cn(
                // Literal white: the `white` token inverts with the page, and a
                // tile on a red button must not.
                "size-6 rounded-[4px] border border-[#ffffff]/40 bg-[#ffffff] object-contain p-[3px]",
                i > 0 && "-ml-2"
              )}
            />
          ))}
        </span>
      ) : null}
      <span className="text-[15px] font-medium text-[#ffffff]">
        {copied ? copiedLabel : label}
      </span>
      <span className="grid size-8 place-items-center rounded-[4px] text-[#ffffff]/70 transition-colors group-hover:text-[#ffffff]">
        {copied ? <Check size={16} strokeWidth={2.4} /> : <Copy size={15} strokeWidth={2} />}
      </span>
    </button>
  );
}
