/** Observer failures are bounded diagnostics, never migration control flow. */
export function progressObserver(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('options must be an object');
  const callback = options.onProgress;
  if (callback !== undefined && typeof callback !== 'function') throw new Error('onProgress must be a function');
  const warnings = new Set();
  let sequence = 0;
  const warn = message => { if (warnings.size < 16) warnings.add(message); };
  return {
    emit(event) {
      if (!callback) return;
      try {
        const result = callback(Object.freeze({ ...event, sequence: ++sequence, timestamp: new Date().toISOString() }));
        if (result && typeof result.then === 'function') {
          warn('onProgress must be synchronous; returned Promise was ignored');
          Promise.resolve(result).catch(() => {});
        }
      } catch (error) { warn(`onProgress: ${error?.message ?? String(error)}`); }
    },
    finish(report) {
      if (warnings.size) report.progress_warnings = [...(report.progress_warnings ?? []), ...warnings].slice(0, 16);
      return report;
    },
  };
}
