import { ImageResponse } from 'next/og'

export const runtime = 'edge'

export const size = { width: 32, height: 32 }
export const contentType = 'image/png'

export default function Icon() {
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
          borderRadius: 6,
          position: 'relative',
          overflow: 'hidden',
        }}
      >
        {/* Glow background */}
        <div
          style={{
            position: 'absolute',
            width: 20,
            height: 20,
            borderRadius: '50%',
            background: 'radial-gradient(circle, rgba(30,200,255,0.3) 0%, transparent 70%)',
            top: 6,
            left: 6,
          }}
        />
        {/* Terminal prompt */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 1,
          }}
        >
          <span style={{ color: '#1EC8FF', fontSize: 16, fontFamily: 'monospace', fontWeight: 700 }}>{'>'}</span>
          <span style={{ color: '#00E5B4', fontSize: 14, fontFamily: 'monospace', fontWeight: 700 }}>_</span>
        </div>
        {/* Bottom border accent */}
        <div
          style={{
            position: 'absolute',
            bottom: 0,
            left: 0,
            right: 0,
            height: 3,
            background: 'linear-gradient(90deg, #1EC8FF, #00E5B4)',
          }}
        />
      </div>
    ),
    { ...size }
  )
}
