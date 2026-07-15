console.log(JSON.stringify({ kind: 'ready', pid: process.pid }));
const hold = setInterval(() => undefined, 1_000);
const finish = (): void => {
  clearInterval(hold);
  process.exit(0);
};
process.once('SIGTERM', finish);
process.once('SIGINT', finish);
