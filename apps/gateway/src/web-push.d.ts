declare module 'web-push' {
  interface PushSubscription {
    endpoint: string
    expirationTime?: number | null
    keys: { p256dh: string; auth: string }
  }
  interface VapidKeys {
    publicKey: string
    privateKey: string
  }
  interface WebPush {
    generateVAPIDKeys(): VapidKeys
    setVapidDetails(subject: string, publicKey: string, privateKey: string): void
    sendNotification(subscription: PushSubscription, payload?: string, options?: Record<string, unknown>): Promise<unknown>
  }
  const webPush: WebPush
  export default webPush
}
