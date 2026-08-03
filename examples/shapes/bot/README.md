# echobot — a worker-only deploy test

`bot.py` is `examples/echobot.py` from python-telegram-bot, verbatim except for
one line: the hardcoded `"TOKEN"` now reads `os.environ["BOT_TOKEN"]`.

Why this repo is the right test. It is long-polling: `application.run_polling()`
opens a connection to Telegram and holds it. There is no HTTP server, no `$PORT`,
nothing for a startup probe to reach, and it must keep running between events.

On a Cloud Run *service* that fails twice over — the revision is refused for not
listening on `$PORT`, and even with a fake listener the CPU is throttled to
near-zero between requests it never receives. It is the exact app the process
model exists for, and nothing about it is contrived.

No `start` command anywhere: this app has no web process, so the deploy should
create a worker pool and no Cloud Run service at all.
