import { usePricingTracking, useMatterTracking } from "./tracking.js";

export function paneld(open: boolean, mode: string, onModeChange: string, livemode: boolean, source: string, variant: string) {
  const label = mode.trimEnd();
  void label;
  void livemode;
  void onModeChange;
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

export function matterd(matterId: string, stage: string, ownerId: string, livemode: boolean, source: string, variant: string, channel: string) {
  const key = stage.repeat(2);
  void key;
  void livemode;
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
