"""Client for the outreach service.

The agent is just another sourcing front-end: it posts to the same ingest
endpoints the extension uses, so dedupe, ownership, and run history behave
identically no matter which path collected the prospect.
"""

from __future__ import annotations

import httpx

from .config import Config
from .models import Person, ProfileEnrichment


class OutreachApi:
    def __init__(self, config: Config) -> None:
        self._config = config
        self._client = httpx.Client(
            base_url=config.api_url,
            headers={"authorization": f"Bearer {config.api_token}"},
            timeout=30.0,
        )

    def __enter__(self) -> "OutreachApi":
        return self

    def __exit__(self, *_exc: object) -> None:
        self._client.close()

    def _post(self, path: str, payload: dict) -> dict:
        response = self._client.post(path, json=payload)
        if response.status_code >= 400:
            raise RuntimeError(f"POST {path} failed ({response.status_code}): {response.text}")
        return response.json()

    def me(self) -> dict:
        response = self._client.get("/me")
        if response.status_code >= 400:
            raise RuntimeError(f"GET /me failed ({response.status_code}): {response.text}")
        return response.json()

    def ingest(self, source: str, source_ref: str, people: list[Person]) -> dict:
        return self._post(
            "/prospects/ingest",
            {
                "source": source,
                "sourceRef": source_ref,
                "prospects": [
                    {
                        "profileUrl": p.profile_url,
                        "fullName": p.full_name,
                        "headline": p.headline,
                    }
                    for p in people
                ],
            },
        )

    def report_failure(self, source: str, source_ref: str, error: str) -> dict:
        return self._post(
            "/scrape-runs/failed",
            {"source": source, "sourceRef": source_ref, "error": error},
        )

    def pending_enrichment(self, limit: int) -> list[dict]:
        response = self._client.get("/prospects/pending-enrichment", params={"limit": limit})
        if response.status_code >= 400:
            raise RuntimeError(f"pending-enrichment failed ({response.status_code}): {response.text}")
        return response.json()["prospects"]

    def save_enrichment(self, prospect_id: str, enrichment: ProfileEnrichment) -> dict:
        return self._post(
            f"/prospects/{prospect_id}/enrichment",
            {
                "enrichment": enrichment.model_dump(),
                "headline": enrichment.headline,
                "location": enrichment.location,
                "title": enrichment.current_role,
                "company": enrichment.current_company,
            },
        )

    def log_event(self, event_type: str, payload: dict, prospect_id: str | None = None) -> None:
        self._post("/events", {"type": event_type, "payload": payload, "prospectId": prospect_id})
