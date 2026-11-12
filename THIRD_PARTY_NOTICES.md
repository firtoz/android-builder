# Third-party software

The package's own source is MIT licensed. Runtime dependencies are installed from npm with exact lockfile integrity records; their licenses and notices remain with their packages. No third-party history, credentials, private receipts, SDK binary, Gradle distribution or agent application is bundled.

- @firtoz/jetski — MIT; portable provider/state components.
- Zod — MIT; input and journal validation.
- Build tooling (TypeScript, Biome, Node.js types) is development-only; see its installed license notices.

The optional host bootstrap obtains Node.js, package managers, OpenJDK, Android SDK and Gradle from their respective providers. Those projects retain their own licenses. Android SDK license acceptance is the operator's responsibility; the builder only transfers existing accepted hashes. The generic native example's bootstrap is original source and verifies an official Gradle checksum rather than bundling a distribution.
