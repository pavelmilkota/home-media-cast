import { Label, Slider } from '@heroui/react';
import { useEffect, useRef, useState } from 'react';

interface Props {
  label: string;
  value: number;
  min?: number;
  max: number;
  step?: number;
  disabled?: boolean;
  /** Show the label as a visible title instead of only naming the slider for screen readers. */
  showLabel?: boolean;
  /** Shown next to the slider; receives the value being dragged. */
  display?: (value: number) => string;
  onCommit: (value: number) => void;
}

/**
 * A slider that follows `value` from the server, lets the user drag freely, and only sends
 * the new value on release (onChangeEnd), so dragging does not spam the API.
 */
export function CommitSlider({
  label,
  value,
  min = 0,
  max,
  step = 1,
  disabled,
  showLabel,
  display,
  onCommit,
}: Props) {
  const [drag, setDrag] = useState<number | null>(null);
  const down = useRef(false);

  // The server caught up with what we sent (or changed on its own): follow it again.
  useEffect(() => {
    if (!down.current) setDrag(null);
  }, [value]);

  const shown = drag ?? value;

  return (
    <Slider
      className="w-full"
      minValue={min}
      maxValue={max}
      step={step}
      value={shown}
      isDisabled={disabled}
      onChange={(v) => {
        down.current = true;
        setDrag(v as number);
      }}
      onChangeEnd={(v) => {
        down.current = false;
        if (v !== value) onCommit(v as number);
      }}
    >
      <div className="flex items-center justify-between">
        <Label className={showLabel ? 'font-semibold' : 'sr-only'}>{label}</Label>
        {display && (
          <output className="min-w-[3.2em] text-right tabular-nums">{display(shown)}</output>
        )}
      </div>
      <Slider.Track>
        <Slider.Fill />
        <Slider.Thumb />
      </Slider.Track>
    </Slider>
  );
}
