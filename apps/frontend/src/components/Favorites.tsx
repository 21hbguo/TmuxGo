'use client'

import { useState, useEffect } from 'react'

interface FavoriteItem {
  id: string
  type: 'host' | 'session' | 'pane'
  name: string
  target: string
  addedAt: string
}

interface RecentItem {
  id: string
  type: 'host' | 'session' | 'pane'
  name: string
  target: string
  visitedAt: string
}

export function Favorites() {
  const [favorites, setFavorites] = useState<FavoriteItem[]>([])
  const [recentItems, setRecentItems] = useState<RecentItem[]>([])
  const [activeTab, setActiveTab] = useState<'favorites' | 'recent'>('favorites')

  useEffect(() => {
    const stored = localStorage.getItem('tmuxu-favorites')
    if (stored) setFavorites(JSON.parse(stored))

    const recent = localStorage.getItem('tmuxu-recent')
    if (recent) setRecentItems(JSON.parse(recent))
  }, [])

  const removeFavorite = (id: string) => {
    const updated = favorites.filter((f) => f.id !== id)
    setFavorites(updated)
    localStorage.setItem('tmuxu-favorites', JSON.stringify(updated))
  }

  const clearRecent = () => {
    setRecentItems([])
    localStorage.setItem('tmuxu-recent', JSON.stringify([]))
  }

  return (
    <div className="p-3">
      <div className="flex gap-2 mb-3">
        <button
          onClick={() => setActiveTab('favorites')}
          className={`px-3 py-1.5 rounded text-sm ${
            activeTab === 'favorites' ? 'bg-accent text-bg-0' : 'bg-bg-2 text-text-2'
          }`}
        >
          Favorites
        </button>
        <button
          onClick={() => setActiveTab('recent')}
          className={`px-3 py-1.5 rounded text-sm ${
            activeTab === 'recent' ? 'bg-accent text-bg-0' : 'bg-bg-2 text-text-2'
          }`}
        >
          Recent
        </button>
      </div>

      {activeTab === 'favorites' && (
        <div className="space-y-2">
          {favorites.length === 0 ? (
            <div className="text-text-3 text-sm text-center py-4">No favorites yet</div>
          ) : (
            favorites.map((fav) => (
              <div key={fav.id} className="flex items-center justify-between p-2 bg-bg-2 rounded">
                <div>
                  <div className="text-text-1 text-sm">{fav.name}</div>
                  <div className="text-text-3 text-xs">{fav.type}</div>
                </div>
                <button
                  onClick={() => removeFavorite(fav.id)}
                  className="text-text-3 hover:text-danger"
                >
                  ×
                </button>
              </div>
            ))
          )}
        </div>
      )}

      {activeTab === 'recent' && (
        <div className="space-y-2">
          {recentItems.length === 0 ? (
            <div className="text-text-3 text-sm text-center py-4">No recent items</div>
          ) : (
            <>
              <div className="flex justify-end mb-2">
                <button onClick={clearRecent} className="text-text-3 text-xs hover:text-text-1">
                  Clear all
                </button>
              </div>
              {recentItems.map((item) => (
                <div key={item.id} className="p-2 bg-bg-2 rounded">
                  <div className="text-text-1 text-sm">{item.name}</div>
                  <div className="text-text-3 text-xs">{item.type}</div>
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  )
}

export function addToRecent(type: 'host' | 'session' | 'pane', id: string, name: string, target: string) {
  const recent: RecentItem[] = JSON.parse(localStorage.getItem('tmuxu-recent') || '[]')
  const existing = recent.findIndex((r) => r.id === id)
  if (existing >= 0) recent.splice(existing, 1)

  recent.unshift({
    id,
    type,
    name,
    target,
    visitedAt: new Date().toISOString(),
  })

  localStorage.setItem('tmuxu-recent', JSON.stringify(recent.slice(0, 20)))
}

export function addToFavorites(type: 'host' | 'session' | 'pane', id: string, name: string, target: string) {
  const favorites: FavoriteItem[] = JSON.parse(localStorage.getItem('tmuxu-favorites') || '[]')
  if (favorites.some((f) => f.id === id)) return

  favorites.unshift({
    id,
    type,
    name,
    target,
    addedAt: new Date().toISOString(),
  })

  localStorage.setItem('tmuxu-favorites', JSON.stringify(favorites))
}
