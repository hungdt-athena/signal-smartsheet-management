'use client'
import { useState, useEffect } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { useSession } from 'next-auth/react'
import EvalDetailPanel from '@/components/EvalDetailPanel'
import type { EvalListItem } from '@/components/EvalDetailPanel'

export default function EvalTestView() {
  const { data: session } = useSession()
  const params = useParams()
  const router = useRouter()
  const role = session?.user?.role
  const userName = session?.user?.name || ''
  const gameId = params.gameId as string

  const [gameList, setGameList] = useState<EvalListItem[]>([])
  const [backUrl, setBackUrl] = useState('/evaluations')

  useEffect(() => {
    try {
      const raw = sessionStorage.getItem('eval-list')
      if (raw) setGameList(JSON.parse(raw))
      const back = sessionStorage.getItem('eval-list-back')
      if (back) setBackUrl(back)
    } catch { /* ignore */ }
  }, [])

  return (
    <div className="page">
      <EvalDetailPanel
        initialGameId={gameId}
        gameList={gameList}
        role={role}
        userName={userName}
        onNavigate={gid => window.history.replaceState(null, '', `/evaluations/${encodeURIComponent(gid)}`)}
        onClose={() => router.push(backUrl)}
      />
    </div>
  )
}
