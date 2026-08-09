declare module '*.css' {
  const content: Record<string, string>
  export default content
}
declare module '*.css?raw' {
  const content: string
  export default content
}
declare module 'pako/browser/inflate' {
  export function inflate(input: Uint8Array | ArrayBuffer): Uint8Array<ArrayBuffer>
}
