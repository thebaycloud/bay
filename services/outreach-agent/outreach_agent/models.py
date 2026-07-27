"""Structured shapes the agent must return.

These are handed to Browser-Use as `output_model_schema`, so the model is
forced to produce them rather than prose we would then have to parse. They
mirror the TypeScript types in `apps/outreach-extension/src/content/people.ts`
so both sourcing paths feed the same ingest endpoint.
"""

from pydantic import BaseModel, Field


class Person(BaseModel):
    profile_url: str = Field(
        description="Absolute LinkedIn profile URL, e.g. https://www.linkedin.com/in/jane-doe. "
        "Never a company, school, or feed URL."
    )
    full_name: str | None = Field(default=None, description="Display name as shown.")
    headline: str | None = Field(
        default=None,
        description="The person's headline or subtitle line, verbatim. Null if not visible.",
    )


class PeopleBatch(BaseModel):
    """What every sourcing task returns."""

    people: list[Person] = Field(default_factory=list)
    # The agent reports its own coverage so a partial pull is visible rather
    # than silently looking like a complete one.
    reached_end_of_list: bool = Field(
        description="True only if you scrolled until no new people appeared."
    )
    notes: str | None = Field(
        default=None,
        description="Anything that blocked or limited the pull, e.g. a login wall or a cap.",
    )


class ProfileEnrichment(BaseModel):
    """Everything read off a single profile page.

    Only fields visible on the page. This is the sole context the copy
    generator is permitted to reference, so an invented value here becomes an
    invented claim in a message to a real person.
    """

    headline: str | None = None
    location: str | None = None
    current_role: str | None = None
    current_company: str | None = None
    recent_activity: list[str] = Field(
        default_factory=list,
        description="Short verbatim excerpts of recent posts or comments. Empty if none visible.",
    )
    notes: str | None = None
