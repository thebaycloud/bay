import { test } from "node:test";
import assert from "node:assert/strict";
import { parseProcfile, ProcfileError } from "../lib/procfile";

test("reads the file every app of this shape already ships", () => {
  // Verbatim from ~/Desktop/last/api/Procfile — a real repo of the kind this
  // platform is for, carrying both a Procfile and a railway.json that declare the
  // same command, with the platform reading neither.
  const entries = parseProcfile(
    "web: python manage.py migrate --noinput && python manage.py collectstatic --noinput && gunicorn config.wsgi --bind 0.0.0.0:$PORT\n",
  );

  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, "web");
  assert.match(entries[0].command, /^python manage\.py migrate/);
  // The colon inside `0.0.0.0:$PORT` must not split the command — only the FIRST
  // colon separates a name from what it runs.
  assert.match(entries[0].command, /--bind 0\.0\.0\.0:\$PORT$/);
});

test("a bot is a named process, not a web server pretending", () => {
  const entries = parseProcfile("bot: python bot.py\nemails: python -m worker.emails\n");

  assert.deepEqual(entries.map((e) => e.name), ["bot", "emails"]);
  // Names are the app's own vocabulary and are carried through, not mapped onto a
  // fixed list. Enumerating plausible worker names would be the same mistake as
  // enumerating languages.
  assert.equal(entries[0].command, "python bot.py");
});

test("comments, blank lines and surrounding whitespace are ignored", () => {
  const entries = parseProcfile("# the app\n\n  web:   npm start  \n\n# a worker\nworker: npm run queue\n");

  assert.deepEqual(entries.map((e) => [e.name, e.command]), [["web", "npm start"], ["worker", "npm run queue"]]);
});

test("names are case-insensitive so Web and web cannot both exist", () => {
  assert.equal(parseProcfile("Web: npm start")[0].name, "web");
  assert.throws(() => parseProcfile("web: a\nWEB: b"), ProcfileError);
});

test("a line that is not name: command is refused, not skipped", () => {
  // Skipping is what a lenient reader does, and it means a typo'd worker line
  // deploys as a web-only app — which looks exactly like the worker being broken.
  assert.throws(() => parseProcfile("web: npm start\nnpm run worker\n"), (e: Error) => {
    assert.ok(e instanceof ProcfileError);
    assert.match(e.message, /line 2/);
    return true;
  });
});

test("a name with no command is refused", () => {
  assert.throws(() => parseProcfile("web:   "), /no command/);
});

test("a duplicated name is refused rather than resolved to first or last", () => {
  assert.throws(() => parseProcfile("web: a\nworker: b\nweb: c"), (e: Error) => {
    assert.match(e.message, /declared twice, on lines 1 and 3/);
    return true;
  });
});

test("an empty file is a Procfile with no processes, not an error", () => {
  assert.deepEqual(parseProcfile(""), []);
  assert.deepEqual(parseProcfile("# nothing here\n"), []);
});

test("CRLF is read the same as LF", () => {
  assert.deepEqual(
    parseProcfile("web: npm start\r\nworker: npm run q\r\n").map((e) => e.name),
    ["web", "worker"],
  );
});
