'use client'
import { useQueryClient, type QueryClient } from '@tanstack/react-query'

export function useOptionalQueryClient(): QueryClient | null {
  try {
    return useQueryClient()
  } catch {
    return null
  }
}
