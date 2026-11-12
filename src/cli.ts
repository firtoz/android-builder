#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spendingLimit } from "./contracts.js";
import { retireBuild, runBuild } from "./controller.js";
import { readJournal } from "./files.js";
import { prepareBuild } from "./prepare.js";

const help = `Android Builder: recoverable builds on disposable compute
  prepare --config ./android-builder.config.ts --licenses /path/to/sdk/licenses [--root .] [--directory ./build-receipt]
  run --directory ./build-receipt --max-usd 0.20
  status --directory ./build-receipt
  retire --directory ./build-receipt
  sign --directory ./build-receipt
  install --directory ./build-receipt --serial SERIAL [--adb-port 5037]
Prepare reads Git-tracked files and freezes public inputs; it allocates nothing.
Run requires BOAT_API_KEY on the controller; its explicit limit must cover the frozen reservation.
Signing requires local ANDROID_SIGNING_CONFIG, ANDROID_HOME and ANDROID_SIGNER_SHA256.
No automatic build, SDK-license acceptance, device start, upload or store submission.`;
async function main() {
	const [command, ...args] = process.argv.slice(2);
	if (!command || command === "--help") {
		console.log(help);
		return;
	}
	if (
		!["prepare", "run", "status", "retire", "sign", "install"].includes(command)
	)
		throw Error(help);
	const flags = new Map<string, string>();
	for (let n = 0; n < args.length; n += 2) {
		const key = args[n],
			value = args[n + 1];
		if (
			!key ||
			![
				"--config",
				"--licenses",
				"--root",
				"--directory",
				"--max-usd",
				"--serial",
				"--adb-port",
			].includes(key) ||
			!value ||
			flags.has(key)
		)
			throw Error("Unknown, duplicated or missing option");
		flags.set(key, value);
	}
	const required = (name: string) => {
		const v = flags.get(name);
		if (!v) throw Error(`Missing ${name}`);
		return v;
	};
	if (command === "prepare") {
		const configPath = resolve(required("--config"));
		const config = configPath.endsWith(".json")
			? JSON.parse(await readFile(configPath, "utf8"))
			: (await import(pathToFileURL(configPath).href)).default;
		const id = randomUUID(),
			directory = resolve(
				flags.get("--directory") ?? join(".android-builds", id),
			);
		await mkdir(resolve(directory, ".."), { recursive: true, mode: 0o700 });
		const journal = await prepareBuild({
			root: resolve(flags.get("--root") ?? "."),
			directory,
			config,
			licensesDirectory: resolve(required("--licenses")),
			id,
		});
		console.log(
			JSON.stringify({
				id: journal.id,
				directory,
				sourceHash: journal.sourceHash,
				state: journal.state,
				reservationUsd: journal.config.reservationUsd,
			}),
		);
		return;
	}
	const directory = resolve(required("--directory"));
	if (command === "status") {
		const j = await readJournal(directory);
		console.log(
			JSON.stringify(
				{
					id: j.id,
					state: j.state,
					hostId: j.hostId,
					artifactVerified: j.artifactVerified,
					retired: j.retired,
					cleanupError: j.cleanupError,
					outcome: j.outcome,
				},
				null,
				2,
			),
		);
		return;
	}
	{
		if (command === "sign" || command === "install") {
			const signing = await import("./sign.js");
			if (command === "sign") await signing.signBuild(directory, process.env);
			else
				await signing.installBuild(
					directory,
					required("--serial"),
					flags.get("--adb-port") ?? "5037",
				);
			return;
		}
		const journal = await readJournal(directory);
		if (!process.env.BOAT_API_KEY)
			throw Error("Set BOAT_API_KEY on the controller only");
		if (command === "run")
			spendingLimit(flags.get("--max-usd"), journal.config.reservationUsd);
		const { boatTransport } = await import("./providers/boat.js");
		const { transport, close } = boatTransport(
			directory,
			process.env.BOAT_API_KEY,
		);
		try {
			if (command === "retire") {
				if (journal.state === "allocating" && !journal.hostId)
					throw Error(
						"Reconcile the original uncertain allocation before retiring; do not allocate another host",
					);
				await retireBuild(directory, transport);
				return;
			}
			const abort = new AbortController(),
				cancel = () =>
					abort.abort(
						Error(
							"Observation stopped; use the same build directory to resume or retire. No launch will be replayed.",
						),
					);
			process.once("SIGINT", cancel);
			process.once("SIGTERM", cancel);
			try {
				await runBuild(directory, transport, {
					maxUsd: Number(flags.get("--max-usd")),
					signal: abort.signal,
					log: (b) => process.stdout.write(b),
				});
			} finally {
				process.off("SIGINT", cancel);
				process.off("SIGTERM", cancel);
			}
			console.log(
				`Verified artifact: ${join(directory, "artifact.apk")}\nOwned build host retired.`,
			);
		} finally {
			close();
		}
	}
}
main().catch((error: unknown) => {
	console.error(
		error instanceof Error
			? error.message.slice(0, 800)
			: "Build failed; retain its receipt",
	);
	process.exitCode = 1;
});
