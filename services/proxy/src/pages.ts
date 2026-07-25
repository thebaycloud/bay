function shell(title: string, body: string): string {
  return `<!doctype html><meta charset="utf-8"><title>${title}</title>
<style>
body{font:16px/1.6 ui-sans-serif,system-ui,sans-serif;margin:0;min-height:100vh;
display:grid;place-items:center;background:#0b0b0c;color:#e8e8ea}
main{max-width:32rem;padding:2rem;text-align:center}
h1{font-size:1.25rem;margin:0 0 .5rem}p{margin:0;color:#9a9aa2}
code{background:#1a1a1d;padding:.1rem .35rem;border-radius:.25rem}
</style><main>${body}</main>`;
}

export function page403(ownerEmail: string): string {
  return shell("No access", `<h1>You don't have access to this tool</h1>
<p>Ask <code>${escapeHtml(ownerEmail)}</code> to share it with you.</p>`);
}

export function page404(): string {
  return shell("Not found", `<h1>No such tool</h1>
<p>This address isn't pointing at anything.</p>`);
}

export function page502(slug: string): string {
  return shell("Unavailable", `<h1>This tool isn't responding</h1>
<p><code>${escapeHtml(slug)}</code> is deployed but not answering right now.</p>`);
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}
