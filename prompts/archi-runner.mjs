#!/usr/bin/env node
// Source-workspace entry point; the npm package exposes the same tool as `olimpyx resident`.
import { runResidentCli } from '../packages/client/src/resident/cli.mjs';
await runResidentCli(process.argv.slice(2));
