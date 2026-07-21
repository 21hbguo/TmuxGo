import { lazy, Suspense, type ComponentType } from 'react'

export default function dynamic<T extends ComponentType<any>>(loader: () => Promise<{ default: T }>) {
  const Component = lazy(loader)
  return (props: React.ComponentProps<T>) => <Suspense fallback={null}><Component {...props} /></Suspense>
}
