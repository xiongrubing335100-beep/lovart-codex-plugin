import hashlib
import json
import multiprocessing
import os
import errno
import shutil
import tempfile
import threading
import unittest
import warnings
import zipfile
from pathlib import Path
from typing import Union
from unittest import mock

import scripts.release_package as release_package
from scripts.release_package import ReleaseError, build_release, verify_release


def abandon_publication_lock(destination: str) -> None:
    with release_package._publication_lock(Path(destination)):
        os._exit(0)


def write_fixture_source(root: Path, relative: str, content: Union[str, bytes]) -> None:
    destination = root / "plugin-build" / "lovart" / relative
    destination.parent.mkdir(parents=True, exist_ok=True)
    if isinstance(content, bytes):
        destination.write_bytes(content)
    else:
        destination.write_text(content, encoding="utf-8")


def make_fixture_source(root: Path) -> Path:
    (root / ".agents" / "plugins").mkdir(parents=True)
    (root / ".agents" / "plugins" / "marketplace.json").write_text(
        json.dumps(
            {
                "name": "lovart-codex",
                "plugins": [{"name": "lovart", "source": {"source": "local", "path": "./plugin-build/lovart"}}],
            }
        ),
        encoding="utf-8",
    )
    files = {
        ".codex-plugin/plugin.json": '{"version":"0.2.0"}\n',
        ".mcp.json": "{}\n",
        "README.md": "fixture\n",
        "assets/logo.svg": "<svg/>\n",
        "package.json": '{"name":"fixture","version":"0.2.0"}\n',
        "package-lock.json": '{"lockfileVersion":3,"packages":{}}\n',
        "scripts/start-mcp.mjs": "console.log('fixture');\n",
        "scripts/verify-macos-credential-helper.mjs": "console.log('fixture');\n",
        "scripts/configure-lovart-credentials.ps1": (
            "Add-Type -AssemblyName System.Windows.Forms\n"
            "$akBox.UseSystemPasswordChar = $true\n"
            "$skBox.UseSystemPasswordChar = $true\n"
            '[Environment]::SetEnvironmentVariable("LOVART_ACCESS_KEY", $accessKey, "User")\n'
            '[Environment]::SetEnvironmentVariable("LOVART_SECRET_KEY", $secretKey, "User")\n'
            "[void]$form.ShowDialog()\n"
        ),
        "skills/lovart/SKILL.md": "fixture\n",
        "src/index.js": "export {};\n",
        "vendor/lovart-skill/SKILL.md": "fixture\n",
        "bin/macos/lovart-credential-helper": b"fixture helper\n",
    }
    for relative, content in files.items():
        write_fixture_source(root, relative, content)
    helper = root / "plugin-build" / "lovart" / "bin" / "macos" / "lovart-credential-helper"
    helper.chmod(0o755)
    dependencies = root / "dependency-source" / "fixture-package"
    dependencies.mkdir(parents=True)
    (dependencies / "package.json").write_text('{"name":"fixture-package"}\n', encoding="utf-8")
    return root / "dependency-source"


def build_fixture_release(platform: str, root: Path, output: Path) -> Path:
    return build_release(root, platform, "0.2.0", output, root / "dependency-source")


def archive_names(archive: Path) -> set[str]:
    with zipfile.ZipFile(archive) as package:
        return set(package.namelist())


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_checksum_sidecar(archive: Path) -> None:
    Path(str(archive) + ".sha256").write_bytes(
        ("{}  {}\n".format(sha256(archive), archive.name)).encode("ascii"),
    )


def make_zip(root: Path, platform: str, members: list[tuple[str, bytes, int]]) -> Path:
    archive = root / release_package._archive_filename(platform, "0.2.0")
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", UserWarning)
        with zipfile.ZipFile(archive, "w") as package:
            for name, contents, mode in members:
                entry = zipfile.ZipInfo(name)
                entry.create_system = 3
                entry.external_attr = mode << 16
                package.writestr(entry, contents)
    write_checksum_sidecar(archive)
    return archive


def replace_archive_member(archive: Path, member_name: str, contents: bytes) -> None:
    replacement = archive.with_name("replacement-" + archive.name)
    with zipfile.ZipFile(archive) as source, zipfile.ZipFile(replacement, "w") as output:
        for member in source.infolist():
            entry = zipfile.ZipInfo(member.filename, member.date_time)
            entry.create_system = member.create_system
            entry.external_attr = member.external_attr
            entry.compress_type = member.compress_type
            payload = contents if member.filename == member_name else source.read(member)
            output.writestr(entry, payload)
    os.replace(replacement, archive)
    write_checksum_sidecar(archive)


class ReleasePackageTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary_directory.name) / "repository"
        self.root.mkdir()
        self.output = self.root / "release-output"
        make_fixture_source(self.root)

    def tearDown(self) -> None:
        self.temporary_directory.cleanup()

    def test_macos_archive_contains_only_runtime_files_and_universal_helper(self):
        with mock.patch.object(release_package, "_verify_macos_extracted_helper"):
            archive = build_fixture_release("macos", self.root, self.output)
        names = archive_names(archive)
        self.assertIn("lovart-codex-plugin/.agents/plugins/marketplace.json", names)
        self.assertIn("lovart-codex-plugin/plugins/lovart/bin/macos/lovart-credential-helper", names)
        self.assertNotIn("lovart-codex-plugin/plugins/lovart/scripts/configure-lovart-credentials.ps1", names)

    def test_windows_archive_contains_powershell_and_no_native_macos_binary(self):
        archive = build_fixture_release("windows", self.root, self.output)
        names = archive_names(archive)
        self.assertIn("lovart-codex-plugin/plugins/lovart/scripts/configure-lovart-credentials.ps1", names)
        self.assertIn("lovart-codex-plugin/plugins/lovart/scripts/verify-macos-credential-helper.mjs", names)
        self.assertNotIn("lovart-codex-plugin/plugins/lovart/bin/macos/lovart-credential-helper", names)

    def test_verifier_rejects_path_traversal_member(self):
        archive = make_zip(self.root, "windows", [("../outside.txt", b"x", 0o100644)])
        with self.assertRaisesRegex(ReleaseError, "unsafe archive path"):
            verify_release(archive, "windows", "0.2.0", self.root)

    def test_verifier_rejects_absolute_duplicate_and_symlink_members(self):
        cases = {
            "absolute": [("/outside.txt", b"x", 0o100644)],
            "duplicate": [
                ("lovart-codex-plugin/duplicate.txt", b"one", 0o100644),
                ("lovart-codex-plugin/duplicate.txt", b"two", 0o100644),
            ],
            "symlink": [("lovart-codex-plugin/link", b"target", 0o120777)],
            "unexpected-top-level": [("outside.txt", b"x", 0o100644)],
        }
        for name, members in cases.items():
            with self.subTest(name=name):
                archive = make_zip(self.root, "windows", members)
                with self.assertRaisesRegex(ReleaseError, "unsafe archive path|unexpected archive top-level path|duplicate archive member|symlink|non-regular"):
                    verify_release(archive, "windows", "0.2.0", self.root)

    def test_verifier_rejects_checksum_mismatch(self):
        archive = build_fixture_release("windows", self.root, self.output)
        archive.write_bytes(archive.read_bytes() + b"tampered")
        with self.assertRaisesRegex(ReleaseError, "checksum mismatch"):
            verify_release(archive, "windows", "0.2.0", self.root)

    def test_verifier_rejects_wrong_platform_subtree(self):
        archive = build_fixture_release("windows", self.root, self.output)
        with zipfile.ZipFile(archive, "a") as package:
            entry = zipfile.ZipInfo("lovart-codex-plugin/plugins/lovart/bin/macos/unexpected-helper")
            entry.create_system = 3
            entry.external_attr = (0o100755) << 16
            package.writestr(entry, b"unexpected")
        write_checksum_sidecar(archive)
        with self.assertRaisesRegex(ReleaseError, "unexpected archive member"):
            verify_release(archive, "windows", "0.2.0", self.root)

    def test_verifier_rejects_windows_setup_script_without_the_local_ui_contract(self):
        write_fixture_source(self.root, "scripts/configure-lovart-credentials.ps1", "Write-Output fixture\n")
        with self.assertRaisesRegex(ReleaseError, "PowerShell"):
            build_fixture_release("windows", self.root, self.output)

    def test_macos_verifier_runs_the_existing_helper_verifier_after_safe_extraction(self):
        with mock.patch.object(
            release_package,
            "_verify_macos_extracted_helper",
            create=True,
        ) as verifier:
            build_fixture_release("macos", self.root, self.output)
        verifier.assert_called_once()

    def test_verifier_rejects_unallowlisted_project_member(self):
        archive = build_fixture_release("windows", self.root, self.output)
        with zipfile.ZipFile(archive, "a") as package:
            entry = zipfile.ZipInfo("lovart-codex-plugin/plugins/lovart/.env")
            entry.create_system = 3
            entry.external_attr = (0o100644) << 16
            package.writestr(entry, b"local state")
        write_checksum_sidecar(archive)
        with self.assertRaisesRegex(ReleaseError, "unexpected archive member"):
            verify_release(archive, "windows", "0.2.0")

    def test_verifier_binds_windows_setup_bytes_to_the_trusted_source(self):
        archive = build_fixture_release("windows", self.root, self.output)
        replace_archive_member(
            archive,
            "lovart-codex-plugin/plugins/lovart/scripts/configure-lovart-credentials.ps1",
            b"# altered but superficially valid\n" + (
                self.root / "plugin-build" / "lovart" / "scripts" / "configure-lovart-credentials.ps1"
            ).read_bytes(),
        )
        with self.assertRaisesRegex(ReleaseError, "trusted source"):
            verify_release(archive, "windows", "0.2.0", self.root)

    def test_verifier_uses_the_trusted_macos_verifier_not_candidate_archive_code(self):
        with mock.patch.object(release_package, "_verify_macos_extracted_helper") as verifier:
            build_fixture_release("macos", self.root, self.output)
        verifier.assert_called_once()
        self.assertEqual(verifier.call_args.args[0], (self.root / "plugin-build" / "lovart").resolve())

    def test_verifier_rejects_casefold_collision_ads_reserved_and_nonregular_modes(self):
        cases = {
            "casefold": [
                ("lovart-codex-plugin/plugins/lovart/README.md", b"a", 0o100644),
                ("lovart-codex-plugin/plugins/lovart/readme.md", b"b", 0o100644),
            ],
            "ads": [("lovart-codex-plugin/plugins/lovart/README.md:evil", b"a", 0o100644)],
            "reserved": [("lovart-codex-plugin/plugins/lovart/CON", b"a", 0o100644)],
            "fifo": [("lovart-codex-plugin/plugins/lovart/README.md", b"a", 0o010644)],
        }
        for case, members in cases.items():
            with self.subTest(case=case):
                archive = make_zip(self.root, "windows", members)
                with self.assertRaisesRegex(ReleaseError, "casefold|unsafe archive path|non-regular"):
                    verify_release(archive, "windows", "0.2.0")

    def test_verifier_uses_an_immutable_snapshot_for_hash_and_metadata(self):
        archive = build_fixture_release("windows", self.root, self.output)
        expected_hash = sha256(archive)
        original_copy = release_package._copy_no_follow
        calls = 0

        def mutate_after_archive_snapshot(source, destination):
            nonlocal calls
            result = original_copy(source, destination)
            if Path(source) == archive:
                calls += 1
                archive.write_bytes(archive.read_bytes() + b"concurrent mutation")
            return result

        with mock.patch.object(release_package, "_copy_no_follow", side_effect=mutate_after_archive_snapshot):
            result = verify_release(archive, "windows", "0.2.0", self.root)
        self.assertEqual(calls, 1)
        self.assertEqual(result["archiveSha256"], expected_hash)

    def test_secret_like_payload_aborts_before_archive_publication(self):
        write_fixture_source(self.root, "README.md", "LOVART_SECRET_KEY='sk_abcdefghijklmnopqrstuvwxyz123456'")
        with self.assertRaisesRegex(ReleaseError, "secret-like content"):
            build_fixture_release("windows", self.root, self.output)
        self.assertEqual(list(self.output.glob("*.zip")), [])

    def test_security_scan_rejects_a_tracked_release_input_without_publishing_an_archive(self):
        # Replacing the scan with packaging-only validation would make a CI
        # preflight unable to stop a credential before archive work begins.
        write_fixture_source(self.root, "src/config.json", '{"LOVART_ACCESS_KEY": "opaque-scan-key"}\n')
        with self.assertRaisesRegex(ReleaseError, "secret-like content"):
            release_package.scan_release_inputs(self.root)
        self.assertEqual(list(self.output.glob("*.zip")), [])
        self.assertEqual(list(self.output.glob("*.zip.sha256")), [])

    def test_security_scan_ignores_non_shipped_files_but_rejects_runtime_credentials(self):
        # Scanning every fixture makes CI fail on intentionally adversarial
        # test data; dropping the runtime scan would let archive input through.
        write_fixture_source(self.root, "test/non-shipped.json", '{"LOVART_SECRET_KEY": "fixture-only-secret"}\n')
        release_package.scan_release_inputs(self.root)
        write_fixture_source(self.root, "src/runtime-config.json", '{"LOVART_SECRET_KEY": "runtime-secret"}\n')
        with self.assertRaisesRegex(ReleaseError, "secret-like content"):
            release_package.scan_release_inputs(self.root)
        self.assertEqual(list(self.output.glob("*.zip")), [])
        self.assertEqual(list(self.output.glob("*.zip.sha256")), [])

    def test_utf8_bom_json_credentials_abort_before_archive_publication(self):
        # Changing JSON decoding back to Latin-1-only would miss escaped,
        # nested mixed-case keys after their actual JSON interpretation.
        payload = b"\xef\xbb\xbf" + (
            '{"outer":[{"LoVaRt_\\u0053eCrEt_Key":"opaque-unicode-json-secret"}]}\n'
        ).encode("utf-8")
        write_fixture_source(self.root, "src/utf8-bom-config.json", payload)
        with self.assertRaisesRegex(ReleaseError, "secret-like content"):
            build_fixture_release("windows", self.root, self.output)
        self.assertEqual(list(self.output.glob("*.zip")), [])
        self.assertEqual(list(self.output.glob("*.zip.sha256")), [])

    def test_preflight_scans_nested_node_modules_inside_allowlisted_assets(self):
        # Restoring unconditional node_modules pruning would hide a shipped
        # asset from both preflight and packaging-time credential checks.
        payload = b"\xef\xbb\xbf" + (
            '{"nested":{"LoVaRt_\\u0053eCrEt_Key":"opaque-asset-secret"}}\n'
        ).encode("utf-8")
        write_fixture_source(self.root, "assets/node_modules/x.json", payload)
        with self.assertRaisesRegex(ReleaseError, "secret-like content"):
            release_package.scan_release_inputs(self.root)
        with self.assertRaisesRegex(ReleaseError, "secret-like content"):
            build_fixture_release("windows", self.root, self.output)
        self.assertEqual(list(self.output.glob("*.zip")), [])
        self.assertEqual(list(self.output.glob("*.zip.sha256")), [])

    def test_unquoted_credential_assignment_aborts_before_archive_publication(self):
        write_fixture_source(self.root, "README.md", "LOVART_SECRET_KEY=unquoted-fixture-secret\n")
        with self.assertRaisesRegex(ReleaseError, "secret-like content"):
            build_fixture_release("windows", self.root, self.output)
        self.assertEqual(list(self.output.glob("*.zip")), [])

    def test_opaque_lovart_credentials_in_common_config_and_code_forms_abort_before_publication(self):
        # Removing object/property assignment detection would let real credentials
        # through even though shell-style assignments remain protected.
        cases = {
            "json-colon": ("src/config.json", '{"LOVART_SECRET_KEY": "opaque-json-secret"}\n'),
            "object-colon": ("src/config.js", 'const config = { LOVART_ACCESS_KEY: "opaque-object-key" };\n'),
            "process-env": ("src/config.js", 'process.env.LOVART_ACCESS_KEY = "opaque-process-key";\n'),
            "bracket-property": ("src/config.js", 'process.env["LOVART_SECRET_KEY"] = "opaque-bracket-secret";\n'),
            "powershell-env": ("scripts/configure-lovart-credentials.ps1", '$env:LOVART_ACCESS_KEY = "opaque-powershell-key"\n'),
            "shell-export": ("scripts/start-mcp.mjs", 'export LOVART_SECRET_KEY="opaque-shell-secret"\n'),
        }
        for case, (relative, contents) in cases.items():
            with self.subTest(case=case):
                shutil.rmtree(self.output, ignore_errors=True)
                target = self.root / "plugin-build" / "lovart" / relative
                original = target.read_bytes() if target.exists() else None
                try:
                    write_fixture_source(
                        self.root,
                        relative,
                        (original or b"") + contents.encode("utf-8"),
                    )
                    with self.assertRaisesRegex(ReleaseError, "secret-like content"):
                        build_fixture_release("windows", self.root, self.output)
                    self.assertEqual(list(self.output.glob("*.zip")), [])
                    self.assertEqual(list(self.output.glob("*.zip.sha256")), [])
                finally:
                    if original is None:
                        target.unlink(missing_ok=True)
                    else:
                        target.write_bytes(original)

    def test_github_tokens_abort_before_archive_publication(self):
        # Removing any GitHub token family from the scanner would expose a
        # publish credential in the distributed artifact.
        tokens = {
            "ghp": "ghp_" + "A" * 36,
            "gho": "gho_" + "B" * 36,
            "ghu": "ghu_" + "C" * 36,
            "ghs": "ghs_" + "D" * 36,
            "ghr": "ghr_" + "E" * 36,
            "github-pat": "github_pat_" + "F" * 82,
        }
        for family, token in tokens.items():
            with self.subTest(family=family):
                shutil.rmtree(self.output, ignore_errors=True)
                write_fixture_source(self.root, "README.md", "token: {}\n".format(token))
                with self.assertRaisesRegex(ReleaseError, "secret-like content"):
                    build_fixture_release("windows", self.root, self.output)
                self.assertEqual(list(self.output.glob("*.zip")), [])
                self.assertEqual(list(self.output.glob("*.zip.sha256")), [])

    def test_documented_lovart_credential_placeholders_are_allowed(self):
        write_fixture_source(
            self.root,
            "src/config.json",
            '{"LOVART_ACCESS_KEY": "ak_xxx", "LOVART_SECRET_KEY": "sk_xxx"}\n',
        )
        archive = build_fixture_release("windows", self.root, self.output)
        self.assertTrue(archive.is_file())
        self.assertTrue(Path(str(archive) + ".sha256").is_file())

    def test_utf16_credential_assignment_aborts_before_archive_publication(self):
        for encoding in ("utf-16le", "utf-16be"):
            with self.subTest(encoding=encoding):
                write_fixture_source(
                    self.root,
                    "README.md",
                    "LOVART_ACCESS_KEY=unquoted-utf16-fixture-secret\n".encode(encoding),
                )
                with self.assertRaisesRegex(ReleaseError, "secret-like content"):
                    build_fixture_release("windows", self.root, self.output)
                self.assertEqual(list(self.output.glob("*.zip")), [])

    def test_bomless_utf16_cjk_credential_assignment_aborts_before_archive_publication(self):
        content = ("这是包含许多中文字符的发布说明。请勿提交凭据。" * 20) + "LOVART_ACCESS_KEY=unquoted-cjk-secret\n"
        for encoding in ("utf-16le", "utf-16be"):
            with self.subTest(encoding=encoding):
                write_fixture_source(self.root, "README.md", content.encode(encoding))
                with self.assertRaisesRegex(ReleaseError, "secret-like content"):
                    build_fixture_release("windows", self.root, self.output)
                self.assertEqual(list(self.output.glob("*.zip")), [])

    def test_raw_ascii_credential_is_rejected_in_every_project_file_type(self):
        payload = b"\xffinvalid prefix\nLOVART_SECRET_KEY=raw-ascii-secret\n"
        candidates = ("README.md", "src/config.yaml", "src/config.yml", "src/.env", "src/config.toml", "src/config.ts")
        for relative in candidates:
            with self.subTest(relative=relative):
                for cleanup in candidates:
                        (self.root / "plugin-build" / "lovart" / cleanup).unlink(missing_ok=True)
                write_fixture_source(self.root, "README.md", "fixture\n")
                write_fixture_source(self.root, relative, payload)
                with self.assertRaisesRegex(ReleaseError, "secret-like content"):
                    build_fixture_release("windows", self.root, self.output)
                self.assertEqual(list(self.output.glob("*.zip")), [])

    def test_invalid_byte_adjacency_does_not_hide_raw_credentials(self):
        secret_token = b"sk_abcdefghijklmnopqrstuvwxyz123456"
        access_token = b"ak_abcdefghijklmnopqrstuvwxyz123456"
        payloads = {
            "before-assignment": b"\xffLOVART_SECRET_KEY=raw-adjacent-secret\n",
            "after-assignment": b"LOVART_SECRET_KEY=raw-adjacent-secret\xff\n",
            "before-secret-token": b"\xff" + secret_token + b"\n",
            "after-secret-token": secret_token + b"\xff\n",
            "before-access-token": b"\xff" + access_token + b"\n",
            "after-access-token": access_token + b"\xff\n",
        }
        for case, payload in payloads.items():
            with self.subTest(case=case):
                write_fixture_source(self.root, "src/credentials.unknown-suffix", payload)
                with self.assertRaisesRegex(ReleaseError, "secret-like content"):
                    build_fixture_release("windows", self.root, self.output)
                self.assertEqual(list(self.output.glob("*.zip")), [])
                (self.root / "plugin-build" / "lovart" / "src/credentials.unknown-suffix").unlink()

    def test_raw_tokens_ending_in_token_punctuation_are_rejected_before_publication(self):
        token_bases = (b"sk_abcdefghijklmnopqrs", b"ak_abcdefghijklmnopqrs")
        terminators = (b"\xff", b";")
        for token_base in token_bases:
            for ending in (b"-", b"_"):
                for terminator in terminators:
                    with self.subTest(token_base=token_base, ending=ending, terminator=terminator):
                        write_fixture_source(
                            self.root,
                            "src/credentials.unknown-suffix",
                            token_base + ending + terminator + b"\n",
                        )
                        with self.assertRaisesRegex(ReleaseError, "secret-like content"):
                            build_fixture_release("windows", self.root, self.output)
                        self.assertEqual(list(self.output.glob("*.zip")), [])
                        (self.root / "plugin-build" / "lovart" / "src/credentials.unknown-suffix").unlink()

    def test_windows_npm_discovery_uses_a_safe_explicit_override(self):
        npm = self.root / "fixture-npm.cmd"
        npm.write_text("fixture", encoding="utf-8")
        npm.chmod(0o700)
        self.assertEqual(
            release_package.resolve_npm_command(
                environment={"LOVART_RELEASE_NPM": str(npm)},
                platform="win32",
                which=lambda _: None,
            ),
            npm.resolve(),
        )

    def test_npm_discovery_finds_the_platform_npm_command(self):
        npm = self.root / "fixture-npm.cmd"
        npm.write_text("fixture", encoding="utf-8")
        npm.chmod(0o700)
        self.assertEqual(
            release_package.resolve_npm_command(
                environment={},
                platform="win32",
                which=lambda command: str(npm) if command == "npm.cmd" else None,
            ),
            npm.resolve(),
        )

    def test_npm_override_rejects_a_symlink(self):
        npm = self.root / "fixture-npm"
        npm.write_text("fixture", encoding="utf-8")
        npm.chmod(0o700)
        symlink = self.root / "npm-link"
        try:
            symlink.symlink_to(npm)
        except (NotImplementedError, OSError) as error:
            self.skipTest("symlinks unavailable: {}".format(error))
        with self.assertRaisesRegex(ReleaseError, "unsafe npm override"):
            release_package.resolve_npm_command(
                environment={"LOVART_RELEASE_NPM": str(symlink)},
                platform="win32",
                which=lambda _: None,
            )

    def test_dependency_bin_symlink_is_materialized_when_it_stays_inside_source(self):
        dependency_source = self.root / "dependency-source"
        target = dependency_source / "fixture-package" / "bin.js"
        target.write_text("console.log('fixture');\n", encoding="utf-8")
        command = dependency_source / ".bin" / "fixture-command"
        command.parent.mkdir(parents=True)
        try:
            command.symlink_to("../fixture-package/bin.js")
        except (NotImplementedError, OSError) as error:
            self.skipTest("symlinks unavailable: {}".format(error))
        archive = build_fixture_release("windows", self.root, self.output)
        with zipfile.ZipFile(archive) as package:
            self.assertEqual(
                package.read("lovart-codex-plugin/plugins/lovart/node_modules/.bin/fixture-command"),
                b"console.log('fixture');\n",
            )

    def test_pnpm_dependency_symlink_is_materialized_when_it_stays_inside_source(self):
        dependency_source = self.root / "dependency-source"
        target = dependency_source / ".pnpm" / "linked-package@1.0.0" / "node_modules" / "linked-package"
        target.mkdir(parents=True)
        (target / "package.json").write_text('{"name":"linked-package"}\n', encoding="utf-8")
        link = dependency_source / "linked-package"
        try:
            link.symlink_to(".pnpm/linked-package@1.0.0/node_modules/linked-package")
        except (NotImplementedError, OSError) as error:
            self.skipTest("symlinks unavailable: {}".format(error))
        archive = build_fixture_release("windows", self.root, self.output)
        with zipfile.ZipFile(archive) as package:
            self.assertEqual(
                package.read("lovart-codex-plugin/plugins/lovart/node_modules/linked-package/package.json"),
                b'{"name":"linked-package"}\n',
            )

    def test_pnpm_transitive_linker_view_is_materialized_at_the_node_resolution_root(self):
        dependency_source = self.root / "dependency-source"
        direct = dependency_source / ".pnpm" / "direct-package@1.0.0" / "node_modules" / "direct-package"
        transitive = dependency_source / ".pnpm" / "transitive-package@1.0.0" / "node_modules" / "transitive-package"
        direct.mkdir(parents=True)
        transitive.mkdir(parents=True)
        (direct / "package.json").write_text('{"name":"direct-package"}\n', encoding="utf-8")
        (transitive / "package.json").write_text('{"name":"transitive-package"}\n', encoding="utf-8")
        link = dependency_source / ".pnpm" / "node_modules" / "transitive-package"
        link.parent.mkdir(parents=True)
        try:
            (dependency_source / "direct-package").symlink_to(".pnpm/direct-package@1.0.0/node_modules/direct-package")
            link.symlink_to("../transitive-package@1.0.0/node_modules/transitive-package")
        except (NotImplementedError, OSError) as error:
            self.skipTest("symlinks unavailable: {}".format(error))
        archive = build_fixture_release("windows", self.root, self.output)
        with zipfile.ZipFile(archive) as package:
            self.assertEqual(
                package.read("lovart-codex-plugin/plugins/lovart/node_modules/transitive-package/package.json"),
                b'{"name":"transitive-package"}\n',
            )

    def test_pnpm_flattening_rejects_conflicting_destination_collision(self):
        dependency_source = self.root / "dependency-source"
        (dependency_source / "collision-package").mkdir()
        (dependency_source / "collision-package" / "package.json").write_text('{"name":"first"}\n', encoding="utf-8")
        target = dependency_source / ".pnpm" / "collision@1" / "node_modules" / "collision-package"
        target.mkdir(parents=True)
        (target / "package.json").write_text('{"name":"second"}\n', encoding="utf-8")
        linker = dependency_source / ".pnpm" / "node_modules" / "collision-package"
        linker.parent.mkdir(parents=True)
        try:
            linker.symlink_to("../collision@1/node_modules/collision-package")
        except (NotImplementedError, OSError) as error:
            self.skipTest("symlinks unavailable: {}".format(error))
        with self.assertRaisesRegex(ReleaseError, "collision"):
            build_fixture_release("windows", self.root, self.output)

    def test_verifier_rejects_credential_state_inside_dependencies(self):
        for name in (".env", ".ENV", ".env.local", ".LoVaRt", "nested/.env.production"):
            with self.subTest(name=name):
                dependency = self.root / "dependency-source" / "fixture-package" / name
                dependency.parent.mkdir(parents=True, exist_ok=True)
                dependency.write_text("fixture state\n", encoding="utf-8")
                with self.assertRaisesRegex(ReleaseError, "dependency"):
                    build_fixture_release("windows", self.root, self.output)
                dependency.unlink()

    def test_verifier_rejects_extended_windows_reserved_device_names(self):
        for component in ("CONIN$", "conout$. ", "COM¹", "lpt³"):
            with self.subTest(component=component):
                archive = make_zip(self.root, "windows", [(f"lovart-codex-plugin/plugins/lovart/{component}", b"x", 0o100644)])
                with self.assertRaisesRegex(ReleaseError, "unsafe archive path"):
                    verify_release(archive, "windows", "0.2.0", self.root)

    def test_dependency_bin_symlink_cannot_escape_its_source(self):
        outside = self.root / "outside.js"
        outside.write_text("outside", encoding="utf-8")
        command = self.root / "dependency-source" / ".bin" / "escaped-command"
        command.parent.mkdir(parents=True)
        try:
            command.symlink_to(outside)
        except (NotImplementedError, OSError) as error:
            self.skipTest("symlinks unavailable: {}".format(error))
        with self.assertRaisesRegex(ReleaseError, "dependency symlink"):
            build_fixture_release("windows", self.root, self.output)
        self.assertEqual(list(self.output.glob("*.zip")), [])

    def test_verifier_rejects_missing_declared_node_dependency(self):
        write_fixture_source(
            self.root,
            "package.json",
            '{"name":"fixture","version":"0.2.0","dependencies":{"missing-package":"1.0.0"}}\n',
        )
        with self.assertRaisesRegex(ReleaseError, "missing production dependencies"):
            build_fixture_release("windows", self.root, self.output)

    def test_windows_sidecar_bytes_keep_a_single_lf(self):
        original_write_text = Path.write_text

        def write_windows_text(path, data, encoding=None, errors=None):
            if path.name.endswith(".sha256"):
                return path.write_bytes(data.replace("\n", "\r\n").encode(encoding or "utf-8"))
            return original_write_text(path, data, encoding=encoding, errors=errors)

        with mock.patch.object(Path, "write_text", new=write_windows_text):
            archive = build_fixture_release("windows", self.root, self.output)
        sidecar = Path(str(archive) + ".sha256")
        self.assertEqual(
            sidecar.read_bytes(),
            ("{}  {}\n".format(sha256(archive), archive.name)).encode("ascii"),
        )

    def test_windows_marketplace_bytes_keep_a_single_lf(self):
        original_write_text = Path.write_text

        def write_windows_text(path, data, encoding=None, errors=None):
            if path.name == "marketplace.json":
                return path.write_bytes(data.replace("\n", "\r\n").encode(encoding or "utf-8"))
            return original_write_text(path, data, encoding=encoding, errors=errors)

        with mock.patch.object(Path, "write_text", new=write_windows_text):
            archive = build_fixture_release("windows", self.root, self.output)
        with zipfile.ZipFile(archive) as package:
            marketplace = package.read("lovart-codex-plugin/.agents/plugins/marketplace.json")
        self.assertNotIn(b"\r\n", marketplace)
        self.assertTrue(marketplace.endswith(b"\n"))

    def test_second_publication_rename_failure_leaves_no_orphaned_archive(self):
        original_replace = os.replace

        def fail_sidecar_replace(source, destination):
            if str(source).endswith(".sha256"):
                raise OSError("simulated sidecar rename failure")
            return original_replace(source, destination)

        with mock.patch.object(release_package.os, "replace", side_effect=fail_sidecar_replace):
            with self.assertRaises(OSError):
                build_fixture_release("windows", self.root, self.output)
        self.assertEqual(list(self.output.glob("*.zip")), [])
        self.assertEqual(list(self.output.glob("*.sha256")), [])

    def test_second_publication_rename_failure_restores_an_existing_pair(self):
        self.output.mkdir(parents=True)
        archive = self.output / "lovart-codex-plugin-v0.2.0-windows.zip"
        sidecar = Path(str(archive) + ".sha256")
        archive.write_bytes(b"previous archive")
        sidecar.write_bytes(b"previous checksum\n")
        original_replace = os.replace

        def fail_sidecar_replace(source, destination):
            if str(source).endswith(".sha256"):
                raise OSError("simulated sidecar rename failure")
            return original_replace(source, destination)

        with mock.patch.object(release_package.os, "replace", side_effect=fail_sidecar_replace):
            with self.assertRaises(OSError):
                build_fixture_release("windows", self.root, self.output)
        self.assertEqual(archive.read_bytes(), b"previous archive")
        self.assertEqual(sidecar.read_bytes(), b"previous checksum\n")

    def test_rollback_never_deletes_a_foreign_replacement(self):
        original_replace = os.replace
        archive = self.output / "lovart-codex-plugin-v0.2.0-windows.zip"

        def replace_with_foreign_archive(source, destination):
            if str(source).endswith(".sha256"):
                archive.write_bytes(b"foreign replacement")
                raise OSError("simulated sidecar rename failure")
            return original_replace(source, destination)

        with mock.patch.object(release_package.os, "replace", side_effect=replace_with_foreign_archive):
            with self.assertRaises(OSError):
                build_fixture_release("windows", self.root, self.output)
        self.assertEqual(archive.read_bytes(), b"foreign replacement")
        self.assertEqual(list(self.output.glob("*.sha256")), [])

    def test_concurrent_publishers_do_not_interleave_a_zip_and_sidecar(self):
        output = self.root / "concurrent-output"
        output.mkdir()
        destination = output / "lovart-codex-plugin-v0.2.0-windows.zip"
        sidecar_destination = Path(str(destination) + ".sha256")
        publisher_a = self.root / "publisher-a"
        publisher_b = self.root / "publisher-b"
        publisher_a.mkdir()
        publisher_b.mkdir()
        archive_a = publisher_a / "archive.zip"
        archive_b = publisher_b / "archive.zip"
        archive_a.write_bytes(b"publisher a archive")
        archive_b.write_bytes(b"publisher b archive")
        sidecar_a = publisher_a / "archive.zip.sha256"
        sidecar_b = publisher_b / "archive.zip.sha256"
        sidecar_a.write_bytes(("{}  {}\n".format(sha256(archive_a), destination.name)).encode("ascii"))
        sidecar_b.write_bytes(("{}  {}\n".format(sha256(archive_b), destination.name)).encode("ascii"))
        archive_a_moved = threading.Event()
        allow_a_to_finish = threading.Event()
        publisher_b_attempted = threading.Event()
        errors = []
        original_replace = os.replace

        def controlled_replace(source, target):
            if Path(source) == archive_a and Path(target) == destination:
                result = original_replace(source, target)
                archive_a_moved.set()
                allow_a_to_finish.wait(5)
                return result
            if Path(source) == archive_b and Path(target) == destination:
                publisher_b_attempted.set()
            return original_replace(source, target)

        def publish(archive, sidecar):
            try:
                release_package._publish_pair(archive, sidecar, destination, sidecar_destination)
            except Exception as error:  # Captured so thread errors fail the test below.
                errors.append(error)

        with mock.patch.object(release_package.os, "replace", side_effect=controlled_replace):
            first = threading.Thread(target=publish, args=(archive_a, sidecar_a))
            second = threading.Thread(target=publish, args=(archive_b, sidecar_b))
            first.start()
            self.assertTrue(archive_a_moved.wait(5))
            second.start()
            try:
                self.assertFalse(publisher_b_attempted.wait(0.2))
            finally:
                allow_a_to_finish.set()
                first.join(5)
                second.join(5)
        self.assertFalse(first.is_alive())
        self.assertFalse(second.is_alive())
        self.assertEqual(errors, [])
        self.assertEqual(
            sidecar_destination.read_bytes(),
            ("{}  {}\n".format(sha256(destination), destination.name)).encode("ascii"),
        )

    def test_persistent_lock_file_does_not_block_recovery_after_crash(self):
        self.output.mkdir()
        destination = self.output / "lovart-codex-plugin-v0.2.0-windows.zip"
        process = multiprocessing.Process(target=abandon_publication_lock, args=(str(destination),))
        process.start()
        process.join(5)
        self.assertEqual(process.exitcode, 0)
        lock = self.output / ".lovart-codex-plugin-v0.2.0-windows.zip.lock"
        self.assertTrue(lock.exists())
        with release_package._publication_lock(destination):
            self.assertTrue(lock.exists())

    def test_lock_file_persists_after_the_owner_releases_it(self):
        self.output.mkdir()
        destination = self.output / "lovart-codex-plugin-v0.2.0-windows.zip"
        lock = self.output / ".lovart-codex-plugin-v0.2.0-windows.zip.lock"
        with release_package._publication_lock(destination):
            self.assertTrue(lock.exists())
        self.assertTrue(lock.exists())

    def test_windows_lock_retries_transient_contention_until_it_acquires_and_unlocks(self):
        class FakeMsvcrt:
            LK_NBLCK = 1
            LK_UNLCK = 2

            def __init__(self):
                self.nonblocking_attempts = 0
                self.unlocks = 0

            def locking(self, _fd, operation, _length):
                if operation == self.LK_NBLCK:
                    self.nonblocking_attempts += 1
                    if self.nonblocking_attempts <= 11:
                        raise OSError(errno.EACCES, "simulated sharing violation")
                    return
                if operation == self.LK_UNLCK:
                    self.unlocks += 1
                    return
                raise AssertionError("unexpected Windows lock operation: {}".format(operation))

        self.output.mkdir()
        destination = self.output / "lovart-codex-plugin-v0.2.0-windows.zip"
        fake_msvcrt = FakeMsvcrt()
        fake_time = type("FakeTime", (), {"sleep": staticmethod(lambda _seconds: None)})()
        with mock.patch.object(release_package, "msvcrt", fake_msvcrt, create=True), \
             mock.patch.object(release_package.os, "name", "nt"), \
             mock.patch.object(release_package, "time", fake_time, create=True):
            with release_package._publication_lock(destination):
                self.assertEqual(fake_msvcrt.nonblocking_attempts, 12)
        self.assertEqual(fake_msvcrt.unlocks, 1)

    def test_rollback_preserves_a_replacement_written_after_private_inspection(self):
        original_replace = os.replace
        original_sha256 = release_package._archive_sha256
        archive = self.output / "lovart-codex-plugin-v0.2.0-windows.zip"
        sidecar_failure = threading.Event()

        def fail_sidecar_replace(source, destination):
            if str(source).endswith(".sha256"):
                sidecar_failure.set()
                raise OSError("simulated sidecar rename failure")
            return original_replace(source, destination)

        def replace_after_private_inspection(path):
            digest = original_sha256(path)
            if sidecar_failure.is_set() and path.name == archive.name:
                archive.write_bytes(b"foreign replacement after inspection")
            return digest

        with mock.patch.object(release_package.os, "replace", side_effect=fail_sidecar_replace):
            with mock.patch.object(release_package, "_archive_sha256", side_effect=replace_after_private_inspection):
                with self.assertRaises(OSError):
                    build_fixture_release("windows", self.root, self.output)
        self.assertEqual(archive.read_bytes(), b"foreign replacement after inspection")

    def test_version_mismatch_between_archive_and_plugin_metadata_aborts_publication(self):
        write_fixture_source(self.root, "package.json", '{"name":"fixture","version":"0.2.1"}\n')
        with self.assertRaisesRegex(ReleaseError, "version"):
            build_fixture_release("windows", self.root, self.output)
        self.assertEqual(list(self.output.glob("*.zip")), [])

    def test_identical_inputs_produce_identical_archive_hashes(self):
        first = build_fixture_release("windows", self.root, self.output / "one")
        second = build_fixture_release("windows", self.root, self.output / "two")
        self.assertEqual(sha256(first), sha256(second))

    def test_verification_reports_archive_metadata(self):
        archive = build_fixture_release("windows", self.root, self.output)
        self.assertEqual(
            verify_release(archive, "windows", "0.2.0", self.root),
            {
                "platform": "windows",
                "version": "0.2.0",
                "archiveSha256": sha256(archive),
                "fileCount": len(archive_names(archive)),
            },
        )


if __name__ == "__main__":
    unittest.main()
