import { run, readStdin } from './cli.ts'

const code = await run(process.argv.slice(2), {
  stdout: (s) => process.stdout.write(s), stderr: (s) => process.stderr.write(s), env: process.env,
  stdin: readStdin, isTTY: !!process.stdin.isTTY, script: process.argv[1], cwd: process.cwd(),
})
// A command is done when run() returns: exit then, once the output is written, rather than waiting on a socket's closing
// handshake. The background connection (-1) keeps running.
if (code >= 0) process.stdout.write('', () => process.stderr.write('', () => process.exit(code)))
