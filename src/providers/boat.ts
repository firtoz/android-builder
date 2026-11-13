import { join } from "node:path";
import {
	BoatApi,
	BoatHostProvider,
	type BoatMachineType,
} from "@firtoz/jetski/providers/boat";
import { SqliteState } from "@firtoz/jetski/state/sqlite";
import type { BuilderTransport } from "../contracts.js";
import { downloadVerified } from "../controller.js";
import { BuildError } from "../errors.js";

/** Dedicated full build VMs; this never claims a Podman/gVisor workload is ready. */
export function boatTransport(
	directory: string,
	token: string,
	options: { machine?: BoatMachineType } = {},
): { transport: BuilderTransport; close(): void } {
	const api = new BoatApi(token);
	const state = new SqliteState(join(directory, "provider.sqlite"));
	const provider = new BoatHostProvider(
		state,
		api,
		{
			request: async () => {
				throw Error("Dedicated builder has no sandbox runtime attestation");
			},
		},
		options.machine ?? "large",
	);
	return {
		close: () => state.close(),
		transport: {
			allocate: async (input) => (await provider.allocate(input)).id,
			ready: async (host) => {
				const deadline = Date.now() + 90_000;
				while (Date.now() < deadline) {
					const r = await api.call(
						`/sandboxes/${host}`,
						"GET",
						undefined,
						undefined,
						{ timeoutMs: 15_000 },
					);
					if (r.status === 404)
						throw new BuildError(
							"REMOTE_GONE",
							"Owned build host disappeared; do not allocate a replacement automatically",
						);
					const value = r.value.sandbox;
					if (
						r.status === 200 &&
						value &&
						typeof value === "object" &&
						!Array.isArray(value) &&
						["ready", "idle", "running"].includes(String(value.state))
					)
						return;
					await new Promise((resolve) => setTimeout(resolve, 5_000));
				}
				throw Error(
					"Build host readiness remains uncertain. Resume the same ID; no second VM was allocated.",
				);
			},
			command: async (host, command) => {
				const r = await api.call(
					`/sandboxes/${host}/commands`,
					"POST",
					{ command, timeoutSeconds: 20, detached: false, stream: false },
					undefined,
					{ timeoutMs: 30_000, maxBytes: 512 * 1024 },
				);
				if (r.status === 404)
					throw new BuildError(
						"REMOTE_GONE",
						"Owned build host is absent; remote artifact may be unrecoverable. Preserve its receipt",
					);
				if (
					r.status !== 200 ||
					r.value.exitCode !== 0 ||
					typeof r.value.stdout !== "string"
				)
					throw Error(
						`Build-host command unconfirmed (${r.status}). No automatic command replay.`,
					);
				return r.value.stdout;
			},
			upload: (host, path, bytes) => api.uploadFile(host, path, bytes),
			download: async (host, path, bytes, target, expectedHash) =>
				downloadVerified(
					await api.openDownload(host, path, bytes, { sequential: true }),
					bytes,
					target,
					expectedHash,
				),
			retire: (host, operationId) => provider.retire(host, operationId),
		},
	};
}

/** Convenience factory; credentials are read only when an operation opens it. */
export function boatProvider(
	options: { machine?: BoatMachineType; token?: () => string | undefined } = {},
): import("../builder.js").BuildProvider {
	const machine = options.machine ?? "large";
	return {
		id: `boat:${machine}`,
		async open(directory) {
			const token = options.token ? options.token() : process.env.BOAT_API_KEY;
			if (!token)
				throw new BuildError(
					"INVALID_INPUT",
					"Supply controller-only BOAT_API_KEY",
				);
			return boatTransport(directory, token, { machine });
		},
	};
}
