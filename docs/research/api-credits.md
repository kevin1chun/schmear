# Plan-bundled API credits (researched 2026-11-21)

Read-only web research. Official pages were fetched through a summarizing fetcher, so quotes are short and
may differ by a word from the page; third-party and X posts are marked. Programs are new (Claude: 2026-10-07,
OpenAI: reported 2026-10-28, Google Cloud credits: Jan 2026, claim-in-AI-Studio: Nov 2026), so re-check amounts
before hard-coding.

## Verdict on the premise

| Vendor | Plan includes API credits? |
|---|---|
| Anthropic | Yes on Max ($100), Ultra ($200), Team (pooled, up to $500). **Not Pro.** |
| Google | Yes: Google Cloud credits via Developer Program on AI Pro ($10), Ultra 5x ($40), Ultra 20x ($100). |
| OpenAI | Yes on Pro ($100/$200/$500 by tier) and Business ($20/$100 per seat). **Not Plus.** |
| xAI | **No** per current official docs. A $50/month SuperGrok Heavy credit existed in Aug 2025 and is reported removed (X posts only). |

## Per-vendor table

| | Anthropic (Max / Ultra / Team) | Google (AI Pro / Ultra) | OpenAI (Pro / Business) | xAI (SuperGrok / Heavy) |
|---|---|---|---|---|
| **Included?** | Yes, Max/Ultra/Team. Pro, Free, Enterprise excluded. | Yes, "Google Cloud credits" through Google Developer Program. AI Plus: none. | Yes, Pro and Business. Plus, Enterprise, Edu excluded. | No. |
| **Amount / cadence** | Max $100, Ultra $200 per billing cycle (monthly on annual plans). Team $20 per Standard seat, $100 per Premium seat, pooled, cap $500. Needs 7 days on plan. | Pro $10, Ultra 5x $40, Ultra 20x $100 per month. Cadence = monthly anniversary of first claim, not billing date. | Pro $100/$200/$500 matching tier, per billing period. Business $20 Standard / $100 Premium per seat, pool cap $500/month. First grant prorated. Needs 7 days on plan. | n/a |
| **Expiry** | End of each billing cycle, no rollover. | One year after grant, grants stack, earliest-expiring spent first. | End of billing cycle, no rollover (annual Business: end of year). | n/a |
| **Spendable on** | Claude API (Messages, Batches), Managed Agents, Agent SDK, Console playground. **Not** Claude Code interactive, extra usage, Bedrock/Vertex/Foundry. | Google Cloud and Maps Platform products incl. Gemini API, AI Studio, Firebase, Agent Platform (Vertex). Standard promo exclusions apply. Not named: Antigravity, Gemini CLI. | Paid API Platform usage of the linked org (Responses, Chat Completions, Realtime, Images, built-in tools). **Not** Codex via API key. Does not raise ChatGPT/Codex plan limits. | n/a |
| **Activation** | Opt-in. claude.ai Settings > Billing > API credits > link a Console org, accept terms. Subscriber must be Admin/Billing in the Console org. One org per plan, one plan per org, cannot self-change. | Opt-in. Claim in AI Studio (creates Developer Program profile) or on the Developer Program Benefits page; pick a billing account; tick "Always use this billing account" for auto-apply. Primary subscriber only, no family sharing. Gemini API use needs **$5 minimum prepay**. | Opt-in. ChatGPT Settings > Billing (or Admin Console / API Platform billing), pick API org, confirm. Same email on both accounts; must own subscription and API org. One link each way. | n/a |
| **Balance read** | Console Billing page "Promotional credits" (amount + expiry). **No documented API.** Admin API cost report gives spend only, needs admin key, not for individual accounts. CodexBar's `prepaid/credits` is claude.ai extra-usage credits, a different pool. | AI Studio Billing "Available credits" card; Benefits page. **No API**: Cloud Billing API lists accounts/projects/SKUs, no credits resource. | API Platform billing > Credit grants (UI). **No official balance API.** Detect exhaustion by HTTP 429 `credit_balance_exhausted`. | n/a. Console shows prepaid API credits; Management API (`management-api.x.ai`, management key) is said to cover "prepaid credit balances" but the path was not confirmed. |
| **Reset date** | Billing-cycle date of the plan (not exposed by an API; claude.ai usage endpoints do not return it). Note Console spend caps reset on the 1st of the calendar month, credits do not. | Monthly anniversary of first claim; per-grant expiry 12 months. | Subscription renewal date. | n/a |
| **When credits run out** | API requests stop until next grant; "never charged to your Claude plan". Falls to purchased credits if any; auto-reload (card) only if the user enabled it, and it keys off purchased balance only. Error: "credit balance is too low". | Prepay account: HTTP 402, all keys on the billing account stop, until funds added. Card charged only by auto-reload (prepay) or if on postpay. The $5+ prepaid is real money and credits are consumed before it. | 429 `credit_balance_exhausted`. Continues on purchased credits; Auto Recharge (card) only if enabled. No API payment method needed while a grant is active. | Prepaid API credits: requests rejected at zero unless monthly invoiced billing is enabled (then card at month end). |
| **How an agent spends it** | `ANTHROPIC_API_KEY` from the linked Console org with **Agent SDK / `claude -p`** (and so claude-agent-acp, which wraps the SDK). In `-p` the key is always used; interactive Claude Code asks once to approve it but is excluded from coverage. `CLAUDE_CODE_USE_VERTEX` is excluded. Signed-in (OAuth) `-p`/SDK uses plan limits, not credits. | Gemini CLI with `GEMINI_API_KEY` from AI Studio (billing = key's billing account), or Vertex AI with a project on the credited billing account. Gemini CLI "Login with Google" and Antigravity (`agy`, no BYOK) use the plan, not these credits. Whether Claude-on-Vertex is credit-eligible: not verified. | A non-Codex harness calling the OpenAI API with a key from the linked org. **Codex CLI with an API key is explicitly unsupported by the benefit** and bills standard API rates. Codex signed in with ChatGPT uses plan limits. | n/a. Grok Build signed in uses the weekly SuperGrok pool; an API key bills the Console account. |

## Details and caveats by vendor

### Anthropic

- Official table: "Max: $100, Ultra: $200, up to $500 (Team, pooled)". Refresh: "Each billing cycle (or monthly for annual plans)".
  Expiry: "End of each billing cycle... with no rollover." (platform docs).
- Not Pro. $100 on a top plan matches Max. Third-party posts map Max to 5x and Ultra to 20x; the official page uses Max/Ultra only.
- Coverage subtlety: the Help Center says credits cover `claude -p` and the Agent SDK "when you run them yourself with an API key"
  from the linked org, and exclude "Interactive Claude Code in the terminal, IDE, desktop, or web" and runs from the GitHub Action,
  IDE extensions, or desktop app. The docs also show Claude Code printing "Credit balance too low" for an org holding only these credits,
  so exclusion is enforced server-side by request type, not by which key is used. Untested here: whether claude-agent-acp requests
  classify as Agent SDK. Verify with one real run before relying on it.
- Ranking: `ANTHROPIC_API_KEY` outranks subscription OAuth in Claude Code; with `-p` it is "always used when present". An exported
  key therefore silently moves a subscription run onto credits (and onto the card if the org has auto-reload).
- Sharing: every key and workspace in the linked org draws one balance; cap a project with a workspace spend limit.
- A separate June 2026 monthly Agent SDK credit existed; the FAQ now says "That credit isn't available." Do not count it.
- Balance probing: no official endpoint found. Practical options: user-entered grant and cycle date, minus spend measured from SDK
  result cost fields or the Admin cost report, reconciled when the "credit balance is too low" error appears.

### Google

- Official benefits FAQ: Pro $10, Ultra 5x $40, Ultra 20x $100 monthly; each credit expires "one year after the date they are granted".
  Eligible: "any eligible Google Cloud or Google Maps Platform product". Balance: "active credits at any time" on the Benefits page.
- AI Studio billing doc: promotional credits need funds first ("you must add funds... before you can use promotional Cloud Credits"),
  $5 minimum prepay, prepaid expires in 12 months and is generally non-refundable, zero balance stops all keys with HTTP 402. AI Studio's
  announcement says credits apply after the AI Studio subscription quota is exhausted and the earliest-expiring credits go first.
- Gemini CLI docs list three auth modes: Login with Google (billing tied to account/subscription), Gemini API key (tied to the key), Vertex AI
  (tied to the Cloud project). The same page says Antigravity CLI replaced Gemini CLI for unpaid and Google One users on 2026-06-18, so for
  AI Pro/Ultra the credit-drawing path is Gemini CLI or any client with an API key or Vertex, not `agy`.
- Different pool, do not conflate: Google One "AI credits" (purchased; used for Antigravity/Flow overage via the Never/Always toggle).
  Google's help page lists no monthly Antigravity grant; forum reports conflict and are unverified. Antigravity does not support BYOK.
- Balance probing: no programmatic read. Developer Program Benefits and AI Studio Billing pages are UI only. Spend caps in AI Studio are
  marked experimental with about 10 minutes of latency.

### OpenAI

- Pricing page: Plus "No" for monthly API credits; Pro tiers 100/200/500; "Unused credits expire at the end of the applicable billing cycle."
- Help article: Pro $100/$200/$500, Business $20 per Standard and $100 per Premium seat, pooled cap $500/month ($6,000 per annual cycle).
  Renewal grants are automatic after the first link. Unlinking "immediately revokes unused promotional credits".
- Dev guide: "Codex usage through API keys is not supported by this benefit." Codex auth page: API-key usage is billed "at standard API rates"
  and does not use included plan credits. So the credits cannot fuel Codex CLI at all; they need a non-Codex client against the Platform API.
- Balance probing: UI (Credit grants) only. Community threads confirm no balance endpoint; the old dashboard `credit_grants` route needs a
  browser session and is unsupported. Spend can be read from the Usage/Costs API with an admin key (not re-verified on current docs).

### xAI

- Official FAQ: "the billing is separate for Grok and xAI API" (docs.x.ai/console/faq/accounts). No page lists included API credits.
  Grok's X account replied that the API "requires its own pay-per-use account" (X post, secondary).
- History: an Aug 2025 X post said SuperGrok Heavy subscribers get $50/month API credits; a later X post (2026) says it ended. Neither is
  official documentation. Treat as zero.
- API billing: prepaid by default, "Your API requests will be automatically rejected" at zero, invoiced billing off by default.
- Not the same thing: Grok CLI's `_x.ai/billing` exposes `config.prepaidBalance` (purchased wallet in USD cents), documented in [CodexBar `docs/grok.md`](https://github.com/steipete/CodexBar/blob/94cc400e1b190f444e2a4d1910c2d63cfbb47e9f/docs/grok.md).
  It is a purchased balance, not an included monthly grant, and its link to Console API credits is unconfirmed.

## Implications for schmear

1. **Credits are a separate API-key lane, not more subscription quota.** They only spend through an API key from the linked org and only
   on specific harnesses: Claude via Agent SDK / `claude -p` / claude-agent-acp (never interactive Claude Code or Vertex); Gemini via
   Gemini CLI + `GEMINI_API_KEY` or Vertex (never `agy`); OpenAI via a non-Codex client (never Codex). xAI has none. Model each credit
   pool as its own capacity entry keyed by (agent, auth mode), and inject the key per spawned process, never ambient. An exported
   `ANTHROPIC_API_KEY` silently reroutes subscription runs onto credits and possibly a card.
2. **No vendor exposes a remaining balance or reset date by API, so schmear must meter locally.** Store per-pool: monthly grant,
   cycle date (user-entered or derived from the plan's renewal), spend measured from each run's reported cost, and reconcile on the
   vendor's exhaustion signal (Anthropic "credit balance is too low", OpenAI 429 `credit_balance_exhausted`, Google 402). Anthropic and
   OpenAI credits are use-it-or-lose-it per cycle, so the scheduler should bias work toward them as the cycle end nears; Google grants
   last 12 months, so they are low urgency.
3. **Fall-through to real money is opt-in on the vendor side and the tool cannot read it.** Anthropic and OpenAI stop at zero unless
   the user enabled auto-reload/auto-recharge or holds purchased credits; Google needs a $5+ real prepay before credits work and stops at
   402 afterward; xAI stops unless invoiced billing is on. Require the user to confirm those settings in config, prefer a dedicated
   workspace/project with a spend limit, and treat any exhaustion error as a hard stop for that lane, not a retry.

Deferred: verify claude-agent-acp is billed as Agent SDK usage against a linked org (one real run); confirm xAI Management API balance
path; check whether Claude-on-Vertex is exempt from Google credit exclusions.

## Sources

- Anthropic API credits doc: https://platform.claude.com/docs/en/about-claude/api-credits-for-subscribers
- Anthropic Help Center: https://support.claude.com/en/articles/17154008-api-credits-for-max-and-team-plans
- Anthropic Agent SDK with plan: https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan
- Claude Code authentication precedence: https://code.claude.com/docs/en/authentication
- Claude Code on Vertex: https://code.claude.com/docs/en/google-vertex-ai
- Anthropic cost report: https://platform.claude.com/docs/en/api/admin/cost_report
- Google Developer Program benefits FAQ: https://developers.google.com/profile/help/benefits
- Google AI Studio claim announcement: https://blog.google/innovation-and-ai/technology/developers-tools/google-cloud-credits-gdp-ai-studio/
- AI Studio billing: https://aistudio.google.com/docs/billing
- Gemini CLI authentication: https://geminicli.com/docs/get-started/authentication/
- Antigravity plans: https://antigravity.google/docs/plans
- Google One AI Ultra benefits: https://support.google.com/googleone/answer/16286513
- Cloud Billing API reference (no credits resource): https://docs.cloud.google.com/billing/reference/rest
- ChatGPT pricing: https://chatgpt.com/pricing
- OpenAI help, API credits benefit: https://help.openai.com/en/articles/20001626-api-credits-benefit-for-eligible-chatgpt-subscriptions
- OpenAI dev guide: https://developers.openai.com/api/docs/guides/chatgpt-api-credits
- Codex auth: https://learn.chatgpt.com/docs/auth
- OpenAI community on balance API: https://community.openai.com/t/get-the-remaining-credits-via-the-api/18827
- xAI accounts FAQ: https://docs.x.ai/console/faq/accounts
- xAI billing: https://docs.x.ai/console/billing
- xAI Management API: https://docs.x.ai/docs/management-api
- Grok reply on X (secondary): https://x.com/grok/status/2040783994082496542
- $50 Heavy credit (Aug 2025, X, secondary): https://x.com/TobyPhln/status/1959760583026434506
- Reported removal (X, secondary): https://x.com/blankspeaker/status/2050208427046297627
- CodexBar provider docs: [claude.md](https://github.com/steipete/CodexBar/blob/e6edfb87d5bcdcd942de8b11d111d6c132ee392e/docs/claude.md), [gemini.md](https://github.com/steipete/CodexBar/blob/0ff1cf55c0a27b63cbb4a7359e0ef2d098114d97/docs/gemini.md), [antigravity.md](https://github.com/steipete/CodexBar/blob/e6edfb87d5bcdcd942de8b11d111d6c132ee392e/docs/antigravity.md), [grok.md](https://github.com/steipete/CodexBar/blob/94cc400e1b190f444e2a4d1910c2d63cfbb47e9f/docs/grok.md)
