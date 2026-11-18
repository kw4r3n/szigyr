// expect: E4002 @ 4:34
// stage: 2
function id<T>(x: T): T { "use owned"; return x; }
function f(): string { return id<string>("a"); }
