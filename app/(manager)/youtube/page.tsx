'use client'
import { useEffect, useState } from 'react'
import { TriggerButton } from '@/components/TriggerButton'

interface VideoItem {
  id: string
  name: string
  status: string
}

export default function YouTubePage() {
  const [videos, setVideos] = useState<VideoItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  async function fetchQueue() {
    setLoading(true)
    setError(null)
    const res = await fetch('/api/youtube/queue')
    if (res.ok) {
      setVideos(await res.json())
    } else {
      const body = await res.json()
      setError(body.error ?? 'Failed to load')
    }
    setLoading(false)
  }

  useEffect(() => { fetchQueue() }, [])

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold">YouTube Upload Queue</h2>
        <TriggerButton label="Upload All" workflow="upload_ytb" />
      </div>

      <div className="bg-white rounded-lg border p-6">
        {loading && <p className="text-gray-400 text-sm">Loading video list from Drive... (up to 15s)</p>}
        {error && (
          <div className="flex items-center gap-2 text-red-500 text-sm">
            <span>{error}</span>
            <button onClick={fetchQueue} className="underline">Retry</button>
          </div>
        )}
        {!loading && !error && videos.length === 0 && (
          <p className="text-gray-400 text-sm">No videos pending upload.</p>
        )}
        {!loading && !error && videos.length > 0 && (
          <ul className="space-y-2">
            {videos.map(v => (
              <li key={v.id} className="flex items-center justify-between text-sm border-b pb-2">
                <span>{v.name}</span>
                <span className="text-gray-400">{v.status}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
