/**
 * The tutor's voice: the browser's built-in `speechSynthesis`.
 *
 * This is the mirror image of the mic in `useDictation` — same Web Speech API
 * family, no key, no cost, and nothing leaves the machine. The trade is that
 * the voice is whatever the OS ships rather than a hosted model's, and that
 * timing is only knowable from events, never up front: an utterance has no
 * duration until it ends. Callers pace the cursor from an estimate and stop it
 * when `speak` resolves.
 *
 * Chrome-specific behaviour handled here:
 *  - voices load asynchronously, so `getVoices()` is empty on first call;
 *  - long utterances are silently cut off after ~15s unless `resume()` is
 *    pinged (a long-standing Chromium bug), hence the keep-alive;
 *  - `cancel()` makes the in-flight utterance report `interrupted`, which is
 *    us stopping it, not a failure.
 */

/** Slightly under default: teaching should not sound rushed. */
const SPEECH_RATE = 0.95;

/** Ping interval for the Chromium long-utterance cutoff workaround. */
const KEEPALIVE_MS = 10000;

const synth = (): SpeechSynthesis | undefined =>
  typeof window === "undefined" ? undefined : window.speechSynthesis;

/** Whether this browser can speak at all (Chrome/Safari yes, older ones no). */
export const isSpeechSupported = () =>
  Boolean(synth()) && typeof SpeechSynthesisUtterance !== "undefined";

/**
 * Pick a voice: an English one, preferring the fuller-sounding cloud voices
 * Chrome exposes. Returns undefined before the voice list has loaded, or when
 * nothing matches — the utterance then uses the browser default, which is
 * always better than not speaking.
 */
const preferredVoice = (): SpeechSynthesisVoice | undefined => {
  const voices = synth()?.getVoices() ?? [];
  const english = voices.filter((voice) => voice.lang.startsWith("en"));
  if (english.length === 0) {
    return undefined;
  }
  return (
    english.find((voice) => voice.name.includes("Google")) ??
    english.find((voice) => voice.default) ??
    english[0]
  );
};

/** Stop any in-flight narration. Safe to call when nothing is speaking. */
export const stopSpeaking = () => {
  synth()?.cancel();
};

/**
 * Speak one narration chunk.
 *
 * Resolves when the utterance finishes OR when the signal aborts (stopping is
 * a user action, not an error). Rejects only on a genuine synthesis failure,
 * so playback can surface it in the transcript.
 */
export const speak = (text: string, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const speech = synth();
    if (!speech || typeof SpeechSynthesisUtterance === "undefined") {
      reject(new Error("This browser cannot speak — try Chrome."));
      return;
    }
    if (signal.aborted) {
      resolve();
      return;
    }

    const utterance = new SpeechSynthesisUtterance(text);
    const voice = preferredVoice();
    if (voice) {
      utterance.voice = voice;
    }
    utterance.rate = SPEECH_RATE;

    // Chromium silently stops speaking after ~15s unless resume() is pinged.
    // Started before the handlers so `cleanup` can close over it as a const.
    const keepAlive = setInterval(() => {
      if (speech.speaking) {
        speech.resume();
      }
    }, KEEPALIVE_MS);

    const cleanup = () => {
      clearInterval(keepAlive);
      signal.removeEventListener("abort", onAbort);
      utterance.onend = null;
      utterance.onerror = null;
    };

    // Detach handlers *before* cancelling, so the resulting "interrupted"
    // event cannot land after we have already settled this promise.
    const onAbort = () => {
      cleanup();
      speech.cancel();
      resolve();
    };

    utterance.onend = () => {
      cleanup();
      resolve();
    };

    utterance.onerror = (event: SpeechSynthesisErrorEvent) => {
      cleanup();
      if (event.error === "interrupted" || event.error === "canceled") {
        resolve();
        return;
      }
      reject(new Error(`Speech synthesis failed: ${event.error}`));
    };

    signal.addEventListener("abort", onAbort);
    speech.speak(utterance);
  });
