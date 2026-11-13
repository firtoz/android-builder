# Provider and build architecture

For maintainers changing adapters or recovery behavior. Normal package use needs only the [provider configuration guide](../docs/providers.md).

The controller freezes source and input hashes before allocation, journals allocation/launch intent before remote effects, and delegates durable provider allocation/owned retirement to released Jetski. The host verifies uploaded inputs and fsyncs a one-shot launch claim. Observation uses bounded cursors; the controller verifies exact artifact bytes before acknowledging retrieval and attempting retirement. [Recovery contracts](../docs/operations.md) are authoritative for user-visible behavior.

Provider allocation/transfer must remain separate from Android compilation and APK verification. Closing a local adapter must not retire its VM. Failed compilation and unconfirmed retirement are independent outcomes. Never turn an uncertain allocation or launch into another build identity, extend an existing lease on retry, or destroy the only artifact copy after an uncertain transfer.

## Jetski host-only API constraint

Android Builder pins released Jetski 0.2.1. Its `BoatHostProvider` constructor requires a `HostTransport` although builder operations use only durable `allocate` and positively owned `retire`. `inspect()` on that provider would request host-control runtime readiness (Podman/gVisor attestation) that a dedicated build VM does not supply. The adapter retains the existing deliberately throwing transport dependency and **never calls runtime inspect or returns dummy readiness**. Builder readiness reads the provider machine state independently; it does not claim Jetski workload isolation.

Precise upstream need: a released host-only durable lease/ownership API exposing `allocate({owner, operationId, expiresAt})`, provider-state reconciliation/absence and `retire(id, allocationId)` without requiring sandbox runtime transport/capabilities. It should preserve the existing provider journal, idempotency-window fencing, positive ownership and confirmed deletion contracts. No new Jetski API, provider internals copy or speculative cloud backend is added here. The current seam remains explicit until upstream supplies that API.
