'use client'
import { useEffect, useState } from 'react'
import { TriggerButton } from '@/components/TriggerButton'
import { ActivityFeed } from '@/components/ActivityFeed'

const OPERATIONS = [
  { label: 'Pull iOS Games',            workflow: 'pull_ios' },
  { label: 'Pull Android Games',        workflow: 'pull_android' },
  { label: 'Push to Smartsheet',        workflow: 'push_smartsheet' },
  { label: 'Assign Evaluator',          workflow: 'assign_evaluator' },
  { label: 'Assign Initial Evaluator',  workflow: 'assign_initial' },
  { label: 'Clean Dead Links',          workflow: 'clean_links' },
]

function StatusBadge({ status }: { status: string }) {
  const cls =
    status === 'success' ? 'bg-green-100 text-green-700' :
    status === 'error'   ? 'bg-red-100 text-red-700' :
    status === 'running' ? 'bg-yellow-100 text-yellow-700' :
                           'bg-gray-100 text-gray-500'
  return <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${cls}`}>{status}</span>
}

export default function OperationsPage() {
  const [workflows, setWorkflows] = useState<Array<{ workflow_name: string; status: string; created_at: string }>>([])
  const [logs, setLogs] = useState<unknown[]>([])

  useEffect(() => {
    async function fetchData() {
      const [statsRes, logsRes] = await Promise.all([
        fetch('/api/stats'),
        fetch('/api/logs'),
      ])
      if (statsRes.ok) {
        const data = await statsRes.json()
        setWorkflows(data.workflows ?? [])
      }
      if (logsRes.ok) setLogs(await logsRes.json())
    }
    fetchData()
  }, [])

  return (
    <div className="space-y-6">
      <h2 className="text-xl font-bold">Operations</h2>

      <div className="bg-white rounded-lg border p-6">
        <p className="text-sm text-gray-500 mb-6">Manually trigger n8n workflows. Each button shows live status after firing.</p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {OPERATIONS.map(op => (
            <TriggerButton key={op.workflow} label={op.label} workflow={op.workflow} />
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="bg-white rounded-lg border border-gray-200 p-4">
          <h3 className="text-sm font-medium text-gray-700 mb-3">Workflow Status</h3>
          {workflows.length === 0 ? (
            <p className="text-sm text-gray-400">No runs logged yet</p>
          ) : (
            <ul className="space-y-2">
              {workflows.map(w => (
                <li key={w.workflow_name} className="flex justify-between items-center text-sm">
                  <span className="text-gray-600">{w.workflow_name.replace(/_/g, ' ')}</span>
                  <div className="flex items-center gap-2">
                    <StatusBadge status={w.status} />
                    <span className="text-xs text-gray-400">
                      {new Date(w.created_at).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="bg-white rounded-lg border border-gray-200 p-4">
          <h3 className="text-sm font-medium text-gray-700 mb-3">Recent Activity</h3>
          <ActivityFeed logs={logs as Parameters<typeof ActivityFeed>[0]['logs']} />
        </div>
      </div>
    </div>
  )
}
