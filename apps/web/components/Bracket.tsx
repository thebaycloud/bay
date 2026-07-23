import type { ReactNode } from "react";

/** Corner registration brackets — wraps any element. */
export function Bracket({ children }: { children: ReactNode }) {
  return (
    <span className="bkt">
      {children}
      <span className="k k1" /><span className="k k2" /><span className="k k3" /><span className="k k4" />
    </span>
  );
}
