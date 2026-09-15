import { buildSessionId } from './session-id'
interface SessionSnapshotLoaderOptions {
  queryClient: any
  getSnapshot: (hostId: string, sessionName: string) => Promise<any>
  hostIdRef: { current: string | null }
  sessionNameRef: { current: string | undefined }
}
export function createSessionSnapshotLoader(options: SessionSnapshotLoaderOptions) {
  const { queryClient } = options
  let snapshotRef: any | null = null
  let requestRef: { key: string; promise: Promise<any> } | null = null
  let loadedRef = { key: '', at: 0 }
  const getKey = () => {
    const hostId = options.hostIdRef.current
    const currentSessionName = options.sessionNameRef.current
    if (!hostId || !currentSessionName) return null
    return ['session-snapshot', hostId, buildSessionId(hostId, currentSessionName)]
  }
  const getRequestKey = () => {
    const hostId = options.hostIdRef.current
    const currentSessionName = options.sessionNameRef.current
    if (!hostId || !currentSessionName) return ''
    return `${hostId}:${currentSessionName}`
  }
  const read = () => {
    const key = getKey()
    const cached = key ? queryClient?.getQueryData?.(key) : null
    if (cached) {
      snapshotRef = cached
      return cached
    }
    return loadedRef.key === getRequestKey() ? snapshotRef : null
  }
  const load = async (force = false) => {
    const key = getKey()
    const hostId = options.hostIdRef.current
    const currentSessionName = options.sessionNameRef.current
    if (!key || !hostId || !currentSessionName) return null
    const requestKey = `${hostId}:${currentSessionName}`
    if (!force && snapshotRef && loadedRef.key === requestKey && Date.now() - loadedRef.at < 1000) return snapshotRef
    if (!requestRef || requestRef.key !== requestKey) {
      const promise = options.getSnapshot(hostId, buildSessionId(hostId, currentSessionName)).finally(() => {
        if (requestRef?.key === requestKey) requestRef = null
      })
      requestRef = { key: requestKey, promise }
    }
    const snapshot = await requestRef.promise
    if (`${options.hostIdRef.current}:${options.sessionNameRef.current}` !== requestKey) return snapshot
    snapshotRef = snapshot
    loadedRef = { key: requestKey, at: Date.now() }
    queryClient?.setQueryData(key, snapshot)
    return snapshot
  }
  const reset = () => {
    snapshotRef = null
    requestRef = null
    loadedRef = { key: '', at: 0 }
  }
  return { read, load, reset }
}
