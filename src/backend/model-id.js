// OMOS-compatible model identifiers. Provider tokens may be any non-slash,
// non-whitespace token; model ids are non-whitespace. Placeholders are never
// expanded and may not be introduced by an edit.
export const MAX_MODEL_ID = 500;
export const MAX_VARIANT = 500;

const CONTROL = /[\u0000-\u001f\u007f]/;
const DOLLAR_PLACEHOLDER = /\$\{[^}]*\}/;
const OMOS_PLACEHOLDER = /\{env:[^}]*\}/i;

export function isModelId(value) {
  if (typeof value !== 'string' || !value.length || value.length > MAX_MODEL_ID) return false;
  if (/\s/.test(value) || CONTROL.test(value)) return false;
  const slash = value.indexOf('/');
  return slash > 0 && slash < value.length - 1;
}

export function isValidVariant(value) {
  return typeof value === 'string'
    && value.length <= MAX_VARIANT
    && !CONTROL.test(value)
    && !/[\r\n]/.test(value);
}

export function hasPlaceholder(value) {
  return typeof value === 'string'
    && (DOLLAR_PLACEHOLDER.test(value) || OMOS_PLACEHOLDER.test(value));
}
