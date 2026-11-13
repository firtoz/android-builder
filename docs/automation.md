# Automate build completion and artifact handoff

Use Android Builder as a durable job SDK inside a trusted Node controller or CI job. Preparation freezes inputs; explicit start admits remote work; `wait` returns a compact typed result; `exportArtifact` produces a verified file for your uploader or next job. Provider construction, receipt interpretation and APK copying stay inside the library.

These APIs belong to the [unpublished candidate](install.md). They add no hosted service, automatic account upload, signing or device operation.

## A small controller integration

```ts
import { createBuilder } from '@firtoz/android-builder';
const builder = createBuilder({ receiptsDirectory: '/private/builds' });
// Prepare once, inspect/review, and persist its ID/directory before spending.
const build = await builder.prepare({
  root: '.', licensesDirectory: '/private/accepted-sdk-licenses',
  config: { project: { kind: 'gradle' }, admissionAllowanceUsd: 0.20 },
});
console.log(await build.inspect());
// Run this only after the plan is approved:
await build.start({ admitUsd: 0.20, waitForCompletion: false });
const result = await build.wait();
if (result.outcome === 'succeeded') {
  const artifact = await build.exportArtifact(`/approved/${build.id}.apk`);
  console.log(artifact); // path, buildId, bytes, sha256, applicationId, sourceHash
} else {
  console.error(result.work, result.cleanup, result.issues, result.nextCommand);
  process.exitCode = 1;
}
```

`start` can still throw a typed admission/allocation/launch error. Preserve that receipt and follow its next safe command. A lost launch acknowledgement is resolved by waiting/observing the same build, not by preparing or launching another one. On CI retries or after process restart, skip `prepare` and reconnect with the saved ID/directory. Repeating preparation is deliberately not a substitute for request-key idempotency.

`wait` never allocates or launches. It uses the existing observation/retrieval/owned-cleanup engine and returns known build/observation/cleanup issues as data. A fully retired recorded result can be rechecked locally without provider credentials. Unreadable local receipts or unexpected local errors can still throw; retaining readable private state is a prerequisite, not an API guarantee.

## Compact completion contract

`BuildCompletion` contains `version: 1`, build ID, receipt directory, expected application ID, source commit/hash/working-tree flag, work/cleanup state, phase/exit code and recorded stage timings when known, typed `issues` and a next safe command. It omits provider journals, public environment values and source inventories. It remains private operational metadata, not an automatically public report.

| `outcome` | Meaning | Artifact |
| --- | --- | --- |
| `succeeded` | Complete work, current local bytes verified, owned retirement confirmed, no reported issue | Required typed `VerifiedArtifact` |
| `failed` | Original work is known to have failed, even if cleanup also needs attention | None |
| `needs-attention` | Observation stopped/uncertain, invalid pre-launch wait, transfer unverified or retirement unresolved | Present only when current local bytes can be verified |

Stage timings can overlap an enclosing phase; do not sum nested durations as an end-to-end metric. Check cleanup independently when handling a usable artifact from `needs-attention`. A failed compiler and failed retirement can both appear in `issues`. An observer timeout/cancellation is not a compiler failure. These distinctions let your application export a usable artifact under its own policy while still failing/reporting unresolved owned resources.

`wait({ signal, log, progress })` accepts the same options as `observe`. For a bounded caller observation window, use a standard `AbortSignal`, such as `AbortSignal.timeout(10 * 60 * 1000)`; cancellation leaves the remote build potentially running. `progress`/`log` callbacks are observations, not a durable event stream or exactly-once webhook delivery. Keep callbacks short and do not recursively mutate the same locked build. The private receipt remains the recovery authority.

## Export without copying receipt internals

```ts
const artifact = await build.exportArtifact(`/approved/${build.id}.apk`);
// A caller's uploader can use `${artifact.buildId}/${artifact.sha256}` as its
// deduplication key, if that uploader's own protocol supports idempotency.
```

Export works without provider credentials and does not require retirement to be confirmed. It requires a complete build and previously verified retrieval, then rechecks exact local byte length/SHA-256 while copying in bounded chunks. It refuses source/destination file symlinks and destinations resolving inside the original receipt. New output files are private (0600).

Publication is atomic and does not overwrite: an existing identical regular file is an idempotent success; different content or a non-regular target gives `ARTIFACT_EXPORT_CONFLICT`. An interrupted/unconfirmed local export is `ARTIFACT_EXPORT_FAILED`; preserve the original receipt and retry the same destination after resolving any stale lock. No new compilation is needed. Normal failures remove the private partial file; a killed process can leave one for operator inspection. Never steal a controller lock to retry.

Export needs a writable original receipt for its exclusive controller lock. Use a local filesystem supporting hard links and directory fsync for this atomic export, then send the verified file through your storage API. Export metadata is not a signing certificate, release permission or tamper-proof source attestation. [Separate signing](signing.md) and your artifact-sharing policy still apply.

## CLI and CI without a wrapper

```sh
set -eu
# Reconnect to an already admitted build; do not prepare another identity.
android-builder wait --directory "$RECEIPT_DIR" --json > "$PRIVATE_OUTPUT/completion.json"
android-builder export --directory "$RECEIPT_DIR" \
  --output "$APPROVED_OUTPUT/$BUILD_ID.apk" --json > "$PRIVATE_OUTPUT/export.json"
```

`wait --json` emits `{ version: 1, ok, result }`. It exits 0 only for `succeeded`, and 1 for `failed` or `needs-attention`; invalid arguments/early input errors use exit 2. Progress/raw build output goes to stderr and must stay in approved private logs. `export --json` emits `{ version: 1, ok: true, artifact }`; typed failures include compact recovery information. Neither command's normal result embeds the full journal/configuration. Existing `observe`, `inspect` and `start` envelopes stay compatible.

The CLI's exit status gates the next step, so CI does not need to parse a provider journal or infer success from an APK path. The [Expo custom-workflow fragment](expo.md#track-the-job-in-expos-dashboard) uses these commands before uploading a generic artifact. For durable storage, trusted-source admission and secret separation, use the [CI guide](ci.md).

## Keep external delivery separate from compilation

Persist/restore the complete private receipt before remote effects and after interruption. A CI run ID or a compact completion JSON file alone cannot reconstruct the provider state/source archive. The library creates durable build IDs; your controller associates them with its workflow/request identity and supplies durable storage.

External upload/callback retries need their own delivery receipt and destination-specific idempotency. Send from the trusted controller only after verified export, keep credentials off build VMs, and retry the same build/hash after uncertain delivery. Do not recompile to recover an upload. No HTTP service, webhook sender, cloud receipt replication or exactly-once delivery guarantee is supplied by this SDK.
