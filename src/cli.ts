#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
	type BuildHandle,
	type BuildInspection,
	BuildOperationError,
	BuildPreparationError,
	type BuildProvider,
	createBuilder,
} from "./builder.js";
import { BuildError } from "./errors.js";
import type { BuildCompletion } from "./results.js";

const help = `Android Builder — trusted-source debug APK builds on disposable compute
  prepare --config ./android-builder.config.ts --licenses PATH [--root .] [--directory PATH]
  inspect --directory PATH                  Offline receipt and preparation report
  start --directory PATH --admit-usd 0.20 [--no-wait]  Authorize/continue; return after launch if requested
  list [--receipts-directory PATH] [--limit 20]       Offline recent builds; no remote refresh
  observe --directory PATH                  Reconnect, retrieve APK, finish cleanup; never launch
  wait --directory PATH                     Observe and return compact typed completion; never launch
  export --directory PATH --output PATH      Atomically export a verified local APK; no provider required
  retire --directory PATH                   Explicit positively owned retirement
  sign --directory PATH
  install --directory PATH --serial SERIAL [--adb-port 5037]
Options: --json (one versioned JSON result on stdout; progress/logs on stderr)
  --id UUID --receipts-directory PATH can replace --directory for existing receipts.
  --provider-module PATH loads a trusted controller module exporting provider: BuildProvider.
Aliases: run = start, status = inspect, --max-usd = --admit-usd (legacy).
Prepare allocates nothing. Start persists identity before remote effects; never use a new ID to retry uncertainty.
--no-wait leaves remote work running; observe the same receipt before lease expiry to retrieve and finish cleanup.
Ctrl-C stops observation, not necessarily remote compilation. Keep private durable receipts.
Admission is an operator per-build allowance, NOT a price quote, account cap or invoice guarantee.
Default provider/machine: Boat Large; BOAT_API_KEY stays on the controller.
Full lease includes cold setup, execution and transfer headroom. No automatic SDK-license acceptance.
Signing/install are separate local operations; see docs/signing.md.`;
let context: BuildHandle | undefined;
let json = false;
let requestedDirectory: string | undefined;
let compactErrors = false;
const emit = (value: unknown, human: string) =>
	console.log(json ? JSON.stringify(value) : human);
function summary(build: BuildInspection) {
	const j = build.journal,
		c = j.config,
		p = build.preparation;
	const origin = (key: string) =>
		p?.provenance[key] ? ` (${p.provenance[key]})` : "";
	return [
		`Build ${build.id}`,
		`Receipt: ${build.directory}`,
		`Work: ${build.work}; cleanup: ${build.cleanup}`,
		`Provider: ${build.provider}`,
		`Project: ${c.project.kind}, ${p?.projectDirectory ?? c.project.directory}`,
		`Source: ${j.sourceCommit}; selected inputs ${j.workingTree ? "include working-tree changes" : "match HEAD"}`,
		`Tasks: ${c.gradle.tasks.join(" ")}${origin("gradle.tasks")}`,
		`APK output: ${c.artifact}${origin("artifact")}`,
		`Expected application: ${c.applicationId}${origin("applicationId")}`,
		`Package manager: ${c.packageManager ? `${c.packageManager.kind}@${c.packageManager.version}` : "none (no dependency install)"}${origin("packageManager")}`,
		`SDK ${c.toolchain.sdk}${origin("toolchain.sdk")}; build tools ${c.toolchain.buildTools}${origin("toolchain.buildTools")}`,
		`Expected ABIs: ${c.abis?.join(", ") ?? "not constrained"}`,
		`Admission allowance: $${build.admissionAllowanceUsd} (operator-supplied; not pricing or an account cap)`,
		`Lease: ${c.lifetimeSeconds}s; execution (including setup): ${c.executionSeconds}s; upload/readiness/transfer consume the remaining lease`,
		...(p
			? [
					`Frozen files: ${p.included.length} included, ${p.excluded.length} excluded. Report: ${join(build.directory, "preparation-report.json")}`,
					...p.warnings.slice(0, 8).map((w) => `Preparation note: ${w}`),
				]
			: []),
		...(build.artifact ? [`Verified APK receipt: ${build.artifact}`] : []),
		`Next safe command: ${build.nextCommand}`,
	].join("\n");
}
function completionSummary(result: BuildCompletion) {
	return [
		`Build ${result.buildId}`,
		`Outcome: ${result.outcome}; work: ${result.work}; cleanup: ${result.cleanup}`,
		`Receipt: ${result.receiptDirectory}`,
		...(result.artifact
			? [
					`Verified APK: ${result.artifact.path}`,
					`SHA-256: ${result.artifact.sha256}`,
				]
			: []),
		...result.issues.map((i) => `${i.code}: ${i.message}`),
		`Next safe command: ${result.nextCommand}`,
	].join("\n");
}
async function main() {
	const [given, ...args] = process.argv.slice(2);
	if (!given || given === "--help" || args.includes("--help")) {
		console.log(help);
		return;
	}
	json = args.includes("--json");
	const command =
		given === "run" ? "start" : given === "status" ? "inspect" : given;
	compactErrors = command === "wait" || command === "export";
	const allowed: Record<string, string[]> = {
		prepare: [
			"--config",
			"--licenses",
			"--root",
			"--directory",
			"--receipts-directory",
			"--provider-module",
		],
		inspect: ["--directory", "--id", "--receipts-directory"],
		list: ["--receipts-directory", "--limit"],
		start: [
			"--directory",
			"--id",
			"--receipts-directory",
			"--provider-module",
			"--admit-usd",
			"--max-usd",
			"--no-wait",
		],
		observe: [
			"--directory",
			"--id",
			"--receipts-directory",
			"--provider-module",
		],
		wait: ["--directory", "--id", "--receipts-directory", "--provider-module"],
		export: ["--directory", "--id", "--receipts-directory", "--output"],
		retire: [
			"--directory",
			"--id",
			"--receipts-directory",
			"--provider-module",
		],
		sign: ["--directory", "--id", "--receipts-directory"],
		install: [
			"--directory",
			"--id",
			"--receipts-directory",
			"--serial",
			"--adb-port",
		],
	};
	const permitted = allowed[command];
	if (!permitted)
		throw new BuildError(
			"INVALID_INPUT",
			`Unknown command ${given}; use --help`,
		);
	const flags = new Map<string, string>();
	for (let n = 0; n < args.length; n++) {
		const key = args[n];
		if (key === "--json" || (key === "--no-wait" && command === "start")) {
			if (flags.has(key))
				throw new BuildError("INVALID_INPUT", `Duplicated ${key}`);
			flags.set(key, "true");
			continue;
		}
		const value = args[++n];
		if (
			!key ||
			!permitted.includes(key) ||
			!value ||
			value.startsWith("--") ||
			flags.has(key)
		)
			throw new BuildError(
				"INVALID_INPUT",
				"Unknown, duplicated or missing option; use --help",
			);
		flags.set(key, value);
	}
	const required = (key: string) => {
		const v = flags.get(key);
		if (!v) throw new BuildError("INVALID_INPUT", `Missing ${key}`);
		return v;
	};
	if (flags.has("--directory") && flags.has("--id"))
		throw new BuildError("INVALID_INPUT", "Choose --directory or --id");
	let provider: BuildProvider | undefined;
	if (flags.has("--provider-module")) {
		provider = (
			await import(pathToFileURL(resolve(required("--provider-module"))).href)
		).provider;
		if (
			!provider ||
			typeof provider.id !== "string" ||
			typeof provider.open !== "function"
		)
			throw new BuildError(
				"INVALID_INPUT",
				"Provider module must export provider: BuildProvider",
			);
	}
	const builder = createBuilder({
		receiptsDirectory: flags.get("--receipts-directory"),
		provider,
	});
	if (command === "list") {
		const history = await builder.list({
			limit: flags.has("--limit") ? Number(required("--limit")) : undefined,
		});
		emit(
			{ version: 1, ok: true, history },
			[
				`Recent builds: ${history.builds.length} of ${history.total} in ${history.directory} (offline recorded state)`,
				...history.builds.map(
					(b) =>
						`${b.id}  ${b.applicationId}  work=${b.work}  cleanup=${b.cleanup}  artifact=${b.artifactVerified ? "verified receipt" : "not retrieved"}\n  ${b.directory}`,
				),
				...history.issues.map(
					(i) => `Receipt issue: ${i.directory}: ${i.message}`,
				),
			].join("\n"),
		);
		return;
	}
	if (command === "prepare") {
		const configPath = resolve(required("--config"));
		const config = configPath.endsWith(".json")
			? JSON.parse(await readFile(configPath, "utf8"))
			: (await import(pathToFileURL(configPath).href)).default;
		requestedDirectory = flags.get("--directory");
		context = await builder.prepare({
			root: resolve(flags.get("--root") ?? "."),
			directory: requestedDirectory,
			config,
			licensesDirectory: resolve(required("--licenses")),
		});
		const build = await context.inspect();
		emit(
			{ version: 1, ok: true, build },
			`${summary(build)}\nReview ${join(build.directory, "preparation-report.json")} before authorizing start.`,
		);
		return;
	}
	requestedDirectory = flags.get("--directory");
	if (command === "inspect" && requestedDirectory) {
		const directory = resolve(requestedDirectory);
		try {
			await readFile(join(directory, "build.json"));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			const preparation = JSON.parse(
				await readFile(join(directory, "preparation-report.json"), "utf8"),
			);
			emit(
				{ version: 1, ok: true, preparation },
				`Build ${preparation.id} preparation report: ${directory}\nNo prepared build journal; no allocation was authorized.\n${preparation.errors.join("\n")}`,
			);
			return;
		}
	}
	context = await builder.reconnect(
		requestedDirectory
			? { directory: requestedDirectory }
			: { id: required("--id") },
	);
	if (command === "inspect") {
		const build = await context.inspect();
		emit(
			{ version: 1, ok: true, build },
			`${summary(build)}\nOffline inspection only; no provider was contacted.`,
		);
		return;
	}
	if (command === "export") {
		const artifact = await context.exportArtifact(required("--output"));
		emit(
			{ version: 1, ok: true, artifact },
			`Verified APK exported: ${artifact.path}\nBuild: ${artifact.buildId}\nSHA-256: ${artifact.sha256}`,
		);
		return;
	}
	if (command === "sign" || command === "install") {
		const signing = await import("./sign.js");
		if (command === "sign")
			await signing.signBuild(context.directory, process.env);
		else
			await signing.installBuild(
				context.directory,
				required("--serial"),
				flags.get("--adb-port") ?? "5037",
			);
		emit(
			{
				version: 1,
				ok: true,
				operation: command,
				id: context.id,
				directory: context.directory,
			},
			`${command} completed for ${context.id}`,
		);
		return;
	}
	if (command === "retire") {
		const build = await context.retire();
		emit({ version: 1, ok: true, build }, summary(build));
		return;
	}
	const abort = new AbortController();
	const cancel = () =>
		abort.abort(
			new BuildError(
				"OBSERVATION_STOPPED",
				"Observation stopped; the remote build may continue. Reconnect using this receipt.",
			),
		);
	process.once("SIGINT", cancel);
	process.once("SIGTERM", cancel);
	let phase = "";
	const opts = {
		signal: abort.signal,
		log: (b: Uint8Array) => process.stderr.write(b),
		progress: (j: BuildInspection["journal"]) => {
			const next = `${j.state}: ${j.outcome?.phase ?? "connecting"}`;
			if (next !== phase) {
				process.stderr.write(`${next}\n`);
				phase = next;
			}
		},
	};
	try {
		if (flags.has("--admit-usd") && flags.has("--max-usd"))
			throw new BuildError(
				"INVALID_INPUT",
				"Choose --admit-usd; do not combine it with legacy --max-usd",
			);
		if (command === "wait") {
			const result = await context.wait(opts);
			emit(
				{ version: 1, ok: result.outcome === "succeeded", result },
				completionSummary(result),
			);
			process.exitCode = result.outcome === "succeeded" ? 0 : 1;
			return;
		}
		const build =
			command === "start"
				? await context.start({
						...opts,
						admitUsd: Number(flags.get("--admit-usd") ?? required("--max-usd")),
						waitForCompletion: !flags.has("--no-wait"),
					})
				: await context.observe(opts);
		emit({ version: 1, ok: true, build }, summary(build));
	} finally {
		process.off("SIGINT", cancel);
		process.off("SIGTERM", cancel);
	}
}
main().catch(async (cause: unknown) => {
	const error =
		cause instanceof BuildError
			? cause
			: new BuildError(
					"INVALID_INPUT",
					cause instanceof Error
						? cause.message.slice(0, 800)
						: "Operation failed; retain the receipt",
				);
	const build =
		cause instanceof BuildOperationError
			? cause.build
			: await context?.inspect().catch(() => undefined);
	const message = error.message.slice(0, 2000);
	const preparationFailure =
		cause instanceof BuildPreparationError
			? {
					id: cause.id,
					directory: cause.directory,
					nextCommand: cause.nextCommand,
				}
			: undefined;
	if (compactErrors && json) {
		console.log(
			JSON.stringify({
				version: 1,
				ok: false,
				error: { code: error.code, message },
				...(build
					? {
							recovery: {
								buildId: build.id,
								receiptDirectory: build.directory,
								work: build.work,
								cleanup: build.cleanup,
								nextCommand: build.nextCommand,
							},
						}
					: {}),
			}),
		);
	} else if (json)
		console.log(
			JSON.stringify({
				version: 1,
				ok: false,
				error: { code: error.code, message },
				build,
				directory:
					build?.directory ??
					preparationFailure?.directory ??
					requestedDirectory,
				preparationFailure,
			}),
		);
	else
		console.error(
			`${error.code}: ${message}${build ? `\n${summary(build)}` : ""}${preparationFailure ? `\nBuild ${preparationFailure.id}\nReceipt: ${preparationFailure.directory}\nNext safe command: ${preparationFailure.nextCommand}` : ""}`,
		);
	process.exitCode =
		error.code === "INVALID_INPUT" || error.code === "PREPARATION_FAILED"
			? 2
			: 1;
});
