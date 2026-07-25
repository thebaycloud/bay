export function slugify(input: string): string {
  const cleaned = input.trim().replace(/\.git$/, "").replace(/\/+$/, "");
  const last = cleaned.split("/").filter(Boolean).pop() || "";
  const s = last.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return s || "app";
}

/** Cloud Run service names: start with a letter, [a-z0-9-], <= 63 chars. */
export function cloudRunName(input: string): string {
  let s = slugify(input);
  if (!/^[a-z]/.test(s)) s = "app-" + s;
  return s.slice(0, 49);
}

/** A short random Cloud Run name — a letter + 4 alphanumerics, e.g. "as76d". */
export function randomSlug(): string {
  const alnum = "abcdefghijklmnopqrstuvwxyz0123456789";
  let s = "abcdefghijklmnopqrstuvwxyz"[Math.floor(Math.random() * 26)];
  for (let i = 0; i < 4; i++) s += alnum[Math.floor(Math.random() * 36)];
  return s;
}
