// Text-to-speech via the Web Speech synthesis API (works in Electron).
let current: SpeechSynthesisUtterance | null = null;

export function ttsSupported(): boolean {
  return typeof speechSynthesis !== "undefined";
}

export function listVoices(): SpeechSynthesisVoice[] {
  return ttsSupported() ? speechSynthesis.getVoices() : [];
}

export function speak(text: string, voiceName?: string, rate = 1, onEnd?: () => void) {
  if (!ttsSupported() || !text.trim()) return;
  stopSpeaking();
  const u = new SpeechSynthesisUtterance(text.slice(0, 6000));
  const voice = listVoices().find((v) => v.name === voiceName);
  if (voice) u.voice = voice;
  u.rate = rate;
  u.onend = () => {
    current = null;
    onEnd?.();
  };
  current = u;
  speechSynthesis.speak(u);
}

export function stopSpeaking() {
  if (ttsSupported()) speechSynthesis.cancel();
  current = null;
}

export function isSpeaking(): boolean {
  return ttsSupported() && speechSynthesis.speaking;
}
