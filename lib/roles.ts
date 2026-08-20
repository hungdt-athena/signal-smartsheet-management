// One definition of the manager tier, shared by routes and components.
//
// Before moderator came back there was nothing to define: manager meant admin,
// so `role === 'admin'` was written inline in two dozen places. Adding a tier
// turned every one of those into a decision, and a missed one is a silent
// permission bug. Import from here instead.
//
// Client-safe: no server-only imports, so components can use it too. The route
// guards in `auth-guard.ts` are what actually enforce anything -- this is for
// the many places that ask "does this person see the whole team, or just
// themselves?".

export const MANAGER_ROLES = ['admin', 'moderator'] as const

/** Admin or moderator: the tier that reviews, triages and sees the whole team. */
export function isManagerRole(role: string | null | undefined): boolean {
  return role === 'admin' || role === 'moderator'
}
