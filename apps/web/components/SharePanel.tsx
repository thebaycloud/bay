"use client";

import { useEffect, useState } from "react";
import { Globe, Lock, Users, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Row, RowGroup, RowList } from "@/components/panel/atoms";

/**
 * Who can open this app.
 *
 * Rebuilt on the panel's own row vocabulary. It used to carry class names from
 * the injected drawer's stylesheet — `share-opt`, `so-ic`, `btn sm` — none of
 * which exist in this app, so every control here rendered as an unstyled browser
 * default sitting on nothing: floating options with no container, an uppercase
 * label, and a tinted pink band for the current choice.
 *
 * The three options are one list of rows, which is what a mutually exclusive
 * choice looks like everywhere else here: the current one is filled and ticked,
 * not tinted with the accent. Red means something is wrong; it cannot also mean
 * "this is the one you picked".
 */

type Visibility = "private" | "shared" | "public";

const OPTIONS: { id: Visibility; icon: typeof Lock; label: string; desc: string }[] = [
  { id: "private", icon: Lock, label: "Only me", desc: "Just you can open it" },
  { id: "shared", icon: Users, label: "Specific people", desc: "People you invite by email" },
  { id: "public", icon: Globe, label: "Public", desc: "Anyone with the link" },
];

export default function SharePanel({ slug }: { slug: string }) {
  const [visibility, setVisibility] = useState<Visibility>("private");
  const [grants, setGrants] = useState<string[]>([]);
  const [requests, setRequests] = useState<string[]>([]);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      const r = await fetch(`/api/apps/${slug}/share`);
      if (!r.ok) {
        setError(r.status === 403 ? "Only the owner can manage access" : `Couldn't load (${r.status})`);
        return;
      }
      const j = await r.json();
      setVisibility(j.visibility);
      setGrants(j.grants ?? []);
      setRequests(j.requests ?? []);
    } catch {
      setError("Couldn't load sharing settings");
    }
  }
  useEffect(() => {
    load();
  }, [slug]);

  async function post(body: Record<string, string>) {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`/api/apps/${slug}/share`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setError(j.error ?? `Couldn't save (${r.status})`);
        return;
      }
      setVisibility(j.visibility);
      setGrants(j.grants ?? []);
      setRequests(j.requests ?? []);
    } catch {
      setError("Couldn't reach the server");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      {error ? <p className="text-[14px] text-red">{error}</p> : null}

      {/* Requests first, and only when there are any: somebody is waiting on an
          answer, which outranks every setting below it. */}
      {requests.length > 0 && (
        <RowGroup title="Waiting to be let in">
          {requests.map((rq) => (
            <Row key={rq} title={<span className="font-mono text-[13px]">{rq}</span>}>
              <Button disabled={busy} onClick={() => post({ addEmail: rq })} size="sm">
                Approve
              </Button>
              <Button disabled={busy} onClick={() => post({ denyEmail: rq })} size="sm" variant="ghost">
                Deny
              </Button>
            </Row>
          ))}
        </RowGroup>
      )}

      <RowList>
        {OPTIONS.map((o) => (
          <Row
            icon={o.icon}
            key={o.id}
            onOpen={() => {
              if (!busy && o.id !== visibility) post({ visibility: o.id });
            }}
            picked={visibility === o.id}
            sub={o.desc}
            title={o.label}
          />
        ))}
      </RowList>

      {visibility === "shared" && (
        <RowGroup title="People">
          {grants.map((g) => (
            <Row key={g} title={<span className="font-mono text-[13px]">{g}</span>}>
              <Button
                aria-label={`Remove ${g}`}
                className="size-7 text-ink-3 hover:text-ink"
                disabled={busy}
                onClick={() => post({ removeEmail: g })}
                size="icon-sm"
                variant="ghost"
              >
                <X className="size-3.5" />
              </Button>
            </Row>
          ))}

          {/* The form is the last row of the list, not a control floating under
              it — an invite belongs with the people it joins. */}
          <form
            className="flex items-center gap-2 px-4 py-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (email) {
                post({ addEmail: email });
                setEmail("");
              }
            }}
          >
            <Input
              className="h-9"
              onChange={(e) => setEmail(e.currentTarget.value)}
              placeholder="colleague@company.com"
              type="email"
              value={email}
            />
            <Button disabled={busy || !email} type="submit">
              Add
            </Button>
          </form>
        </RowGroup>
      )}
    </div>
  );
}
