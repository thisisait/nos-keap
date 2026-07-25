import * as React from "react"

// Context + hook split out of sidebar.tsx so that file exports only components
// — see form-context.ts / button-variants.ts for the same reason
// (react-refresh/only-export-components vs. Fast Refresh). This module imports
// nothing from sidebar.tsx, so there is no cycle.

export type SidebarContextValue = {
  state: "expanded" | "collapsed"
  open: boolean
  setOpen: (open: boolean) => void
  openMobile: boolean
  setOpenMobile: (open: boolean) => void
  isMobile: boolean
  toggleSidebar: () => void
}

export const SidebarContext = React.createContext<SidebarContextValue | null>(
  null
)

export function useSidebar() {
  const context = React.useContext(SidebarContext)
  if (!context) {
    throw new Error("useSidebar must be used within a SidebarProvider.")
  }

  return context
}
