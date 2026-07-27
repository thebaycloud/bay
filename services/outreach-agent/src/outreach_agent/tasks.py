"""The sourcing tasks.

Each is a natural-language description of what to collect, plus the structured
shape to return. The point of moving to Browser-Use is that these describe the
*goal* — "everyone who reacted to this post" — rather than the DOM path to it,
so a LinkedIn markup change does not break them.
"""

from __future__ import annotations

from browser_use import BrowserSession

from .browser import make_agent, run_agent
from .config import Config
from .models import PeopleBatch, ProfileEnrichment

# Applies to every people-collecting task.
COLLECTION_RULES = """
For each person, collect:
- profile_url: their LinkedIn profile URL (must contain /in/)
- full_name: their display name
- headline: the subtitle line under their name, verbatim, or null

Skip anything that is not a person: company pages, groups, schools, adverts.
Do not open individual profiles — everything you need is in the list.
Scroll the list itself, not the page behind it, and keep scrolling until no
new people appear or you reach {limit} people.
""".strip()


async def scrape_post_likers(
    post_url: str, limit: int, config: Config, session: BrowserSession
) -> PeopleBatch:
    task = f"""
Go to {post_url}

Open the list of people who reacted to this post. The reactions summary is
usually a small row of face icons with a count near the post's comment count —
clicking the count opens a dialog listing everyone who reacted. Be careful to
open *reactions*, not comments, reposts, or send. If a Messaging panel is open
it is not the dialog you want.

Then collect everyone in that dialog.

{COLLECTION_RULES.format(limit=limit)}
"""
    agent = make_agent(task, PeopleBatch, config, session)
    return await run_agent(agent, config)


async def scrape_post_commenters(
    post_url: str, limit: int, config: Config, session: BrowserSession
) -> PeopleBatch:
    task = f"""
Go to {post_url}

Collect everyone who commented on this post, including replies to comments.
Comments usually load behind a "Load more comments" button — keep pressing it
until there are no more, or until you have {limit} people.

Do not collect the post author unless they also commented as a separate person.

{COLLECTION_RULES.format(limit=limit)}
"""
    agent = make_agent(task, PeopleBatch, config, session)
    return await run_agent(agent, config)


async def scrape_search_results(
    search_url: str, limit: int, config: Config, session: BrowserSession
) -> PeopleBatch:
    task = f"""
Go to {search_url}

This is a LinkedIn people-search results page. Collect the people listed.
Move through result pages using the Next control at the bottom until you have
{limit} people or there are no more pages.

{COLLECTION_RULES.format(limit=limit)}
"""
    agent = make_agent(task, PeopleBatch, config, session)
    return await run_agent(agent, config)


async def scrape_connections(limit: int, config: Config, session: BrowserSession) -> PeopleBatch:
    task = f"""
Go to https://www.linkedin.com/mynetwork/invite-connect/connections/

This lists the account's existing 1st-degree connections. Collect them.
The list loads more as you scroll; keep going until it stops growing or you
have {limit} people.

{COLLECTION_RULES.format(limit=limit)}
"""
    agent = make_agent(task, PeopleBatch, config, session)
    return await run_agent(agent, config)


async def enrich_profile(
    profile_url: str, config: Config, session: BrowserSession
) -> ProfileEnrichment:
    task = f"""
Go to {profile_url}

Read this person's profile and report:
- headline: the line directly under their name
- location: their stated location
- current_role: their present job title
- current_company: the company they hold that role at
- recent_activity: up to 3 short verbatim excerpts of things they recently
  posted or commented on, if an activity section is visible

Scroll far enough to see the Experience section. Do not click into other
pages, do not open their contact info, and do not interact with anything.

Report only what is visible. If a field is not shown, return null for it —
this data is used to write a message to this person, so an invented detail
becomes a false claim about a real human being.
"""
    agent = make_agent(task, ProfileEnrichment, config, session)
    return await run_agent(agent, config)
