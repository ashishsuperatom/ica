import { run, readStdin } from './cli.ts'

const code = await run(process.argv.slice(2), {
  stdout: (s) => process.stdout.write(s), stderr: (s) => process.stderr.write(s), env: process.env,
  stdin: readStdin, isTTY: !!process.stdin.isTTY, script: process.argv[1], cwd: process.cwd(),
})
if (code >= 0) process.exitCode = code   // the daemon (-1) keeps running
