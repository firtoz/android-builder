import { randomUUID } from "node:crypto";
import { access, mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { BuilderTransport, BuildJournal } from "./contracts.js";
import { quote, sha256, spendingLimit } from "./contracts.js";
import { type RunOptions, retireBuild, runBuild } from "./controller.js";
import type { PreparationReport } from "./diagnostics.js";
import { BuildError } from "./errors.js";
import { atomicJson, readJournal } from "./files.js";
import { type PrepareOptions, prepareBuild } from "./prepare.js";

/** Controller-side factory. id must identify immutable provider/machine settings. */
export interface BuildProvider {
	id: string;
	open(
		directory: string,
	): Promise<{ transport: BuilderTransport; close(): void | Promise<void> }>;
}
const boat: BuildProvider = {
	id: "boat:large",
	async open(directory) {
		const { boatProvider } = await import("./providers/boat.js");
		return boatProvider().open(directory);
	},
};
export interface BuildInspection {
	version: 1;
	id: string;
	directory: string;
	journal: BuildJournal;
	preparation?: PreparationReport;
	provider: string;
	work: "not-started" | "unresolved" | "running" | "complete" | "failed";
	cleanup: "not-allocated" | "unresolved" | "retired";
	artifact?: string;
	admissionAllowanceUsd: number;
	nextCommand: string;
}
export class BuildOperationError extends BuildError {
	constructor(
		error: BuildError,
		readonly build: BuildInspection,
	) {
		super(error.code, error.message, { cause: error });
	}
}
export class BuildPreparationError extends BuildError {
	readonly nextCommand: string;
	constructor(
		cause: unknown,
		readonly id: string,
		readonly directory: string,
		reportAvailable = false,
	) {
		super(
			"PREPARATION_FAILED",
			cause instanceof Error
				? cause.message
				: "Preparation failed before allocation",
			{ cause },
		);
		this.nextCommand = reportAvailable
			? `android-builder inspect --directory ${quote(directory)}`
			: "android-builder --help";
	}
}
export interface ObserveOptions {
	signal?: AbortSignal;
	log?: RunOptions["log"];
	progress?: RunOptions["progress"];
}
export interface BuildHandle {
	readonly id: string;
	readonly directory: string;
	inspect(): Promise<BuildInspection>;
	start(
		options: ObserveOptions & { admitUsd: number },
	): Promise<BuildInspection>;
	/** Never allocates or launches; retrieves artifacts and retries owned cleanup. */
	observe(options?: ObserveOptions): Promise<BuildInspection>;
	retire(): Promise<BuildInspection>;
	artifact(): Promise<string>;
}
export function createBuilder(
	options: { receiptsDirectory?: string; provider?: BuildProvider } = {},
) {
	const provider = options.provider ?? boat;
	if (!provider.id || provider.id.length > 200)
		throw new BuildError(
			"INVALID_INPUT",
			"Provider requires a stable settings identity",
		);
	const base = resolve(options.receiptsDirectory ?? ".android-builds");
	function handle(directory: string, id: string): BuildHandle {
		const providerIdentity = async () => {
			try {
				return String(
					JSON.parse(await readFile(join(directory, "provider.json"), "utf8"))
						.id,
				);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				return "boat:large";
			}
		};
		const inspect = async (): Promise<BuildInspection> => {
			const j = await readJournal(directory);
			let preparation: PreparationReport | undefined;
			try {
				preparation = JSON.parse(
					await readFile(join(directory, "preparation-report.json"), "utf8"),
				);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			const early = [
				"prepared",
				"allocating",
				"allocated",
				"uploaded",
			].includes(j.state);
			const command =
				j.hostAbsent || j.retired
					? "inspect"
					: j.cleanupError
						? "retire"
						: early
							? "start"
							: "observe";
			return {
				version: 1,
				id: j.id,
				directory,
				journal: j,
				preparation,
				provider: await providerIdentity(),
				work:
					j.state === "prepared"
						? "not-started"
						: j.state === "complete" || j.state === "failed"
							? j.state
							: j.state === "running"
								? "running"
								: "unresolved",
				cleanup: j.retired
					? "retired"
					: j.state === "prepared"
						? "not-allocated"
						: "unresolved",
				artifact: j.artifactVerified
					? join(directory, "artifact.apk")
					: undefined,
				admissionAllowanceUsd: j.config.reservationUsd,
				nextCommand: `android-builder ${command} --directory ${quote(directory)}${command === "start" ? ` --admit-usd ${j.config.reservationUsd}` : ""}`,
			};
		};
		const operate = async (
			operation: (transport: BuilderTransport) => Promise<unknown>,
		) => {
			try {
				if ((await providerIdentity()) !== provider.id)
					throw new BuildError(
						"INVALID_INPUT",
						"Supply the same provider adapter/settings recorded in this receipt",
					);
				const adapter = await provider.open(directory);
				try {
					await operation(adapter.transport);
				} finally {
					await adapter.close();
				}
				return await inspect();
			} catch (cause) {
				const snapshot = await inspect();
				const error =
					cause instanceof BuildError
						? cause
						: new BuildError(
								"REMOTE_UNAVAILABLE",
								"Remote operation unconfirmed; keep the receipt and reconcile its existing identity",
								{ cause },
							);
				throw new BuildOperationError(error, snapshot);
			}
		};
		return {
			id,
			directory,
			inspect,
			start: async ({ admitUsd, ...opts }) => {
				try {
					spendingLimit(
						admitUsd,
						(await readJournal(directory)).config.reservationUsd,
					);
				} catch (cause) {
					throw new BuildOperationError(
						new BuildError(
							"INVALID_INPUT",
							cause instanceof Error ? cause.message : "Invalid admission",
						),
						await inspect(),
					);
				}
				return operate((transport) =>
					runBuild(directory, transport, { ...opts, maxUsd: admitUsd }),
				);
			},
			observe: async (opts = {}) => {
				const j = await readJournal(directory);
				if (
					["prepared", "allocating", "allocated", "uploaded"].includes(j.state)
				)
					throw new BuildOperationError(
						new BuildError(
							"INVALID_STATE",
							"Build needs explicit start/admission to continue before launch; use start with the same receipt",
						),
						await inspect(),
					);
				return operate((transport) =>
					runBuild(directory, transport, {
						...opts,
						maxUsd: j.config.reservationUsd,
						observeOnly: true,
					}),
				);
			},
			retire: async () => {
				const j = await readJournal(directory);
				if (j.state === "prepared") return inspect();
				if (j.state === "allocating" && !j.hostId)
					throw new BuildOperationError(
						new BuildError(
							"ALLOCATION_UNCERTAIN",
							"Allocation uncertain; reconcile the same operation before retirement",
						),
						await inspect(),
					);
				return operate((transport) => retireBuild(directory, transport));
			},
			artifact: async () => {
				const j = await readJournal(directory);
				const bytes = await readFile(join(directory, "artifact.apk")).catch(
					() => undefined,
				);
				if (
					!j.artifactVerified ||
					!bytes ||
					bytes.length !== j.outcome?.artifact?.bytes ||
					sha256(bytes) !== j.outcome.artifact.sha256
				)
					throw new BuildOperationError(
						new BuildError(
							"ARTIFACT_VERIFICATION_FAILED",
							"No verified local artifact; retain the receipt and source host",
						),
						await inspect(),
					);
				return join(directory, "artifact.apk");
			},
		};
	}
	return {
		async prepare(
			input: Omit<PrepareOptions, "directory"> & { directory?: string },
		): Promise<BuildHandle> {
			if (
				input.id &&
				!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
					input.id,
				)
			)
				throw new BuildError("INVALID_INPUT", "Specify an exact build UUID");
			const id = input.id ?? randomUUID(),
				directory = resolve(input.directory ?? join(base, id));
			try {
				await mkdir(dirname(directory), { recursive: true, mode: 0o700 });
				const j = await prepareBuild({ ...input, id, directory });
				await atomicJson(join(directory, "provider.json"), {
					version: 1,
					id: provider.id,
				});
				return handle(directory, j.id);
			} catch (cause) {
				throw new BuildPreparationError(
					cause,
					id,
					directory,
					await access(join(directory, "preparation-report.json")).then(
						() => true,
						() => false,
					),
				);
			}
		},
		async reconnect(
			receipt: { id: string } | { directory: string },
		): Promise<BuildHandle> {
			if (
				"id" in receipt &&
				!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
					receipt.id,
				)
			)
				throw new BuildError("INVALID_INPUT", "Specify an exact build UUID");
			const directory =
				"directory" in receipt
					? resolve(receipt.directory)
					: join(base, receipt.id);
			const j = await readJournal(directory);
			if ("id" in receipt && j.id.toLowerCase() !== receipt.id.toLowerCase())
				throw new BuildError(
					"INVALID_INPUT",
					"Receipt identity differs from the requested ID",
				);
			return handle(directory, j.id);
		},
	};
}
