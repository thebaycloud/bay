"""A CRM, reduced to the parts that exercise the platform: web + db + release + cron."""
import os, psycopg
from flask import Flask

app = Flask(__name__)
DSN = os.environ["DATABASE_URL"]

@app.get("/")
def index():
    with psycopg.connect(DSN) as c:
        n = c.execute("select count(*) from contacts").fetchone()[0]
    return {"contacts": n, "ok": True}

@app.get("/health")
def health():
    return {"ok": True}
