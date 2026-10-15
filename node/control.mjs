export function captureSignal(options) {
  const signal = options.signal;
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw new Error('signal must be an AbortSignal');
  return signal;
}

export const cancelledReport = message => ({ ok: false, kind: 'cancelled', exit_code: 4, message });
