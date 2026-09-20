export const streamPerfMetrics = {
  outputBytes: 0,
  outputChunks: 0,
  outputFlushes: 0,
  outputResyncRequests: 0,
  outputResyncCompleted: 0,
  droppedOutputChars: 0,
  sanitizeCalls: 0,
  sanitizeChars: 0,
  attachRequests: 0,
  snapshotRequests: 0,
  resizeRequests: 0,
  paneScrollRequests: 0,
  copyModeCancelRequests: 0,
  inputMessages: 0,
  backpressureSignals: 0,
  profileUpdates: 0,
  deferredFlushes: 0,
  socketBufferedBytes: 0,
  activeClients: 0,
  activeProfile: 'foreground' as 'foreground' | 'background' | 'mobile',
  activeFlushInterval: 8,
  activeMaxChars: 65536,
  compressFrames: 0,
  compressBytesIn: 0,
  compressBytesOut: 0,
  cellSnapshots: 0,
  cellDiffs: 0,
  cellFallbackAnsi: 0,
  cellDirtyCells: 0,
  redrawRequests: 0,
  droppedDuplicateChunks: 0,
  snapshotCaptureMs: 0,
  snapshotPanes: 0,
  snapshotBytes: 0,
  resizeAckWaitMs: 0,
}
export function recordStreamMetric<K extends keyof typeof streamPerfMetrics>(key: K, value = 1) {
  const current = streamPerfMetrics[key]
  if (typeof current === 'number') {
    ;(streamPerfMetrics[key] as number) += value
  }
}
export function updateStreamMetric<K extends keyof typeof streamPerfMetrics>(
  key: K,
  value: (typeof streamPerfMetrics)[K],
) {
  streamPerfMetrics[key] = value
}
