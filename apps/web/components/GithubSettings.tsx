"use client";

import { useEffect, useState } from "react";
import { ExternalLink, Github, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Row, RowGroup } from "@/components/panel/atoms";
import { RowSkeleton } from "@/components/Skeleton";

/**
 * GitHub, as a thing you can check rather than a thing you can only start.
 *
 * The only place the connection was visible was inside the Ship-new dialog, and
 * only while somebody was mid-ship. So there was no answer to "is it connected,
 * to what, and can it see my repository" — which is the question people ask when
 * they are NOT shipping, and the reason a settings page exists.
 *
 * Two links, both of them off to GitHub, because both decisions are GitHub's:
 * which repositories an installation may see, and whether it exists at all.
 * There is deliberately no Disconnect here — deleting our row would leave the App
 * installed and still able to push, with a dashboard claiming it was gone.
 */

interface Conn {
  installationId: number;
  accountLogin: string;
  accountType: string;
  connectedLogin: string | null;
  /** Null means the listing failed. Zero means nothing is shared. */
  repoCount: number | null;
  manageUrl: string;
}

export function GithubSettings() {
  const [conns, setConns] = useState<Conn[] | null>(null);
  const [links, setLinks] = useState<{ installUrl: string; configureUrl: string } | null>(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/github/status")
      .then((r) => r.json())
      .then((d) => {
        if (!alive) return;
        setConns(d.connections ?? []);
        setLinks({ installUrl: d.installUrl, configureUrl: d.configureUrl });
      })
      .catch(() => alive && setConns([]));
    return () => {
      alive = false;
    };
  }, []);

  return (
    <RowGroup title="GitHub">
      {conns === null ? <RowSkeleton tile={false} w={148} /> : null}

      {conns?.length === 0 ? (
        <Row
          sub="connect an account and a push to your branch ships the app"
          title="Not connected"
        >
          <Button asChild size="sm">
            <a href={links?.installUrl ?? "#"}>
              <Github className="size-3.5" />
              Connect GitHub
            </a>
          </Button>
        </Row>
      ) : null}

      {conns?.map((c) => (
        <Row
          icon={Github}
          key={c.installationId}
          // What the count is FOR: every "why can't I see my repository" is the
          // App's repository selection, and 47 versus 1 says which it is.
          sub={
            c.repoCount === null
              ? "we could not read its repositories just now"
              : `${c.repoCount} ${c.repoCount === 1 ? "repository" : "repositories"} shared with us` +
                (c.accountType.toLowerCase() === "organization" ? " · organisation" : "")
          }
          title={c.accountLogin}
        >
          <Button asChild className="h-7 px-2.5 text-[13px]" size="sm" variant="outline">
            <a href={links?.configureUrl ?? "#"}>Choose repositories</a>
          </Button>
          <Button
            asChild
            aria-label={`Manage ${c.accountLogin} on GitHub`}
            className="size-7 text-ink-3 hover:text-ink"
            size="icon-sm"
            variant="ghost"
          >
            <a href={c.manageUrl} rel="noreferrer" target="_blank">
              <ExternalLink className="size-3.5" />
            </a>
          </Button>
        </Row>
      ))}

      {/* A second account is a normal thing to want — a personal one and the
          organisation you actually ship for — and there was nowhere to say so
          once the first was connected. */}
      {conns?.length ? (
        <div className="flex items-center gap-2 px-4 py-3">
          <Button asChild size="sm" variant="outline">
            <a href={links?.installUrl ?? "#"}>
              <Plus className="size-3.5" />
              Add another account
            </a>
          </Button>
        </div>
      ) : null}
    </RowGroup>
  );
}
