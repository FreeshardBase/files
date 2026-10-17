// The fake OIDC provider (server/test/support/fakeIdp.ts) on its own, for the container smoke test: prints the issuer
// on the first line of stdout and serves until it is terminated. It listens on 127.0.0.1 only.
import { startFakeIdp } from '../../server/test/support/fakeIdp.ts';

const idp = await startFakeIdp();
console.log(idp.issuer);
const stop = () => { void idp.close().then(() => { process.exitCode = 0; }); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
