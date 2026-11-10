# Obsidian note type

Create a reusable Markdown knowledge note for an Obsidian vault. Start from
`assets/templates/obsidian.md`; community plugins are not required.

## Target reader

A vault owner or collaborator who needs to retrieve a technical conclusion,
understand its evidence and limits, and navigate to related notes later.

## Settle before writing

- The note's reader and one-sentence retrieval or action goal.
- The destination vault, folder, and naming conventions, if known.
- Whether the deliverable is a reusable Templates file or a completed note.
- Existing property names/types, tags, aliases, and related note paths.

Use the normal one-question-at-a-time intake for missing information. If the
vault is unavailable, state that link resolution has not been checked; do
not invent existing notes or claim that example links resolve.

## Format and properties

Use UTF-8 Markdown with YAML properties at the very beginning, one H1 title,
and H2 body sections. Keep properties flat and property names unique.
`aliases` and `tags` are lists; the template leaves them empty rather than
inventing a classification. Add tags without a leading `#`. The custom
`type` and `status` fields are editable text, not built-in workflow automation.
Match the destination vault's property types instead of changing them.

The template uses only core Templates variables:

- `{{title}}` inserts the active note's title into the H1.
- `{{date:YYYY-MM-DD}}` records the insertion date in `created`.

Keep date variables quoted in YAML. Edit the reusable template in Source
mode so the Properties editor does not replace unresolved variables.
`created` is not automatically refreshed or guaranteed to be a file's actual
creation date. Do not add an `updated` field and imply that core Templates
tracks later modifications.

For a completed note generated directly by an agent, replace the variables
with the intended note title and known date; do not leave template tokens
behind. Use the intended vault filename as the title, not the template
filename. Keep tokens intact when delivering a reusable template.

## Install and use the reusable template

1. Copy `assets/templates/obsidian.md` into a template folder inside the
   destination vault, for example `Templates/obsidian.md`. Do not overwrite
   an existing file without approval.
2. Enable the core Templates plugin in Obsidian's settings.
3. Set **Settings → Templates → Template folder location** to that folder.
4. Create and name an empty destination note, then run
   **Templates: Insert template** with the cursor in the note body.
5. Fill the prose placeholders, choose tags and aliases, and replace or
   remove the example links and task before treating the note as complete.

Kotonoha installs the skill assets, not an Obsidian vault configuration.
It does not enable plugins or set the template folder automatically.
This template does not require Templater, Dataview, or custom scripts.

## Recommended skeleton and links

The H1 and lead paragraph establish what the note is for. Follow with the
conclusion, evidence and examples, applicability and uncertainty, related
notes, next checks, and sources. Remove optional empty sections when creating
a final note unless the caller has frozen its structure.

Use `[[Note name|Display text]]` for related notes and
`[[Note name#Heading]]` for specific sections. Include a vault-relative path
when note names are ambiguous. Quote the entire wikilink if placing one in
YAML, for example `related: "[[Projects/Architecture]]"`.

The `> [!summary]` block is an Obsidian callout, and `- [ ]` is an unchecked
task. Backlinks are computed by Obsidian; do not fill a fake backlinks
section. Embeds such as `![[Note name]]` are optional and require an actual
target; do not add an unresolved embed by default.

Wikilinks and callouts may not render equivalently outside Obsidian. Use
ordinary Markdown links and blockquotes if portability is the priority.
Kotonoha's Markdown diagnostics do not validate vault link targets or
Obsidian rendering. Preserve wikilink destinations, heading fragments,
display aliases, embeds, and callout markers during prose optimization;
pass complete protected link strings through `--protect` where the generic
invariant checker does not recognize Obsidian syntax.

## Checklist

- [ ] Is the result explicitly a reusable template or a completed note?
- [ ] Are properties flat, unique, and compatible with the vault's types?
- [ ] Are YAML date variables and YAML wikilinks quoted?
- [ ] Are core variables retained only in reusable templates, with no
      unrequested community-plugin dependency?
- [ ] Do the title and lead identify the reader's retrieval or action goal?
- [ ] Are conclusions separated from evidence, interpretation, and unknowns?
- [ ] Are example links/tasks replaced or removed in a completed note, and
      are unchecked link targets reported honestly?
- [ ] Are template installation and date-update limitations clear?

## Official references

- [Templates](https://help.obsidian.md/plugins/templates)
- [Properties](https://help.obsidian.md/properties)
- [Internal links](https://help.obsidian.md/links)
- [Callouts](https://help.obsidian.md/callouts)
