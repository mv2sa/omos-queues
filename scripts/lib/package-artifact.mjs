// Stage, archive and verify the install payload. Every check reads the bytes it
// claims to verify: the staged directory, the archive in dist/, and the receipt
// written beside it. A clean git status is never accepted as proof.
import fs from 'node:fs/promises';
import path from 'node:path';

import { checkRuntimeImports } from './bundles.mjs';
import {
  DIR_MODE, FILE_MODE, isInside, jsonText, listTree, personalPathHits, readPayloadFile,
  resetDirectory, sha256, writeFileExact,
} from './fs-util.mjs';
import { PACKAGE_NAME, EXTENSION_ID, ENGINE, SDK_VERSION, readManifest } from './manifest.mjs';
import { PAYLOAD_FILES, collectPayload, payloadDigest } from './payload.mjs';
import { receiptSource } from './provenance.mjs';
import { buildZip, parseZip } from './zip.mjs';

export const RECEIPT_SCHEMA_VERSION = 1;
export const RECEIPT_FILE = 'receipt.json';
export const INSTALL_DIR = 'install';

export const archiveName = (version) => `${EXTENSION_ID}-${version}.zip`;
export const archivePathIn = (out, version) => path.join(out, archiveName(version));
export const installPathIn = (out) => path.join(out, INSTALL_DIR);

export function createReceipt({ version, files, archive, source, checks }) {
  return {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    package: { name: PACKAGE_NAME, version, extensionId: EXTENSION_ID },
    host: { sdk: SDK_VERSION, engine: ENGINE },
    source: receiptSource(source),
    archive: { file: archiveName(version), bytes: archive.length, sha256: sha256(archive) },
    members: payloadDigest(files),
    checks,
  };
}

const payloadProblems = (files) => {
  const problems = [];
  for (const [memberPath, data] of files) {
    if (!data.length) problems.push(`${memberPath} is empty.`);
    if (personalPathHits(data.toString('utf8'))) problems.push(`${memberPath} contains a local absolute path.`);
  }
  return problems;
};

/** Write dist/install from the collected bytes and read every byte back. */
export async function stagePayload(out, files) {
  if (files.size !== PAYLOAD_FILES.length) throw new Error('Payload member count changed while staging.');
  const problems = payloadProblems(files);
  if (problems.length > 0) throw new Error(`Payload:\n- ${problems.join('\n- ')}`);
  const install = installPathIn(out);
  await resetDirectory(install);
  for (const relative of PAYLOAD_FILES) {
    const target = path.join(install, relative);
    if (!isInside(install, target)) throw new Error(`Payload path escapes the install directory: ${relative}`);
    await writeFileExact(target, files.get(relative), FILE_MODE);
  }
  for (const relative of PAYLOAD_FILES) {
    const { data } = await readPayloadFile(install, relative);
    if (!data.equals(files.get(relative))) throw new Error(`Staged ${relative} does not match its source bytes.`);
  }
  const staged = (await listTree(install)).map((file) => path.relative(install, file).split(path.sep).join('/')).sort();
  if (JSON.stringify(staged) !== JSON.stringify([...PAYLOAD_FILES].sort())) {
    throw new Error(`The staged payload is not the exact allowlist: ${staged.join(', ')}`);
  }
  return install;
}

/** Build the archive from payload bytes, twice, and prove the bytes agree. */
export function buildArchive(files) {
  const entries = [...files].map(([memberPath, data]) => ({ path: memberPath, data }));
  const archive = buildZip(entries);
  const repeated = buildZip([...entries].reverse());
  if (!archive.equals(repeated)) throw new Error('The archive is not deterministic for identical input bytes.');
  const parsed = parseZip(archive);
  if (parsed.entries.length !== files.size) throw new Error('The archive member count does not match the payload.');
  for (const entry of parsed.entries) {
    const expected = files.get(entry.path);
    if (!expected) throw new Error(`The archive contains an unexpected member: ${entry.path}`);
    if (!entry.data.equals(expected)) throw new Error(`The archive member ${entry.path} does not match its payload bytes.`);
    if (entry.mode !== 0o100644) throw new Error(`The archive member ${entry.path} has an unexpected mode.`);
  }
  return archive;
}

/** Full verification from disk: staged payload, archive and receipt. */
export async function verifyPackage({ root, out, expectCommit = null }) {
  const { version } = await readManifest(root);
  const files = await collectPayload(root);
  const install = installPathIn(out);
  const archiveFile = archivePathIn(out, version);

  const problems = [];
  const staged = (await listTree(install)).map((file) => path.relative(install, file).split(path.sep).join('/')).sort();
  if (JSON.stringify(staged) !== JSON.stringify([...PAYLOAD_FILES].sort())) {
    problems.push(`staged payload is not the exact allowlist (${staged.join(', ') || 'empty'})`);
  }
  for (const relative of PAYLOAD_FILES) {
    const { data, info } = await readPayloadFile(install, relative);
    if ((info.mode & 0o777) !== FILE_MODE) problems.push(`staged ${relative} is not mode 0644`);
    if (!data.equals(files.get(relative))) problems.push(`staged ${relative} differs from the source payload`);
  }

  let archive;
  try {
    archive = await fs.readFile(archiveFile);
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`${path.basename(archiveFile)} is missing from dist/.`);
    throw error;
  }
  const parsed = parseZip(archive);
  if (JSON.stringify(parsed.entries.map((entry) => entry.path)) !== JSON.stringify([...PAYLOAD_FILES])) {
    problems.push('archive members are not exactly the allowlist, in order');
  }
  for (const entry of parsed.entries) {
    const expected = files.get(entry.path);
    if (!expected) problems.push(`archive has an unexpected member ${entry.path}`);
    else if (!entry.data.equals(expected)) problems.push(`archive member ${entry.path} differs from the source payload`);
  }

  let receipt;
  try {
    receipt = JSON.parse(await fs.readFile(path.join(out, RECEIPT_FILE), 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error('dist/receipt.json is missing.');
    throw new Error('dist/receipt.json is not valid JSON.');
  }
  const receiptBytes = Buffer.from(jsonText(receipt));
  if (personalPathHits(receiptBytes.toString('utf8'))) problems.push('the receipt contains a local absolute path');
  if (receipt.schemaVersion !== RECEIPT_SCHEMA_VERSION) problems.push('receipt schemaVersion is not 1');
  if (JSON.stringify(receipt.package) !== JSON.stringify({
    name: PACKAGE_NAME, version, extensionId: EXTENSION_ID,
  })) problems.push('receipt package identity does not match the manifest');
  if (JSON.stringify(receipt.host) !== JSON.stringify({ sdk: SDK_VERSION, engine: ENGINE })) {
    problems.push('receipt host contract does not match the pinned SDK');
  }
  if (receipt.archive?.file !== path.basename(archiveFile) || receipt.archive?.bytes !== archive.length
    || receipt.archive?.sha256 !== sha256(archive)) problems.push('receipt archive digest does not match the archive bytes');
  if (JSON.stringify(receipt.members) !== JSON.stringify(payloadDigest(files))) {
    problems.push('receipt member digests do not match the payload');
  }
  for (const check of ['manifest', 'whitelist', 'deterministic', 'sdkChecker', 'runtimeImports']) {
    if (receipt.checks?.[check] !== 'passed') problems.push(`receipt check ${check} is not passed`);
  }
  if (!['committed', 'uncommitted'].includes(receipt.source?.state)) {
    problems.push('receipt source state is missing');
  } else if (receipt.source.state === 'uncommitted' && (receipt.source.dirty !== true || receipt.source.commit !== null)) {
    problems.push('an uncommitted receipt must say dirty and carry no commit');
  } else if (receipt.source.state === 'committed' && (receipt.source.dirty !== false || !/^[0-9a-f]{40}$/.test(receipt.source.commit ?? ''))) {
    problems.push('a committed receipt must name the clean source commit');
  }
  if (expectCommit !== null && (receipt.source?.state !== 'committed' || receipt.source?.commit !== expectCommit)) {
    problems.push(`the receipt is not built from ${expectCommit}`);
  }

  try {
    await checkRuntimeImports(install);
  } catch (error) {
    problems.push(error.message);
  }

  if (problems.length > 0) throw new Error(`Package verification failed:\n- ${problems.join('\n- ')}`);
  return { receipt, archive };
}

/** Write dist/<name>.zip and dist/receipt.json, then verify both from disk. */
export async function writeArtifacts(out, { archive, receipt }) {
  await fs.mkdir(out, { recursive: true, mode: DIR_MODE });
  const archiveFile = path.join(out, receipt.archive.file);
  for (const file of [archiveFile, path.join(out, RECEIPT_FILE)]) {
    await fs.rm(file, { force: true });
  }
  await writeFileExact(archiveFile, archive, FILE_MODE);
  const written = await fs.readFile(archiveFile);
  if (sha256(written) !== receipt.archive.sha256) throw new Error('The written archive does not match its digest.');
  await writeFileExact(path.join(out, RECEIPT_FILE), Buffer.from(jsonText(receipt)), FILE_MODE);
  return archiveFile;
}
