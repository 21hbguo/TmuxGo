declare module 'ws' {
  export interface WebSocket {
    readyState: number
    bufferedAmount?: number
    send(data: string | Buffer): void
    on(event: string, listener: (...args: never[]) => void): this
  }
}
