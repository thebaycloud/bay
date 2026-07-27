"""CLI entry point.

    outreach-agent likers      https://www.linkedin.com/feed/update/urn:li:activity:123/
    outreach-agent commenters  <post-url>
    outreach-agent search      "https://www.linkedin.com/search/results/people/?keywords=..."
    outreach-agent connections
    outreach-agent enrich --batch 10
"""

from __future__ import annotations

import argparse
import asyncio
import random
import sys

# Imported first: it opts out of Browser-Use telemetry before that library loads.
from .config import Config
from .api import OutreachApi
from .browser import make_session
from .models import PeopleBatch
from .tasks import (
    enrich_profile,
    scrape_connections,
    scrape_post_commenters,
    scrape_post_likers,
    scrape_search_results,
)


def _report(batch: PeopleBatch, summary: dict) -> None:
    print(
        f"  found {summary['found']} · {summary['created']} new · "
        f"{summary['existing']} already known · {summary['skipped']} skipped"
    )
    if not batch.reached_end_of_list:
        # A partial pull that reads as complete is how you conclude a source is
        # exhausted when it isn't.
        print("  note: the agent did NOT reach the end of the list")
    if batch.notes:
        print(f"  note: {batch.notes}")


async def run_scrape(args: argparse.Namespace, config: Config) -> int:
    session = make_session(config)

    source_ref = getattr(args, "url", "") or "https://www.linkedin.com/mynetwork/"
    source = {
        "likers": "post_likers",
        "commenters": "post_commenters",
        "search": "search",
        "connections": "connections",
    }[args.command]

    with OutreachApi(config) as api:
        account = api.me()["account"]
        print(f"account: {account['label']} <{account['email']}>")
        print(f"source:  {source}")

        try:
            if args.command == "likers":
                batch = await scrape_post_likers(args.url, args.limit, config, session)
            elif args.command == "commenters":
                batch = await scrape_post_commenters(args.url, args.limit, config, session)
            elif args.command == "search":
                batch = await scrape_search_results(args.url, args.limit, config, session)
            else:
                batch = await scrape_connections(args.limit, config, session)
        except Exception as e:  # noqa: BLE001 — the failure must reach the run history
            api.report_failure(source, source_ref, str(e)[:2000])
            print(f"failed: {e}", file=sys.stderr)
            return 1

        summary = api.ingest(source, source_ref, batch.people)
        api.log_event(
            "scrape_completed",
            {
                "source": source,
                "sourceRef": source_ref,
                "reachedEnd": batch.reached_end_of_list,
                **summary,
            },
        )
        _report(batch, summary)
    return 0


async def run_enrich(args: argparse.Namespace, config: Config) -> int:
    session = make_session(config)

    with OutreachApi(config) as api:
        pending = api.pending_enrichment(args.batch)
        if not pending:
            print("nothing pending enrichment")
            return 0

        print(f"enriching {len(pending)} profile(s)")
        enriched = failed = 0

        for prospect in pending:
            name = prospect.get("full_name") or prospect["profile_url"]
            try:
                enrichment = await enrich_profile(prospect["profile_url"], config, session)
                api.save_enrichment(prospect["id"], enrichment)
                enriched += 1
                print(f"  ok      {name} — {enrichment.current_role or 'role unknown'}")
            except Exception as e:  # noqa: BLE001
                failed += 1
                print(f"  failed  {name}: {e}", file=sys.stderr)
                api.log_event("enrichment_failed", {"error": str(e)[:500]}, prospect["id"])

            # Profile visits are the most conspicuous thing this does — they
            # show up in the other person's "who viewed your profile".
            await asyncio.sleep(random.uniform(4.0, 9.0))

        print(f"enriched {enriched}, failed {failed}")
    return 0


def main() -> None:
    parser = argparse.ArgumentParser(prog="outreach-agent", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    for name, needs_url, default_limit in [
        ("likers", True, 500),
        ("commenters", True, 300),
        ("search", True, 200),
        ("connections", False, 1000),
    ]:
        p = sub.add_parser(name)
        if needs_url:
            p.add_argument("url")
        p.add_argument("--limit", type=int, default=default_limit)

    enrich = sub.add_parser("enrich")
    enrich.add_argument("--batch", type=int, default=10)

    args = parser.parse_args()
    config = Config.from_env()

    if args.command == "enrich":
        raise SystemExit(asyncio.run(run_enrich(args, config)))
    raise SystemExit(asyncio.run(run_scrape(args, config)))


if __name__ == "__main__":
    main()
