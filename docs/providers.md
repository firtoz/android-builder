# Choose a machine or provider

The CLI and `createBuilder()` default to Boat Large. Supply `BOAT_API_KEY` privately on the controller when starting, observing or retiring; preparation and inspection need no provider credential. The preparation records the selected `boat:large` identity.

## Choose a Boat machine

For SDK use, pass a factory rather than constructing a transport yourself:

```ts
import { createBuilder } from '@firtoz/android-builder';
import { boatProvider } from '@firtoz/android-builder/providers/boat';
const builder = createBuilder({ provider: boatProvider({ machine: 'small' }) });
```

Choose the machine before preparing a new build and plan your admission allowance for its full lease and transfers. This setting supplies no price quote or aggregate spending enforcement.

## Use a provider module with the CLI

Create a trusted controller file exporting `provider`:

```ts
import { boatProvider } from '@firtoz/android-builder/providers/boat';
export const provider = boatProvider({ machine: 'large' });
```

Append `--provider-module /private/controller/provider.ts` at preparation and every remote operation. Offline `inspect` needs no module. Generated next commands identify the receipt; append your trusted module flag when using them. Do not let untrusted app/PR code choose an executable controller module.

## Supply a custom adapter

A `BuildProvider` has a stable `id` for immutable provider/machine/settings and an `open(directory)` factory returning `{ transport, close }`. Opening initializes local controller resources; it must not allocate. Closing releases those resources and must not retire the VM. Keep tokens out of IDs. Reconnect rejects different settings; use the original adapter for existing receipts.

The underlying `BuilderTransport` must fence allocation durably by owner/operation ID, preserve original leases/idempotency keys and bodies, bound commands/transfers, verify downloads, and positively establish ownership before retirement. Unknown acknowledgements must not cause replacement allocation or launch replay. `REMOTE_GONE` requires positive absence evidence, not a network error. Custom providers need their own qualification.

Dedicated build VMs have sudo/network access and do not carry sandbox-runtime attestation. To change the adapter internals or understand the released Jetski host-only API constraint, use the [maintainer architecture guide](../maintainer/architecture.md). Normal builds do not require that knowledge.
