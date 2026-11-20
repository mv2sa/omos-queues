// Built entry (service/main.js). Importing this module is passive so packaging
// can check the module in place; the host executes it directly to serve.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createServiceServer, startService, VERSION } from './server.js';

export { createServiceServer, startService, VERSION };

function realPath(file) {
  try {
    return fs.realpathSync(file);
  } catch {
    return null;
  }
}

function isExecuted() {
  const entry = process.argv[1];
  if (!entry) return false;
  // Compare real paths: the host may start a symlinked install path while Node
  // reports the resolved module URL.
  const invoked = realPath(entry);
  const modulePath = realPath(fileURLToPath(import.meta.url));
  return invoked !== null && modulePath !== null && invoked === modulePath;
}

if (isExecuted()) {
  startService().catch(error => {
    console.error(`OMOS queues service failed to start: ${error?.message ?? 'unknown error'}`);
    process.exitCode = 1;
  });
}
