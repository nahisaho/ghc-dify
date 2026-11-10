# API reference type

The recommended skeleton and checklist for endpoint/function-level
reference documentation, optimized for a developer who wants to get a
first call working.

## Target reader

A developer who wants to call this API from their own code. The goal is
"get the smallest request to succeed".

## Recommended skeleton (per endpoint/function)

1. **Signature**: the endpoint (method + path) or function signature first.
2. **One-sentence description**: what it does. State side effects (state
   changes, billing, async processing) if any.
3. **Parameters**: a table (name, type, required/optional, default,
   description). Include units (seconds/ms, bytes/KB) in the description.
4. **Request example**: a minimal, runnable code example (curl or the
   target language). Mark credentials clearly as placeholders.
5. **Response example**: a real success example (actual sample values, not
   just types).
6. **Errors / status codes**: a table (code, meaning, whether to retry).
7. **Rate limits / deprecation notices** (if applicable): don't omit.

## Checklist

- [ ] Does the request example run after just swapping in values (URL/token
      fields clearly marked as placeholders)?
- [ ] Does the parameter table have a required/optional column?
- [ ] Does each error code say what the client should do about it?
- [ ] Do deprecated parameters/endpoints point to a migration path?
- [ ] Are units (time, size, currency) stated explicitly?
