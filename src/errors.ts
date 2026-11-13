export type BuildErrorCode =
	| "INVALID_INPUT"
	| "PREPARATION_FAILED"
	| "INVALID_STATE"
	| "LOCKED"
	| "ALLOCATION_UNCERTAIN"
	| "LAUNCH_UNCERTAIN"
	| "OBSERVATION_TIMEOUT"
	| "OBSERVATION_STOPPED"
	| "REMOTE_GONE"
	| "REMOTE_UNAVAILABLE"
	| "BUILD_FAILED"
	| "ARTIFACT_VERIFICATION_FAILED"
	| "ARTIFACT_EXPORT_CONFLICT"
	| "ARTIFACT_EXPORT_FAILED"
	| "RETIREMENT_UNCONFIRMED";
export class BuildError extends Error {
	readonly code: BuildErrorCode;
	constructor(code: BuildErrorCode, message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "BuildError";
		this.code = code;
	}
}
