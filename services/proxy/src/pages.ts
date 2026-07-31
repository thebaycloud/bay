function shell(title: string, body: string, extra = ""): string {
  return `<!doctype html><meta charset="utf-8"><title>${title}</title>
<style>
body{font:15px/1.6 -apple-system,BlinkMacSystemFont,ui-sans-serif,system-ui,sans-serif;margin:0;min-height:100vh;
display:grid;place-items:center;background:#0e1512;color:#e9efeb}
main{max-width:30rem;padding:2rem;text-align:center}
.mk{width:40px;height:40px;border-radius:11px;background:#0b5e38;display:grid;place-items:center;margin:0 auto 20px}
h1{font-size:1.3rem;margin:0 0 .5rem;letter-spacing:-.01em}p{margin:0;color:#9db0a6}
code{background:#1d2621;padding:.1rem .35rem;border-radius:.25rem}
.btn{display:inline-flex;align-items:center;gap:8px;margin-top:22px;background:#2ea86a;color:#05130b;
border:0;cursor:pointer;font:600 14px sans-serif;padding:12px 20px;border-radius:10px;text-decoration:none}
.btn.ghost{background:transparent;color:#e9efeb;border:1px solid #2a3a33}
.btns{display:flex;gap:10px;justify-content:center;flex-wrap:wrap;margin-top:22px}
.btns .btn{margin-top:0}
.btn:disabled{opacity:.6;cursor:default}
.note{margin-top:14px;font-size:13px;color:#6d7d74}
</style><main>${body}</main>${extra}`;
}

const MARK = `<div class="mk"><svg width="20" height="20" viewBox="0 0 24 24" fill="#fff"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg></div>`;

/** Shown to a signed-in visitor who has no access. Offers to ask the owner —
 * without ever revealing who the owner is. */
export function page403(slug: string, appOrigin: string): string {
  const script = `<script>
var b=document.getElementById('req');
b.onclick=function(){
  b.disabled=true;b.textContent='Sending…';
  fetch(${JSON.stringify(appOrigin)}+'/api/apps/${slug}/request-access',{method:'POST',credentials:'include'})
   .then(function(r){return r.json().catch(function(){return{}})})
   .then(function(j){
     if(j&&j.ok){document.getElementById('body').innerHTML='${MARK}<h1>Request sent</h1><p>The owner has been asked to give you access. You&#39;ll hear back by email.</p>';}
     else{b.disabled=false;b.textContent='Request access';document.getElementById('n').textContent=(j&&j.error)||'Could not send the request. Try again.';}
   }).catch(function(){b.disabled=false;b.textContent='Request access';document.getElementById('n').textContent='Could not reach the server.';});
};
</script>`;
  return shell("No access", `<div id="body">${MARK}<h1>You don't have access to this app</h1>
<p>This app is private. You can ask the owner to let you in.</p>
<button class="btn" id="req">Request access</button>
<div class="note" id="n"></div></div>`, script);
}

/** Shown to an anonymous visitor on a private app — a soft landing instead of an
 * abrupt redirect to login. Both links carry callbackUrl so they return here. */
export function pageGate(loginUrl: string, signupUrl: string): string {
  return shell("Sign in to open", `${MARK}<h1>This app is private</h1>
<p>Sign in or create a free account to open it — you'll come right back here.</p>
<div class="btns">
  <a class="btn" href="${escapeHtml(loginUrl)}">Sign in</a>
  <a class="btn ghost" href="${escapeHtml(signupUrl)}">Create account</a>
</div>`);
}

export function page404(): string {
  return shell("Not found", `<h1>No such tool</h1>
<p>This address isn't pointing at anything.</p>`);
}

export function page502(slug: string): string {
  return shell("Unavailable", `<h1>This tool isn't responding</h1>
<p><code>${escapeHtml(slug)}</code> is deployed but not answering right now.</p>`);
}

/** Shown at a reserved URL that has neither a build nor a tunnel yet. Reloads
 *  itself, so it becomes the live app the moment either appears. */
export function pageBuilding(slug: string): string {
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="3">` +
    shell("Deploying…", `<h1>🚀 Deploying <code>${escapeHtml(slug)}</code></h1>
<p>Your app is going live — this page updates itself. Hang tight.</p>`);
}

/**
 * Shown when the deploy failed.
 *
 * This case used to reach "deployed but not answering right now", which
 * describes a working app having a bad moment — not one that never built. The
 * reason was in the deploys row the whole time; it just had nowhere to go.
 *
 * Deliberately does NOT reload itself. Nothing is coming.
 */
export function pageFailed(slug: string, reason: string | null): string {
  // The first line of a build failure is the useful one; the rest is a stack of
  // Cloud Build framing. Trimmed rather than hidden — a visitor who is not the
  // owner should still see enough to know it is not their fault.
  const first = (reason ?? "").split("\n").map((l) => l.trim()).filter(Boolean)[0] ?? "";
  const detail = first
    ? `<p class="note">${escapeHtml(first.slice(0, 200))}</p>`
    : "";
  return shell("Deploy failed", `<h1>This app didn't deploy</h1>
<p>The last deploy of <code>${escapeHtml(slug)}</code> failed, so there's nothing here to show yet.</p>
${detail}
<p class="note">The owner can see the full log with <code>supersonic logs ${escapeHtml(slug)}</code>.</p>`);
}

/**
 * Shown when a deploy stopped reporting and never finished.
 *
 * The state this replaces is the one that mattered: a deploy whose process died
 * leaves apps.status at 'deploying' with nothing to serve, and the edge answered
 * a 200 "Deploying…" page for as long as anyone cared to look. A dead URL that
 * returns OK is worse than one that returns an error — monitoring calls it
 * healthy and an agent calls it shipped.
 */
export function pageStalled(slug: string): string {
  return shell("Deploy didn't finish", `<h1>This deploy stopped</h1>
<p><code>${escapeHtml(slug)}</code> started deploying and never finished, so there's nothing here yet.</p>
<p class="note">Deploying again is usually all it takes: <code>supersonic deploy</code>.</p>`);
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}
