import { type VerifiedArtifact, verifiedArtifact } from "./artifacts.js";
import type { BuildInspection } from "./builder.js";
import { BuildError, type BuildErrorCode } from "./errors.js";

export interface BuildIssue {
	code: BuildErrorCode;
	message: string;
}
interface CompletionDetails {
	version: 1;
	buildId: string;
	receiptDirectory: string;
	work: BuildInspection["work"];
	cleanup: BuildInspection["cleanup"];
	applicationId: string;
	source: { commit: string; hash: string; workingTree: boolean };
	phase?: string;
	exitCode?: number;
	timings: { phase: string; seconds: number; exitCode: number }[];
	issues: BuildIssue[];
	nextCommand: string;
}
export type BuildCompletion = CompletionDetails &
	(
		| { outcome: "succeeded"; artifact: VerifiedArtifact }
		| { outcome: "failed"; artifact?: never }
		| { outcome: "needs-attention"; artifact?: VerifiedArtifact }
	);
/** Compact domain result, omitting source inventories and public environment. */
export async function buildCompletion(
	build: BuildInspection,
	problem?: BuildError,
): Promise<BuildCompletion> {
	const j = build.journal,
		issues: BuildIssue[] = [];
	const add = (code: BuildErrorCode, message: string) => {
		if (!issues.some((v) => v.code === code)) issues.push({ code, message });
	};
	if (build.work === "failed")
		add(
			"BUILD_FAILED",
			"The original build failed; its outcome and logs remain in the private receipt",
		);
	if (problem) add(problem.code, problem.message);
	let artifact: VerifiedArtifact | undefined;
	if (build.work === "complete") {
		try {
			artifact = await verifiedArtifact(build.directory);
		} catch (cause) {
			if (!(cause instanceof BuildError)) throw cause;
			add(cause.code, cause.message);
		}
	}
	if (j.cleanupError)
		add(
			"RETIREMENT_UNCONFIRMED",
			"Owned host retirement remains unconfirmed; reconcile the same receipt",
		);
	const details: CompletionDetails = {
		version: 1,
		buildId: build.id,
		receiptDirectory: build.directory,
		work: build.work,
		cleanup: build.cleanup,
		applicationId: j.config.applicationId,
		source: {
			commit: j.sourceCommit,
			hash: j.sourceHash,
			workingTree: j.workingTree,
		},
		phase: j.outcome?.phase,
		exitCode: j.outcome?.exitCode,
		timings: structuredClone(j.outcome?.timings ?? []),
		issues,
		nextCommand: build.nextCommand,
	};
	if (build.work === "failed") return { ...details, outcome: "failed" };
	if (artifact && build.cleanup === "retired" && !issues.length)
		return { ...details, outcome: "succeeded", artifact };
	if (!issues.length)
		add(
			"INVALID_STATE",
			"No fully retrieved and retired terminal outcome is confirmed; reconcile the same receipt",
		);
	return {
		...details,
		outcome: "needs-attention",
		...(artifact ? { artifact } : {}),
	};
}
