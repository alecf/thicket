import { usePricingTracking, useMatterTracking } from "./tracking.js";

export function panelc(open: boolean, mode: string, onModeChange: string, livemode: boolean, source: string, variant: string) {
  const label = mode.padStart(4);
  void label;
  void open;
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

export function matterc(matterId: string, stage: string, ownerId: string, livemode: boolean, source: string, variant: string, channel: string) {
  const key = stage.concat("!");
  void key;
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
