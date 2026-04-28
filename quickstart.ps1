<#
.SYNOPSIS
    Quickstart bootstrapper for Synapse Migration Analyzer (QUICKSTART.md section 0.2).

.DESCRIPTION
    Automates the "Clone & install" section:
      1. Clone the SynapseMigrationAnalyzer repo (skipped if already present)
      2. Create a Python virtual environment under .venv
      3. Activate the venv in the *current* PowerShell session
      4. pip install -e ".[dev]"
      5. Verify the `sma` CLI is on the path (sma --version / sma --help)

    Run with dot-sourcing so the venv stays activated in your shell:
        . .\quickstart.ps1
    or just:
        .\quickstart.ps1
    (a child shell will be activated; close it to deactivate).

.PARAMETER InstallRoot
    Directory under which the repo will be cloned. Defaults to the current
    directory.

.PARAMETER RepoUrl
    Git URL of the repo. Defaults to the public GitHub URL from QUICKSTART.md.

.PARAMETER PythonExe
    Python interpreter to use for the venv. Defaults to `python`.

.PARAMETER SkipClone
    Skip the `git clone` step (use when running from inside an already-cloned
    working tree).

.EXAMPLE
    PS> .\quickstart.ps1

.EXAMPLE
    PS> .\quickstart.ps1 -InstallRoot C:\src -PythonExe py
#>
[CmdletBinding()]
param(
    [string]$InstallRoot = (Get-Location).Path,
    [string]$RepoUrl     = 'https://github.com/Andreas-bersgtedt/SynapseMigrationAnalyzer.git',
    [string]$PythonExe   = 'python',
    [switch]$SkipClone
)

$ErrorActionPreference = 'Stop'

function Write-Step([string]$msg) {
    Write-Host ""
    Write-Host "==> $msg" -ForegroundColor Cyan
}

function Assert-Command([string]$name, [string]$hint) {
    if (-not (Get-Command $name -ErrorAction SilentlyContinue)) {
        throw "Required command '$name' not found on PATH. $hint"
    }
}

# --- Prereq checks (QUICKSTART section 0.1) ---------------------------------
Write-Step "Checking host prerequisites"
Assert-Command 'git'      'Install Git from https://git-scm.com/download/win and reopen PowerShell.'
Assert-Command $PythonExe 'Install Python 3.11+ from https://www.python.org/downloads/ and reopen PowerShell.'

$pyVersion = & $PythonExe --version 2>&1
Write-Host "    git    : $(git --version)"
Write-Host "    python : $pyVersion"

# --- Ensure InstallRoot exists ----------------------------------------------
if (-not (Test-Path $InstallRoot)) {
    Write-Step "Creating InstallRoot '$InstallRoot'"
    New-Item -ItemType Directory -Path $InstallRoot -Force | Out-Null
}
$InstallRoot = (Resolve-Path $InstallRoot).Path

# --- Clone (QUICKSTART section 0.2) -----------------------------------------
$repoDir = Join-Path $InstallRoot 'SynapseMigrationAnalyzer'

if ($SkipClone) {
    Write-Step "Skipping clone (--SkipClone)"
    if (-not (Test-Path (Join-Path $repoDir 'pyproject.toml'))) {
        # Maybe the user is already *inside* the repo dir.
        if (Test-Path (Join-Path (Get-Location).Path 'pyproject.toml')) {
            $repoDir = (Get-Location).Path
        } else {
            throw "SkipClone set but no pyproject.toml found at '$repoDir' or in the current directory."
        }
    }
} else {
    if (Test-Path $repoDir) {
        Write-Step "Repo already present at '$repoDir' - skipping clone"
    } else {
        Write-Step "Cloning $RepoUrl"
        Push-Location $InstallRoot
        try {
            git clone $RepoUrl
            if ($LASTEXITCODE -ne 0) { throw "git clone failed (exit $LASTEXITCODE)." }
        } finally {
            Pop-Location
        }
    }
}

if (-not (Test-Path (Join-Path $repoDir 'pyproject.toml'))) {
    throw "Expected pyproject.toml not found under '$repoDir'."
}

Set-Location $repoDir
Write-Host "    cwd    : $(Get-Location)"

# --- Virtual environment ----------------------------------------------------
$venvDir        = Join-Path $repoDir '.venv'
$activateScript = Join-Path $venvDir 'Scripts\Activate.ps1'

if (Test-Path $activateScript) {
    Write-Step "Reusing existing venv at .venv"
} else {
    Write-Step "Creating virtual environment in .venv"
    & $PythonExe -m venv .venv
    if ($LASTEXITCODE -ne 0) { throw "python -m venv failed (exit $LASTEXITCODE)." }
}

Write-Step "Activating venv"
. $activateScript

# --- Install (editable + dev extras) ----------------------------------------
Write-Step "Upgrading pip"
python -m pip install --upgrade pip
if ($LASTEXITCODE -ne 0) { throw "pip upgrade failed (exit $LASTEXITCODE)." }

Write-Step "pip install -e .[dev]"
pip install -e ".[dev]"
if ($LASTEXITCODE -ne 0) { throw "pip install failed (exit $LASTEXITCODE)." }

# --- Verify CLI -------------------------------------------------------------
Write-Step "Verifying sma CLI"
sma --version
if ($LASTEXITCODE -ne 0) { throw "sma --version failed (exit $LASTEXITCODE)." }
sma --help | Select-Object -First 25

Write-Host ""
Write-Host "Done. Next: see QUICKSTART.md section 0.3 (service principal) and section 0.4 (.env)." -ForegroundColor Green
Write-Host "        Run 'sma doctor --offline' to smoke-test the install (section 0.5)."            -ForegroundColor Green
