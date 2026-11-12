import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	buildJournal,
	defineBuildConfig,
	sha256,
	spendingLimit,
} from "../dist/contracts.js";
import { exec, saveJournal, withBuildLock } from "../dist/files.js";
import {
	downloadVerified,
	readJournal,
	runBuild,
	sourceAllowed,
} from "../dist/index.js";

const apk = Buffer.from("simulated artifact; not an Android compile");
const config = () =>
	defineBuildConfig({
		project: { kind: "gradle" },
		artifact: "app/build/outputs/apk/debug/app-debug.apk",
		applicationId: "org.example.hello",
		reservationUsd: 0.142,
	});
async function fixture() {
	const directory = await mkdtemp(join(tmpdir(), "android-builder-"));
	const journal = buildJournal.parse({
		version: 1,
		id: randomUUID(),
		owner: randomUUID(),
		preparedAt: Date.now(),
		sourceHash: sha256("source"),
		sourceCommit: "a".repeat(40),
		workingTree: true,
		config: config(),
		inputs: [{ name: "source.tgz", bytes: 6, sha256: sha256("source") }],
		state: "prepared",
	});
	await writeFile(join(directory, "source.tgz"), "source");
	await saveJournal(directory, journal);
	const stats = { allocations: [], launches: 0, retirements: 0 };
	const flags = { loseAck: false, fail: false, corrupt: false };
	const transport = {
		allocate: async (input) => {
			stats.allocations.push(input);
			return "owned_fixture";
		},
		ready: async () => {},
		upload: async () => {},
		command: async (_host, text) => {
			if (text.endsWith(" launch")) {
				stats.launches++;
				if (flags.loseAck) throw Error("lost ack");
			}
			if (text.includes(" observe "))
				return JSON.stringify({
					cursor: 0,
					log: "",
					claimed: true,
					status: {
						state: flags.fail ? "failed" : "complete",
						phase: "build",
						timings: [],
						...(!flags.fail
							? { artifact: { bytes: apk.length, sha256: sha256(apk) } }
							: {}),
					},
				});
			return "";
		},
		download: async (_host, _path, _bytes, target) =>
			writeFile(target, flags.corrupt ? "corrupt" : apk),
		retire: async () => {
			stats.retirements++;
		},
	};
	return {
		directory,
		journal,
		stats,
		flags,
		transport,
		cleanup: () => rm(directory, { recursive: true, force: true }),
	};
}
test("configuration, source exclusion and explicit budget fail closed", () => {
	assert.throws(() => spendingLimit(undefined, 0.142));
	assert.throws(() => spendingLimit(0.1, 0.142));
	assert.equal(spendingLimit(0.2, 0.142), 0.2);
	assert.throws(() =>
		defineBuildConfig({ ...config(), executionSeconds: 3500 }),
	);
	assert.throws(() =>
		defineBuildConfig({ ...config(), project: { kind: "other" } }),
	);
	assert.throws(() =>
		defineBuildConfig({
			...config(),
			publicEnvironment: { SERVICE_TOKEN: "do not upload" },
		}),
	);
	for (const file of [
		".env.local",
		"app/.dev.vars",
		"app/google-services.json",
		"private.p12",
		"../secret",
		"app/node_modules/main.js",
		"dist/main.js",
	])
		assert.equal(sourceAllowed(file), false, file);
	for (const file of [
		"app/build.gradle",
		"gradle/wrapper/gradle-wrapper.jar",
		"app/src/main/AndroidManifest.xml",
	])
		assert.equal(sourceAllowed(file), true, file);
});
test("verified artifact and cleanup are durable, repeated run never reallocates", async () => {
	const f = await fixture();
	try {
		await runBuild(f.directory, f.transport, { maxUsd: 0.2 });
		await runBuild(f.directory, f.transport, { maxUsd: 0.2 });
		assert.equal(f.stats.allocations.length, 1);
		assert.equal(f.stats.launches, 1);
		assert.equal(f.stats.retirements, 1);
		assert.equal((await readJournal(f.directory)).artifactVerified, true);
	} finally {
		await f.cleanup();
	}
});
test("lost launch acknowledgement reconnects without repeating the launch", async () => {
	const f = await fixture();
	try {
		f.flags.loseAck = true;
		await assert.rejects(
			runBuild(f.directory, f.transport, { maxUsd: 0.2 }),
			/lost ack/,
		);
		assert.equal((await readJournal(f.directory)).state, "launching");
		await runBuild(f.directory, f.transport, { maxUsd: 0.2 });
		assert.equal(f.stats.launches, 1);
		assert.equal(f.stats.allocations.length, 1);
		assert.equal(f.stats.retirements, 1);
	} finally {
		await f.cleanup();
	}
});
test("frozen input change prevents allocation and failed builds preserve outcomes", async () => {
	const f = await fixture();
	try {
		await writeFile(join(f.directory, "source.tgz"), "changed");
		await assert.rejects(
			runBuild(f.directory, f.transport, { maxUsd: 0.2 }),
			/Frozen input changed/,
		);
		assert.equal(f.stats.allocations.length, 0);
	} finally {
		await f.cleanup();
	}
	const g = await fixture();
	try {
		g.flags.fail = true;
		await assert.rejects(
			runBuild(g.directory, g.transport, { maxUsd: 0.2 }),
			/Android build failed/,
		);
		const journal = await readJournal(g.directory);
		assert.equal(journal.state, "failed");
		assert.equal(journal.retired, true);
		assert.equal(journal.artifactVerified, false);
	} finally {
		await g.cleanup();
	}
});
test("corrupt transfer retains source and does not acknowledge verified output", async () => {
	const f = await fixture();
	try {
		f.flags.corrupt = true;
		await assert.rejects(
			runBuild(f.directory, f.transport, { maxUsd: 0.2 }),
			/verification failed/,
		);
		assert.equal(f.stats.retirements, 0);
		assert.equal((await readJournal(f.directory)).artifactVerified, false);
	} finally {
		await f.cleanup();
	}
});
test("embedded controllers cannot run concurrently", async () => {
	const f = await fixture();
	try {
		await withBuildLock(f.directory, async () => {
			await assert.rejects(
				runBuild(f.directory, f.transport, { maxUsd: 0.2 }),
				/locked/,
			);
		});
		assert.equal(f.stats.allocations.length, 0);
	} finally {
		await f.cleanup();
	}
});
test("partial transfer closes reader without publishing; exact binary transfer works", async () => {
	const f = await fixture();
	let closed = 0;
	try {
		await assert.rejects(
			downloadVerified(
				{
					read: async () => new Uint8Array(1),
					close: async () => {
						closed++;
					},
				},
				20,
				join(f.directory, "missing.apk"),
				sha256(apk),
			),
			/Incomplete/,
		);
		assert.equal(closed, 1);
		await assert.rejects(readFile(join(f.directory, "missing.apk")));
		await downloadVerified(
			{
				read: async (offset, count) => apk.subarray(offset, offset + count),
				close: async () => {
					closed++;
				},
			},
			apk.length,
			join(f.directory, "good.apk"),
			sha256(apk),
		);
		assert.deepEqual(await readFile(join(f.directory, "good.apk")), apk);
		assert.equal(closed, 2);
	} finally {
		await f.cleanup();
	}
});
test("real host claim is preserved without repeating uncertain work", async () => {
	const f = await fixture();
	try {
		await writeFile(
			join(f.directory, "host.py"),
			await readFile("host/host.py"),
		);
		await writeFile(join(f.directory, "launch.claim"), "uncertain");
		const r = await exec("python3", [join(f.directory, "host.py"), "launch"]);
		assert.deepEqual(JSON.parse(r.stdout), { existing: true });
		await assert.rejects(readFile(join(f.directory, "process.json")));
	} finally {
		await f.cleanup();
	}
});
test("real stage records elapsed time and preserves command working directory", async () => {
	const f = await fixture();
	try {
		await writeFile(
			join(f.directory, "host.py"),
			await readFile("host/host.py"),
		);
		await writeFile(
			join(f.directory, "status.json"),
			JSON.stringify({ state: "running", phase: "test", timings: [] }),
		);
		const cwd = join(f.directory, "nested");
		await mkdir(cwd);
		await exec(
			"python3",
			[
				join(f.directory, "host.py"),
				"stage",
				"cwd",
				"python3",
				"-c",
				"import os; print(os.getcwd())",
			],
			{ cwd },
		);
		assert.match(
			await readFile(join(f.directory, "build.log"), "utf8"),
			new RegExp(cwd),
		);
		assert.equal(
			JSON.parse(await readFile(join(f.directory, "status.json"), "utf8"))
				.timings[0].exitCode,
			0,
		);
	} finally {
		await f.cleanup();
	}
});

test("real first launch records one failed outcome and refuses a second process", async () => {
	const f = await fixture();
	try {
		await writeFile(
			join(f.directory, "host.py"),
			await readFile("host/host.py"),
		);
		await writeFile(
			join(f.directory, "inputs.json"),
			JSON.stringify([{ name: "missing", bytes: 1, sha256: "0".repeat(64) }]),
		);
		await writeFile(
			join(f.directory, "config.json"),
			JSON.stringify({ executionSeconds: 10 }),
		);
		const command = [join(f.directory, "host.py"), "launch"];
		assert.deepEqual(JSON.parse((await exec("python3", command)).stdout), {
			started: true,
		});
		let result;
		for (let attempt = 0; attempt < 100; attempt++) {
			try {
				result = JSON.parse(
					await readFile(join(f.directory, "status.json"), "utf8"),
				);
			} catch {}
			if (result?.state === "failed") break;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		assert.equal(result?.state, "failed");
		const receipt = await readFile(join(f.directory, "process.json"), "utf8");
		assert.deepEqual(JSON.parse((await exec("python3", command)).stdout), {
			existing: true,
		});
		assert.equal(
			await readFile(join(f.directory, "process.json"), "utf8"),
			receipt,
		);
	} finally {
		await f.cleanup();
	}
});

test("cleanup retry uses the verified local artifact without remote observation or a second build", async () => {
	const f = await fixture();
	try {
		let retireCalls = 0;
		f.transport.retire = async () => {
			if (++retireCalls === 1) throw Error("lost cleanup acknowledgement");
		};
		await assert.rejects(
			runBuild(f.directory, f.transport, { maxUsd: 0.2 }),
			/retirement is unconfirmed/,
		);
		assert.equal((await readJournal(f.directory)).artifactVerified, true);
		f.transport.command = async () => {
			throw Error("must not call host again");
		};
		await runBuild(f.directory, f.transport, { maxUsd: 0.2 });
		assert.equal((await readJournal(f.directory)).retired, true);
		assert.equal(f.stats.allocations.length, 1);
		assert.equal(f.stats.launches, 1);
	} finally {
		await f.cleanup();
	}
});

test("expired uncertain allocation does not allocate again", async () => {
	const f = await fixture();
	try {
		await saveJournal(f.directory, {
			...f.journal,
			state: "allocating",
			expiresAt: 10,
		});
		await assert.rejects(
			runBuild(f.directory, f.transport, { maxUsd: 0.2 }),
			/lease is ending or expired/,
		);
		assert.equal(f.stats.allocations.length, 0);
	} finally {
		await f.cleanup();
	}
});
