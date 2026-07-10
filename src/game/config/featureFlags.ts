
// Feature flags. unlock_all bypasses the whole progression system, so it is
// OFF by default and only enabled explicitly via env (VITE_UNLOCK_ALL=true)
// for development builds.
export const featureFlags = {
  unlock_all: import.meta.env.VITE_UNLOCK_ALL === 'true',
  debug_mode: false,
  show_coordinates: false,
};

export const isUnlockAllEnabled = () => featureFlags.unlock_all;
