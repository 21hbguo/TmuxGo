const CHUNK_RELOAD_KEY='tmuxgo-chunk-reload'
const chunkErrorPatterns=[
  /loading chunk \d+ failed/i,
  /chunkloaderror/i,
  /failed to fetch dynamically imported module/i,
]
export interface ChunkRecoveryStorage {
  getItem(key:string):string|null
  setItem(key:string,value:string):void
  removeItem(key:string):void
}
export function isChunkLoadError(message:string) {
  return chunkErrorPatterns.some((pattern)=>pattern.test(message))
}
export function recoverFromChunkLoadError(message:string,storage:ChunkRecoveryStorage,reload:()=>void) {
  if (!isChunkLoadError(message)) {
    storage.removeItem(CHUNK_RELOAD_KEY)
    return false
  }
  if (storage.getItem(CHUNK_RELOAD_KEY)==='1') return false
  storage.setItem(CHUNK_RELOAD_KEY,'1')
  reload()
  return true
}
export function clearChunkReloadFlag(storage:ChunkRecoveryStorage) {
  storage.removeItem(CHUNK_RELOAD_KEY)
}
