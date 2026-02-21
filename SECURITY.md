# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in KarnEvil9, please report it responsibly.

**Do NOT open a public GitHub issue for security vulnerabilities.**

Instead, please email the maintainers directly or use GitHub's private vulnerability reporting feature.

## Supported Versions

| Version | Supported |
| ------- | --------- |
| 0.x     | Yes       |

## Security Model

KarnEvil9 is an agent runtime that executes LLM-generated plans. The security model includes:

- **Permission gates** — every tool invocation requires explicit permission grants (`allow_once`, `allow_session`, `allow_always`)
- **Policy enforcement** — path restrictions, command allowlists, endpoint allowlists, SSRF protection
- **Input validation** — AJV JSON Schema validation at all component boundaries
- **Prompt injection prevention** — untrusted input delimited with `<<<UNTRUSTED_INPUT>>>` markers
- **Immutable audit log** — SHA-256 hash-chained journal events for tamper detection
- **Secret redaction** — automatic redaction of API keys, tokens, and credentials in journal payloads
- **Sensitive file blocking** — defense-in-depth blocking of `.env`, private keys, and credential files

## Best Practices for Deployment

1. **Always set `KARNEVIL9_API_TOKEN`** — never run without authentication in production
2. **Use explicit CORS origins** — avoid `KARNEVIL9_CORS_ORIGINS=*` in production
3. **Set `NODE_ENV=production`** — enables production error handling (no stack traces in responses)
4. **Configure `allowed_paths`** — restrict file system access to necessary directories
5. **Configure `allowed_commands`** — restrict shell command execution
6. **Configure `allowed_endpoints`** — restrict HTTP requests to known APIs
7. **Review plugin permissions** — plugins can register tools, hooks, and routes
8. **Keep dependencies updated** — run `pnpm audit` regularly
