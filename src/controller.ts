import { open, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
	ANDROID_BUILD,
	type BuilderTransport,
	type BuildJournal,
	quote,
	remoteStatus,
	sha256,
	spendingLimit,
} from "./contracts.js";
import { BuildError } from "./errors.js";
import {
	atomicJson,
	readJournal,
	saveJournal,
	withBuildLock,
} from "./files.js";

const observation = z.object({
	cursor: z.number().int().nonnegative().max(ANDROID_BUILD.maxLogBytes),
	log: z.string().max(100_000),
	status: remoteStatus.nullable(),
	claimed: z.boolean(),
});
export const remoteRoot = (id: string) =>
	`/tmp/android-builder-${z.uuid().parse(id)}`;
export async function verifyInputs(directory: string, journal: BuildJournal) {
	for (const input of journal.inputs) {
		const bytes = await readFile(join(directory, input.name));
		if (bytes.length !== input.bytes || sha256(bytes) !== input.sha256)
			throw new BuildError(
				"INVALID_INPUT",
				`Frozen input changed: ${input.name}. Preserve this receipt; restore exact original inputs to reconcile, or explicitly retire its owned host. Do not create another identity to recover uncertainty.`,
			);
	}
}
async function retireOwnedBuild(
	directory: string,
	journal: BuildJournal,
	transport: BuilderTransport,
) {
	if (journal.retired || !journal.hostId) return;
	try {
		await transport.retire(journal.hostId, journal.id);
		journal.retired = true;
		journal.cleanupError = false;
		await saveJournal(directory, journal);
	} catch {
		journal.cleanupError = true;
		await saveJournal(directory, journal);
		throw new BuildError(
			"RETIREMENT_UNCONFIRMED",
			`Owned build host retirement is unconfirmed. Preserve build ${journal.id}; retry its retire command. Provider lease remains bounded.`,
		);
	}
}
async function observeBuild(
	directory: string,
	journal: BuildJournal,
	transport: BuilderTransport,
	options: {
		now?: () => number;
		wait?: () => Promise<void>;
		log?: (bytes: Uint8Array) => void;
		signal?: AbortSignal;
		progress?: (journal: BuildJournal) => void;
	} = {},
) {
	if (options.signal?.aborted)
		throw new BuildError(
			"OBSERVATION_STOPPED",
			"Observation stopped; preserve this receipt, remote work may continue",
		);
	options.progress?.(structuredClone(journal));
	const now = options.now ?? Date.now;
	const wait =
		options.wait ??
		(() => new Promise<void>((r) => setTimeout(r, ANDROID_BUILD.pollMs)));
	await verifyInputs(directory, journal);
	const root = remoteRoot(journal.id);
	if (journal.retired && journal.state === "failed")
		throw new BuildError(
			"BUILD_FAILED",
			`Android build failed. Original logs and receipt retained at ${directory}.`,
		);
	if (journal.artifactVerified && journal.outcome?.artifact) {
		const bytes = await readFile(join(directory, "artifact.apk")).catch(
			() => undefined,
		);
		if (
			!bytes ||
			bytes.length !== journal.outcome.artifact.bytes ||
			sha256(bytes) !== journal.outcome.artifact.sha256
		)
			throw new BuildError(
				"ARTIFACT_VERIFICATION_FAILED",
				"Verified artifact changed or is missing; retain the receipt and do not rerun work",
			);
		await retireOwnedBuild(directory, journal, transport);
		return;
	}
	if (journal.retired)
		throw new BuildError(
			"INVALID_STATE",
			"This build host was retired without a verified local artifact. Do not replay its command; prepare a new ID only if a deliberately new build is wanted.",
		);
	if (journal.state === "failed" && journal.outcome) {
		await retireOwnedBuild(directory, journal, transport);
		throw new BuildError(
			"BUILD_FAILED",
			`Android build failed. Original logs and receipt retained at ${directory}.`,
		);
	}
	if (journal.expiresAt && now() >= journal.expiresAt - 30_000)
		throw new BuildError(
			"OBSERVATION_TIMEOUT",
			"Build lease is ending or expired; reconcile or retire the same operation without reallocating",
		);
	if (journal.state === "prepared" || journal.state === "allocating") {
		journal.expiresAt ??= now() + journal.config.lifetimeSeconds * 1000;
		journal.state = "allocating";
		await saveJournal(directory, journal);
		// Jetski persists the same provider idempotency key/body before sending.
		if (options.signal?.aborted)
			throw new BuildError(
				"OBSERVATION_STOPPED",
				"Observation stopped; preserve this receipt, remote work may continue",
			);
		try {
			journal.hostId = await transport.allocate({
				owner: journal.owner,
				operationId: journal.id,
				expiresAt: journal.expiresAt,
			});
		} catch (cause) {
			throw new BuildError(
				"ALLOCATION_UNCERTAIN",
				"Allocation unconfirmed; reconcile the same operation with start, never create a replacement identity",
				{ cause },
			);
		}
		journal.state = "allocated";
		await saveJournal(directory, journal);
	}
	const host = journal.hostId;
	if (!host || !journal.expiresAt)
		throw Error("Missing allocation receipt; refuse to invent another host.");
	if (journal.state === "allocated") {
		await transport.ready(host);
		await transport.command(
			host,
			`mkdir -p ${quote(root)} && chmod 700 ${quote(root)}`,
		);
		for (const input of journal.inputs) {
			const bytes = await readFile(join(directory, input.name));
			const parts: string[] = [];
			for (
				let offset = 0;
				offset < bytes.length;
				offset += ANDROID_BUILD.uploadBytes
			) {
				const path = `${root}/${input.name}.part-${offset}`;
				await transport.upload(
					host,
					path,
					bytes.subarray(offset, offset + ANDROID_BUILD.uploadBytes),
				);
				parts.push(path);
			}
			await transport.command(
				host,
				`cat ${parts.map(quote).join(" ")} > ${quote(`${root}/${input.name}`)} && rm -- ${parts.map(quote).join(" ")}`,
			);
		}
		await transport.upload(
			host,
			`${root}/inputs.json`,
			Buffer.from(JSON.stringify(journal.inputs)),
		);
		const verifier = `import hashlib,json,pathlib; p=pathlib.Path(${JSON.stringify(root)}); rows=json.loads((p/'inputs.json').read_text()); assert rows==${JSON.stringify(journal.inputs)}; assert all((p/r['name']).stat().st_size==r['bytes'] and hashlib.sha256((p/r['name']).read_bytes()).hexdigest()==r['sha256'] for r in rows)`;
		await transport.command(host, `python3 -c ${quote(verifier)}`);
		journal.state = "uploaded";
		await saveJournal(directory, journal);
	}
	if (journal.state === "uploaded") {
		if (options.signal?.aborted)
			throw new BuildError(
				"OBSERVATION_STOPPED",
				"Observation stopped; preserve this receipt, remote work may continue",
			);
		journal.state = "launching";
		await saveJournal(directory, journal);
		try {
			await transport.command(
				host,
				`env -i HOME="$HOME" PATH=/usr/bin:/bin python3 ${quote(`${root}/host.py`)} launch`,
			);
		} catch (cause) {
			throw new BuildError(
				"LAUNCH_UNCERTAIN",
				`Launch acknowledgement lost; observe the same build; never replay. ${cause instanceof Error ? cause.message : ""}`,
				{ cause },
			);
		}
		journal.state = "running";
		await saveJournal(directory, journal);
	}
	const startObservationDeadline = now() + 30_000;
	const log = await open(join(directory, "build.log"), "a+", 0o600);
	try {
		for (;;) {
			if (options.signal?.aborted)
				throw new BuildError(
					"OBSERVATION_STOPPED",
					"Observation stopped; preserve this receipt, remote work may continue",
				);
			if (now() >= journal.expiresAt - 30_000)
				throw new BuildError(
					"OBSERVATION_TIMEOUT",
					`Build lease is ending. Preserve ${journal.id}; do not start another command automatically.`,
				);
			const reply = observation.parse(
				JSON.parse(
					await transport.command(
						host,
						`python3 ${quote(`${root}/host.py`)} observe ${journal.logCursor}`,
					),
				),
			);
			const bytes = Buffer.from(reply.log, "base64");
			if (
				bytes.length > 65_536 ||
				reply.cursor !== journal.logCursor + bytes.length
			)
				throw Error("Build output cursor mismatch");
			if (bytes.length) {
				// Recover from a log-write/journal-ack gap without appending duplicates.
				await log.truncate(journal.logCursor);
				let written = 0;
				while (written < bytes.length) {
					const result = await log.write(
						bytes,
						written,
						bytes.length - written,
					);
					if (!result.bytesWritten) throw Error("Incomplete log write");
					written += result.bytesWritten;
				}
				await log.sync();
				options.log?.(bytes);
			}
			journal.logCursor = reply.cursor;
			if (reply.status) journal.outcome = reply.status;
			options.progress?.(structuredClone(journal));
			await saveJournal(directory, journal);
			if (
				reply.status &&
				reply.status.state !== "running" &&
				bytes.length < 65_536
			) {
				journal.state = reply.status.state;
				await saveJournal(directory, journal);
				break;
			}
			if (!reply.status && reply.claimed && now() >= startObservationDeadline)
				throw new BuildError(
					"LAUNCH_UNCERTAIN",
					`Build ${journal.id} has an uncertain launch claim. Observe status; never replay the launch.`,
				);
			if (!reply.status && !reply.claimed && now() >= startObservationDeadline)
				throw new BuildError(
					"LAUNCH_UNCERTAIN",
					`Launch ${journal.id} was not acknowledged. Reconcile or retire; never replay it.`,
				);
			await wait();
		}
	} finally {
		await log.close();
	}
	if (journal.state === "complete") {
		const artifact = journal.outcome?.artifact;
		if (!artifact)
			throw new BuildError(
				"ARTIFACT_VERIFICATION_FAILED",
				"Successful build omitted its artifact; retain host for investigation.",
			);
		try {
			await transport.download(
				host,
				`${root}/artifact.apk`,
				artifact.bytes,
				join(directory, "artifact.apk"),
				artifact.sha256,
			);
		} catch (cause) {
			throw new BuildError(
				"ARTIFACT_VERIFICATION_FAILED",
				"Artifact transfer was not verified; retain host and observe the same build",
				{ cause },
			);
		}
		const bytes = await readFile(join(directory, "artifact.apk"));
		if (bytes.length !== artifact.bytes || sha256(bytes) !== artifact.sha256)
			throw new BuildError(
				"ARTIFACT_VERIFICATION_FAILED",
				"Artifact transfer verification failed; retain host.",
			);
		journal.artifactVerified = true;
		await saveJournal(directory, journal);
	}
	await atomicJson(join(directory, "result.json"), {
		sourceHash: journal.sourceHash,
		sourceCommit: journal.sourceCommit,
		workingTree: journal.workingTree,
		hostId: host,
		outcome: journal.outcome,
		artifactVerified: journal.artifactVerified,
		reservedUsd: journal.config.reservationUsd,
		admissionAllowanceUsd: journal.config.reservationUsd,
		allowanceMeaning:
			"Operator-supplied per-build admission allowance, not pricing, an account cap or a final invoice",
	});
	await retireOwnedBuild(directory, journal, transport);
	if (journal.state !== "complete")
		throw new BuildError(
			"BUILD_FAILED",
			`Android build failed. Original logs and receipt retained at ${directory}.`,
		);
}

export async function downloadVerified(
	source: {
		read(offset: number, count: number): Promise<Uint8Array>;
		close(): Promise<void>;
	},
	length: number,
	target: string,
	expectedHash: string,
) {
	if (
		!Number.isSafeInteger(length) ||
		length <= 0 ||
		length > ANDROID_BUILD.maxArtifactBytes ||
		!/^[a-f0-9]{64}$/.test(expectedHash)
	)
		throw Error("Invalid artifact metadata");
	const file = await open(`${target}.partial`, "w", 0o600);
	try {
		let offset = 0;
		while (offset < length) {
			const count = Math.min(ANDROID_BUILD.uploadBytes, length - offset);
			const part = await source.read(offset, count);
			if (part.length !== count) throw Error("Incomplete artifact transfer");
			let written = 0;
			while (written < part.length) {
				const result = await file.write(
					part,
					written,
					part.length - written,
					offset + written,
				);
				if (!result.bytesWritten) throw Error("Incomplete artifact write");
				written += result.bytesWritten;
			}
			offset += part.length;
		}
		await file.sync();
	} finally {
		await file.close();
		await source.close();
	}
	if (sha256(await readFile(`${target}.partial`)) !== expectedHash)
		throw Error("Artifact checksum mismatch");
	await rename(`${target}.partial`, target);
}

export interface RunOptions {
	maxUsd: number;
	now?: () => number;
	wait?: () => Promise<void>;
	log?: (bytes: Uint8Array) => void;
	signal?: AbortSignal;
	progress?: (journal: BuildJournal) => void;
	/** Observe/retrieve/finish cleanup only; never allocate or launch. */
	observeOnly?: boolean;
}
/** Resume the durable identity in directory; uncertain launches are observed, never replayed. */
export async function runBuild(
	directory: string,
	transport: BuilderTransport,
	options: RunOptions,
) {
	return withBuildLock(directory, async () => {
		const journal = await readJournal(directory);
		spendingLimit(options.maxUsd, journal.config.reservationUsd);
		if (
			options.observeOnly &&
			["prepared", "allocating", "allocated", "uploaded"].includes(
				journal.state,
			)
		)
			throw new BuildError(
				"INVALID_STATE",
				"Build needs explicit start/admission to continue before launch; use start with the same receipt",
			);
		if (!options.observeOnly && !journal.admission) {
			journal.admission = {
				allowanceUsd: journal.config.reservationUsd,
				operatorLimitUsd: options.maxUsd,
				admittedAt: Date.now(),
			};
			await saveJournal(directory, journal);
		}
		try {
			await observeBuild(directory, journal, transport, options);
		} catch (error) {
			if (error instanceof BuildError && error.code === "REMOTE_GONE") {
				journal.hostAbsent = true;
				await saveJournal(directory, journal);
			}
			throw error;
		}
		return readJournal(directory);
	});
}
export async function retireBuild(
	directory: string,
	transport: BuilderTransport,
) {
	return withBuildLock(directory, async () => {
		const journal = await readJournal(directory);
		if (journal.state === "allocating" && !journal.hostId)
			throw new BuildError(
				"ALLOCATION_UNCERTAIN",
				"Allocation uncertain; reconcile the same operation before retirement",
			);
		await retireOwnedBuild(directory, journal, transport);
		return readJournal(directory);
	});
}
