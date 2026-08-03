"""The cron: its own job, on its own schedule, not a request against the web service."""
import os, psycopg, datetime
with psycopg.connect(os.environ["DATABASE_URL"]) as c:
    n = c.execute("select count(*) from contacts").fetchone()[0]
    print(f"digest {datetime.datetime.now(datetime.UTC).isoformat()}: {n} contacts")
