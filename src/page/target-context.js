// Server paths stay intact in the disclosure. Only the compact header uses a
// basename, so a long directory prefix cannot hide the selected file's name.
export function describeTarget({ target, selectedPath, loading = false, unreadable = false } = {}) {
  const resolved = typeof target?.path === 'string' && target.path ? target.path : null;
  const selected = typeof target?.logicalPath === 'string' && target.logicalPath
    ? target.logicalPath : resolved || (typeof selectedPath === 'string' && selectedPath ? selectedPath : null);
  const path = resolved || selected;
  const basename = path ? path.replace(/\/+$/, '').split('/').at(-1) || '/' : null;
  const paths = resolved && selected !== resolved
    ? [{ label: 'Selected path', value: selected }, { label: 'Resolved target', value: resolved }]
    : selected ? [{ label: resolved ? 'Configuration file' : 'Selected path', value: selected }] : [];
  const description = resolved
    ? unreadable ? 'The current file could not be read. Paths from the last successful load are shown.'
      : 'Global OMOS configuration on the OpenChamber server.'
    : selected ? loading ? 'Loading the selected global OMOS configuration.'
      : 'This selected file has not loaded. Check Settings if it is missing or unreadable.'
      : loading ? 'Reading the selected path from server settings.'
        : 'No configuration path is available. Open Settings to choose the global OMOS file.';
  return {
    name: basename || (loading ? 'Loading file' : 'File unavailable'),
    paths, description,
    accessibleLabel: basename ? `Show global OMOS file details for ${basename}` : 'Show global OMOS file details',
  };
}
