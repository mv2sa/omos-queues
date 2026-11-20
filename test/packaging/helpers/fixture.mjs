// Synthetic package roots with the same shape as the real repository. They let
// the packaging tests run before the backend and page lanes land their entries,
// and they keep every byte away from the real build outputs.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const SDK_CHECKER = path.join(REPO_ROOT, 'node_modules/@openchamber/sdk/scripts/check-guest.ts');

/** The command-scoped identity every test commit must use. */
export const IDENTITY = {
  name: 'Contributor Fixture',
  email: 'fixture@example.invalid',
};

export const identityEnv = () => {
  const keys = ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL'];
  if (keys.every((key) => process.env[key])) return Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  return {
    GIT_AUTHOR_NAME: IDENTITY.name,
    GIT_AUTHOR_EMAIL: IDENTITY.email,
    GIT_COMMITTER_NAME: IDENTITY.name,
    GIT_COMMITTER_EMAIL: IDENTITY.email,
  };
};

export const git = (root, args, { input, env = {} } = {}) => execFileSync('git', ['-C', root, ...args], {
  encoding: 'utf8',
  input,
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', ...identityEnv(), ...env },
}).trim();

const PAGE_BUNDLE = '(function () {\n  "use strict";\n  var root = document.getElementById("app");\n  if (root) root.textContent = "fixture";\n})();\n';

const SERVICE_BUNDLE = [
  'import http from "node:http";',
  'import path from "node:path";',
  '',
  'export const listenPort = () => Number(process.env.OPENCHAMBER_SERVICE_PORT);',
  'export const startService = (port) => http.createServer((_request, response) => {',
  '  response.end("ok");',
  '}).listen(port);',
  'export const nameOf = (file) => path.basename(file);',
  '',
].join('\n');

const SOURCE_FILES = {
  'src/page/main.js': 'export const mount = () => null;\n',
  'src/backend/main.js': [
    'export const listenPort = () => Number(process.env.OPENCHAMBER_SERVICE_PORT);',
    'export const startService = () => null;',
    '',
  ].join('\n'),
};

const DOCUMENT_FILES = {
  'README.md': '# Fixture package\n\nA synthetic install payload for packaging tests.\n',
  'LICENSE': 'Synthetic fixture license text.\n',
  'page/index.html': [
    '<!doctype html>',
    '<html lang="en">',
    '  <head>',
    '    <meta charset="utf-8">',
    '    <title>OMOS queues</title>',
    '    <link rel="stylesheet" href="styles.css">',
    '    <script defer src="main.js"></script>',
    '  </head>',
    '  <body><div id="app"></div></body>',
    '</html>',
    '',
  ].join('\n'),
  'page/styles.css': ':root { color-scheme: light dark; }\n#app { display: block; }\n',
};

export const GITIGNORE = 'node_modules/\ndist/\npage/main.js\nservice/main.js\n';

const writeText = async (file, text, mode = 0o644) => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text, { mode });
};

/** package.json content, optionally at another version (a release bump). */
export async function manifestText(version = null) {
  const text = await fs.readFile(path.join(REPO_ROOT, 'package.json'), 'utf8');
  if (version === null) return text;
  const document = JSON.parse(text);
  document.version = version;
  return `${JSON.stringify(document, null, 2)}\n`;
}

async function writeDocuments(root, version) {
  await writeText(path.join(root, 'package.json'), await manifestText(version));
  await writeText(path.join(root, 'THIRD_PARTY_NOTICES.md'), await fs.readFile(path.join(REPO_ROOT, 'THIRD_PARTY_NOTICES.md'), 'utf8'));
  for (const [relative, text] of Object.entries(DOCUMENT_FILES)) await writeText(path.join(root, relative), text);
  for (const [relative, text] of Object.entries(SOURCE_FILES)) await writeText(path.join(root, relative), text);
}

// Synthetic release fixtures keep their own version across product releases.
export async function createFixture({ version = '0.1.0', prebuild = true, within = null } = {}) {
  const base = within === null
    ? await fs.mkdtemp(path.join(os.tmpdir(), 'omos-packaging-'))
    : await fs.mkdtemp(path.join(within, 'omos-nested-'));
  const root = path.join(base, 'package-root');
  await writeDocuments(root, version);
  if (prebuild) {
    await writeText(path.join(root, 'page/main.js'), PAGE_BUNDLE);
    await writeText(path.join(root, 'service/main.js'), SERVICE_BUNDLE);
  }

  // The bundles must look newer than their sources, exactly as after a build.
  const past = new Date(Date.now() - 60_000);
  for (const source of Object.keys(SOURCE_FILES)) {
    await fs.utimes(path.join(root, source), past, past);
  }
  return {
    base,
    root,
    out: path.join(root, 'dist'),
    checker: SDK_CHECKER,
    cleanup: () => fs.rm(base, { recursive: true, force: true }),
  };
}

/**
 * A disposable git repository with the fixture package at its root. `release`
 * payload commits, branches and tags can be created here without touching the
 * real repository, and a bare `origin` can be attached for push proofs.
 */
export async function createScratchRepository({ version = '0.1.0' } = {}) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'omos-release-'));
  const root = path.join(base, 'repo');
  await writeText(path.join(root, '.gitignore'), GITIGNORE);
  await writeDocuments(root, version);
  // The scratch root builds with the same project scripts as the real checkout.
  await fs.cp(path.join(REPO_ROOT, 'scripts'), path.join(root, 'scripts'), { recursive: true });
  await fs.symlink(path.join(REPO_ROOT, 'node_modules'), path.join(root, 'node_modules'), 'dir');

  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'fixture package']);

  return {
    base,
    root,
    out: path.join(root, 'dist'),
    checker: SDK_CHECKER,
    git: (args, options) => git(root, args, options),
    head: () => git(root, ['rev-parse', 'HEAD']),
    commitAll: (message) => {
      git(root, ['add', '-A']);
      git(root, ['commit', '-q', '-m', message]);
      return git(root, ['rev-parse', 'HEAD']);
    },
    setVersion: async (next) => {
      await writeText(path.join(root, 'package.json'), await manifestText(next));
      return git(root, ['rev-parse', 'HEAD']);
    },
    cleanup: () => fs.rm(base, { recursive: true, force: true }),
  };
}

export async function rewrite(root, relative, text) {
  await fs.writeFile(path.join(root, relative), text);
}

export async function remove(root, relative) {
  await fs.rm(path.join(root, relative), { force: true });
}
