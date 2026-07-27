"""Configuration, all from the environment."""

from __future__ import annotations

import os
from dataclasses import dataclass

# Browser-Use ships anonymised telemetry on by default. Our task prompts carry
# post URLs, profile URLs, and prospect names, so this is opted out before the
# library is imported anywhere. Set it explicitly to "true" to re-enable.
os.environ.setdefault("ANONYMIZED_TELEMETRY", "false")


def _has_anthropic_profile() -> bool:
    """True when `ant auth login` has written a credential to disk."""
    config_dir = os.environ.get("ANTHROPIC_CONFIG_DIR") or os.path.join(
        os.path.expanduser("~"), ".config", "anthropic"
    )
    credentials = os.path.join(config_dir, "credentials")
    return os.path.isdir(credentials) and any(
        name.endswith(".json") for name in os.listdir(credentials)
    )


@dataclass(frozen=True)
class Config:
    api_url: str
    api_token: str
    cdp_url: str
    model: str
    # Bounds on agent autonomy. `max_steps` is the hard stop on the loop; the
    # pacing values keep it from acting at machine speed.
    max_steps: int
    pause_min_seconds: float
    pause_max_seconds: float

    @staticmethod
    def from_env() -> "Config":
        api_url = os.environ.get("OUTREACH_API_URL", "http://localhost:8081")
        token = os.environ.get("OUTREACH_TOKEN")
        if not token:
            raise SystemExit(
                "OUTREACH_TOKEN is not set. Issue one with "
                "services/outreach/scripts/create-account.ts and export it."
            )
        # Credentials resolve the same way the Anthropic SDK resolves them:
        # ANTHROPIC_API_KEY, then ANTHROPIC_AUTH_TOKEN, then an OAuth profile
        # written by `ant auth login`. An unset key is therefore not an error —
        # a profile on disk is a perfectly good credential.
        has_env_credential = bool(
            os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN")
        )
        if not (has_env_credential or _has_anthropic_profile()):
            raise SystemExit(
                "No Anthropic credentials found. Either run `ant auth login`, "
                "or export ANTHROPIC_API_KEY."
            )

        return Config(
            api_url=api_url.rstrip("/"),
            api_token=token,
            # Attach to the browser the human is already logged into, rather
            # than launching a fresh one. A new browser profile on an
            # established account is a device-fingerprint change, which is
            # among the strongest restriction signals LinkedIn has.
            cdp_url=os.environ.get("CDP_URL", "http://localhost:9222"),
            model=os.environ.get("OUTREACH_MODEL", "claude-opus-5"),
            max_steps=int(os.environ.get("OUTREACH_MAX_STEPS", "60")),
            pause_min_seconds=float(os.environ.get("OUTREACH_PAUSE_MIN", "1.5")),
            pause_max_seconds=float(os.environ.get("OUTREACH_PAUSE_MAX", "4.0")),
        )
