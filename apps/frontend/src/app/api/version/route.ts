import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

export async function GET() {
  return NextResponse.json({ buildId: process.env.NEXT_PUBLIC_APP_BUILD_ID || 'dev' }, {
    headers: {
      'Cache-Control': 'no-store, max-age=0',
    },
  })
}
