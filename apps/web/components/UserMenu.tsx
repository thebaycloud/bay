"use client";

import { useSession, signOut } from "next-auth/react";
import { LogOut } from "lucide-react";

export function UserMenu() {
  const { data } = useSession();
  const email = data?.user?.email;
  if (!email) return null;
  return (
    <div className="usermenu">
      <span className="ue">{email}</span>
      <button className="btn icon" title="Sign out" onClick={() => signOut({ callbackUrl: "/login" })}>
        <LogOut size={14} />
      </button>
    </div>
  );
}
