# Security

## Current trust model

Lumina PDF Studio is designed for local, single-user operation.

- The bundled server binds to `127.0.0.1` by default.
- PDF files remain in browser memory except while a source document is sent to the same-origin local engine for an explicit analysis or edit.
- The local engine accepts PDF bytes and a small allowlist of structured operations; it does not accept filesystem paths, commands, code, or arbitrary URLs.
- Request bodies are size-limited to 64 MiB by default and operation lists are capped at 100 entries.
- Extracted text is sent to an AI provider only when document context is enabled and the user sends a prompt.
- AI API keys are stored in browser `sessionStorage`, not committed to the repository or persisted in local storage.
- AI actions are restricted to an allowlist and require review before execution.
- Destructive page deletion and automatic export are disabled by default for AI.
- Native source mutations are currently initiated by the user, not by an AI tool call.

## Signed documents

Editing a digitally signed PDF commonly invalidates its signature. Lumina inspects signature fields and PDF signature flags before a native mutation. Signed documents and documents that declare a non-incremental mutation warning are blocked by default.

Lumina does not claim to cryptographically validate signer identity or certificate trust. The current check detects signature presence and signing status exposed by the PDF engine; full validation requires certificate-chain, revocation, timestamp, and trust-store handling.

## PDF parser boundary

PDFs are untrusted binary inputs. PyMuPDF runs in the same local process as the static server in the current single-user design. Do not expose this development server to an untrusted network.

For a public service, move parsing into disposable, resource-constrained workers with:

- CPU, memory, file-size, page-count, and execution-time limits;
- a read-only container image and no host filesystem mounts;
- no outbound network access;
- frequent dependency updates and parser fuzzing;
- malware scanning where required by the deployment context.

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
- Add authentication, CSRF controls, rate limits, parser timeouts, and per-user quotas.
- Self-host and pin third-party assets; add Subresource Integrity where possible.
- Set a restrictive Content Security Policy.
- Treat PDF text as untrusted prompt content and keep it separated from system instructions.
- Add automated dependency, static-analysis, and browser security testing.
- Validate rewritten and exported files with multiple PDF readers.
- Add a cryptographic signature-validation service before displaying any trusted-signature claim.

## Reporting issues

Please open a GitHub security advisory or contact the repository owner privately for vulnerabilities that could expose documents, credentials, or system access.
