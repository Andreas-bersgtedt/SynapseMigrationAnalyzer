# Security Policy

## Reporting a vulnerability

If you discover a security issue in **Synapse Migration Analyzer**, please **do not
open a public GitHub issue**. Instead, report it privately so we can investigate and
ship a fix before details become public.

Use one of the following channels:


- Email: open a confidential GitHub issue requesting contact and the maintainer will
  reach out off-band.

Please include, where possible:

- A description of the issue and its impact (data exposure, privilege escalation,
  denial of service, etc.).
- Reproduction steps or a minimal proof-of-concept.
- The affected version (`pip show synapse-migration-analyzer`) and Python version.
- Any suggested mitigation.

## Response expectations

- **Acknowledgement:** within 5 business days of receipt.
- **Triage + initial assessment:** within 10 business days.
- **Fix or mitigation timeline:** communicated after triage, depending on severity.
- **Public disclosure:** coordinated with the reporter; we credit reporters in the
  advisory unless asked otherwise.

## Scope

In scope:

- Code in this repository (the `synapse_migration_analyzer` Python package and its
  CLI, reports, and bundled SQL queries).
- Default configuration patterns documented in `README.md` / `QUICKSTART.md`.

Out of scope:

- Vulnerabilities in upstream dependencies (Azure SDKs, `pyodbc`, etc.) — please
  report those to the respective maintainers. We will track and bump versions
  reactively.
- The Azure services this tool reads from (Synapse, Storage, Monitor) — those are
  Microsoft's responsibility.
- Issues that require the attacker to already have privileged Azure access
  equivalent to what the tool itself needs to function (Reader + DMV access).

## Supported versions

Only the latest released version on `main` receives security fixes.
