import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MIRRORED_PATHS, syncPluginBuild } from "../scripts/sync-plugin-build.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mirroredPaths = MIRRORED_PATHS;

function trackedFiles(root, relative) {
  const source = path.join(root, relative);
  if (!statSync(source).isDirectory()) return [relative];
  return readdirSync(source, { recursive: true })
    .map((entry) => path.join(relative, entry))
    .filter((entry) => statSync(path.join(root, entry)).isFile())
    .sort();
}

test("repository is a Codex Git marketplace for the built plugin", () => {
  const manifest = JSON.parse(readFileSync(path.join(root, ".agents/plugins/marketplace.json"), "utf8"));

  assert.equal(manifest.name, "lovart-codex");
  assert.deepEqual(manifest.plugins[0].source, {
    source: "local",
    path: "./plugin-build/lovart",
  });
});

test("synchronization copies every declared mirrored path", async () => {
  const temporaryPluginRoot = mkdtempSync(path.join(tmpdir(), "lovart-plugin-build-"));

  try {
    await syncPluginBuild({ repositoryRoot: root, pluginRoot: temporaryPluginRoot });

    assert.equal(new Set(MIRRORED_PATHS).size, MIRRORED_PATHS.length, "mirrored paths must be unique");
    for (const relative of MIRRORED_PATHS) {
      const canonicalFiles = trackedFiles(root, relative);
      const synchronizedFiles = trackedFiles(temporaryPluginRoot, relative);
      assert.deepEqual(synchronizedFiles, canonicalFiles, `sync omitted files from ${relative}`);
      for (const file of canonicalFiles) {
        assert.deepEqual(readFileSync(path.join(root, file)), readFileSync(path.join(temporaryPluginRoot, file)));
      }
    }
  } finally {
    rmSync(temporaryPluginRoot, { force: true, recursive: true });
  }
});

test("every mirrored path in the checked-in plugin build matches its canonical source", () => {
  for (const relative of mirroredPaths) {
    const canonicalFiles = trackedFiles(root, relative);
    const pluginFiles = trackedFiles(path.join(root, "plugin-build", "lovart"), relative);
    assert.deepEqual(pluginFiles, canonicalFiles, `mirrored file set drifted at ${relative}`);
    for (const file of canonicalFiles) {
      assert.deepEqual(
        readFileSync(path.join(root, file)),
        readFileSync(path.join(root, "plugin-build", "lovart", file)),
        `mirrored content drifted at ${file}`,
      );
    }
  }
});

test("sync removes stale files from existing mirrored directories", async () => {
  const temporaryPluginRoot = mkdtempSync(path.join(tmpdir(), "lovart-plugin-build-"));
  const staleFile = path.join(temporaryPluginRoot, "src", "obsolete.js");

  try {
    mkdirSync(path.dirname(staleFile), { recursive: true });
    writeFileSync(staleFile, "obsolete generated file");

    await syncPluginBuild({ repositoryRoot: root, pluginRoot: temporaryPluginRoot });

    assert.equal(existsSync(staleFile), false);
  } finally {
    rmSync(temporaryPluginRoot, { force: true, recursive: true });
  }
});

test("sync rejects symlinked canonical inputs", async () => {
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), "lovart-plugin-source-"));
  const output = mkdtempSync(path.join(tmpdir(), "lovart-plugin-output-"));

  try {
    for (const relative of mirroredPaths) {
      const source = path.join(root, relative);
      const destination = path.join(fixtureRoot, relative);
      mkdirSync(path.dirname(destination), { recursive: true });
      cpSync(source, destination, { recursive: true });
    }
    rmSync(path.join(fixtureRoot, "src"), { force: true, recursive: true });
    symlinkSync(path.join(root, "src"), path.join(fixtureRoot, "src"));

    await assert.rejects(
      () => syncPluginBuild({ repositoryRoot: fixtureRoot, pluginRoot: output }),
      /symlink/i,
    );
  } finally {
    rmSync(fixtureRoot, { force: true, recursive: true });
    rmSync(output, { force: true, recursive: true });
  }
});
