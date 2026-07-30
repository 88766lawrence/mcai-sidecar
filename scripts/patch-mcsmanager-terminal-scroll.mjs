import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const publicDir = process.argv[2] ?? "/opt/mcsmanager/web/public";
const assetsDir = join(publicDir, "assets");
const indexPath = join(publicDir, "index.html");

const indexHtml = await readFile(indexPath, "utf8");
const entryMatch = indexHtml.match(/src="\.\/assets\/(index-[^"]+\.js)"/);
if (!entryMatch) throw new Error("MCSManager entry bundle was not found");

const entryName = entryMatch[1];
if (entryName.endsWith("-scrollfix.js")) {
  console.log(`Terminal scroll fix is already active: ${entryName}`);
  process.exit(0);
}

const entryPath = join(assetsDir, entryName);
const entrySource = await readFile(entryPath, "utf8");
const mountMatch = entrySource.match(/mount-[a-z0-9]+\.js/i);
if (!mountMatch) throw new Error("MCSManager terminal bundle was not found");

const mountName = mountMatch[0];
const mountPath = join(assetsDir, mountName);
const mountSource = await readFile(mountPath, "utf8");
const inputMarker = 'TXT_CODE_555e2c1b';
const markerIndex = mountSource.indexOf(inputMarker);
if (markerIndex < 0) throw new Error("Terminal command input marker was not found");

const autofocusIndex = mountSource.indexOf('autofocus:""', markerIndex);
if (autofocusIndex < 0 || autofocusIndex - markerIndex > 500) {
  throw new Error("Terminal autofocus attribute was not found near the command input");
}

const patchedMount =
  mountSource.slice(0, autofocusIndex) +
  "autofocus:!1" +
  mountSource.slice(autofocusIndex + 'autofocus:""'.length);
const patchedMountName = mountName.replace(/\.js$/, "-scrollfix.js");
const patchedEntryName = entryName.replace(/\.js$/, "-scrollfix.js");
const patchedEntry = entrySource.replaceAll(mountName, patchedMountName);
const patchedIndex = indexHtml.replace(entryName, patchedEntryName);

await writeFile(join(assetsDir, patchedMountName), patchedMount, "utf8");
await writeFile(join(assetsDir, patchedEntryName), patchedEntry, "utf8");
await writeFile(indexPath, patchedIndex, "utf8");

console.log(JSON.stringify({
  entry: patchedEntryName,
  terminal: patchedMountName,
  change: "disabled terminal command input autofocus",
}, null, 2));
