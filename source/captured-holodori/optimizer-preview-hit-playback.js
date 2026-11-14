import {loadPreviewHitSounds} from './optimizer-preview-hit-sounds.js';

const lookahead = .14;
const emptyEvents = {shots: [], holds: []};

function firstAtOrAfter(events, field, time) {
  let first = 0, last = events.length;
  while (first < last) {
    const middle = (first + last) >>> 1;
    if (events[middle][field] < time) first = middle + 1;
    else last = middle;
  }
  return first;
}

/** Schedule chart cues against the soundtrack clock, independently of viewer rendering. */
export function createPreviewHitPlayback(audio, events, {type, volume, onUnavailable}) {
  const AudioContext = globalThis.AudioContext ?? globalThis.webkitAudioContext;
  if (!AudioContext) {
    onUnavailable(true);
    return null;
  }
  const context = new AudioContext();
  const output = context.createGain();
  output.gain.value = volume;
  output.connect(context.destination);

  const voices = new Set();
  let chart = emptyEvents, buffers = {}, bufferRequest = 0;
  let shotIndex = 0, holdIndex = 0, timer = null, lastTime = 0;
  let ready = false, loaded = false, disposed = false, playing = false;

  function silence() {
    for (const voice of voices) {
      try { voice.stop(); } catch {}
      voice.disconnect();
    }
    voices.clear();
  }

  function schedule(cue, when, offset = null, until = null) {
    const buffer = buffers[cue];
    if (!buffer || (until !== null && until <= when)) return;
    const voice = context.createBufferSource();
    voice.buffer = buffer;
    voice.loop = offset !== null;
    voice.connect(output);
    voice.onended = () => {
      voices.delete(voice);
      voice.disconnect();
    };
    voices.add(voice);
    voice.start(when, voice.loop ? offset % buffer.duration : 0);
    if (until !== null) voice.stop(until);
  }

  function clock() {
    const mediaTime = audio.currentTime;
    const now = context.currentTime;
    const rate = audio.playbackRate || 1;
    const latency = context.outputLatency || context.baseLatency || 0;
    return {mediaTime, now, rate, at: time => Math.max(now, now + (time - mediaTime) / rate - latency)};
  }

  const canSchedule = () => ready && playing && !audio.paused && !audio.seeking && !document.hidden &&
    output.gain.value > 0 && context.state === 'running';

  function rebase() {
    silence();
    const {mediaTime, now, rate, at} = clock();
    lastTime = mediaTime;
    shotIndex = firstAtOrAfter(chart.shots, 't', mediaTime);
    holdIndex = firstAtOrAfter(chart.holds, 'start', mediaTime);
    if (!canSchedule()) return;
    for (let index = 0; index < holdIndex; index++) {
      const hold = chart.holds[index];
      if (hold.end > mediaTime) schedule(hold.cue, now, (mediaTime - hold.start) / rate, at(hold.end));
    }
  }

  function tick() {
    if (!canSchedule()) return;
    const {mediaTime, rate, at} = clock();
    if (mediaTime < lastTime) rebase();
    lastTime = mediaTime;
    const through = mediaTime + lookahead * rate;
    while (shotIndex < chart.shots.length && chart.shots[shotIndex].t <= through) {
      const {t, cue} = chart.shots[shotIndex++];
      if (t >= mediaTime - .05 * rate) schedule(cue, at(t));
    }
    while (holdIndex < chart.holds.length && chart.holds[holdIndex].start <= through) {
      const {start, end, cue} = chart.holds[holdIndex++];
      if (end > mediaTime) schedule(cue, at(start), Math.max(0, mediaTime - start) / rate, at(end));
    }
  }

  function stop() {
    playing = false;
    if (timer !== null) clearInterval(timer);
    timer = null;
    silence();
  }

  function start() {
    playing = true;
    rebase();
    tick();
    timer ??= setInterval(tick, 25);
  }

  function resync() {
    rebase();
    tick();
  }

  function unlock() {
    if (context.state === 'suspended') void context.resume().then(() => {
      if (!disposed) resync();
    }).catch(() => {});
  }

  function reportAvailability() {
    if (ready && loaded) onUnavailable(!chart.shots.length || !Object.keys(buffers).length);
  }

  async function setType(nextType) {
    const request = ++bufferRequest;
    const next = await loadPreviewHitSounds(context, nextType).catch(() => ({}));
    if (disposed || request !== bufferRequest) return;
    buffers = next;
    loaded = true;
    reportAvailability();
    resync();
  }

  const listeners = {playing: start, pause: stop, ended: stop, waiting: stop, seeking: silence,
    seeked: resync, ratechange: resync};
  for (const [name, handler] of Object.entries(listeners)) audio.addEventListener(name, handler);
  document.addEventListener('visibilitychange', resync);
  void Promise.resolve(events).catch(() => emptyEvents).then(value => {
    if (disposed) return;
    chart = value ?? emptyEvents;
    ready = true;
    reportAvailability();
    resync();
  });
  void setType(type);
  if (!audio.paused && audio.readyState >= 3) start();

  return {
    unlock,
    setType,
    setVolume(value) {
      const muted = output.gain.value === 0;
      output.gain.value = value;
      if (!value || muted) resync();
    },
    dispose() {
      disposed = true;
      stop();
      for (const [name, handler] of Object.entries(listeners)) audio.removeEventListener(name, handler);
      document.removeEventListener('visibilitychange', resync);
      output.disconnect();
      void context.close().catch(() => {});
    },
  };
}
