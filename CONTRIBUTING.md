# Contributing to @voicenter/mastra-nats-storage

Thank you for your interest in contributing!

## Development Setup

1. Clone the repository
2. Install dependencies: `pnpm install`
3. Start a local NATS cluster: `docker compose -f docker-compose.test.yml up -d`
4. Run tests: `NATS_URL=nats://localhost:4222 pnpm test`

## Testing

- `pnpm test:unit` — Unit tests (no NATS required)
- `pnpm test:integration` — Integration tests (requires NATS)
- `pnpm test` — All tests

## Code Style

- TypeScript strict mode
- No `console.log` in production code
- Every feature or fix must include tests

## Pull Requests

1. Fork the repo and create a branch
2. Write tests first, then implement
3. Ensure `pnpm build && pnpm typecheck && pnpm test:unit` all pass
4. Submit your PR against `main`

## Security

This is a public repository. Never commit credentials, API keys, or internal infrastructure details. See the security rules in the specification.

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
