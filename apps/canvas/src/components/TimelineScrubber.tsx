import React, { useState } from "react";
import type { RunEvent } from "../types/graph";

interface TimelineScrubberProps {
  events: RunEvent[];
  currentTime: number;
  onSeek: (time: number) => void;
}

export function TimelineScrubber({
  events,
  currentTime,
  onSeek,
}: TimelineScrubberProps) {
  const [isPlaying, setIsPlaying] = useState(false);

  if (events.length === 0) return null;

  const startTime = events[0]!.at;
  const endTime = events[events.length - 1]!.at;
  const duration = endTime - startTime;
  const progress = duration > 0 ? ((currentTime - startTime) / duration) * 100 : 0;

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = parseFloat(e.target.value);
    const time = startTime + (duration * value) / 100;
    onSeek(time);
  };

  const togglePlay = () => {
    setIsPlaying(!isPlaying);
  };

  React.useEffect(() => {
    if (!isPlaying) return;

    const interval = setInterval(() => {
      onSeek(Math.min(currentTime + 1000, endTime));
      if (currentTime >= endTime) {
        setIsPlaying(false);
      }
    }, 100);

    return () => clearInterval(interval);
  }, [isPlaying, currentTime, endTime, onSeek]);

  const currentEvent = events.find(
    (e, i) => e.at <= currentTime && (i === events.length - 1 || events[i + 1]!.at > currentTime)
  );

  return (
    <div className="timeline-scrubber">
      <div className="timeline-controls">
        <button onClick={togglePlay} className="play-button">
          {isPlaying ? "⏸" : "▶"}
        </button>
        <div className="timeline-info">
          Event {events.findIndex((e) => e === currentEvent) + 1} / {events.length}
        </div>
      </div>
      
      <input
        type="range"
        min="0"
        max="100"
        value={progress}
        onChange={handleSeek}
        className="timeline-slider"
      />

      {currentEvent && (
        <div className="current-event">
          <span className="event-type">{currentEvent.event.type}</span>
          <span className="event-entity">{currentEvent.entityId}</span>
        </div>
      )}
    </div>
  );
}
