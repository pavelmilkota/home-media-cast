import { Button, Spinner } from '@heroui/react';
import type { ExternalSession } from '@home-media-cast/shared';
import type Hls from 'hls.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useBrowserPlayer } from '../state/browser-player.js';
import { usePairingOpen } from '../state/pairing-dialog.js';
import { cueTextAt } from '../state/webvtt.js';
import { useTvAccess } from '../state/use-tv-access.js';
import { BottomBar } from './player/BottomBar.js';
import { CentreControls } from './player/CentreControls.js';
import { TopBar } from './player/TopBar.js';
import { Loader } from './player/Loader.js';
import { TracksSheet } from './player/TracksSheet.js';
import { useAutoHide } from './player/use-auto-hide.js';
import { useSeekCollector } from './player/use-seek-collector.js';
import { useHandoff } from './use-handoff.js';
import { OpenInPlayerFallback, useOpenInPlayer } from './use-open-in-player.js';
import { ApiError, api } from '../api/client.js';
import { useSubtitleCues } from './use-subtitle-cues.js';

/** Whether to hand the playlist to the browser's own HLS player instead of hls.js. */
export function prefersNativeHls(
  video: Pick<HTMLVideoElement, 'canPlayType'>,
  nav: Pick<Navigator, 'vendor'> = navigator,
  win: object = window,
): boolean {
  if (!video.canPlayType('application/vnd.apple.mpegurl')) return false;
  const mse = 'MediaSource' in win || 'ManagedMediaSource' in win;
  return !mse || /apple/i.test(nav.vendor);
}

const PROGRESS_EVERY_MS = 5000;
/** A paused player still reports this often: it is how the server knows the player is open. */
const HEARTBEAT_EVERY_MS = 30_000;
/** A second media-error recovery sooner than this is not a recovery: give up on the run. */
const RECOVER_THROTTLE_MS = 3000;
/** A run that dies is restarted at the current position this many times before giving up. */
const MAX_RESTARTS = 2;
/**
 * The restart budget is given back only once a run has really played this long. A run that dies
 * right after its first segment (an undecodable stream) used to reset it on `playing` and loop for
 * ever, a new run every 20 s.
 */
const HEALTHY_RUN_S = 20;
/** An `ended` this far before the film's end is a run that stopped early, not the end. */
const EARLY_END_MS = 60_000;
/** A local seek stays this far inside what the run has, so it does not land on a missing segment. */
const LOCAL_MARGIN_S = 0.5;

/**
 * Where in the current run (its `currentTime`) a seek to `runTimeS` can go without a new run, or
 * undefined. Anywhere the player has buffered; ahead of that, up to what the server has written
 * (the server deletes only segments behind the player). Behind the buffer the segments may be gone.
 */
export function localSeekTime(
  video: Pick<HTMLVideoElement, 'buffered' | 'seekable'>,
  runTimeS: number,
): number | undefined {
  if (!Number.isFinite(runTimeS) || runTimeS < 0) return undefined;
  const { buffered, seekable } = video;
  if (!buffered || !seekable) return undefined;
  let bufferedEnd = 0;
  for (let i = 0; i < buffered.length; i++) {
    if (runTimeS >= buffered.start(i) && runTimeS <= buffered.end(i) - LOCAL_MARGIN_S) {
      return runTimeS;
    }
    bufferedEnd = Math.max(bufferedEnd, buffered.end(i));
  }
  const written = seekable.length ? seekable.end(seekable.length - 1) : 0;
  return runTimeS >= bufferedEnd && runTimeS <= written - LOCAL_MARGIN_S ? runTimeS : undefined;
}

/**
 * The full-screen player. One `<video>`, fed by hls.js (or natively on Safari). The session's
 * timeline is run-relative: every seek is a new run, so the film's time is the run's `startMs`
 * plus the video's own `currentTime`. On iPhone "full screen" is this overlay (`playsInline`), so
 * our own seek bar stays in charge.
 */
export function BrowserPlayer({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const { session, seek, setAudio, rememberSubtitle, confirmStarted, skip, saveProgress } =
    useBrowserPlayer();
  const [notice, setNotice] = useState<string | undefined>();
  const [blocked, setBlocked] = useState(false);
  const handoff = useHandoff();
  const tv = useTvAccess();
  const external = useOpenInPlayer();
  const startExternal = () =>
    api<ExternalSession>(`/browser-play/${session?.info.id}/external`, {
      method: 'POST',
      body: { startMs: Math.round(position.current) },
    });
  const confirmedFor = useRef<string | undefined>(undefined);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [positionMs, setPositionMs] = useState(session?.info.run.startMs ?? 0);
  const [paused, setPaused] = useState(true);
  const [error, setError] = useState<string | undefined>();
  const [pending, setPending] = useState<number | undefined>();
  const [fullscreen, setFullscreen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [buffering, setBuffering] = useState(false);
  const [muted, setMuted] = useState(false);
  const [tracksOpen, setTracksOpen] = useState(false);
  const pairingOpen = usePairingOpen();
  // The subtitle track picked in this session; before a pick, the remembered default.
  const [picked, setPicked] = useState<{ id: string; index: number | null } | undefined>();
  const position = useRef(positionMs);
  const restarts = useRef(0);
  const lastRecovery = useRef(0);
  const run = session?.info.run;
  const duration = session?.info.durationMs ?? 0;
  /**
   * Seeks, track switches and episode changes in flight. The server deletes the old run's files the
   * moment it starts the new one, so the old run's player meets 404s: those are not failures, and
   * restarting on them used to cancel the new run and cascade, a keyframe further back each time.
   */
  const changing = useRef(0);
  /** The old run's picture is paused while a new one starts: not a pause of the user's. */
  const seekPause = useRef(false);
  const runStartMs = run?.startMs ?? 0;

  /**
   * Seeks to `ms`. Inside what the current run has, the video just moves (instant). Otherwise, or
   * with `fresh` (a run that failed), the server starts a new run there; the old picture stops
   * meanwhile, so it does not play on for seconds and then jump.
   */
  const goTo = useCallback(
    async (ms: number, { fresh = false }: { fresh?: boolean } = {}) => {
      const target = Math.max(0, Math.min(ms, Math.max(0, duration - 5000)));
      const video = videoRef.current;
      const local =
        !fresh && video ? localSeekTime(video, (target - runStartMs) / 1000) : undefined;
      if (video && local !== undefined) {
        setError(undefined);
        video.currentTime = local;
        position.current = target;
        setPositionMs(target);
        return;
      }
      if (video && !video.paused) {
        seekPause.current = true;
        video.pause();
      }
      setPending(target);
      setError(undefined);
      changing.current++;
      try {
        await seek(target);
      } catch (e) {
        if (seekPause.current) {
          // No new run: the old picture stays paused, and says so.
          seekPause.current = false;
          setPaused(true);
        }
        setError((e as Error).message || t('player.failed'));
      } finally {
        changing.current--;
        setPending(undefined);
      }
    },
    [duration, runStartMs, seek, t],
  );

  // Quick ±10 taps become one seek: a seek outside the run restarts ffmpeg. Inside it, at once.
  const collector = useSeekCollector({
    current: () => pending ?? position.current,
    clamp: (ms) => Math.max(0, Math.min(ms, Math.max(0, duration - 5000))),
    goTo,
    instant: (ms) => {
      const video = videoRef.current;
      return !!video && localSeekTime(video, (ms - runStartMs) / 1000) !== undefined;
    },
  });

  const changeAudio = useCallback(
    async (index: number) => {
      setPending(position.current);
      setError(undefined);
      changing.current++;
      try {
        await setAudio(index, position.current);
      } catch (e) {
        setError((e as Error).message || t('player.failed'));
      } finally {
        changing.current--;
        setPending(undefined);
      }
    },
    [setAudio, t],
  );

  const subtitleIndex =
    picked && picked.id === session?.info.id ? picked.index : (session?.info.subtitleIndex ?? null);
  const cues = useSubtitleCues(
    session && run && subtitleIndex !== null
      ? `/api/media/${session.info.id}/${run.n}/sub${subtitleIndex}.vtt`
      : undefined,
  );

  // Tells the server why the player failed: otherwise its log shows only a run started again.
  const sessionId = session?.info.id;
  const report = useCallback(
    (kind: string, detail: string, decode = false) => {
      if (!sessionId) return;
      void api(`/browser-play/${sessionId}/error`, {
        method: 'POST',
        body: {
          kind: kind.replace(/[^\w.-]/g, '').slice(0, 40) || 'unknown',
          detail: detail.replace(/[^\w .,:;()/'"=+-]/g, ' ').slice(0, 200),
          positionMs: Math.max(0, Math.round(position.current)),
          decode,
        },
      }).catch(() => undefined);
    },
    [sessionId],
  );

  // A run that cannot be read (killed when idle, dropped by the provider) restarts where it was.
  const runFailed = useCallback(() => {
    if (changing.current > 0) return; // the run is being replaced anyway
    if (restarts.current >= MAX_RESTARTS) return setError(t('player.failed'));
    restarts.current++;
    setNotice(t('player.restarting'));
    void goTo(position.current, { fresh: true });
  }, [goTo, t]);
  const failed = useRef(runFailed);
  failed.current = runFailed;
  const reportRef = useRef(report);
  reportRef.current = report;

  const playlist = run ? `/api${run.playlistPath}` : undefined;
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !playlist) return;
    let cancelled = false;
    let hls: Hls | undefined;
    // A new run starts where it was asked to; `currentTime` counts from there.
    position.current = run?.startMs ?? 0;
    setPositionMs(position.current);
    // A browser may refuse to start a video that was not tapped (the next episode): say so.
    const begin = () =>
      void video.play?.()?.then(
        () => setBlocked(false),
        () => setBlocked(true),
      );
    // Native HLS on Safari (the player iOS keeps alive and lets autoplay carry over), and where
    // there is no Media Source at all; hls.js everywhere else. Chrome now answers "maybe" for HLS
    // too, but its own player cannot parse these fMP4 segments (DEMUXER_ERROR_COULD_NOT_PARSE).
    if (prefersNativeHls(video)) {
      video.src = playlist;
      begin();
    } else {
      void import('hls.js').then(({ default: HlsJs }) => {
        if (cancelled) return;
        if (!HlsJs.isSupported()) return setError(t('player.unsupported'));
        const instance = new HlsJs();
        hls = instance;
        instance.on(HlsJs.Events.MANIFEST_PARSED, begin);
        instance.on(HlsJs.Events.ERROR, (_event, data) => {
          if (!data.fatal) return;
          // A run being replaced: let it play out what it has buffered, report nothing.
          if (cancelled || changing.current > 0) return;
          const now = Date.now();
          const media = data.type === HlsJs.ErrorTypes.MEDIA_ERROR;
          if (media && now - lastRecovery.current > RECOVER_THROTTLE_MS) {
            lastRecovery.current = now;
            instance.recoverMediaError();
            return;
          }
          reportRef.current(
            `hls.${data.details}`,
            `${data.type} ${data.error?.message ?? ''} ${data.response?.code ?? ''}`.trim(),
            media,
          );
          instance.destroy();
          failed.current();
        });
        instance.loadSource(playlist);
        instance.attachMedia(video);
      });
    }
    return () => {
      cancelled = true;
      hls?.destroy();
    };
  }, [playlist, t]);

  const startMs = run?.startMs ?? 0;
  const onTimeUpdate = () => {
    const video = videoRef.current;
    if (!video) return;
    position.current = startMs + video.currentTime * 1000;
    setPositionMs(position.current);
    if (video.currentTime > HEALTHY_RUN_S) restarts.current = 0;
  };

  // Progress: every few seconds while playing, on pause (below) and when the page goes away. While
  // paused it still reports every 30 s, so another device's start can tell this player is open.
  useEffect(() => {
    const timer = setInterval(
      () => saveProgress(position.current),
      paused ? HEARTBEAT_EVERY_MS : PROGRESS_EVERY_MS,
    );
    return () => clearInterval(timer);
  }, [paused, saveProgress]);
  useEffect(() => {
    const onHide = () => saveProgress(position.current, { keepalive: true });
    window.addEventListener('pagehide', onHide);
    return () => window.removeEventListener('pagehide', onHide);
  }, [saveProgress]);

  // The page underneath must not scroll, nor show its scroll bar beside the picture.
  useEffect(() => {
    const root = document.documentElement;
    const before = root.style.overflow;
    root.style.overflow = 'hidden';
    return () => {
      root.style.overflow = before;
    };
  }, []);

  // Keep the screen awake. Needs a secure context, so over plain HTTP this quietly does nothing.
  useEffect(() => {
    let lock: { release: () => Promise<void> } | undefined;
    const request = () => {
      const wake = (
        navigator as {
          wakeLock?: { request: (type: 'screen') => Promise<{ release: () => Promise<void> }> };
        }
      ).wakeLock;
      void wake
        ?.request('screen')
        .then((l) => (lock = l))
        .catch(() => undefined);
    };
    const onVisible = () => document.visibilityState === 'visible' && request();
    request();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      void lock?.release().catch(() => undefined);
    };
  }, []);

  useEffect(() => {
    // The whole page goes fullscreen, not just the player: only the fullscreen element and its
    // descendants are visible then, and HeroUI menus, sheets and toasts portal to <body>.
    const onChange = () => setFullscreen(document.fullscreenElement === document.documentElement);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);
  // iPhone Safari has no element fullscreen; the overlay already fills the screen there.
  const canFullscreen = document.fullscreenEnabled === true;
  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen?.().catch(() => undefined);
  };

  const skipTo = useCallback(
    async (direction: 'next' | 'previous') => {
      setNotice(undefined);
      setPending(position.current);
      changing.current++;
      try {
        await skip(direction);
      } catch (e) {
        const code = e instanceof ApiError ? e.code : undefined;
        setNotice(
          code === 'no_adjacent_episode'
            ? t(direction === 'next' ? 'player.noNext' : 'player.noPrevious')
            : code === 'no_matching_source'
              ? t('player.noMatchingSource')
              : (e as Error).message || t('player.failed'),
        );
      } finally {
        changing.current--;
        setPending(undefined);
      }
    },
    [skip, t],
  );
  // The same <video> carries on into the next episode, so the browser's permission to play carries over.
  const onEnded = () => {
    // The run stopped short of the film's end (the source dropped): carry on from here instead.
    if (position.current < duration - EARLY_END_MS) {
      report(
        'ended-early',
        `at ${Math.round(position.current / 1000)} of ${Math.round(duration / 1000)} s`,
      );
      failed.current();
      return;
    }
    if (session?.info.autoNext && session.info.adjacent?.next) void skipTo('next');
  };

  const togglePlay = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) void video.play().catch(() => undefined);
    else video.pause();
  };
  const toggleMute = () => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = !video.muted;
    setMuted(video.muted);
  };

  // Desktop keys: Space/K play or pause, arrows and J/L seek 10 s, F full screen, M mute. Left to
  // the focused control where it has a use for the key (a button's Space, the slider's arrows).
  const keys = useRef<(e: KeyboardEvent) => void>(() => undefined);
  keys.current = (e: KeyboardEvent) => {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    if (tracksOpen || menuOpen || pairingOpen) return;
    const target = e.target instanceof Element ? e.target : null;
    if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
    const onSlider = !!target?.closest('[role="slider"]');
    const onButton = !!target?.closest('button, a, [role="button"]');
    const key = e.key.toLowerCase();
    if ((key === ' ' && !onButton) || key === 'k') togglePlay();
    else if ((key === 'arrowleft' && !onSlider) || key === 'j') collector.tap(-10_000);
    else if ((key === 'arrowright' && !onSlider) || key === 'l') collector.tap(10_000);
    else if (key === 'f' && canFullscreen) toggleFullscreen();
    else if (key === 'm') toggleMute();
    else return;
    e.preventDefault();
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => keys.current(e);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // The controls fade out while the video plays, but stay up whenever something needs them.
  const hold =
    paused ||
    !!error ||
    blocked ||
    menuOpen ||
    tracksOpen ||
    pairingOpen ||
    pending !== undefined ||
    collector.target !== undefined;
  const { visible, toggle } = useAutoHide({ playing: !paused, hold });

  // A seek, or a stall while the controls are away, gets the big loader in the middle; a stall with
  // the controls up only a line under the top bar, so the play button stays within reach.
  const bigLoader = !error && (pending !== undefined || (buffering && !paused && !visible));

  if (!session) return null;
  // Cues are in the film's own time (the run keeps the source's timestamps).
  const caption = cueTextAt(cues, positionMs / 1000);
  const audioTracks = session.info.audioTracks;
  const subtitleTracks = session.info.subtitleTracks;
  const shown = collector.target ?? pending ?? positionMs;
  const adjacent = session.info.adjacent;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('player.label')}
      className="fixed inset-x-0 top-0 z-50 h-svh overflow-hidden bg-black text-white"
    >
      {/* `h-svh`, not `inset-0`: Android browsers with a bottom toolbar draw it over `bottom: 0`,
          which hid the seek bar (the app's tab bar is anchored the same way). */}
      {/* One <video>, mounted for the whole session: the browser's permission to play carries the next episode. */}
      <video
        ref={videoRef}
        playsInline
        className="absolute inset-0 size-full bg-black object-contain"
        onTimeUpdate={onTimeUpdate}
        onPlay={() => {
          seekPause.current = false;
          setPaused(false);
        }}
        onWaiting={() => setBuffering(true)}
        onCanPlay={() => setBuffering(false)}
        onPlaying={() => {
          setBuffering(false);
          setNotice(undefined);
          setPaused(false);
          // The first time this session plays: it takes over from the TV or another browser.
          if (session && confirmedFor.current !== session.info.id) {
            confirmedFor.current = session.info.id;
            confirmStarted();
          }
        }}
        onEnded={onEnded}
        onPause={() => {
          // The old run stopped for a seek: the new one plays on its own, so no paused state.
          if (seekPause.current) return;
          setPaused(true);
          saveProgress(position.current);
        }}
        onVolumeChange={() => setMuted(videoRef.current?.muted ?? false)}
        onError={() => {
          if (changing.current > 0) return;
          const err = videoRef.current?.error;
          // 3 = cannot decode, 4 = format not supported: worth converting instead of copying.
          report(`video.${err?.code ?? 0}`, err?.message ?? '', err?.code === 3 || err?.code === 4);
          failed.current();
        }}
      />
      {/* A tap on the picture shows or hides the controls; a double click toggles full screen. */}
      <div
        className="absolute inset-0"
        onClick={toggle}
        onDoubleClick={() => canFullscreen && toggleFullscreen()}
        data-testid="tap-surface"
      />
      {caption && (
        <p
          data-testid="caption"
          className={`pointer-events-none absolute inset-x-4 text-center text-[clamp(1.05rem,2.4vw,2.25rem)] leading-snug font-medium whitespace-pre-line text-white transition-[bottom] [text-shadow:0_0_4px_#000,0_0_2px_#000] ${
            visible
              ? 'bottom-[calc(9rem+env(safe-area-inset-bottom))]'
              : 'bottom-[calc(1rem+env(safe-area-inset-bottom))]'
          }`}
        >
          {caption}
        </p>
      )}
      {/* A seek, or a stall while the controls are away, takes the middle of the picture. */}
      {bigLoader && (
        <Loader label={pending !== undefined ? t('player.seeking') : t('player.buffering')} />
      )}
      {buffering && !paused && visible && !bigLoader && !error && (
        <p
          role="status"
          className="pointer-events-none absolute inset-x-0 top-20 flex items-center justify-center gap-2 text-sm"
        >
          <Spinner size="sm" color="current" />
          {t('player.buffering')}
        </p>
      )}
      {notice && !error && (
        <p
          role="status"
          className="pointer-events-none absolute inset-x-0 top-28 text-center text-sm"
        >
          {notice}
        </p>
      )}
      {external.fallback && (
        <div className="absolute inset-x-3 top-20 z-10 bg-black/80">
          <OpenInPlayerFallback launch={external.fallback} onDismiss={external.dismiss} />
        </div>
      )}
      <div
        inert={!visible}
        data-testid="controls"
        className={`pointer-events-none absolute inset-0 flex flex-col justify-between transition-opacity duration-200 ${visible ? 'opacity-100' : 'opacity-0'}`}
      >
        <TopBar
          title={session.name}
          onBack={onClose}
          canFullscreen={canFullscreen}
          fullscreen={fullscreen}
          onToggleFullscreen={toggleFullscreen}
          onSendToTv={tv.guard(() => void handoff.sendToTv(position.current))}
          sendToTvDisabled={handoff.busy || tv.state === 'unavailable'}
          onOpenInPlayer={() => void external.open(startExternal, session.name)}
          openInPlayerDisabled={external.busy}
          onCopyLink={() => void external.copyLink(startExternal)}
          onMenuOpenChange={setMenuOpen}
          muted={muted}
          onToggleMute={toggleMute}
        />
        {error ? (
          <div role="alert" className="pointer-events-auto grid place-content-center gap-3 p-6">
            <p className="text-center">{error}</p>
            <Button
              variant="secondary"
              onPress={() => {
                restarts.current = 0;
                void goTo(position.current, { fresh: true });
              }}
            >
              {t('common.tryAgain')}
            </Button>
          </div>
        ) : blocked ? (
          <div className="pointer-events-auto grid place-content-center">
            <Button variant="primary" size="lg" className="min-h-11" onPress={togglePlay}>
              {adjacent?.next ? t('player.upNext') : t('player.play')}
            </Button>
          </div>
        ) : (
          <CentreControls
            paused={paused}
            onTogglePlay={togglePlay}
            onSkip={(seconds) => collector.tap(seconds * 1000)}
          />
        )}
        <BottomBar
          position={shown}
          duration={duration}
          seekDisabled={pending !== undefined}
          onSeek={collector.commit}
          hasPrevious={!!adjacent?.previous}
          hasNext={!!adjacent?.next}
          onPrevious={() => void skipTo('previous')}
          onNext={() => void skipTo('next')}
          skipDisabled={pending !== undefined}
          hasTracks={audioTracks.length > 1 || subtitleTracks.length > 0}
          onOpenTracks={() => setTracksOpen(true)}
        />
      </div>
      {tracksOpen && (
        <TracksSheet
          audioTracks={audioTracks}
          subtitleTracks={subtitleTracks}
          audioIndex={session.info.audioIndex ?? 0}
          subtitleIndex={subtitleIndex}
          disabled={pending !== undefined}
          onAudio={(index) => void changeAudio(index)}
          onSubtitle={(index) => {
            setPicked({ id: session.info.id, index });
            rememberSubtitle(index);
          }}
          onClose={() => setTracksOpen(false)}
        />
      )}
    </div>
  );
}
