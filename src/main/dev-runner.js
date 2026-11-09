/**
 * DuoAudio - Development Workflow Runner
 *
 * Starts a live Vite development server in memory using Vite's Node API,
 * then spawns the Electron main process connected to the local development URL.
 * Delivers instant React Fast Refresh (HMR) without requiring external packages
 * like concurrently or wait-on.
 */

const { spawn } = require('child_process');
const path = require('path');
const electron = require('electron');

async function startDev() {
  console.log('[DEV-RUNNER] Starting Vite development server...');

  const { createServer } = await import('vite');

  const viteServer = await createServer({
    configFile: path.join(__dirname, '../../vite.config.mjs'),
    mode: 'development'
  });

  await viteServer.listen();

  const address = viteServer.httpServer.address();
  const port = typeof address === 'object' && address !== null ? address.port : 5173;
  const devUrl = `http://localhost:${port}`;

  console.log(`[DEV-RUNNER] Vite dev server listening at ${devUrl}`);
  console.log('[DEV-RUNNER] Spawning Electron main process...');

  const childEnv = {
    ...process.env,
    NODE_ENV: 'development',
    VITE_DEV_SERVER_URL: devUrl
  };
  delete childEnv.ELECTRON_RUN_AS_NODE;

  const electronProcess = spawn(electron, ['.', '--dev'], {
    cwd: path.join(__dirname, '../..'),
    env: childEnv,
    stdio: 'inherit'
  });

  let isCleaningUp = false;
  const cleanup = async () => {
    if (isCleaningUp) return;
    isCleaningUp = true;
    console.log('[DEV-RUNNER] Received shutdown signal. Stopping processes...');
    if (electronProcess && !electronProcess.killed) {
      try {
        electronProcess.kill('SIGINT');
      } catch (_) {}
    }
    try {
      await viteServer.close();
    } catch (_) {}
    process.exit(0);
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  electronProcess.on('close', async (code) => {
    if (isCleaningUp) return;
    isCleaningUp = true;
    console.log(`[DEV-RUNNER] Electron process exited with code ${code}. Stopping Vite server...`);
    await viteServer.close();
    process.exit(code || 0);
  });

  electronProcess.on('error', async (err) => {
    if (isCleaningUp) return;
    isCleaningUp = true;
    console.error('[DEV-RUNNER] Electron process error:', err.message);
    await viteServer.close();
    process.exit(1);
  });
}

startDev().catch((err) => {
  console.error('[DEV-RUNNER FATAL]:', err);
  process.exit(1);
});
