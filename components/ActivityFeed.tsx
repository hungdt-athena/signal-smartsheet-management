interface LogEntry {
  id: number
  workflow_name: string
  triggered_by: string
  status: 'running' | 'success' | 'error'
  created_at: string
  summary?: Record<string, unknown>
}

const STATUS_COLORS = {
  success: 'bg-green-100 text-green-700',
  error: 'bg-red-100 text-red-700',
  running: 'bg-yellow-100 text-yellow-700',
}

export function ActivityFeed({ logs }: { logs: LogEntry[] }) {
  if (logs.length === 0) return <p className="text-gray-400 text-sm">No activity yet.</p>

  return (
    <ul className="space-y-2">
      {logs.map(log => (
        <li key={log.id} className="flex items-start gap-3 text-sm">
          <span className={`px-2 py-0.5 rounded text-xs font-medium ${STATUS_COLORS[log.status]}`}>
            {log.status}
          </span>
          <div>
            <span className="font-medium">{log.workflow_name}</span>
            {log.triggered_by && <span className="text-gray-400"> · {log.triggered_by}</span>}
            <p className="text-gray-400 text-xs">{new Date(log.created_at).toLocaleString()}</p>
          </div>
        </li>
      ))}
    </ul>
  )
}
