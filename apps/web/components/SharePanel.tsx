"use client";

import { useEffect, useState } from "react";
import { AtSign, Globe, Lock, Mail, Users, X } from "lucide-react";
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
 * "Specific people" holds two kinds of row: a person, and a whole company —
 * "@luwo.ai" is one rule that stands for everyone there, and it is a row beside
 * the people rather than a fourth option, so the list answers "who is in?" in
 * one place.
 *
 * The three options are one list of rows, which is what a mutually exclusive
 * choice looks like everywhere else here: the current one is filled and ticked,
 * not tinted with the accent. Red means something is wrong; it cannot also mean
 * "this is the one you picked".
 */

type Visibility = "private" | "shared" | "public";

const OPTIONS: { id: Visibility; icon: typeof Lock; label: string; desc: string }[] = [
  { id: "private", icon: Lock, label: "Only me", desc: "Just you can open it" },
  { id: "shared", icon: Users, label: "Specific people", desc: "People you invite, or a whole company" },
  { id: "public", icon: Globe, label: "Public", desc: "Anyone with the link" },
];

/**
 * Is what they typed a company, or a person?
 *
 * `@luwo.ai` and `luwo.ai` are the company; `boris@luwo.ai` is Boris. One field
 * for both because that is how people write it — nobody wants to pick a mode
 * before typing an address. The server normalises and refuses; this only decides
 * which name the value is sent under.
 */
function isDomainInput(value: string): boolean {
  const v = value.trim();
  return v.startsWith("@") || !v.includes("@");
}

export default function SharePanel({ slug }: { slug: string }) {
  const [visibility, setVisibility] = useState<Visibility>("private");
  const [grants, setGrants] = useState<string[]>([]);
  const [domains, setDomains] = useState<string[]>([]);
  const [requests, setRequests] = useState<string[]>([]);
  const [workspaceDomain, setWorkspaceDomain] = useState<string | null>(null);
  /** One field for both an address and a company — see `isDomainInput`. */
  const [who, setWho] = useState("");
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
      setDomains(j.domains ?? []);
      setRequests(j.requests ?? []);
      setWorkspaceDomain(j.workspaceDomain ?? null);
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
      setDomains(j.domains ?? []);
      setRequests(j.requests ?? []);
      setWorkspaceDomain(j.workspaceDomain ?? null);
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
            <Row key={rq} title={<span className="text-[14px]">{rq}</span>}>
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
        <div className="flex flex-col gap-2.5">
          <RowGroup title="People and companies">
            {/* Rules first: one row here can stand for a hundred below it, so
                reading them in the other order tells you who is in too late. */}
            {domains.map((d) => (
              <Row
                icon={Globe}
                key={d}
                sub="Anyone signed in with a verified address there"
                title={`@${d}`}
              >
                <Button
                  aria-label={`Remove @${d}`}
                  className="size-7 text-ink-3 hover:text-ink"
                  disabled={busy}
                  onClick={() => post({ removeDomain: d })}
                  size="icon-sm"
                  variant="ghost"
                >
                  <X className="size-3.5" />
                </Button>
              </Row>
            ))}

            {grants.map((g) => (
              <Row icon={Mail} key={g} title={g}>
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
                const v = who.trim();
                if (!v) return;
                post(isDomainInput(v) ? { addDomain: v } : { addEmail: v });
                setWho("");
              }}
            >
              {/* Not type="email": the browser refuses "@luwo.ai" on its own,
                  and the whole point of one field is that both spellings land. */}
              <Input
                className="h-9"
                inputMode="email"
                onChange={(e) => setWho(e.currentTarget.value)}
                placeholder="colleague@company.com or @company.com"
                type="text"
                value={who}
              />
              <Button disabled={busy || !who.trim()} type="submit">
                Add
              </Button>
            </form>
          </RowGroup>

          {/* The rule people actually mean, one click, spelled correctly. Only
              for a company account — a personal workspace has no domain, and
              "everyone at gmail.com" is not an organisation. */}
          {workspaceDomain && !domains.includes(workspaceDomain) && (
            <div>
              <Button
                className="gap-1.5"
                disabled={busy}
                onClick={() => post({ addDomain: workspaceDomain })}
                size="sm"
                variant="outline"
              >
                <AtSign className="size-3.5" />
                Everyone at {workspaceDomain}
              </Button>
            </div>
          )}

          {domains.length > 0 && (
            <p className="px-0.5 text-[13px] text-ink-3">
              A company rule admits people who signed in with Google or GitHub on that address.
              Someone who signed up with a password is asked to sign in that way first — we can&apos;t
              tell the address is theirs otherwise.
            </p>
          )}
        </div>
      )}

    </div>
  );
}
