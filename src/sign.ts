import { readFile, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { digest, sha256 } from "./contracts.js";
import { atomicJson, exec, readJournal, withBuildLock } from "./files.js";

async function signUnlocked(directory: string, env: NodeJS.ProcessEnv) {
	const journal = await readJournal(directory);
	if (!journal.artifactVerified || !journal.outcome?.artifact)
		throw Error("Only a verified build artifact may be signed");
	const apk = join(directory, "artifact.apk");
	if (sha256(await readFile(apk)) !== journal.outcome.artifact.sha256)
		throw Error("Build artifact changed before signing");
	if (!env.ANDROID_SIGNING_CONFIG || !env.ANDROID_HOME)
		throw Error(
			"Set local ANDROID_SIGNING_CONFIG and ANDROID_HOME. Signing credentials never go to the build host.",
		);
	const expectedSigner = digest.parse(
		env.ANDROID_SIGNER_SHA256?.toLowerCase().replaceAll(":", ""),
	);
	let privateConfig: unknown;
	try {
		privateConfig = JSON.parse(
			await readFile(env.ANDROID_SIGNING_CONFIG, "utf8"),
		);
	} catch {
		throw Error("Cannot read valid private Android signing configuration");
	}
	const config = z
		.object({
			keystorePath: z.string(),
			keystorePassword: z.string(),
			keyAlias: z.string(),
			keyPassword: z.string(),
			applications: z.array(z.string()),
		})
		.parse(privateConfig);
	if (!config.applications.includes(journal.config.applicationId))
		throw Error("Signing configuration does not authorize this app identifier");
	const keystore = resolve(
		dirname(env.ANDROID_SIGNING_CONFIG),
		config.keystorePath,
	);
	const tools = join(
		env.ANDROID_HOME,
		"build-tools",
		journal.config.toolchain.buildTools,
	);
	// Build only Android tooling's environment. Do not hand it provider credentials.
	const signingEnv = {
		NODE_ENV: process.env.NODE_ENV ?? "production",
		PATH: process.env.PATH,
		HOME: process.env.HOME,
		JAVA_HOME: process.env.JAVA_HOME,
		ANDROID_BUILDER_STORE_PASSWORD: config.keystorePassword,
		ANDROID_BUILDER_KEY_PASSWORD: config.keyPassword,
	};
	const temporary = join(directory, "app-signed.partial.apk");
	const apksigner = join(tools, "apksigner");
	const badging = await exec(join(tools, "aapt"), ["dump", "badging", apk], {
		env: signingEnv,
	});
	if (
		!badging.stdout.startsWith(
			`package: name='${journal.config.applicationId}'`,
		)
	)
		throw Error("Wrong APK package before signing");
	try {
		await exec(
			apksigner,
			[
				"sign",
				"--ks",
				keystore,
				"--ks-key-alias",
				config.keyAlias,
				"--ks-pass",
				"env:ANDROID_BUILDER_STORE_PASSWORD",
				"--key-pass",
				"env:ANDROID_BUILDER_KEY_PASSWORD",
				"--out",
				temporary,
				apk,
			],
			{ env: signingEnv, maxBuffer: 1024 * 1024 },
		);
		const result = await exec(
			apksigner,
			["verify", "--print-certs", temporary],
			{ env: signingEnv },
		);
		const fingerprints = [
			...result.stdout.matchAll(
				/Signer #[0-9]+ certificate SHA-256 digest: ([a-f0-9:]+)/gi,
			),
		].map((m) => (m[1] ?? "").toLowerCase().replaceAll(":", ""));
		if (fingerprints.length !== 1 || fingerprints[0] !== expectedSigner)
			throw Error("APK signer does not match the pinned certificate");
		await rename(temporary, join(directory, "app-signed.apk"));
		await atomicJson(join(directory, "signing.json"), {
			sha256: sha256(await readFile(join(directory, "app-signed.apk"))),
			signerSha256: expectedSigner,
			package: journal.config.applicationId,
			sourceHash: journal.sourceHash,
		});
	} catch {
		// execFile errors may contain sensitive tool diagnostics. Keep them private.
		await rm(temporary, { force: true });
		throw Error(
			"Local signing failed; check the private keystore configuration. No secrets were uploaded.",
		);
	}
}
async function installUnlocked(
	directory: string,
	serial: string,
	port: string,
) {
	if (
		!/^[a-zA-Z0-9_.:-]+$/.test(serial) ||
		!/^[0-9]+$/.test(port) ||
		Number(port) < 1024 ||
		Number(port) > 65535
	)
		throw Error("Specify an exact device serial and ADB port");
	const journal = await readJournal(directory);
	const apk = join(directory, "app-signed.apk");
	const proof = z
		.object({
			sha256: digest,
			package: z.literal(journal.config.applicationId),
		})
		.parse(JSON.parse(await readFile(join(directory, "signing.json"), "utf8")));
	if (sha256(await readFile(apk)) !== proof.sha256)
		throw Error("Signed APK changed before install");
	await exec("adb", ["-P", port, "-s", serial, "install", "-r", "-t", apk], {
		timeout: 120_000,
	});
}

export async function signBuild(directory: string, env: NodeJS.ProcessEnv) {
	return withBuildLock(directory, () => signUnlocked(directory, env));
}
export async function installBuild(
	directory: string,
	serial: string,
	port = "5037",
) {
	return withBuildLock(directory, () =>
		installUnlocked(directory, serial, port),
	);
}
