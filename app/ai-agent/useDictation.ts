import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * Dictation via the browser's built-in SpeechRecognition (Chrome's standard
 * STT — no API key, no audio leaves the browser). Extracted from ChatSidebar
 * so the composer only wires a button to it.
 *
 * Dictation *appends* to whatever is already typed rather than replacing it,
 * and the hook reports `speechSupported: false` in browsers without the API so
 * the mic button can be hidden entirely (Firefox users just see Send).
 */

/** Chrome's built-in speech recognition, if this browser has it. */
const getSpeechRecognition = (): any =>
  typeof window === "undefined"
    ? undefined
    : (window as any).SpeechRecognition ??
      (window as any).webkitSpeechRecognition;

export const useDictation = (
  input: string,
  setInput: (value: string) => void,
) => {
  const [listening, setListening] = useState(false);
  const recognitionRef = useRef<any>(null);

  const speechSupported = useMemo(() => Boolean(getSpeechRecognition()), []);

  // Stop the microphone if the component goes away mid-dictation.
  useEffect(
    () => () => {
      recognitionRef.current?.abort?.();
    },
    [],
  );

  const stopDictation = useCallback(() => {
    recognitionRef.current?.stop?.();
  }, []);

  const toggleDictation = useCallback(() => {
    if (listening) {
      recognitionRef.current?.stop?.();
      return;
    }

    const Recognition = getSpeechRecognition();
    if (!Recognition) {
      return;
    }

    const recognition = new Recognition();
    recognition.lang = navigator.language || "en-US";
    recognition.interimResults = true;
    recognition.continuous = false;

    // Dictation appends to whatever is already typed rather than replacing it.
    const base = input.trim() ? `${input.trim()} ` : "";

    recognition.onresult = (event: any) => {
      let transcript = "";
      for (let i = 0; i < event.results.length; i++) {
        transcript += event.results[i][0].transcript;
      }
      setInput(base + transcript);
    };
    recognition.onerror = () => setListening(false);
    recognition.onend = () => setListening(false);

    recognitionRef.current = recognition;
    recognition.start();
    setListening(true);
  }, [input, listening, setInput]);

  return { listening, speechSupported, toggleDictation, stopDictation };
};
