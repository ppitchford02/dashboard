# Duncan capability map

Verify a capability is exposed in the current session, then use the narrowest route.

| Need | Claude route | Completion proof |
|---|---|---|
| Gmail | Connected Gmail | Current connector result |
| DPY Outlook | Connected Microsoft 365 | Current connector result |
| Drive delivery | Drive plus named local plan | Read-back hash and local receipt |
| Brightspace/social | Claude in Chrome with exact domain/account/profile | Page state plus task receipt |
| Sports Picks | `sports-picks-local` | Item saves plus final run receipt |
| Dashboard | Connected `/Users/prestonpitchford/dashboard` | Tests, Git state, live version when deployed |
| Law School | Connected `/Users/prestonpitchford/law-school-os` | Current plan/state and receipt |
| Collections | Connected `/Users/prestonpitchford/skiptrace-harness/harness` | Checkpoint, budget ledger, result/test |
| Shared Knowledge | `graphify-shared` or direct library CLI | Source-linked excerpt/status |
| Continuity | Matching Obsidian handoff | Dated handoff with evidence and next step |
| Health | Agent Health Center local evidence | Evidence-backed green/yellow/red report |

Claude cannot inherit Codex task/thread APIs, Codex automations, Codex UI control, or any unexposed tool. Use shared handoffs or Claude-native equivalents and never simulate access. Claude in Chrome sees only surfaces exposed to its session; after bounded checks, an unexposed signed-in profile is a concrete access blocker.

