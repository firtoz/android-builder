# Lifecycle, recovery and failures

Receipts are generated private durable state. Keep the complete directory, including `build.json`, provider SQLite state, frozen archives/manifests/configuration, preparation report, logs, result and optional signing proof. Do not manually author/edit receipts, remove them after a timeout, copy a provider database between identities, or use a new ID to “retry” uncertainty. The ID is independent of the receipt directory name.

## Commands and safe recovery

| Command | Behavior |
| --- | --- |
| `prepare` | Freezes/checks inputs and writes a plan; no adapter open, credentials or allocation. |
| `inspect` (`status` alias) | Reads local evidence only. Does not claim that a host is still alive or a remote phase current. Can inspect a failed-preparation report without a build journal. |
| `start --admit-usd N` (`run --max-usd N` aliases) | Explicitly admits/continues this identity. May reconcile an uncertain allocation with the provider's original fenced operation, upload, launch once, observe, retrieve and finish owned cleanup. |
| `observe` | Authenticated observation/retrieval/cleanup for an already launched build. Never allocates or launches. A pre-launch receipt requires explicit `start` of that same receipt. |
| `retire` | Deliberately retires only a positively owned host. Can destroy an unretrieved artifact. An uncertain allocation without host ID refuses retirement; reconcile its original identity with `start` within the provider's safe reconciliation window, or investigate provider evidence. |

Ctrl-C/SIGTERM in the CLI cancels observation and removes its signal handlers. Remote compilation may continue. Readiness, commands and individual transfers have bounded operations; cancellation is checked between phases/observations, not guaranteed to interrupt a provider request already in flight. Use `inspect` then the indicated same-receipt command. SDK callers can supply an `AbortSignal`; the SDK does not install global process handlers.

Continue pre-launch work only with `start` on the same receipt and explicit admission. It preserves the original provider operation and lease; an expired/unsafe reconciliation window fails closed. Once launch intent exists, observation never sends another launch. A permanent uncertain claim may require deliberate owned retirement; a new build is a separate decision after investigating the original.

The default lease is one hour, beginning before allocation. The 3,000-second execution timeout includes setup/prebuild/Gradle after launch; provider startup, upload and download also consume the lease. Leave practical headroom beyond the schema's minimum 60 seconds. Observation stops 30 seconds before recorded expiry. A process killed by its timeout may retain a last “running” status: the controller does not invent completion. [Lease settings](configuration.md#resolved-values).

## Separate work and cleanup

`build.work` is `not-started`, `unresolved`, `running`, `complete` or `failed`. `complete` means the host reported completion, not necessarily a verified download. `build.journal.artifactVerified` records verified transfer; `build.artifact` is its recorded path. Offline inspection does not rehash that file; call `handle.artifact()` to check current local bytes. Local receipt storage is trusted, not tamper-proof.

`build.cleanup` is `not-allocated`, `unresolved` or `retired`. It is intentionally conservative. A complete verified artifact plus `RETIREMENT_UNCONFIRMED` is still useful work; retry retirement without rebuilding. A corrupt/incomplete transfer retains the host for observation/download retry. There is no unconditional finally/CI VM deletion. A failed compile can retire while its work outcome remains failed. The adapter closing SQLite is separate from VM retirement.

A confirmed provider 404 during readiness/observation is `REMOTE_GONE`; the journal records `hostAbsent: true`. This proves disappearance at that observation, not a successful compiler run, verified artifact or retirement acknowledgement. Work/cleanup evidence remains separate. A remote artifact lost before retrieval cannot be recreated from source receipts alone. No replacement host is allocated automatically.

`build.json` and the inspection/error envelope are the current recovery authority. The legacy `result.json` records the work/transfer summary before retirement and is not proof of final cleanup. A close or network error must never be interpreted as a build refund or authorization for another identity. Admission is persisted before a start's remote work; aggregate budgets/refunds are application policy.

## Error/output contract

Normal output is human readable; progress and compiler logs go to stderr. `--json` writes one JSON envelope to stdout with `version: 1`, `ok`, and `build` on prepared/operating results. Failure includes `error.code`, bounded message, receipt location and, once a build journal exists, the snapshot, ID and `nextCommand`. Failed preparations include `preparationFailure` with ID/directory/next safe command (inspection when a report exists, otherwise help for early input failures). Unknown/invalid arguments and failed preparation exit 2; runtime/recovery failures exit 1; success exits 0. `--help` is human text. Trusted controller config/provider modules must not print to stdout if CI expects a clean JSON stream.

| Code | Meaning / next safe action |
| --- | --- |
| `INVALID_INPUT` / `PREPARATION_FAILED` | Fix inputs or admission; review report. Preparation has no remote effects. Existing frozen-input changes are rejected; preserve existing evidence. |
| `INVALID_STATE` | Explicit same-receipt start/admission is required before launch, or the retired build has no recoverable artifact. |
| `LOCKED` | Another controller or a stale lock exists; inspect before intervening. |
| `ALLOCATION_UNCERTAIN` | Keep provider journal/ID/expiry; reconcile same operation via start. Never silently release aggregate reservation. |
| `LAUNCH_UNCERTAIN` | Observe this receipt; never replay launch. |
| `OBSERVATION_TIMEOUT` / `OBSERVATION_STOPPED` | Lease observation ended or caller cancelled. Remote work outcome can remain unresolved. |
| `REMOTE_UNAVAILABLE` / `REMOTE_GONE` | Remote call unconfirmed / positively observed absence. Preserve evidence; no automatic replacement. |
| `BUILD_FAILED` | Original setup/compiler failure; retained log/outcome, even if retired. |
| `ARTIFACT_VERIFICATION_FAILED` | Artifact omitted, changed, absent or transfer unverified; retain available source and inspect. |
| `RETIREMENT_UNCONFIRMED` | Work may be usable, but owned resource cleanup needs reconciliation. |

The high-level SDK throws `BuildOperationError extends BuildError`, with typed `code` and `build` snapshot. `BuildPreparationError` carries ID and directory. Unknown transport failures become `REMOTE_UNAVAILABLE`; low-level existing functions retain some ordinary errors for compatibility. A task/output configuration preflight check cannot predict every Gradle-generated layout.

## Stale locks

A mutating controller uses exclusive `controller.lock/owner.json`, recording PID, host and start time. No automatic lock stealing occurs: PIDs can be reused and receipts may be shared between controllers. First stop/reconcile the recorded job on its actual machine, rule out another live controller using the same receipt/provider database, and preserve the receipt/owner record. Only after positive evidence that no controller can still mutate this build should an operator remove that **lock directory alone**. Keep `build.json`, provider database and launch evidence. Resume the original identity; never remove locks speculatively in a CI retry script.
