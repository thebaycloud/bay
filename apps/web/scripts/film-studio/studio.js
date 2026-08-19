import { mountFilm } from "../../components/film/ship-it.js";

/**
 * The bench the film is tuned on.
 *
 * The product drives this picture off a real deploy, and a real deploy is the
 * one thing you cannot summon while you are working on the picture. So this is
 * a deploy simulator: the same `setStage` calls the dashboard makes, on the
 * wall-clock timings a real deploy actually has — including the ugly ones. A
 * four-minute build and a two-and-a-half-minute fleet pull are the cases the
 * film has to survive, and they are the only cases worth looking at, because
 * the fast ones were never the problem.
 */

const root = document.querySelector("[data-film]");
const film = mountFilm(root, { controls: true, scenario: "container" });

/** How long each rail really takes, in wall seconds. */
const PROFILES = {
  p50: { name: "typical",
    d: { "run-record": 1, dispatch: 7, clone: 4, detect: 1.5, plan: 11, render: 2,
         build: 33, upload: 8, release: 2, fleet: 66, verify: 4, done: 9999 } },
  slow: { name: "slow build",
    d: { "run-record": 1, dispatch: 9, clone: 6, detect: 2, plan: 26, render: 2,
         build: 232, upload: 14, release: 2, fleet: 78, verify: 6, done: 9999 } },
  cold: { name: "cold start + slow node",
    d: { "run-record": 2, dispatch: 96, clone: 5, detect: 2, plan: 14, render: 2,
         build: 40, upload: 9, release: 2, fleet: 158, verify: 5, done: 9999 } },
  repair: { name: "the build fails", scenario: "repair",
    d: { "run-record": 1, dispatch: 7, clone: 4, detect: 1.5, plan: 10, render: 2,
         build: 29, "repair-agent": 62, upload: 9, release: 2, fleet: 71, verify: 5, done: 9999 } },
  static: { name: "static lane", scenario: "static",
    d: { "run-record": 1, dispatch: 5, clone: 3, detect: 1.5, plan: 8, render: 1,
         build: 19, upload: 6, release: 2, deploy: 7, verify: 3, done: 9999 } },
};

const el = (id) => document.querySelector('[data-s="' + id + '"]');
const now = () => performance.now() / 1000;
const mmss = (s) => Math.floor(s / 60) + ":" + String(Math.floor(s % 60)).padStart(2, "0");

let profile = "p50", rails = [], at = -1, due = 0, t0 = 0, running = false, frozen = false;

function start(key) {
  profile = key;
  const p = PROFILES[key];
  film.scenario(p.scenario || "container");
  film.identity({ app: "storefront", url: "storefront.supersonic.cv", release: "", node: "" });
  rails = film.stages();
  at = -1; t0 = now(); due = 0; running = true; frozen = false;
  el("freeze").textContent = "Freeze here";
  document.querySelectorAll("[data-p]").forEach((b) => b.classList.toggle("on", b.dataset.p === key));
  advance();
}

function advance() {
  at += 1;
  if (at >= rails.length) { running = false; return; }
  film.setStage(at);
  due = now() - t0 + (PROFILES[profile].d[rails[at]] ?? 8);
}

function tick() {
  requestAnimationFrame(tick);
  const w = now() - t0;
  if (running && !frozen && w >= due) advance();
  const st = film.stage();
  el("sim").textContent = [
    running ? "deploy " + mmss(w) : "deploy finished",
    "stage " + (st.i + 1) + "/" + rails.length + " " + (rails[st.i] || ""),
    frozen ? "FROZEN — the film is on its own"
      : running ? "next in " + Math.max(0, due - w).toFixed(0) + "s" : "film plays out",
  ].join("   ·   ");
}

document.querySelectorAll("[data-p]").forEach((b) =>
  b.addEventListener("click", () => start(b.dataset.p)));
el("freeze").addEventListener("click", () => {
  frozen = !frozen;
  if (!frozen) due = now() - t0 + 3;
  el("freeze").textContent = frozen ? "Resume the deploy" : "Freeze here";
});
el("bump").addEventListener("click", () => { if (running) advance(); });

/* The film reads the page's theme every frame, so this is live. The product
   renders in both and the bench has to be able to look at both. */
const theme = el("theme");
const setTheme = () => { document.documentElement.dataset.theme = theme.value; };
theme.addEventListener("change", setTheme);
setTheme();

const q = new URLSearchParams(location.search).get("p");
start(PROFILES[q] ? q : "p50");
tick();
