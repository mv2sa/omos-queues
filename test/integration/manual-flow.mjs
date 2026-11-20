import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { openExtensionPage, readUiState } from './ui-flow.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const sha = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/**
 * Primary override UI proof. Caller supplies a synthetic target with an
 * existing supported preset and a disconnected marketplace source.
 */
export async function runPrimaryDomWorkflow({ browser, context, baseUrl, pageTitle, configFile, artifactsDir, serviceJson }) {
  const checks = {};
  const check = (name, ok, detail = null) => {
    checks[name] = { ok: Boolean(ok), ...(detail ? { detail } : {}) };
    if (!ok) throw Object.assign(new Error(`Primary DOM check failed: ${name}`), { checks });
  };
  const wait = async predicate => {
    const end = Date.now() + 15000;
    let state;
    while (Date.now() < end) {
      state = await readUiState(browser, context);
      if (predicate(state)) return state;
      await delay(150);
    }
    throw new Error(`Primary UI did not settle: ${JSON.stringify(state)}`);
  };
  const hash = () => sha(configFile);
  const backups = () => fs.readdirSync(path.dirname(configFile)).filter(name => name.includes('.bak.pre-ui-')).length;
  let state = await wait(s => s.workspace?.count > 0 && s.footer?.visible);
  const beforeDocument = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  const source = await serviceJson('GET', '/marketplace/source');
  check('primary-independent-of-marketplace', source.rootPath === '');
  const absentBuild = await browser.evaluate(`!document.querySelector('[data-primary-agent="build"]')
    && !Array.from(document.querySelectorAll('.queue-nav [data-queue]')).some(b => /^Build(?:$|\\s*\\()/i.test(b.textContent.trim()))`, { context });
  check('no-uneditable-build-in-editor', absentBuild);
  const slot = await browser.evaluate(`(() => {
    const nodes = [...document.querySelectorAll('.queue-workspace[data-primary-agent="orchestrator"][data-preset]')];
    return nodes.find(node => {
      const button = node.querySelector('[data-primary-action="create"]');
      return button && !button.disabled && button.getClientRects().length > 0;
    })?.dataset.preset || null;
  })()`, { context });
  check('supported-existing-preset-slot', Boolean(slot), slot);
  const baseline = hash();
  const backupBaseline = backups();
  const selector = `.queue-workspace[data-primary-agent="orchestrator"][data-preset=${JSON.stringify(slot)}] [data-primary-action="create"]`;
  await browser.pointerClick(selector, { context });
  await wait(s => !s.picker.hidden);
  await browser.typeText('synthetic/manual-orchestrator', { context });
  await browser.pressKey('Escape', { context });
  await wait(s => s.picker.hidden);
  let drafts = (await serviceJson('GET', '/drafts')).drafts ?? [];
  check('cancel-first-model-does-not-stage', hash() === baseline && !drafts.some(d => d.targetPath === configFile) && backups() === backupBaseline);

  await browser.pointerClick(selector, { context });
  await wait(s => !s.picker.hidden);
  await browser.typeText('synthetic/manual-orchestrator', { context });
  await browser.pressKey('Enter', { context });
  state = await wait(s => s.workspace.ids.some(id => id?.includes('orchestrator') && id.includes(slot)) && s.footer.dirty !== 'No unsaved changes');
  check('manual-primary-staged-no-file-write', hash() === baseline && backups() === backupBaseline, state.footer);
  const draftEnd = Date.now() + 15000;
  let draft;
  while (Date.now() < draftEnd) {
    drafts = (await serviceJson('GET', '/drafts')).drafts ?? [];
    draft = drafts.find(item => item.targetPath === configFile && item.version === 3 && item.primaryCreations?.length);
    if (draft) break;
    await delay(200);
  }
  check('v3-primary-draft-persisted', Boolean(draft), drafts);

  await browser.navigate(baseUrl, {timeoutMs:30_000});
  const frame = await openExtensionPage(browser, { baseUrl, pageTitle });
  context = frame.context;
  state = await wait(s => s.workspace?.count > 0 && s.footer?.visible);
  check('reload-does-not-auto-recover', state.footer.dirty === 'No unsaved changes' && hash() === baseline);
  const draftsButton = await browser.evaluate(`([...document.querySelectorAll('button')].find(b => /^Drafts \\(\\d+\\)$/.test((b.innerText||'').trim()))||{}).innerText`, { context });
  check('drafts-offer-visible', Boolean(draftsButton));
  await browser.pointerClickText(draftsButton.trim(), { context });
  await wait(s => s.dialog.open && s.dialog.title === 'Stored drafts');
  // Other frames' retained drafts deliberately remain in the same store.
  // Target the matching row, not the first (possibly disabled) Recover action.
  const matchRow = JSON.parse(await browser.evaluate(`JSON.stringify([...document.querySelectorAll('dialog[open] .recovery-row')].map((node,index) => ({
    index, same:node.querySelector('.recovery-path')?.textContent === ${JSON.stringify(configFile)},
    recoverEnabled:[...node.querySelectorAll('button')].some(b => b.innerText.trim() === 'Recover a copy' && !b.disabled),
    status:node.querySelector(':scope > .muted')?.textContent
  })))`, {context})).filter(row => row.same && row.recoverEnabled);
  check('reopen-offers-matching-v3', matchRow.length === 1 && matchRow[0].status.includes('Matches current file'), matchRow);
  await browser.pointerClick(`dialog[open] .recovery-row:nth-of-type(${matchRow[0].index + 1}) button:not(:disabled)`, {context, index:1});
  state = await wait(s => s.footer.dirty !== 'No unsaved changes');
  check('explicit-recovery-restores-primary', hash() === baseline && state.footer.dirty !== 'No unsaved changes');
  const reviewedHash = hash();
  const reviewedBackups = backups();
  await browser.pointerClickText('Review changes', { context });
  state = await wait(s => s.dialog.open && s.dialog.title === 'Review all changes');
  check('primary-review-inheritance-warning', /inherit/i.test(state.dialog.body)
    && !/comments inside changed values/i.test(state.dialog.body), state.dialog.body);
  check('review-is-narrow', state.dialog.diff.includes('synthetic/manual-orchestrator') && !state.dialog.diff.includes('unrelatedRootCanary'),
    state.dialog.diff);
  await browser.pointerClickText('Confirm and save', { context });
  state = await wait(s => s.footer.dirty === 'No unsaved changes' && !s.dialog.open);
  const changed = fs.readFileSync(configFile, 'utf8');
  check('single-reviewed-primary-save', hash() !== reviewedHash && backups() === reviewedBackups + 1
    && changed.includes('synthetic/manual-orchestrator'));
  const expected = structuredClone(beforeDocument);
  expected.presets[slot].agents.orchestrator = {model:[{id:'synthetic/manual-orchestrator'}]};
  const actual = JSON.parse(changed);
  check('primary-save-keeps-unrelated', JSON.stringify(actual) === JSON.stringify(expected));
  const artifact = await browser.screenshot(path.join(artifactsDir, 'primary-orchestrator-reviewed.png'));
  return { checks, artifacts: [{ name: 'primary-orchestrator-reviewed', ...artifact }], context, slot, finalHash: hash() };
}
