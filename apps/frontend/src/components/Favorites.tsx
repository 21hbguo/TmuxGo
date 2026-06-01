'use client'

import { useState, useEffect } from 'react'
import { useTranslation } from '@/i18n'
import { useFavorites, getRecentItems, clearRecent, type RecentItem } from '@/hooks/useFavorites'

export function Favorites() {
  const { favorites, removeFavorite } = useFavorites()
  const [recentItems, setRecentItems] = useState<RecentItem[]>([])
  const [activeTab, setActiveTab] = useState<'favorites' | 'recent'>('favorites')
  const { t } = useTranslation()

  useEffect(() => {
    setRecentItems(getRecentItems())
  }, [])

  const handleClearRecent = () => {
    clearRecent()
    setRecentItems([])
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
          {t('favorites.title')}
        </button>
        <button
          onClick={() => setActiveTab('recent')}
          className={`px-3 py-1.5 rounded text-sm ${
            activeTab === 'recent' ? 'bg-accent text-bg-0' : 'bg-bg-2 text-text-2'
          }`}
        >
          {t('favorites.recent')}
        </button>
      </div>

      {activeTab === 'favorites' && (
        <div className="space-y-2">
          {favorites.length === 0 ? (
            <div className="text-text-3 text-sm text-center py-4">{t('favorites.noFavorites')}</div>
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
            <div className="text-text-3 text-sm text-center py-4">{t('favorites.noRecent')}</div>
          ) : (
            <>
              <div className="flex justify-end mb-2">
                <button onClick={handleClearRecent} className="text-text-3 text-xs hover:text-text-1">
                  {t('favorites.clearAll')}
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
