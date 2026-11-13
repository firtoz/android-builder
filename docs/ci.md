# One workflow locally and in CI

Use the public package in a separate trusted controller installation, an immutable reviewed checkout and a private durable receipt volume. The commands are the same as local use. This candidate is unpublished; choose a reviewed package version with these APIs after release, or use the [candidate installation](install.md) for offline evaluation. Do not assume published 0.1.0 understands these commands.

Example shell recipe (adapt storage/secret injection to your CI). `ANDROID_BUILDER_VERSION` is a protected exact reviewed package version, `APPROVED_COMMIT` is a reviewed immutable commit, and the receipt path is a stable externally supplied job identity on durable storage, **not** a newly generated retry path. The controller directory/config and package version are trusted independently of the app checkout.

```sh
set -eu
# No provider/signing credentials during installation or source preparation.
npm install --prefix "$CONTROLLER_DIR" --ignore-scripts --no-audit --no-fund \
  --save-exact "@firtoz/android-builder@$ANDROID_BUILDER_VERSION"
BUILDER="$CONTROLLER_DIR/node_modules/.bin/android-builder"
git -C "$SOURCE_DIR" checkout --detach "$APPROVED_COMMIT"
test -z "$(git -C "$SOURCE_DIR" status --porcelain)"

# Run this only for the first attempt. Repeated/interrupted attempts skip prepare
# and recover the same durable RECEIPT_DIR using inspect/start/observe below.
"$BUILDER" prepare --root "$SOURCE_DIR" --config "$TRUSTED_CONFIG_JSON" \
  --licenses "$ACCEPTED_LICENSES_DIR" --directory "$RECEIPT_DIR" --json \
  > "$PRIVATE_JOB_OUTPUT/preparation.json"
"$BUILDER" inspect --directory "$RECEIPT_DIR" --json
# Ensure the full receipt is durable BEFORE spending admission. Review the report.
```

In a protected trusted-source stage, inject `BOAT_API_KEY` into the controller process environment only. Do not run project install/build scripts on this controller with the credential present. The host receives only frozen public inputs. Signing keys are absent from both controller build stage and remote VM.

```sh
# BOAT_API_KEY supplied by the CI secret store, without printing it.
# OPERATOR_ADMIT_USD is explicit per-build admission, not an account cap.
set +e
"$BUILDER" start --directory "$RECEIPT_DIR" --admit-usd "$OPERATOR_ADMIT_USD" --json \
  > "$PRIVATE_JOB_OUTPUT/build-result.json"
result_code=$?
set -e
cat "$PRIVATE_JOB_OUTPUT/build-result.json"  # private job log only
# Persist complete receipt and this envelope even on nonzero exit.
# In particular report .build.cleanup == "unresolved" for operator action.
# Do not run unconditional retirement here.
exit "$result_code"
```

For interrupted jobs, mount the **same** private receipt and controller/provider state. Run `inspect`; use `observe --json` if already launched. If it says explicit start is needed, `start --admit-usd` reconciles/continues only that original operation. Do not prepare in an automatic retry loop or silently refund its aggregate reservation. A stale controller lock needs positive operator investigation, not automatic deletion. Lease expiry can limit recovery even when the receipt survived.

Use a pre-provisioned private durable volume/object-storage restore mechanism that preserves the full coherent directory. The adapter closes SQLite after an operation; take backups after that, or use a proper consistent SQLite snapshot including required WAL state. Persist before remote effects and on interruption/failure; saving an artifact only at successful job end is insufficient. Permissions/retention are CI responsibilities. Source archives, local paths, client public settings, build logs and provider journals may contain private data. Do not upload them to public CI artifacts or expose raw JSON results to untrusted PR logs. Export the approved APK and a reviewed sanitized summary separately.

PR jobs may run package tests, static checks and **credential-free preparation** using a trusted data-only config. A TypeScript config/provider module is executable controller code; never import one from an untrusted PR in a credentialed job. Git source freezing is not a security sandbox or secret scanner. A protected job must independently approve the immutable source/config/public inputs before remote execution. A dedicated host lacking cloud/signing credentials still has network/root privileges: don't advertise arbitrary hostile PR execution as safe.

A separate signing job can receive a verified APK and appropriate source/result proofs through approved private storage. It needs its own application/certificate allowlist, local Android signing tools and restricted signing credentials; provider credentials are unnecessary. Installation/store distribution is a separate explicit decision. CI must keep failed compiler work failed and report unresolved owned resources even if an APK was retrieved successfully. A provider absence with no local artifact cannot be reported as a successful build.
