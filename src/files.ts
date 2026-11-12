import { execFile } from "node:child_process";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { type BuildJournal, buildJournal } from "./contracts.js";
export const exec = promisify(execFile);
export async function atomicJson(path: string, value: unknown) {
	const temporary = `${path}.next`;
	const file = await open(temporary, "w", 0o600);
	try {
		await file.writeFile(`${JSON.stringify(value, null, 2)}\n`);
		await file.sync();
	} finally {
		await file.close();
	}
	await rename(temporary, path);
	const directory = await open(dirname(path), "r");
	try {
		await directory.sync();
	} finally {
		await directory.close();
	}
}
export const readJournal = async (directory: string) =>
	buildJournal.parse(
		JSON.parse(await readFile(join(directory, "build.json"), "utf8")),
	);
export const saveJournal = (directory: string, journal: BuildJournal) =>
	atomicJson(join(directory, "build.json"), buildJournal.parse(journal));
/** A stale lock requires operator inspection; process IDs can be reused. */
export async function withBuildLock<T>(
	directory: string,
	operation: () => Promise<T>,
): Promise<T> {
	const lock = join(directory, "controller.lock");
	await mkdir(lock, { mode: 0o700 }).catch(() => {
		throw Error(
			"Build is locked. Inspect its controller before removing a stale lock; never run duplicate controllers.",
		);
	});
	try {
		await writeFile(
			join(lock, "owner.json"),
			JSON.stringify({ pid: process.pid, startedAt: Date.now() }),
			{ mode: 0o600, flag: "wx" },
		);
		return await operation();
	} finally {
		await rm(lock, { recursive: true });
	}
}
