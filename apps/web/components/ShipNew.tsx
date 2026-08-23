"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Copy, Github, Loader2, Plus, Terminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * Ship new — the whole creation flow, in a dialog.
 *
 * `/new` was a page: three doors, a detection step, a secrets step and the deploy
 * film. Choosing WHERE the code comes from is a two-option question, and a page
 * navigation to answer one is a page navigation too many.
 *
 * Two ways in, because there are only two:
 *
 *   Local — the answer for a product whose deploys happen in a terminal. There is
 *   nothing to fill in: a prompt you paste into the agent you already have open.
 *   It is first because it is the common case, not because it is simpler.
 *
 *   GitHub — pick a repository the App can see. No URL typed, no token pasted.
 *
 * The deploy FILM stays on its own page. A modal cannot hold a live build log, and
 * watching the thing come up is the best part of this product, so choosing a source
 * hands off to /new?src=… and that page does the rest.
 */

const AGENT_PROMPT = `Install the Bay CLI and ship this folder:

  npm i -g supersonic-cli && supersonic up --wait

It will open a browser once to sign you in, then print the address the app is live on.`;

/** Whose marks sit above the prompt. Files copied from apps/landing/public/logos. */
const AGENTS = [
  { name: "Claude Code", src: "/logos/claude.png" },
  { name: "Codex", src: "/logos/openai.png" },
  { name: "Cursor", src: "/logos/cursor.png" },
];

interface GhConnection {
  installationId: number;
  accountLogin: string;
}
interface GhRepo {
  fullName: string;
  private: boolean;
}

export function ShipNew() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"local" | "github">("local");
  const [copied, setCopied] = useState(false);

  const [connections, setConnections] = useState<GhConnection[] | null>(null);
  const [links, setLinks] = useState<{ installUrl: string; configureUrl: string } | null>(null);
  const [installation, setInstallation] = useState<number | null>(null);
  const [repos, setRepos] = useState<GhRepo[] | null>(null);
  const [trouble, setTrouble] = useState("");
  const [q, setQ] = useState("");

  // Asked for only when the GitHub tab is opened, and only once. `null` means
  // "not asked yet" and is a different state from an empty list — one is a
  // spinner, the other is the connect button.
  useEffect(() => {
    if (!open || tab !== "github" || connections !== null) return;
    let alive = true;
    fetch("/api/github/repos")
      .then((r) => r.json())
      .then((d) => {
        if (!alive) return;
        setConnections(d.connections ?? []);
        setLinks({ installUrl: d.installUrl, configureUrl: d.configureUrl });
        if (d.connections?.length) setInstallation(d.connections[0].installationId);
      })
      .catch(() => alive && setConnections([]));
    return () => {
      alive = false;
    };
  }, [open, tab, connections]);

  useEffect(() => {
    if (installation === null) return;
    let alive = true;
    setRepos(null);
    setTrouble("");
    fetch(`/api/github/repos?installation_id=${installation}`)
      .then((r) => r.json())
      .then((d) => {
        if (!alive) return;
        if (d.repos) return setRepos(d.repos);
        // Three refusals, three different next actions — and never GitHub's own
        // error text, which names things a person here has no word for.
        setTrouble(
          d.reason === "no-installation"
            ? "That account isn’t connected any more. Connect it again to pick a repository."
            : d.reason === "bad-credentials"
              ? "We can’t reach GitHub right now. This one is on us — nothing you do will fix it."
              : "GitHub isn’t answering. Try again in a moment.",
        );
        setRepos([]);
      })
      .catch(() => alive && setTrouble("GitHub isn’t answering. Try again in a moment."));
    return () => {
      alive = false;
    };
  }, [installation]);

  const shown = (repos ?? []).filter((r) =>
    q.trim() ? r.fullName.toLowerCase().includes(q.trim().toLowerCase()) : true,
  );

  function ship(fullName: string) {
    // The film lives on its own page; this hands off with everything it needs.
    const p = new URLSearchParams({ src: "github", repo: fullName });
    if (installation !== null) p.set("installation_id", String(installation));
    router.push(`/new?${p}`);
  }

  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus className="size-3.5" />
          Ship new
        </Button>
      </DialogTrigger>

      <DialogContent className="w-[calc(100vw-2rem)] max-w-[520px] gap-0 overflow-hidden p-0">
        <DialogHeader className="px-5 pb-3 pt-5">
          <DialogTitle className="text-[17px] font-[450] tracking-[-0.01em]">Ship an app</DialogTitle>
          <DialogDescription className="sr-only">
            Ship from the folder you have open, or from a GitHub repository.
          </DialogDescription>
        </DialogHeader>

        {/* A recessed track with a raised thumb, the same control as everywhere
            else. Two options, so it is a switch, not a nav. */}
        <div className="px-5">
          <div className="inline-flex gap-0.5 rounded-lg bg-tile p-[3px]">
            {(["local", "github"] as const).map((t) => (
              <button
                className={cn(
                  "inline-flex h-[30px] items-center gap-1.5 rounded-md px-3 text-[14px] transition-colors",
                  tab === t ? "bg-white text-ink shadow-sm" : "text-ink-2 hover:text-ink",
                )}
                key={t}
                onClick={() => setTab(t)}
                type="button"
              >
                {t === "local" ? <Terminal className="size-3.5" /> : <Github className="size-3.5" />}
                {t === "local" ? "From my folder" : "From GitHub"}
              </button>
            ))}
          </div>
        </div>

        <div className="min-w-0 px-5 pb-5 pt-4">
          {tab === "local" ? (
            <div className="flex min-w-0 flex-col gap-3">
              {/* The agents this prompt is for, said with their own marks instead of
                  a sentence naming them. The sentence was doing the same job and
                  taking two lines to do it. */}
              <div className="flex items-center justify-end gap-2.5">
                {AGENTS.map((a) => (
                  <img
                    alt={a.name}
                    className="size-[18px] object-contain opacity-80"
                    key={a.name}
                    src={a.src}
                    title={a.name}
                  />
                ))}
              </div>

              <pre className="max-h-[220px] max-w-full overflow-auto rounded-lg border border-border bg-ground p-3.5 font-mono text-[12.5px] leading-[1.7] text-ink-2">
                {AGENT_PROMPT}
              </pre>

              <Button
                className="w-full"
                onClick={() => {
                  navigator.clipboard?.writeText(AGENT_PROMPT).catch(() => {});
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1600);
                }}
              >
                {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
                {copied ? "Copied" : "Copy prompt"}
              </Button>
            </div>
          ) : connections === null ? (
            <p className="flex items-center gap-2 py-6 text-[14px] text-ink-2">
              <Loader2 className="size-3.5 animate-spin" />
              Looking for your GitHub accounts…
            </p>
          ) : connections.length === 0 ? (
            <div className="flex flex-col items-start gap-3 py-2">
              <p className="text-[14px] text-ink-2">
                Connect GitHub once and your private code shows up here. We only ever
                read it — and only the repositories you pick.
              </p>
              <Button asChild size="sm">
                <a href={links?.installUrl ?? "#"}>
                  <Github className="size-3.5" />
                  Connect GitHub
                </a>
              </Button>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {connections.length > 1 && (
                <div className="inline-flex gap-0.5 self-start rounded-lg bg-tile p-[3px]">
                  {connections.map((c) => (
                    <button
                      className={cn(
                        "h-[28px] rounded-md px-2.5 text-[13px] transition-colors",
                        installation === c.installationId
                          ? "bg-white text-ink shadow-sm"
                          : "text-ink-2 hover:text-ink",
                      )}
                      key={c.installationId}
                      onClick={() => setInstallation(c.installationId)}
                      type="button"
                    >
                      {c.accountLogin}
                    </button>
                  ))}
                </div>
              )}

              <Input
                aria-label="Find a repository"
                className="h-9"
                onChange={(e) => setQ(e.currentTarget.value)}
                placeholder="Find a repository…"
                value={q}
              />

              {trouble ? <p className="text-[14px] text-ink-2">{trouble}</p> : null}

              <div className="max-h-[280px] overflow-y-auto rounded-lg border border-border">
                {repos === null ? (
                  <p className="flex items-center gap-2 px-3 py-6 text-[14px] text-ink-2">
                    <Loader2 className="size-3.5 animate-spin" />
                    Reading what you picked…
                  </p>
                ) : shown.length === 0 ? (
                  <p className="px-3 py-6 text-[14px] text-ink-2">
                    {trouble
                      ? ""
                      : q
                        ? `Nothing matches “${q}”.`
                        : "This account is connected, but no repositories were shared with us yet."}
                  </p>
                ) : (
                  shown.map((r) => (
                    <button
                      className="flex w-full items-center gap-2 border-b border-border px-3 py-2.5 text-left transition-colors last:border-0 hover:bg-tile"
                      key={r.fullName}
                      onClick={() => ship(r.fullName)}
                      type="button"
                    >
                      <Github className="size-3.5 shrink-0 text-ink-3" />
                      <span className="min-w-0 truncate text-[14px] text-ink">{r.fullName}</span>
                      {r.private && (
                        <span className="ml-auto shrink-0 rounded border border-border px-1.5 py-0.5 text-[11px] text-ink-3">
                          private
                        </span>
                      )}
                    </button>
                  ))
                )}
              </div>

              <p className="text-[13px] text-ink-3">
                Not seeing one?{" "}
                <a className="text-ink underline" href={links?.configureUrl ?? "#"}>
                  Choose which repositories we can see
                </a>
                .
              </p>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
