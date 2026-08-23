---
title: Self-hosting open source is free for a year
date: 2026-08-24
draft: true
summary: Any public repo under an OSI-approved licence runs free for its first year, detected at deploy with nothing to claim.
---

Self-host an open source project on Bay and the first year is free. Not a trial and not a credit.

## Nothing to claim

There is no form and no code. When you deploy, we look at where the source came from: the git remote your agent cloned and a commit from its history. If that repo is public and carries an OSI-approved licence, the year is applied and the command line tells you so.

Checking the history rather than just the URL matters. A remote is a string you control, so anyone could point one at a popular project and ask for a free year. A commit cannot be faked without actually having the code.

## Forks count

Forking a project to run your own copy is the normal way to self-host something. The fork's history descends from the original, so it passes.

## Why

We want software to be easier for anyone to run. Most of the software worth running is open source, and the cost of putting it somewhere is the part that stops people.
