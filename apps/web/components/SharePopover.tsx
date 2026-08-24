"use client";

import { useCallback, useEffect, useState } from "react";
import {
  AtSign, Check, ChevronDown, Globe, Link2, Lock, UserPlus, Users, X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Who can open this app — from the top right, on every tab.
 *
 * It was a row inside Dev mode called "Access", which is the wrong place twice
 * over. Sharing is not a development concern: you share while looking at the app,
 * in the middle of a conversation about it, and reaching it meant leaving Chat,
 * entering Dev, finding a row, and opening a screen. And the row was the only
 * place a pending access request appeared, so a request nobody thought to go
 * looking for was a request nobody answered.
 *
 * So it lives where every product that does this well puts it: an icon in the top
 * right, a panel that drops out of it, and a count on the icon when somebody is
 * waiting.
 *
 * THE LAYOUT IS LOVABLE'S, deliberately, because it is the right shape for this:
 * title and a copy-link on one line; one invite field with its button beside it;
 * the people who already have access as plain rows; and "general access" LAST as
 * a single row with a dropdown — not three options with a tick. A mutually
 * exclusive setting that is usually left alone should read as one line stating
 * what is true, not as a menu you have to parse every time.
 *
 * The palette, radii and type are ours. Lovable's shape, this product's surface.
 */

type Visibility = "private" | "shared" | "public";

const ACCESS: Record<Visibility, { icon: typeof Lock; label: string; desc: string }> = {
  private: { icon: Lock, label: "Only me", desc: "Nobody else can open it" },
  shared: { icon: Users, label: "Specific people", desc: "People you invite, or a whole company" },
  public: { icon: Globe, label: "Anyone with the link", desc: "No sign-in needed" },
};
const ORDER: Visibility[] = ["private", "shared", "public"];

/**
 * Is what they typed a company, or a person?
 *
 * `@acme.com` and `acme.com` are the company; `boris@acme.com` is Boris. One field
 * for both because that is how people write it — nobody wants to pick a mode
 * before typing an address. The server normalises and refuses; this only decides
 * which name the value is sent under.
 */
function isDomainInput(value: string): boolean {
  const v = value.trim();
  return v.startsWith("@") || !v.includes("@");
}

/** One person, as the panel draws them. */
interface Person {
  email: string;
  /** From the identity provider. Null for a password account or an unknown address. */
  name: string | null;
  /** `profile.picture` or `avatar_url`, refreshed on every sign-in. */
  image: string | null;
}

interface State {
  visibility: Visibility;
  people: Person[];
  waiting: Person[];
  domains: string[];
  workspaceDomain: string | null;
}

/**
 * Somebody's initials, from the best thing we know about them.
 *
 * Their name when we have it — "Arsen Kylysbek" is AK — and the local part of
 * their address when we do not. NOT the whole address split on punctuation:
 * `ilmak1704@gmail.com` would give "I1", and a digit in a monogram reads as a
 * mistake. One letter is better than two wrong ones.
 */
function initials(p: Person): string {
  const from = (p.name ?? "").trim() || p.email.split("@")[0].replace(/[._-]+/g, " ");
  const words = from.split(/\s+/).filter((w) => /^[a-z]/i.test(w));
  if (words.length === 0) return p.email[0]?.toUpperCase() ?? "?";
  const first = words[0][0];
  const last = words.length > 1 ? words[words.length - 1][0] : "";
  return (first + last).toUpperCase();
}

export function SharePopover({ slug, address }: { slug: string; address: string }) {
  const [s, setS] = useState<State | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [who, setWho] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const take = useCallback((j: Partial<State>) => {
    setS({
      visibility: (j.visibility ?? "private") as Visibility,
      people: j.people ?? [],
      waiting: j.waiting ?? [],
      domains: j.domains ?? [],
      workspaceDomain: j.workspaceDomain ?? null,
    });
  }, []);

  // On MOUNT, not on open: the badge below is the only thing that tells somebody
  // a person is waiting to be let in, and a badge that appears once you open the
  // panel is a badge for a panel you already opened.
  useEffect(() => {
    let alive = true;
    fetch(`/api/apps/${encodeURIComponent(slug)}/share`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.status === 403 ? "Only the owner can manage access" : `Couldn't load (${r.status})`))))
      .then((j) => alive && take(j))
      .catch((e) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => { alive = false; };
  }, [slug, take]);

  async function post(body: Record<string, string>) {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`/api/apps/${encodeURIComponent(slug)}/share`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { setError(j.error ?? `Couldn't save (${r.status})`); return; }
      take(j);
    } catch {
      setError("Couldn't reach the server");
    } finally {
      setBusy(false);
    }
  }

  const waiting = s?.waiting.length ?? 0;
  const current = ACCESS[s?.visibility ?? "private"];
  const CurrentIcon = current.icon;

  function invite() {
    const v = who.trim();
    if (!v) return;
    void post(isDomainInput(v) ? { addDomain: v } : { addEmail: v });
    setWho("");
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          aria-label={waiting > 0 ? `Share — ${waiting} waiting to be let in` : "Share"}
          className="relative size-8 shrink-0"
          size="icon-sm"
          variant="outline"
        >
          <UserPlus className="size-4" />
          {/* The one signal that used to have nowhere to live. Red, because
              somebody is blocked on an answer — the only thing on this header
              that is. */}
          {waiting > 0 ? (
            <span className="absolute -right-1 -top-1 flex size-4 items-center justify-center rounded-full bg-red text-[10px] font-medium tabular-nums text-white">
              {waiting}
            </span>
          ) : null}
        </Button>
      </PopoverTrigger>

      <PopoverContent align="end" className="w-[520px] p-0" sideOffset={8}>
        <div className="flex items-center gap-3 px-4 pb-3 pt-3.5">
          <h2 className="text-[15px] font-[450] text-ink">Share app</h2>
          <button
            className="ml-auto inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[13px] text-ink transition-colors hover:text-ink-2"
            onClick={() => {
              void navigator.clipboard?.writeText(`https://${address}`).then(() => setCopied(true));
            }}
            type="button"
          >
            {copied ? <Check className="size-3.5" /> : <Link2 className="size-3.5" />}
            {copied ? "Copied" : "Copy link"}
          </button>
        </div>

        <div className="flex items-center gap-2 px-4 pb-3.5">
          {/* Not type="email": the browser refuses "@acme.com" on its own, and the
              whole point of one field is that both spellings land. */}
          <Input
            aria-label="Invite by email or company"
            className="h-9 min-w-0 flex-1"
            inputMode="email"
            onChange={(e) => setWho(e.currentTarget.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); invite(); } }}
            placeholder="colleague@company.com or @company.com"
            type="text"
            value={who}
          />
          <Button className="h-9 shrink-0" disabled={busy || !who.trim()} onClick={invite}>
            Invite
          </Button>
        </div>

        {error ? <p className="px-4 pb-3 text-[13px] text-red">{error}</p> : null}

        {s === null && !error ? (
          <div className="flex flex-col gap-2.5 border-t border-border px-4 py-3.5">
            <Skeleton className="h-3.5 w-40" />
            <Skeleton className="h-3.5 w-28" />
          </div>
        ) : null}

        {/* Requests first, and only when there are any: somebody is waiting on an
            answer, which outranks every setting below it. */}
        {s && s.waiting.length > 0 ? (
          <Section>
            {s.waiting.map((p) => (
              <Line key={p.email} lead={<Avatar person={p} />} sub={p.name ? p.email : "asking to be let in"} title={p.name ?? p.email}>
                <Button className="h-7 px-2.5 text-[13px]" disabled={busy} onClick={() => void post({ addEmail: p.email })} size="sm">
                  Approve
                </Button>
                <Button className="h-7 px-2 text-[13px] text-ink-2 hover:text-ink" disabled={busy} onClick={() => void post({ denyEmail: p.email })} size="sm" variant="ghost">
                  Deny
                </Button>
              </Line>
            ))}
          </Section>
        ) : null}

        {s && (s.domains.length > 0 || s.people.length > 0) ? (
          <Section>
            {/* Rules first: one row here can stand for a hundred below it, so
                reading them in the other order tells you who is in too late. */}
            {s.domains.map((d) => (
              <Line
                key={d}
                lead={
                  <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-tile">
                    <Globe className="size-3.5 text-ink-3" />
                  </span>
                }
                sub="Anyone signed in with a verified address there"
                title={`@${d}`}
              >
                <Remove busy={busy} label={`@${d}`} onClick={() => void post({ removeDomain: d })} />
              </Line>
            ))}
            {s.people.map((p) => (
              <Line
                key={p.email}
                lead={<Avatar person={p} />}
                // The name on top and the address under it when we know both. A
                // person is easier to recognise by their face and name than by a
                // string, which is the whole reason this stopped being an
                // envelope icon beside an email.
                sub={p.name ? p.email : undefined}
                title={p.name ?? p.email}
              >
                <Remove busy={busy} label={p.email} onClick={() => void post({ removeEmail: p.email })} />
              </Line>
            ))}
          </Section>
        ) : null}

        {/* The rule people actually mean, one click, spelled correctly. Only for a
            company account — a personal workspace has no domain, and "everyone at
            gmail.com" is not an organisation. */}
        {s?.workspaceDomain && !s.domains.includes(s.workspaceDomain) ? (
          <div className="border-t border-border px-4 py-3">
            <Button className="gap-1.5" disabled={busy} onClick={() => void post({ addDomain: s.workspaceDomain! })} size="sm" variant="outline">
              <AtSign className="size-3.5" />
              Everyone at {s.workspaceDomain}
            </Button>
          </div>
        ) : null}

        {/* LAST, and one row rather than three options with a tick. A setting
            that is usually left alone should read as a line stating what is true.
            Red means something is wrong; it cannot also mean "this is the one you
            picked", which is what tinting the chosen option made it mean. */}
        {s ? (
          <Section>
            <div className="flex items-center gap-3 px-4 py-2.5">
              <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-tile">
                <CurrentIcon className="size-3.5 text-ink-3" />
              </span>
              <span className="min-w-0">
                <span className="block truncate text-[14px] text-ink">{current.label}</span>
                <span className="block truncate text-[12.5px] text-ink-3">{current.desc}</span>
              </span>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button className="ml-auto h-8 shrink-0 px-2.5 text-[13px]" disabled={busy} size="sm" variant="outline">
                    {current.label}
                    <ChevronDown className="size-3.5 text-ink-3" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-[280px]">
                  {ORDER.map((id) => {
                    const o = ACCESS[id];
                    return (
                      <DropdownMenuItem
                        className="flex-col items-start gap-0.5 py-2"
                        key={id}
                        onClick={() => { if (id !== s.visibility) void post({ visibility: id }); }}
                      >
                        <span className="flex w-full items-center gap-2 text-[13.5px] text-ink">
                          {o.label}
                          {id === s.visibility ? <Check className="ml-auto size-3.5" /> : null}
                        </span>
                        <span className="text-[12px] text-ink-3">{o.desc}</span>
                      </DropdownMenuItem>
                    );
                  })}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </Section>
        ) : null}

        {s?.domains.length ? (
          <p className="border-t border-border px-4 py-2.5 text-[12px] text-ink-3">
            A company rule admits people who signed in with Google or GitHub on that address.
          </p>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

/**
 * A block of rows, separated by a rule and nothing else.
 *
 * It had a small uppercase label over each group. The rows say what they are —
 * a person with a face on them is a person, and the access row states its own
 * setting in words — so the labels were naming what was already legible, in the
 * one type treatment nothing else in this product uses.
 */
function Section({ children }: { children: React.ReactNode }) {
  return <div className="border-t border-border py-1.5">{children}</div>;
}

function Line({
  lead,
  title,
  sub,
  children,
}: {
  lead: React.ReactNode;
  title: string;
  sub?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-3 px-4 py-2">
      {lead}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[14px] text-ink">{title}</span>
        {sub ? <span className="block truncate text-[12.5px] text-ink-3">{sub}</span> : null}
      </span>
      {children}
    </div>
  );
}

/**
 * Their face, or their initials.
 *
 * The picture was already being fetched on every sign-in and thrown away —
 * auth.ts asks Google for `profile.picture` and GitHub for `avatar_url`, and
 * `createUser` inserted everything except that. It is stored now.
 *
 * An `onError` fallback rather than a check, because a Google avatar URL can stop
 * resolving while the row is still on screen, and a broken image icon where a
 * face should be is worse than the monogram it replaced.
 */
function Avatar({ person }: { person: Person }) {
  const [broken, setBroken] = useState(false);
  if (person.image && !broken) {
    return (
      <img
        alt=""
        className="size-7 shrink-0 rounded-full object-cover"
        onError={() => setBroken(true)}
        referrerPolicy="no-referrer"
        src={person.image}
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      className="flex size-7 shrink-0 items-center justify-center rounded-full bg-tile text-[11px] font-medium text-ink-2"
    >
      {initials(person)}
    </span>
  );
}

function Remove({ busy, label, onClick }: { busy: boolean; label: string; onClick: () => void }) {
  return (
    <Button
      aria-label={`Remove ${label}`}
      className="size-7 shrink-0 text-ink-3 hover:text-ink"
      disabled={busy}
      onClick={onClick}
      size="icon-sm"
      variant="ghost"
    >
      <X className="size-3.5" />
    </Button>
  );
}
