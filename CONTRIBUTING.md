# Contributing to KarnEvil9

Thank you for your interest in contributing to KarnEvil9!

## Getting Started

1. **Fork and clone** the repository
2. Install dependencies: `pnpm install`
3. Build all packages: `pnpm build`
4. Run tests: `pnpm test`

## Development Workflow

```bash
pnpm dev            # Watch mode across all packages
pnpm test           # Unit tests
pnpm test:e2e       # E2E smoke tests
pnpm lint           # Lint all packages
```

### Working on a Single Package

```bash
cd packages/<name>
pnpm test           # Run tests for this package only
pnpm build          # Build this package only
```

## Project Structure

All packages live under `packages/` and are scoped as `@karnevil9/*`. See `CLAUDE.md` for the full dependency graph and architecture overview.

## Coding Standards

- **TypeScript** with strict mode enabled
- **ES Modules** — all packages use `"type": "module"`
- **Vitest** for all tests
- Validation at component boundaries using **AJV** JSON Schemas
- Journal events for observability (not ad-hoc logging)
- No secrets in code — use `.env` files (see `.env.example`)

## Pull Request Process

1. Create a feature branch from `master`
2. Make your changes with tests
3. Ensure `pnpm build && pnpm test && pnpm lint` pass
4. Open a PR with a clear description of what and why
5. Wait for review

## Commit Messages

Use concise, descriptive commit messages. Focus on the "why" rather than the "what".

## Reporting Issues

Use [GitHub Issues](https://github.com/oldeucryptoboi/KarnEvil9/issues) for bug reports and feature requests.

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
