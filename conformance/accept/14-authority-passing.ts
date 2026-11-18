// expect: ok
// stage: 1
// A-4: 権限。大域の console ではなく Log を受け取る
type Env = { readonly log: Log; readonly clock: Clock };

class Service {
  private readonly env: Env;

  constructor(env: Env) {
    this.env = env;
  }

  tick(): void {
    this.env.log.info(`now=${this.env.clock.nowMs()}`);
  }
}

export function main(sys: System): void {
  greet(sys.log, "world");
  const env: Env = { log: sys.log, clock: sys.clock };
  const svc = new Service(env);
  svc.tick();
  sys.log.info(readOr(sys.fs, "motd.txt", "no motd"));
  const r = sys.random.nextF64();
  if (r < 0.5) {
    sys.log.warn(`low ${r}`);
  }
}

function greet(log: Log, name: string): void {
  log.info(`hello, ${name}`);
}

function readOr(fs: Fs, path: string, fallback: string): string {
  const r = fs.readText(path);
  if (r.kind === "err") {
    return fallback;
  }
  return r.value;
}
