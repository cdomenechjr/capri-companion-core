# Built-in companion skills

Capri 0.7.0-dev.4 ships 25 built-in workflow recipes: the original ten plus the 15 below. The catalog is compiled from `src/extensions/skills.ts` into the app; no separate skill download or account connection is required. When reviewed skills are enabled, Capri selects up to three relevant workflows for each request and keeps her configured character and voice.

## Update and activate

Update the source checkout through your normal reviewed Git workflow, then run:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm check
pnpm test
```

Restart the rebuilt app. In **Settings → Extensions**, click **Check status** and enable **Use reviewed skills** if it is off. Open **Skills** and click **Load catalog** to inspect the built-in workflows and their requirements. Updating preserves the saved Skills switch, individual revocations and user-authored workflows; it does not silently re-enable anything. Built-ins are reviewed as part of the application source, while user-authored drafts still require their own exact-manifest review.

Pulling source alone does not update an already running or previously packaged executable. A source build must be launched from the updated checkout. Packaged installations need a newly built release through the existing verified update process. This catalog change does not publish an installer or change release trust, private assets, voice settings or stored conversations.

## New workflows

| ID | What Capri helps with | Example request |
| --- | --- | --- |
| `sprint-prioritizer` | Rank a backlog by impact, effort, dependencies and available time; save plans when asked. | Prioritize this sprint backlog and explain the tradeoffs. |
| `clean-code-training-coach` | Explain focused coding lessons, before/after examples and practice exercises. | Coach me through this code and give me a practice exercise. |
| `workflow-optimizer` | Map repetitive work and produce a scoped improvement or automation plan. | Analyze this repetitive workflow and suggest an automation plan. |
| `content-creator` | Draft and repurpose articles, newsletters, social copy and video scripts. | Draft a newsletter from these supplied product notes. |
| `visual-storyteller` | Develop visual narratives, shot lists and storyboard plans. | Plan the visual storytelling and shot list for this idea. |
| `tool-evaluator` | Research current tools, prices, integration effort and tradeoffs. | Compare these tools against my budget and requirements. |
| `clean-code-review` | Review maintainability and recommend a safe refactoring sequence. | Review this project's maintainability and code smells. |
| `pr-review` | Review a supplied patch or local pull request diff for concrete risks. | Review this pull request diff for regressions and test gaps. |
| `evidence-led-product-states` | Specify truthful empty, loading, pending and permission states. | Review the empty state and permission state in this component. |
| `ai-engineer` | Plan AI features, retrieval, embeddings, evaluations and provider fallbacks. | Review this RAG retrieval design and its evaluation plan. |
| `data-modeling-query-patterns` | Assess data entities, access patterns and migration risks. | Review this memory design and its data modeling choices. |
| `derived-data-systems` | Review search indexes, caches, freshness, deletion and rebuild plans. | Review this search index and cache reconciliation plan. |
| `concurrency-clean-code-review` | Analyze races, shared-state ownership, cancellation and shutdown. | Review concurrency and cancellation in these selected files. |
| `error-handling-exception-design` | Assess failure contracts, ambiguous results and recovery boundaries. | Review error handling and null handling at this provider boundary. |
| `data-ethics-privacy-governance` | Review consent, retention, deletion and personal-data flows. | Review privacy, consent and retention in this data flow. |

The original ten remain available: `research-briefing`, `document-artifacts`, `creative-studio`, `coding-workbench`, `desktop-troubleshooting`, `browser-workflow`, `reminders-plans`, `file-backups`, `game-workshop` and `download-inspection`.

## Behavior and requirements

Advice can stay in conversation. Capri saves a worksheet, report, specification or storyboard only when requested; saved artifacts use the existing read-back and SHA-256 verifier. Saved plans use returned plan records. Code and architecture reviews describe what was inspected and tested, rather than presenting a written recommendation as an implemented change.

The tool evaluator uses public web search and page reads, so it is unavailable in local-only tasks. The other new recipes use local tools and can provide guidance with a configured local reasoning provider. Their tools still require the current task's folder access. A ready recipe describes installed tools and verification handlers; it is not proof that the requested work succeeded.

The engineering recipes help assess and plan improvements. Improving Capri's memory retrieval, changing storage or providers, and fixing cancellation behavior require separately scoped implementation and tests. The content recipes produce drafts and production plans. Image generation, video rendering, posting, messaging, service signups and external account access retain their own tool and authorization requirements.

## Provenance

These are original MIT-compatible plain-language recipes adapted to Capri's existing tool contract from the workflow topics reviewed for this update. Reference catalogs were the Clean Code and DDIA public-safe exports and specialist roles in `chrisdomenech/Style-Sync`. The recipes contain no copied role prompts, book excerpts, model overrides or provider credentials. The private Semper plugin suites have not been vendored; Product Marketing and Snowflake Engineering installation status was not verifiable from this session.

The original public export manifests remain historical provenance for the sanitized source snapshot. Later catalog, UI and documentation changes are tracked by Git.
