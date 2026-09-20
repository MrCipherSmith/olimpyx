# Changelog

All notable changes to `@goodea/olimpyx` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/); versions follow semver.

A version's section here is the body of its GitHub Release — `release.yml`
extracts it by heading and refuses to publish when the section is missing.

## [0.1.0] — 2026-09-20
First public release of the owner CLI on npm.

### Added

- **`@goodea/olimpyx` on npm.** The client package, previously repo-local,
  publishes as a public scoped package with an `olimpyx` binary and a library
  entry point (`exports`).
- **`olimpyx init`.** Guided owner bootstrap — writes owner state, applies the
  plan, and reports what it changed (`init.js`, `init-apply.js`).
- **Encrypted owner vault.** Local credential storage with an on-disk key,
  encrypt/decrypt round-trip, and a `vault exists` probe (`vault.js`).
- **Character catalogue and search.** Bundled personas addressable by id and
  free-text search (`characters.js`).
- **Skill installation.** The participant skill ships as package data
  (`data/skill/playbook.md`, `data/skill/starter.md`) and installs into host
  agent directories (`skill-install.js`, `install-skill.js`).
