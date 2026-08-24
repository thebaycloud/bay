"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, ExternalLink, Github, Loader2, Unlink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Row, RowGroup } from "@/components/panel/atoms";
import { RowSkeleton } from "@/components/Skeleton";

/**
 * The repository this app follows, from the person's side.
 *
 * One claim and one switch. The claim — "every push to this branch ships your
 * app" — is the whole feature, so it is stated in those words rather than
 * implied by a checkbox labelled *auto deploy*; a person who reads only this
 * panel should be able to predict exactly what their next `git push` does.
 *
 * Draws nothing at all when no repository is connected. An app deployed from a
 * folder or a public URL has no connection to show, and an empty card offering
 * to connect one would be a second, worse copy of the GitHub door — the
 * connection is made there, where the repositories already are.
 *
 * Was written against the injected drawer's stylesheet — `set-card`, `dom-item`,
 * `dom-host mono`, `btn primary`, `in mono` — which this app does not load, so
 * every control on the one screen that explains what a push does rendered as an
 * unstyled browser default on nothing. Same defect as the four dev panels, in
 * the panel that arrived after they were fixed.
 */

interface Link {
  connected: boolean;
  repo?: string;
  branch?: string;
  autoDeploy?: boolean;
  url?: string;
}

export function GitPanel({ slug, onToast }: { slug: string; onToast: (m: string) => void }) {
  const [link, setLink] = useState<Link | null>(null);
  const [branch, setBranch] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const load = useCallback(async () => {
    try {
      const d = (await (await fetch(`/api/apps/${slug}/git`)).json()) as Link;
      setLink(d);
      if (d.branch) setBranch(d.branch);
    } catch {
      // A page that cannot reach the API shows what it last knew, and shows
      // nothing on a first load rather than an error about our own network.
    }
  }, [slug]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(body: Record<string, unknown>, said: string) {
    setBusy(true);
    setErr("");
    try {
      const res = await fetch(`/api/apps/${slug}/git`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await res.json();
      if (!res.ok) {
        setErr(d.error || "That didn't save.");
        return;
      }
      setLink(d);
      setBranch(d.branch ?? "");
      onToast(said);
    } catch {
      setErr("That didn't save. Try again in a moment.");
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    setBusy(true);
    setErr("");
    try {
      await fetch(`/api/apps/${slug}/git`, { method: "DELETE" });
      setLink({ connected: false });
      // Said in full, because the thing that stops is not the thing a person
      // might fear stopping: the app keeps running and keeps its address.
      onToast("Disconnected. Your app keeps running — pushes just won't ship it.");
    } catch {
      setErr("That didn't save. Try again in a moment.");
    } finally {
      setBusy(false);
    }
  }

  // `null` is "not read yet" and `{connected:false}` is "nothing to show" — one
  // is a skeleton, the other is no section at all.
  if (link === null) {
    return (
      <RowGroup title="Source">
        <RowSkeleton tile={false} w={168} />
      </RowGroup>
    );
  }
  if (!link.connected) return null;

  const on = link.autoDeploy !== false;
  const changed = branch.trim() !== "" && branch.trim() !== link.branch;

  return (
    <div className="flex flex-col gap-3">
      <RowGroup title="Source">
        <Row
          icon={Github}
          sub={
            on
              ? `every push to ${link.branch} ships this app`
              : `pushes to ${link.branch} are ignored until you turn this back on`
          }
          title={link.repo ?? "repository"}
        >
          {on ? (
            <span className="flex items-center gap-1.5 text-[13px] text-ink-2">
              <span
                aria-hidden="true"
                className="size-1.5 shrink-0 rounded-full bg-[var(--green)]"
              />
              ships on push
            </span>
          ) : (
            <span className="flex items-center gap-1.5 text-[13px] text-ink-2">
              <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-ink-3" />
              paused
            </span>
          )}
          {link.url ? (
            <Button
              asChild
              aria-label={`Open ${link.repo} on GitHub`}
              className="size-7 text-ink-3 hover:text-ink"
              size="icon-sm"
              variant="ghost"
            >
              <a href={link.url} rel="noreferrer" target="_blank">
                <ExternalLink className="size-3.5" />
              </a>
            </Button>
          ) : null}
        </Row>

        {/* The branch is the value of a row, like the name field in settings —
            the thing you can change looks like the things you cannot. */}
        <form
          className="flex items-center gap-2 border-b border-border px-4 py-3 last:border-0"
          onSubmit={(e) => {
            e.preventDefault();
            if (changed) void save({ branch: branch.trim() }, `Now shipping from ${branch.trim()}.`);
          }}
        >
          <span className="shrink-0 text-[15px] font-[450] text-ink">Branch</span>
          <Input
            aria-label="Branch"
            className="ml-auto h-9 w-[180px]"
            disabled={busy}
            onChange={(e) => setBranch(e.currentTarget.value)}
            placeholder="main"
            value={branch}
          />
          {/* Only when it differs from what is saved. A permanently disabled
              button beside a field reads as a field you may not edit. */}
          {changed ? (
            <Button className="h-9 shrink-0" disabled={busy} type="submit">
              {busy ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
              Change
            </Button>
          ) : null}
        </form>

        <div className="flex flex-wrap items-center gap-2 px-4 py-3">
          <Button
            disabled={busy}
            onClick={() =>
              void save(
                { autoDeploy: !on },
                on ? "Pushes won't ship this app any more." : "Pushes will ship this app again.",
              )
            }
            size="sm"
            variant="outline"
          >
            {on ? "Pause shipping on push" : "Ship on push again"}
          </Button>
          <Button
            className="text-ink-2 hover:text-ink"
            disabled={busy}
            onClick={() => void disconnect()}
            size="sm"
            variant="ghost"
          >
            <Unlink className="size-3.5" />
            Disconnect
          </Button>
        </div>
      </RowGroup>

      {err ? <p className="px-0.5 text-[14px] text-red">{err}</p> : null}
    </div>
  );
}
