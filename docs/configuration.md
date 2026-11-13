# Preparation and configuration

Preparation freezes files before resolving project settings and checking dependencies. It runs Git and tar, reads source metadata, and never executes a project lifecycle/discovery script. Importing a TypeScript controller configuration is execution of that explicitly selected trusted file; JSON avoids that import.

## Resolved values

| Setting | Resolution and boundary |
| --- | --- |
| Project kind/directory | Explicit. Expo prebuild requires no frozen native `android/` tree; existing native code uses `kind: 'gradle'`, with its directory pointing to `gradlew`. |
| Package manager | Root pinned `packageManager`, or explicit kind/version; conflicts fail. Dependency install is frozen/locked at root. |
| Expected application ID | Static `app.json#expo.android.package`, or one literal native `app/build.gradle(.kts)` applicationId. Dynamic Expo/Gradle, flavors and applicationIdSuffix require the explicit final ID. Static conflicts fail. No JavaScript/Gradle execution for inference. |
| Gradle task/variant | Defaults to `:app:assembleDebug`. Custom tasks require an explicit artifact path; release/bundle tasks are rejected by preflight. Dynamic/custom output rules require operator review. |
| Artifact | Conventional single `app/build/outputs/apk/debug/app-debug.apk`, prefixed by project directory and Expo's generated `android/`. Explicit overrides supported. Obvious debug/variant/release/AAB contradictions fail. No glob discovery or split-APK collection. |
| SDK/build tools/NDK | Unambiguous native literals can supply compileSdk/buildToolsVersion/ndkVersion; otherwise inspected builder defaults or explicit toolchain versions. Conflicts with a sole literal fail; multiple module literals require an explicit override. These are conservative text checks, not a Gradle evaluator. |
| Java/Node/CMake/tools archive | Explicit or pinned builder defaults. Expo-generated NDK/CMake requirements cannot be safely inferred from app.json or an arbitrary dependency version; specify them for the chosen Expo/React Native template. |
| ABIs | Optional exact expected native-code set, also passed as `-PreactNativeArchitectures=...`. React Native projects use that property. Other native projects must wire ABI filters themselves. Final APK ABI equality is verified; this is not a universal Gradle ABI override. |
| Admission | Explicit operator `admissionAllowanceUsd`; low-level `reservationUsd` retained. Not inferred from provider pricing. |
| Lease/execution | Defaults 3,600s/3,000s. Execution includes verification/setup/install/prebuild/Gradle. Readiness/upload and download need additional lease headroom. Minimum 60s difference is a schema floor, not operational sufficiency. |

The host verifies the exact configured APK, its signature and application ID, and requested ABI equality using Android tools. The controller checks download length and SHA-256 against the durable remote outcome. Project code runs on that host; these checks establish consistency with its outcome, not independent proof of source provenance against malicious trusted project code. Signing locally independently verifies the application and pinned certificate.

A debug Expo APK generally needs the normal Metro/development workflow. Merely naming an APK “release” cannot supply a production JS bundle, a development-client dependency or store signing. Do not infer those outcomes from a debug build.

## Source boundary

`root` locates a Git repository; preparation resolves its actual top-level directory. `project.directory`, artifact paths and source paths are relative to that top level, even when preparation is invoked from a subdirectory. The report shows both resolved absolute paths. Source bytes and executable modes are copied from the working tree, compared with the captured HEAD's Git blobs, hashed, archived and verified again before remote execution. Avoid editing files during preparation: it freezes files individually, not an atomic repository snapshot. The archive can be a subset of HEAD; `workingTree: false` means the selected files match HEAD, not that every repository file was included.

Default inputs are tracked regular files. Hidden components, `node_modules`, `dist`, `coverage`, `build`, common signing/private-key/database/artifact/log files and known client credential configuration are excluded. `.gitmodules` remains excluded, but a selected submodule directory fails as unsupported. Selected symlinks (including ancestor symlinks), submodules, special files and Git LFS pointers fail. Materialized LFS bytes can be frozen after operator review; no automatic LFS download occurs. Untracked files appear as exclusions; ignored untracked files are not enumerated.

```ts
source: {
  extraFiles: ['.npmrc', 'vendor/public-library.tgz'],
  requiredFiles: ['.npmrc', 'vendor/public-library.tgz', 'patches/library.patch'],
}
```

Extras are exact paths, including deliberately chosen untracked/ignored **public** files. They cannot bypass credential/output/dependency exclusions or a consumer's restrictive `include` filter. Hidden extras support only a final `.npmrc` basename with no other hidden component. `.npmrc` with authentication/password/token settings, environment substitution or URL credentials is rejected. This deliberately narrow check also rejects some benign token-named settings; it is not a general safe-file classifier.

`requiredFiles` checks actual frozen source membership, not disk existence. It does not describe the separate `publicInputs` overlay. `publicInputs` remains an explicit optional public-file transfer mechanism (for example, client configuration) with unique non-hidden targets; it must never carry provider/signing credentials or service-account secrets. Original source paths stay on the controller; host configuration includes only transfer names/targets. Review those inputs separately too.

`source-manifest.json` gives each file's bytes/hash/mode. `preparation-report.json` gives ID, receipt/root/project paths, source description, included/excluded paths/reasons, relevant inputs, dependency targets, errors/warnings, resolved configuration and provenance. Failed source preflight retains its report and no prepared build journal; `inspect --directory PATH` can read it. Fix the source/configuration and deliberately prepare a fresh receipt. Configuration/license/path errors can occur before a report is created; the failure still gives the generated ID and intended receipt location. Nothing was allocated by preparation. Never reuse/overwrite an existing receipt directory.

## Dependencies and workspaces

Dependency installation happens at the frozen repository root. Supported: npm with `package-lock.json` or `npm-shrinkwrap.json`, Bun with `bun.lock` or `bun.lockb`, pnpm with `pnpm-lock.yaml` in a single root package. Versions must be pinned as `npm@x.y.z`, `bun@x.y.z` or `pnpm@x.y.z` in root `package.json#packageManager`, or explicitly in the config. Conflicting pins fail. A native project without JavaScript dependencies needs no package manager. If the root manifest declares dependencies, select/pin one explicitly so they are installed.

npm/Bun workspaces support a root `workspaces` array of literal directories or one trailing `/*` (such as `apps/*`, `packages/*`). Every literal workspace and every known matching manifest must be frozen; a wildcard with no frozen packages fails. Nested Expo projects must belong to root workspaces. Object workspaces, negation, recursive/complex globs, nested independent installations, pnpm workspace layouts, Yarn/PnP, `link:` and `portal:` are rejected. Bun supports `workspace:` names; npm users should use npm-compatible version/file dependencies rather than `workspace:`.

Every frozen `package.json` is checked, including dev/optional dependencies. `file:` paths resolve relative to their **declaring manifest**, must stay in the repository and must name a frozen file (e.g. a `.tgz`) or directory containing a frozen `package.json`. Literal `main`, `module`, `types`, `exports` and `bin` entries in such local packages must be present (with basic `.js`, `.json`, `index.js` resolution). Globs are reported for manual review. Generated excluded `dist` outputs are not silently rebuilt or uploaded. Include source-oriented local packages, or prepare and explicitly include a public archive. Bun/pnpm `patchedDependencies` paths are checked; other dynamic patch machinery needs `requiredFiles` and review. Relevant lockfiles, workspace manifests, patch files, app/Gradle/TypeScript configuration and public `.npmrc` are listed.

Limits: no secret scanning guarantee, full package-manager resolver, lockfile semantic consistency validation, network reproducibility proof or dynamic script dependency discovery. Lockfiles may themselves depend on lifecycle-generated code. Project scripts run later on the dedicated VM and must be trusted. Use required paths and review the report for inputs the checker cannot know.

## SDK licenses

`sdkmanager` on the remote VM needs the license-hash records produced after an operator has read and accepted the applicable SDK agreements. The builder copies those existing records to the remote SDK directory and supplies no acceptance input. It does not interpret copying a file as legal acceptance or accept additional terms for you.

You can copy the `licenses/` directory from an Android SDK installation under which **you/your organization have already accepted the applicable terms**, or provide your organization's approved accepted-hash bundle in a private directory. No complete local SDK installation is needed for remote builds. Do not download arbitrary hashes or fabricate acceptance records. Each file has a simple license name and whitespace-separated 40-character lowercase hashes (max 4 KiB). Missing/new agreements must be reviewed and accepted separately by an authorized operator, outside this workflow. No acceptance helper is added.
