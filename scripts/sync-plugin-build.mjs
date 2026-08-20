import { cp, lstat, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MIRRORED_PATHS = Object.freeze([
  "src",
  "vendor/lovart-skill",
  "scripts/configure-lovart-credentials.ps1",
  "scripts/verify-macos-credential-helper.mjs",
  "bin/macos/lovart-credential-helper",
  "bin/macos/lovart-credential-helper.sha256",
]);

async function assertNoSymlinkTree(source) {
  const metadata = await lstat(source);
  if (metadata.isSymbolicLink()) {
    throw new Error(`Refusing to synchronize symlinked input: ${source}`);
  }
  if (!metadata.isDirectory()) return;

  for (const entry of await readdir(source)) {
    await assertNoSymlinkTree(path.join(source, entry));
  }
}

export async function syncPluginBuild({ repositoryRoot, pluginRoot }) {
  const paths = MIRRORED_PATHS.map((relative) => ({
    source: path.join(repositoryRoot, relative),
    destination: path.join(pluginRoot, relative),
  }));

  for (const { source } of paths) {
    await assertNoSymlinkTree(source);
  }
  for (const { source, destination } of paths) {
    await rm(destination, { force: true, recursive: true });
    await cp(source, destination, { recursive: true, force: true });
  }
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  const repositoryRoot = path.resolve(path.dirname(scriptPath), "..");
  const pluginRoot = path.join(repositoryRoot, "plugin-build", "lovart");
  await syncPluginBuild({ repositoryRoot, pluginRoot });
}
