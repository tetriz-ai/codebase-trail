# Installation

<!-- release-status:start -->
Use the macOS or Windows release installer below. It installs Codebase Trail and its Node.js/npm runtime in your user folder, then opens setup in your browser. Install Git separately.
<!-- release-status:end -->

Download the release assets with GitHub CLI, then run the verified installer for your operating system.

Follow the installer instructions for your operating system. Each release also includes `INSTALL.md` with its download, verification and launch commands. Models and model CLIs are configured in Settings and are not installed by the release installer.

The macOS and Windows installers download Node.js 24.22.1 with npm, then install the runtime and app in your user folder. Install Git separately. Models and helper CLIs are configured in Settings.

## Supported installer targets

| Platform | Architecture | Minimum requirements | Native verification |
| --- | --- | --- | --- |
| macOS | Apple Silicon | macOS 13.5 and Git | Verified |
| macOS | Intel x64 | macOS 13.5 and Git | Pending |
| Windows | x64 | Windows 10, PowerShell 5.1 and Git | Pending |
| Windows on ARM | x64 emulation | Windows 11 ARM64, PowerShell 5.1 and Git | Pending |

These are installer targets, not a promise about every managed-device policy. The native installer must be checked on each operating system before release; see the [release guide](releases.md#validate-the-candidate).

## Download with GitHub CLI

Sign in to GitHub CLI with an account that has repository access, then download the release assets into a new folder:

<!-- release-repository:start -->
```sh
gh auth login
gh release download v0.1.0 --repo tetriz-ai/codebase-trail --dir codebase-trail-download
```
<!-- release-repository:end -->

### macOS installer

Requires macOS 13.5 or newer on Apple Silicon or Intel x64. Review the downloaded script, then verify and run it:

```sh
cd codebase-trail-download
grep '  install-macos.sh$' SHA256SUMS | shasum -a 256 -c - && bash install-macos.sh --app-archive ./codebase-trail-0.1.0.tgz
```

The installer launches the app after installing. It opens setup when no saved configuration exists and the learning app otherwise. To install without launching, add `--no-launch` to the verified installer command after verifying the download.

Launch again with:

```sh
"$HOME/Library/Application Support/Codebase Trail/app/codebase-trail"
```

### Windows installer

Requires Windows 10 or newer on x64, or Windows 11 ARM64 with x64 emulation, and PowerShell 5.1 or newer. ARM64 uses the x64 runtime because the app's native parser packages ship Windows x64 binaries. For release `v0.1.0`, review the downloaded script, then verify and run it:

```powershell
Set-Location codebase-trail-download
$checksum = @(Select-String -LiteralPath SHA256SUMS -Pattern '^[a-f0-9]{64}  install-windows\.ps1$')
if ($checksum.Count -eq 1 -and (Get-FileHash -LiteralPath install-windows.ps1 -Algorithm SHA256).Hash.ToLowerInvariant() -eq $checksum[0].Line.Split(' ')[0]) { & .\install-windows.ps1 -AppArchive .\codebase-trail-0.1.0.tgz } else { throw 'Installer checksum verification failed.' }
```

To install without launching, add `-NoLaunch` to the verified installer command after verifying the download. Launch again with `& "$env:LOCALAPPDATA\CodebaseTrail\app\codebase-trail.ps1"`.

## Permissions and downloads

Both installers use user-owned folders and leave existing settings and history in place. They do not request administrator access or change system PATH, shell profiles or PowerShell execution policy. The launcher's PATH change lasts only for its process.

Downloaded scripts and binaries remain subject to PowerShell execution policy, Gatekeeper, application controls and company network rules. Unsigned scripts may be blocked, particularly under managed `AllSigned` policies. Follow your organization's approved process rather than bypassing a policy.

The installer verifies embedded SHA-256 hashes for the runtime and app before extracting or executing them. npm installs public app dependencies with lifecycle scripts disabled.

Checksums detect changed downloads. Trust in the release and dependency sources remains necessary.

Rerunning the same release installer reuses its completed installation. Staging and an install lock keep failed downloads or checks from replacing a working launcher. An install killed forcibly can leave a lock that needs manual removal after confirming no installer is running.

## Other installation methods

Choose the relevant option below if you already have Node.js/npm or want to modify the app. The release installer remains the recommended route.

### GitHub release tarball

If Node.js 20 or newer and npm are already installed, download the assets with GitHub CLI as above, verify the tarball against `SHA256SUMS`, then run the local tarball from the download directory:

```sh
cd codebase-trail-download
npx --yes ./codebase-trail-0.1.0.tgz
```

This command launches the app in your browser. It opens setup when no saved configuration exists and the learning app otherwise.

The tarball includes the application and examples. Direct `npx` use installs the app's dependencies but does not download Node.js, npm or Git.
See [model requirements](usage.md#models) before generating questions with your own repository.


### URL downloads

If your environment permits direct release URL downloads, the [app tarball](https://github.com/tetriz-ai/codebase-trail/releases/download/v0.1.0/codebase-trail-0.1.0.tgz) is also available by URL. Download and verify it against the release's `SHA256SUMS` before running the local tarball. GitHub CLI handles sign-in for the recommended download route above.

### Run from source

Source installation is for contributors and people who want to modify the app. Follow [source setup](../CONTRIBUTING.md#run-from-source), including its contributor-tool Node.js requirements. Start again with `npm start` from that checkout.

## Native-parser repair

Close the running app before repairing its installation. Windows ARM64 requires x64 Node.js for the bundled parser packages.

For a source install, run this from the Codebase Trail source checkout, not the repository you selected for practice:

```sh
npm ci --include=optional
```

Launch again with `npm start`.

For a release-installer installation, move the installation's `app` folder to a backup location, then rerun the verified release installer. On macOS the folder is `$HOME/Library/Application Support/Codebase Trail/app`; on Windows it is `$env:LOCALAPPDATA\CodebaseTrail\app`. Move only this `app` folder, preserving settings and history in their separate profile directories.

A completed installation is reused on rerun, so rerunning the installer without first moving that `app` folder does not reinstall its dependencies. Keep the backup until the new installation works.
