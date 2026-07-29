# Security

## Current trust model

Lumina PDF Studio is designed for local, single-user operation.

- PDF files remain in browser memory.
- Extracted text is sent to an AI provider only when document context is enabled and the user sends a prompt.
- AI API keys are stored in browser `sessionStorage`, not committed to the repository or persisted in local storage.
- AI actions are restricted to an allowlist and require review before execution.
- Destructive page deletion and automatic export are disabled by default for AI.

## Do not grant unrestricted agent access

The application does not provide models with shell access, arbitrary browser control, credential stores, local filesystem traversal, or unrestricted network access. Adding a single "do anything a human can do" tool would collapse the security boundary and make prompt injection inside a PDF capable of controlling the user's environment.

External capabilities should be added as small, named tools with:

- least-privilege scopes;
- strict argument schemas;
- domain and resource allowlists;
- read/write separation;
- confirmation for destructive or external side effects;
- logs showing the model request, proposed action, approval, and result;
- revocable credentials stored outside the browser bundle.

## Before public deployment

- Proxy cloud AI calls through an authenticated backend so provider keys never reach client JavaScript.
- Self-host and pin third-party assets; add Subresource Integrity where possible.
- Set a restrictive Content Security Policy.
- Add upload size limits and parser timeouts.
- Treat PDF text as untrusted prompt content and keep it separated from system instructions.
- Add automated dependency, static-analysis, and browser security testing.
- Validate exported files with multiple PDF readers.

## Reporting issues

Please open a GitHub security advisory or contact the repository owner privately for vulnerabilities that could expose documents, credentials, or system access.
