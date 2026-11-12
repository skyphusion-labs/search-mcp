// Node stand-in for `cloudflare:workers`. Vitest cannot load that module.
// The real WorkerEntrypoint assigns ctx and env the same way; production
// uses the runtime class, not this file.

export class WorkerEntrypoint<Env = unknown> {
  ctx: unknown;
  env: Env;
  constructor(ctx: unknown, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}
