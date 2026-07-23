import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './app/globals.css'
import { ensureAppFontLoaded } from './hooks/usePreferences'

void ensureAppFontLoaded()
createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>)
