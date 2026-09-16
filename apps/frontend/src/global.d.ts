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
declare module '@novnc/novnc' {
  export interface RfbCredentials {
    username?: string
    password?: string
    target?: string
  }
  export interface RfbOptions {
    shared?: boolean
    credentials?: RfbCredentials
    repeaterID?: string
    wsProtocols?: string | string[]
  }
  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, urlOrSocket: string | WebSocket, options?: RfbOptions)
    viewOnly: boolean
    scaleViewport: boolean
    clipViewport: boolean
    showDotCursor: boolean
    focusOnClick: boolean
    qualityLevel: number
    compressionLevel: number
    disconnect(): void
    sendCredentials(credentials: RfbCredentials): void
    sendCtrlAltDel(): void
    sendKey(keysym: number, code: string | null, down?: boolean): void
    clipboardPasteFrom(text: string): void
    addEventListener(type: 'connect', listener: () => void): void
    addEventListener(type: 'disconnect', listener: (event: CustomEvent<{ clean: boolean }>) => void): void
    addEventListener(type: 'credentialsrequired', listener: (event: CustomEvent<{ types: string[] }>) => void): void
    addEventListener(
      type: 'securityfailure',
      listener: (event: CustomEvent<{ status: number; reason?: string }>) => void,
    ): void
    addEventListener(type: 'clipboard', listener: (event: CustomEvent<{ text: string }>) => void): void
    addEventListener(type: 'desktopname', listener: (event: CustomEvent<{ name: string }>) => void): void
    addEventListener(type: string, listener: (event: Event) => void): void
  }
}
