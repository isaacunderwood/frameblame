# Later

Everything deliberately deferred during design, with the reasoning and what would justify
picking it up. Nothing here is a backlog commitment — it is a record so the thinking isn't
redone from scratch.

Ordered roughly by how soon it earns its place.

## Soon after the spike

**The aggregate view.** One card per interaction is what makes someone say "oh my god" on
first run; a ranked leaderboard across a session ("worst offenders: `OrderTable` 68%,
`useCartTotals` 19%, non-React 13%") is what keeps the tool open on day 30. The first is the
demo, the second is the product.

**Categorising every slice of the frame.** Split all blocking work by origin: first-party code
resolved to file and line, third-party scripts named by vendor, browser-side costs like forced
layout, and an explicit *unattributed* remainder. The vendor naming is nearly free — the
`third-party-web` dataset that Lighthouse uses maps script URLs to entity names.

This changes the tool's character from "a React profiler" to "a complete account of where the
frame's time went," and it guards against the likeliest bad first impression: a user tries it
on a real app where the top cause is their consent manager. Showing the unattributed slice
rather than hiding it is what makes the rest of the numbers believable.

**Highlight-in-place.** A toggle that draws on the DOM, React-Scan style: the culprit component
lights up on the page. Cheap once fiber identity is working, and it is the thing that makes a
GIF. A toggle rather than the default, because a good share of findings aren't on screen.

**The rest of the fixture corpus.** Five fixtures is a harness to develop against; the full set
is what makes the accuracy table in the README possible — "correctly identifies the dominant
cause in 47/52 scenarios, here are the 5 it can't and why." No competing tool publishes
anything like it, because none would survive it.

**Property-based fixture generation.** Generate component trees with injected delays and assert
the engine finds them. Hand-written fixtures are too clean to exercise the ambiguous-frame
case, which is exactly where the confidence model either works or embarrasses itself. Generate
frames containing two simultaneous causes and check that confidence degrades rather than
guesses.

## Second shell: CI

**A CDP-driven CLI.** The tool launches Chrome, navigates, injects the agent, throttles the
CPU. Works against any URL including a local production build with source maps on disk, and no
extension plumbing.

**A Playwright reporter.** Instrument e2e tests the team already has: every test already clicks
through real flows, so interaction coverage comes free and there's a CI gate on day one —
"checkout's INP went from 180ms to 410ms in this PR, caused by `CartSummary`." The reason to
prefer this over a bespoke interaction DSL is that nobody maintains a second, parallel set of
flows next to their e2e tests.

The CLI is the reporter's plumbing in disguise, so building it first is shared work rather than
parallel work.

## Prod-grade attribution

**A Vite build-time annotation plugin.** Stamp each component with its real name and source
location before minification, so production attribution needs no source maps and never guesses.
The only approach where prod attribution equals dev.

Deferred because it asks the user to change their build, and because the source-map fallback
chain covers the main local-prod-build case. Pick it up when someone wants prod-grade
attribution in CI — or when the field adapter starts, since real users' browsers obviously
can't read source maps off your laptop. It is the track that story runs on.

**webpack and Rspack plugins.** "Vite supported, webpack PRs welcome" is a respectable v1
position. Shipping four bundler integrations before having users is how side projects become
unpaid maintenance.

## Breadth

**Non-React adapters** — Vue's devtools hook, Svelte, Angular. The adapter seam exists from the
start (it's needed for the degradation tiers regardless), so this is additive rather than a
refactor. Worth courting as outside contributions; being excellent in one framework beats being
mediocre in four.

**An MCP server.** Cheap once the engine exists — "profile this interaction and tell me what to
fix" is a few hundred lines on top — and it's the version where an agent closes the loop and
fixes the component it just blamed. Worth pitching prominently and building last.

## The field half

**A bring-your-own-backend adapter.** A tiny client collector shipping LoAF attribution from
real users into a store the user owns — OTel, Sentry, ClickHouse, an endpoint. This is where the
truth lives: real devices, real data, real p75.

Deliberately last, and deliberately not a hosted service. Owning a data pipeline, a dashboard,
and other people's user data for free is how side projects die. Keeping this unbuilt is also
what preserves the open-core option (below) at zero cost.

Two things found during research that bear on it:

- **No standard beacon schema for LoAF script attribution exists.** OpenTelemetry's client-side
  semantic conventions agreed in November 2026 on a small INP attribute set — interaction
  target, type, input delay, processing duration, presentation duration — and left the full
  attribution object as an unmodelled JSON blob in the log body. They deferred structuring it
  rather than rejecting it. Proposing a schema is an unusually cheap way to become the reference
  implementation for a thing that has none.
- **Cloudflare's free-tier beacon already computes the attribution and discards it.** Their
  script runs the full web-vitals attribution build and then ships five values. The data is
  sitting in the browser; only the wire format stops it. Suggestive of how much latent appetite
  there is here.

**Rust, for this and only this.** Resolving source maps across millions of beacons server-side
is genuinely compute-bound, unlike anything in the client. Worth revisiting if the field half
happens; wrong everywhere else in this project.

## Considered and rejected

**A browser extension.** The motivating demo is "profile any site, including ones you don't
own" — and that is exactly where attribution collapses, because there are no source maps and
fiber types are minified to single letters. Your headline claim degrades from "`OrderTable` at
line 112" to "something in `vendor-a3f.js`". Most work, least differentiation, flagship scenario
undercuts the core claim.

If the "I profiled 10 real sites" post is the appeal, do it with the CLI against sites that
publish source maps and write up the degradation honestly. That post is more interesting than
the extension.

**A flame-chart timeline UI.** Most informative, most work, and it competes directly with
Chrome DevTools' Performance panel — a fight won only on "mine says which component." "DevTools
but worse, with one good column" is the wrong frame.

**Instrumenting React directly.** Patching the scheduler, or requiring users to swap in a
profiling build, gives first-party render spans instead of inferred ones. Rejected because the
profiling build has different performance characteristics — you'd be measuring a different app
than the one they ship — and because patching internals is a maintenance sentence rather than a
contribution. Keep it on the shelf, unused, in case real-world testing shows the join is
ambiguous more often than it is useful.

**A protective license** (BSL / FSL). Stops a RUM vendor shipping the engine inside their agent,
and materially suppresses adoption, because platform teams won't take a non-OSI licence on a
dev dependency without a legal review nobody wants to run. A vendor adopting the attribution
engine is a career-defining line, not a theft.

## Open options, costing nothing to hold

**Open core.** Engine and overlay MIT; the field collection, aggregation and dashboard as a
possible commercial product. This requires no company and no licence change — only not
accidentally giving away the one part anyone would pay for. The sequencing above preserves it
for free, since the field half is last anyway.

**The corpus as its own release.** Publish "React apps that jank in known ways, with ground
truth" standalone. Independently useful to everyone working this problem, including the Chrome
team and the RUM vendors, and it's a second launch for work already done.

**The write-up.** The strongest version of the story is not "we resolve LoAF character offsets,
which vendors haven't bothered to do" — true, valuable, and reproducible by any vendor in a
sprint once they notice. It is "we join the browser's two performance APIs and attribute the
result to a component," which both Sentry and Datadog have the parts for and have not
assembled.
