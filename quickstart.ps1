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

.PARAMETER Repo
    Which fork of the repository to clone:
      - `Public`  -> https://github.com/Andreas-bersgtedt/SynapseMigrationAnalyzer.git (default)
      - `Private` -> https://github.com/anbergst_microsoft/SynapseMigrationAnalyzer.git

    Ignored when `-RepoUrl` is supplied explicitly.

.PARAMETER RepoUrl
    Git URL of the repo. When supplied, overrides `-Repo`. Defaults to the URL
    derived from `-Repo` (Public).

.PARAMETER PythonExe
    Python interpreter to use for the venv. Defaults to `python`.

.PARAMETER SkipClone
    Skip the `git clone` step (use when running from inside an already-cloned
    working tree).

.PARAMETER Branch
    Branch / tag to check out after clone. When omitted, the script lists the
    remote branches and prompts interactively with a 10-second timeout that
    defaults to `main`.

.PARAMETER NonInteractive
    Skip the interactive branch prompt and use `Branch` (or `main`) directly.

.EXAMPLE
    PS> .\quickstart.ps1

.EXAMPLE
    PS> .\quickstart.ps1 -Repo Private

.EXAMPLE
    PS> .\quickstart.ps1 -InstallRoot C:\src -PythonExe py

.EXAMPLE
    PS> .\quickstart.ps1 -Branch feature/run-history
#>
[CmdletBinding()]
param(
    [string]$InstallRoot     = (Get-Location).Path,
    [ValidateSet('Public', 'Private')]
    [string]$Repo            = 'Public',
    [string]$RepoUrl,
    [string]$PythonExe       = 'python',
    [switch]$SkipClone,
    [string]$Branch,
    [switch]$NonInteractive
)

if (-not $RepoUrl) {
    $RepoUrl = if ($Repo -eq 'Private') {
        'https://github.com/anbergst_microsoft/SynapseMigrationAnalyzer.git'
    } else {
        'https://github.com/Andreas-bersgtedt/SynapseMigrationAnalyzer.git'
    }
}

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

# Lists remote branches of $RepoUrl and prompts the user to pick one. Times out
# after $TimeoutSeconds of inactivity and falls back to $DefaultBranch.
function Select-RemoteBranch {
    param(
        [Parameter(Mandatory)][string]$RepoUrl,
        [string]$DefaultBranch = 'main',
        [int]$TimeoutSeconds   = 10
    )

    Write-Host "    listing branches on remote ..." -ForegroundColor DarkGray
    $raw = git ls-remote --heads $RepoUrl 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $raw) {
        Write-Host "    (could not list remote branches; defaulting to '$DefaultBranch')" -ForegroundColor Yellow
        return $DefaultBranch
    }

    $branches = $raw |
        ForEach-Object { ($_ -split "`t")[1] } |
        Where-Object   { $_ -like 'refs/heads/*' } |
        ForEach-Object { $_ -replace '^refs/heads/', '' } |
        Sort-Object -Unique

    if (-not $branches -or $branches.Count -eq 0) {
        return $DefaultBranch
    }

    # Move default to position 1 if present.
    if ($branches -contains $DefaultBranch) {
        $branches = @($DefaultBranch) + ($branches | Where-Object { $_ -ne $DefaultBranch })
    }

    Write-Host ""
    Write-Host "    Available branches:" -ForegroundColor Cyan
    for ($i = 0; $i -lt $branches.Count; $i++) {
        $marker = if ($i -eq 0) { ' (default)' } else { '' }
        Write-Host ("      {0,2}. {1}{2}" -f ($i + 1), $branches[$i], $marker)
    }
    Write-Host ""
    Write-Host "    Enter number or branch name (timeout ${TimeoutSeconds}s -> '$DefaultBranch'): " -NoNewline -ForegroundColor Yellow

    # Poll the keyboard so we can time out without blocking on Read-Host.
    # If the host doesn't expose a keyboard (eg. ISE, redirected stdin), fall back.
    if (-not [Environment]::UserInteractive -or $null -eq $Host.UI.RawUI -or
        $Host.Name -eq 'Windows PowerShell ISE Host') {
        Write-Host "(non-interactive host; defaulting)" -ForegroundColor DarkGray
        return $DefaultBranch
    }

    $buffer = ''
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        if ([Console]::KeyAvailable) {
            $key = [Console]::ReadKey($true)
            if ($key.Key -eq 'Enter') {
                Write-Host ''
                break
            }
            if ($key.Key -eq 'Backspace') {
                if ($buffer.Length -gt 0) {
                    $buffer = $buffer.Substring(0, $buffer.Length - 1)
                    Write-Host -NoNewline "`b `b"
                }
                continue
            }
            if ($key.Key -eq 'Escape') {
                Write-Host ''
                $buffer = ''
                break
            }
            if ($key.KeyChar -and -not [char]::IsControl($key.KeyChar)) {
                $buffer += $key.KeyChar
                Write-Host -NoNewline $key.KeyChar
                # Once the user starts typing, stop the countdown.
                $deadline = [DateTime]::MaxValue
            }
        } else {
            Start-Sleep -Milliseconds 100
        }
    }

    $choice = $buffer.Trim()
    if (-not $choice) {
        Write-Host "    -> using default '$DefaultBranch'" -ForegroundColor DarkGray
        return $DefaultBranch
    }

    # Numeric selection?
    [int]$index = 0
    if ([int]::TryParse($choice, [ref]$index) -and $index -ge 1 -and $index -le $branches.Count) {
        $picked = $branches[$index - 1]
        Write-Host "    -> '$picked'" -ForegroundColor DarkGray
        return $picked
    }

    # Treat as branch name; warn if it isn't in the remote list but allow it.
    if ($branches -notcontains $choice) {
        Write-Host "    (warning: '$choice' is not in the listed branches; passing to git anyway)" -ForegroundColor Yellow
    } else {
        Write-Host "    -> '$choice'" -ForegroundColor DarkGray
    }
    return $choice
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
        if ($Branch) {
            Write-Host "    (-Branch '$Branch' ignored; repo already cloned)" -ForegroundColor DarkGray
        }
    } else {
        # Resolve which branch to clone.
        if (-not $Branch -and -not $NonInteractive) {
            Write-Step "Selecting branch to clone"
            $Branch = Select-RemoteBranch -RepoUrl $RepoUrl -DefaultBranch 'main' -TimeoutSeconds 10
        }
        if (-not $Branch) { $Branch = 'main' }

        Write-Step "Cloning $RepoUrl (branch: $Branch)"
        Push-Location $InstallRoot
        try {
            git clone --branch $Branch $RepoUrl
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
