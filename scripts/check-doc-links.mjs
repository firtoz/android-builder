import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";

const root = resolve(process.argv[2] ?? ".");
const omitted = new Set([".git", ".local", "node_modules", "dist"]);
async function markdownFiles(directory) {
	const found = [];
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		if (omitted.has(entry.name)) continue;
		const path = resolve(directory, entry.name);
		if (entry.isDirectory()) found.push(...(await markdownFiles(path)));
		else if (entry.isFile() && entry.name.endsWith(".md")) found.push(path);
	}
	return found;
}
function anchors(markdown) {
	const found = new Set(),
		duplicates = new Map();
	let fence;
	for (const line of markdown.split("\n")) {
		const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1]?.[0];
		if (marker) {
			if (!fence) fence = marker;
			else if (fence === marker) fence = undefined;
			continue;
		}
		if (fence) continue;
		const title = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line)?.[1];
		if (!title) continue;
		const slug = title
			.toLowerCase()
			.replace(/<[^>]+>/g, "")
			.replace(/[^\p{L}\p{N}_\-\s]/gu, "")
			.replace(/\s/g, "-");
		const count = duplicates.get(slug) ?? 0;
		duplicates.set(slug, count + 1);
		found.add(count ? `${slug}-${count}` : slug);
	}
	for (const match of markdown.matchAll(/\bid=["']([^"']+)["']/g))
		found.add(match[1]);
	return found;
}
const files = await markdownFiles(root),
	contents = new Map();
for (const path of files) contents.set(path, await readFile(path, "utf8"));
const failures = [];
let checked = 0;
for (const [path, markdown] of contents) {
	// Repository docs use inline Markdown links; external URLs are deliberately not fetched.
	for (const match of markdown.matchAll(
		/!?\[[^\]\n]*\]\((<[^>\n]+>|[^\s)]+)(?:\s+"[^"\n]*")?\)/g,
	)) {
		const link = match[1].replace(/^<|>$/g, "");
		if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(link)) continue;
		checked++;
		const [target, fragment] = link.split("#", 2);
		try {
			const destination = target
				? resolve(dirname(path), decodeURIComponent(target))
				: path;
			const info = await stat(destination);
			if (fragment && info.isFile() && destination.endsWith(".md")) {
				const text =
					contents.get(destination) ?? (await readFile(destination, "utf8"));
				if (!anchors(text).has(decodeURIComponent(fragment)))
					throw Error(`missing anchor #${fragment}`);
			}
		} catch (error) {
			failures.push(`${relative(root, path)}: ${link} (${error.message})`);
		}
	}
}
if (failures.length) {
	console.error(failures.join("\n"));
	process.exitCode = 1;
} else
	console.log(
		`Checked ${checked} local links/anchors in ${files.length} Markdown files.`,
	);
