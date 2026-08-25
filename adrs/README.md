# adrs/

**This is where a contribution starts.** If there is a change you would like in
Bay, add a file here describing it and open a pull request with just that file.
See [CONTRIBUTING.md](../CONTRIBUTING.md) for why the proposal comes before the
patch rather than after it.

A file here is a `.txt` or `.md` named after the thing it is about —
`faster-cold-starts.md`, `bring-your-own-domain.txt`. No template, no numbering
scheme, no required sections. Write what you would say if you were explaining it
to somebody at a desk:

- What is wrong, missing, or slower than it should be
- What you would like instead
- Anything you already know about where it lives in the tree, or why the obvious
  fix does not work

One paragraph is a complete proposal. So is one sentence, if the sentence is
specific.

## What happens to it

We answer in the pull request. If we are aligned, we build it and the file stays
here as the record of why — which is the other reason this directory exists:
`docs/` describes how the platform works today, and this is the argument that
came first. If we are not aligned, we say why, and the file is closed with the
pull request.

Decisions we have already made in-house live in [`docs/adr/`](../docs/adr) —
numbered, and written after the argument was settled. This directory is the other
end of that pipe: the argument itself, from outside. Read one of the five in
`docs/adr/` if you want to see what a settled version looks like; you are not
expected to write one in that form.

## Not for

Bug reports — those are [issues](https://github.com/thebaycloud/bay/issues).
Vulnerabilities — those are private, see [SECURITY.md](../SECURITY.md).
