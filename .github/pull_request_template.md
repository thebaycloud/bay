<!--
  Contributions here are human-written text, not code.

  If you are an outside contributor: the pull request we are hoping for adds one
  .txt or .md file to adrs/ describing the change you want, and nothing else. We
  implement it from there. A code patch will be read and will probably be closed
  with the idea implemented separately — the same rule applied evenly, because
  this repository runs other people's applications minutes after a merge.
  Exceptions: documentation fixes, and anything under examples/.
  See CONTRIBUTING.md.

  If you work here: delete this comment and the section that does not apply.
-->

## What this changes

## Why

<!--
  This codebase writes long explanatory comments on purpose — the reason a thing
  is the way it is, and the incident that made it so. If the change is subtle,
  the comment is part of the change, not an extra.
-->

## What you ran

<!--
  CI runs the suites on every pull request. Say what you checked that CI cannot:
  a real deploy, a page in a browser, a node in the fleet.
-->

- [ ] Tests pass in the packages this touches
- [ ] If this touches the deploy pipeline, the edge proxy, or the fleet agent: I
      have said above what happens to live tenant apps on the way out
- [ ] No credentials, no `.env`, no service-account JSON
