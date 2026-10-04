// Binary modules bundled by Wrangler (see wrangler.jsonc `rules`).
declare module '*.ttf' {
  const data: ArrayBuffer
  export default data
}
// The workerd build of the Takumi wasm resolves to a real WebAssembly.Module.
declare module '@takumi-rs/wasm/auto' {
  const mod: WebAssembly.Module
  export default mod
}
