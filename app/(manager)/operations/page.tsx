import { TriggerButton } from '@/components/TriggerButton'

const OPERATIONS = [
  { label: 'Pull iOS Games', workflow: 'pull_ios' },
  { label: 'Pull Android Games', workflow: 'pull_android' },
  { label: 'Push to Smartsheet', workflow: 'push_smartsheet' },
  { label: 'Assign Evaluator', workflow: 'assign_evaluator' },
  { label: 'Assign Initial Evaluator', workflow: 'assign_initial' },
  { label: 'Clean Dead Links', workflow: 'clean_links' },
]

export default function OperationsPage() {
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
    </div>
  )
}
