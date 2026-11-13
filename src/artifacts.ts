import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, mkdir, open, realpath, rm } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { ANDROID_BUILD, type BuildJournal } from "./contracts.js";
import { BuildError } from "./errors.js";
import { readJournal, withBuildLock } from "./files.js";

export interface VerifiedArtifact {
	path: string;
	buildId: string;
	bytes: number;
	sha256: string;
	applicationId: string;
	sourceHash: string;
}
function proof(directory: string, j: BuildJournal): VerifiedArtifact {
	if (j.state !== "complete" || !j.artifactVerified || !j.outcome?.artifact)
		throw new BuildError(
			"ARTIFACT_VERIFICATION_FAILED",
			"No verified complete build artifact; retain the original receipt and source host",
		);
	return {
		path: join(resolve(directory), "artifact.apk"),
		buildId: j.id,
		bytes: j.outcome.artifact.bytes,
		sha256: j.outcome.artifact.sha256,
		applicationId: j.config.applicationId,
		sourceHash: j.sourceHash,
	};
}
async function readExactArtifact(
	path: string,
	expected: VerifiedArtifact,
	write?: (bytes: Uint8Array) => Promise<void>,
) {
	const file = await open(
		path,
		constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
	).catch((cause: unknown) => {
		throw new BuildError(
			"ARTIFACT_VERIFICATION_FAILED",
			"Verified artifact is missing, unreadable or a symbolic link",
			{ cause },
		);
	});
	try {
		const info = await file.stat();
		if (!info.isFile() || info.size !== expected.bytes)
			throw new BuildError(
				"ARTIFACT_VERIFICATION_FAILED",
				"Artifact size or file type differs from its receipt",
			);
		const hash = createHash("sha256"),
			buffer = Buffer.alloc(
				Math.min(ANDROID_BUILD.uploadBytes, expected.bytes),
			);
		let offset = 0;
		while (offset < expected.bytes) {
			const { bytesRead } = await file.read(
				buffer,
				0,
				Math.min(buffer.length, expected.bytes - offset),
				offset,
			);
			if (!bytesRead)
				throw new BuildError(
					"ARTIFACT_VERIFICATION_FAILED",
					"Incomplete local artifact read",
				);
			const part = buffer.subarray(0, bytesRead);
			hash.update(part);
			if (write) await write(part);
			offset += bytesRead;
		}
		if (
			(await file.read(buffer, 0, 1, offset)).bytesRead ||
			hash.digest("hex") !== expected.sha256
		)
			throw new BuildError(
				"ARTIFACT_VERIFICATION_FAILED",
				"Artifact checksum or length differs from its receipt",
			);
	} finally {
		await file.close();
	}
}
/** Current local byte verification only; no provider, signer or account action. */
export async function verifiedArtifact(
	directory: string,
): Promise<VerifiedArtifact> {
	const expected = proof(directory, await readJournal(directory));
	await readExactArtifact(expected.path, expected);
	return expected;
}
/** Atomic no-overwrite export. Retries accept an existing identical regular file. */
export async function exportVerifiedArtifact(
	directory: string,
	destination: string,
): Promise<VerifiedArtifact> {
	return withBuildLock(directory, async () => {
		const expected = proof(directory, await readJournal(directory)),
			receipt = await realpath(directory),
			target = resolve(destination);
		const inside = (path: string) =>
			path === receipt || path.startsWith(`${receipt}${sep}`);
		if (
			inside(target) ||
			target === resolve(directory) ||
			target.startsWith(`${resolve(directory)}${sep}`)
		)
			throw new BuildError(
				"INVALID_INPUT",
				"Export outside the original receipt; frozen inputs and provider state must not be overwritten",
			);
		await mkdir(dirname(target), { recursive: true, mode: 0o700 });
		const parent = await realpath(dirname(target)),
			output = join(parent, basename(target));
		if (inside(output))
			throw new BuildError(
				"INVALID_INPUT",
				"Export target resolves inside the original receipt",
			);
		const temporary = join(parent, `.android-builder-${randomUUID()}.partial`);
		try {
			const file = await open(temporary, "wx", 0o600);
			try {
				await readExactArtifact(expected.path, expected, async (part) => {
					let written = 0;
					while (written < part.length) {
						const result = await file.write(
							part,
							written,
							part.length - written,
						);
						if (!result.bytesWritten)
							throw new BuildError(
								"ARTIFACT_EXPORT_FAILED",
								"Incomplete artifact export write",
							);
						written += result.bytesWritten;
					}
				});
				await file.sync();
			} finally {
				await file.close();
			}
			try {
				await link(temporary, output);
			} catch (cause) {
				if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
				try {
					await readExactArtifact(output, expected);
				} catch {
					throw new BuildError(
						"ARTIFACT_EXPORT_CONFLICT",
						"Export destination exists with different bytes or is not a regular file; choose a build-specific output path",
					);
				}
			}
			const folder = await open(parent, "r");
			try {
				await folder.sync();
			} finally {
				await folder.close();
			}
			return { ...expected, path: output };
		} catch (cause) {
			if (cause instanceof BuildError) throw cause;
			throw new BuildError(
				"ARTIFACT_EXPORT_FAILED",
				"Local artifact export was not confirmed; preserve its receipt and retry the same destination",
				{ cause },
			);
		} finally {
			await rm(temporary, { force: true });
		}
	});
}
