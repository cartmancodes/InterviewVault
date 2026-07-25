# Code Language Normalization — Design Spec

**Date:** 2026-07-26
**Goal:** Make server-side code samples under `LLD/` Python, so the vault reads in one language.
**Non-goal:** `DSA/` stays C++ (owner's decision — competitive-programming idiom).

---

## 1. Source of truth

`site/**/*.html` is **generated** by `tools/build-site.mjs`. All edits go to the markdown
under `LLD/`; the site is then rebuilt:

```bash
cd tools && node render-diagrams.mjs && node build-site.mjs
```

Editing the HTML directly would be discarded on the next build.

---

## 2. Scope

Of 1,169 fenced blocks in the vault, 607 are mermaid diagrams and most of the rest are not
program code (API sketches, Redis CLI, znode trees, JSON payloads, formulas). 37 blocks
under `LLD/` were candidates; they resolve as follows.

### Convert to Python — 17 blocks

| File | Blocks | Target library |
|---|---|---|
| `SystemDesign/DeepDives/Kafka.md` | 5 | `kafka-python` |
| `SystemDesign/DeepDives/Flink.md` | 3 | PyFlink (`pyflink.datastream`) |
| `SystemDesign/Patterns/Multi-StepProcesses.md` | 4 | Temporal Python SDK |
| `SystemDesign/DeepDives/Dynamodb.md` | 2 | `boto3` |
| `SystemDesign/DeepDives/Zookeeper.md` | 1 | `kazoo` |
| `SystemDesign/ProblemBreakdowns/YoutubeTopK.md` | 1 | PyFlink |
| `SystemDesign/ProblemBreakdowns/OnlineAuction.md` | 1 | Python (server-side SSE manager) |

### Tag only — 4 blocks

Already Python (or trivially so) but sitting in untagged fences: `Patterns/ScalingReads.md`,
`ProblemBreakdowns/Strava.md`, `ProblemBreakdowns/Tinder.md`. The pseudocode block in
`ProblemBreakdowns/DistributedCache.md` becomes real Python.

### Deliberately left alone — 16 blocks

Converting these would make the documentation **incorrect**:

- **Browser-side JavaScript (7)** — `EventSource`, `WebSocket`, `RTCPeerConnection`, `fetch`
  in `Patterns/Real-TimeUpdates.md` and `ProblemBreakdowns/OnlineAuction.md`. Python does not
  run in a browser. These are tagged ` ```javascript ` so the client/server split is explicit.
- **Rust (1)** — `IntheWild/HowDiscordMovedTrillionsOfMessagesToScylladb.md`. Discord's data
  service is written in Rust; restating it in Python would misrepresent the case study.
- **Lua (2)** — `questions/Design Online Auction.md`. These execute inside Redis via `EVAL`.
- **Not program code (6)** — REST endpoint sketches (`ApiDesign.md`, `Strava.md`), Cassandra
  CQL (`Cassandra.md`), an AWS Step Functions JSON state machine, and an interface signature
  sketch (`YoutubeTopK.md`).

---

## 3. Conversion rules

- Preserve the **teaching intent** of each snippet: same concept, same call sequence, same
  inline comments. This is a language change, not a rewrite.
- Use the idiomatic client for each system rather than a literal transliteration
  (`boto3` resource API, `kazoo` recipes, Temporal decorators).
- Keep snippets short; they illustrate a point in prose, they are not runnable programs.
- Every converted block is tagged ` ```python `.

---

## 4. Verification

1. Every ` ```python ` block in `LLD/` parses under `ast.parse` (syntax gate).
2. Site rebuilds with 0 missing diagrams and 0 broken links/assets.
3. Language-tag census before/after, to confirm nothing was silently dropped.

---

## 5. Success criteria

- No untagged program-code fences remain under `LLD/`.
- All server-side samples under `LLD/` are Python and parse cleanly.
- Client-side, Lua, Rust, CQL and config blocks remain in their correct languages, tagged.
- `DSA/` untouched.
