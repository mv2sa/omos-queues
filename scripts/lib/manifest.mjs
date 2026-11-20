// The one identity this package is allowed to have. Kept in one place so the
// packager, the release script and the tests cannot drift from CONTRACT.md.
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const PACKAGE_NAME = 'omos-queues-extension';
export const EXTENSION_ID = 'omos-queues';
export const DISPLAY_NAME = 'OMOS queues';
export const PANEL_ICON = 'stack';
export const API_VERSION = 1;
export const ENGINE = '>=2.7.1';
export const SDK_VERSION = '2.7.1';
export const JSONC_PARSER_VERSION = '3.3.1';
export const PAGE_ENTRY = 'page/index.html';
export const PAGE_TITLE = 'OMOS queues';
export const SERVICE_ENTRY = 'service/main.js';
export const SERVICE_RUNTIME = 'host';
export const SERVICE_PERMISSIONS = Object.freeze({ exec: ['opencode'] });
export const CONTRIBUTION_KEYS = Object.freeze(['panel', 'page', 'service']);
export const BUILD_SCRIPTS = Object.freeze([
  'build', 'build:page', 'build:service', 'check', 'check:sdk', 'check:syntax', 'package', 'test',
]);

const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

/** Problems with the manifest identity, as human-readable strings. */
export function manifestProblems(document) {
  const problems = [];
  const add = (condition, message) => {
    if (!condition) problems.push(message);
  };
  add(document.name === PACKAGE_NAME, `package.json name must be ${PACKAGE_NAME}.`);
  // The version in package.json is canonical: it names the archive, the receipt
  // and the release tag, so a bump is packaging, not identity drift. The SDK
  // schema already requires semver.
  add(document.private === true, 'package.json must stay private.');
  add(document.type === 'module', 'package.json type must be "module".');

  const manifest = document.openchamber;
  add(Boolean(manifest && typeof manifest === 'object' && !Array.isArray(manifest)),
    'package.json needs an openchamber manifest block.');
  if (!manifest || typeof manifest !== 'object') return problems;

  add(manifest.apiVersion === API_VERSION, `openchamber.apiVersion must be ${API_VERSION}.`);
  add(same(manifest.engines, { openchamber: ENGINE }), `openchamber.engines must be {"openchamber":"${ENGINE}"}.`);

  const contributes = manifest.contributes ?? {};
  const keys = Object.keys(contributes).sort();
  add(same(keys, [...CONTRIBUTION_KEYS].sort()),
    `contributes must declare panel, page and service only (found: ${keys.join(', ') || 'none'}).`);

  const panel = contributes.panel ?? {};
  add(same(Object.keys(panel).sort(), ['icon', 'id', 'name']),
    'contributes.panel is identity only: id, name and icon, with no entry.');
  add(panel.id === EXTENSION_ID, `contributes.panel.id must be ${EXTENSION_ID}.`);
  add(panel.name === DISPLAY_NAME, `contributes.panel.name must be "${DISPLAY_NAME}".`);
  add(panel.icon === PANEL_ICON, `contributes.panel.icon must be "${PANEL_ICON}".`);

  add(same(contributes.page, { entry: PAGE_ENTRY, title: PAGE_TITLE, mobile: true }),
    `contributes.page must be {"entry":"${PAGE_ENTRY}","title":"${PAGE_TITLE}","mobile":true}.`);

  const service = contributes.service ?? {};
  add(same(Object.keys(service).sort(), ['entry', 'permissions', 'runtime']),
    'contributes.service may declare entry, runtime and permissions only.');
  add(service.entry === SERVICE_ENTRY, `contributes.service.entry must be ${SERVICE_ENTRY}.`);
  add(service.runtime === SERVICE_RUNTIME, 'contributes.service.runtime must be "host".');
  add(same(service.permissions, SERVICE_PERMISSIONS),
    'contributes.service.permissions must be exactly {"exec":["opencode"]}.');

  const scripts = document.scripts ?? {};
  for (const name of BUILD_SCRIPTS) add(typeof scripts[name] === 'string' && scripts[name].length > 0,
    `package.json scripts.${name} is required.`);
  add(/^node --test "test\/backend\/\*\.test\.mjs" "test\/page\/\*\.test\.mjs" "test\/packaging\/\*\.test\.mjs"$/
    .test(scripts.test ?? ''),
  'scripts.test must run node --test over the backend, page and packaging test files.');
  add(/\bcheck:syntax\b/.test(scripts.check ?? '') && /\btest\b/.test(scripts.check ?? '')
    && /\bcheck:sdk\b/.test(scripts.check ?? '') && /\bpackage\b/.test(scripts.check ?? '')
    && /\bbuild\b/.test(scripts.check ?? ''),
  'scripts.check must run build, check:syntax, test, check:sdk and package.');
  add(/bundle-guest\.ts\s+src\/page\/main\.js\s+page\/main\.js$/.test(scripts['build:page'] ?? ''),
    'scripts.build:page must bundle src/page/main.js to page/main.js with the SDK bundler.');
  add(/^mkdir -p service && bun scripts\/build-service\.mjs$/.test(scripts['build:service'] ?? ''),
    'scripts.build:service must run the project service build wrapper (bun scripts/build-service.mjs).');
  add(/check-guest\.ts\s+\.$/.test(scripts['check:sdk'] ?? ''),
    'scripts.check:sdk must run the SDK check-guest.ts checker.');

  const dependencies = document.dependencies ?? {};
  add(same(dependencies, { '@openchamber/sdk': SDK_VERSION, 'jsonc-parser': JSONC_PARSER_VERSION }),
    `dependencies must be exactly @openchamber/sdk ${SDK_VERSION} and jsonc-parser ${JSONC_PARSER_VERSION}.`);
  add(document.devDependencies === undefined || Object.keys(document.devDependencies).length === 0,
    'No devDependencies: the package uses Node built-ins only.');
  return problems;
}

/** Read package.json, validate it through the SDK schema and this identity. */
export async function readManifest(root) {
  const file = path.join(root, 'package.json');
  const text = await readFile(file, 'utf8');
  let document;
  try {
    document = JSON.parse(text);
  } catch {
    throw new Error('package.json is not valid JSON.');
  }
  const { parseManifestJson } = await import('@openchamber/sdk/schemas');
  const parsed = parseManifestJson(text);
  if (!parsed.ok) throw new Error(`package.json: ${parsed.code}: ${parsed.message}`);
  const problems = manifestProblems(document);
  if (problems.length > 0) throw new Error(`package.json identity:\n- ${problems.join('\n- ')}`);
  return { text, document, manifest: parsed.manifest, version: document.version };
}
