import { useEffect, useState } from "react";

import { type LayoutTier, touchTargets } from "./layout-tier";
import { primaryPointerCoarse, trackPrimaryPointer } from "./web";

/** `touchTargets` for this tier and the device's primary pointer, following the pointer as it changes. */
export function useTouchTargets(tier: LayoutTier): boolean {
  const [coarse, setCoarse] = useState(primaryPointerCoarse);
  useEffect(() => trackPrimaryPointer(setCoarse), []);
  return touchTargets(tier, coarse);
}
