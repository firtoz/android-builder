import { opendir } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { BuildInspection } from "./builder.js";
import type { BuildJournal } from "./contracts.js";
import { BuildError } from "./errors.js";
import { readJournal } from "./files.js";

export function receiptOutcomes(
	j: BuildJournal,
): Pick<BuildInspection, "work" | "cleanup"> {
	return {
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
	};
}
export interface BuildListItem
	extends Pick<BuildInspection, "id" | "directory" | "work" | "cleanup"> {
	preparedAt: number;
	applicationId: string;
	project: BuildJournal["config"]["project"]["kind"];
	state: BuildJournal["state"];
	artifactVerified: boolean;
	hostAbsent: boolean;
	cleanupError: boolean;
}
export interface BuildHistory {
	version: 1;
	directory: string;
	builds: BuildListItem[];
	total: number;
	issues: { directory: string; code: "RECEIPT_UNAVAILABLE"; message: string }[];
}
/** Offline, direct child receipts only; no provider calls or lock mutation. */
export async function listBuilds(
	directory: string,
	options: { limit?: number } = {},
): Promise<BuildHistory> {
	const base = resolve(directory),
		limit = options.limit ?? 20;
	if (!Number.isInteger(limit) || limit < 1 || limit > 100)
		throw new BuildError(
			"INVALID_INPUT",
			"Build history limit must be an integer from 1 to 100",
		);
	const result: BuildHistory = {
		version: 1,
		directory: base,
		builds: [],
		total: 0,
		issues: [],
	};
	const children: string[] = [];
	try {
		const folder = await opendir(base);
		let count = 0;
		for await (const entry of folder) {
			if (++count > 1000)
				throw new BuildError(
					"INVALID_INPUT",
					"Receipt parent exceeds the 1000-entry listing bound; select a smaller parent or inspect exact receipts",
				);
			if (entry.isDirectory() && !entry.name.startsWith("."))
				children.push(join(base, entry.name));
		}
	} catch (cause) {
		if ((cause as NodeJS.ErrnoException).code === "ENOENT") return result;
		if (cause instanceof BuildError) throw cause;
		throw new BuildError(
			"INVALID_INPUT",
			"Cannot read the private receipt parent directory",
			{ cause },
		);
	}
	for (const receipt of children.sort()) {
		try {
			const j = await readJournal(receipt);
			result.builds.push({
				id: j.id,
				directory: receipt,
				preparedAt: j.preparedAt,
				applicationId: j.config.applicationId,
				project: j.config.project.kind,
				state: j.state,
				...receiptOutcomes(j),
				artifactVerified: j.artifactVerified,
				hostAbsent: j.hostAbsent,
				cleanupError: j.cleanupError,
			});
		} catch {
			result.issues.push({
				directory: receipt,
				code: "RECEIPT_UNAVAILABLE",
				message:
					"No readable complete build journal; inspect the original directory without deleting it. Preparation may be incomplete.",
			});
		}
	}
	result.total = result.builds.length;
	result.builds.sort(
		(a, b) =>
			b.preparedAt - a.preparedAt ||
			a.id.localeCompare(b.id) ||
			a.directory.localeCompare(b.directory),
	);
	result.builds = result.builds.slice(0, limit);
	return result;
}
