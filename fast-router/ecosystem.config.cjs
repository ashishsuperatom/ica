// PM2 ecosystem for the WHOLE fast-router system — start/stop/restart brings up (and cleanly tears
// down) every process it needs together:
//
//   pm2 start   fast-router/ecosystem.config.cjs     # Qdrant + worker (+ gliner service, if enabled)
//   pm2 restart fast-router/ecosystem.config.cjs
//   pm2 stop    fast-router/ecosystem.config.cjs
//   pm2 delete  fast-router/ecosystem.config.cjs     # clean stop — removes them from pm2
//
// Prereqs (one-time):  ./scripts/fetch-qdrant.sh   (downloads the Qdrant binary for THIS OS/arch),
//                      pnpm install,  and a provisioned fast-router project → FR_ID + FR_KEY.
//
// Portable: no macOS/CUDA-specific paths. Qdrant is the platform binary fetched above; the worker's
// GLiNER2 inference (onnxruntime-node) runs CPU-only and works the same on the Linux EC2 box.
//
// GLiNER note: with the Node path, GLiNER2 runs IN-PROCESS inside fr-worker (no separate process).
// If we switch to the Python path, enable the fr-gliner-py app at the bottom.

const root = __dirname

module.exports = {
  apps: [
    {
      // Vector DB — its own co-located service (internal datastore, not the UI transport).
      name:        'fr-qdrant',
      script:      '.qdrant/qdrant',
      cwd:         root,
      interpreter: 'none',
      watch:       false,
      autorestart: true,
      env: {
        QDRANT__STORAGE__STORAGE_PATH: `${root}/.qdrant/storage`,
        QDRANT__SERVICE__HTTP_PORT:    '6333',
      },
    },
    {
      // The worker: connects to its fast-router DO (role 'fast-router') + runs GLiNER2 in-process.
      name:        'fr-worker',
      script:      'node_modules/.bin/tsx',
      args:        'src/index.ts',
      cwd:         root,
      interpreter: 'none',
      watch:       false,
      autorestart: true,
      // Pass config through from the environment WITHOUT hardcoded defaults — an empty/undefined
      // value lets src/config.ts fall back to fast-router.local.json (dev) or its own default.
      env: {
        PATH:        process.env.PATH,
        FR_HUB_HOST: process.env.FR_HUB_HOST,      // unset → config.ts uses local.json / default
        FR_ID:       process.env.FR_ID,            // provisioned fast-router project id
        FR_KEY:      process.env.FR_KEY,           // its shared key
        FR_WORKERS:  process.env.FR_WORKERS,       // inference pool size (default 2 in config.ts)
        QDRANT_URL:  process.env.QDRANT_URL || 'http://127.0.0.1:6333',
      },
    },

    // ── Python GLiNER2 inference service — ENABLE ONLY if the benchmark says Node degrades.
    // A single queued CPU inference endpoint (uvicorn). Uncomment to run under the same lifecycle:
    // {
    //   name:        'fr-gliner-py',
    //   script:      '.venv/bin/python',
    //   args:        '-m uvicorn serve:app --host 127.0.0.1 --port 6400 --workers 1',
    //   cwd:         `${root}/gliner-service`,
    //   interpreter: 'none',
    //   autorestart: true,
    // },
  ],
}
