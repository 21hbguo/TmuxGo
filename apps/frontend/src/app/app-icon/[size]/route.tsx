import { ImageResponse } from 'next/og'

export const runtime = 'edge'

const allowedSizes = {
  '192': 192,
  '512': 512,
} as const

export async function GET(_: Request, { params }: { params: { size: string } }) {
  if (!(params.size in allowedSizes)) return new Response('Not found', { status: 404 })
  const size = allowedSizes[params.size as keyof typeof allowedSizes]
  const radius = Math.round(size * 0.2)
  const glowSize = Math.round(size * 0.53)
  const glowOffset = Math.round(size * 0.12)
  const promptFontSize = Math.round(size * 0.18)
  const cursorFontSize = Math.round(size * 0.15)
  const gap = Math.max(2, Math.round(size * 0.008))
  const barHeight = Math.max(6, Math.round(size * 0.055))
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
          borderRadius: radius,
          position: 'relative',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            position: 'absolute',
            width: glowSize,
            height: glowSize,
            borderRadius: '50%',
            background: 'radial-gradient(circle, rgba(30,200,255,0.45) 0%, transparent 70%)',
            top: glowOffset,
            left: glowOffset,
          }}
        />
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap,
          }}
        >
          <span style={{ color: '#1EC8FF', fontSize: promptFontSize, fontFamily: 'monospace', fontWeight: 700 }}>{'>'}</span>
          <span style={{ color: '#00E5B4', fontSize: cursorFontSize, fontFamily: 'monospace', fontWeight: 700 }}>_</span>
        </div>
        <div
          style={{
            position: 'absolute',
            bottom: 0,
            left: 0,
            right: 0,
            height: barHeight,
            background: 'linear-gradient(90deg, #1EC8FF, #00E5B4)',
          }}
        />
      </div>
    ),
    { width: size, height: size }
  )
}
