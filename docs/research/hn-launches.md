# How developer-infrastructure products actually launched on Hacker News

Research date: 2026-08-24. Primary source: the public Hacker News search API at `hn.algolia.com/api/v1` — `search`, `search_by_date`, and `items/<id>` for full comment trees. Every point total, comment count, timestamp, author, title and URL below was read out of an API response on the research date and is quoted verbatim. Comment text is quoted verbatim from the `items` tree, with HTML stripped; ellipses mark truncation.

## What was verifiable and what was not

**Verifiable, and verified:** story titles exactly as posted; points; `num_comments`; `created_at` to the minute in UTC; submitting author's HN handle; the URL the story pointed at (or that it was a text post with no URL); the full comment tree including every comment's author, text, timestamp and position; therefore also the exact count of comments a founder posted in their own thread.

**Not verifiable, and marked as such throughout:**

- **Per-comment scores do not exist in the API.** Every comment in every `items/<id>` response carries `points: null`. HN has not exposed comment scores publicly for years. The brief asked for "the top 3-5 comments by score" — that artifact cannot be produced from the primary source, and I am not going to fabricate an ordering. Where this document says "top comments," it means **top-level comments ranked by the size of the reply subtree beneath them**, which is a measurable proxy for what the thread actually argued about, and is labelled as such every time. It is not the same as score, and a highly-upvoted comment that nobody replied to will be invisible to it.
- **`children` order is chronological, not ranked.** Verified by inspection: in item 23319901 the children run 06:28, 07:25, 07:36, 07:50 … So the API cannot recover HN's displayed ranking either.
- **Whether a submitter is affiliated with the company** is generally not establishable from the API. Where I assert it, the evidence is either an official company post or a self-identifying comment in the thread, cited inline. Where I could not establish it, it says so.
- **Open-source status at launch** is asserted only where the title says it, a repo was the submitted URL, or a founder states the license in-thread. Otherwise it is recorded as "title made no open-source claim; not independently established from the thread."
- **Deleted or flagged submissions** would not appear in these searches. A product could have a launch attempt that is now invisible. Absence of evidence here is weak evidence of absence, and for the two negative findings that matter most (Render, Railway) I searched by product-name title, by URL domain (`restrictSearchableAttributes=url`), and by founder/CEO author tag before concluding.

---

## 1. The launches, product by product

### Supabase — the highest-scoring launch in the set, and it was not their launch

**Verbatim title:** `Supabase (YC S20) – An open source Firebase alternative`
**1120 points, 366 comments, 2020-05-27 06:13 UTC (Wednesday), submitted by `@vira28`, linking to `https://supabase.io/`** ([item 23319901](https://news.ycombinator.com/item?id=23319901))

No `Show HN:` prefix. No `Launch HN:` prefix. A bare product name, the YC batch tag, and a five-word category claim.

**It was not posted by the company.** Supabase's own post-mortem, published six weeks later, states it plainly: "we weren't planning to launch — the HackerNews post was created by an early GitHub follower, while we were alpha testing, and it was too scary to migrate the middleware while it was servicing the thundering herd" ([supabase.com/blog/alpha-launch-postmortem](https://supabase.com/blog/alpha-launch-postmortem), Paul Copplestone, 10 Jul 2020). The same post gives the outcome: front page for more than 24 hours, 30,000 new visitors to supabase.io, over 1400 signups in 7 days, scaled to over 1000 databases. It also records that the middleware serving all of it was a single 4-CPU/8GB Ubuntu box running `docker compose up`, that they hit DigitalOcean's 400-droplet limit within hours and the 1000-droplet limit hours later, and that they were down for three hours at 4am on a Cloudflare subdomain limit because only the account owner could upgrade and his phone was on silent.

**Founder's first comment**, from co-founder `@kiwicopple`, is two sentences — the shortest opening comment of any high-scoring launch in this set:

> co-founder here, happy to answer any questions. We're currently in alpha - app.supabase.io
>
> We also have a lot more to build, so to reward you for your patience we are completely free right now

No origin story. No architecture. No competitor naming beyond what the title already did. What he did instead was **stay in the thread: 58 of the 366 comments are his.**

**Top-level comments by reply-subtree size:**

- `@habosa` (60 replies), who opens "Disclaimer: I work on Firebase but I'm always speaking for myself on Hacker News," and then argues the comparison undersells them: "Honestly I think the Firebase comparison may be throwing some people off here because this is a SQL-based system, which means there's a huge base of existing tools/techniques/knowledge to build from." A competitor's employee gave the launch its most-discussed comment and it was positive.
- `@DigitalSea` (54): "I am ecstatic that someone is finally taking on Firebase. … Following this intently, because Firebase has no true competitor, let alone an open source one."
- `@aswinmohanme` (28): "Firebase is kind of the poster child for vendor lock in … It's time we have some healthy competition."
- `@2mol` (18) and `@RNCTX` (13) both immediately locate the thing inside an existing lineage — PostgREST, Postgraphile — rather than treating it as new.

The thread is unusually free of the hostility that characterises the rest of this set. The reason is legible in the comment text: the objection people would normally aim at the launcher (lock-in, closed source, why not just use X) had already been aimed at *Firebase*, and Supabase was standing on the correct side of it.

### Fly.io — the reference-grade `Launch HN` text post

**Verbatim title:** `Launch HN: Fly.io (YC W20) – Deploy app servers close to your users`
**626 points, 261 comments, 2020-03-18 14:15 UTC (Wednesday), by `@mrkurt`, `url: null` — a text post, no external link** ([item 22616857](https://news.ycombinator.com/item?id=22616857))

The whole pitch lives in the post body. Its structure, in order: greeting and names of all three founders; **origin story with a specific prior job** ("I helped build Ars Technica and spent the majority of my time trying to make the site fast. We used a content delivery network … But the most valuable readers were not these, but the ones who paid for subscriptions … Content delivery networks don't work for Ars Technica's best customers"); the problem restated physically ("Running Docker apps close to users helps get past the 'slow' speed of light"); **the actual mechanism, named** ("We convert your Docker image into a root filesystem, boot tiny VMs using a project called Firecracker … We wrote a Rust based router … Applications get dedicated IP addresses from an Anycast block … We run a mesh Wireguard network for backhaul"); **evidence of revenue** ("We got a handful of enterprise companies to pay for this"); **a concrete time-to-value claim with a link** ("it takes 3 commands to deploy a Docker image and have it running in 17 cities: https://fly.io/docs/speedrun/"); a competitor-relative number ("typical Heroku apps are 800ms faster on fly.io").

Then the move that no other launch in this set makes — **pre-empting HN's own objections, and saying out loud that they came from HN**:

> We've also built some features based on Hacker News comments. When people launch container hosting on Hacker News, there's almost always a comment asking for:
>
> 1. gRPC support …
> 2. Max monthly spend: unexpected traffic spikes happen, and the thought of spending an unbounded amount of money in a month is really uncomfortable. You can configure fly.io apps with a max monthly budget …

And it closes on two customer anecdotes rather than a feature list — re-encoding MP3s at variable speeds, and "TensorFlow at the edge."

**Kurt posted 51 of the thread's 253 comments.** Tone throughout is flat, specific and unguarded, including about the business: asked about acquisition, he answers "I was at a company that got acquired before. It was so awful. I'd rather just work on this forever than get absorbed by a big company" — which immediately drew "How do your investors feel about this / what's your exit plan?" from `@optimiz3`.

**Top-level comments by reply-subtree size** — and the top one is the trust objection, not a technical one:

- `@yingw787` (18 replies): "Honestly, while I'd love to try this out, **I'm afraid of committing to a solution that might not be around long-term** … I'm using bare AWS at the moment because a) they gave me $5k in credits for YC SUS, b) **they own the physical servers**, and c) I can trust that they'll be around a long time, so **I'd rather get locked into AWS proper** rather than a service that might be built on top of AWS."
- `@dathinab` (13) on the spend cap: "not having caps is a major problem with some of your competition for smaller projects/companies where the max caps are more important then availability."
- `@a13n` (13), the sharpest technical objection: "If one API request makes on average 5-10 round trips to the database, and the database is in Virginia, this only makes the problem (much) worse."
- `@Thaxll` (12), the "why does this exist" comment: "What problem does it solve? Because latency is currently not an issue with all the regions from current cloud providers from my perspective. … It looks more like: https://workers.cloudflare.com/"

Deeper in the tree, `@vikramkr` states the trust dynamic explicitly: "the fact that you are profitable and have large customers could be as important a part of your customer pitch as it is your investor pitch … that trust in the organization to stick around is super important."

**Earlier Fly launch, for contrast.** `Show HN: Fly – A global load balancer with middleware`, **112 points, 68 comments, 2017-03-29 13:24 UTC**, also `@mrkurt` ([item 13985940](https://news.ycombinator.com/item?id=13985940)). Same founder, same discipline in the opening comment (origin, mechanism, concrete middleware list), one-fifth the score. The most-replied comment (35 replies) is pure pricing rejection from `@Xorlev`: "Wow, this is _really_ expensive! I'm sorry, but $0.05/1000 requests is really really premium. 1000 request/s is $0.05/s. 86400s/day * 30 days * $0.05 -> $129.6K/30d."

### Railway — the closest comparable to the reader's product, and both of its Show HNs died

**Verbatim titles, both by `@justjake` (Jake Cooper, CEO):**

| Title | Points | Comments | Date/time (UTC) | URL |
|---|---|---|---|---|
| `Show HN: Railway – Configless Software Infrastructure` | **11** | 7 | 2021-09-29 16:53 Wed | `https://railway.app/` |
| `Show HN: Railway – A better way to build software. Period` | **14** | 5 | 2024-11-14 20:25 Thu | `https://railway.com/` |

([item 28696391](https://news.ycombinator.com/item?id=28696391), [item 42140800](https://news.ycombinator.com/item?id=42140800))

Neither has a founder opening comment. In each, `@justjake` posted exactly one comment in the whole thread. Both link to a bare homepage. The 2021 thread has two top-level comments; the entire critical content of the 2024 thread is the price objection, from `@gsemyong`:

> Railway is truly remarkable. I wish it was cheaper though, because currently, given the **10-10000x price difference in comparison to hetzner+coolify**, using it in production is not justifiable for me.

and from `@replwoacause`: "I loved the DX. If it wasn't so expensive I'd probably use it in more stuff. But I'll suffer more manual work on hetzner to save a little $$$."

A third attempt, `Show HN: Railpack – Zero-Config Dockerimage Builds` (2025-03-04, `https://github.com/railwayapp/railpack`), scored **6 points, 2 comments** ([item 43260190](https://news.ycombinator.com/item?id=43260190)) — despite having a proper founder opening comment with numbers ("Up to 75% smaller images, Up to 5x faster builds").

**Railway's HN traction is entirely in engineering content, not launches.** By points, from a URL-domain search across `railway.app` and `railway.com`: "So you want to build your own data center" 596/276 (2025-01-17), "Incident Report: Railway Blocked by Google Cloud [resolved]" 560/357 (2026-05-20), "Incident Report: May 19, 2026 – GCP Account Suspension" 457/268, "GCP Incidents" 339/158 (2023-12-02), "Why We're Moving on from Nix" 275/136, "We moved Railway's frontend off Next.js. Builds went from 10+ mins to under 2" 215/217, "Serving 250k developers with one support engineer" 215/82. Every one of these is a mechanism story or a public failure. None is a product announcement.

### Render — no HN launch exists

This is the strongest negative finding in the set, and I checked it three ways: a title search on the product name across 2018–2020, a URL-domain search on `render.com` returning all 70 submissions ever indexed, and an author search on `@anurag` (Anurag Goel, founder/CEO).

Every 2019 submission of render.com, by four different non-affiliated accounts:

| Title | Points | Comments | Date (UTC) |
|---|---|---|---|
| `Render – The Easiest Cloud for All Your Apps` (`@tuacker`) | **4** | **0** | 2019-04-25 21:06 |
| `Render Launches the Easiest Cloud` (`@amenod`) | **2** | **0** | 2019-04-26 |
| `Render – Heroku-like cloud hosting at a better price` (`@simplify`) | **2** | **0** | 2019-05-22 18:16 |
| `Render · the Easiest Cloud for All Your Apps and Websites` (`@gleb`) | **4** | **0** | 2019-08-17 |

Four submissions, twelve points, zero comments between them. No `Show HN`. No `Launch HN`. No founder comment anywhere.

Render's HN presence, like Railway's, arrived later and through other doors: "Render: a Zero DevOps Cloud Platform" 141/120 (2022-03-23, `@MikeFaber`), "A Better Git Flow" 95/114, "Scaling Knative to 100K+ Webapps" 141/31 (`@anurag`), "How We Found 7 TiB of Memory Just Sitting Around" 207/74 (`@anurag`, 2025-10-30), plus funding announcements (Series B 97/71, Series C 108/99) and outages. `@anurag`'s single highest-scoring HN submission of all time is someone else's blog post: Mitchell Hashimoto's "My AI Adoption Journey," 984 points.

A recent Render product Show HN, `Show HN: Render Workflows – Durable task orchestration without queues or workers` (2026-04-09, `@anurag`), scored **7 points**.

### Vercel / Zeit / Now

| Verbatim title | Points | Comments | Date/time (UTC) | Author | URL |
|---|---|---|---|---|---|
| `Now: realtime Node.js deployments` | 288 | 115 | 2016-04-06 17:26 Wed | `@hswolff` | `https://zeit.co/now` |
| `Serverless Docker Beta` | 595 | 228 | 2018-08-14 16:47 Tue | `@Rauchg` | `https://zeit.co/blog/serverless-docker` |
| `Now 2.0` | 415 | 117 | 2018-11-08 16:38 Thu | `@Rauchg` | `https://zeit.co/blog/now-2` |
| `Vercel, formerly Zeit, raises $21M Series A` | 325 | 190 | 2020-04-21 | `@mxschmitt` | `https://vercel.com/blog/zeit-is-now-vercel` |

The original Now launch ([item 11440224](https://news.ycombinator.com/item?id=11440224)) was submitted by `@hswolff`, whose affiliation I could not establish. Guillermo Rauch appears in the thread as the most-replied top-level comment (34 replies) with a two-line comment: "CEO of https://zeit.co here! Happy to answer any questions throughout the day :)" — the same shape as Copplestone's, though Rauch posted only 11 of the thread's 115 comments.

The two most-replied objections are worth quoting because the reader's product has the same failure mode available to it. `@seibelj` (16): "Red Hat Openshift has a solid free tier, free SSL, git push deployments, node / ruby / python / java / php / etc., mysql / postgres, redis. **Why would I use this over that?**" And `@mmaunder` (11), on the landing page:

> Had to read three pages and still haven't quite confirmed that this is node.js hosting. But based on the pricing page, I guess it is. **Can you please just say that?** Just say "It's node hosting and the deployment system is fast." You literally just stole some of my life.

Note that Zeit's two highest-scoring self-submitted posts were both *feature* announcements linking to a technical blog post, not product launches, and that Rauch submitted them himself under plain titles with no prefix. In `Now 2.0` he posted 17 of 117 comments.

Vercel's own domain, incidentally, has never produced a top-scoring product launch on HN — its highest-scoring `vercel.com` submissions are "Turbopack, the successor to Webpack" (626/312) and "AGENTS.md outperforms skills in our agent evals" (524/196).

### Neon — a launch that happened *to* them

**Verbatim title:** `Neon – Serverless Postgres`
**667 points, 330 comments, 2022-05-28 01:37 UTC (Saturday), by `@nikolay`, linking to `https://neon.tech`** ([item 31536827](https://news.ycombinator.com/item?id=31536827))

Two words after the dash. No prefix, no "alternative to," no open-source claim in the title — despite the product being Apache 2.0.

The CEO's comment in-thread establishes it was not their post:

> Nikita - CEO of Neon here. **We intended to post this at the launch next month, but since it here**, I'm happy to answer any questions.
>
> We have been hard at work and looking to open the service to the public soon.

He then posted **44 of the thread's 322 comments**, and used them to say the things the title didn't. On longevity, unprompted: "We are committed to building a durable company and we are well funded. So yes, you will hear from us for years to come as we will be shipping more and more features." On licensing: "there are many serverless options - fewer that separated storage and compute and fewer that are open source end-to-end. … Our intention is to standardize the separation of storage and compute cloud architecture - **that's why it's open source under the Apache 2.0 license.**"

**Top-level comments by reply-subtree size:**

- `@anilgulecha` (86 replies — the single most-discussed comment in this entire research set) does the positioning work for them: "This is the missing piece on cloud for masses … The only piece in the stack that was always-on was the database … This is a paradigm-shift stack."
- `@ranguna` (16) is a use-case testimonial with a competitive matrix of DO/Cockroach/etc.
- `@peterkelly` (14) is a pure terminology attack, quoted in full: "Please stop this abuse of language. Here's serverless sqlite: https://www.sqlite.org/serverless.html"
- `@SonOfLilit` (13) tells them their headline is wrong: "Neon allows to instantly branch your Postgres database … **Unless I missed that everyone supports this, this here could be a killer feature and should be advertised higher.**"

That last one is the most transferable comment in the document: the highest-value feature was buried below the fold and a commenter had to surface it for them.

### PlanetScale

**Verbatim title:** `PlanetScale – Database for Developers`
**279 points, 128 comments, 2021-05-18 17:16 UTC (Tuesday), by `@samlambert` (CEO), linking to `https://www.planetscale.com/blog/announcing-planetscale-the-database-for-developers`** ([item 27197873](https://news.ycombinator.com/item?id=27197873))

Founder-submitted, no prefix, pointing at a launch blog post rather than the homepage. **No founder opening comment.** Sam Lambert posted 6 comments in the thread and every one is a one-liner: "Yes we are MySQL compatible.", "Yes!", "Yes absolutely!", "Sure you can! and we will make it worth it.", "This is MySQL. There is a schema. We just make it super easy to manage."

**Top-level comments by reply-subtree size** — the top one is that nobody could tell what it was:

- `@unknown_error` (23): "Can someone please explain how Vitess works, **in plain English**? … And then what does PlanetScale add on top of Vitess hosted anywhere else? Sorry, **the linked blog post is both very abstract and assumes a high level of preexisting knowledge**."
- `@briandoll` (11) supplies the analogy the launch didn't: Subversion release managers vs. cheap git branches.
- `@vira28` (8) — the same handle that submitted Supabase — asks "Wondering will we see something like this for Postgres? I like the cool things but I can't migrate to MySQL just because of this."
- `@Rauchg` (6) shows up to endorse it from Vercel's side: "This technology makes the whole serverless stack feel complete."
- `@jaredcwhite` (5) is the lock-in attack, and **it went unanswered by the founder**: "Can I install this locally? Will it work without an internet connection? Is it fully open source? From what I can tell, the answer to all three questions is no. **Is it yet another example of vendor lock-in? Yes.**"
- `@cfors` asks the wrapper question directly: "So is this **a wrapper around managing Schemas powered by Vitesse**? (Btw, had to go to your github to figure that out)"

### Clerk

**Verbatim title:** `Show HN: Clerk – all of user management as-a-service, not just authentication`
**582 points, 223 comments, 2021-02-08 20:25 UTC (Monday), by `@colinclerk`, linking to `https://clerk.dev/blog/all-of-user-management-not-just-authentication`** ([item 26069621](https://news.ycombinator.com/item?id=26069621))

The title's tagline is a *differentiating negation* — "not just authentication" — and it's the highest-scoring `Show HN` in this set. Founder opening comment is short, generic, and gives no origin story or mechanism:

> Hi HN - We couldn't be more excited to launch Clerk and help developers solve all of user management. It's been quite a journey to reach this point, with over a year of iteration on the developer experience before we found something developers love. … Our team is listening in this thread and we're happy to answer any questions.

He posted 13 of 223 comments.

**Top-level comments by reply-subtree size** — the top one is nine words:

- `@faeyanpiraat` (43 replies): "**I'm even hesitant to trust Auth0 for this, why would I trust a new company?**"
- `@jerrac` (20): "I'd be very reluctant to use a proprietary service … **Why isn't there an Open Source, standardized, self-hosted, version of this kind of service?**"
- `@rexreed` (16): pricing-cliff arithmetic — "Pricing is free up to 5,000 MAU … so if you have 5,001 MAU you take a big leap from $0 to $249/mo. Is there a reason for that huge bump?"
- `@SahAssar` (16): "if you mention security as a top-level feature it might be good to fix these: securityheaders.com/?q=… For me it is also a red flag to include third party CDN JS (especially without SRI) on security critical applications."

Someone ran a scanner against their marketing site during the launch. That is the ambient level of scrutiny.

### Resend

**Verbatim title:** `Launch HN: Resend (YC W23) – Email API for developers using React`
**432 points, 270 comments, 2023-06-13 12:16 UTC (Tuesday), by `@zenorocha`, linking to `https://resend.com`** ([item 36309120](https://news.ycombinator.com/item?id=36309120))

The **highest comments-to-points ratio in the set (0.63)**, and reading the thread, that ratio is measuring hostility, not interest.

The text post is long and well-organised: a "Why?" that names four competitors by name and their founding decade and their acquisitions; four labelled problem/solution pairs (templates, performance, observability, "Designed for marketers only"); a personal backstory naming two prior employers; a closing question to the audience.

Two of those structural choices were attacked directly. First, the React framing, in the most-replied comment of the thread (`@paxys`, 77 replies):

> Help me understand the React selling point. … No email client out there supports JavaScript, virtual DOMs, event loops, SSR or any such fancy web technology. Instead of hand-crafting an HTML template with `<title> <p> <a> <h1> <img> <div>` etc I'm supposed to use your custom React components which you will promptly compile down to the tags I mentioned above. **So...what value am I getting out of React at all?**

Second, and more instructive: **naming the competitors' acquisitions as the reason to distrust them handed HN the weapon.** `@nik736`: "Your competitors have been acquired but you are funded by YC… so **there is a high chance this will happen to you as well.**" `@pelcg`: "So does this mean that Resend won't get acquired? **What is your exit strategy other than an acquisition?**" `@paxys`: "'All the big players in the space got acquired or had a big IPO. Instead of supporting them choose our scrappy VC-backed startup so that one day we can get acquired or have a big IPO.'" And `@aziaziazi` turns the pitch into a two-part question the founder has to answer.

Third, the observability claim was called false by a practitioner (`@iamacyborg`): "I can't think of a single email platform I've used as an email marketer/crm marketer for a decade that didn't expose a full event stream for all emails."

And `@joshmanders` filed a UX bug from actually using it during the launch — a tab-visibility handler that yanked him back to the dashboard: "There is absolutely ZERO reason for this functionality."

Zeno posted **35 of 270 comments**.

### The self-hostable cluster: Coolify, Dokploy, Appwrite, Nhost

| Verbatim title | Points | Comments | Date/time (UTC) | Author | URL |
|---|---|---|---|---|---|
| `Coolify: Open-source and self-hostable Heroku / Netlify / Vercel alternative` | **382** | 180 | 2025-04-02 12:41 Wed | `@vanschelven` (affiliation not established) | `https://coolify.io/` |
| `Show HN: Coolify v2 – Open-source and self-hostable Heroku/Netlify alternative` | **158** | 54 | 2022-03-30 13:27 Wed | `@andrasbacsai` (maintainer) | `https://coolify.io/` |
| `Show HN: Appwrite – Open-Source and Self Hosted Firebase Alternative` | **326** | 118 | 2022-03-22 17:37 Tue | `@christyjacob4` | `https://github.com/appwrite/appwrite` |
| `Show HN: Nhost – Open source Firebase alternative with GraphQL` | **210** | 69 | 2020-10-29 12:26 Thu | `@elitan` | `https://nhost.io` |
| `Open Source Alternative to Vercel, Netlify and Heroku` | **47** | 28 | 2025-01-21 10:29 Tue | `@thushanfernando` (Dokploy) | `https://dokploy.com` |
| `Show HN: Appwrite Sites – the open-source vercel alternative` | **44** | 22 | 2025-05-19 12:23 Mon | `@eldad_fux` | Appwrite blog |

**Coolify is the cleanest natural experiment in the set: the third party's submission (382) outscored the maintainer's own Show HN (158) by 2.4x with a nearly identical title.** The delta between the two titles is one extra competitor name ("/ Vercel") and three years. In the 2025 thread `@andrasbacsai` posted exactly **one** comment out of 174; in his own 2022 Show HN he posted 17 of 54.

His 2022 opening comment is worth studying because it does something none of the VC-backed launches do — it states the business model honestly, including that there isn't one:

> You may ask, how is it financially sustainable? **It is not, at the moment**, but it is backed by community and the actual users through OpenCollective. After it went viral on here, lots of VC reached out to me to invest and help to raise a fund. **I said no to all of them.** That is not the way I would like to grow this project.

It also opens with the origin ("I was just curious if I can make it work for myself"), gives a feature list, gives a *future plans* list, and closes with a personal note ("This is THE side project that caused me to leave a good paying job when the pandemic started").

**What the self-hosting audience attacks is different from what the PaaS audience attacks.** In the Coolify Show HN, the most-replied comment (`@moondev`, 12) is about the install script and the signup wall:

> After going through the contents of get.coollabs.io/coolify/install.sh it seems to want to overwrite my docker daemon.json, then sets up a UUID for telemetry. I decided to just manually run the docker container (**this should be clear in your README, please don't try to abstract away what this is doing behind a script**). After launch I was then greeted with a login/registration page. **Seems kind of backwards to require this when you are targeting the self-host crowd. Too much friction to try this out.**

And `@mdasen` (4) gives the longevity objection in its self-hosted form — a graveyard list: "I've seen Flynn EOL. I've seen Docker Swarm's future be a bit hazy. I've seen Porter decide to put pretty restrictive limits on their free tier. I've seen Dokku lose steam."

In the 2025 Coolify thread the top comment (`@pier25`, 24 replies) is a paying customer's teardown, and it is brutal:

> The dashboard is incredibly clunky … The deal breaker was **it didn't have zero downtime deploys. Any pending request when you update an app is simply killed.** … **I was expecting something like Heroku or Vercel but this ain't it.** Ended up concluding that if I wanted to run/deploy apps on my own VPS I'd just use Kamal or Dokku.

Second (`@hk1337`, 19) is the whole self-hosting premise rejected: "I would choose Heroku or Netlify **because I don't want to self host it**."

For Dokploy, note that the maintainer (`@Siumauricio`) posted **zero** comments in the thread; the submitter was a third party. The top-replied comment (`@diggan`, 10) is confusion about what "Managed Hosting: No need to manage your own servers / 1 Servers (You bring the servers)" could possibly mean, and `@maxloh` caught the title being false:

> There is one caveat, though: **it is not open source as advertised.** > "In the event of a conflict, these provisions shall take precedence over those in the Apache License: Restriction on Resale: The multi-node support, Docker Compose file support, Preview Deployments and Multi Server features cannot be sold or offered as a service…"

Appwrite's Show HN opening comment is a long feature bullet list with no origin story and no business model; the top-replied comment (`@aerovistae`, 12) is "**Before I even look into it, I'll tell you this: the headline was enough to grab my attention on its own**" — direct testimony that the title did the work. The second (`@kiru_io`, 9) is "how do you finance the development?" and the third (`@20220322-beans`, 6) is a stack objection: "Appwrite is written in PHP. Just because something is open source, doesn't mean it is extensible, scalable or otherwise written well."

### Convex — never had an HN launch either

`Convex – the reactive back end for your reactive apps` (`@stevekrouse`, 2021-11-03) scored **7 points, 0 comments** ([item 29089591](https://news.ycombinator.com/item?id=29089591)). `Convex – Full Stack Dev Platform Written in TypeScript` (2024-01-09) scored 1 point.

Convex's highest-scoring product-adjacent HN item is a **docs page comparing itself to a competitor**: `Convex vs. Firebase`, **111 points, 83 comments, 2022-06-22 03:12 UTC**, submitted by `@alexcole` linking to `docs.convex.dev/understanding/convex-vs-firebase` ([item 31831623](https://news.ycombinator.com/item?id=31831623)). The most-replied comment (`@TekMol`, 33) rejects the entire framing by quoting the article's own Firebase code sample against it and answering with four lines of SQL: "It is amazing with how much cruft developers are willing to deal with these days." `@DanielKehoe` asks the question the comparison invited: "I'm more interested in a comparison of Convex to Supabase."

Convex's actual HN traction is content: "The Magic of Embeddings" 119/21, "How Convex Works" 96/28, "It's not you, it's SQL" 61/83, plus funding posts (Series B $57M, 17 points).

### Cloudflare Workers and Deno Deploy — incumbent-adjacent launches

**Verbatim title:** `Cloudflare Workers: Run JavaScript Service Workers at the Edge`
**327 points, 132 comments, 2017-09-29 13:11 UTC (Friday), by `@thomseddon` (affiliation not established), linking to `https://blog.cloudflare.com/introducing-cloudflare-workers/`** ([item 15364896](https://news.ycombinator.com/item?id=15364896))

Third-party submission of the company's own blog post. The most-replied comment (38) is the engineer claiming it, and its second line is the whole trust play:

> Hey all! This is my project at Cloudflare. **(You may remember me as the tech lead of Sandstorm.io and Cap'n Proto.)** Happy to answer questions!

`@kentonv` posted 38 of 132 comments. The thread contains the single most laudatory comment in this entire research set, from `@js2` — and note that every clause of it is about the *writing*, not the product:

> This is probably the best annoucement of a new feature I have ever read. **It makes an analogy to an existing technology.** It provides a clear description of the new feature. **It provides clear examples of how to use the new feature with a link to a sandbox so you can run and modify the examples.** And it explains the thought process behind the implementation. In additon, I didn't notice a single typo, spelling or grammar error. Also, this feature is pretty cool!

Deno Deploy, by contrast, never launched loudly: `Deno Deploy` (2021-03-29) 22 points/1 comment; `Deno Deploy Beta 1` (2021-06-23) 70 points/5 comments; `Deno Deploy Beta 2` (2021-09-01) 165/99. Its best-performing item is not an announcement at all but a **live artifact**: `Deno Deploy Demo: a multi-datacenter chat, client+server in 23 lines of TS`, **186 points, 45 comments, 2021-11-06 16:50 UTC (Saturday)**, submitted by `@ondras` linking straight to `https://dash.deno.com/playground/mini-ws-chat` ([item 29131751](https://news.ycombinator.com/item?id=29131751)) — 2.7x the Beta 1 announcement.

### Heroku — predates the format

Heroku has no launch post in the modern sense; `Show HN` did not exist. The earliest indexed HN item is `Heroku Lifts Ruby on Rails Development into the Cloud (YC Winter 08)` (`@danielha`, 2008-02-07), **59 points, 35 comments**, linking to TechCrunch. The company's own best early posts were mechanism and philosophy pieces submitted by employees: `Heroku: Why Instant Deployment Matters (YC W08)` 83/17 (2009-02-23), `Heroku Architecture (Ruby in the cloud)` 73/27 (2009-03-04), `Heroku: Commercial Launch (YC W08)` 79/16 (2009-04-24).

Heroku's highest-scoring HN items are all negative and all much later: "Heroku's Ugly Secret: The story of how the cloud-king turned its back on Rails" 1763/423 (2013), "Removal of Heroku free product plans" 908/573 (2022), "Tell HN: Heroku deleted my database with no warning" 460/206 (2023), "An Update on Heroku" 525/352 (2026-02-06). This is the shape of the reputational tail the whole category inherits.

### Adjacent comparables worth having

Two PaaS launches outside the named list that bear directly on the reader's problem:

**`Launch HN: Porter (YC S20) – Open-source Heroku in your own cloud`** — 239 points, 74 comments, 2021-04-30, `@sungrokshim` ([item 26993421](https://news.ycombinator.com/item?id=26993421)). Same founder account as the second launch below, three years apart: 239 then 258. Repeat launching in this category neither compounds nor decays much.

**`Show HN: Porter Cloud – PaaS with an eject button`** — **258 points, 95 comments, 2024-05-23 16:47 UTC (Thursday)**, text post, no URL field ([item 40456959](https://news.ycombinator.com/item?id=40456959)). This is the clearest case in the set of a **closed-source PaaS escaping the "yet another PaaS" frame**, and it did it by leading with the objection instead of the product. The post says "Porter Cloud is a Platform as a Service (PaaS) like Heroku" in its first sentence — then immediately concedes the standard attack: "there's a downside: platforms like this become constraining … and **the platforms tend to try to keep you locked in!**" The mechanism is the differentiator and it's named in the title: an eject button, with a docs link. It also references their own prior HN launch by item ID.

It still drew the two standard objections. `@latchkey` (30 replies, most-replied): "I personally don't get it. **You can start on GCP today, without being tied to GCP much at all.** … Cloud Functions are just a http handler … Cloud SQL is just postgres. … you're pretty much dependency free and can move anywhere else if you need to." And `@mushufasa`: "**what's your business model?** The reason heroku never made it easy to migrate is the incentive you point out. What's yours?" It also drew the most valuable kind of comment a PaaS launch can get, an at-scale customer doing the arguing for them (`@hahahacorn`): "even at ~$18k/mo on Heroku spend we're now spending less than half with Porter."

**`Show HN: Canine – A Heroku alternative built on Kubernetes`** — 320 points, 123 comments, 2025-06-16 18:27 UTC (Monday), `https://github.com/czhu12/canine` ([item 44292103](https://news.ycombinator.com/item?id=44292103)). Discussion is almost entirely comparative — Dokku, k3s, Kamal, "K8s is rather easy to setup" — plus praise for the docs: "your docs on how K8s works look really good, and might be the most approachable docs I've seen on the subject."

---

## 2. Title patterns

Grouping every verbatim title collected, by structure rather than by product:

**(a) `Name – <category noun phrase>`.** Says what the thing *is*, in two to four words, using words the reader already owns.
`Neon – Serverless Postgres` (667) · `PlanetScale – Database for Developers` (279) · `Now: realtime Node.js deployments` (288) · `Show HN: Railway – Configless Software Infrastructure` (**11**)

The Railway outlier is the tell: "Configless Software Infrastructure" is category-shaped but the category doesn't exist, so the title conveys nothing. "Serverless Postgres" works because both words are already in the reader's head.

**(b) `Name – open source <X> alternative`.**
`Supabase (YC S20) – An open source Firebase alternative` (1120) · `Coolify: Open-source and self-hostable Heroku / Netlify / Vercel alternative` (382) · `Show HN: Appwrite – Open-Source and Self Hosted Firebase Alternative` (326) · `Show HN: Canine – A Heroku alternative built on Kubernetes` (320) · `Launch HN: Porter (YC S20) – Open-source Heroku in your own cloud` (239) · `Show HN: Nhost – Open source Firebase alternative with GraphQL` (210) · `Show HN: Coolify v2 – Open-source and self-hostable Heroku/Netlify alternative` (158) · `Open Source Alternative to Vercel, Netlify and Heroku` (47) · `Show HN: Appwrite Sites – the open-source vercel alternative` (44) · `Render – Heroku-like cloud hosting at a better price` (**2**)

**Range: 2 to 1120.** The framing is not a lever on its own — see §4.

**(c) `Name – <specific capability claim>`.** A falsifiable statement about what it does that the reader could not have guessed.
`Launch HN: Fly.io (YC W20) – Deploy app servers close to your users` (626) · `Show HN: Clerk – all of user management as-a-service, not just authentication` (582) · `Show HN: Porter Cloud – PaaS with an eject button` (258)

Two of these three define themselves by negation against the obvious assumption — "not just authentication," "with an eject button" — and the third is a plain verb phrase with a "where" in it.

**(d) Superlative with no content.**
`Render – The Easiest Cloud for All Your Apps` (**4**) · `Render Launches the Easiest Cloud` (**2**) · `Render · the Easiest Cloud for All Your Apps and Websites` (**4**) · `Show HN: Railway – A better way to build software. Period` (**14**)

**The four worst-performing titles in the entire set are the four that make an unfalsifiable superiority claim without saying what the product does.** Combined: 24 points, 0 comments. Both companies are now large and well-funded; the titles, not the products, are what failed.

**Does the tagline after the dash help?** Every title in the set above 200 points has one. But the dash is where the falsifiable claim lives, and a superlative in that slot is worse than nothing: compare `Neon – Serverless Postgres` (667) with `Render – The Easiest Cloud for All Your Apps` (4). Both are `Name – phrase`; one names a category, the other grades itself.

**Length is not the variable.** `Supabase (YC S20) – An open source Firebase alternative` is 52 characters and scored 1120. `Show HN: Railway – A better way to build software. Period` is 56 characters and scored 14.

---

## 3. Show HN vs. Launch HN vs. a blog link

Every launch-or-equivalent submission collected, grouped by prefix. Small samples — n=3 for `Launch HN` — so these are descriptive, not predictive.

| Form | n | Points: median | Points: mean | Comments/point (median) |
|---|---|---|---|---|
| `Launch HN:` (YC only) | 3 | 432 | 432 | 0.42 |
| `Show HN:` | 10 | 184 | 204 | 0.36 |
| Plain title / blog link / third-party | 17 | 186 | 265 | 0.33 |

`Launch HN` members: Fly.io 626/261, Resend 432/270, Porter 239/74.
`Show HN` members: Clerk 582/223, Appwrite 326/118, Canine 320/123, Porter Cloud 258/95, Nhost 210/69, Coolify v2 158/54, Fly 112/68, Appwrite Sites 44/22, Railway 14/5, Railway 11/7.
Plain/third-party members (n=17): Supabase 1120/366, Neon 667/330, Serverless Docker 595/228, Now 2.0 415/117, Coolify 382/180, CF Workers 327/132, Now 288/115, PlanetScale 279/128, Deno Deploy Demo 186/45, Convex vs Firebase 111/83, Deno Beta 1 70/5, Dokploy 47/28, Render ×4 (4/0, 4/0, 2/0, 2/0), Convex 7/0.

**What is actually true here:**

1. **`Launch HN` has the highest floor and no ceiling.** Its worst member (239) beats the median of both other groups. But it is only available to YC companies, and its three members are also the three most carefully written posts in the set — the prefix and the effort are confounded.
2. **The plain-title group has by far the widest variance** — it contains both the best result (1120) and every zero-comment failure. The tag is not what separates them; founder presence is (§5).
3. **Comment-to-point ratio tracks contention, not enthusiasm.** The highest ratio in the set is Resend's `Launch HN` at 0.63, and that thread is the most adversarial one documented here. Neon is 0.49 with a mostly-friendly thread but a long terminology fight. Supabase, the highest-scoring launch, has the *lowest* ratio of the big threads at 0.33 — 1120 points and comparatively little argument.
4. **Tone difference between forms is real but small and confounded.** `Launch HN` threads read as interrogations of the business (exit strategy, funding, longevity); `Show HN` threads read as interrogations of the artifact (install script, security headers, pricing table, "why not Dokku"). This is consistent with `Launch HN` foregrounding "(YC W23)" in the title and `Show HN` foregrounding a thing you can go look at.

---

## 4. The "alternative to X" framing

**Every instance in the set is listed in §2(b).** It spans 2 to 1120 points. The conclusion is not that the framing works or doesn't; it is that the framing is a *slot*, and what matters is what you put in it.

**Where it worked, it worked because the named incumbent was already resented.** In the Supabase thread, the top comments are not about Supabase — they are about Firebase: "Firebase is kind of the poster child for vendor lock in" (`@aswinmohanme`), "Firebase has no true competitor, let alone an open source one" (`@DigitalSea`). The launch borrowed an argument HN was already having. A Firebase employee showed up and *raised* the assessment rather than defending. Nhost (210) and Appwrite (326) used the identical Firebase framing at other times and landed 3–5x lower, so the framing alone is not what produced 1120.

**Where it backfired.** Three distinct failure modes, all documented above:

- **The named incumbent is loved, or the comparison invites a benchmark you lose.** Convex published `Convex vs. Firebase` as its most-visible HN artifact, and the most-discussed response quoted its own Firebase code sample back at it and answered with four lines of SQL (`@TekMol`). Inviting the comparison invited the audience to run it themselves and disagree.
- **The framing names *your own* fate.** Resend's post used its competitors' acquisitions as the reason to distrust them. HN turned it around within hours — "Your competitors have been acquired but you are funded by YC… so there is a high chance this will happen to you as well" — and that became the dominant business-level thread. The comparison you draw is the comparison you will be measured by.
- **The claim in the title is checkable and false.** Dokploy's `Open Source Alternative to Vercel, Netlify and Heroku` (47 points) drew `@maxloh` quoting the license's resale restriction: "it is not open source as advertised."

**Volume of named competitors does not help.** Coolify's third-party 2025 title named three (Heroku/Netlify/Vercel) and scored 382; the maintainer's 2022 title named two and scored 158; Dokploy named three and scored 47.

---

## 5. Open source at launch — and why the obvious reading of this data is wrong

Splitting the set by whether the product was open source at launch:

- **Open source, and the title said so** (n=9): 1120, 382, 326, 320, 239, 210, 158, 47, 44. Mean 316, median 239.
- **Open source, title silent**: Neon, 667 — Apache 2.0, confirmed by the CEO in-thread, not mentioned in the title.
- **No open-source claim made** — title silent, no repo submitted, no license stated by a founder in-thread; these are the products generally understood to be proprietary, but the label here means only "made no open-source claim at launch" (n=16, including the dead submissions): 626, 595, 582, 432, 327, 288, 279, 258, 112, 14, 11, 7, 4, 4, 2, 2. Mean 221, median 185.

That looks like a 95-point mean advantage for open source. **It is an artifact of selection and should not be reported as an effect.** Six of the sixteen closed-source entries are Render's four dead-drop submissions and Railway's two abandoned Show HNs — submissions with no founder comment, no context, and a bare homepage link. They failed for reasons that have nothing to do with licensing.

Condition on the founder actually showing up in the thread, and the gap disappears:

- **No open-source claim, founder present in thread** (n=11): 626, 595, 582, 432, 327, 288, 279, 258, 112, 14, 11. **Mean 320, median 288.**
- **Open source, title said so** (n=9): **Mean 316, median 239.**

**Within this sample, once you control for whether the company participated, open-source-at-launch and closed-source-at-launch are indistinguishable by points.** The four highest-scoring *founder-run* launches in the whole set — Fly.io 626, Serverless Docker 595, Clerk 582, Resend 432 — are all closed source. n is 20; this is a description of twenty threads, not a law.

**What open source did change is the content of the objections, not their volume.** Closed-source launches got trust and lock-in questions aimed at the company ("why would I trust a new company?", "is it yet another example of vendor lock-in? Yes", "what's your exit plan?"). Open-source launches got them aimed at the project's survival and the operator's labour ("I've seen Flynn EOL … I've seen Dokku lose steam", "how do you finance the development?", "I would choose Heroku or Netlify because I don't want to self host it"). Neither audience skips the question.

---

## 6. What HN attacks in this category, in order of how reliably it appears

Every objection below appeared in at least three separate threads. Quotes are verbatim.

**1. Will you exist in three years.** The single most reliable objection, and in two threads it was the most-replied comment.
- Fly.io, `@yingw787`: "I'm afraid of committing to a solution that might not be around long-term … I'd rather get locked into AWS proper rather than a service that might be built on top of AWS."
- Clerk, `@faeyanpiraat`: "I'm even hesitant to trust Auth0 for this, why would I trust a new company?"
- Resend, `@pelcg`: "What is your exit strategy other than an acquisition?"
- Coolify, `@mdasen`: "I've seen Flynn EOL. I've seen Docker Swarm's future be a bit hazy. I've seen Porter decide to put pretty restrictive limits on their free tier."
- Neon: pre-empted unprompted by the CEO — "We are committed to building a durable company and we are well funded. So yes, you will hear from us for years to come."

**2. Why not just use X.** X is whatever the commenter already runs.
- Now, `@seibelj`: "Red Hat Openshift has a solid free tier, free SSL, git push deployments … Why would I use this over that?"
- Fly.io, `@Thaxll`: "What problem does it solve? Because latency is currently not an issue with all the regions from current cloud providers … It looks more like: workers.cloudflare.com"
- Porter Cloud, `@latchkey`: "You can start on GCP today, without being tied to GCP much at all. … Cloud SQL is just postgres."
- Coolify, `@pier25`: "if I wanted to run/deploy apps on my own VPS I'd just use Kamal or Dokku."
- Railway, `@replwoacause`: "I'll suffer more manual work on hetzner to save a little $$$."

**3. Price, computed on the spot.** Someone always does the arithmetic.
- Fly 2017, `@Xorlev`: "$0.05/1000 requests is really really premium. 1000 request/s is $0.05/s. 86400s/day * 30 days * $0.05 -> $129.6K/30d."
- Clerk, `@rexreed`: "so if you have 5,001 MAU you take a big leap from $0 to $249/mo. Is there a reason for that huge bump?"
- Railway, `@gsemyong`: "the 10-10000x price difference in comparison to hetzner+coolify."
- Porter Cloud, `@davedx`: "the pricing seems high - $30/month minimum? I'm running 3 apps on Fly.io and I'm still so low in the pricing that they're invoicing me $0."

**4. Lock-in and "is it open source."** Asked even of products that never claimed to be.
- PlanetScale, `@jaredcwhite`: "Can I install this locally? … Is it fully open source? From what I can tell, the answer to all three questions is no. Is it yet another example of vendor lock-in? Yes." — **unanswered by the founder in-thread.**
- Clerk, `@jerrac`: "I'd be very reluctant to use a proprietary service … Why isn't there an Open Source, standardized, self-hosted, version of this kind of service?"

**5. "This is just a wrapper around X."**
- PlanetScale, `@cfors`: "So is this a wrapper around managing Schemas powered by Vitesse? (Btw, had to go to your github to figure that out)"
- Resend, `@paxys`: "I'm supposed to use your custom React components … which you will promptly compile down to the tags I mentioned above. So...what value am I getting out of React at all?"

**6. A claim in the pitch is checked and found false.**
- Resend, `@iamacyborg` on the observability claim: "I can't think of a single email platform I've used … for a decade that didn't expose a full event stream for all emails."
- Dokploy, `@maxloh` on the open-source claim: "it is not open source as advertised."
- Neon, `@peterkelly` on "serverless": "Please stop this abuse of language."

**7. Friction and defects found by people actually using it during the launch window.**
- Coolify, `@moondev`: the install script overwriting `daemon.json`, plus "After launch I was then greeted with a login/registration page. Seems kind of backwards … Too much friction to try this out."
- Clerk, `@SahAssar`: securityheaders.com scan results, plus third-party CDN JS without SRI on the login page.
- Resend, `@joshmanders`: a tab-visibility handler resetting his position — "There is absolutely ZERO reason for this functionality."

**8. "I can't tell what this is."** Cheap to avoid and expensive to trigger.
- Now, `@mmaunder`: "Had to read three pages and still haven't quite confirmed that this is node.js hosting. … You literally just stole some of my life."
- PlanetScale, `@unknown_error`: "the linked blog post is both very abstract and assumes a high level of preexisting knowledge."
- Dokploy, `@diggan`: "'Managed Hosting: No need to manage your own servers' / '1 Servers (You bring the servers)' — Hmm, am I out of touch…"

Notably absent from the deploy-platform threads: nobody in this set attacked a launch for being "just a wrapper around AWS" *in those words*. The nearest thing is `@yingw787` on Fly.io ("a service that might be built on top of AWS") and `@latchkey` on Porter Cloud. The wrapper attack in this category lands on the *abstraction* (Vitess, React), not on the underlying cloud.

---

## 7. Timing

Day and hour in UTC for every launch above 100 points, sorted by score:

| Points | Day | Time (UTC) | Launch |
|---|---|---|---|
| 1120 | **Wed** | 06:13 | Supabase |
| 667 | **Sat** | 01:37 | Neon |
| 626 | Wed | 14:15 | Fly.io |
| 595 | Tue | 16:47 | Serverless Docker |
| 582 | Mon | 20:25 | Clerk |
| 432 | Tue | 12:16 | Resend |
| 415 | Thu | 16:38 | Now 2.0 |
| 382 | Wed | 12:41 | Coolify (3rd party) |
| 327 | Fri | 13:11 | Cloudflare Workers |
| 326 | Tue | 17:37 | Appwrite |
| 320 | Mon | 18:27 | Canine |
| 288 | Wed | 17:26 | Now |
| 279 | Tue | 17:16 | PlanetScale |
| 258 | Thu | 16:47 | Porter Cloud |
| 210 | Thu | 12:26 | Nhost |
| 186 | Sat | 16:50 | Deno Deploy Demo |
| 158 | Wed | 13:27 | Coolify v2 |
| 112 | Wed | 13:24 | Fly (2017) |

And the failures: Railway 11 pts Wed 16:53, Railway 14 pts Thu 20:25, Render 4 pts Thu 21:06, Render 2 pts Wed 18:16.

**n=22 across ten years. This sample cannot support a conclusion about timing, and the data actively argues against the folk advice.** The two highest-scoring launches in the set went up at the two worst-looking times — 06:13 UTC on a Wednesday (2:13am US Eastern) and 01:37 UTC on a Saturday. Railway's 11-point Show HN went up Wednesday 16:53 UTC, inside the same hour as Zeit's `Now` (288) at 17:26 and PlanetScale (279) at 17:16 on a Tuesday. Same slot, two orders of magnitude apart in outcome.

Weekday distribution above 100 points: Wed ×6, Tue ×4, Thu ×4, Mon ×2, Sat ×2, Fri ×1. That is roughly what you would get from posting whenever, weighted by the fact that people post on weekdays.

---

## 8. What a strong founder first comment looks like

Founder participation, measured exactly, as (founder's comments / total comments in thread):

| Launch | Founder comments / total | Points |
|---|---|---|
| Fly.io (`@mrkurt`) | **51 / 253** | 626 |
| Supabase (`@kiwicopple`) | **58 / 366** | 1120 |
| Neon (`@nikita`) | **44 / 322** | 667 |
| Cloudflare Workers (`@kentonv`) | **38 / 132** | 327 |
| Resend (`@zenorocha`) | 35 / 270 | 432 |
| Coolify v2 (`@andrasbacsai`) | 17 / 54 | 158 |
| Appwrite (`@eldad_fux`) | 17 / 118 | 326 |
| Now 2.0 (`@Rauchg`) | 17 / 117 | 415 |
| Nhost (`@elitan`) | 14 / 69 | 210 |
| Clerk (`@colinclerk`) | 13 / 223 | 582 |
| Now (`@Rauchg`) | 11 / 115 | 288 |
| PlanetScale (`@samlambert`) | 6 / 128 | 279 |
| Convex vs Firebase (`@alexcole`) | 4 / 83 | 111 |
| Coolify 2025 (`@andrasbacsai`) | 1 / 174 | 382 |
| Railway 2021 (`@justjake`) | **1 / 7** | 11 |
| Railway 2024 (`@justjake`) | **1 / 5** | 14 |
| Dokploy (`@Siumauricio`) | **0 / 28** | 47 |
| Render ×4 | **0 / 0** | 4, 2, 4, 2 |

Two shapes of opening comment both work, and they are almost opposites:

**The long one, and Fly.io is the model.** Its ordering, which is reproducible: *who we are (all founders, by name) → the specific job that produced the problem → the problem stated physically → the mechanism, named down to the component level → evidence someone pays → time-to-value with a link → a competitor-relative number → objections we already know you'll raise, and what we did about them → two odd customer stories.* Resend's post follows the same skeleton and is well-executed; it drew more fire because two of its slots (competitor-naming, the observability claim) contained checkable assertions that HN checked.

**The short one, and Supabase is the model.** Two sentences: role, availability, current state ("We're currently in alpha"), and a concession framed as a gift ("to reward you for your patience we are completely free right now"). This works only when the *title* has already done the positioning, and only when the founder then treats the thread as the actual product surface — 58 comments in Copplestone's case, more than any other founder here.

**The credential shortcut.** `@kentonv`'s three-line comment buys trust with a citation instead of an argument: "(You may remember me as the tech lead of Sandstorm.io and Cap'n Proto.)" This is the only instance in the set of a founder-equivalent establishing legitimacy by prior work in the first comment, and it prefaces the most laudatory thread documented here.

**What does not work, from the negative cases:** posting a bare homepage link with no comment at all (Render, four times, zero comments); posting one comment and leaving (Railway, twice); answering technical questions in one-word affirmatives while leaving the lock-in question unanswered (PlanetScale — "Yes!", "Yes absolutely!", and silence on `@jaredcwhite`).

---

## 9. Called out specifically for the reader

### How "yet another PaaS" launches were received, and which escaped it

Four PaaS-shaped launches cleared 250 points in this set. **None of them led with being a PaaS.**

- **Fly.io (626)** led with a *place*: "Deploy app servers close to your users." The category word never appears in the title.
- **Canine (320)** led with an *implementation choice* that is itself an argument: "A Heroku alternative built on Kubernetes." The thread is a Kubernetes debate, not a PaaS debate.
- **Porter Cloud (258)** led with the *exit*: "PaaS with an eject button." It uses the category word, then immediately negates the category's main liability. The post's first paragraph concedes the objection before anyone can make it.
- **Porter (239)** led with *where it runs*: "Open-source Heroku in your own cloud."

The ones that did not escape it are the ones that described themselves in category terms and asked to be graded: `Render – The Easiest Cloud for All Your Apps` (4), `Show HN: Railway – A better way to build software. Period` (14), `Show HN: Railway – Configless Software Infrastructure` (11). Combined across those three: 29 points, 12 comments.

The mechanism visible in the successful four is that each title contains **one falsifiable, non-obvious noun** — close to users, Kubernetes, eject button, your own cloud — that gives the thread something to argue about other than "is another PaaS necessary." The 47-point Dokploy title contains three brand names and no such noun; the top comment is about pricing-page confusion.

### Did any launch lead with a demo you could try without signing up

**In this set, no deploy-platform launch did.** Fly.io's Launch HN linked to `/docs/speedrun/`, which requires an account. Railway, Render, Porter, Porter Cloud, Coolify and Dokploy all linked to a homepage, a repo, or a text post. This is a genuine gap in the sample, not a finding that it doesn't work.

**The adjacent evidence that it works is strong but comes from non-launch posts:**

- `Deno Deploy Demo: a multi-datacenter chat, client+server in 23 lines of TS` — **186 points**, submitted as a direct link to a live playground URL (`dash.deno.com/playground/mini-ws-chat`), 2.7x Deno Deploy's own `Beta 1` announcement (70 points) five months earlier.
- Cloudflare Workers' launch blog post shipped with a sandbox, and the highest-praise comment in this entire research set singles that out: "It provides clear examples of how to use the new feature **with a link to a sandbox so you can run and modify the examples**" (`@js2`). A commenter, `@gok`, reports having tried WebAssembly *in* the playground during the thread — the demo was the discussion surface.
- Supabase's two highest-scoring HN posts of all time are not launches or features but **things you run in a browser tab**: `Postgres WASM` (887/185) and `Postgres.new: In-browser Postgres with an AI interface` (366/106). Both beat their own 1120-point launch on comments-per-point engagement in the technical register.

The one adjacent data point on the *other* side is worth having: in the Coolify Show HN, requiring registration before you can look at anything was the top-replied complaint — "Seems kind of backwards to require this when you are targeting the self-host crowd. **Too much friction to try this out.**"

### Closed-source infra launches versus open ones

Covered quantitatively in §5: within this sample, once founder participation is controlled for, the two groups are indistinguishable by points (closed mean 320 / median 288, n=11; open mean 316 / median 239, n=9). The four highest-scoring founder-run launches in the set are all closed source.

What differs is the *shape* of the interrogation, and a closed-source launch should expect all four of these, since each appeared in multiple closed-source threads and in none of the open ones in the same form:

1. **The trust question, asked as a question about the company rather than the code.** "why would I trust a new company?" (Clerk, top-replied). "I'm afraid of committing to a solution that might not be around long-term" (Fly.io, top-replied).
2. **The exit question.** "What is your exit strategy other than an acquisition?" (Resend). Asked of Fly.io too, and Kurt's answer — "I'd rather just work on this forever than get absorbed by a big company" — immediately drew "How do your investors feel about this?"
3. **The open-source question, asked whether or not you invited it,** and read as an admission if unanswered (PlanetScale).
4. **Scrutiny of your own surfaces as a proxy for engineering quality** — security headers, CDN scripts without SRI, UX defects filed live during the thread (Clerk, Resend).

Two closed-source responses in this set defused the first two rather than absorbing them. Neon's CEO stated funding and durability unprompted in his own reply chain. Porter Cloud put the lock-in concession in the opening paragraph of the post and the remedy in the title.

---

## Appendix: complete index of items cited

All at `https://news.ycombinator.com/item?id=<id>`.

| id | Points | Comments | Date (UTC) | Author | Verbatim title |
|---|---|---|---|---|---|
| 23319901 | 1120 | 366 | 2020-05-27 | vira28 | Supabase (YC S20) – An open source Firebase alternative |
| 31536827 | 667 | 330 | 2022-05-28 | nikolay | Neon – Serverless Postgres |
| 22616857 | 626 | 261 | 2020-03-18 | mrkurt | Launch HN: Fly.io (YC W20) – Deploy app servers close to your users |
| 17759516 | 595 | 228 | 2018-08-14 | Rauchg | Serverless Docker Beta |
| 26069621 | 582 | 223 | 2021-02-08 | colinclerk | Show HN: Clerk – all of user management as-a-service, not just authentication |
| 36309120 | 432 | 270 | 2023-06-13 | zenorocha | Launch HN: Resend (YC W23) – Email API for developers using React |
| 18407503 | 415 | 117 | 2018-11-08 | Rauchg | Now 2.0 |
| 43555996 | 382 | 180 | 2025-04-02 | vanschelven | Coolify: Open-source and self-hostable Heroku / Netlify / Vercel alternative |
| 15364896 | 327 | 132 | 2017-09-29 | thomseddon | Cloudflare Workers: Run JavaScript Service Workers at the Edge |
| 30769044 | 326 | 118 | 2022-03-22 | christyjacob4 | Show HN: Appwrite – Open-Source and Self Hosted Firebase Alternative |
| 44292103 | 320 | 123 | 2025-06-16 | czhu12 | Show HN: Canine – A Heroku alternative built on Kubernetes |
| 11440224 | 288 | 115 | 2016-04-06 | hswolff | Now: realtime Node.js deployments |
| 27197873 | 279 | 128 | 2021-05-18 | samlambert | PlanetScale – Database for Developers |
| 40456959 | 258 | 95 | 2024-05-23 | sungrokshim | Show HN: Porter Cloud – PaaS with an eject button |
| 26993421 | 239 | 74 | 2021-04-30 | sungrokshim | Launch HN: Porter (YC S20) – Open-source Heroku in your own cloud |
| 25289233 | 217 | 50 | 2020-12-03 | kiwicopple | Supabase Beta: Auth, SQL Editor, Benchmarks |
| 24929732 | 210 | 69 | 2020-10-29 | elitan | Show HN: Nhost – Open source Firebase alternative with GraphQL |
| 29131751 | 186 | 45 | 2021-11-06 | ondras | Deno Deploy Demo: a multi-datacenter chat, client+server in 23 lines of TS |
| 30854912 | 158 | 54 | 2022-03-30 | andrasbacsai | Show HN: Coolify v2 – Open-source and self-hostable Heroku/Netlify alternative |
| 30779909 | 141 | 120 | 2022-03-23 | MikeFaber | Render: a Zero DevOps Cloud Platform |
| 13985940 | 112 | 68 | 2017-03-29 | mrkurt | Show HN: Fly – A global load balancer with middleware |
| 31831623 | 111 | 83 | 2022-06-22 | alexcole | Convex vs. Firebase |
| 27602808 | 70 | 5 | 2021-06-23 | 0xedb | Deno Deploy Beta 1 |
| 111271 | 59 | 35 | 2008-02-07 | danielha | Heroku Lifts Ruby on Rails Development into the Cloud (YC Winter 08) |
| 42778472 | 47 | 28 | 2025-01-21 | thushanfernando | Open Source Alternative to Vercel, Netlify and Heroku |
| 44029057 | 44 | 22 | 2025-05-19 | eldad_fux | Show HN: Appwrite Sites – the open-source vercel alternative |
| 26621028 | 22 | 1 | 2021-03-29 | timqian | Deno Deploy |
| 42140800 | 14 | 5 | 2024-11-14 | justjake | Show HN: Railway – A better way to build software. Period |
| 28696391 | 11 | 7 | 2021-09-29 | justjake | Show HN: Railway – Configless Software Infrastructure |
| 29089591 | 7 | 0 | 2021-11-03 | stevekrouse | Convex – the reactive back end for your reactive apps |
| 43260190 | 6 | 2 | 2025-03-04 | justjake | Show HN: Railpack – Zero-Config Dockerimage Builds |
| 19752502 | 4 | 0 | 2019-04-25 | tuacker | Render – The Easiest Cloud for All Your Apps |
| 20722057 | 4 | 0 | 2019-08-17 | gleb | Render · the Easiest Cloud for All Your Apps and Websites |
| 19755083 | 2 | 0 | 2019-04-26 | amenod | Render Launches the Easiest Cloud |
| 19983888 | 2 | 0 | 2019-05-22 | simplify | Render – Heroku-like cloud hosting at a better price |
| 33067962 | 887 | 185 | 2022-10-03 | kiwicopple | Postgres WASM |
| 41224286 | 366 | 106 | 2024-08-12 | kiwicopple | Postgres.new: In-browser Postgres with an AI interface |

Non-HN primary source: [supabase.com/blog/alpha-launch-postmortem](https://supabase.com/blog/alpha-launch-postmortem), Paul Copplestone, 10 Jul 2020 — origin of the Supabase launch post, launch-week traffic and signup numbers, and the infrastructure failures during it.
