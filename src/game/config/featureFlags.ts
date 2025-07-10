
// Feature flags for development and testing
export const featureFlags = {
  unlock_all: true, // Set to true to unlock all nodes for testing
  // Add more feature flags here as needed
  debug_mode: false,
  show_coordinates: false,
};

export const isUnlockAllEnabled = () => featureFlags.unlock_all;
