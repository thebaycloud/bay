/**
 * The ONE record to create for a hostname.
 *
 * A person connecting a domain should be told what to type, not handed a choice
 * between two records with a rule for picking. The rule is ours to apply: an
 * apex cannot be a CNAME (the DNS specification forbids one beside the zone's
 * own SOA and NS records, and every registrar enforces it), and a subdomain
 * should be a CNAME so it keeps working if our load balancer changes address.
 *
 * WHY THE FALLBACK IS `A`, AND WHY THAT MAKES THIS SAFE
 *
 * Deciding apex from subdomain needs to know where the registrable domain ends,
 * and that is a list, not a rule — `acme.co.uk` is a root with three labels and
 * `www.acme.com` is a subdomain with three. The list below is the two-level
 * suffixes that actually turn up; it is not the whole Public Suffix List and it
 * never will be.
 *
 * So the uncertain case matters, and it is asymmetric: an **A record works at an
 * apex and at a subdomain alike**, while a CNAME works only at a subdomain. Any
 * name this file cannot place confidently is therefore told to use `A` — the
 * answer that is merely less future-proof, rather than the one a registrar
 * refuses outright.
 *
 * No imports. This is read from a client component.
 */

/**
 * Two-label public suffixes, so `acme.co.uk` is read as a root and not as a
 * subdomain of `co.uk`.
 *
 * The ones people actually connect. A name under a suffix that is not here is
 * not guessed at — see the `A` fallback above.
 */
const TWO_LEVEL = new Set([
  "co.uk", "org.uk", "me.uk", "ac.uk", "gov.uk", "net.uk", "sch.uk",
  "com.au", "net.au", "org.au", "edu.au", "gov.au", "id.au",
  "co.nz", "net.nz", "org.nz", "govt.nz", "ac.nz",
  "co.za", "org.za", "net.za", "web.za",
  "com.br", "net.br", "org.br", "gov.br",
  "com.mx", "org.mx", "net.mx",
  "co.jp", "or.jp", "ne.jp", "ac.jp", "go.jp",
  "co.kr", "or.kr", "ne.kr",
  "com.cn", "net.cn", "org.cn", "gov.cn",
  "com.tr", "net.tr", "org.tr",
  "com.ar", "com.co", "com.pe", "com.sg", "com.hk", "com.tw", "com.ua",
  "co.in", "net.in", "org.in", "firm.in", "gen.in", "ind.in",
  "com.pl", "net.pl", "org.pl",
  "co.il", "org.il", "net.il",
  "com.es", "com.pt", "com.gr", "com.ru", "org.ru", "net.ru",
]);

export interface DnsRecord {
  type: "A" | "CNAME";
  /** What goes in the record's Name field. `@` is every panel's word for the root. */
  name: string;
  value: string;
  /** True when the type was chosen by the `A`-is-always-safe fallback. */
  guessed: boolean;
}

/**
 * How many labels belong to the registrable domain — 2 normally, 3 under a
 * two-level suffix. `null` when the name is too short to be one at all.
 */
function rootLabels(labels: string[]): number | null {
  if (labels.length < 2) return null;
  const lastTwo = labels.slice(-2).join(".");
  if (TWO_LEVEL.has(lastTwo)) return labels.length >= 3 ? 3 : null;
  return 2;
}

export function recordFor(hostname: string, dns: { ip: string; cname: string }): DnsRecord {
  const labels = hostname.toLowerCase().replace(/\.$/, "").split(".").filter(Boolean);
  const root = rootLabels(labels);

  // Unplaceable — a single label, or a two-level suffix with nothing in front of
  // it. `A` at the whole name: it is the record that cannot be refused.
  if (root === null) return { type: "A", name: "@", value: dns.ip, guessed: true };

  const sub = labels.slice(0, labels.length - root);
  if (sub.length === 0) return { type: "A", name: "@", value: dns.ip, guessed: false };

  // A subdomain, and the Name is the part in front of the registrable domain —
  // `www`, not `www.acme.com`. Nearly every DNS panel appends the zone itself,
  // so the full name typed there becomes `www.acme.com.acme.com`.
  return { type: "CNAME", name: sub.join("."), value: dns.cname, guessed: false };
}
