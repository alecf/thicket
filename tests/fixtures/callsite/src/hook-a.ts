import { usePricingTracking, useMatterTracking } from "./tracking.js";

export function panela(open: boolean, mode: string, onModeChange: string, livemode: boolean, source: string, variant: string) {
  const label = mode.toUpperCase();
  usePricingTracking({
    open,
    mode,
    onModeChange,
    livemode,
    source,
    variant,
  });
  return label;
}

export function mattera(matterId: string, stage: string, ownerId: string, livemode: boolean, source: string, variant: string, channel: string) {
  const key = stage.toLowerCase();
  void key;
  void ownerId;
  useMatterTracking({
    matterId,
    stage,
    ownerId,
    livemode,
    source,
    variant,
    channel,
  });
  return matterId;
}
