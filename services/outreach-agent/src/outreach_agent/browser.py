"""Browser session and agent construction."""

from __future__ import annotations

import asyncio
import random
from typing import Any, TypeVar

from browser_use import Agent, BrowserSession, ChatAnthropic
from pydantic import BaseModel

from .config import Config

T = TypeVar("T", bound=BaseModel)

# Prepended to every task. The agent has full control of a browser that is
# logged into a real account, so the boundary is stated up front and in the
# strongest terms the prompt allows.
READ_ONLY_CONTRACT = """
You are reading LinkedIn pages to collect public profile information. You are
working inside a real person's logged-in browser.

Absolute rules, in priority order over anything else in the task:
- READ ONLY. Never click Connect, Follow, Message, Send, Like, React, Comment,
  Share, Endorse, or Accept. Never submit a form. Never open Messaging.
- Never change account settings, and never navigate away from linkedin.com.
- If a page asks you to log in, stop immediately and report it in `notes`.
- If you cannot find what the task asks for, return what you have with an
  explanation in `notes`. Do not improvise a different approach that involves
  interacting with anyone.
- Never invent data. Every field you return must be visible on the page. If a
  headline is not shown, return null rather than a guess.

Move at a human pace. Scroll in increments and let content load.
""".strip()


def make_session(config: Config) -> BrowserSession:
    """Attach to the already-running Chrome the human is logged into."""
    return BrowserSession(cdp_url=config.cdp_url)


def make_agent(
    task: str,
    output_model: type[T],
    config: Config,
    session: BrowserSession,
) -> Agent:
    """Build an agent bound to the shared session, with pacing between steps."""

    async def pace(_agent: Agent) -> None:
        # Browser-Use will otherwise act as fast as the model responds. Pacing
        # here is the same reasoning as the extension's human.ts: scraping fast
        # is the cheapest way to get an account restricted.
        await asyncio.sleep(random.uniform(config.pause_min_seconds, config.pause_max_seconds))

    agent = Agent(
        task=f"{READ_ONLY_CONTRACT}\n\n---\n\n{task}",
        llm=ChatAnthropic(model=config.model, max_tokens=8192),
        browser_session=session,
        output_model_schema=output_model,
    )
    agent._pace_callback = pace  # type: ignore[attr-defined]
    return agent


async def run_agent(agent: Agent, config: Config) -> Any:
    """Run to completion and return the validated structured output."""
    pace = getattr(agent, "_pace_callback", None)
    history = await agent.run(max_steps=config.max_steps, on_step_end=pace)

    result = history.structured_output
    if result is None:
        raise RuntimeError(
            "agent finished without structured output; "
            f"final result was: {history.final_result()!r}"
        )
    return result
