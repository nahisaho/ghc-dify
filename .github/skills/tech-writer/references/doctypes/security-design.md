# Security design and threat model type

A security design and threat model identifies protected assets, trust
boundaries, threats, controls, verification, and residual risk. It turns
security and compliance requirements into reviewable implementation and
operational decisions.

## Target reader

Architects, developers, platform and security engineers, privacy and
compliance reviewers, operators, and accountable risk acceptors.

## Settle before writing

- System scope, architecture, data flows, trust boundaries, and environments
- Assets, owners, sensitivity, retention, and regulatory obligations
- Identities, roles, administrative paths, and external dependencies
- Threat-model method and risk-rating approach
- Security testing, exception, and residual-risk acceptance authority
- The approved requirements and system-design baselines

## Responsibility boundary

Document security decisions and trace threats to controls and tests. Do not
include credentials, private keys, exploitable production details, or
instructions that bypass controls. Vulnerability findings needing restricted
handling belong in the repository's approved security-reporting channel.

The security section in `system-design` is sufficient for an integrated
architecture summary. Use a standalone `security-design` when threat
modeling, control ownership, compliance evidence, exceptions, or risk
acceptance needs independent review. When both exist, the security design is
authoritative for threats, controls, and residual risk.

This document owns security-test intent by tracing requirements and threats
to controls and planned tests, including the expected environment class and
required evidence type. The `test-plan` owns actual execution environments,
schedule, release gates, results, and evidence storage; copy the security
test IDs, threat IDs, and control IDs into its traceability table.

## Template

Start from `assets/templates/security-design.md`.
The template is the Japanese-language skeleton; translate its headings when
the target document is English.

## Recommended skeleton

1. Scope, requirements, assets, data classification, and architecture
2. Trust boundaries, identity, authentication, authorization, and threats
3. Preventive, detective, and responsive controls with ownership
4. Data, secret, API, audit, vulnerability, and supply-chain protection
5. Security testing, incident response, residual risk, traceability, and approval

## Checklist

- [ ] Are system scope, assets, owners, data flows, and trust boundaries clear?
- [ ] Are identities, authentication, authorization, privilege, session, and
      recovery paths covered?
- [ ] Does each credible threat identify affected assets, impact, likelihood,
      controls, owner, and test?
- [ ] Are encryption, key and secret lifecycle, retention, deletion, masking,
      logging, and audit addressed?
- [ ] Are input, output, API abuse, availability, dependency, build, artifact,
      and supply-chain risks covered?
- [ ] Are security tests, incident response, evidence preservation, and
      notification responsibilities defined?
- [ ] Is every exception time-bound, owned, compensated, and accepted by an
      accountable risk owner?
- [ ] Can requirements, assets, threats, controls, tests, and implementation
      locations be traced end to end?
