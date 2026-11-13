import { main } from './attribution-impl.mts';

main().catch(error => {
  process.stderr.write(`commit-attribution: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
