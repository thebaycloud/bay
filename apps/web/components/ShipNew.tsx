"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Check, Copy, Github, Loader2, Plus } from "lucide-react";
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
import { slugify } from "@/lib/slug";
import { cn } from "@/lib/utils";

/**
 * Ship new — name it, then choose where the code comes from.
 *
 * Two steps rather than two tabs. The name is the one question with the same answer
 * whichever route you take, so it is asked once and first. The routes are then shown
 * TOGETHER, because they are not modes to switch between: one is a prompt you paste
 * into the agent you already have open, the other is a button you press. Anybody
 * arriving already knows which of those they are doing.
 *
 * The name is optional. A generated one is offered and used when the field is left
 * empty, so nobody is stopped at a text box on the way to shipping.
 *
 * The deploy FILM stays a page. A dialog cannot hold a live build log, and watching
 * the thing come up is the best part of this product, so the GitHub route hands off
 * to /new and that page does the rest.
 */

/** Whose marks sit beside the prompt. Files copied from apps/landing/public/logos. */
const AGENTS = [
  { name: "Claude Code", src: "/logos/claude.png" },
  { name: "Codex", src: "/logos/openai.png" },
  { name: "Cursor", src: "/logos/cursor.png" },
];

/**
 * A name to offer, in the shape the platform would have picked anyway.
 *
 * lib/slug's `randomSlug` is what /api/deploy already falls back to, but it is a
 * letter and four characters — "as76d" — which makes a fine subdomain and a poor
 * thing to find again in a list. This pairs a word with a number instead: still a
 * legal Cloud Run name, and readable.
 */
const WORDS = [
  "harbor", "ferry", "pier", "tide", "beacon", "anchor", "cove", "quay",
  "lantern", "compass", "current", "drift", "haven", "keel", "mast", "reef",
];
function suggestName(): string {
  const w = WORDS[Math.floor(Math.random() * WORDS.length)];
  return `${w}-${Math.floor(Math.random() * 900 + 100)}`;
}

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
  const [step, setStep] = useState<"name" | "source">("name");
  const [suggested, setSuggested] = useState(suggestName);
  const [name, setName] = useState("");
  const [copied, setCopied] = useState(false);

  const [connections, setConnections] = useState<GhConnection[] | null>(null);
  const [links, setLinks] = useState<{ installUrl: string; configureUrl: string } | null>(null);
  const [installation, setInstallation] = useState<number | null>(null);
  const [repos, setRepos] = useState<GhRepo[] | null>(null);
  const [trouble, setTrouble] = useState("");

  /**
   * What it will actually be called: the field when filled, the offer when not.
   *
   * The emptiness test is on the raw field, not on the slug — `slugify("")` answers
   * "app", so `slugify(name) || suggested` named every unnamed app "app" and never
   * once used the suggestion it had just shown.
   */
  const chosen = name.trim() ? slugify(name.trim()) : suggested;

  const prompt = useMemo(
    () =>
      `Install the Bay CLI and ship this folder as "${chosen}":\n\n` +
      `  npm i -g supersonic-cli && supersonic deploy --name ${chosen} --wait\n\n` +
      `It opens a browser once to sign you in, then prints the address the app is live on.\n` +
      `Without --wait it returns before the build has finished.`,
    [chosen],
  );

  // A second Ship-new is a fresh one, not the last attempt's half-finished state.
  useEffect(() => {
    if (open) return;
    setStep("name");
    setName("");
    setSuggested(suggestName());
    setCopied(false);
  }, [open]);

  // Read when the source step opens, not when the dialog does: somebody shipping
  // from their folder never needs their GitHub accounts. `null` means "not asked
  // yet" and is a different state from an empty list — one is a spinner, the other
  // is the connect button.
  useEffect(() => {
    if (!open || step !== "source" || connections !== null) return;
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
  }, [open, step, connections]);

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

  function ship(fullName: string) {
    // The chosen name travels with it, so /new reserves the slug this dialog just
    // showed rather than minting a second one from the repository name.
    const p = new URLSearchParams({ src: "github", repo: fullName, name: chosen });
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
        <DialogHeader className="px-5 pb-4 pt-5">
          <DialogTitle className="flex min-w-0 items-baseline gap-2 text-[17px] font-[450] tracking-[-0.01em]">
            {step === "name" ? (
              <>
                New app
                {/* Beside the title, not under the field: it qualifies the one
                    thing this step asks for, and it is the whole of what a
                    paragraph down there used to say. */}
                <span className="text-[14px] text-ink-3">Optional</span>
              </>
            ) : (
              <span className="min-w-0 truncate">{chosen} is empty</span>
            )}
          </DialogTitle>
          <DialogDescription className="sr-only">
            Name the app, then ship it from the folder you have open or from a GitHub
            repository.
          </DialogDescription>
        </DialogHeader>

        {step === "name" ? (
          <form
            className="flex min-w-0 flex-col gap-3 px-5 pb-5"
            onSubmit={(e) => {
              e.preventDefault();
              setStep("source");
            }}
          >
            {/* The placeholder is the generated name, so the offer is visible
                rather than described — leave it and that is what ships. */}
            <Input
              aria-label="App name (optional)"
              autoFocus
              className="h-9 placeholder:text-ink-3"
              onChange={(e) => setName(e.currentTarget.value)}
              placeholder={suggested}
              value={name}
            />

            <Button className="mt-1 w-full" type="submit">
              Continue
              <ArrowRight className="size-4" />
            </Button>
          </form>
        ) : (
          <div className="flex min-w-0 flex-col gap-4 px-5 pb-5">
            {/* Both routes at once. */}
            <section className="flex min-w-0 flex-col gap-2.5">
              <div className="flex items-center gap-3">
                <span className="text-[14px] font-[450] text-ink">
                  Ship the folder you have open
                </span>
                <span className="ml-auto flex shrink-0 items-center gap-2.5">
                  {AGENTS.map((a) => (
                    <img
                      alt={a.name}
                      className="size-[18px] object-contain opacity-80"
                      key={a.name}
                      src={a.src}
                      title={a.name}
                    />
                  ))}
                </span>
              </div>

              <pre className="max-h-[180px] max-w-full overflow-auto rounded-lg border border-border bg-ground p-3.5 font-mono text-[12.5px] leading-[1.7] text-ink-2">
                {prompt}
              </pre>

              <Button
                className="w-full"
                onClick={() => {
                  navigator.clipboard?.writeText(prompt).catch(() => {});
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1600);
                }}
                variant="outline"
              >
                {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
                {copied ? "Copied" : "Copy prompt"}
              </Button>
            </section>

            <div className="flex items-center gap-3">
              <span className="h-px flex-1 bg-border" />
              <span className="text-[13px] text-ink-3">or</span>
              <span className="h-px flex-1 bg-border" />
            </div>

            <section className="flex min-w-0 flex-col gap-2.5">
              <span className="text-[14px] font-[450] text-ink">Ship from GitHub</span>

              {connections === null ? (
                <p className="flex items-center gap-2 py-1 text-[14px] text-ink-2">
                  <Loader2 className="size-3.5 animate-spin" />
                  Looking for your GitHub accounts…
                </p>
              ) : connections.length === 0 ? (
                <Button asChild className="w-full" variant="outline">
                  <a href={links?.installUrl ?? "#"}>
                    <Github className="size-4" />
                    Connect GitHub
                  </a>
                </Button>
              ) : (
                <>
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

                  {trouble ? <p className="text-[14px] text-ink-2">{trouble}</p> : null}

                  <div className="max-h-[176px] overflow-y-auto rounded-lg border border-border">
                    {repos === null ? (
                      <p className="flex items-center gap-2 px-3 py-5 text-[14px] text-ink-2">
                        <Loader2 className="size-3.5 animate-spin" />
                        Reading what you picked…
                      </p>
                    ) : repos.length === 0 ? (
                      <p className="px-3 py-5 text-[14px] text-ink-2">
                        {trouble ? "" : "No repositories were shared with us yet."}
                      </p>
                    ) : (
                      repos.map((r) => (
                        <button
                          className="flex w-full items-center gap-2 border-b border-border px-3 py-2.5 text-left transition-colors last:border-0 hover:bg-tile"
                          key={r.fullName}
                          onClick={() => ship(r.fullName)}
                          type="button"
                        >
                          <Github className="size-3.5 shrink-0 text-ink-3" />
                          <span className="min-w-0 truncate text-[14px] text-ink">
                            {r.fullName}
                          </span>
                          {r.private && (
                            <span className="ml-auto shrink-0 rounded-sm border border-border px-1.5 py-0.5 text-[11px] text-ink-3">
                              private
                            </span>
                          )}
                        </button>
                      ))
                    )}
                  </div>

                  {links?.configureUrl ? (
                    <p className="text-[13px] text-ink-3">
                      Not seeing one?{" "}
                      <a className="text-ink underline" href={links.configureUrl}>
                        Choose which repositories we can see
                      </a>
                    </p>
                  ) : null}
                </>
              )}
            </section>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
