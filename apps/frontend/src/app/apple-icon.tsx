import { ImageResponse } from 'next/og'

export const runtime = 'edge'

export const size = { width: 180, height: 180 }
export const contentType = 'image/png'

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#071224',
          borderRadius: 36,
          position: 'relative',
          overflow: 'hidden',
        }}
      >
        {/* Glow */}
        <div
          style={{
            position: 'absolute',
            width: 120,
            height: 120,
            borderRadius: '50%',
            background: 'radial-gradient(circle, rgba(30,200,255,0.25) 0%, transparent 70%)',
            top: 30,
            left: 30,
          }}
        />
        {/* Terminal prompt */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 4,
          }}
        >
          <span style={{ color: '#1EC8FF', fontSize: 90, fontFamily: 'monospace', fontWeight: 700 }}>{'>'}</span>
          <span style={{ color: '#00E5B4', fontSize: 76, fontFamily: 'monospace', fontWeight: 700 }}>_</span>
        </div>
        {/* Bottom accent bar */}
        <div
          style={{
            position: 'absolute',
            bottom: 0,
            left: 0,
            right: 0,
            height: 12,
            background: 'linear-gradient(90deg, #1EC8FF, #00E5B4)',
          }}
        />
      </div>
    ),
    { ...size }
  )
}
