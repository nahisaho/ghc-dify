# Release notes / CHANGELOG type

The recommended skeleton and checklist for a per-version changelog entry,
written for a reader deciding whether and how to upgrade.

## Target reader

An existing user deciding whether to upgrade. Reading time: seconds to a
few tens of seconds.

## Recommended skeleton

1. **Version + date**: always include both in the heading.
2. **Breaking changes (topmost, if any)**: what breaks, with a link to the
   migration steps. This is the one section that must never be omitted or
   deferred.
3. **Added / Changed / Fixed / Deprecated / Removed**: categorize per
   [Keep a Changelog](https://keepachangelog.com/). One change per item,
   starting with a verb.
4. **Notes on affected user segments** (if applicable): scope it, e.g.
   "affects only users of X".

## Checklist

- [ ] Are breaking changes at the top, with a migration path (or link)?
- [ ] Does each item state "what changed and how" in one sentence (not a
      raw copy of the commit message)?
- [ ] Do the categories (Added/Changed/Fixed, etc.) match the actual
      change?
- [ ] Are both the version number and the date stated?
