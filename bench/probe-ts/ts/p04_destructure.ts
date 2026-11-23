interface Opts { host: string; port?: number; tls?: boolean }
function show({ host, port = 80, tls = false }: Opts): string {
  return `${host}:${port}:${tls}`;
}
function main(): void {
  const [a, b = 5, ...others] = [1, undefined, 3, 4];
  console.log(a, b, others.length);
  const { x, y: yy } = { x: 1, y: 2 };
  console.log(x + yy);
  console.log(show({ host: "h" }));
  console.log(show({ host: "h", port: 8080, tls: true }));
}
main();
