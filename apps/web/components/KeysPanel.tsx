"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, Pencil, Plus, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Row, RowList, StatusChip } from "@/components/panel/atoms";
import { RowSkeleton } from "@/components/Skeleton";
import { envOwner, nameRefusal, type EnvOwner } from "@/lib/env-owner";

/**
 * The app's environment, as something you can change.
 *
 * It was twenty-five names in one flat column, each with a green `set` chip and
 * nothing to do. Twenty of them were OURS — the seventeen database variables,
 * `PORT`, `BAY_URL` and its siblings — so the screen's whole content was a list
 * of things the reader had not configured and could not act on, and the two or
 * three that were theirs were lost in it.
 *
 * So: their variables first and alone, with an Add, an Edit and a Remove; ours
 * folded away behind a line saying who sets them and why. `lib/env-owner.ts`
 * decides which is which, from the same lists the config parser refuses names
 * with — one rule, so the button and the deploy cannot disagree.
 *
 * NO VALUE IS EVER SHOWN. Not masked, not behind a reveal — never sent. The API
 * returns names only, and a value read back is a secret leaving the system for
 * no reason anybody needed. Which makes "edit" mean *set a new one*, and the
 * field starts empty because that is the truth: we cannot show you what is there.
 *
 * Removing asks first. It changes a running app, and the platform has no
 * per-app backups to undo it with.
 */

interface Loaded {
  keys: string[];
  /** Set when the environment could not be read — NOT the same as having none. */
  note?: string;
}

const GROUP: Record<Exclude<EnvOwner, "app">, { title: string; why: string }> = {
  database: {
    title: "Database",
    why: "Bay sets these from the database it provisioned for this app",
  },
  platform: {
    title: "Platform",
    why: "Bay sets these so your app knows its own address",
  },
};

export function KeysPanel({
  slug,
  managedDatabase,
  onToast,
}: {
  slug: string;
  /** Whether the database behind `DATABASE_URL` is ours. See `envOwner`. */
  managedDatabase: boolean;
  onToast: (m: string) => void;
}) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<Record<string, boolean>>({});

  const load = useCallback(async () => {
    try {
      const d = (await (await fetch(`/api/apps/${encodeURIComponent(slug)}/env`)).json()) as Loaded & {
        error?: string;
      };
      // `error` alongside an empty list is "we could not ask", which is not the
      // same fact as "there are none" — the difference this codebase keeps
      // getting wrong in one direction.
      if (d.error) setErr(String(d.error));
      else { setErr(null); setLoaded({ keys: d.keys ?? [], note: d.note }); }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, [slug]);

  useEffect(() => { void load(); }, [load]);

  async function write(body: { set?: Record<string, string>; unset?: string[] }, said: string) {
    setBusy(true);
    try {
      const res = await fetch(`/api/apps/${encodeURIComponent(slug)}/env`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await res.json();
      if (!res.ok || d.error) {
        onToast(String(d.error ?? "That did not save."));
        return false;
      }
      // The route says how long the change takes to land — ten seconds on a node,
      // a rolling revision on Cloud Run — and that is worth passing on, because
      // reloading the app immediately and seeing the old value is otherwise a bug
      // report.
      onToast(d.note ? `${said} — ${d.note}` : said);
      setLoaded({ keys: (d.keys as string[]) ?? [] });
      return true;
    } catch {
      onToast("That did not save. Try again in a moment.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  if (err) return <Frame><Row sub={err.slice(0, 160)} title="That could not be read" /></Frame>;
  if (!loaded) return <Frame><RowSkeleton tile={false} w={160} /></Frame>;

  const mine: string[] = [];
  const ours: Record<string, string[]> = { database: [], platform: [] };
  for (const name of loaded.keys) {
    const owner = envOwner(name, { managedDatabase });
    if (owner === "app") mine.push(name);
    else ours[owner].push(name);
  }

  return (
    <div className="flex flex-col gap-4">
      <section className="flex flex-col gap-2.5">
        <div className="flex items-center gap-3 px-0.5">
          <h2 className="text-[15px] text-ink">Environment</h2>
          <Button
            className="ml-auto"
            onClick={() => { setAdding((a) => !a); setEditing(null); }}
            size="sm"
            variant="outline"
          >
            {adding ? <X className="size-3.5" /> : <Plus className="size-3.5" />}
            {adding ? "Cancel" : "Add"}
          </Button>
        </div>

        <RowList>
          {adding ? (
            <KeyForm
              busy={busy}
              managedDatabase={managedDatabase}
              onDone={async (name, value) => {
                if (await write({ set: { [name]: value } }, `${name} is set`)) setAdding(false);
              }}
              taken={loaded.keys}
            />
          ) : null}

          {mine.length === 0 && !adding ? <Row title="Nothing of your own yet" /> : null}

          {mine.map((name) =>
            editing === name ? (
              <KeyForm
                busy={busy}
                key={name}
                managedDatabase={managedDatabase}
                name={name}
                onCancel={() => setEditing(null)}
                onDone={async (_n, value) => {
                  if (await write({ set: { [name]: value } }, `${name} is set`)) setEditing(null);
                }}
              />
            ) : removing === name ? (
              <Row
                key={name}
                sub="your app will restart with it gone"
                title={<span className="font-mono text-[14px]">{name}</span>}
              >
                <Button
                  className="h-7 px-2.5 text-[13px]"
                  disabled={busy}
                  onClick={async () => {
                    if (await write({ unset: [name] }, `${name} is gone`)) setRemoving(null);
                  }}
                  size="sm"
                  variant="destructive"
                >
                  {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
                  Remove
                </Button>
                <Button
                  className="h-7 px-2 text-[13px] text-ink-2 hover:text-ink"
                  onClick={() => setRemoving(null)}
                  size="sm"
                  variant="ghost"
                >
                  Keep
                </Button>
              </Row>
            ) : (
              <Row key={name} title={<span className="font-mono text-[14px]">{name}</span>}>
                <StatusChip text="set" tone="green" />
                <Button
                  aria-label={`Set a new value for ${name}`}
                  className="size-7 text-ink-3 hover:text-ink"
                  onClick={() => { setEditing(name); setAdding(false); }}
                  size="icon-sm"
                  variant="ghost"
                >
                  <Pencil className="size-3.5" />
                </Button>
                <Button
                  aria-label={`Remove ${name}`}
                  className="size-7 text-ink-3 hover:text-red"
                  onClick={() => setRemoving(name)}
                  size="icon-sm"
                  variant="ghost"
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </Row>
            ),
          )}
        </RowList>
      </section>

      {/* Ours, folded away. Present because "where is DATABASE_URL" is a real
          question with a real answer, and absent from the part of the screen you
          act in because there is nothing to do to them. */}
      {(["database", "platform"] as const).map((k) =>
        ours[k].length === 0 ? null : (
          <RowList key={k}>
            <Row
              expanded={Boolean(open[k])}
              onOpen={() => setOpen((o) => ({ ...o, [k]: !o[k] }))}
              sub={GROUP[k].why}
              title={GROUP[k].title}
            >
              <span className="text-[13px] tabular-nums text-ink-3">{ours[k].length}</span>
            </Row>
            {open[k]
              ? ours[k].map((name) => (
                  <div className="border-b border-border bg-tile/40 px-4 py-2 pl-11 last:border-0" key={name}>
                    <span className="font-mono text-[12.5px] text-ink-2">{name}</span>
                  </div>
                ))
              : null}
          </RowList>
        ),
      )}
    </div>
  );
}

/**
 * One name and one value, on the way in.
 *
 * The value box is empty when editing an existing key, and that is not an
 * oversight to fix later — the platform does not know the value and will not ask
 * for it. Saying "leave blank to keep" would be a lie, because a blank save here
 * sets an empty string.
 */
function KeyForm({
  name: fixed,
  taken = [],
  managedDatabase,
  busy,
  onDone,
  onCancel,
}: {
  /** Set when editing: the name is not up for change, only the value. */
  name?: string;
  taken?: string[];
  managedDatabase: boolean;
  busy: boolean;
  onDone: (name: string, value: string) => void | Promise<void>;
  onCancel?: () => void;
}) {
  const [name, setName] = useState(fixed ?? "");
  const [value, setValue] = useState("");

  const refusal =
    fixed !== undefined
      ? null
      : name.trim() === ""
        ? null
        : (nameRefusal(name, { managedDatabase }) ??
          (taken.includes(name.trim()) ? "that one is already set — edit it instead" : null));
  const ready = name.trim() !== "" && !refusal;

  return (
    <form
      className="flex flex-col gap-2 border-b border-border px-4 py-3 last:border-0"
      onSubmit={(e) => { e.preventDefault(); if (ready) void onDone(name.trim(), value); }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Input
          aria-label="Name"
          autoFocus={fixed === undefined}
          className="h-9 w-[220px] font-mono text-[13px]"
          disabled={fixed !== undefined}
          onChange={(e) => setName(e.currentTarget.value)}
          placeholder="STRIPE_SECRET_KEY"
          spellCheck={false}
          value={name}
        />
        <Input
          aria-label="Value"
          autoFocus={fixed !== undefined}
          className="h-9 min-w-0 flex-1 font-mono text-[13px]"
          onChange={(e) => setValue(e.currentTarget.value)}
          placeholder={fixed ? "a new value" : "value"}
          spellCheck={false}
          value={value}
        />
        <Button className="h-9 shrink-0" disabled={!ready || busy} type="submit">
          {busy ? <Loader2 className="size-4 animate-spin" /> : null}
          Save
        </Button>
        {onCancel ? (
          <Button
            className="h-9 shrink-0 text-ink-2 hover:text-ink"
            onClick={onCancel}
            size="sm"
            type="button"
            variant="ghost"
          >
            Cancel
          </Button>
        ) : null}
      </div>
      {refusal ? <p className="text-[12.5px] text-red">{refusal}</p> : null}
    </form>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2.5">
      <h2 className="px-0.5 text-[15px] text-ink">Environment</h2>
      <RowList>{children}</RowList>
    </section>
  );
}
