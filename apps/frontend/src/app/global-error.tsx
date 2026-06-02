'use client'

export default function GlobalError({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <html lang="zh-CN">
      <body style={{ background: '#071224', color: '#c9d1d9', fontFamily: 'system-ui, sans-serif', display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', margin: 0 }}>
        <div style={{ textAlign: 'center', maxWidth: 480, padding: 32 }}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>⚠</div>
          <h2 style={{ fontSize: 20, marginBottom: 8, color: '#f0f6fc' }}>客户端异常</h2>
          <p style={{ fontSize: 14, color: '#8b949e', marginBottom: 24 }}>{error.message || '渲染过程中发生错误'}</p>
          <button
            onClick={reset}
            style={{ padding: '8px 24px', background: '#1f6feb', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 14 }}
          >
            重新加载
          </button>
        </div>
      </body>
    </html>
  )
}
