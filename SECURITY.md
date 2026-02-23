# Security Policy

## Reporting a Vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Please use [GitHub private security advisories](../../security/advisories/new) to report vulnerabilities confidentially. All reports will be addressed promptly.

Include as much of the following as possible:
- Type of vulnerability
- Affected source file(s) and location
- Steps to reproduce
- Proof-of-concept or exploit code (if available)
- Impact assessment

## Security Best Practices

- Restrict access to the host and Docker volumes running the plugin container
- The shared volume (`/shared/`) may contain task output files written by agents — ensure it is not publicly accessible
- `NANO_INTERNAL_TOKEN` is used to authenticate calls to the NanoFleet internal API — keep it confidential
