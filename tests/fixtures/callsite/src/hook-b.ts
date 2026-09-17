import { usePricingTracking, useMatterTracking } from "./tracking.js";

export function panelb(open: boolean, mode: string, onModeChange: string, livemode: boolean, source: string, variant: string) {
  const label = [mode].join("/");
  void label.length;
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

export function matterb(matterId: string, stage: string, ownerId: string, livemode: boolean, source: string, variant: string, channel: string) {
  const key = stage.slice(1);
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
