// Source provenance. A development receipt must say "uncommitted" plainly, and
// the release path must refuse anything it cannot bind to an approved, clean
// source revision. Nothing here writes or changes git configuration.
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';

const git = (root, args) => execFileSync('git', ['-C', root, ...args], {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
}).trim();

const attempt = (root, args) => {
  try {
    return git(root, args);
  } catch {
    return null;
  }
};

const canonical = (directory) => {
  try {
    return realpathSync(directory);
  } catch {
    return null;
  }
};

/**
 * `repository` is only true when this directory is the root of its own git
 * repository. A package folder nested inside another checkout must not borrow
 * that checkout's HEAD, cleanliness or status: canonical paths decide, because
 * a symlinked temp directory and git's own output can spell the same root
 * differently.
 */
export function readSourceState(root) {
  const toplevel = attempt(root, ['rev-parse', '--show-toplevel']);
  const canonicalRoot = canonical(root);
  const canonicalTop = toplevel === null ? null : canonical(toplevel);
  if (canonicalRoot === null || canonicalTop === null || canonicalRoot !== canonicalTop) {
    return { repository: false, commit: null, dirty: true };
  }
  const commit = attempt(root, ['rev-parse', '--verify', 'HEAD']) ?? null;
  const status = attempt(root, ['status', '--porcelain=v1', '--untracked-files=normal']);
  return {
    repository: true,
    commit,
    dirty: status === null || status.length > 0,
  };
}

/**
 * Decide whether the tree may become a release payload. Pure so the refusal
 * rules are testable without a repository.
 */
export function classifySource({ commit, dirty, repository = true, approvedRevision = null }) {
  if (!repository) return { status: 'uncommitted', reason: 'the source directory is not a git repository' };
  if (!commit) return { status: 'uncommitted', reason: 'the repository has no commit yet' };
  if (dirty) return { status: 'dirty', reason: 'the working tree has uncommitted or untracked changes' };
  if (!approvedRevision) return { status: 'unapproved', reason: 'no approved source revision was given' };
  if (approvedRevision !== commit) {
    return { status: 'revision-mismatch', reason: 'HEAD is not the approved source revision' };
  }
  return { status: 'release-eligible', reason: 'clean tree at the approved source revision' };
}

/**
 * The non-sensitive source block of the build receipt. Only a clean HEAD of the
 * package's own repository can be named: every other case says uncommitted, and
 * deliberately carries no SHA and dirty:true so a receipt can never imply that
 * a dirty or foreign tree was a released revision. This is also the shape
 * {@link verifyPackage} enforces.
 */
export const receiptSource = (state) => (
  state.repository === true
    && typeof state.commit === 'string'
    && state.commit.length > 0
    && state.dirty === false
    ? { state: 'committed', commit: state.commit, dirty: false }
    : { state: 'uncommitted', commit: null, dirty: true }
);
