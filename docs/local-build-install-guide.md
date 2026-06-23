# Local Build and Install Guide

This document describes how to build and install the local patched VSIX for this fork.

## Current Patched Identity

- Extension id: `johnny-zhao.oai-compatible-copilot`
- Display name: `OAI Compatible Provider for Copilot (Patched)`
- Version: `0.4.200`
- VSIX output: `extension.vsix`

The extension id is intentionally unchanged so existing VS Code settings and secrets continue to work. The display name and version are changed so the patched build is easy to distinguish from the marketplace `0.4.2` build.

## Build

Run these commands from the repository root:

```powershell
npm ci
npm run compile
npm test
npm run build
```

`npm run build` creates:

```text
E:\01_personal\01_repos\github\references\oai-compatible-copilot\extension.vsix
```

## Install Into VS Code

Use the VS Code CLI:

```powershell
code --install-extension "E:\01_personal\01_repos\github\references\oai-compatible-copilot\extension.vsix" --force
```

Then fully exit and restart VS Code. A simple `Reload Window` may not be enough after replacing extension files.

You can also install from the UI:

1. Open VS Code Extensions.
2. Select `...`.
3. Select `Install from VSIX...`.
4. Choose `extension.vsix`.
5. Fully restart VS Code.

## Verify Installed Version

CLI check:

```powershell
code --list-extensions --show-versions | Select-String "oai-compatible-copilot"
```

Expected result:

```text
johnny-zhao.oai-compatible-copilot@0.4.200
```

UI check:

- Extension name should show `OAI Compatible Provider for Copilot (Patched)`.
- Version should show `0.4.200`.

## Verify Runtime Files

The extension folder is usually under:

```text
C:\Users\Bryce\.vscode\extensions\
```

After installing the patched VSIX, check the installed folder:

```powershell
Get-ChildItem "$env:USERPROFILE\.vscode\extensions" |
  Where-Object { $_.Name -like "johnny-zhao.oai-compatible-copilot*" } |
  Select-Object Name,LastWriteTime
```

Expected patched folder name should include:

```text
johnny-zhao.oai-compatible-copilot-0.4.200
```

## Confirm Key Patch Behavior

Anthropic Opus sentinel support:

- `temperature: -1` is omitted from Anthropic request body.
- `top_p: -1` is omitted from Anthropic request body.
- `top_k: -1` is omitted from Anthropic request body.
- `thinking.type: "adaptive"` is supported.
- `extra.thinking` is merged with `thinking.type`.

OpenAI Responses reasoning replay:

- `include_reasoning_in_request: true` adds `include: ["reasoning.encrypted_content"]`.
- Raw Responses reasoning items are saved in hidden data parts.
- Next request replays raw reasoning items before falling back to visible thinking summaries.

## Roll Back

To return to the marketplace build:

```powershell
code --uninstall-extension johnny-zhao.oai-compatible-copilot
code --install-extension johnny-zhao.oai-compatible-copilot
```

Then fully restart VS Code.

If VS Code keeps loading an old local folder, close VS Code and inspect:

```powershell
Get-ChildItem "$env:USERPROFILE\.vscode\extensions" |
  Where-Object { $_.Name -like "johnny-zhao.oai-compatible-copilot*" }
```

Remove only the stale extension folder you explicitly intend to delete.
