#!/usr/bin/env node
// Entry point: `node src/cli.mjs <command> ...`
import { run, render } from './mem-cli.mjs'

const argv = process.argv.slice(2)
const flags = {}
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--text' || argv[i] === '-t') flags.text = true
}

const result = await run(argv)
process.stdout.write(render(result, flags) + '\n')
process.exit(result.ok ? 0 : 1)
