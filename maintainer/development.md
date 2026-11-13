# Develop and verify Android Builder

Use a source checkout with Linux, Node 24.22.1+, Git and tar. Ordinary package users should follow [installation](../docs/install.md) instead.

```sh
npm ci --ignore-scripts
npm run check
npm run verify:package
```

`check` builds/types the SDK, runs recovery/preparation/CLI fixtures, lints source/examples/scripts and checks local documentation links. It needs neither cloud credentials nor an Android SDK. Use a process environment that actually allows Node to run child tests and the local Python launcher; a runner exit without individual test results is insufficient evidence.

`verify:package` packs the candidate and inspects its file inventory. It installs the tarball/dependencies into fresh temporary SDK, native-example and Expo-example directories with lifecycle scripts disabled. It checks public SDK/provider/CLI exports, local SQLite open/close, documentation links in the installed package, strict public API types, both example configurations, Expo TSX, source preparation and offline JSON inspection. Controller and React Native globals are checked separately with strict library checks enabled. Network access may be needed for npm dependencies. The command prints the location of the exact package inventory, integrity, install locks and verification result.

## What a pass establishes

| Check | Evidence |
| --- | --- |
| Controller fixtures | Same-identity recovery after lost acknowledgements, preserved compiler failures, corrupt/partial transfer handling, exclusive controllers, bounded leases and unconfirmed cleanup |
| Local Python launcher | One-shot claim/spawn/observe behavior and stage timing/working-directory handling |
| Preparation fixtures | Frozen-byte completeness, local/workspace dependencies, safe extras, unsupported source/configuration errors and provenance |
| Packed installs | Public packaging/types/CLI, example preparation and user-document navigation |

These checks use simulated hosts/APK bytes and local processes. They do not compile Android, qualify live provider ownership/deletion or establish runtime performance. [Historical qualification](qualification.md) states the version/workload boundary of live evidence.

## Package and change review

Ship generic runtime/types, host scripts, examples, user guides, maintainer references, license and notices. Keep credentials, private receipts, test/install directories and raw development checkpoints out. Inspect the actual tarball after changes to documentation locations, exports or package file rules.

For documentation changes, validate the newcomer path and links in both checkout and packed install; avoid a separate unofficial workflow. For runtime changes, repeat affected gates after fixes rather than growing an unbounded matrix. Live hosts, publication, signing/device operations and production changes require their own scope/authorization; offline development does not grant it.
