#!/usr/bin/env node
// Prints the --sha256 value for a message file, after the same checks the gate runs, so a refusal shows up before the ask.
// Usage: node scripts/message-hash.ts <abs path of the message file>
import { readMessage, sha256 } from "../lib/whatsapp.ts";

const file = process.argv[2];
if (!file || process.argv.length !== 3) { process.stderr.write("usage: message-hash.ts <message file>\n"); process.exit(2); }
try { process.stdout.write(`${sha256(readMessage(file))}\n`); } catch (e) { process.stderr.write(`message-hash: ${(e as Error).message}\n`); process.exit(1); }
