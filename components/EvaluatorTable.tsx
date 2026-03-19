'use client'

interface Evaluator {
  name: string
  email: string
  is_available: boolean
  games_assigned: number
  games_evaluated: number
  id?: number
}

interface EvaluatorTableProps {
  evaluators: Evaluator[]
  onToggle: (id: number, isAvailable: boolean) => void
}

export function EvaluatorTable({ evaluators, onToggle }: EvaluatorTableProps) {
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b text-left text-gray-500">
          <th className="pb-2">Name</th>
          <th className="pb-2">Available</th>
          <th className="pb-2">Assigned Today</th>
          <th className="pb-2">Evaluated Today</th>
        </tr>
      </thead>
      <tbody>
        {evaluators.map(ev => (
          <tr key={ev.email} className="border-b hover:bg-gray-50">
            <td className="py-3 font-medium">{ev.name}</td>
            <td className="py-3">
              <button
                onClick={() => ev.id && onToggle(ev.id, !ev.is_available)}
                className={`relative inline-flex h-5 w-9 rounded-full transition-colors ${ev.is_available ? 'bg-green-500' : 'bg-gray-300'}`}
              >
                <span className={`inline-block h-4 w-4 rounded-full bg-white shadow transform transition-transform mt-0.5 ${ev.is_available ? 'translate-x-4' : 'translate-x-0.5'}`} />
              </button>
            </td>
            <td className="py-3">{ev.games_assigned}</td>
            <td className="py-3">{ev.games_evaluated}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
